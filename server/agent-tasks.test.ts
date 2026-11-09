import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTaskStatus, readTaskLine, taskCount, type SessionTasks, type TaskCount } from "./agent-tasks.ts";
import type { HerdrPane } from "../shared/protocol.ts";

const T0 = Date.parse("2026-11-09T04:00:00Z");
const iso = (minute: number): string => new Date(T0 + minute * 60_000).toISOString().replace(/\.000Z$/, "Z");
const SID = "8bdcc0e6-168b-4e00-9cd7-11e6fc25a662";
const agy = {
  prompt: (minute: number) => ({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: iso(minute), content: "<USER_REQUEST>deploy it</USER_REQUEST>" }),
  start: (task: number, minute: number, description = "gh run watch 1") => ({ step_index: task, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: iso(minute), content: `Created At: x\nTool is running as a background task with task id: ${SID}/task-${task}\nTask Description: ${description}` }),
  notice: (task: number, minute: number) => ({ step_index: 900 + task, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: iso(minute), content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(minute)} sender=${SID}/task-${task} priority=MESSAGE_PRIORITY_HIGH content=Task id "${SID}/task-${task}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>` }),
  checked: (task: number, minute: number, status: string) => ({ step_index: 800 + task, source: "MODEL", type: "GENERIC", status: "DONE", created_at: iso(minute), content: `Created At: x\nTask: ${SID}/task-${task}\nStatus: ${status}\nLog: file:///x` }),
};
const grok = {
  prompt: (minute: number, text = "deploy it") => ({ timestamp: (T0 + minute * 60_000) / 1000, method: "_x.ai/session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } } }),
  tasks: (minute: number, tasks: [string, string, number][]) => ({ timestamp: (T0 + minute * 60_000) / 1000, method: "_x.ai/session/update", params: { update: { sessionUpdate: "background_tasks", tasks: tasks.map(([task_id, status, started]) => ({ task_id, status, kind: "monitor", started_at: new Date(T0 + started * 60_000).toISOString() })) } } }),
};

function read(agent: "agy" | "grok", entries: unknown[]): SessionTasks {
  const state: SessionTasks = { tasks: new Map(), promptAt: null };
  for (const entry of entries) readTaskLine(agent, state, JSON.stringify(entry));
  return state;
}
const count = (running: number, turnRunning: number, promptAt: number | null, capped = true): TaskCount => ({ running, turnRunning, promptAt, capped });

describe("agy background tasks", () => {
  it("counts a task from its RUNNING step until its notice or a status check ends it, the turn's since the prompt", () => {
    const state = read("agy", [agy.start(3, 1), agy.prompt(2), agy.start(5, 3), agy.start(7, 4), agy.start(9, 5)]);
    expect(taskCount(state, null, T0 + 6 * 60_000)).toEqual(count(4, 3, T0 + 2 * 60_000));
    for (const entry of [agy.notice(5, 7), agy.checked(7, 8, "RUNNING")]) readTaskLine("agy", state, JSON.stringify(entry));
    expect(taskCount(state, null, T0 + 9 * 60_000)).toEqual(count(3, 2, T0 + 2 * 60_000));
    for (const entry of [agy.checked(7, 9, "DONE"), agy.checked(9, 9, "CANCELED")]) readTaskLine("agy", state, JSON.stringify(entry));
    expect(taskCount(state, null, T0 + 10 * 60_000)).toEqual(count(1, 0, T0 + 2 * 60_000));
  });

  it("holds a timer past the hold's limit until it is due, and drops a task its process did not start", () => {
    const state = read("agy", [agy.prompt(0), agy.start(3, 1, "Timer: 2h, Prompt: check the backup"), agy.start(4, 1, "Timer: 1h 30m 30s, Prompt: x")]);
    expect(taskCount(state, null, T0 + 60 * 60_000)).toEqual(count(2, 2, T0, false));
    // the shorter one's due time and grace have passed: it fired in a process that is gone
    expect(taskCount(state, null, T0 + 94 * 60_000)).toEqual(count(1, 1, T0, false));
    readTaskLine("agy", state, JSON.stringify(agy.start(5, 2)));
    expect(taskCount(state, null, T0 + 3 * 60_000).capped).toBe(true);
    // the pane's process started after all three
    expect(taskCount(state, T0 + 10 * 60_000, T0 + 11 * 60_000)).toEqual(count(0, 0, T0));
  });
});

describe("grok background tasks", () => {
  it("takes the newest task list for what runs, and a notice for no prompt", () => {
    const state = read("grok", [grok.tasks(1, [["old", "running", 1]]), grok.prompt(2), grok.tasks(3, [["old", "running", 1], ["watch", "running", 3]])]);
    expect(taskCount(state, null, T0 + 4 * 60_000)).toEqual(count(2, 1, T0 + 2 * 60_000));
    for (const entry of [grok.prompt(5, '<system-reminder> Monitor "watch" ended'), grok.tasks(5, [["old", "running", 1], ["watch", "completed", 3]])]) readTaskLine("grok", state, JSON.stringify(entry));
    expect(taskCount(state, null, T0 + 6 * 60_000)).toEqual(count(1, 0, T0 + 2 * 60_000));
  });
});

describe("AgentTaskStatus", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const pane = (agent: string | null): HerdrPane => ({ pane_id: "p1", agent } as HerdrPane);

  it("reads a session's file on from where it stopped, starts again on another session, and lets a pane go", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const files = [join(root, "a.jsonl"), join(root, "b.jsonl")];
    for (const file of files) writeFileSync(file, `${JSON.stringify(agy.prompt(0))}\n`);
    let path = files[0]!;
    const told: TaskCount[] = [];
    const resets: string[] = [];
    let now = T0 + 60_000;
    const status = new AgentTaskStatus({ resolve: async () => ({ path, started: null, owner: null }), onChange: (_, c) => told.push(c), onReset: (id) => resets.push(id), now: () => now });
    await status.track(pane("agy"));
    expect(told).toEqual([count(0, 0, T0)]);
    // half a line is read once it is whole
    const line = JSON.stringify(agy.start(3, 1));
    appendFileSync(files[0]!, line.slice(0, 40));
    status.poll();
    expect(told).toHaveLength(1);
    appendFileSync(files[0]!, `${line.slice(40)}\n`);
    status.poll();
    expect(told.at(-1)).toEqual(count(1, 1, T0));
    expect(status.countOf("p1")).toBe(1);
    // looked up again only once RESOLVE_MS passed: another session there now
    path = files[1]!;
    await status.track(pane("agy"));
    expect(resets).toEqual([]);
    now += 30_000;
    expect(status.stale("p1")).toBe(true);
    await status.track(pane("agy"));
    expect(resets).toEqual(["p1"]);
    expect(told.at(-1)).toEqual(count(0, 0, T0));
    appendFileSync(files[1]!, `${JSON.stringify(agy.start(4, 1))}\n`);
    status.poll("p1");
    expect(status.countOf("p1")).toBe(1);
    await status.refresh([pane("claude")]);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    expect(status.countOf("p1")).toBe(0);
  });

  it("keeps the wait of the same process whose start reads a little differently, and resets for another process", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1))}\n`);
    let owner = "1:boot:100", started = T0 - 5;
    const resets: string[] = [];
    let now = T0 + 60_000;
    const status = new AgentTaskStatus({ resolve: async () => ({ path, started, owner }), onChange: () => undefined, onReset: (id) => resets.push(id), now: () => now });
    await status.track(pane("agy"));
    // the process start is an upper bound read off the clock: a later read of the same process differs
    started = T0 - 2;
    now += 30_000;
    await status.track(pane("agy"));
    expect(resets).toEqual([]);
    expect(status.countOf("p1")).toBe(1);
    owner = "2:boot:200";
    now += 30_000;
    await status.track(pane("agy"));
    expect(resets).toEqual(["p1"]);
  });

  it("drops a lookup that finishes after the pane was let go", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1))}\n`);
    const lookup = Promise.withResolvers<{ path: string; started: null; owner: null }>();
    const told: TaskCount[] = [];
    const status = new AgentTaskStatus({ resolve: () => lookup.promise, onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => T0 + 60_000 });
    const tracking = status.track(pane("agy"));
    status.forget("p1");
    lookup.resolve({ path, started: null, owner: null });
    await tracking;
    expect(told).toEqual([]);
    expect(status.countOf("p1")).toBe(0);
    expect(status.stale("p1")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO in place of the session file without waiting for a writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "fifo.jsonl");
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const told: TaskCount[] = [];
    const status = new AgentTaskStatus({ resolve: async () => ({ path, started: null, owner: null }), onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => T0 });
    await status.track(pane("agy"));
    expect(told).toEqual([count(0, 0, null)]);
  });

  it("drops a gone process's tasks once the pane's process start can be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1))}\n`);
    let started: number | null = null;
    let now = T0 + 20 * 60_000;
    const status = new AgentTaskStatus({ resolve: async () => ({ path, started, owner: "1:boot:100" }), onChange: () => undefined, onReset: () => undefined, now: () => now });
    await status.track(pane("agy"));
    expect(status.countOf("p1")).toBe(1);
    started = T0 + 10 * 60_000;
    now += 30_000;
    await status.track(pane("agy"));
    status.poll();
    expect(status.countOf("p1")).toBe(0);
  });

  it("drops a pane's tasks and timers once its session cannot be looked up, and looks a timer's pane up again by itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1, "Timer: 2h, Prompt: x"))}\n`);
    let found: { path: string; started: null; owner: string } | null = { path, started: null, owner: "1:boot:100" };
    let lookups = 0;
    const told: TaskCount[] = [];
    let dropped = Promise.withResolvers<void>();
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({
      resolve: async () => { lookups += 1; return found; },
      onChange: (_, c) => { told.push(c); if (c.running === 0) dropped.resolve(); },
      onReset: () => undefined,
      now: () => now,
    });
    await status.track(pane("agy"));
    expect(told).toEqual([count(1, 1, T0, false)]);
    // the agy process is gone (or its session unreadable): its timer will not fire, so nothing of it is held
    found = null;
    now += 30_000;
    await status.track(pane("agy"));
    expect(told.at(-1)).toEqual(count(0, 0, null));
    expect(status.countOf("p1")).toBe(0);
    // a pane at rest on a timer gets no event that would look it up: the poll does, once its lookup is old
    found = { path, started: null, owner: "1:boot:100" };
    await status.track(pane("agy"));
    expect(status.countOf("p1")).toBe(1);
    dropped = Promise.withResolvers<void>();
    found = null;
    status.poll();
    expect(lookups).toBe(3);
    now += 30_000;
    status.poll();
    await dropped.promise;
    expect(lookups).toBe(4);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    expect(status.countOf("p1")).toBe(0);
  });
});

describe("agy timers", () => {
  it("takes a timer too long to be told as a command, held to the hold's limit", () => {
    const state = read("agy", [agy.prompt(0), agy.start(3, 1, `Timer: ${"9".repeat(400)}h, Prompt: x`)]);
    expect(taskCount(state, null, T0 + 2 * 60_000)).toEqual(count(1, 1, T0, true));
  });

  it("holds a timer due more than a day out as a command, to the hold's limit", () => {
    const state = read("agy", [agy.prompt(0), agy.start(3, 1, "Timer: 9999h, Prompt: x")]);
    expect(taskCount(state, null, T0 + 2 * 60_000)).toEqual(count(1, 1, T0, true));
    readTaskLine("agy", state, JSON.stringify(agy.start(4, 1, "Timer: 24h, Prompt: x")));
    expect(taskCount(state, null, T0 + 2 * 60_000)).toEqual(count(2, 2, T0, true));
    readTaskLine("agy", state, JSON.stringify(agy.notice(3, 2)));
    expect(taskCount(state, null, T0 + 3 * 60_000)).toEqual(count(1, 1, T0, false));
  });
});
