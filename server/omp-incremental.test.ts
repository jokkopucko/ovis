import { expect, test } from "bun:test";
import type { ConversationTurn } from "../shared/protocol.ts";
import { createOmpTranscriptParser, parseOmpTranscript } from "./transcript-records.ts";

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}, timestamp?: string) => ({
  type: "message", ...(timestamp ? { timestamp } : {}), message: { role, content, ...extra },
});
const answer = (text: string, stopReason?: string) => message("assistant", [{ type: "text", text }], { stopReason });
const tools = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "tool" ? [part] : []));
const tasks = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "task_result" ? part.tasks : []));
const wake = (id: string) => ({
  type: "custom_message", customType: "omo-senpi:wake", display: false,
  details: [{ customType: "senpi-task.completion", details: [{ task_id: id, status: "completed", final_response: "Found it." }] }],
});
const titleResult = (id: string, title: string) => message("toolResult", "Started", {
  toolName: "task", toolCallId: `call-${id}`, details: { task_id: id, task_summary: title },
});

function appendRecords(rows: unknown[], options: { images?: boolean } = {}) {
  const parser = createOmpTranscriptParser(options);
  let committed = "";
  for (const row of rows) {
    const line = JSON.stringify(row);
    const before = parser.snapshot();
    expect(parser.snapshot(line.slice(0, -1))).toEqual(before);
    expect(parser.snapshot(line)).toEqual(parseOmpTranscript(committed + line, Infinity, options));
    expect(parser.snapshot()).toEqual(before);
    parser.write(line + "\n");
    committed += line + "\n";
    expect(parser.snapshot()).toEqual(parseOmpTranscript(committed, Infinity, options));
  }
  return parser;
}

test("delayed results update the right tool across turns without changing older or speculative snapshots", () => {
  const opening = [
    message("user", "Inspect the file"),
    message("assistant", [
      { type: "thinking", thinking: "Check the contents" },
      { type: "toolCall", callId: "read", toolName: "Read", toolInput: { file_path: "/tmp/a" }, intent: "Read the file" },
    ], { stopReason: "toolUse" }, "2026-10-01T00:00:01Z"),
  ];
  const intervening = [message("user", "Also check the build"), answer("Checking both", "stop")];
  const result = message("toolResult", [
    { type: "text", text: "x".repeat(7000) },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
    { type: "image", mimeType: "image/svg+xml", data: "ignored" },
  ], { callId: "read", isError: true });
  const parser = createOmpTranscriptParser({ images: true });
  parser.write(jsonl(opening));
  const older = parser.snapshot();
  const original = structuredClone(older);
  parser.write(jsonl(intervening));
  const beforeResult = parser.snapshot();
  const preview = parser.snapshot(JSON.stringify(result));
  expect(tools(preview)[0]).toEqual({
    kind: "tool", name: "Read", summary: "Read the file", input: '{\n  "file_path": "/tmp/a"\n}',
    output: "x".repeat(4000) + "\n… trimmed", output_ref: "read", output_size: 7000, error: true,
    images: [{ media_type: "image/png", ref: "pi:read:0" }],
  });
  expect(parser.snapshot()).toEqual(beforeResult);
  tools(preview)[0]!.output = "consumer edit";
  tools(preview)[0]!.images![0]!.ref = "consumer edit";
  parser.write(jsonl([result]));
  const exposed = parser.snapshot();
  tools(exposed)[0]!.images![0]!.ref = "consumer edit";
  exposed[0]!.parts.length = 0;
  expect(parser.snapshot()).toEqual(parseOmpTranscript(jsonl([...opening, ...intervening, result]), Infinity, { images: true }));
  expect(tools(parser.snapshot())[0]?.output).toBe("x".repeat(4000) + "\n… trimmed");
  expect(tools(parser.snapshot())[0]?.images).toEqual([{ media_type: "image/png", ref: "pi:read:0" }]);
  expect(older).toEqual(original);
  expect(tools(older)[0]?.output).toBe("");
  expect(tools(beforeResult)[0]?.output).toBe("");
});

test("embedded results and Pi aliases normalize once, including results placed before their calls", () => {
  const rows = [
    message("assistant", [
      { type: "toolResult", id: "inline", output: [{ type: "text", text: "inline failure" }, { type: "image", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" }], isError: true },
      { type: "toolCall", toolCallId: "inline", toolName: "Bash", input: { command: "false" } },
      { type: "toolCall", id: "later", name: "Read", arguments: { path: "/tmp/later" } },
    ], { stopReason: "toolUse" }),
    message("toolResult", "hidden", { toolCallId: "later", display: false }),
    message("assistant", "hidden answer", { display: false, stopReason: "stop" }),
    message("toolResult", "later output", { toolCallId: "later" }),
    answer("Finished", "stop"),
  ];
  const turns = appendRecords(rows).snapshot();
  expect(turns).toHaveLength(1);
  expect(tools(turns)).toEqual([
    { kind: "tool", name: "Bash", summary: "false", input: '{\n  "command": "false"\n}', output: "inline failure", error: true },
    { kind: "tool", name: "Read", summary: "/tmp/later", input: '{\n  "path": "/tmp/later"\n}', output: "later output" },
  ]);
  expect(turns[0]?.parts.at(-1)).toEqual({ kind: "text", text: "Finished", phase: "final_answer" });
  expect(tools(appendRecords(rows, { images: true }).snapshot())[0]?.images).toEqual([{ media_type: "image/jpeg", ref: "pi:inline:0" }]);
});

test("settled boundaries survive previews, hidden wakeups, empty assistant messages and later errors", () => {
  const rows = [
    answer("The complete answer", "stop"),
    { type: "custom_message", customType: "monitor", display: false, content: "runtime only" },
    message("assistant", [{ type: "thinking", text: "New work" }], { stopReason: "toolUse" }),
    message("assistant", [], { stopReason: "error", errorMessage: "Provider unavailable" }),
    answer("Recovered", "stop"),
    message("assistant", [], { stopReason: "stop" }),
    answer("Another wake", "stop"),
  ];
  expect(appendRecords(rows).snapshot().map((turn) => turn.parts)).toEqual([
    [{ kind: "text", text: "The complete answer", phase: "final_answer" }],
    [{ kind: "thinking", text: "New work" }, { kind: "text", text: "Error: Provider unavailable", failed: true }, { kind: "text", text: "Recovered", phase: "final_answer" }],
    [{ kind: "text", text: "Another wake", phase: "final_answer" }],
  ]);
});

test("committed task titles reach the supplied map while speculative titles remain isolated", () => {
  const titles = new Map([["seeded", "Seed title"]]);
  const parser = createOmpTranscriptParser({ taskTitles: titles });
  const first = titleResult("first", "Locate the record");
  parser.write(jsonl([first]));
  expect([...titles]).toEqual([["seeded", "Seed title"], ["first", "Locate the record"]]);
  const speculative = titleResult("later", "Speculative title");
  parser.snapshot(JSON.stringify(speculative));
  expect(titles.has("later")).toBe(false);
  expect(tasks(parser.snapshot(JSON.stringify(wake("later"))))[0]?.title).toBe("later");
  expect(parser.snapshot()).toEqual([]);
  parser.write(jsonl([wake("first"), wake("seeded")]));
  const older = parser.snapshot();
  titles.set("seeded", "Updated externally");
  parser.write(jsonl([speculative, wake("later"), wake("seeded")]));
  expect(tasks(parser.snapshot()).map((task) => task.title)).toEqual(["Locate the record", "Seed title", "Speculative title", "Updated externally"]);
  expect(tasks(older).map((task) => task.title)).toEqual(["Locate the record", "Seed title"]);
  expect(titles.get("later")).toBe("Speculative title");

  const oneShotTitles = new Map<string, string>();
  expect(tasks(parseOmpTranscript(jsonl([first, wake("first")]), 100, { taskTitles: oneShotTitles }))[0]?.title).toBe("Locate the record");
  expect(oneShotTitles.get("first")).toBe("Locate the record");
});

test("late skill invocations and notices stay user turns and compaction keeps preceding history", () => {
  const rows = [
    message("user", '<skill name="review" location="/skills/review/SKILL.md">\nPRIVATE INSTRUCTIONS\n</skill>\n\nreview the diff'),
    answer("Review complete", "stop"),
    { type: "custom_message", customType: "skill-prompt", display: false, details: { name: "hidden" }, content: "hidden skill" },
    { type: "custom_message", customType: "skill-prompt", details: { name: "audit", path: "/skills/audit.md", args: "the result" }, content: "PRIVATE EXPANSION" },
    answer("Audited", "stop"),
    { type: "custom_message", customType: "async-result", display: true, content: "<system-notice>\nBackground task finished\n</system-notice>" },
    { type: "compaction", summary: "Earlier work was summarized" },
    { type: "compaction", summary: "  " },
  ];
  const turns = appendRecords(rows).snapshot();
  expect(turns.map((turn) => turn.parts)).toEqual([
    [{ kind: "text", text: "review the diff" }, { kind: "skill", skill: { name: "review", path: "/skills/review/SKILL.md", evidence: "instructions", status: "loaded" } }],
    [{ kind: "text", text: "Review complete", phase: "final_answer" }],
    [{ kind: "text", text: "/skill:audit the result" }, { kind: "skill", skill: { name: "audit", path: "/skills/audit.md", evidence: "instructions", status: "loaded" } }],
    [{ kind: "text", text: "Audited", phase: "final_answer" }],
    [{ kind: "notice", text: "Background task finished", source: "async-result" }],
    [{ kind: "compact", text: "Earlier work was summarized" }],
  ]);
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user"]);
  expect(JSON.stringify(turns)).not.toContain("PRIVATE");
});

test("a valid clear preview is detached, committed clear drops old tools but preserves collected task titles", () => {
  const clear = { type: "custom", customType: "context_clear" };
  const opening = [
    titleResult("task", "Remember the task"),
    message("assistant", [{ type: "toolCall", id: "old", name: "Read", arguments: {} }], { stopReason: "stop" }),
    { type: "compaction", summary: "Keep this history until clear" },
  ];
  const after = [message("toolResult", "late old output", { toolCallId: "old" }), answer("New context", "stop"), wake("task")];
  const titles = new Map<string, string>();
  const parser = createOmpTranscriptParser({ taskTitles: titles });
  parser.write(jsonl(opening));
  const older = parser.snapshot();
  expect(older).toHaveLength(2);
  expect(parser.snapshot(JSON.stringify(clear).slice(0, -1))).toEqual(older);
  expect(parser.snapshot(JSON.stringify(clear))).toEqual([]);
  expect(parser.snapshot()).toEqual(older);
  expect(titles.get("task")).toBe("Remember the task");
  parser.write(jsonl([clear, ...after]));
  const current = parser.snapshot();
  expect(current).toEqual(parseOmpTranscript(jsonl([...opening, clear, ...after]), Infinity));
  expect(current.map((turn) => turn.parts[0]?.kind)).toEqual(["text", "task_result"]);
  expect(current[0]?.parts).toEqual([{ kind: "text", text: "New context", phase: "final_answer" }]);
  expect(tasks(current)[0]?.title).toBe("Remember the task");
  expect(tools(current)).toEqual([]);
  expect(tools(older)[0]?.output).toBe("");
  expect(older[1]?.parts).toEqual([{ kind: "compact", text: "Keep this history until clear" }]);
});

test("a goal's wait is withdrawn the same way record by record, in previews and in one-shot parses", () => {
  const warmup = (phase: string) => ({ type: "custom", customType: "goal-cache-warmup", data: { phase, dueAtMs: 1_790_000_000_000, wakeSources: { "terminal-monitors": 1 } } });
  const parser = appendRecords([
    message("user", "Watch the build"),
    answer("Watching", "stop"),
    warmup("scheduled"),
    { type: "custom", customType: "engine-turn-start", data: { customType: "senpi-monitor:notification" } },
    answer("Build passed", "stop"),
    warmup("scheduled"),
    warmup("scheduled"),
    warmup("resumed"),
    { type: "custom_message", customType: "goal-continuation", display: false, content: "<untrusted_objective>\nShip it\n</untrusted_objective>" },
    warmup("scheduled"),
    answer("Shipped", "stop"),
  ]);
  expect(parser.snapshot().map((turn) => turn.parts[0]?.kind)).toEqual(["text", "text", "text", "notice", "text"]);
});

test("snapshots retain the normalized window while one-shot turn limits and final-line handling stay compatible", () => {
  const rows = Array.from({ length: 105 }, (_, i) => message("user", `request ${i}`));
  const parser = createOmpTranscriptParser();
  parser.write(jsonl(rows.slice(0, -1)));
  const final = JSON.stringify(rows.at(-1));
  expect(parser.snapshot(final)).toHaveLength(105);
  expect(parser.snapshot(final.slice(0, -1))).toHaveLength(104);
  expect(parser.snapshot()).toHaveLength(104);
  parser.write(final + "\n");
  const text = jsonl(rows).trimEnd();
  expect(parser.snapshot()).toEqual(parseOmpTranscript(text, Infinity));
  expect(parseOmpTranscript(text)).toHaveLength(100);
  expect(parseOmpTranscript(text, 2)).toEqual([
    { role: "user", ts: null, parts: [{ kind: "text", text: "request 103" }] },
    { role: "user", ts: null, parts: [{ kind: "text", text: "request 104" }] },
  ]);
});
