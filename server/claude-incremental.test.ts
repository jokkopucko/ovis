import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import type { SubagentDetail } from "./claude-subagents.ts";
import { createClaudeTranscriptParser, forgetTranscriptState, parseClaudeTranscript, transcriptPage } from "./conversation.ts";

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const stamp = (ms: number) => new Date(Date.UTC(2026, 9, 1) + ms).toISOString();
const user = (content: unknown, parentUuid?: string) => ({ type: "user", parentUuid, message: { role: "user", content } });
const assistant = (content: unknown[], stop_reason?: string | null, timestamp = stamp(0)) => ({ type: "assistant", timestamp, message: { role: "assistant", content, stop_reason } });
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const result = (tool_use_id: string, content: unknown, is_error = false) => ({ type: "tool_result", tool_use_id, content, is_error });
const info = (content: string, ms: number) => ({ type: "system", subtype: "informational", content, timestamp: stamp(ms) });
const local = (content: string, ms: number) => ({ type: "system", subtype: "local_command", content: `<local-command-stderr>${content}</local-command-stderr>`, timestamp: stamp(ms) });
const notification = (id: string, use: string, result: string, status = "completed", summary = 'Agent "Reviewer" finished') => `<task-notification><task-id>${id}</task-id><tool-use-id>${use}</tool-use-id><status>${status}</status><summary>${summary}</summary><result>${result}</result></task-notification>`;
const enqueue = (content: string) => ({ type: "queue-operation", operation: "enqueue", content });
const notifiedAttachment = (prompt: string) => ({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt } });
const peerOrigin = { kind: "peer", from: "session-one", msg_id: "message-one", name: "Reviewer", body: "Review ready" };
const peerAttachment = { type: "attachment", attachment: { type: "queued_command", origin: peerOrigin } };
const peerEcho = { ...user("Review ready"), isMeta: true, origin: peerOrigin };
const tools = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "tool"));
const tasks = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "task_result" ? part.tasks : []));

type Options = NonNullable<Parameters<typeof createClaudeTranscriptParser>[0]>;

/**
 * Claude Code 2.1.30x: a background subagent sends its report with SubagentHandback, as another session's
 * message framed and indented; the task's notification then only points at it (#3658)
 */
function handbackRecords(lines = ["## Verdict", "", "**No.** The path is not cheaper.", "  - indented item"]) {
  const frame = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:";
  const body = `${frame}\n${lines.map((line) => `  ${line}`).join("\n")}`;
  const handback = { ...user(`Another Claude session sent a message:\n<agent-message from="a3e6">\n${body}\n</agent-message>`), isMeta: true, origin: { kind: "peer", from: "a3e6", senderTaskId: "a3e6", name: "general-purpose", body } };
  const pointer = 'This agent\'s report was delivered to you as a message from "a3e6" (its SubagentHandback call). Read it there; it is not repeated here.\n';
  const ended = notification("a3e6", "toolu_a3e6", pointer, "completed", 'Agent "Price the path" finished');
  return { handback, pointer, ended, report: lines.join("\n").trim() };
}

/** Check every append and speculative final line, including older returned snapshots. */
function appendRecords(records: unknown[], options: Options = {}): ConversationTurn[] {
  const parser = createClaudeTranscriptParser(options);
  const initiallyNoticed = new Set(options.noticed);
  const written: unknown[] = [];
  for (const record of records) {
    const before = parser.snapshot();
    const saved = structuredClone(before);
    const externalNoticed = options.noticed && new Set(options.noticed);
    const externalSubagents = options.subagents && structuredClone(options.subagents);
    const expected = parseClaudeTranscript(jsonl(...written, record), Infinity, { ...options, noticed: new Set(initiallyNoticed) });
    expect(parser.snapshot(JSON.stringify(record))).toEqual(expected);
    expect(parser.snapshot()).toEqual(saved);
    expect(options.noticed).toEqual(externalNoticed);
    expect(options.subagents).toEqual(externalSubagents);
    parser.write(`${JSON.stringify(record)}\n`);
    written.push(record);
    expect(parser.snapshot()).toEqual(expected);
    expect(before).toEqual(saved);
  }
  return parser.snapshot();
}

describe("incremental Claude transcripts", () => {
  it("isolates consumer edits of ordinary snapshots from later skill results", () => {
    const parser = createClaudeTranscriptParser();
    parser.write(jsonl(user("Review the change"), assistant([call("skill", "Skill", { skill: "review" })], "tool_use")));
    const exposed = parser.snapshot();
    exposed[0]!.parts.length = 0;
    tools(exposed)[0]!.skill!.name = "consumer edit";
    parser.write(jsonl(user([result("skill", "Loaded")]), assistant([{ type: "text", text: "Reviewed" }], "end_turn")));
    const updated = parser.snapshot();
    expect(updated[0]?.parts).toEqual([{ kind: "text", text: "Review the change" }]);
    expect(tools(updated)[0]?.skill).toMatchObject({ name: "review", status: "loaded" });
    expect(updated.at(-1)?.parts.at(-1)).toEqual({ kind: "text", text: "Reviewed", phase: "final_answer" });
  });

  it("keeps delayed tool and skill results across notices and completed assistant turns", () => {
    const turns = appendRecords([
      user("Review and run"),
      assistant([call("skill", "Skill", { skill: "review" }), call("run", "Bash", { command: "run" })], null, stamp(1)),
      info("Message held", 2),
      user([result("skill", [{ type: "text", text: "Loaded" }])]),
      assistant([{ type: "thinking", thinking: "Internal reasoning" }, { type: "text", text: "First answer" }], "end_turn", stamp(3)),
      user([result("run", "x".repeat(5000), true)]),
      { ...user("Stop hook feedback"), isMeta: true },
      { type: "system", subtype: "stop_hook_summary" },
      assistant([call("retry", "Skill", { skill: "deploy" })], "tool_use", stamp(4)),
      user([result("retry", "Unavailable", true)]),
      assistant([{ type: "text", text: "Second answer" }], "end_turn", stamp(5)),
    ]);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "user", "assistant", "assistant"]);
    expect(turns[1]?.parts).toEqual([{ kind: "notice", text: "Message held", source: "informational" }]);
    expect(turns.slice(2).map((turn) => turn.end_ts)).toEqual([stamp(3), stamp(5)]);
    expect(turns[2]?.parts.map((part) => part.kind)).toEqual(["tool", "tool", "thinking", "text"]);
    expect(tools(turns)).toMatchObject([
      { name: "Skill", output: "Loaded", skill: { name: "review", status: "loaded" } },
      { name: "Bash", output: `${"x".repeat(4000)}\n… trimmed`, output_ref: "run", output_size: 5000, error: true },
      { name: "Skill", output: "Unavailable", error: true, skill: { name: "deploy", status: "failed" } },
    ]);
    expect(turns.slice(2).map((turn) => turn.parts.at(-1))).toEqual([
      { kind: "text", text: "First answer", phase: "final_answer" }, { kind: "text", text: "Second answer", phase: "final_answer" },
    ]);
  });

  it("deduplicates all notification carriers before the assistant at work and keeps resumed task results", () => {
    const first = notification("review", "one", "First findings");
    const second = notification("review", "two", "Retry failed", "failed");
    const noticed = new Set(["prior\0prior-use"]);
    const subagents = new Map<string, SubagentDetail>([["review", { title: "Review the parser", agent: "reviewer" }]]);
    const turns = appendRecords([
      user("Start"),
      assistant([call("read", "Read", { file_path: "file.ts" })], "tool_use"),
      enqueue(notification("prior", "prior-use", "Already on another page")),
      enqueue(first),
      notifiedAttachment(first),
      user([{ type: "text", text: first }, result("read", "File read")]),
      user(second),
      enqueue(notification("shell", "shell-use", "Hidden command result", "completed", "Background command finished")),
      assistant([{ type: "text", text: "Finished" }], "end_turn"),
    ], { noticed, subagents });
    expect(turns.map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"], ["task_result"], ["task_result"], ["tool", "text"]]);
    expect(tasks(turns)).toMatchObject([
      { id: "review", title: "Review the parser", agent: "reviewer", status: "completed", result: "First findings" },
      { id: "review", title: "Review the parser", agent: "reviewer", status: "failed", result: "Retry failed" },
    ]);
    expect(tools(turns)[0]?.output).toBe("File read");
    expect([...noticed]).toEqual(["prior\0prior-use", "review\0one", "review\0two"]);
  });

  it("reads newly supplied subagent metadata without letting previews change caller-owned state", () => {
    const noticed = new Set<string>();
    const subagents = new Map<string, SubagentDetail>();
    const parser = createClaudeTranscriptParser({ noticed, subagents });
    const start = [user("Start"), assistant([call("read", "Read", { file_path: "file.ts" })], "tool_use")];
    parser.write(`${jsonl(...start)}\n`);
    const before = parser.snapshot();
    subagents.set("late", { title: "Metadata arrived", agent: "explorer" });
    const record = enqueue(notification("late", "launch", "Found it"));
    const preview = parser.snapshot(JSON.stringify(record));
    expect(tasks(preview)).toMatchObject([{ title: "Metadata arrived", agent: "explorer", result: "Found it" }]);
    expect(noticed.size).toBe(0);
    expect([...subagents]).toEqual([["late", { title: "Metadata arrived", agent: "explorer" }]]);
    expect(parser.snapshot()).toEqual(before);
    parser.write(`${jsonl(record, notifiedAttachment(record.content))}\n`);
    expect(parser.snapshot()).toEqual(preview);
    expect(parser.snapshot()).toEqual(parseClaudeTranscript(jsonl(...start, record), Infinity, { subagents }));
    expect([...noticed]).toEqual(["late\0launch"]);
    expect(before.map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"], ["tool"]]);
  });

  it("joins informational lines and deduplicates local-command echoes across chunk boundaries", () => {
    const turns = appendRecords([
      user("Work"),
      assistant([call("run", "Bash", { command: "run" })], "tool_use"),
      info("\u001b[31mMessage held\u001b[0m", 100),
      info("Try again", 101),
      local("Message held", 102),
      info("Later notice", 2000),
      local("Different notice", 2001),
      info("Different notice", 2002),
      user([result("run", "Done")]),
      assistant([{ type: "text", text: "Done" }], "end_turn"),
    ]);
    expect(turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice"))).toEqual([
      { kind: "notice", text: "Message held\nTry again", source: "informational" },
      { kind: "notice", text: "Later notice", source: "informational" },
      { kind: "notice", text: "Different notice", source: "local-command" },
    ]);
    expect(turns.at(-1)?.parts.map((part) => part.kind)).toEqual(["tool", "text"]);
  });

  it("removes sibling drafts after previews but retains prompts whose replies were committed", () => {
    const parser = createClaudeTranscriptParser();
    const draft = user("Cancelled draft", "parent");
    const resend = user([{ type: "text", text: "Actual prompt" }], "parent");
    const answer = assistant([{ type: "text", text: "Answer" }], "end_turn");
    parser.write(`${jsonl(draft, { type: "last-prompt" })}\n`);
    const old = parser.snapshot();
    expect(parser.snapshot(JSON.stringify(resend))[0]?.parts).toEqual([{ kind: "text", text: "Actual prompt" }]);
    expect(parser.snapshot(JSON.stringify(answer))).toHaveLength(2);
    parser.write(`${jsonl(resend)}\n`);
    expect(parser.snapshot()).toEqual([{ role: "user", ts: null, parts: [{ kind: "text", text: "Actual prompt" }] }]);
    expect(old[0]?.parts).toEqual([{ kind: "text", text: "Cancelled draft" }]);
    parser.write(`${jsonl(answer, user("A later sibling", "parent"))}\n`);
    expect(parser.snapshot()).toEqual(parseClaudeTranscript(jsonl(draft, resend, answer, user("A later sibling", "parent"))));
    expect(parser.snapshot().map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "Actual prompt" }, { kind: "text", text: "Answer", phase: "final_answer" }, { kind: "text", text: "A later sibling" },
    ]);
    const emptyReply = appendRecords([draft, assistant([], "end_turn"), resend]);
    expect(emptyReply.map((turn) => turn.parts[0])).toEqual([{ kind: "text", text: "Cancelled draft" }, { kind: "text", text: "Actual prompt" }]);
  });

  it("preserves peer dedup, queued human prompts, image refs, pastes and thinking-display updates", () => {
    const paste = '<pasted_content id="paste-one">\nPasted text\n</pasted_content id="paste-one">';
    const turns = appendRecords([
      { ...user([{ type: "text", text: paste }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoPRIVATEIMAGE" } }, { type: "image", source: { type: "base64", media_type: "application/pdf" } }]), uuid: "11111111-2222-3333-4444-555555555555" },
      { ...assistant([{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "Visible update" }]), thinkingDisplay: "updates" },
      peerAttachment,
      peerEcho,
      { ...user("Hidden meta body"), isMeta: true },
      enqueue(paste),
      { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: paste } },
      assistant([{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text: "Answer" }], "end_turn"),
    ]);
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "image", media_type: "image/png", ref: "11111111-2222-3333-4444-555555555555:1" }, { kind: "text", text: "Pasted text" }],
      [{ kind: "text", text: "Visible update", phase: "commentary" }],
      [{ kind: "notice", text: "Review ready", source: "peer:Reviewer" }],
      [{ kind: "text", text: "Pasted text" }],
      [{ kind: "thinking", text: "Private reasoning" }, { kind: "text", text: "Answer", phase: "final_answer" }],
    ]);
    expect(JSON.stringify(turns)).not.toContain("PRIVATEIMAGE");
    expect(JSON.stringify(turns)).not.toContain("Hidden meta body");
  });

  it("puts a subagent's hand-back report in its card, whichever of the two arrives first (#3658)", () => {
    const { handback, pointer, ended, report } = handbackRecords();
    for (const records of [[enqueue(ended), handback, user(ended)], [handback, user(ended)]]) {
      const turns = appendRecords([user("Price it"), assistant([{ type: "text", text: "Started." }], "end_turn"), ...records]);
      expect(turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice"))).toEqual([]);
      expect(tasks(turns).map(({ id, title, result }) => ({ id, title, result }))).toEqual([{ id: "a3e6", title: "Price the path", result: report }]);
    }
    // another session's message is still its own notice, and a pointer whose report never came stays as written
    const turns = appendRecords([{ ...handback, origin: { ...handback.origin, senderTaskId: undefined, from: "other" } }, user(notification("b1", "toolu_b1", pointer.replace("a3e6", "b1")))]);
    expect(turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice")).length).toBe(1);
    expect(tasks(turns).map((task) => task.result)).toEqual([pointer.replace("a3e6", "b1").trim()]);
  });

  it("names a tool's pictures and a prompt that is only a picture the same live as cold", () => {
    const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } };
    const turns = appendRecords([
      user("Open the shot"),
      assistant([call("read", "Read", { file_path: "shot.png" })], "tool_use"),
      { ...user([result("read", [{ type: "text", text: "Read output" }, picture])]), uuid: "11111111-2222-3333-4444-555555555555" },
      assistant([{ type: "text", text: "A pixel." }], "end_turn"),
      { ...user([picture]), uuid: "22222222-2222-3333-4444-555555555555" },
    ]);
    expect(tools(turns).map((tool) => tool.images)).toEqual([[{ media_type: "image/png", ref: "11111111-2222-3333-4444-555555555555:0:1" }]]);
    expect(turns.at(-1)?.parts).toEqual([{ kind: "image", media_type: "image/png", ref: "22222222-2222-3333-4444-555555555555:0" }]);
  });

  it("clears visible state and pending tools while keeping native notification and peer dedup semantics", () => {
    const notice = enqueue(notification("review", "one", "Old findings"));
    const clear = user("<command-name>/clear</command-name>");
    const before = [
      user("Old prompt"),
      assistant([call("stale", "Skill", { skill: "old" })], "tool_use"),
      notice,
      peerAttachment,
      { ...clear, isMeta: true },
      { ...user([{ type: "text", text: "Compacted summary" }]), isCompactSummary: true },
    ];
    const parser = createClaudeTranscriptParser();
    parser.write(`${jsonl(...before)}\n`);
    const saved = parser.snapshot();
    expect(saved.at(-1)?.parts).toEqual([{ kind: "compact", text: "Compacted summary" }]);
    expect(parser.snapshot(JSON.stringify(clear))).toEqual([]);
    expect(parser.snapshot()).toEqual(saved);
    parser.write(`${jsonl(clear, user([result("stale", "Too late", true)]), notice, peerEcho)}\n`);
    expect(parser.snapshot()).toEqual([]);
    const after = [user("New prompt"), assistant([call("fresh", "Skill", { skill: "new" })], "tool_use"), user([result("fresh", "Loaded")]), assistant([{ type: "text", text: "New answer" }], "end_turn")];
    parser.write(`${jsonl(...after)}\n`);
    expect(parser.snapshot()).toEqual(parseClaudeTranscript(jsonl(...before, clear, user([result("stale", "Too late", true)]), notice, peerEcho, ...after)));
    expect(parser.snapshot().map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"], ["tool", "text"]]);
    expect(tools(parser.snapshot())[0]?.skill).toMatchObject({ name: "new", status: "loaded" });
    expect(tools(saved)[0]?.skill).toMatchObject({ name: "old", status: "requested" });
  });

  it("previews torn and valid final records without consuming them", () => {
    const parser = createClaudeTranscriptParser();
    const prompt = user("Unicode reply");
    parser.write(`${jsonl(prompt)}\n`);
    const before = parser.snapshot();
    const tail = JSON.stringify(assistant([{ type: "text", text: "終🙂" }], "end_turn"));
    for (let cut = 1; cut < tail.length; cut++) expect(parser.snapshot(tail.slice(0, cut))).toEqual(before);
    const preview = parser.snapshot(tail);
    expect(preview.at(-1)?.parts).toEqual([{ kind: "text", text: "終🙂", phase: "final_answer" }]);
    expect(parser.snapshot()).toEqual(before);
    parser.write(tail);
    expect(parser.snapshot()).toEqual(preview);
    expect(parser.snapshot()).toEqual(parseClaudeTranscript(`${jsonl(prompt)}\n${tail}`));
    expect(before).toHaveLength(1);
  });
});

describe("a subagent's hand-back through the page reader (#3658)", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
  const shown = (turns: ConversationTurn[]) => ({
    notices: turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice")).length,
    results: tasks(turns).map((task) => task.result),
  });

  const rows = (turns: ConversationTurn[]) => turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : part.kind === "task_result" ? `card:${part.tasks[0]!.result.slice(0, 10)}` : part.kind).join(" "));

  for (const order of ["notification first", "hand-back first", "hand-back, reply, notification"] as const) {
    it(`puts the report in the card, warm as cold, with the ${order}`, () => {
      const { handback, ended, report } = handbackRecords();
      const records = order === "notification first" ? [enqueue(ended), handback, user(ended)]
        : order === "hand-back first" ? [handback, user(ended)]
        // the agent answers the report before the notification comes: the card stays where the report came, before that answer
        : [handback, assistant([{ type: "text", text: "Summary of the report" }], "end_turn"), user(ended)];
      const root = mkdtempSync(join(tmpdir(), "ovis-handback-page-")); roots.push(root);
      const path = join(root, "session.jsonl");
      writeFileSync(path, `${jsonl(user("Price it"), assistant([{ type: "text", text: "Started." }], "end_turn"), ...records)}\n`);
      const cold = transcriptPage("claude-transcript", path).turns;
      expect(shown(cold)).toEqual({ notices: 0, results: [report] });
      if (order === "hand-back, reply, notification") expect(rows(cold)).toEqual(["Price it", "Started.", "card:## Verdict", "Summary of the report"]);
      // the next prompt settles that turn: a warm read keeps what a cold one shows
      appendFileSync(path, `${jsonl(user("Thanks"), assistant([{ type: "text", text: "Sure." }], "end_turn"))}\n`);
      const warm = transcriptPage("claude-transcript", path).turns;
      forgetTranscriptState();
      expect(shown(warm)).toEqual({ notices: 0, results: [report] });
      expect(warm).toEqual(transcriptPage("claude-transcript", path).turns);
    });
  }

  it("keeps the first line's own indentation, a report that opens with code", () => {
    const { handback, ended } = handbackRecords(["", "    const x = 1;", "", "That is the line."]);
    expect(tasks(parseClaudeTranscript(jsonl(enqueue(ended), handback, user(ended)))).map((task) => task.result)).toEqual(["    const x = 1;\n\nThat is the line."]);
  });

  it("leaves a report longer than a card holds as the message it came as, whole", () => {
    const lines = [...Array.from({ length: 2_000 }, (_, index) => `line ${index} of the report`), "TAIL"];
    const { handback, ended, pointer } = handbackRecords(lines);
    const root = mkdtempSync(join(tmpdir(), "ovis-handback-page-")); roots.push(root);
    const path = join(root, "session.jsonl");
    writeFileSync(path, `${jsonl(user("Price it"), enqueue(ended), handback, user(ended))}\n`);
    const turns = transcriptPage("claude-transcript", path).turns;
    const notice = turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice"))[0];
    expect(notice?.kind === "notice" && notice.text.endsWith("TAIL")).toBeTrue();
    expect(tasks(turns).map((task) => task.result)).toEqual([pointer.trim()]);
  });
});
