import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { HerdrPane, OmoTask } from "../shared/protocol.ts";
import { BackgroundWait, WAIT_LIMIT_MS } from "./background-wait.ts";
import { ClaudeSubagentStatus, DETAIL_LIMITS, LOOP_HOLD_MS, backgroundAgentDetail, backgroundCommand, claudeSubagentState, detailIo, claudeSubagents, forgetSubagents, lineNotifications, plain, readLines, remember, subagentDetails, taskNotification, validDetailId, wholeClaudeSubagents, within } from "./claude-subagents.ts";
import { scanClaudeTasks } from "./claude-task-scan.ts";
import { commandHistory, commandHistorySize, holdCommandHistory, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";
import { runFileTask } from "./file-tasks.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetSubagents();
});

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const at = (minutes: number): string => new Date(NOW - 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

function session() {
  const root = mkdtempSync(join(tmpdir(), "herdr-subagents-"));
  roots.push(root);
  const path = join(root, "projects", "p", "11111111-1111-4111-8111-111111111111.jsonl");
  const dir = join(root, "projects", "p", "11111111-1111-4111-8111-111111111111", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, json({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
  return {
    path,
    parent: (entry: unknown) => appendFileSync(path, json(entry)),
    /** the pair of files of one subagent, its transcript as (minute, usage) steps */
    agent(id: string, options: { description?: string; type?: string; toolUseId?: string; shape?: string; steps?: [number, number][] } = {}) {
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: options.type ?? "reviewer", description: options.description ?? `task ${id}`, toolUseId: options.toolUseId ?? `toolu_${id}`, spawnDepth: 1, requestShape: options.shape ?? "background" }));
      const file = join(dir, `agent-${id}.jsonl`);
      writeFileSync(file, "");
      for (const [minute, output] of options.steps ?? [[1, 10], [2, 20]]) this.work(id, minute, output);
      return file;
    },
    work(id: string, minute: number, output: number, tools = 1) {
      const file = join(dir, `agent-${id}.jsonl`);
      appendFileSync(file, json({ isSidechain: true, sessionId: "11111111-1111-4111-8111-111111111111", agentId: id, type: "user", timestamp: at(minute), message: { role: "user", content: "x" } }));
      appendFileSync(file, json({ isSidechain: true, sessionId: "11111111-1111-4111-8111-111111111111", agentId: id, type: "assistant", timestamp: at(minute), message: { id: `m${minute}`, model: "claude-opus-5", usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: output }, content: Array.from({ length: tools }, () => ({ type: "tool_use", id: "t", name: "Read", input: {} })) } }));
    },
    /** a Bash call sent to the background, by the session or (`file`) by a subagent */
    bash(taskId: string, minute: number, options: { description?: string; command?: string; file?: string } = {}) {
      const write = (entry: unknown) => options.file ? appendFileSync(options.file, json({ isSidechain: true, ...(entry as object) })) : this.parent(entry);
      write({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${taskId}`, name: "Bash", input: { command: options.command ?? "bun test", ...(options.description === undefined ? {} : { description: options.description }), run_in_background: true } }] } });
      write({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId } });
    },
    /** a prompt the person typed; `origin` as Claude Code 2.1.2xx writes it, none (only the permission mode) as older ones do */
    prompt(minute: number, origin: string | null = "human") {
      this.parent({ type: "user", timestamp: at(minute), permissionMode: "default", ...(origin === null ? {} : { origin: { kind: origin } }), message: { role: "user", content: "next" } });
    },
    notify(id: string, minute: number, options: { status?: string; toolUseId?: string; summary?: string; carriers?: ("user" | "queue" | "attachment")[] } = {}) {
      const block = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${options.toolUseId ?? `toolu_${id}`}</tool-use-id>\n<status>${options.status ?? "completed"}</status>\n<summary>${options.summary ?? `Agent "task ${id}" finished`}</summary>\n<result>the answer</result>\n</task-notification>`;
      const timestamp = at(minute);
      for (const carrier of options.carriers ?? ["queue", "user", "attachment"]) {
        this.parent(carrier === "queue" ? { type: "queue-operation", operation: "enqueue", timestamp, content: block }
          : carrier === "user" ? { type: "user", timestamp, message: { role: "user", content: block } }
            : { type: "attachment", timestamp, attachment: { type: "queued_command", commandMode: "task-notification", prompt: block } });
      }
    },
  };
}

const ids = (path: string, live = true) => claudeSubagents(path, live, NOW).map((task) => `${task.id}:${task.status}`);

describe("claudeSubagents", () => {
  it("lists a subagent nothing has ended as running, with what its transcript says", () => {
    const s = session();
    s.agent("a1", { description: "Review the parser", type: "reviewer", steps: [[1, 10], [2, 30]] });
    expect(claudeSubagents(s.path, true, NOW)).toEqual([{
      id: "a1", title: "Review the parser", category: "reviewer", model: "claude-opus-5", status: "running",
      started_at: at(1), ended_at: null, turns: 2, tool_calls: 2,
      // the last request held 2 + 100 + 5 + 30 tokens: not the sum of both requests
      tokens: 137,
      detail_kind: "claude-subagent",
    }]);
  });

  it("counts a notification once however many records carry it", () => {
    const s = session();
    s.agent("a1");
    s.notify("a1", 3);
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "a1", status: "completed", ended_at: at(3) }]);
  });

  it("reads the status a notification gives: failed, and stopped as cancelled", () => {
    const s = session();
    s.agent("a1");
    s.agent("a2");
    s.notify("a1", 3, { status: "failed" });
    s.notify("a2", 4, { status: "killed", summary: 'Agent "task a2" was stopped by Claude' });
    expect(ids(s.path)).toEqual(["a2:cancelled", "a1:failed"]);
  });

  it("does not take a background command's notification for an agent's", () => {
    const s = session();
    s.agent("a1");
    s.notify("a1", 3, { summary: 'Background command "sleep" completed (exit code 0)' });
    expect(ids(s.path)).toEqual(["a1:running"]);
  });

  it("reads a subagent whose file has entries after its notification as running again", () => {
    const s = session();
    s.agent("a1");
    s.notify("a1", 3);
    expect(ids(s.path)).toEqual(["a1:completed"]);
    // resumed with another message: it works again, and its next notification ends it again
    s.work("a1", 5, 40);
    expect(ids(s.path)).toEqual(["a1:running"]);
    s.notify("a1", 6, { toolUseId: "toolu_resume" });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "a1", status: "completed", ended_at: at(6), turns: 3 }]);
  });

  it("ends a synchronous call by its tool_result, and not a background one", () => {
    const s = session();
    s.agent("sync", { shape: "foreground", toolUseId: "toolu_sync" });
    s.agent("bad", { shape: "foreground", toolUseId: "toolu_bad" });
    s.agent("bg", { toolUseId: "toolu_bg" });
    s.parent({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: ["sync", "bad", "bg"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name: "Agent", input: {} })) } });
    // the launch of a background agent is answered at once too
    s.parent({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Async agent launched successfully" }] } });
    expect(ids(s.path).sort()).toEqual(["bad:running", "bg:running", "sync:running"]);
    s.parent({ type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sync", content: "answer" }] } });
    s.parent({ type: "user", timestamp: at(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bad", content: "boom", is_error: true }] } });
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.status}:${task.ended_at}`).sort()).toEqual([`bad:failed:${at(5)}`, "bg:running:null", `sync:completed:${at(4)}`].sort());
  });

  it("reads what is running as lost once the pane no longer runs Claude on the session", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 10], [7, 10]] });
    s.agent("a2");
    s.notify("a2", 3);
    expect(claudeSubagents(s.path, false, NOW).map((task) => [task.id, task.status, task.ended_at])).toEqual([["a1", "lost", at(7)], ["a2", "completed", at(3)]]);
  });

  it("lists running first and at most ten that ended in the last day, newest first", () => {
    const s = session();
    for (let n = 0; n < 12; n++) {
      s.agent(`e${n}`, { steps: [[1, 1]] });
      s.notify(`e${n}`, 10 + n);
    }
    s.agent("old", { steps: [[-2001, 1]] });
    s.notify("old", -2000);
    s.agent("run", { steps: [[1, 1]] });
    expect(ids(s.path)).toEqual(["run:running", ...Array.from({ length: 10 }, (_, n) => `e${11 - n}:completed`)]);
  });

  it("passes over a subagent whose file has been quiet for more than a day", () => {
    const s = session();
    const file = s.agent("stale");
    s.agent("fresh");
    const old = new Date(NOW - 25 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    expect(ids(s.path)).toEqual(["fresh:running"]);
  });

  it("reads only what a file gained, and nothing of one that did not change", () => {
    const s = session();
    const file = s.agent("a1");
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(2);
    // a torn last line is read once it is whole
    appendFileSync(file, '{"type":"assistant","timestamp":"');
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(2);
    appendFileSync(file, `${at(9)}","message":{"id":"m9","content":[]}}\n`);
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(3);
    // the same answer from a cold read
    const warm = claudeSubagents(s.path, true, NOW);
    forgetSubagents();
    expect(claudeSubagents(s.path, true, NOW)).toEqual(warm);
  });

  it("reads a large subagent file over several calls, a budget at a time", () => {
    const s = session();
    const file = s.agent("big", { steps: [] });
    const line = json({ type: "assistant", timestamp: at(1), message: { id: "x", content: [], padding: "p".repeat(1000) } });
    const turn = (n: number) => line.replace('"id":"x"', `"id":"m${n}"`);
    // 10 MB of lines, each a request of its own
    writeFileSync(file, Array.from({ length: 10_000 }, (_, n) => turn(n)).join(""));
    const first = claudeSubagents(s.path, true, NOW)[0]!.turns;
    // a count that is not the whole is not shown as one
    expect(first).toBeNull();
    expect(claudeSubagents(s.path, true, NOW)[0]!.turns).toBe(10_000);
  });

  it("reads a subagent file past one read's budget whole on a file thread, so its first answer has the counts", () => {
    const s = session();
    const file = s.agent("big", { steps: [] });
    const line = json({ type: "assistant", timestamp: at(1), message: { id: "x", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t", name: "Read", input: {} }], padding: "p".repeat(1000) } });
    // 10 MB of lines, each a request of its own: more than one read's budget
    writeFileSync(file, Array.from({ length: 10_000 }, (_, n) => line.replace('"id":"x"', `"id":"m${n}"`)).join(""));
    // a file thread's caches start cold: its first answer is all it gives
    const [task] = runFileTask({ op: "claude-tasks", path: s.path, live: true, since: null }) as OmoTask[];
    expect([task!.turns, task!.tool_calls, task!.tokens, task!.model]).toEqual([10_000, 10_000, 2, "claude-opus-5"]);
  });

  it("does not take an agent for running when the part of the transcript read starts after it went quiet", () => {
    const s = session();
    s.agent("quiet", { steps: [[1, 1]] });
    s.agent("busy", { steps: [[1, 1]] });
    // 17 MB of an older conversation is out of reach: only its last 16 MB is read
    writeFileSync(s.path, "");
    const filler = json({ type: "user", timestamp: at(2), message: { role: "user", content: "f".repeat(1000) } });
    writeFileSync(s.path, filler.repeat(17_000));
    s.parent({ type: "user", timestamp: at(30), message: { role: "user", content: "later" } });
    s.work("busy", 31, 1);
    s.notify("busy", 32);
    // the first read takes the whole window: no call before the notice is reached says "running"
    expect(ids(s.path)).toEqual(["busy:completed"]);
  });

  it("has nothing for a session with no subagents folder, or files that are not records", () => {
    const s = session();
    expect(ids(join(s.path, "..", "none.jsonl"))).toEqual([]);
    writeFileSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", "agent-x.meta.json"), "{ torn");
    writeFileSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", "agent-x.jsonl"), "not json\n");
    expect(ids(s.path)).toEqual([]);
  });
});

describe("subagentDetails", () => {
  it("answers for the agents asked about", () => {
    const s = session();
    s.agent("a1", { description: "Review the parser", type: "reviewer", steps: [[1, 10], [2, 30]] });
    s.agent("a2");
    expect([...subagentDetails(s.path, ["a1", "gone"])]).toEqual([["a1", { title: "Review the parser", agent: "reviewer" }]]);
  });
});

describe("backgroundAgentDetail", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  /** one assistant entry: its blocks, under a message id of its own */
  /** a record of the agent a1's own file, as Claude Code writes it: the sidechain of its session and agent */
  const own = (entry: object, id = "a1") => json({ isSidechain: true, sessionId: SESSION, agentId: id, ...entry });
  const assistant = (minute: number, content: unknown[], extra: object = {}) => own({ type: "assistant", timestamp: at(minute), message: { id: `m${minute}`, model: "claude-opus-5", content, stop_reason: "tool_use" }, ...extra });
  const detailOf = (path: string, id: string) => {
    const read = backgroundAgentDetail(path, id);
    if (!("detail" in read)) throw new Error(`refused: ${read.refusal}`);
    return read.detail;
  };

  /** the detail, with every byte the transcript's own descriptor gave the read: the bytes in all, and the spans read, in order */
  const reading = (path: string) => {
    const opened = new Map<number, string>();
    const spans: Array<[number, number]> = [];
    const { openSync, readSync } = detailIo;
    detailIo.openSync = ((name: string, flags: number) => { const fd = openSync(name, flags); opened.set(fd, name); return fd; }) as typeof openSync;
    detailIo.readSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const n = readSync(fd, buffer, offset, length, position);
      if (opened.get(fd)?.endsWith(".jsonl")) spans.push([position, position + n]);
      return n;
    }) as typeof readSync;
    let detail: ReturnType<typeof detailOf>;
    try { detail = detailOf(path, "a1"); } finally { Object.assign(detailIo, { openSync, readSync }); }
    spans.sort((a, b) => a[0] - b[0]);
    const size = statSync(join(path, "..", SESSION, "subagents", "agent-a1.jsonl")).size;
    return { detail, spans, size, total: spans.reduce((sum, [from, to]) => sum + to - from, 0) };
  };
  /** `head` and then records of about 4 KiB, the last one padded so that the file is `bytes` long */
  const filled = (head: string, bytes: number): string => {
    let out = head;
    for (let index = 1; Buffer.byteLength(out, "utf8") < bytes; index++) {
      const bare = Buffer.byteLength(assistant(index, [{ type: "text", text: `e${index}` }], { pad: "" }), "utf8");
      const room = bytes - Buffer.byteLength(out, "utf8") - bare;
      if (room < 0) throw new Error("no room for a whole record");
      out += assistant(index, [{ type: "text", text: `e${index}` }], { pad: "p".repeat(room <= 8000 ? room : 4000) });
    }
    return out;
  };

  it("reads bounded running agent content", () => {
    const s = session();
    const file = s.agent("a1", { description: "Review the parser", type: "reviewer", steps: [] });
    writeFileSync(file, [
      own({ type: "user", timestamp: at(1), message: { role: "user", content: "Review src/parser.ts for off-by-one errors" } }),
      assistant(2, [{ type: "thinking", thinking: "private", signature: "x" }, { type: "text", text: "Reading the parser first." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/parser.ts" } }]),
      own({ type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export function parse() {}" }] } }),
      own({ type: "user", timestamp: at(3), message: { role: "user", content: "Also check the lexer" } }),
      assistant(3, [{ type: "text", text: "The lexer is fine." }, { type: "tool_use", id: "t2", name: "Grep", input: {} }]),
    ].join(""));
    expect(detailOf(s.path, "a1")).toEqual({
      agent_id: "a1", session_id: SESSION, title: "Review the parser", agent: "reviewer",
      prompt: "Review src/parser.ts for off-by-one errors",
      // the thinking, the tool's answer and the later instruction are not the agent's own activity
      events: [
        { kind: "text", text: "Reading the parser first.", at: at(2) },
        { kind: "tool", text: 'Read {"file_path":"src/parser.ts"}', at: at(2) },
        { kind: "text", text: "The lexer is fine.", at: at(3) },
        { kind: "tool", text: "Grep {}", at: at(3) },
      ],
      truncated: false, incomplete: false, limits: DETAIL_LIMITS,
    });
    // the list says which rows can be opened: a subagent, not a command
    s.bash("b1", 4, { description: "Run the suite" });
    expect(claudeSubagents(s.path, true, NOW).map((task) => [task.id, task.detail_kind])).toEqual([["a1", "claude-subagent"], ["b1", null]]);
    // a file not written yet says so with nothing in it, not with an activity it does not know
    s.agent("a2", { steps: [] });
    expect(detailOf(s.path, "a2")).toMatchObject({ prompt: null, events: [], truncated: false, incomplete: false });
  });

  it("partial and oversized records report incomplete", () => {
    const s = session();
    const file = s.agent("a1", { steps: [] });
    writeFileSync(file, [
      own({ type: "user", timestamp: at(1), message: { role: "user", content: "go" } }),
      assistant(2, [{ type: "text", text: "first" }]),
      // a complete record over its size, a line that is no record, and a trailing record still being written
      assistant(3, [{ type: "text", text: "x".repeat(70_000) }]),
      "not a record\n",
      assistant(4, [{ type: "text", text: "second" }]),
      assistant(5, [{ type: "text", text: "torn" }]).slice(0, -20),
    ].join(""));
    expect(detailOf(s.path, "a1")).toMatchObject({ prompt: "go", events: [{ kind: "text", text: "first" }, { kind: "text", text: "second" }], truncated: false, incomplete: true });
    // a meta file being written, or over its size, is no agent yet
    writeFileSync(join(s.path, "..", SESSION, "subagents", "agent-a1.meta.json"), "{ torn");
    expect(backgroundAgentDetail(s.path, "a1")).toEqual({ refusal: "not_found" });
    writeFileSync(join(s.path, "..", SESSION, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "x".repeat(70_000) }));
    expect(backgroundAgentDetail(s.path, "a1")).toEqual({ refusal: "not_found" });
  });

  it("head and tail budgets never overlap or exceed limits", () => {
    const s = session();
    const file = s.agent("a1", { steps: [] });
    const prompt = own({ type: "user", timestamp: at(0), message: { role: "user", content: "the dispatch" } });
    // records of 4 KiB that each carry one short event: the windows cut the file, not the text budget
    const record = (index: number) => assistant(index, [{ type: "text", text: `e${index}` }], { pad: "p".repeat(4000) });
    const indexOf = (event: { text: string }) => Number(event.text.slice(1));
    writeFileSync(file, prompt + Array.from({ length: 100 }, (_, index) => record(index + 1)).join(""));
    const large = detailOf(s.path, "a1");
    expect(large.prompt).toBe("the dispatch");
    expect(large.truncated).toBe(true);
    const indexes = large.events.map(indexOf);
    // the start of the file and its end, each window's records in order, once each, and a gap between that neither read
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    const gap = indexes.findIndex((index, position) => position > 0 && index !== indexes[position - 1]! + 1);
    expect(gap).toBeGreaterThan(0);
    expect(indexes[0]).toBe(1);
    expect(indexes.at(-1)).toBe(100);
    expect(indexes.slice(0, gap)).toEqual(Array.from({ length: gap }, (_, index) => index + 1));
    const head = indexes.slice(0, gap).length * 4096;
    const tail = (100 - indexes[gap]! + 1) * 4096;
    expect(head).toBeLessThanOrEqual(64 * 1024);
    expect(tail).toBeLessThanOrEqual(DETAIL_LIMITS.max_read_bytes - 64 * 1024);
    // the reads themselves: what the transcript's descriptor gave, at most the budget, no byte twice, the head and the end
    const over = reading(s.path);
    expect(over.size).toBeGreaterThan(DETAIL_LIMITS.max_read_bytes);
    expect(over.total).toBe(DETAIL_LIMITS.max_read_bytes);
    expect(over.spans[0]![0]).toBe(0);
    expect(over.spans.at(-1)![1]).toBe(over.size);
    for (let index = 1; index < over.spans.length; index++) expect(over.spans[index]![0]).toBeGreaterThanOrEqual(over.spans[index - 1]![1]);
    // at the budget the file is read whole; a byte over it, the two windows, and still not a byte more than the budget
    writeFileSync(file, filled(prompt, DETAIL_LIMITS.max_read_bytes));
    const atBudget = reading(s.path);
    expect([atBudget.size, atBudget.total, atBudget.detail.truncated]).toEqual([DETAIL_LIMITS.max_read_bytes, DETAIL_LIMITS.max_read_bytes, false]);
    writeFileSync(file, filled(prompt, DETAIL_LIMITS.max_read_bytes + 1));
    const byteOver = reading(s.path);
    expect([byteOver.size, byteOver.total, byteOver.detail.truncated]).toEqual([DETAIL_LIMITS.max_read_bytes + 1, DETAIL_LIMITS.max_read_bytes, true]);
    expect(byteOver.detail.prompt).toBe("the dispatch");
    // a file that fits the read budget is read whole
    writeFileSync(file, prompt + Array.from({ length: 40 }, (_, index) => record(index + 1)).join(""));
    const whole = detailOf(s.path, "a1");
    expect(whole.events.map(indexOf)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(whole).toMatchObject({ truncated: false, incomplete: false });
    // more events than the cap: the newest are kept, and said to be a part
    writeFileSync(file, prompt + Array.from({ length: 200 }, (_, index) => assistant(index + 1, [{ type: "text", text: `e${index + 1}` }])).join(""));
    const capped = detailOf(s.path, "a1");
    expect(capped.events).toHaveLength(DETAIL_LIMITS.max_events);
    expect(capped.events.map(indexOf)).toEqual(Array.from({ length: DETAIL_LIMITS.max_events }, (_, index) => 200 - DETAIL_LIMITS.max_events + index + 1));
    expect(capped.truncated).toBe(true);
    // more text than the budget: the newest events that fit, whole, and the prompt before them
    writeFileSync(file, prompt + Array.from({ length: 10 }, (_, index) => assistant(index + 1, [{ type: "text", text: `${index + 1}:${"t".repeat(20 * 1024)}` }])).join(""));
    const budgeted = detailOf(s.path, "a1");
    const bytes = budgeted.events.reduce((sum, event) => sum + Buffer.byteLength(event.text, "utf8"), Buffer.byteLength(budgeted.prompt ?? "", "utf8"));
    expect(bytes).toBeLessThanOrEqual(DETAIL_LIMITS.max_output_bytes);
    expect(budgeted.events.map((event) => event.text.split(":")[0])).toEqual(["5", "6", "7", "8", "9", "10"]);
    expect(budgeted.events.every((event) => event.text.endsWith("t".repeat(20 * 1024)))).toBe(true);
    expect(budgeted).toMatchObject({ prompt: "the dispatch", truncated: true, incomplete: false });
  });

  it("rejects traversal and symlink escapes", () => {
    const s = session();
    s.agent("a1", { description: "inside" });
    for (const id of ["", "..", "x/../../../secret", "a/b", "/etc/passwd", "a b", "a\0b", "x".repeat(129)]) {
      expect([id.slice(0, 20), validDetailId(id)]).toEqual([id.slice(0, 20), false]);
      expect(backgroundAgentDetail(s.path, id)).toEqual({ refusal: "unavailable" });
    }
    expect(validDetailId("x".repeat(128))).toBe(true);
    const dir = join(s.path, "..", SESSION, "subagents");
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "agent-l1.meta.json"), JSON.stringify({ agentType: "x", description: "outside" }));
    writeFileSync(join(outside, "agent-l1.jsonl"), json({ type: "user", message: { content: "secret" } }));
    // an agent whose files are links, to anywhere, is none of this session's
    symlinkSync(join(outside, "agent-l1.meta.json"), join(dir, "agent-l1.meta.json"));
    symlinkSync(join(outside, "agent-l1.jsonl"), join(dir, "agent-l1.jsonl"));
    expect(backgroundAgentDetail(s.path, "l1")).toEqual({ refusal: "not_found" });
    symlinkSync(join(dir, "agent-a1.meta.json"), join(dir, "agent-l2.meta.json"));
    symlinkSync(join(dir, "agent-a1.jsonl"), join(dir, "agent-l2.jsonl"));
    expect(backgroundAgentDetail(s.path, "l2")).toEqual({ refusal: "not_found" });
    expect(backgroundAgentDetail(s.path, "gone")).toEqual({ refusal: "not_found" });
    // a transcript that is there but cannot be opened is a store not readable now, never an agent gone (root opens anything)
    if (process.getuid?.() !== 0) {
      chmodSync(join(dir, "agent-a1.jsonl"), 0o000);
      try { expect(backgroundAgentDetail(s.path, "a1")).toEqual({ refusal: "unavailable" }); } finally { chmodSync(join(dir, "agent-a1.jsonl"), 0o644); }
    }
    // another session's valid id is not this session's
    const other = session();
    other.agent("b1", { description: "theirs" });
    expect(backgroundAgentDetail(s.path, "b1")).toEqual({ refusal: "not_found" });
    expect(detailOf(other.path, "b1").title).toBe("theirs");
    // a subagents folder that is a link leads out of the store: nothing of it is read, not even the file it points at
    const linkedSession = join(s.path, "..", "22222222-2222-4222-8222-222222222222");
    const linkedParent = `${linkedSession}.jsonl`;
    writeFileSync(linkedParent, json({ type: "user", message: { content: "go" } }));
    mkdirSync(linkedSession);
    symlinkSync(join(other.path, "..", SESSION, "subagents"), join(linkedSession, "subagents"));
    expect(backgroundAgentDetail(linkedParent, "b1")).toEqual({ refusal: "unavailable" });
    // a parent transcript that is a link is not read through
    const linkedTranscript = join(s.path, "..", "33333333-3333-4333-8333-333333333333.jsonl");
    symlinkSync(s.path, linkedTranscript);
    expect(backgroundAgentDetail(linkedTranscript, "a1")).toEqual({ refusal: "unavailable" });
    // a session with no subagents folder has no agent to read
    expect(backgroundAgentDetail(join(s.path, "..", "none.jsonl"), "a1")).toEqual({ refusal: "unavailable" });
    writeFileSync(join(s.path, "..", "none.jsonl"), "");
    expect(backgroundAgentDetail(join(s.path, "..", "none.jsonl"), "a1")).toEqual({ refusal: "not_found" });
  });

  it("counts and titles nothing through a subagents or session folder that is a link to another session's (#3348)", () => {
    const s = session();
    s.agent("a1");
    expect(claudeSubagentState(s.path, true, NOW).running).toBe(1);
    const project = join(s.path, "..");
    const linked = (id: string, link: string, target: string): string => {
      writeFileSync(join(project, `${id}.jsonl`), json({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
      symlinkSync(target, link);
      return join(project, `${id}.jsonl`);
    };
    mkdirSync(join(project, "22222222-2222-4222-8222-222222222222"));
    const viaSubagents = linked("22222222-2222-4222-8222-222222222222", join(project, "22222222-2222-4222-8222-222222222222", "subagents"), join(project, SESSION, "subagents"));
    const viaSession = linked("33333333-3333-4333-8333-333333333333", join(project, "33333333-3333-4333-8333-333333333333"), join(project, SESSION));
    for (const parent of [viaSubagents, viaSession]) {
      expect([parent, claudeSubagentState(parent, true, NOW)]).toMatchObject([parent, { tasks: [], running: 0 }]);
      expect([parent, [...subagentDetails(parent, ["a1"])]]).toEqual([parent, []]);
    }
  });

  it.skipIf(process.platform === "win32")("lists and titles nothing of a folder swapped for a link to another session's while it is opened (#3348)", () => {
    const s = session();
    const project = join(s.path, "..");
    const sessionDir = join(project, SESSION);
    const subagents = join(sessionDir, "subagents");
    s.agent("a1", { description: "inside" });
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-swap-"));
    roots.push(outside);
    const outsideSession = join(outside, SESSION);
    mkdirSync(join(outsideSession, "subagents"), { recursive: true });
    for (const id of ["a1", "o1"]) {
      writeFileSync(join(outsideSession, "subagents", `agent-${id}.meta.json`), JSON.stringify({ agentType: "x", description: "outside title", toolUseId: `toolu_${id}` }));
      writeFileSync(join(outsideSession, "subagents", `agent-${id}.jsonl`), json({ isSidechain: true, sessionId: SESSION, agentId: id, type: "user", timestamp: at(1), message: { role: "user", content: "outside" } }));
    }
    const restore = (): void => {
      for (const folder of [subagents, sessionDir]) {
        try { if (lstatSync(folder).isSymbolicLink()) { rmSync(folder); renameSync(`${folder}.moved`, folder); } } catch { /* not swapped */ }
      }
    };
    const swap = (folder: string, target: string) => (): void => { renameSync(folder, `${folder}.moved`); symlinkSync(target, folder); };
    // before the folder's open (where the kernel names a descriptor's file, Linux; elsewhere the folder is not opened, and
    // the first call after the look is its listing or a title's open), or once it is open and checked: before its listing,
    // or before a title's file is opened
    const cases: Array<[string, "open" | "read", () => void]> = [
      ["the subagents folder, before its open", "open", swap(subagents, join(outsideSession, "subagents"))],
      ["the session folder, before its open", "open", swap(sessionDir, outsideSession)],
      ["the subagents folder, after its open", "read", swap(subagents, join(outsideSession, "subagents"))],
      ["the session folder, after its open", "read", swap(sessionDir, outsideSession)],
    ];
    const { openSync } = detailIo;
    const opendir = fs.opendirSync;
    for (const read of ["list", "titles"] as const) {
      for (const [label, at, act] of cases) {
        forgetSubagents();
        let swapped = false;
        const once = (): void => { if (!swapped) { swapped = true; act(); } };
        detailIo.openSync = ((path: string, flags: number) => {
          if (at === "open" || (read === "titles" && path.endsWith("agent-a1.meta.json"))) once();
          return openSync(path, flags);
        }) as typeof openSync;
        const listing = spyOn(fs, "opendirSync").mockImplementation((path, options) => { once(); return opendir(path, options); });
        let answer: string;
        try {
          answer = read === "list"
            ? JSON.stringify(claudeSubagentState(s.path, true, NOW).tasks.map((task) => `${task.id}:${task.title}`))
            : JSON.stringify([...subagentDetails(s.path, ["a1", "o1"])]);
        } finally { detailIo.openSync = openSync; listing.mockRestore(); restore(); }
        expect([read, label, swapped]).toEqual([read, label, true]);
        expect([read, label, answer]).not.toEqual([read, label, expect.stringContaining("outside")]);
        expect([read, label, answer.includes("o1")]).toEqual([read, label, false]);
      }
    }
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW).tasks.map((task) => task.title)).toEqual(["inside"]);
  });

  it.skipIf(process.platform === "win32")("counts nothing of a session folder moved and replaced with a link to it once its listing is kept (#3348)", () => {
    const s = session();
    const sessionDir = join(s.path, "..", SESSION);
    s.agent("a1");
    // read a while after the folder was written: its listing is kept
    setSystemTime(new Date(Date.now() + 5000));
    try {
      expect(claudeSubagentState(s.path, true, NOW).running).toBe(1);
      renameSync(sessionDir, `${sessionDir}.moved`);
      symlinkSync(`${sessionDir}.moved`, sessionDir);
      expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ tasks: [], running: 0 });
    } finally { setSystemTime(); }
  });

  it.skipIf(process.platform === "win32")("reads no meta file swapped for a FIFO before its open, and does not wait on it", () => {
    const s = session();
    const meta = join(s.path, "..", SESSION, "subagents", "agent-a1.meta.json");
    const { openSync } = detailIo;
    for (const read of ["titles", "list"] as const) {
      forgetSubagents();
      s.agent("a1");
      let swapped = false;
      detailIo.openSync = ((path: string, flags: number) => {
        if (!swapped && path.endsWith("agent-a1.meta.json")) {
          swapped = true;
          rmSync(meta);
          expect(Bun.spawnSync(["mkfifo", meta]).exitCode).toBe(0);
        }
        return openSync(path, flags);
      }) as typeof openSync;
      let answer: unknown[];
      try {
        answer = read === "list" ? claudeSubagentState(s.path, true, NOW).tasks.map((task) => task.id) : [...subagentDetails(s.path, ["a1"])];
      } finally { detailIo.openSync = openSync; rmSync(meta, { force: true }); }
      expect([read, swapped, answer]).toEqual([read, true, []]);
    }
  });

  /**
   * `before` runs once, just before the `nth` open of a file named `name`, and `after` just after it: whichever way the
   * read opens it, through `detailIo` or straight through `fs`.
   */
  function onOpen(name: string, nth: number, before: () => void, after: () => void = () => undefined): { acted: () => boolean; restore: () => void } {
    const { openSync } = detailIo;
    let seen = 0;
    let acted = false;
    const hooked = ((path: string, flags: number, mode?: number) => {
      if (acted || !String(path).endsWith(`/${name}`) || ++seen !== nth) return openSync(path, flags, mode);
      acted = true;
      before();
      try { return openSync(path, flags, mode); } finally { after(); }
    }) as typeof openSync;
    detailIo.openSync = hooked;
    const spy = spyOn(fs, "openSync").mockImplementation(hooked);
    return { acted: () => acted, restore: () => { detailIo.openSync = openSync; spy.mockRestore(); } };
  }

  it.skipIf(process.platform === "win32")("reads no transcript swapped for a FIFO before its open, and does not wait on it (#3363)", () => {
    const s = session();
    const file = s.agent("a1");
    // in a process of its own, with a deadline: a read that waits on the FIFO never returns, and would hold this one
    const script = `
      const fs = require("node:fs");
      const open = fs.openSync;
      let swapped = false;
      const hooked = (path, ...rest) => {
        if (!swapped && String(path).endsWith("/agent-a1.jsonl")) { swapped = true; fs.rmSync(process.env.SCAN_FILE); Bun.spawnSync(["mkfifo", process.env.SCAN_FILE]); }
        return open(path, ...rest);
      };
      fs.openSync = hooked;
      const { claudeSubagentState, detailIo } = await import(process.env.SCAN_MODULE);
      detailIo.openSync = hooked;
      const { tasks } = claudeSubagentState(process.env.SCAN_PARENT, true, Number(process.env.SCAN_NOW));
      console.log(JSON.stringify({ swapped, tasks }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, SCAN_MODULE: join(import.meta.dir, "claude-subagents.ts"), SCAN_PARENT: s.path, SCAN_FILE: file, SCAN_NOW: String(NOW) },
      timeout: 4_000,
    });
    expect([child.exitCode, child.stdout.toString().trim()]).toEqual([0, JSON.stringify({ swapped: true, tasks: [] })]);
  });

  it.skipIf(process.platform === "win32")("reads no transcript replaced before its open: a link, even to itself, or another file (#3363)", () => {
    const s = session();
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-link-"));
    roots.push(outside);
    const elsewhere = join(outside, "agent-a1.jsonl");
    // what the outside transcript would say: it ended its turn at minute 30
    const ended = own({ type: "assistant", timestamp: at(30), message: { id: "m30", model: "outside-model", stop_reason: "end_turn", content: [] } });
    writeFileSync(elsewhere, ended);
    const cases: Array<[string, 1 | 2, (file: string) => void]> = [
      ["a link to another file", 1, (file) => { rmSync(file); symlinkSync(elsewhere, file); }],
      // the same file, so only the refusal to follow a link stops it
      ["a link to the file itself, moved aside", 1, (file) => { renameSync(file, `${file}.aside`); symlinkSync(`${file}.aside`, file); }],
      // no link, so only the file's identity stops it
      ["another plain file", 1, (file) => { writeFileSync(`${file}.new`, ended); renameSync(`${file}.new`, file); }],
      ["a link to another file, before the tail's read", 2, (file) => { rmSync(file); symlinkSync(elsewhere, file); }],
    ];
    for (const [label, nth, act] of cases) {
      forgetSubagents();
      const file = join(s.path, "..", SESSION, "subagents", "agent-a1.jsonl");
      rmSync(file, { force: true });
      rmSync(`${file}.aside`, { force: true });
      s.agent("a1");
      const hook = onOpen("agent-a1.jsonl", nth, () => act(file));
      let tasks: OmoTask[];
      try { tasks = claudeSubagentState(s.path, true, NOW).tasks; } finally { hook.restore(); }
      const said = JSON.stringify(tasks);
      // replaced before the whole read, nothing is told of it; before the tail's, only what the whole read found
      expect([label, hook.acted(), said.includes(at(30)), nth === 1 ? tasks : tasks.map((task) => task.status)]).toEqual([label, true, false, nth === 1 ? [] : ["running"]]);
    }
  });

  it.skipIf(process.platform === "win32")("reads nothing of a folder swapped for a link to another session's after its listing (#3363)", () => {
    const s = session();
    const sessionDir = join(s.path, "..", SESSION);
    const subagents = join(sessionDir, "subagents");
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-after-"));
    roots.push(outside);
    const outsideSession = join(outside, SESSION);
    mkdirSync(join(outsideSession, "subagents"), { recursive: true });
    writeFileSync(join(outsideSession, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "x", description: "outside title", toolUseId: "toolu_a1" }));
    writeFileSync(join(outsideSession, "subagents", "agent-a1.jsonl"), own({ type: "assistant", timestamp: at(30), message: { id: "m30", model: "outside-model", stop_reason: "end_turn", content: [] } }));
    const swap = (folder: string, target: string) => (): void => { renameSync(folder, `${folder}.moved`); symlinkSync(target, folder); };
    const back = (folder: string) => (): void => { if (lstatSync(folder).isSymbolicLink()) { rmSync(folder); renameSync(`${folder}.moved`, folder); } };
    const restore = (): void => { for (const folder of [subagents, sessionDir]) { try { back(folder)(); } catch { /* not swapped */ } } };
    const folders: Array<[string, string, string]> = [["the subagents folder", subagents, join(outsideSession, "subagents")], ["the session folder", sessionDir, outsideSession]];
    s.agent("a1", { description: "inside" });
    for (const [what, folder, target] of folders) {
      // after the listing, before the transcript is looked at; and before it is opened
      type Hook = { acted: () => boolean; restore: () => void };
      // swapped at the transcript's first look, the one after the listing
      const atLook = (): Hook => {
        const { lstatSync: look } = fs;
        let acted = false;
        const spy = spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: object) => {
          if (!acted && String(path).endsWith("/agent-a1.jsonl")) { acted = true; swap(folder, target)(); }
          return look(path, options);
        }) as typeof look);
        return { acted: () => acted, restore: () => spy.mockRestore() };
      };
      const cases: Array<[string, () => Hook]> = [
        [`${what}, before the transcript's look`, atLook],
        [`${what}, before the transcript's open`, () => onOpen("agent-a1.jsonl", 1, swap(folder, target))],
        // and swapped back once it is open: no look after the read can tell, so only a folder held open can
        ...(process.platform === "linux" ? [[`${what}, from the transcript's look until its open`, (): Hook => {
          const looked = atLook();
          const opened = onOpen("agent-a1.jsonl", 1, () => undefined, back(folder));
          return { acted: () => looked.acted() && opened.acted(), restore: () => { looked.restore(); opened.restore(); } };
        }] as [string, () => Hook]] : []),
      ];
      for (const [label, hook] of cases) {
        forgetSubagents();
        const hooked = hook();
        let said: string;
        try { said = JSON.stringify(claudeSubagentState(s.path, true, NOW).tasks); } finally { hooked.restore(); restore(); }
        expect([label, hooked.acted(), said.includes("outside"), said.includes(at(30))]).toEqual([label, true, false, false]);
      }
    }
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW).tasks.map((task) => task.title)).toEqual(["inside"]);
  });

  it("reads no file whose identity is the one looked at only once rounded to a number (#3363)", () => {
    const s = session();
    const file = s.agent("a1");
    const { lstatSync: look, fstatSync: opened } = fs;
    // an NTFS file ID can pass 2^53: looked at as 2^53 + 1 and opened as 2^53, two files read as one number
    const big = 2n ** 53n;
    const as = <T extends object>(stat: T, ino: bigint): T => Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as T, stat, { ino: typeof (stat as { ino: unknown }).ino === "bigint" ? ino : Number(ino) });
    // the file opened as 2^53; replaced only after the first look, every later look sees it too
    for (const replaced of [false, true]) {
      let looked = big + 1n;
      const looks = spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: object) => { const stat = look(path, options); return path === file && stat ? as(stat, looked) : stat; }) as typeof look);
      const opens = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: object) => as(opened(fd, options), big)) as typeof opened);
      let read: ReturnType<typeof readLines>;
      try {
        const seen = plain(file)!;
        if (replaced) looked = big;
        read = readLines(file, 0, seen, seen.size, () => undefined, false);
      } finally { looks.mockRestore(); opens.mockRestore(); }
      expect([replaced, read]).toEqual([replaced, { offset: 0, skipping: false, more: true, failed: true }]);
    }
  });

  it.skipIf(process.platform === "win32")("lists afresh after a folder swapped while it was read by its path, and skips none of its agents as old (#3363)", () => {
    const s = session();
    const subagents = join(s.path, "..", SESSION, "subagents");
    s.agent("a1", { description: "inside" });
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-stale-"));
    roots.push(outside);
    mkdirSync(join(outside, "subagents"));
    writeFileSync(join(outside, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "x", description: "outside title", toolUseId: "toolu_a1" }));
    const old = join(outside, "subagents", "agent-a1.jsonl");
    writeFileSync(old, own({ type: "user", timestamp: at(1), message: { role: "user", content: "outside" } }));
    // last written two days before the read: an agent the read would skip as old for a while
    utimesSync(old, (NOW - 48 * 60 * 60 * 1000) / 1000, (NOW - 48 * 60 * 60 * 1000) / 1000);
    // in a process of its own where no descriptor names its file, as off Linux: the files are read by their path, and
    // the subagents folder is swapped for a link to the outside one at the first look at a transcript, then put back
    const script = `
      const fs = require("node:fs");
      const look = fs.lstatSync;
      const folder = process.env.SCAN_FOLDER;
      let swapped = false;
      fs.lstatSync = (path, ...rest) => {
        if (path === "/proc/self/fd") throw Object.assign(new Error("no such folder"), { code: "ENOENT" });
        if (!swapped && String(path).endsWith("/agent-a1.jsonl")) { swapped = true; fs.renameSync(folder, folder + ".moved"); fs.symlinkSync(process.env.SCAN_OUTSIDE, folder); }
        return look(path, ...rest);
      };
      const { claudeSubagentState } = await import(process.env.SCAN_MODULE);
      const now = Number(process.env.SCAN_NOW);
      const first = claudeSubagentState(process.env.SCAN_PARENT, true, now).tasks.map((task) => task.title);
      fs.rmSync(folder);
      fs.renameSync(folder + ".moved", folder);
      const next = claudeSubagentState(process.env.SCAN_PARENT, true, now).tasks.map((task) => task.title);
      console.log(JSON.stringify({ swapped, first, next }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, SCAN_MODULE: join(import.meta.dir, "claude-subagents.ts"), SCAN_PARENT: s.path, SCAN_FOLDER: subagents, SCAN_OUTSIDE: join(outside, "subagents"), SCAN_NOW: String(NOW) },
      timeout: 4_000,
    });
    expect([child.exitCode, child.stdout.toString().trim() || child.stderr.toString()]).toEqual([0, JSON.stringify({ swapped: true, first: [], next: ["inside"] })]);
  });

  it("an unreadable dispatch is no prompt, and no later instruction is taken for it", () => {
    const s = session();
    const file = s.agent("a1", { steps: [] });
    const later = own({ type: "user", timestamp: at(3), message: { role: "user", content: "a later instruction" } });
    for (const first of [own({ type: "user", timestamp: at(1), message: { role: "user", content: "x".repeat(70_000) } }), "{ torn dispatch\n", "[1]\n"]) {
      writeFileSync(file, first + assistant(2, [{ type: "text", text: "working" }]) + later);
      expect([first.slice(0, 16), detailOf(s.path, "a1")]).toMatchObject([first.slice(0, 16), { prompt: null, events: [{ kind: "text", text: "working" }], incomplete: true }]);
    }
    // a meta entry before the dispatch is none, and leaves it to come
    writeFileSync(file, own({ type: "user", isMeta: true, timestamp: at(0), message: { role: "user", content: "caveat" } }) + own({ type: "user", timestamp: at(1), message: { role: "user", content: "the dispatch" } }) + later);
    expect(detailOf(s.path, "a1")).toMatchObject({ prompt: "the dispatch", incomplete: false });
    // a head window that holds no whole record has no prompt either; the tail's instruction is not it
    writeFileSync(file, own({ type: "user", timestamp: at(1), message: { role: "user", content: "y".repeat(300_000) } }) + later);
    expect(detailOf(s.path, "a1")).toMatchObject({ prompt: null, events: [], incomplete: true, truncated: true });
  });

  it("answers only a file that is this session's agent's own", () => {
    const s = session();
    const file = s.agent("a1", { steps: [] });
    const dispatch = { type: "user", timestamp: at(1), message: { role: "user", content: "secret dispatch" } };
    const cases: Array<[string, string]> = [
      ["another session", json({ isSidechain: true, sessionId: "22222222-2222-4222-8222-222222222222", agentId: "a1", ...dispatch })],
      ["another agent", json({ isSidechain: true, sessionId: SESSION, agentId: "b9", ...dispatch })],
      ["the main thread", json({ isSidechain: false, sessionId: SESSION, agentId: "a1", ...dispatch })],
      ["no identity", json(dispatch)],
      // one foreign record among the agent's own taints the whole file
      ["a foreign record after its own", own(dispatch) + json({ isSidechain: true, sessionId: SESSION, agentId: "b9", type: "attachment", timestamp: at(3) })],
    ];
    for (const [label, records] of cases) {
      writeFileSync(file, records + assistant(2, [{ type: "text", text: "secret prose" }]));
      expect([label, backgroundAgentDetail(s.path, "a1")]).toEqual([label, { refusal: "not_found" }]);
    }
    writeFileSync(file, own(dispatch));
    expect(detailOf(s.path, "a1").prompt).toBe("secret dispatch");
    // a meta file that names no agent type is no subagent's
    writeFileSync(join(s.path, "..", SESSION, "subagents", "agent-a1.meta.json"), JSON.stringify({ description: "no type", toolUseId: "toolu_a1" }));
    expect(backgroundAgentDetail(s.path, "a1")).toEqual({ refusal: "not_found" });
    // a background command the session started is a command, whatever files bear its id
    s.bash("b1", 4, { description: "Run the suite" });
    s.agent("b1", { steps: [] });
    expect([backgroundCommand(s.path, "b1"), backgroundCommand(s.path, "a1")]).toEqual([true, false]);
  });

  it.skipIf(process.platform === "win32")("refuses a folder swapped for a link between the look and the open", () => {
    const s = session();
    const project = join(s.path, "..");
    const sessionDir = join(project, SESSION);
    const subagents = join(sessionDir, "subagents");
    const file = s.agent("a1", { description: "inside", steps: [] });
    writeFileSync(file, own({ type: "user", timestamp: at(1), message: { role: "user", content: "inside dispatch" } }));
    // elsewhere, a session folder of the same names whose records claim this session and agent
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-swap-"));
    roots.push(outside);
    const outsideSession = join(outside, SESSION);
    mkdirSync(join(outsideSession, "subagents"), { recursive: true });
    writeFileSync(join(outsideSession, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "x", description: "outside title" }));
    writeFileSync(join(outsideSession, "subagents", "agent-a1.jsonl"), own({ type: "user", timestamp: at(1), message: { role: "user", content: "outside secret" } }));
    const restore = (): void => {
      for (const folder of [subagents, sessionDir]) {
        try { if (lstatSync(folder).isSymbolicLink()) { rmSync(folder); renameSync(`${folder}.moved`, folder); } } catch { /* not swapped */ }
      }
    };
    const swap = (folder: string, target: string) => (): void => { renameSync(folder, `${folder}.moved`); symlinkSync(target, folder); };
    const swaps: Array<[string, (path: string, index: number) => boolean, () => void]> = [
      ["the subagents folder, before the first open", (_path, index) => index === 0, swap(subagents, join(outsideSession, "subagents"))],
      ["the session folder, before the first open", (_path, index) => index === 0, swap(sessionDir, outsideSession)],
      ["the subagents folder, before the transcript's open", (path) => path.endsWith("agent-a1.jsonl"), swap(subagents, join(outsideSession, "subagents"))],
      ["the session folder, before the transcript's open", (path) => path.endsWith("agent-a1.jsonl"), swap(sessionDir, outsideSession)],
    ];
    expect(detailOf(s.path, "a1").prompt).toBe("inside dispatch");
    const { openSync } = detailIo;
    for (const [label, when, act] of swaps) {
      let opens = 0;
      let swapped = false;
      detailIo.openSync = ((path: string, flags: number) => {
        if (!swapped && when(path, opens++)) { swapped = true; act(); }
        return openSync(path, flags);
      }) as typeof openSync;
      let read: ReturnType<typeof backgroundAgentDetail>;
      try { read = backgroundAgentDetail(s.path, "a1"); } finally { detailIo.openSync = openSync; restore(); }
      expect([label, swapped, "refusal" in read]).toEqual([label, true, true]);
      expect(JSON.stringify(read)).not.toContain("outside");
    }
    expect(detailOf(s.path, "a1").prompt).toBe("inside dispatch");
  });

  it.skipIf(process.platform === "win32")("refuses a file moved or replaced while it is read, and a read that fails, as unavailable", () => {
    const s = session();
    const subagents = join(s.path, "..", SESSION, "subagents");
    const file = s.agent("a1", { description: "inside", steps: [] });
    const meta = join(subagents, "agent-a1.meta.json");
    writeFileSync(file, own({ type: "user", timestamp: at(1), message: { role: "user", content: "inside dispatch" } }));
    const outside = mkdtempSync(join(tmpdir(), "herdr-subagents-moved-"));
    roots.push(outside);
    const { openSync, readSync } = detailIo;
    /** the detail, with `act` run once at the first read of the file whose name ends in `name` */
    const during = (name: string, act: () => void) => {
      const opened = new Map<number, string>();
      let acted: boolean = false;
      detailIo.openSync = ((path: string, flags: number) => { const fd = openSync(path, flags); opened.set(fd, path); return fd; }) as typeof openSync;
      detailIo.readSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        if (!acted && opened.get(fd)?.endsWith(name)) { acted = true; act(); }
        return readSync(fd, buffer, offset, length, position);
      }) as typeof readSync;
      try { const read = backgroundAgentDetail(s.path, "a1"); return [acted, read]; } finally { Object.assign(detailIo, { openSync, readSync }); }
    };
    const replaced = (path: string, words: string) => (): void => { renameSync(path, join(outside, `${basename(path)}.${words}`)); writeFileSync(path, own({ type: "user", timestamp: at(1), message: { role: "user", content: words } })); };
    const restore = (path: string, words: string): void => { renameSync(join(outside, `${basename(path)}.${words}`), path); };
    // the transcript moved out of the session while it is read, and another file put at its path
    expect(during("agent-a1.jsonl", replaced(file, "moved"))).toEqual([true, { refusal: "unavailable" }]);
    restore(file, "moved");
    // the meta file likewise
    expect(during("agent-a1.meta.json", () => { renameSync(meta, join(outside, "agent-a1.meta.json.moved")); writeFileSync(meta, JSON.stringify({ agentType: "x" })); })).toEqual([true, { refusal: "unavailable" }]);
    restore(meta, "moved");
    // a read the disk fails is a store not readable now, never an agent gone
    expect(during("agent-a1.meta.json", () => { throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }); })).toEqual([true, { refusal: "unavailable" }]);
    expect(during("agent-a1.jsonl", () => { throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }); })).toEqual([true, { refusal: "unavailable" }]);
    // a session folder that cannot be looked into, nor its subagents folder opened (root looks into anything)
    if (process.getuid?.() !== 0) {
      for (const folder of [join(subagents, ".."), subagents]) {
        chmodSync(folder, 0o000);
        try { expect(backgroundAgentDetail(s.path, "a1")).toEqual({ refusal: "unavailable" }); } finally { chmodSync(folder, 0o755); }
      }
    }
    // a file linked in that claims this session and agent is still no file of this agent's
    const claimed = join(outside, "claimed.jsonl");
    writeFileSync(claimed, own({ type: "user", timestamp: at(1), message: { role: "user", content: "linked secret" } }));
    renameSync(file, `${file}.real`);
    symlinkSync(claimed, file);
    try { expect(backgroundAgentDetail(s.path, "a1")).toEqual({ refusal: "not_found" }); } finally { rmSync(file); renameSync(`${file}.real`, file); }
    expect(detailOf(s.path, "a1").prompt).toBe("inside dispatch");
  });

  it("metadata-only details stay unchanged", () => {
    const s = session();
    s.agent("a1", { description: "Review the parser", type: "reviewer", steps: [[1, 10], [2, 30]] });
    const before = [...subagentDetails(s.path, ["a1"])];
    expect(before).toEqual([["a1", { title: "Review the parser", agent: "reviewer" }]]);
    const detail = detailOf(s.path, "a1");
    expect(detail.events.length).toBeGreaterThan(0);
    // the chat's card and the list keep what they had: no prompt, no event, no argument
    expect([...subagentDetails(s.path, ["a1"])]).toEqual(before);
    expect(Object.keys(claudeSubagents(s.path, true, NOW)[0]!).sort()).toEqual(["category", "detail_kind", "ended_at", "id", "model", "started_at", "status", "title", "tokens", "tool_calls", "turns"]);
  });
});

describe("taskNotification", () => {
  it("does not report a truncated envelope as completed", () => {
    expect(taskNotification('<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "review" finished</summary>')).toBeNull();
  });

  it("reads a block, its result to the last closing tag", () => {
    expect(taskNotification('<task-notification>\n<task-id>a</task-id>\n<status>stopped</status>\n<summary>Agent "x" was stopped by Claude</summary>\n<result>see </result> here</result>\n</task-notification>')).toEqual({
      taskId: "a", toolUseId: null, status: "cancelled", summary: 'Agent "x" was stopped by Claude', result: "see </result> here", agent: true,
    });
    expect(taskNotification("hello")).toBeNull();
  });
});

describe("ClaudeSubagentStatus", () => {
  const pane = (id: string, agent: string | null, session = "s1"): HerdrPane => ({ pane_id: id, agent, agent_session: { agent: agent ?? "", kind: "id", source: "hook", value: session }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 }) as HerdrPane;

  it("keeps task-list reads bound to a pane lifetime across process replacement and close/reopen", async () => {
    const s = session();
    let pid = 1;
    let now = NOW;
    const status = new ClaudeSubagentStatus({
      resolve: async () => ({ path: s.path, startedAt: null, pid }), pid: async () => pid,
      onChange: () => undefined, now: () => now, refreshMs: 1000,
    });
    await status.refresh([pane("p1", "claude")]);
    const first = status.sessionOf("p1")!.read;
    expect(typeof first).toBe("number");
    now += 1000;
    await status.refresh([pane("p1", "claude")]);
    expect(status.sessionOf("p1")!.read).toBe(first);
    // A new process can resume the same transcript with no known start time.
    pid++;
    now += 1000;
    await status.refresh([pane("p1", "claude")]);
    const replaced = status.sessionOf("p1")!.read;
    expect(replaced).not.toBe(first);
    await status.refresh([]);
    await status.refresh([pane("p1", "claude")]);
    expect(status.sessionOf("p1")!.read).not.toBe(replaced);
    const reopened = status.sessionOf("p1")!.read;
    await status.refresh([pane("p1", "claude", "s2")]);
    expect(status.sessionOf("p1")!.read).not.toBe(reopened);
  });

  it("adopts a delayed transcript without losing the observed rest or renewing its deadline", async () => {
    for (const order of ["early", "late", "baseline", "expired"] as const) {
      const s = session();
      s.prompt(1);
      s.bash("suite", 2);
      let now = NOW;
      const waits = new BackgroundWait(() => now);
      let resolve!: (value: { path: string; startedAt: null }) => void;
      const pending = new Promise<{ path: string; startedAt: null }>((done) => { resolve = done; });
      const status = new ClaudeSubagentStatus({ resolve: () => pending, now: () => now,
        onReset: (id) => waits.reset(id), onChange: (id, _, running, prompt) => { waits.running(id, running, prompt); } });
      waits.status("p1", order === "baseline" ? "done" : "working");
      const refresh = status.refresh([pane("p1", "claude")]);
      if (order === "early") { resolve({ path: s.path, startedAt: null }); await refresh; }
      status.poll("p1");
      waits.status("p1", "done");
      now += order === "expired" ? WAIT_LIMIT_MS : WAIT_LIMIT_MS - 1;
      if (order !== "early") { resolve({ path: s.path, startedAt: null }); await refresh; }
      waits.tick();
      expect(status.countOf("p1")).toBe(1);
      expect(waits.waiting("p1")).toBe(order === "early" || order === "late");
      now++;
      waits.tick();
      expect(waits.waiting("p1")).toBe(false);
      status.stop();
    }
  });

  it("forgets old transition evidence when a session changes during discovery, but keeps the new session's observations", async () => {
    const s = session();
    s.prompt(1);
    s.bash("suite", 2);
    const waits = new BackgroundWait(() => NOW);
    let resolve!: (value: { path: string; startedAt: null }) => void;
    const pending = new Promise<{ path: string; startedAt: null }>((done) => { resolve = done; });
    const status = new ClaudeSubagentStatus({ resolve: () => pending, now: () => NOW,
      onReset: (id) => waits.reset(id), onChange: (id, _, running, prompt) => { waits.running(id, running, prompt); } });
    const first = status.refresh([pane("p1", "claude", "s1")]);
    waits.status("p1", "working");
    waits.status("p1", "done");
    const next = status.refresh([pane("p1", "claude", "s2")]);
    resolve({ path: s.path, startedAt: null });
    await Promise.all([first, next]);
    expect(status.countOf("p1")).toBe(1);
    expect(waits.waiting("p1")).toBe(false);
    waits.status("p1", "working");
    waits.status("p1", "done");
    expect(waits.waiting("p1")).toBe(true);
    await status.refresh([pane("p1", "claude", "s3")]);
    expect(status.countOf("p1")).toBe(1);
    expect(waits.waiting("p1")).toBe(false);
  });

  it("retains the latest pane status, but no old hold, across asynchronous process replacement", async () => {
    for (const latest of ["working", "done"] as const) {
      const s = session();
      s.prompt(1);
      s.bash("suite", 2);
      let now = NOW;
      let pid = 1;
      const waits = new BackgroundWait(() => now);
      const replacement = Promise.withResolvers<{ path: string; startedAt: number; pid: number }>();
      const status = new ClaudeSubagentStatus({
        resolve: () => pid === 1 ? Promise.resolve({ path: s.path, startedAt: Date.parse(at(0)), pid }) : replacement.promise,
        pid: async () => pid, now: () => now, refreshMs: 1000,
        onReset: (id) => waits.reset(id),
        onChange: (id, _, running, prompt) => { waits.running(id, running, prompt); },
      });
      await status.refresh([pane("p1", "claude")]);
      waits.status("p1", "working");
      waits.status("p1", "done");
      expect(waits.waiting("p1")).toBe(true);
      now += 1000;
      pid = 2;
      const refreshing = status.refresh([pane("p1", "claude")]);
      waits.status("p1", latest);
      replacement.resolve({ path: s.path, startedAt: Date.parse(at(0)) + 1, pid });
      await refreshing;
      expect(status.countOf("p1")).toBe(1);
      expect(waits.waiting("p1")).toBe(false);
      waits.seed("p1", latest === "working" ? "done" : "working");
      now += 1000;
      waits.status("p1", "done");
      expect(waits.waiting("p1")).toBe(latest === "working");
      now += WAIT_LIMIT_MS - 1;
      waits.tick();
      expect(waits.waiting("p1")).toBe(latest === "working");
      now++;
      waits.tick();
      expect(waits.waiting("p1")).toBe(false);
    }
  });

  it("rereads a same-size replaced parent and a replaced subagent directory", async () => {
    const s = session();
    const old = new Date(Date.now() - 5000);
    const now = Date.now() + 5000;
    const launch = (id: string) => json({ type: "user", timestamp: at(1), toolUseResult: { backgroundTaskId: id }, message: { content: [] } });
    writeFileSync(s.path, launch("one"));
    utimesSync(s.path, old, old);
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => now });
    await status.refresh([pane("p1", "claude")]);
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    writeFileSync(`${s.path}.new`, launch("two"));
    utimesSync(`${s.path}.new`, old, old);
    renameSync(`${s.path}.new`, s.path);
    status.poll();
    s.notify("two", 3, { summary: "Background command ended" });
    status.poll();
    expect(status.countOf("p1")).toBe(0);
    const dir = join(s.path.replace(/\.jsonl$/, ""), "subagents");
    s.agent("a1");
    utimesSync(dir, old, old);
    status.poll();
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    renameSync(dir, `${dir}.old`);
    mkdirSync(dir);
    s.agent("a2");
    s.agent("a3");
    utimesSync(join(dir, "agent-a2.meta.json"), old, old);
    utimesSync(dir, old, old);
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    s.parent({ type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", id: "toolu_a2", name: "Agent", input: {} }] } });
    s.parent({ type: "user", timestamp: at(4), message: { content: [{ type: "tool_result", tool_use_id: "toolu_a2", content: "done" }] } });
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    // Reuse the agent ID and metadata size/mtime, but not the completed call's identity.
    renameSync(dir, `${dir}.second`);
    mkdirSync(dir);
    s.agent("a2", { toolUseId: "toolu_b2" });
    s.agent("a3");
    utimesSync(join(dir, "agent-a2.meta.json"), old, old);
    utimesSync(dir, old, old);
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    rmSync(join(dir, "agent-a2.meta.json"));
    status.poll();
    expect(status.countOf("p1")).toBe(1);
  });

  it("expires unchanged agent files exactly after a day, while newer agents remain counted", async () => {
    const s = session();
    const old = Date.now() - 5000;
    for (const [id, stamp] of [["old", old], ["new", old + 2000]] as const) {
      const file = s.agent(id);
      utimesSync(file, new Date(stamp), new Date(stamp));
    }
    let now = old + 10000;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => now });
    await status.refresh([pane("p1", "claude")]);
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    now = old + 24 * 60 * 60 * 1000;
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    now++;
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    expect(claudeSubagents(s.path, true, now).map((task) => task.id)).toEqual(["new"]);
  });

  it("counts a Claude pane's running subagents and says only when the count changes", async () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    s.agent("a2", { steps: [[1, 1]] });
    const told: [string, number][] = [];
    const looked: string[] = [];
    const status = new ClaudeSubagentStatus({ resolve: async (p) => { looked.push(p.pane_id); return { path: s.path, startedAt: null }; }, onChange: (paneId, running) => told.push([paneId, running]), now: () => NOW });
    await status.refresh([pane("p1", "claude"), pane("p2", "codex"), pane("p3", null)]);
    expect(told).toEqual([["p1", 2]]);
    expect(status.countOf("p1")).toBe(2);
    // the same session is not looked up again, and an unchanged count is not told again
    await status.refresh([pane("p1", "claude"), pane("p2", "codex")]);
    status.poll();
    s.notify("a1", 3);
    status.poll();
    expect(looked).toEqual(["p1"]);
    expect(told).toEqual([["p1", 2], ["p1", 1]]);
    expect(status.countOf("p2")).toBe(0);
    expect(status.sessionOf("p2")).toBeNull();
  });

  it("reads a pane that stopped running Claude as having nothing running, and its subagents as lost", async () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    const told: [string, number][] = [];
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (paneId, running) => told.push([paneId, running]), now: () => NOW });
    await status.refresh([pane("p1", "claude")]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, live: true, startedAt: null, read: expect.any(Number) });
    await status.refresh([pane("p1", null)]);
    expect(told).toEqual([["p1", 1], ["p1", 0]]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, live: false, startedAt: null, read: expect.any(Number) });
    // gone with the pane
    await status.refresh([]);
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("looks again when the pane's session changes, and for a transcript that was not there yet", async () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    let calls = 0;
    let at = 0;
    const status = new ClaudeSubagentStatus({ resolve: async () => (++calls === 1 ? null : { path: s.path, startedAt: null }), onChange: () => undefined, now: () => at, refreshMs: 1000 });
    await status.refresh([pane("p1", "claude")]);
    expect([calls, status.sessionOf("p1")]).toEqual([1, null]);
    await status.refresh([pane("p1", "claude")]);
    expect(calls).toBe(1);
    at = 1000;
    await status.refresh([pane("p1", "claude")]);
    expect([calls, status.countOf("p1")]).toEqual([2, 1]);
    await status.refresh([pane("p1", "claude", "s2")]);
    expect([calls, status.countOf("p1")]).toEqual([3, 1]);
  });

  describe("a /loop wakeup's fire (#3494)", () => {
    type Session = ReturnType<typeof session>;
    const rest = (s: Session, minute: number) => s.parent({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: at(minute) });
    const fire = (s: Session, minute: number) => s.parent({ type: "system", subtype: "scheduled_task_fire", timestamp: at(minute), taskKind: "loop", taskId: "591b6f5a" });
    /** A fire dated by its own timestamp (`ms`, on the tracker's clock), or carrying none (null). */
    const firedAt = (s: Session, ms: number | null) => s.parent({ type: "system", subtype: "scheduled_task_fire", ...(ms === null ? {} : { timestamp: new Date(ms).toISOString() }), taskKind: "loop", taskId: "591b6f5a" });
    const answer = (s: Session, minute: number) => s.parent({ type: "assistant", timestamp: at(minute), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "checked" }] } });
    /**
     * The prompt of a turn Claude resumed by itself, with the keys Claude Code 2.1.318 writes on it right after
     * a /loop fire (read from a transcript of this PC). `loop` false: a scheduled task's that is no loop, which
     * Claude Code 2.1.321's own code gives the same keys with `schedule_wakeup` (no transcript of one was at hand).
     * `keys`: only that one of its two telling keys.
     */
    const resumes = (s: Session, minute: number, loop = true, written = at(minute), keys: "both" | "turnOrigin" | "wakeupSource" = "both") => s.parent({
      type: "user", isMeta: true, isSidechain: false, permissionMode: "auto", promptSource: "system", queuePriority: "later",
      ...(keys === "wakeupSource" ? {} : { turnOrigin: "scheduled" }), ...(keys === "turnOrigin" ? {} : { wakeupSource: loop ? "loop_wakeup" : "schedule_wakeup" }),
      scheduledTaskId: "591b6f5a", scheduledFireId: "0b6c1d7e", timestamp: written,
      message: { role: "user", content: "check the deploy" },
    });
    /** A tracker that has read a session at rest, and each word it gave of the queue's hold as it changed. */
    const tracked = async (s: Session, clock: () => number = () => NOW) => {
      const told: boolean[] = [];
      const status: ClaudeSubagentStatus = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => { told.push(status.loopHolds("p1")); }, now: clock });
      await status.refresh([pane("p1", "claude")]);
      return { status, told };
    };

    it("holds the queue from a fire written after the first read to the resumed turn's rest, whatever herdr reads the pane as", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status, told } = await tracked(s);
      try {
        expect(status.loopHolds("p1")).toBe(false);
        fire(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        // herdr reads the pane at rest until it reads the resumed turn: in every snapshot, and in an event of the turn before
        status.quiet("p1", false);
        status.quiet("p1", true);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        // what the turn writes is no rest
        answer(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        rest(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        // the hold was told as it came and as it went
        expect(told).toEqual([false, true, false]);
      } finally { status.stop(); }
    });

    it("takes a fire found written long before the first read for history, and holds on the next one", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      // written 57 minutes before the tracker's first read
      fire(s, 3);
      const { status } = await tracked(s);
      try {
        expect(status.loopHolds("p1")).toBe(false);
        // nothing read later makes that fire hold: its turn may have been interrupted long ago
        answer(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        rest(s, 5);
        fire(s, 6);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
      } finally { status.stop(); }
    });

    it("holds on a fire written a moment before the first read, for what is left of its time by its own timestamp", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      // a wakeup that fired 20 s before the server started, or before the pane's session was found
      firedAt(s, NOW - 20_000);
      let now = NOW;
      const { status, told } = await tracked(s, () => now);
      try {
        // nothing says its turn is over, and herdr may still read the pane at rest
        expect(status.loopHolds("p1")).toBe(true);
        expect(told).toEqual([true]);
        status.quiet("p1", true);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        // to the millisecond LOOP_HOLD_MS after the fire was written, not after it was found
        now = NOW - 20_000 + LOOP_HOLD_MS - 1;
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        now += 1;
        expect(status.loopHolds("p1")).toBe(false);
        status.poll();
        expect(told).toEqual([true, false]);
      } finally { status.stop(); }
    });

    it("ends the hold of a fire found at the first read at its turn's rest, not when herdr tells that turn", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      firedAt(s, NOW - 1000);
      const { status, told } = await tracked(s);
      try {
        expect(status.loopHolds("p1")).toBe(true);
        // herdr's working after a rest word of its own, heard in an event since the server started, and its rest word again
        status.quiet("p1", true);
        status.busy("p1", "herdr");
        status.quiet("p1", true);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        expect(told.at(-1)).toBe(true);
        rest(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        expect(told.at(-1)).toBe(false);
      } finally { status.stop(); }
    });

    it("holds on a fire found at the first read though herdr said the pane works since the server started", async () => {
      for (const heard of ["before the pane's transcript was found", "after its first read"] as const) {
        for (const end of ["rest", "time"] as const) {
          const s = session();
          s.prompt(1);
          rest(s, 2);
          firedAt(s, NOW - 1000);
          let found = heard === "after its first read";
          let now = NOW;
          const told: boolean[] = [];
          const status: ClaudeSubagentStatus = new ClaudeSubagentStatus({ resolve: async () => found ? { path: s.path, startedAt: null } : null, onChange: () => { told.push(status.loopHolds("p1")); }, now: () => now });
          await status.refresh([pane("p1", "claude")]);
          try {
            // herdr says the pane works: its word for the resumed turn, or a late one for the turn before the fire
            status.quiet("p1", false);
            status.busy("p1", "herdr");
            if (!found) {
              // heard while the pane's session was still looked for, and kept through the lookup
              found = true;
              now += 5000;
              await status.refresh([pane("p1", "claude")]);
              expect(status.sessionOf("p1")?.path).toBe(s.path);
            }
            // the fire holds for what is left of its time
            expect(status.loopHolds("p1")).toBe(true);
            expect(told.at(-1)).toBe(true);
            // herdr's rest word next lets nothing go, nor does its working after that
            status.quiet("p1", true);
            status.busy("p1", "herdr");
            status.poll();
            expect(status.loopHolds("p1")).toBe(true);
            // the turn's rest, or the fire's own time, ends the hold, and is told
            if (end === "rest") rest(s, 3); else now = NOW - 1000 + LOOP_HOLD_MS;
            status.poll();
            expect(status.loopHolds("p1")).toBe(false);
            expect(told.at(-1)).toBe(false);
          } finally { status.stop(); }
        }
      }
    });

    it("takes a fire found at the first read for history once it is as old as LOOP_HOLD_MS, or tells no time", async () => {
      for (const written of [NOW - LOOP_HOLD_MS, null]) {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        firedAt(s, written);
        const { status, told } = await tracked(s);
        try {
          expect(status.loopHolds("p1")).toBe(false);
          expect(told).toEqual([false]);
        } finally { status.stop(); }
      }
    });

    it("holds no longer than LOOP_HOLD_MS from the first read on a fire dated ahead of this PC's clock", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      // a clock set back since, or a transcript copied from a PC whose clock runs ahead
      firedAt(s, NOW + 60 * 60 * 1000);
      let now = NOW;
      const { status, told } = await tracked(s, () => now);
      try {
        expect(status.loopHolds("p1")).toBe(true);
        now += LOOP_HOLD_MS;
        expect(status.loopHolds("p1")).toBe(false);
        status.poll();
        expect(told).toEqual([true, false]);
      } finally { status.stop(); }
    });

    it("lets go by itself, and says so, once no rest was written for LOOP_HOLD_MS", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      let now = NOW;
      const { status, told } = await tracked(s, () => now);
      try {
        fire(s, 3);
        status.poll();
        now += LOOP_HOLD_MS - 1;
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        const before = told.length;
        // a turn interrupted on a Claude Code that writes no rest for it, or whose process was killed
        now += 1;
        expect(status.loopHolds("p1")).toBe(false);
        status.poll();
        expect(told.slice(before)).toEqual([false]);
        // and what is written later, which is no fire and no self-resumed prompt, brings no hold back
        answer(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
      } finally { status.stop(); }
    });

    it("keeps the hold through a new lookup of the pane's session, and says it is over though that lookup came before any poll found it so", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      let now = NOW;
      const { status, told } = await tracked(s, () => now);
      try {
        fire(s, 3);
        status.poll();
        expect(told.at(-1)).toBe(true);
        // a snapshot's lookup of a session whose process is not known replaces what is kept of the pane
        const before = status.sessionOf("p1");
        now += 30_000;
        await status.refresh([pane("p1", "claude")]);
        expect(status.sessionOf("p1")).toEqual(before);
        expect(status.loopHolds("p1")).toBe(true);
        expect(told.at(-1)).toBe(true);
        now = NOW + LOOP_HOLD_MS;
        await status.refresh([pane("p1", "claude")]);
        expect(status.sessionOf("p1")).toEqual(before);
        // the queue still hears that nothing holds it: no status event may come to say so
        expect(told.at(-1)).toBe(false);
      } finally { status.stop(); }
    });

    it("holds from the fire to the resumed turn's rest or its time, whatever herdr says of the pane and whenever it says it", async () => {
      const words: ((status: ClaudeSubagentStatus) => void)[] = [
        // herdr tells a turn at work: the resumed one on time, or the one before it late
        (status) => { status.quiet("p1", true); status.busy("p1", "herdr"); },
        // and then reads the pane at rest: the turn before's rest, or the resumed turn interrupted with no rest written
        (status) => { status.quiet("p1", true); status.busy("p1", "herdr"); status.quiet("p1", true); },
        // and then tells a turn at work again
        (status) => { status.quiet("p1", true); status.busy("p1", "herdr"); status.quiet("p1", true); status.busy("p1", "herdr"); },
        // its working with no rest word heard in an event before it (the server just started), then its rest word
        (status) => { status.quiet("p1", false); status.busy("p1", "herdr"); status.quiet("p1", true); },
        // the same working word twice: a snapshot read the change, then its event came
        (status) => { status.quiet("p1", true); status.busy("p1", "herdr"); status.busy("p1", "herdr"); status.quiet("p1", true); },
        // the chat's own send
        (status) => status.busy("p1", "chat", Date.parse(at(3))),
      ];
      for (const say of words) {
        for (const before of ["the turn read at rest", "a short turn of the person's that herdr has not told"] as const) {
          for (const said of ["before the fire is written", "with the fire written and read by no poll", "after the fire was read"] as const) {
            for (const end of ["rest", "time"] as const) {
              const s = session();
              s.prompt(1);
              rest(s, 2);
              let now = NOW;
              const { status, told } = await tracked(s, () => now);
              try {
                if (before !== "the turn read at rest") { s.prompt(3); rest(s, 4); }
                if (said === "before the fire is written") say(status);
                fire(s, 5);
                if (said === "with the fire written and read by no poll") say(status);
                status.poll();
                if (said === "after the fire was read") say(status);
                status.poll();
                expect(status.loopHolds("p1")).toBe(true);
                expect(told.at(-1)).toBe(true);
                // what the resumed turn writes is no rest
                resumes(s, 5);
                answer(s, 5);
                status.poll();
                expect(status.loopHolds("p1")).toBe(true);
                // only its rest, or its time, ends the hold, and is told
                if (end === "rest") rest(s, 6); else now += LOOP_HOLD_MS;
                status.poll();
                expect(status.loopHolds("p1")).toBe(false);
                expect(told.at(-1)).toBe(false);
              } finally { status.stop(); }
            }
          }
        }
      }
    });

    it("holds on the second of two loops due together: its prompt follows the first loop turn's rest with no fire between", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status, told } = await tracked(s);
      try {
        // both fires are written in the scheduler's one tick, then the first loop's prompt and turn
        fire(s, 3);
        fire(s, 3);
        resumes(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        answer(s, 4);
        rest(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        // the second loop's prompt runs at once: herdr still tells the first loop's turn, or its rest
        resumes(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        status.quiet("p1", true);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        rest(s, 5);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        expect(told).toEqual([false, true, false, true, false]);
      } finally { status.stop(); }
    });

    it("holds anew, for its full time, on what resumes after a turn that wrote no rest", async () => {
      for (const next of ["the second loop's prompt", "another fire"] as const) {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        let now = NOW;
        const { status, told } = await tracked(s, () => now);
        try {
          // two loops due in one tick: both fires, then the first loop's prompt and turn, which is interrupted and writes no rest
          fire(s, 3);
          fire(s, 3);
          resumes(s, 3);
          answer(s, 3);
          status.poll();
          expect(status.loopHolds("p1")).toBe(true);
          // 12 s later the second loop's prompt runs, or another task fires: that turn is another one
          now += 12_000;
          if (next === "another fire") fire(s, 3.2); else resumes(s, 3.2);
          status.poll();
          // it holds for its own time, past the end of the first one's
          now = NOW + LOOP_HOLD_MS;
          status.poll();
          expect(status.loopHolds("p1")).toBe(true);
          now = NOW + 12_000 + LOOP_HOLD_MS - 1;
          expect(status.loopHolds("p1")).toBe(true);
          now += 1;
          expect(status.loopHolds("p1")).toBe(false);
          status.poll();
          expect(told).toEqual([false, true, false]);
        } finally { status.stop(); }
      }
    });

    it("holds on a scheduled task that is no loop from its fire, until its rest or its time", async () => {
      for (const end of ["rest", "time"] as const) {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        let now = NOW;
        const { status, told } = await tracked(s, () => now);
        try {
          // its fire carries no taskKind: it holds as a loop's does, before the turn's prompt is written
          s.parent({ type: "system", subtype: "scheduled_task_fire", isSidechain: false, timestamp: at(3), taskId: "7c2e9a10" });
          status.poll();
          expect(status.loopHolds("p1")).toBe(true);
          resumes(s, 3, false);
          status.poll();
          expect(status.loopHolds("p1")).toBe(true);
          if (end === "rest") rest(s, 4); else now += LOOP_HOLD_MS;
          status.poll();
          expect(status.loopHolds("p1")).toBe(false);
          // told as it came and as it went; the prompt, which begins the turn shown, tells the same hold once more
          expect(told).toEqual([false, true, true, false]);
        } finally { status.stop(); }
      }
    });

    it("holds nothing on a fire that is a subagent's, however its line is spaced, or that is no system entry", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status } = await tracked(s);
      try {
        s.parent({ type: "system", subtype: "scheduled_task_fire", isSidechain: true, timestamp: at(3), taskKind: "loop", taskId: "591b6f5a" });
        appendFileSync(s.path, `{"type":"system","subtype":"scheduled_task_fire","isSidechain": true,"timestamp":"${at(3)}","taskId":"591b6f5a"}\n`);
        s.parent({ type: "attachment", subtype: "scheduled_task_fire", timestamp: at(3), taskKind: "loop", taskId: "591b6f5a" });
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        // the session's own is what holds
        fire(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
      } finally { status.stop(); }
    });

    it("tells a self-resumed turn's prompt by either of its keys", async () => {
      for (const keys of ["turnOrigin", "wakeupSource"] as const) {
        for (const loop of [true, false]) {
          const s = session();
          s.prompt(1);
          rest(s, 2);
          const { status } = await tracked(s);
          try {
            resumes(s, 3, loop, at(3), keys);
            status.poll();
            expect(status.loopHolds("p1")).toBe(true);
          } finally { status.stop(); }
        }
      }
    });

    it("holds on a self-resumed turn's prompt found at the first read as on a fire: by its own age", async () => {
      for (const [age, held] of [[20_000, true], [LOOP_HOLD_MS, false]] as const) {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        resumes(s, 3, true, new Date(NOW - age).toISOString());
        const { status } = await tracked(s);
        try {
          expect(status.loopHolds("p1")).toBe(held);
        } finally { status.stop(); }
      }
    });

    it("holds anew on a later wakeup though the turn the one before resumed wrote no rest", async () => {
      for (const before of ["a turn", "nothing"] as const) {
        for (const next of ["fire", "prompt"] as const) {
          const s = session();
          s.prompt(1);
          rest(s, 2);
          let now = NOW;
          const { status, told } = await tracked(s, () => now);
          try {
            // a loop turn interrupted, which writes no rest, or one that never wrote its prompt: its hold runs out
            fire(s, 3);
            if (before === "a turn") { resumes(s, 3); answer(s, 3); }
            status.poll();
            now += LOOP_HOLD_MS;
            status.poll();
            expect(status.loopHolds("p1")).toBe(false);
            // minutes later the next wakeup: another fire, or a scheduled task's prompt
            if (next === "fire") fire(s, 8); else resumes(s, 8, false);
            status.poll();
            expect(status.loopHolds("p1")).toBe(true);
            expect(told).toEqual([false, true, false, true]);
          } finally { status.stop(); }
        }
      }
    });

    it("ends a wakeup at its rest: what resumes next holds anew, though that turn wrote nothing else", async () => {
      for (const next of ["fire", "prompt"] as const) {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        const { status, told } = await tracked(s);
        try {
          fire(s, 3);
          status.poll();
          rest(s, 3);
          status.poll();
          expect(status.loopHolds("p1")).toBe(false);
          // seconds later, inside the time the first fire would have held for
          if (next === "fire") fire(s, 3.1); else resumes(s, 3.1);
          status.poll();
          expect(status.loopHolds("p1")).toBe(true);
          expect(told).toEqual([false, true, false, true]);
        } finally { status.stop(); }
      }
    });

    it("takes the keys of a self-resumed prompt only from the session's own entry, not from words that quote them", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status } = await tracked(s);
      const scheduled = { turnOrigin: "scheduled", wakeupSource: "loop_wakeup" };
      /** each is read by itself, and its turn brought to rest before the next */
      const holdsNothing = (write: () => void) => {
        write();
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        rest(s, 3);
        status.poll();
      };
      try {
        // a prompt of the person's that quotes the keys, and one that holds them in an object inside it
        holdsNothing(() => s.parent({ type: "user", timestamp: at(3), permissionMode: "default", origin: { kind: "human" }, turnOrigin: "human", message: { role: "user", content: 'why "turnOrigin":"scheduled" and "wakeupSource":"loop_wakeup"?' } }));
        holdsNothing(() => s.parent({ type: "user", timestamp: at(3), permissionMode: "default", origin: { kind: "human" }, turnOrigin: "human", message: { role: "user", content: "and this?" }, attached: scheduled }));
        // a subagent's entry that carries them, however its line is spaced
        holdsNothing(() => s.parent({ type: "user", isSidechain: true, isMeta: true, ...scheduled, timestamp: at(3), message: { role: "user", content: "check" } }));
        holdsNothing(() => appendFileSync(s.path, `{"type":"user","isSidechain": true,"isMeta":true,"turnOrigin":"scheduled","wakeupSource":"loop_wakeup","timestamp":"${at(3)}","message":{"role":"user","content":"check"}}\n`));
        // an entry that is no prompt, though it holds a user entry inside it
        holdsNothing(() => s.parent({ type: "assistant", ...scheduled, timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "on it" }] } }));
        holdsNothing(() => s.parent({ type: "api-request", ...scheduled, timestamp: at(3), params: { messages: [{ type: "user" }] } }));
        // the session's own prompt with those keys is what holds
        resumes(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
      } finally { status.stop(); }
    });

    it("holds on a fire written to the file that took the transcript's place, by what that file says alone", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      fire(s, 3);
      const { status, told } = await tracked(s);
      try {
        // the fire read first is history, written 57 minutes ago
        expect(status.loopHolds("p1")).toBe(false);
        // another file takes the transcript's place, of the same size: what was read of the one before says nothing of it
        copyFileSync(s.path, `${s.path}.new`);
        renameSync(`${s.path}.new`, s.path);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        rest(s, 4);
        fire(s, 5);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        // the turn's rest ends the hold, and is told
        rest(s, 6);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        expect(told.at(-1)).toBe(false);
      } finally { status.stop(); }
    });

    it("reads the transcript for a hold begun or ended since the pane's last poll, and tells of it", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      let now = NOW;
      const { status, told } = await tracked(s, () => now);
      try {
        expect(status.loopHoldsNow("p1")).toBe(false);
        // a fire no poll has read: as the last poll left it nothing holds, and the read made now finds it
        fire(s, 3);
        expect(status.loopHolds("p1")).toBe(false);
        expect(status.loopHoldsNow("p1")).toBe(true);
        expect(told.at(-1)).toBe(true);
        // so with the resumed turn's rest
        rest(s, 4);
        expect(status.loopHolds("p1")).toBe(true);
        expect(status.loopHoldsNow("p1")).toBe(false);
        expect(told.at(-1)).toBe(false);
        // and with a hold whose time ran out since the last poll, with nothing written
        fire(s, 5);
        expect(status.loopHoldsNow("p1")).toBe(true);
        now += LOOP_HOLD_MS;
        const before = told.length;
        expect(status.loopHoldsNow("p1")).toBe(false);
        expect(told.slice(before)).toEqual([false]);
        // nothing is told twice
        expect(status.loopHoldsNow("p1")).toBe(false);
        expect(told.slice(before)).toEqual([false]);
      } finally { status.stop(); }
    });

    it("reads nothing else and tells nothing where no wakeup was written: the pane's busy signals stay as its last poll left them", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      let now = NOW;
      let changes = 0;
      const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => { changes++; }, now: () => now });
      await status.refresh([pane("p1", "claude")]);
      try {
        // herdr says the pane works with no turn written: that word waits for its turn, and the pane is told of
        status.busy("p1", "herdr");
        const told = changes;
        // it began none in the time a signal is shown working (BUSY_HOLD_MS), and a subagent started meanwhile
        now += 5000;
        s.agent("a1", { steps: [[3, 1]] });
        // the read made for a wakeup's hold finds none: it ages no signal, counts nothing, and tells nothing
        expect(status.loopHoldsNow("p1")).toBe(false);
        expect(changes).toBe(told);
        expect(status.holdsQueue("p1")).toBe(false);
        expect(status.countOf("p1")).toBe(0);
        // the pane's own poll does
        status.poll();
        expect(changes).toBe(told + 1);
        expect(status.holdsQueue("p1")).toBe(true);
        expect(status.countOf("p1")).toBe(1);
      } finally { status.stop(); }
    });

    it("has no hold to read for a pane whose transcript is not found", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      fire(s, 3);
      let found = false;
      const status = new ClaudeSubagentStatus({ resolve: async () => found ? { path: s.path, startedAt: null } : null, onChange: () => undefined, now: () => Date.parse(at(3)) + 1000 });
      try {
        expect(status.loopHoldsNow("p1")).toBe(false);
        await status.refresh([pane("p1", "claude")]);
        expect(status.sessionOf("p1")).toBeNull();
        expect(status.loopHoldsNow("p1")).toBe(false);
        // found by a snapshot's lookup, the fire written a second before holds
        found = true;
        await status.refresh([pane("p1", "claude", "s2")]);
        expect(status.loopHoldsNow("p1")).toBe(true);
      } finally { status.stop(); }
    });

    it.each(["the pane left Claude", "the tracker stopped"] as const)("reads nothing once %s: what the pane's last poll found stands, for its time", async (gone) => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status } = await tracked(s);
      try {
        fire(s, 3);
        expect(status.loopHoldsNow("p1")).toBe(true);
        if (gone === "the pane left Claude") await status.refresh([pane("p1", "codex")]); else status.stop();
        // the resumed turn's rest is written, and no read made for the hold opens the transcript
        rest(s, 4);
        const opened = spyOn(detailIo, "openSync");
        try {
          expect(status.loopHoldsNow("p1")).toBe(true);
          expect(opened).not.toHaveBeenCalled();
        } finally { opened.mockRestore(); }
      } finally { status.stop(); }
    });

    it("reads the hold anew from another file found in the transcript's place since the pane's last poll, by what that file says alone", async () => {
      // the file read before holds, and the one in its place tells of no self-resumed turn
      {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        const { status, told } = await tracked(s);
        try {
          copyFileSync(s.path, `${s.path}.other`);
          fire(s, 3);
          expect(status.loopHoldsNow("p1")).toBe(true);
          renameSync(`${s.path}.other`, s.path);
          expect(status.loopHoldsNow("p1")).toBe(false);
          expect(told.at(-1)).toBe(false);
        } finally { status.stop(); }
      }
      // the file read before came to rest past its fire, and the one in its place has a fire written a second ago
      // with no rest after it, right where the one before's stood: the place of a fire in one file says nothing of another's
      {
        const s = session();
        s.prompt(1);
        rest(s, 2);
        let now = NOW;
        const { status, told } = await tracked(s, () => now);
        try {
          firedAt(s, NOW - 1000);
          copyFileSync(s.path, `${s.path}.other`);
          status.poll();
          rest(s, 4);
          status.poll();
          expect(status.loopHolds("p1")).toBe(false);
          renameSync(`${s.path}.other`, s.path);
          // it holds as a fire found at any transcript's first read does: for what is left of its time
          expect(status.loopHoldsNow("p1")).toBe(true);
          expect(told.at(-1)).toBe(true);
          now = NOW - 1000 + LOOP_HOLD_MS;
          expect(status.loopHoldsNow("p1")).toBe(false);
          expect(told.at(-1)).toBe(false);
        } finally { status.stop(); }
      }
    });

    it.each(["the pane's poll", "a send's own read of the hold"] as const)("holds on a fire in a transcript rewritten in place, though it stands before the last one read, when %s finds it", async (first) => {
      const s = session();
      const long = { type: "user", timestamp: at(1), permissionMode: "default", origin: { kind: "human" }, message: { role: "user", content: "a long prompt ".repeat(100) } };
      s.parent(long);
      rest(s, 2);
      const { status, told } = await tracked(s);
      try {
        fire(s, 3);
        status.poll();
        rest(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        // the same file written anew without that prompt, then the next wakeup's fire: it ends before where the first one did
        const before = statSync(s.path);
        writeFileSync(s.path, readFileSync(s.path, "utf8").replace(json(long), ""));
        fire(s, 5);
        expect(statSync(s.path).ino).toBe(before.ino);
        expect(statSync(s.path).size).toBeLessThan(before.size);
        // it is no fire the pane took account of: it holds
        if (first === "the pane's poll") status.poll();
        expect(status.loopHoldsNow("p1")).toBe(true);
        expect(told.at(-1)).toBe(true);
        rest(s, 6);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
      } finally { status.stop(); }
    });

    it("ends no hold on a rest that tells no time: the resumed turn holds to a rest that does", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status, told } = await tracked(s);
      try {
        fire(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        // a turn_duration entry with no timestamp is no rest the transcript's turns go by, and none for the hold
        s.parent({ type: "system", subtype: "turn_duration", isSidechain: false });
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        expect(status.loopHoldsNow("p1")).toBe(true);
        rest(s, 4);
        status.poll();
        expect(status.loopHolds("p1")).toBe(false);
        expect(told).toEqual([false, true, false]);
      } finally { status.stop(); }
    });

    it("ends the hold of a fire written while another turn worked at that turn's rest: the task's own turn holds from its prompt", async () => {
      const s = session();
      s.prompt(1);
      rest(s, 2);
      const { status } = await tracked(s);
      try {
        // a turn of the person's at work, and a task that comes due meanwhile, whose fire Claude writes then
        s.prompt(3);
        fire(s, 3);
        status.poll();
        expect(status.loopHolds("p1")).toBe(true);
        // that turn's rest ends the hold as any rest does: which turn a fire began is not kept
        rest(s, 4);
        expect(status.loopHoldsNow("p1")).toBe(false);
        // the task's turn begins at once, and holds from its own prompt on. A known bound: nothing holds between
        // that rest and this line, which Claude writes some tens of milliseconds into the turn
        resumes(s, 4);
        expect(status.loopHoldsNow("p1")).toBe(true);
        rest(s, 5);
        expect(status.loopHoldsNow("p1")).toBe(false);
      } finally { status.stop(); }
    });

  });
});

describe("claudeSubagents reading", () => {
  const assistant = (id: string, pad = "") => json({ type: "assistant", timestamp: at(1), message: { id, model: "claude-opus-5", content: [], pad } });

  it("keeps a failed open or read unfinished instead of reporting the end of the file", () => {
    const s = session();
    for (const path of [join(s.path, "..", "missing.jsonl"), join(s.path, "..")]) {
      // the identity of what is there, if anything: each is refused for what it is
      const exact = ((): string => { try { const stat = lstatSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; } catch { return "0:0"; } })();
      expect(readLines(path, 0, { size: 10, exact }, 10, () => { throw new Error("no line should be read"); }, false)).toEqual({ offset: 0, skipping: false, more: true, failed: true });
    }
  });

  it("waits for a share of the budget that fits a file's first line, and never jumps to the end of it", () => {
    const s = session();
    const big = s.agent("big", { steps: [] });
    const next = s.agent("next", { steps: [] });
    // `big` takes all but a little of the budget; `next` starts with a line larger than what is left
    writeFileSync(big, Array.from({ length: 7_900 }, (_, n) => assistant(`b${n}`, "p".repeat(1000))).join(""));
    writeFileSync(next, assistant("n1", "q".repeat(400_000)));
    utimesSync(big, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const turns = () => claudeSubagents(s.path, true, NOW).find((task) => task.id === "next")?.turns;
    // a whole file of one entry too long to tell its end from: not listed until it is read
    expect(turns()).toBeUndefined();
    expect(turns()).toBe(1);
    expect(claudeSubagents(s.path, true, NOW).find((task) => task.id === "next")?.model).toBe("claude-opus-5");
  });

  it("skips a line longer than the whole budget, and not what follows it", () => {
    const s = session();
    const file = s.agent("a1", { steps: [] });
    writeFileSync(file, assistant("m0", "x".repeat(9 * 1024 * 1024)) + assistant("m1"));
    claudeSubagents(s.path, true, NOW);
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(1);
    // the same of the parent: an 9 MB entry (an image) does not swallow the notice after it
    s.parent({ type: "user", timestamp: at(2), message: { role: "user", content: "i".repeat(9 * 1024 * 1024) } });
    s.notify("a1", 3);
    expect(ids(s.path)).toEqual(["a1:completed"]);
  });

  it("reads a synchronous agent's answer that quotes the tag, and an entry that holds an answer and a notice", () => {
    const s = session();
    for (const id of ["q", "batch", "bg"]) s.agent(id, { shape: id === "bg" ? "background" : "foreground", toolUseId: `toolu_${id}` });
    s.parent({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: ["q", "batch"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name: "Agent", input: { note: "<task-notification>" } })) } });
    const quoted = '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>';
    s.parent({ type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", content: `it said ${quoted}` }] } });
    // one entry: the answer of one agent beside the notice of another
    s.parent({ type: "user", timestamp: at(5), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_batch", content: "done" },
      { type: "text", text: quoted.replace("<task-id>x", "<task-id>bg").replace('"x"', '"task bg"') },
    ] } });
    expect(ids(s.path).sort()).toEqual(["batch:completed", "bg:completed", "q:completed"]);
  });

  it("takes whichever of the answer and the notice is newest, and the acknowledgement of a launch for neither", () => {
    const s = session();
    s.agent("sync", { shape: "foreground", toolUseId: "toolu_sync" });
    // no requestShape at all: the immediate acknowledgement does not end a background agent
    s.agent("noshape", { shape: "", toolUseId: "toolu_noshape" });
    s.parent({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: ["sync", "noshape"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name: "Agent", input: {} })) } });
    s.parent({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_noshape", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: noshape" }] }] } });
    s.parent({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sync", content: "answer" }] } });
    expect(ids(s.path).sort()).toEqual(["noshape:running", "sync:completed"]);
    // resumed with a message: running again until it notifies, and then that notice is the end
    s.work("sync", 6, 5);
    expect(ids(s.path).sort()).toEqual(["noshape:running", "sync:running"]);
    s.notify("sync", 8, { toolUseId: "toolu_resumed" });
    expect(claudeSubagents(s.path, true, NOW).find((task) => task.id === "sync")).toMatchObject({ status: "completed", ended_at: at(8) });
  });

  it("reads an agent last written before the Claude process now in the pane started as lost", () => {
    const s = session();
    s.agent("old", { steps: [[1, 1], [7, 1]] });
    s.agent("new", { steps: [[1, 1], [12, 1]] });
    const states = (since: number | null) => claudeSubagents(s.path, true, NOW, since).map((task) => `${task.id}:${task.status}`).sort();
    expect(states(null)).toEqual(["new:running", "old:running"]);
    expect(states(Date.parse(at(10)))).toEqual(["new:running", "old:lost"]);
    expect(claudeSubagents(s.path, true, NOW, Date.parse(at(10))).find((task) => task.id === "old")?.ended_at).toBe(at(7));
  });

  it("never turns an id from a transcript into a path outside the folder", () => {
    const s = session();
    writeFileSync(join(s.path, "..", "secret.meta.json"), JSON.stringify({ description: "secret", agentType: "x" }));
    expect([...subagentDetails(s.path, ["x/../../../secret", "..", "a/b"])]).toEqual([]);
    const block = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`;
    expect(taskNotification(block("x/../../../secret"))).toBeNull();
    // a line that only mentions the tag, in a tool result, is no notification
    const result = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: block("fine") }] } });
    expect(lineNotifications(result)).toEqual([]);
    expect(lineNotifications(JSON.stringify({ type: "user", message: { role: "user", content: block("fine") } }))).toHaveLength(1);
  });

  it("sees an agent added to the folder", () => {
    const s = session();
    s.agent("a1");
    expect(ids(s.path)).toEqual(["a1:running"]);
    s.agent("a2");
    expect(ids(s.path).sort()).toEqual(["a1:running", "a2:running"]);
  });
});

describe("ClaudeSubagentStatus upkeep", () => {
  const pane = (agent: string | null, session = "s1"): HerdrPane => ({ pane_id: "p1", agent, agent_session: { agent: agent ?? "", kind: "id", source: "hook", value: session }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 }) as HerdrPane;

  it("looks up new panes from the newest snapshot after an in-flight refresh", async () => {
    const one = session();
    const latest = session();
    latest.agent("a1");
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const looked: string[] = [];
    const status = new ClaudeSubagentStatus({
      resolve: (p) => {
        looked.push(p.pane_id);
        return p.pane_id === "p1" ? lookup.promise : Promise.resolve({ path: latest.path, startedAt: null });
      },
      onChange: () => undefined, now: () => NOW,
    });
    const original = pane("claude");
    const pending = status.refresh([original]);
    const superseded = status.refresh([original, { ...pane("claude", "s2"), pane_id: "p2" }]);
    const current = status.refresh([original, { ...pane("claude", "s3"), pane_id: "p3" }]);
    lookup.resolve({ path: one.path, startedAt: null });
    await Promise.all([pending, superseded, current]);
    expect(looked).toEqual(["p1", "p3"]);
    expect(status.sessionOf("p2")).toBeNull();
    expect(status.sessionOf("p3")?.path).toBe(latest.path);
    expect(status.countOf("p3")).toBe(1);
  });

  it("discards queued snapshots when the tracker stops", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const looked: string[] = [];
    const status = new ClaudeSubagentStatus({ resolve: (p) => { looked.push(p.pane_id); return lookup.promise; }, onChange: () => undefined });
    const pending = status.refresh([pane("claude")]);
    const queued = status.refresh([{ ...pane("claude", "s2"), pane_id: "p2" }]);
    status.stop();
    lookup.resolve({ path: s.path, startedAt: null });
    await Promise.all([pending, queued]);
    expect(looked).toEqual(["p1"]);
    expect(status.sessionOf("p1")).toBeNull();
    expect(status.sessionOf("p2")).toBeNull();
  });

  it("does not let an older lookup overwrite a newer session", async () => {
    const old = session();
    const current = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: (p) => p.agent_session?.value === "old" ? lookup.promise : Promise.resolve({ path: current.path, startedAt: null }), onChange: () => undefined });
    const pending = status.ensure(pane("claude", "old"));
    await status.ensure(pane("claude", "new"));
    lookup.resolve({ path: old.path, startedAt: null });
    await pending;
    expect(status.sessionOf("p1")?.path).toBe(current.path);
  });

  it("does not restore Claude after the pane changed agent during a lookup", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: () => lookup.promise, onChange: () => undefined });
    const pending = status.ensure(pane("claude"));
    await status.ensure(pane("codex"));
    lookup.resolve({ path: s.path, startedAt: null });
    await pending;
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("does not restore a closed pane when its snapshot lookup finishes", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: () => lookup.promise, onChange: () => undefined });
    const pending = status.refresh([pane("claude")]);
    const closed = status.refresh([]);
    lookup.resolve({ path: s.path, startedAt: null });
    await Promise.all([pending, closed]);
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("does not finish a pending lookup after the tracker stops", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: () => lookup.promise, onChange: () => undefined });
    const pending = status.ensure(pane("claude"));
    status.stop();
    lookup.resolve({ path: s.path, startedAt: null });
    await pending;
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("tells a drop to nothing when the pane moves to another session", async () => {
    const one = session();
    one.agent("a1", { steps: [[1, 1]] });
    const two = session();
    const told: number[] = [];
    let path = one.path;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path, startedAt: null }), onChange: (_, running) => told.push(running), now: () => NOW });
    await status.refresh([pane("claude", "s1")]);
    path = two.path;
    await status.refresh([pane("claude", "s2")]);
    expect(told).toEqual([1, 0]);
    expect(status.countOf("p1")).toBe(0);
  });

  it("sees an agent that ended resume by its own file, though nothing else of the session was written", async () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    s.notify("a1", 3);
    const now = Date.now();
    const old = new Date(now - 5000);
    const dir = join(s.path.replace(/\.jsonl$/, ""), "subagents");
    for (const path of [file, s.path, dir]) utimesSync(path, old, old);
    const told: number[] = [];
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: 42 }), onChange: (_, running) => told.push(running), now: () => now });
    await status.refresh([pane("claude")]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, live: true, startedAt: 42, read: expect.any(Number) });
    status.poll();
    expect(told).toEqual([]);
    // a message to it was written before, and the session is idle: only its own file moves
    s.work("a1", 5, 1);
    // An append can share the previous write's coarse filesystem clock tick.
    utimesSync(file, old, old);
    status.poll();
    expect(told).toEqual([1]);
  });

  it("sees a running agent end by its own file while the parent and folder stay quiet", async () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    const now = Date.now();
    const old = new Date(now - 5000);
    const dir = join(s.path.replace(/\.jsonl$/, ""), "subagents");
    for (const path of [file, s.path, dir]) utimesSync(path, old, old);
    const told: number[] = [];
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (_, running) => told.push(running), now: () => now });
    await status.refresh([pane("claude")]);
    expect(told).toEqual([1]);
    appendFileSync(file, json({ type: "assistant", timestamp: at(3), message: { id: "end", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }));
    utimesSync(file, old, old);
    status.poll();
    expect(told).toEqual([1, 0]);
  });

  it("does not read again while nothing it watches changed", async () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    const now = Date.now();
    const old = new Date(now - 5000);
    for (const path of [file, s.path, join(s.path.replace(/\.jsonl$/, ""), "subagents")]) utimesSync(path, old, old);
    let looked = 0;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => { looked += 1; }, now: () => now });
    await status.refresh([pane("claude")]);
    expect(looked).toBe(1);
    // An unchanged poll does not notify again.
    status.poll();
    expect(looked).toBe(1);
  });

  it("finds a pane's transcript on demand", async () => {
    const s = session();
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => undefined, now: () => NOW });
    expect(status.sessionOf("p1")).toBeNull();
    await status.ensure(pane("claude"));
    expect(status.sessionOf("p1")?.path).toBe(s.path);
    await status.ensure({ ...pane("codex"), pane_id: "p2" });
    expect(status.sessionOf("p2")).toBeNull();
  });
});

describe("remember", () => {
  it("drops the oldest entry over the cap, one at a time, and a touched one is the newest", () => {
    const map = new Map<string, number>();
    for (const key of ["a", "b", "c"]) remember(map, key, 1, 3);
    remember(map, "a", 2, 3);
    remember(map, "d", 1, 3);
    expect([...map.keys()]).toEqual(["c", "a", "d"]);
  });
});

describe("claudeSubagents reading, upkeep", () => {
  const assistant = (id: string, pad = "") => json({ type: "assistant", timestamp: at(1), message: { id, model: "claude-opus-5", content: [], pad } });

  it("reads the line after a skipped over-budget line from its start", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    expect(ids(s.path)).toEqual(["a1:running"]);
    // a 10 MB entry, then a 7 MB notification that crosses the read after the skipped line's end
    s.parent({ type: "user", timestamp: at(2), message: { role: "user", content: "i".repeat(10 * 1024 * 1024) } });
    const block = `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "task a1" finished</summary>\n<result>${"r".repeat(7 * 1024 * 1024)}</result>\n</task-notification>`;
    s.parent({ type: "queue-operation", operation: "enqueue", timestamp: at(3), content: block });
    ids(s.path);
    expect(ids(s.path)).toEqual(["a1:completed"]);
  });

  it("gives a file that waited for budget the whole of it next time, though others are newer and large", () => {
    const s = session();
    const big = s.agent("big", { steps: [] });
    const next = s.agent("next", { steps: [] });
    writeFileSync(big, Array.from({ length: 20_000 }, (_, n) => assistant(`b${n}`, "p".repeat(1000))).join(""));
    writeFileSync(next, assistant("n1", "q".repeat(400_000)));
    utimesSync(big, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const turns = () => claudeSubagents(s.path, true, NOW).find((task) => task.id === "next")?.turns;
    // a whole file of one entry too long to tell its end from: not listed until it is read
    expect(turns()).toBeUndefined();
    expect(turns()).toBe(1);
  });

  it("keeps what an agent was read as while the transcript is read in parts", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    s.agent("a2", { steps: [[1, 1]] });
    s.notify("a2", 3);
    expect(ids(s.path).sort()).toEqual(["a1:running", "a2:completed"]);
    // more than the first read takes arrives at once
    appendFileSync(s.path, json({ type: "user", timestamp: at(4), message: { role: "user", content: "f".repeat(1000) } }).repeat(30_000));
    const state = claudeSubagentState(s.path, true, NOW);
    expect(state.settled).toBe(false);
    expect(state.tasks.map((task) => `${task.id}:${task.status}`).sort()).toEqual(["a1:running", "a2:completed"]);
  });

  it("is not settled while a meta file is torn", () => {
    const s = session();
    s.agent("a1");
    const meta = join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", "agent-a1.meta.json");
    const whole = JSON.stringify({ agentType: "reviewer", description: "x", toolUseId: "toolu_a1" });
    writeFileSync(meta, whole.slice(0, 20));
    expect(claudeSubagentState(s.path, true, NOW).settled).toBe(false);
    writeFileSync(meta, whole);
    expect(claudeSubagentState(s.path, true, NOW).settled).toBe(true);
  });

  it("calls an agent lost by the process start only when it was quiet a minute before it", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1], [7, 1]] });
    const state = (since: number) => claudeSubagents(s.path, true, NOW, since)[0]?.status;
    expect(state(Date.parse(at(7)) + 30_000)).toBe("running");
    expect(state(Date.parse(at(7)) + 90_000)).toBe("lost");
  });

  it("answers within the time it is given", async () => {
    const started = Date.now();
    await within(50, new Promise(() => undefined));
    await within(1000, Promise.reject(new Error("slow herdr failed")));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("ClaudeSubagentStatus process", () => {
  const pane = (): HerdrPane => ({ pane_id: "p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "hook", value: "s1" }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 }) as HerdrPane;

  it("recovers incomplete process boundaries, throttles failures, and keeps the known transcript", async () => {
    for (const identity of ["missing-pid", "missing-start", "resolver-only"] as const) {
      const s = session();
      s.agent("orphan", { steps: [[1, 1]] });
      let now = NOW;
      let attempts = 0;
      let recovered = false;
      const status = new ClaudeSubagentStatus({
        now: () => now, refreshMs: 1000, onChange: () => {},
        ...(identity === "resolver-only" ? {} : { pid: async () => 123 }),
        resolve: async () => {
          attempts++;
          if (recovered) return { path: s.path, pid: 123, startedAt: NOW };
          if (attempts > 1) throw new Error("temporarily unavailable");
          return { path: s.path, pid: identity === "missing-start" ? 123 : null, startedAt: null };
        },
      });
      await status.refresh([pane()]);
      expect(status.countOf("p1")).toBe(1);
      now += 999;
      await status.refresh([pane()]);
      expect(attempts).toBe(1);
      now++;
      await status.refresh([pane()]);
      expect(attempts).toBe(2);
      expect(status.sessionOf("p1")?.path).toBe(s.path);
      expect(status.countOf("p1")).toBe(1);
      recovered = true;
      await status.refresh([pane()]);
      expect(attempts).toBe(2);
      now += 1000;
      await status.refresh([pane()]);
      expect(status.sessionOf("p1")?.startedAt).toBe(NOW);
      expect(status.countOf("p1")).toBe(0);
      now += 1000;
      await status.refresh([pane()]);
      expect(attempts).toBe(3);
    }
  });

  it("looks the session up again when the pane's Claude process is another one", async () => {
    const s = session();
    let pid = 100;
    let at = 0;
    const starts = [1000, 2000];
    let calls = 0;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: starts[calls++] ?? null, pid }), pid: async () => pid, onChange: () => undefined, now: () => at, refreshMs: 1000 });
    await status.refresh([pane()]);
    expect(status.sessionOf("p1")?.startedAt).toBe(1000);
    at = 1000;
    await status.refresh([pane()]);
    expect(calls).toBe(1);
    pid = 200;
    at = 2000;
    await status.refresh([pane()]);
    expect([calls, status.sessionOf("p1")?.startedAt]).toEqual([2, 2000]);
  });
});

describe("claudeSubagents, an agent's own turn", () => {
  const entry = (file: string, value: unknown) => appendFileSync(file, json({ isSidechain: true, ...(value as object) }));
  const assistant = (file: string, minute: number, stop: string | null, kind = "text") => entry(file, { type: "assistant", timestamp: at(minute), message: { id: `m${minute}${kind}`, model: "claude-haiku-4-5", stop_reason: stop, content: [{ type: kind, text: "x" }] } });
  /** a teammate: no notification, no toolUseId, a name of its own */
  const teammate = (s: ReturnType<typeof session>, id: string) => {
    writeFileSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", `agent-${id}.meta.json`), JSON.stringify({ agentType: "local-harness-map", name: "local-harness-map", spawnDepth: 0, requestShape: "background", taskKind: "in_process_teammate", teamName: "session-1" }));
    const file = join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", `agent-${id}.jsonl`);
    writeFileSync(file, "");
    entry(file, { type: "user", timestamp: at(1), message: { role: "user", content: "map it" } });
    return file;
  };
  /** a lead's shutdown request at 5, the teammate's SendMessage answer at 6 and that call's result at 7 */
  const shutdown = (file: string, result: { success: boolean; message: string; request_id: string }) => {
    entry(file, { type: "user", timestamp: at(5), message: { role: "user", content: `<teammate-message teammate_id="team-lead">${JSON.stringify({ type: "shutdown_request", request_id: result.request_id })}</teammate-message>` } });
    assistant(file, 6, "tool_use", "tool_use");
    entry(file, { type: "user", timestamp: at(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_shutdown", content: [{ type: "text", text: JSON.stringify(result) }] }] }, toolUseResult: result });
  };

  it("reads a teammate whose last turn ended as completed, at that entry's time, and titles it by its name", () => {
    const s = session();
    const file = teammate(s, "alocal-harness-map-f7b05717a4a23081");
    assistant(file, 2, null, "thinking");
    assistant(file, 3, "end_turn");
    // bookkeeping after the end is not a message to it
    entry(file, { type: "attachment", timestamp: at(4), attachment: { type: "queued_command" } });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "alocal-harness-map-f7b05717a4a23081", title: "local-harness-map", category: "local-harness-map", status: "completed", ended_at: at(3) }]);
  });

  it("reads one still streaming or calling a tool as running, and one sent a message after its end as running again", () => {
    const s = session();
    const streaming = teammate(s, "streaming");
    assistant(streaming, 2, null);
    const calling = teammate(s, "calling");
    assistant(calling, 2, "tool_use", "tool_use");
    const woken = teammate(s, "woken");
    assistant(woken, 2, "end_turn");
    expect(ids(s.path).sort()).toEqual(["calling:running", "streaming:running", "woken:completed"]);
    entry(woken, { type: "user", timestamp: at(5), message: { role: "user", content: "one more thing" } });
    expect(ids(s.path).sort()).toEqual(["calling:running", "streaming:running", "woken:running"]);
    assistant(woken, 6, "end_turn");
    expect(claudeSubagents(s.path, true, NOW).find((task) => task.id === "woken")).toMatchObject({ status: "completed", ended_at: at(6) });
  });

  it("reads a teammate that approved its lead's shutdown request as completed, at that answer's time", () => {
    const s = session();
    const file = teammate(s, "draft-t1");
    assistant(file, 3, "end_turn");
    shutdown(file, { success: true, message: "Shutdown approved. Sent confirmation to team-lead. Agent draft-t1 is now exiting.", request_id: "shutdown-1791642615398@draft-t1" });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "draft-t1", status: "completed", ended_at: at(7) }]);
  });

  /** the lead's TaskStop at `minute`: called with what it was asked to stop, answered with a task id of its own */
  const stop = (s: ReturnType<typeof session>, minute: number, asked: string, answered: string) => {
    s.parent({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_stop_${minute}`, name: "TaskStop", input: { task_id: asked } }] } });
    s.parent({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_stop_${minute}`, content: "{}" }] }, toolUseResult: { message: `Successfully stopped task: ${answered} (map it)`, task_id: answered, task_type: "in_process_teammate", command: "map it" } });
  };

  it("reads a teammate stopped by its name as cancelled, with the commands it left running", () => {
    const s = session();
    const file = teammate(s, "alocal-harness-map-f7b05717a4a23081");
    s.bash("bsh", 2, { description: "Run the IME probe", file });
    assistant(file, 3, "tool_use", "tool_use");
    // the answer's task id is none of the teammate's own
    stop(s, 4, "local-harness-map", "t9glutltm");
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.status}:${task.ended_at?.slice(14, 16) ?? "-"}`)).toEqual([
      "alocal-harness-map-f7b05717a4a23081:cancelled:04", "bsh:cancelled:04",
    ]);
  });

  it("reads a teammate stopped by its id as cancelled, and one sent a message after the stop, or spawned after it, as running", () => {
    const s = session();
    const byId = teammate(s, "by-id");
    assistant(byId, 2, "tool_use", "tool_use");
    stop(s, 3, "by-id", "t1");
    const woken = teammate(s, "woken-after-stop");
    assistant(woken, 2, "tool_use", "tool_use");
    stop(s, 3, "local-harness-map", "t2");
    entry(woken, { type: "user", timestamp: at(5), message: { role: "user", content: "go on" } });
    expect(ids(s.path).sort()).toEqual(["by-id:cancelled", "woken-after-stop:running"]);
  });

  it("reads a teammate stopped by its id, sent a message, then stopped by its name as cancelled at the second stop", () => {
    const s = session();
    const file = teammate(s, "restopped");
    assistant(file, 2, "tool_use", "tool_use");
    stop(s, 3, "restopped", "t1");
    entry(file, { type: "user", timestamp: at(5), message: { role: "user", content: "go on" } });
    stop(s, 6, "local-harness-map", "t2");
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.status}:${task.ended_at?.slice(14, 16) ?? "-"}`)).toEqual(["restopped:cancelled:06"]);
  });

  it("does not stop a teammate by a failed TaskStop", () => {
    const s = session();
    const file = teammate(s, "kept");
    assistant(file, 2, "tool_use", "tool_use");
    s.parent({ type: "assistant", timestamp: at(3), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_failed", name: "TaskStop", input: { task_id: "local-harness-map" } }] } });
    // an answer that names a task id still stops nothing when it is an error
    s.parent({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_failed", is_error: true, content: "No task found" }] }, toolUseResult: { task_id: "kept" } });
    expect(ids(s.path)).toEqual(["kept:running"]);
  });

  it("does not stop a teammate under a stopped name before its file is read", () => {
    const s = session();
    const old = teammate(s, "old-holder");
    assistant(old, 2, "tool_use", "tool_use");
    stop(s, 3, "local-harness-map", "t1");
    // a new teammate under the same name, its file not written yet
    const fresh = teammate(s, "fresh-holder");
    writeFileSync(fresh, "");
    expect(ids(s.path).filter((task) => task.startsWith("fresh-holder"))).not.toContain("fresh-holder:cancelled");
  });

  it("reads a teammate whose shutdown answer is no approval as still running", () => {
    const s = session();
    const file = teammate(s, "draft-t2");
    assistant(file, 3, "end_turn");
    shutdown(file, { success: false, message: "Shutdown rejected", request_id: "shutdown-2@x" });
    expect(ids(s.path)).toEqual(["draft-t2:running"]);
  });

  it("reads a teammate sent a message after its approved shutdown as running again", () => {
    const s = session();
    const file = teammate(s, "draft-t3");
    assistant(file, 3, "end_turn");
    shutdown(file, { success: true, message: "Shutdown approved. Sent confirmation to team-lead. Agent draft-t3 is now exiting.", request_id: "shutdown-3@draft-t3" });
    entry(file, { type: "user", timestamp: at(9), message: { role: "user", content: "one more thing" } });
    expect(ids(s.path)).toEqual(["draft-t3:running"]);
  });

  it("takes a background agent that ended its turn as done before its notification is written, and the newest word among them", () => {
    const s = session();
    const file = s.agent("bg", { steps: [[1, 1]] });
    assistant(file, 2, "end_turn");
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "bg", status: "completed", ended_at: at(2) }]);
    // its notice, written after, is newer and says it failed
    s.notify("bg", 3, { status: "failed" });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "bg", status: "failed", ended_at: at(3) }]);
  });

  it("titles by description, then name, then agent type, then id", () => {
    const s = session();
    const dir = join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents");
    const titles: [string, object][] = [["d", { description: "D", name: "N", agentType: "T" }], ["n", { name: "N", agentType: "T" }], ["t", { agentType: "T" }], ["i", {}]];
    for (const [id, meta] of titles) {
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
      writeFileSync(join(dir, `agent-${id}.jsonl`), json({ type: "user", timestamp: at(1), message: { role: "user", content: "x" } }));
    }
    expect(Object.fromEntries(claudeSubagents(s.path, true, NOW).map((task) => [task.id, task.title]))).toEqual({ d: "D", n: "N", t: "T", i: "i" });
  });
});

describe("claudeSubagents, background commands", () => {
  const command = (summary: string) => ({ summary: `Background command "${summary}`, carriers: ["queue" as const] });

  it("counts a resumed subagent for the new prompt without changing its original start", () => {
    const s = session();
    s.prompt(1);
    s.agent("review", { steps: [[2, 1]] });
    s.notify("review", 3);
    expect(claudeSubagentState(s.path, true, NOW).turnRunning).toBe(0);
    s.prompt(10);
    s.work("review", 11, 1);
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({
      running: 1, turnRunning: 1, tasks: [{ id: "review", started_at: at(2), status: "running" }],
    });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW).turnRunning).toBe(1);
  });

  it("says the session's turn rests from its turn_duration entry until a next turn writes anything (#2069)", () => {
    const s = session();
    s.prompt(1);
    s.agent("review", { steps: [[2, 1]] });
    expect(claudeSubagentState(s.path, true, NOW).resting).toBe(false);
    s.parent({ type: "assistant", timestamp: at(3), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } });
    s.parent({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: at(3) });
    // what Claude writes between turns moves nothing
    s.parent({ type: "last-prompt", lastPrompt: "go" });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, resting: true });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW).resting).toBe(true);
    // the subagent's notice is a next turn's request first
    s.parent({ type: "api-request", timestamp: at(4) });
    expect(claudeSubagentState(s.path, true, NOW).resting).toBe(false);
  });

  it("holds a turn at rest while its Workflow run goes on, until the run's notice", () => {
    const s = session();
    s.prompt(1);
    s.parent({ type: "assistant", timestamp: at(2), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_wm1", name: "Workflow", input: { name: "sweep" } }] } });
    s.parent({ type: "user", timestamp: at(2), toolUseResult: { status: "async_launched", taskId: "wm1", taskType: "local_workflow", workflowName: "sweep", runId: "wf_1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wm1", content: "Workflow launched in background. Task ID: wm1" }] } });
    s.parent({ type: "assistant", timestamp: at(3), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } });
    s.parent({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: at(3) });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, resting: true });
    expect(claudeSubagents(s.path, true, NOW)[0]).toMatchObject({ status: "running", title: "sweep" });
    s.notify("wm1", 4, { summary: 'Background workflow "sweep" (run wf_1) completed' });
    expect(claudeSubagentState(s.path, true, NOW).running).toBe(0);
  });

  it("takes a skill's echo for a prompt, and a local command's output back from its echo (#2072)", () => {
    const s = session();
    s.prompt(1);
    s.agent("review", { steps: [[2, 1]] });
    s.parent({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: at(3) });
    // a local command: caveat, echo, output
    s.parent({ type: "user", isMeta: true, timestamp: at(4), message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } });
    s.parent({ type: "user", timestamp: at(4), message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>" } });
    s.parent({ type: "user", timestamp: at(4), message: { role: "user", content: "<local-command-stdout>Set model to sonnet</local-command-stdout>" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ resting: true, promptAt: Date.parse(at(1)) });
    // a skill: its echo, then the skill's own text
    // as Claude Code records it: neither `origin` nor a permission mode
    s.parent({ type: "user", timestamp: at(5), message: { role: "user", content: "<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>" } });
    s.parent({ type: "user", isMeta: true, timestamp: at(5), message: { role: "user", content: [{ type: "text", text: "Review the PR." }] } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ resting: false, promptAt: Date.parse(at(5)) });
  });

  it("lists a running subagent while the session's last line is still being written, which certifies no rest (#2072)", () => {
    const s = session();
    s.prompt(1);
    s.agent("review", { steps: [[2, 1]] });
    s.parent({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: at(3) });
    appendFileSync(s.path, JSON.stringify({ type: "user", timestamp: at(4), message: { role: "user", content: "next" } }));
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ tasks: [{ id: "review", status: "running" }], resting: false });
  });

  it("does not count an old subagent's tool result as a new dispatch", () => {
    const s = session();
    s.prompt(1);
    const file = s.agent("review", { steps: [[2, 1]] });
    s.prompt(10);
    appendFileSync(file, json({ isSidechain: true, type: "user", timestamp: at(11), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "read complete" }] } }));
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 0 });
  });

  it.each(["compaction", "task notification"])("does not treat an old subagent's %s as a new dispatch on warm or cold reads", (kind) => {
    const s = session();
    s.prompt(1);
    const file = s.agent("review", { steps: [[2, 1]] });
    s.prompt(10);
    expect(claudeSubagentState(s.path, true, NOW).turnRunning).toBe(0);
    appendFileSync(file, json({
      isSidechain: true, type: "user", timestamp: at(11),
      ...(kind === "compaction" ? { isCompactSummary: true } : {}),
      message: { role: "user", content: kind === "compaction" ? "Earlier context summarized"
        : "<task-notification>\n<task-id>shell</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>" },
    }));
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 0 });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 0 });
  });

  it("keeps running after garbled lines or a failed stop, then accepts repeated successful stops once", () => {
    const s = session();
    s.prompt(1);
    s.bash("suite", 2);
    appendFileSync(s.path, '{garbled "task_id":"suite"\nnull\n');
    s.parent({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "failed-stop", is_error: true, content: "Could not stop suite" }] }, toolUseResult: { task_id: "suite", task_type: "local_bash" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 1 });
    for (const minute of [4, 5]) s.parent({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `stop-${minute}`, content: "{}" }] }, toolUseResult: minute === 4 ? { task_id: "suite", task_type: "local_bash" } : { shell_id: "suite" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 0, turnRunning: 0, tasks: [{ id: "suite", status: "cancelled", ended_at: at(4) }] });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 0, turnRunning: 0, tasks: [{ id: "suite", status: "cancelled", ended_at: at(4) }] });
  });

  it("lists a command the session sent to the background as running, by its description, with no subagent folder", () => {
    const s = session();
    rmSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111"), { recursive: true });
    s.bash("b1", 2, { description: "Run the full suite", command: "bun run test" });
    s.bash("b2", 3, { command: "sleep 30" });
    expect(claudeSubagents(s.path, true, NOW)).toEqual([
      { id: "b1", title: "Run the full suite", category: "shell", model: null, status: "running", started_at: at(2), ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: null },
      { id: "b2", title: "sleep 30", category: "shell", model: null, status: "running", started_at: at(3), ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: null },
    ]);
  });

  it("counts a Monitor and a background Workflow as background commands until their notices end them", () => {
    const s = session();
    s.parent({ type: "assistant", timestamp: at(2), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_m1", name: "Monitor", input: { command: "gh run watch 1", description: "Watch the deploy", timeout_ms: 600_000 } }] } });
    s.parent({ type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_m1", content: "Monitor started (task m1)" }] }, toolUseResult: { taskId: "m1", timeoutMs: 600_000, persistent: false } });
    s.parent({ type: "assistant", timestamp: at(3), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_w1", name: "Workflow", input: { script: "export const meta = {}" } }] } });
    s.parent({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_w1", content: "Workflow launched in background. Task ID: w1" }] }, toolUseResult: { status: "async_launched", taskId: "w1", taskType: "local_workflow", workflowName: "site-editions" } });
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.title}:${task.status}`)).toEqual(["m1:Watch the deploy:running", "w1:site-editions:running"]);
    s.notify("m1", 4, { summary: 'Monitor "Watch the deploy" stream ended' });
    s.notify("w1", 5, { summary: 'Dynamic workflow "site-editions" completed' });
    expect(ids(s.path)).toEqual(["w1:completed", "m1:completed"]);
  });

  it("counts a /loop wakeup until it fires, a newer one replaces it or the loop stops", () => {
    const s = session();
    const wakeup = (id: string, minute: number, scheduledFor: number) => {
      s.parent({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id, name: "ScheduleWakeup", input: scheduledFor === 0 ? { stop: true } : { delaySeconds: 1200, prompt: "check CI", reason: "Watch the CI run" } }] } });
      s.parent({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Next wakeup scheduled" }] }, toolUseResult: { scheduledFor, clampedDelaySeconds: 1200, wasClamped: false } });
    };
    wakeup("toolu_w1", 2, Date.parse(at(22)));
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.title}:${task.status}`)).toEqual(["toolu_w1:Watch the CI run:running"]);
    s.parent({ type: "system", subtype: "scheduled_task_fire", timestamp: at(22), taskKind: "loop", taskId: "591b6f5a" });
    wakeup("toolu_w2", 23, Date.parse(at(43)));
    wakeup("toolu_w3", 24, Date.parse(at(44)));
    expect(ids(s.path)).toEqual(["toolu_w3:running", "toolu_w2:completed", "toolu_w1:completed"]);
    wakeup("toolu_stop", 25, 0);
    expect(ids(s.path)).toEqual(["toolu_w3:completed", "toolu_w2:completed", "toolu_w1:completed"]);
  });

  it("ends a command by its notice, whatever the status, and by TaskStop or KillShell", () => {
    const s = session();
    for (const id of ["ok", "bad", "killed", "stopped", "shell"]) s.bash(id, 2);
    s.notify("ok", 3, command('x" completed (exit code 0)'));
    s.notify("bad", 4, { status: "failed", ...command('x" failed with exit code 1') });
    s.notify("killed", 5, { status: "killed", ...command('x" was stopped after reaching its background time limit') });
    s.parent({ type: "user", timestamp: at(6), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_stop", content: "{}" }] }, toolUseResult: { message: "Successfully stopped task: stopped (sleep)", task_id: "stopped", task_type: "local_bash", command: "sleep" } });
    s.parent({ type: "user", timestamp: at(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_kill", content: "{}" }] }, toolUseResult: { message: "Successfully killed shell: shell", shell_id: "shell" } });
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.status}:${task.ended_at === null ? "-" : task.ended_at.slice(14, 16)}`)).toEqual([
      "shell:cancelled:07", "stopped:cancelled:06", "killed:cancelled:05", "bad:failed:04", "ok:completed:03",
    ]);
  });

  it("reads a command a subagent started, ended by the notice the session got, and one ended in the subagent's own file", () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    s.bash("bsub", 2, { description: "Run the suite for the review", file });
    s.bash("bown", 2, { file });
    appendFileSync(file, json({ isSidechain: true, type: "attachment", timestamp: at(3), attachment: { type: "queued_command", commandMode: "task-notification", prompt: `<task-notification>\n<task-id>bown</task-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>` } }));
    s.notify("a1", 4);
    expect(ids(s.path)).toEqual(["bsub:running", "a1:completed", "bown:completed"]);
    s.notify("bsub", 9, command('Run the suite for the review" completed (exit code 0)'));
    expect(ids(s.path)).toEqual(["bsub:completed", "a1:completed", "bown:completed"]);
  });

  it("reads a command as lost once the pane no longer runs Claude, or when it was started before the Claude process there", () => {
    const s = session();
    s.bash("old", 2);
    s.bash("new", 50);
    expect(ids(s.path, false)).toEqual(["new:lost", "old:lost"]);
    expect(claudeSubagents(s.path, true, NOW, Date.parse(at(40))).map((task) => `${task.id}:${task.status}`)).toEqual(["new:running", "old:lost"]);
  });

  it("counts what still runs of the turn: what started since the last prompt the person gave, a notice's turn going on", () => {
    const s = session();
    s.bash("server", 2, { command: "bun run dev" });
    s.prompt(10);
    s.bash("suite", 11);
    const file = s.agent("a1", { steps: [[12, 1]] });
    s.bash("review", 13, { file });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 4, turnRunning: 3 });
    // the notice of one starts a turn of its own, which is the same work going on
    s.notify("suite", 20, command('x" completed (exit code 0)'));
    s.parent({ type: "user", timestamp: at(20), origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>\n<task-id>suite</task-id>\n</task-notification>" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 3, turnRunning: 2 });
    // a prompt typed at rest, as older Claude Code writes it (no origin): a new turn
    s.prompt(30, null);
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 3, turnRunning: 0 });
    // one typed while the turn works is handed to it on the way: the same turn
    s.bash("lint", 31);
    s.parent({ type: "attachment", timestamp: at(32), attachment: { type: "queued_command", commandMode: "prompt", prompt: "and the docs" } });
    // nor is another session's message, or an interruption: neither carries a permission mode
    s.parent({ type: "user", timestamp: at(33), message: { role: "user", content: "Another Claude session sent a message: <teammate-message>hi</teammate-message>" } });
    s.parent({ type: "user", timestamp: at(34), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 4, turnRunning: 1 });
  });

  it("tells the pane's running count and what of it is the turn's when either changes", async () => {
    const s = session();
    s.prompt(1);
    s.bash("b1", 2);
    const told: [string, number, number][] = [];
    const pane = { pane_id: "p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "hook", value: "s1" }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (paneId, running, turnRunning) => told.push([paneId, running, turnRunning]), now: () => NOW });
    await status.refresh([pane]);
    s.prompt(3);
    status.poll("p1");
    s.notify("b1", 4, command('x" completed (exit code 0)'));
    status.poll("p1");
    expect(told).toEqual([["p1", 1, 1], ["p1", 1, 0], ["p1", 0, 0]]);
    expect(status.countOf("p1")).toBe(0);
  });

  it("announces a new prompt even when one background task replaces another between polls", async () => {
    const s = session();
    s.prompt(1);
    s.bash("first", 2);
    const prompts: Array<number | null> = [];
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({
      resolve: async () => ({ path: s.path, startedAt: null }),
      onChange: (_paneId, _running, _turnRunning, promptAt) => prompts.push(promptAt),
      now: () => NOW,
    });
    await status.refresh([pane]);
    s.notify("first", 3, command('x" completed (exit code 0)'));
    s.prompt(4);
    s.bash("second", 5);
    status.poll();
    expect(prompts).toEqual([Date.parse(at(1)), Date.parse(at(4))]);
  });
});

describe("claudeSubagents, before the files are read through", () => {
  const body = (id: string, minute: number, stop: string | null) => json({ type: "assistant", timestamp: at(minute), message: { id, model: "claude-haiku-4-5", stop_reason: stop, usage: { output_tokens: 7 }, content: [{ type: "text", text: "x" }], pad: "p".repeat(1000) } });
  const pastParentWindow = (path: string) => {
    // Many ordinary records, each below the line limit: the old notice is before the 16 MiB cold window.
    const filler = json({ type: "user", timestamp: at(5), message: { role: "user", content: "x".repeat(1024) } }).repeat(1024);
    for (let mib = 0; mib < 17; mib++) appendFileSync(path, filler);
  };

  it.each(["completed", "failed", "cancelled"])("keeps an old subagent command %s after its parent notice falls outside a cold window (#2601)", async (status) => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("suite", 2, { file });
    s.notify("suite", 3, { status, summary: "Background command finished", carriers: ["queue"] });
    const ended = { id: "suite", status, ended_at: at(3) };
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "suite")).toMatchObject(ended);
    pastParentWindow(s.path);
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "suite")).toMatchObject(ended);
    forgetSubagents();
    // Real workers use their own wall clock; keep their fixture inside the recent-task window.
    const shift = Date.now() - NOW;
    for (const path of [s.path, file]) writeFileSync(path, fs.readFileSync(path, "utf8").replace(/"timestamp":"([^"]+)"/g, (_match, timestamp: string) => `"timestamp":"${new Date(Date.parse(timestamp) + shift).toISOString()}"`));
    const recentEnd = { ...ended, ended_at: new Date(Date.parse(at(3)) + shift).toISOString() };
    expect((await scanClaudeTasks({ path: s.path, live: true, startedAt: null })).find((task) => task.id === "suite")).toMatchObject(recentEnd);
    expect((await scanClaudeTasks({ path: s.path, live: false, startedAt: null })).find((task) => task.id === "suite")).toMatchObject(recentEnd);
  });

  it("keeps a genuinely unfinished old subagent command after a cold parent window (#2601)", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("watch", 2, { file, command: "watch-tests" });
    const running = { id: "watch", status: "running", ended_at: null };
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "watch")).toMatchObject(running);
    pastParentWindow(s.path);
    forgetSubagents();
    const history = await waitCommandHistory(s.path, statSync(s.path).size);
    expect(wholeClaudeSubagents(s.path, true, NOW, null, Infinity, Date.now, history).find((task) => task.id === "watch")).toMatchObject(running);
  });

  it("does not count an ended subagent command after a cold parent window in pane status, and holds no queue for it (#2601)", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("suite", 2, { file });
    s.notify("suite", 3, { summary: "Background command finished", carriers: ["queue"] });
    s.notify("review", 4);
    expect(claudeSubagentState(s.path, true, NOW).running).toBe(0);
    pastParentWindow(s.path);
    forgetSubagents();
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({
      resolve: async () => ({ path: s.path, startedAt: Date.parse(at(0)) }),
      onChange: () => {},
      now: () => NOW,
    });
    try {
      await status.refresh([pane]);
      // a history still being read holds nothing: the pane is as it would be without it
      expect(status.holdsQueue("p1")).toBe(false);
      await waitCommandHistory(s.path, statSync(s.path).size);
      status.poll();
      expect(status.countOf("p1")).toBe(0);
      expect(status.holdsQueue("p1")).toBe(false);
    } finally { status.stop(); }
  });

  it("counts an ended command once its history is read despite a skipped record, holding no queue meanwhile", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("suite", 2, { file });
    s.notify("suite", 3, { summary: "Background command finished", carriers: ["queue"] });
    s.notify("review", 4);
    s.parent({ type: "progress", value: "x".repeat(2 * 1024 * 1024) });
    pastParentWindow(s.path);
    forgetSubagents();
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => NOW });
    try {
      await status.refresh([pane]);
      expect(status.holdsQueue("p1")).toBe(false);
      expect(await waitCommandHistory(s.path, statSync(s.path).size)).toMatchObject({ complete: true });
      status.poll();
      expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ historyPending: false, running: 0 });
      expect(status.holdsQueue("p1")).toBe(false);
    } finally { status.stop(); }
  });

  it("leaves a pane's queue and rest as without history when a still-running command's history has an unreadable record (#2069)", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("watch", 2, { file });
    s.parent({ type: "progress", value: "x".repeat(2 * 1024 * 1024) });
    appendFileSync(s.path, "not json\n");
    pastParentWindow(s.path);
    s.prompt(50);
    s.parent({ type: "assistant", timestamp: at(51), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } });
    s.parent({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: at(51) });
    forgetSubagents();
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "working", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => NOW });
    try {
      await status.refresh([pane]);
      expect(status.holdsQueue("p1")).toBe(false);
      expect(status.restsOn("p1")).toBe(true);
      expect(await waitCommandHistory(s.path, statSync(s.path).size)).toMatchObject({ complete: true, ends: [] });
      status.poll();
      // the command still runs: it is counted, and the session's own turn still rests
      expect(status.countOf("p1")).toBe(1);
      expect(status.holdsQueue("p1")).toBe(false);
      expect(status.restsOn("p1")).toBe(true);
    } finally { status.stop(); }
  });

  it("never ends a command with an end older than its launch: an id used again is a new command", async () => {
    const s = session();
    s.bash("bash_1", 1);
    s.notify("bash_1", 2, { summary: "Background command finished", carriers: ["queue"] });
    pastParentWindow(s.path);
    s.bash("bash_1", 50);
    forgetSubagents();
    const history = await waitCommandHistory(s.path, statSync(s.path).size);
    expect(history!.ends.map((end) => end.id)).toContain("bash_1");
    expect(wholeClaudeSubagents(s.path, true, NOW, null, Infinity, Date.now, history).find((task) => task.id === "bash_1")).toMatchObject({ status: "running", started_at: at(50), ended_at: null });
    // its own later end does end it
    s.notify("bash_1", 55, { summary: "Background command finished", carriers: ["queue"] });
    expect(wholeClaudeSubagents(s.path, true, NOW, null, Infinity, Date.now, history).find((task) => task.id === "bash_1")).toMatchObject({ status: "completed", started_at: at(50), ended_at: at(55) });
  });

  it("ends each use of a reused id at its own end inside the window", () => {
    const s = session();
    s.bash("bash_1", 1);
    s.notify("bash_1", 2, { summary: "Background command finished", carriers: ["queue"] });
    s.bash("bash_1", 10);
    expect(claudeSubagentState(s.path, true, NOW).tasks.find((task) => task.id === "bash_1")).toMatchObject({ status: "running", started_at: at(10), ended_at: null });
    s.notify("bash_1", 12, { status: "failed", summary: "Background command failed", carriers: ["queue"] });
    expect(claudeSubagentState(s.path, true, NOW).tasks.find((task) => task.id === "bash_1")).toMatchObject({ status: "failed", started_at: at(10), ended_at: at(12) });
  });

  it("takes no historical end from a row naming another session", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("same", 2, { file });
    s.bash("mine", 2, { file });
    const block = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>`;
    s.parent({ type: "queue-operation", operation: "enqueue", sessionId: "22222222-2222-4222-8222-222222222222", timestamp: at(3), content: block("same") });
    s.parent({ type: "queue-operation", operation: "enqueue", sessionId: "11111111-1111-4111-8111-111111111111", timestamp: at(3), content: block("mine") });
    pastParentWindow(s.path);
    forgetSubagents();
    const history = await waitCommandHistory(s.path, statSync(s.path).size);
    const tasks = wholeClaudeSubagents(s.path, true, NOW, null, Infinity, Date.now, history);
    expect(tasks.find((task) => task.id === "same")).toMatchObject({ status: "running" });
    expect(tasks.find((task) => task.id === "mine")).toMatchObject({ status: "completed", ended_at: at(3) });
  });

  it("takes no historical end back before the bytes it came from are checked again after a rewrite that grew the transcript", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("suite", 2, { file });
    const before = statSync(s.path).size;
    s.notify("suite", 3, { summary: "Background command finished", carriers: ["queue"] });
    const notice = fs.readFileSync(s.path).subarray(before);
    pastParentWindow(s.path);
    forgetSubagents();
    await waitCommandHistory(s.path, statSync(s.path).size);
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "suite")).toMatchObject({ status: "completed" });
    // the notice is rewritten in place (another command's, of the same length) and the transcript grows
    const rewritten = Buffer.from(notice.toString("utf8").replaceAll("suite", "other"));
    const fd = fs.openSync(s.path, "r+");
    fs.writeSync(fd, rewritten, 0, rewritten.length, before);
    fs.closeSync(fd);
    s.prompt(60);
    const state = claudeSubagentState(s.path, true, NOW);
    expect(state.tasks.find((task) => task.id === "suite")).toMatchObject({ status: "running", ended_at: null });
    expect(state.historyPending).toBe(true);
  });

  it("takes no end from history evidence handed over before a rewrite that grew the transcript", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("suite", 2, { file });
    const before = statSync(s.path).size;
    s.notify("suite", 3, { summary: "Background command finished", carriers: ["queue"] });
    const notice = fs.readFileSync(s.path).subarray(before);
    pastParentWindow(s.path);
    forgetSubagents();
    const history = await waitCommandHistory(s.path, statSync(s.path).size);
    expect(history!.ends.map((end) => end.id)).toEqual(["suite"]);
    // rewritten and grown after the evidence was read, before the task list's read takes it
    const rewritten = Buffer.from(notice.toString("utf8").replaceAll("suite", "other"));
    const fd = fs.openSync(s.path, "r+");
    fs.writeSync(fd, rewritten, 0, rewritten.length, before);
    fs.closeSync(fd);
    s.prompt(60);
    expect(wholeClaudeSubagents(s.path, true, NOW, null, Infinity, Date.now, history).find((task) => task.id === "suite")).toMatchObject({ status: "running", ended_at: null });
  });

  it("leaves a command running when an end in another transcript has its launch's very millisecond", () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("same", 2, { file });
    // an earlier use's notice, with no call to tie it to any launch
    s.parent({ type: "queue-operation", operation: "enqueue", timestamp: at(2), content: "<task-notification>\n<task-id>same</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>" });
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "same")).toMatchObject({ status: "running", ended_at: null });
    // its own call's notice in that millisecond ends it: the command finished at once
    s.notify("same", 2, { summary: "Background command finished", carriers: ["queue"] });
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "same")).toMatchObject({ status: "completed", ended_at: at(2) });
  });

  it("ends a command stopped in its launch's very millisecond, written after it in the same transcript", () => {
    const s = session();
    s.bash("same", 2);
    // TaskStop's answer names no Bash call: the transcript's order says it came after the launch
    s.parent({ type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_stop" }] }, toolUseResult: { task_id: "same", task_type: "local_bash" } });
    expect(wholeClaudeSubagents(s.path, true, NOW).find((task) => task.id === "same")).toMatchObject({ status: "cancelled", ended_at: at(2) });
  });

  it("never ends a launch with a historical end told of another call", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("same", 2, { file });
    s.notify("same", 3, { toolUseId: "toolu_earlier", summary: "Background command finished", carriers: ["queue"] });
    s.bash("mine", 2, { file });
    s.notify("mine", 3, { summary: "Background command finished", carriers: ["queue"] });
    pastParentWindow(s.path);
    forgetSubagents();
    const history = await waitCommandHistory(s.path, statSync(s.path).size);
    expect(history!.ends.map((end) => end.id)).toEqual(["same", "mine"]);
    const tasks = wholeClaudeSubagents(s.path, true, NOW, null, Infinity, Date.now, history);
    expect(tasks.find((task) => task.id === "same")).toMatchObject({ status: "running", ended_at: null });
    expect(tasks.find((task) => task.id === "mine")).toMatchObject({ status: "completed", ended_at: at(3) });
  });

  it("starts no history read for a watcher heard after the tracker stopped and the last server let go", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("watch", 2, { file });
    pastParentWindow(s.path);
    forgetSubagents();
    const hold = holdCommandHistory();
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => NOW });
    try {
      await status.refresh([pane]);
      expect(commandHistorySize().sessions).toBe(1);
      // a replaced transcript tells the tracker's watch, in a microtask still to run
      const copy = `${s.path}.copy`;
      fs.copyFileSync(s.path, copy);
      fs.renameSync(copy, s.path);
      commandHistory(s.path, statSync(s.path).size, false);
      status.stop();
      hold();
      expect(commandHistorySize()).toMatchObject({ sessions: 0, waiting: 0 });
      // a poll after the stop (a lookup answered late) reads nothing either
      status.poll();
      // every microtask queued so far has run once a macrotask comes round
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(commandHistorySize()).toMatchObject({ sessions: 0, waiting: 0, draining: false, timers: 0 });
    } finally { status.stop(); }
  });

  it("retries a history watch refused by cache capacity and then drains chunks without more polling", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("suite", 2, { file });
    const filler = json({ type: "progress", value: "x".repeat(1024) }).repeat(2048);
    appendFileSync(s.path, filler);
    s.notify("suite", 3, { summary: "Background command finished", carriers: ["queue"] });
    pastParentWindow(s.path);
    forgetSubagents();
    const owners: (() => void)[] = [];
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    let counted: (running: number) => void = () => {};
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (_pane, running) => counted(running), now: () => NOW });
    try {
      // Already-owned cursors fill the cache before the tracker first requests its history.
      for (let index = 0; index < 16; index++) {
        const path = join(dirname(s.path), `owned-${index}.jsonl`);
        writeFileSync(path, "{}\n");
        expect(commandHistory(path, 0, false)).not.toBeNull();
        const release = watchCommandHistory(path, () => {});
        expect(release).not.toBeNull();
        owners.push(release!);
      }
      await status.refresh([pane]);
      expect(commandHistorySize()).toMatchObject({ sessions: 16 });
      expect(commandHistory(s.path, statSync(s.path).size, false)).toBeNull();
      expect(watchCommandHistory(s.path, () => {})).toBeNull();
      expect(await waitCommandHistory(s.path, statSync(s.path).size, 20)).toBeNull();
      expect(status.countOf("p1")).toBe(1);
      const drained = new Promise<void>((resolve) => { counted = (running) => { if (running === 0) resolve(); }; });
      owners.shift()!();
      status.poll(); // Retry admission once; subsequent chunks must advance via the real watch.
      await drained;
      const history = commandHistory(s.path, statSync(s.path).size, false);
      expect(history!.through).toBeGreaterThan(2 * 1024 * 1024);
      expect(history!.ends.map((end) => end.id)).toContain("suite");
      expect(status.countOf("p1")).toBe(0);
    } finally { status.stop(); for (const release of owners) release(); }
  });

  it("releases a cold-window history wait after a partial final record is completed", async () => {
    const s = session();
    const file = s.agent("review", { steps: [[1, 1]] });
    s.bash("watch", 2, { file });
    pastParentWindow(s.path);
    const partial = '{"type":"progress","value":"unfinished';
    appendFileSync(s.path, partial);
    forgetSubagents();
    wholeClaudeSubagents(s.path, true, NOW);
    const boundary = statSync(s.path).size;
    // answered as soon as the read waits for the record, not at its deadline (the test's timeout)
    expect(await waitCommandHistory(s.path, boundary, 60_000)).toMatchObject({ complete: false, through: boundary - Buffer.byteLength(partial) });
    expect(claudeSubagentState(s.path, true, NOW).historyPending).toBe(true);
    appendFileSync(s.path, '"}\n');
    const history = await waitCommandHistory(s.path, boundary);
    expect(history).toMatchObject({ complete: true });
    const state = claudeSubagentState(s.path, true, NOW);
    expect(state.historyPending).toBe(false);
    expect(state.tasks.find((task) => task.id === "watch")).toMatchObject({ status: "running" });
  }, 5000);

  it("reads a whole list on through a transcript appended past what a call reads (#2511)", () => {
    const s = session();
    expect(wholeClaudeSubagents(s.path, true, NOW)).toEqual([]);
    // more than a call reads of the transcript (its 16 MiB window, in 8 MiB reads: at most 24 MiB), then a command sent to the background
    const filler = json({ type: "user", timestamp: at(1), message: { role: "user", content: "x".repeat(1024) } }).repeat(1024);
    for (let mib = 0; mib < 26; mib++) appendFileSync(s.path, filler);
    s.bash("cmd", 2);
    expect(wholeClaudeSubagents(s.path, true, NOW).map((task) => task.id)).toEqual(["cmd"]);
  });

  it("stops reading a whole list on once its time is up, and answers with what it read (#2511)", () => {
    const s = session();
    // two agents of 5.5 MB each: more than one call reads
    const big = json({ type: "user", timestamp: at(1), message: { role: "user", content: "go" } }) + Array.from({ length: 5000 }, (_, i) => body(`m${i}`, 2, null)).join("");
    for (const id of ["a", "b"]) writeFileSync(s.agent(id, { steps: [] }), big);
    // a clock already at the end of its time: one call's read, no more
    const cut = wholeClaudeSubagents(s.path, true, NOW, null, 1, () => 1);
    expect(cut.map((task) => task.id).sort()).toEqual(["a", "b"]);
    expect(cut.some((task) => task.turns === null)).toBe(true);
    forgetSubagents();
    expect(wholeClaudeSubagents(s.path, true, NOW).every((task) => task.turns !== null)).toBe(true);
  });

  it("tells the status of every agent on the first call, whatever the budget has reached", () => {
    const s = session();
    // eight idle teammates of 1.5 MB each and one agent at work: 13 MB, more than a call reads
    for (let n = 0; n < 8; n++) {
      const file = s.agent(`idle${n}`, { steps: [] });
      writeFileSync(file, json({ type: "user", timestamp: at(1), message: { role: "user", content: "go" } }) + Array.from({ length: 1500 }, (_, i) => body(`m${i}`, 2, null)).join("") + body("last", 3, "end_turn"));
    }
    const busy = s.agent("busy", { steps: [] });
    writeFileSync(busy, json({ type: "user", timestamp: at(1), message: { role: "user", content: "go" } }) + Array.from({ length: 1500 }, (_, i) => body(`b${i}`, 2, null)).join(""));
    const first = claudeSubagents(s.path, true, NOW);
    expect(first.filter((task) => task.status === "running").map((task) => task.id)).toEqual(["busy"]);
    expect(first).toHaveLength(9);
    // started at once; what it did only once it is counted through
    expect(first.every((task) => task.started_at === at(1))).toBe(true);
    expect(first.some((task) => task.turns === null)).toBe(true);
    expect(first.find((task) => task.id === "idle0")).toMatchObject({ status: "completed", ended_at: at(3) });
    for (let call = 0; call < 3; call++) claudeSubagents(s.path, true, NOW);
    const done = claudeSubagents(s.path, true, NOW);
    expect(done.every((task) => task.turns !== null)).toBe(true);
    expect(done.find((task) => task.id === "idle0")?.turns).toBe(1501);
    expect(done.filter((task) => task.status === "running")).toHaveLength(1);
  });

  it("leaves out an agent whose status cannot be told yet, rather than showing it running", () => {
    const s = session();
    const file = s.agent("long", { steps: [] });
    // one entry larger than the tail, and more file than a call reads
    writeFileSync(file, Array.from({ length: 9000 }, (_, i) => body(`m${i}`, 2, null)).join("") + body("last", 3, "end_turn").replace('"pad":"', `"pad":"${"p".repeat(200_000)}`));
    expect(ids(s.path)).toEqual([]);
    // read through, it ended
    for (let call = 0; call < 3; call++) ids(s.path);
    expect(ids(s.path)).toEqual(["long:completed"]);
  });
});

describe("claudeSubagents, a long-lived session's old history (#2510)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const age = (file: string, at: number) => utimesSync(file, at / 1000, at / 1000);
  const pane = { pane_id: "p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "hook", value: "s1" }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;

  it("checks an agent file last written over a day ago again only once a minute, and lists one written since then", () => {
    const s = session();
    const files = Array.from({ length: 50 }, (_, i) => s.agent(`old${i}`));
    for (const file of files) age(file, NOW - 2 * DAY);
    s.agent("new1");
    expect(ids(s.path)).toEqual(["new1:running"]);
    const stats = spyOn(fs, "lstatSync");
    try {
      // resumed, and one whose transcript comes after its meta file: neither is taken for old history
      s.work("old7", 50, 5);
      writeFileSync(join(dirname(files[0]!), "agent-late.meta.json"), JSON.stringify({ agentType: "reviewer", description: "task late" }));
      claudeSubagents(s.path, true, NOW + 1000);
      s.work("late", 51, 5);
      expect(claudeSubagents(s.path, true, NOW + 2000).map((task) => task.id)).toEqual(expect.arrayContaining(["late", "new1"]));
      expect(stats.mock.calls.filter(([path]) => basename(String(path)).startsWith("agent-old"))).toEqual([]);
      expect(claudeSubagents(s.path, true, NOW + 60_000).map((task) => `${task.id}:${task.status}`)).toContain("old7:running");
    } finally { stats.mockRestore(); }
  });

  it("lists a folder of any size reading at most MAX_NAMES of its names (#3348)", () => {
    const s = session();
    const dir = dirname(s.agent("a1"));
    for (let i = 0; i < 6000; i += 1) writeFileSync(join(dir, `junk-${i}`), "");
    const open = fs.opendirSync;
    let names = 0;
    const listed = spyOn(fs, "readdirSync");
    const opened = spyOn(fs, "opendirSync").mockImplementation((path, options) => {
      const folder = open(path, options);
      const next = folder.readSync.bind(folder);
      folder.readSync = () => { const entry = next(); if (entry !== null) names += 1; return entry; };
      return folder;
    });
    try {
      claudeSubagentState(s.path, true, NOW);
      expect(listed.mock.calls.filter(([path]) => String(path) === dir)).toEqual([]);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(names).toBe(5000);
    } finally { opened.mockRestore(); listed.mockRestore(); }
  });

  it("counts an old agent resumed while the session's transcript stays quiet, once its minute is up", async () => {
    const s = session();
    const old = s.agent("old1");
    s.agent("new1");
    // a clock past every write, so a poll that finds nothing changed reads nothing
    let clock = Date.now() + 5000;
    age(old, clock - 2 * DAY);
    const status = new ClaudeSubagentStatus({ resolve: () => Promise.resolve({ path: s.path, startedAt: null }), onChange: () => undefined, now: () => clock });
    await status.refresh([pane]);
    // the next pass finds the first read whole: what it read stands until an input changes
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    s.work("old1", 50, 5);
    age(old, clock - 1000);
    clock += 60_000;
    status.poll();
    expect(status.countOf("p1")).toBe(2);
  });

  it("counts a resumed old agent on every pane of the session, whichever pane rechecked it first", async () => {
    const s = session();
    const old = s.agent("old1");
    s.agent("new1");
    let clock = Date.now() + 5000;
    age(old, clock - 2 * DAY);
    const status = new ClaudeSubagentStatus({ resolve: () => Promise.resolve({ path: s.path, startedAt: null }), onChange: () => undefined, now: () => clock });
    const second = { ...pane, pane_id: "p2", agent_session: { ...pane.agent_session!, value: "s2" } } as HerdrPane;
    await status.refresh([pane, second]);
    status.poll();
    expect([status.countOf("p1"), status.countOf("p2")]).toEqual([1, 1]);
    s.work("old1", 50, 5);
    age(old, clock - 1000);
    clock += 60_000;
    // the first pane's recheck finds it; the second must not keep its certified answer
    status.poll("p1");
    status.poll("p2");
    expect([status.countOf("p1"), status.countOf("p2")]).toEqual([2, 2]);
  });
});
