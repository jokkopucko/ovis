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
    expect(taskCount(state, null, T0 + 94 * 60_000)).toEqual(count(1, 1, T0, false));
    readTaskLine("agy", state, JSON.stringify(agy.start(5, 2)));
    expect(taskCount(state, null, T0 + 3 * 60_000).capped).toBe(true);
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
  function lookups(status: AgentTaskStatus): () => Promise<void> {
    const begun: Promise<void>[] = [];
    const track = status.track.bind(status);
    status.track = (...args: Parameters<AgentTaskStatus["track"]>) => { const done = track(...args); begun.push(done); return done; };
    return async () => { await Promise.all(begun.splice(0)); };
  }

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
    const line = JSON.stringify(agy.start(3, 1));
    appendFileSync(files[0]!, line.slice(0, 40));
    status.poll();
    expect(told).toHaveLength(1);
    appendFileSync(files[0]!, `${line.slice(40)}\n`);
    status.poll();
    expect(told.at(-1)).toEqual(count(1, 1, T0));
    expect(status.countOf("p1")).toBe(1);
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

  it("drops a timer's pane once its session cannot be looked up twice in a row, looking it up again by itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1, "Timer: 2h, Prompt: x"))}\n`);
    const live = { path, started: null, owner: "1:boot:100" };
    let found: typeof live | null = live;
    let asked = 0;
    const told: TaskCount[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async () => { asked += 1; return found; }, onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => now });
    const looked = lookups(status);
    await status.track(pane("agy"));
    expect(told).toEqual([count(1, 1, T0, false)]);
    found = null;
    now += 29_999;
    status.poll();
    expect(asked).toBe(1);
    now += 1;
    status.poll();
    await looked();
    expect(asked).toBe(2);
    expect(told).toHaveLength(1);
    expect(status.countOf("p1")).toBe(1);
    now += 9_999;
    status.poll();
    await looked();
    expect(asked).toBe(2);
    now += 1;
    status.poll();
    await looked();
    expect(asked).toBe(3);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    expect(status.countOf("p1")).toBe(0);
    found = live;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(3);
    now += 10_000;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(4);
    expect(told.at(-1)).toEqual(count(1, 1, T0, false));
  });

  it("keeps what a pane holds through one lookup that failed, and takes a miss after a good lookup for a first one", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1, "Timer: 2h, Prompt: x"))}\n`);
    const live = { path, started: null, owner: "1:boot:100" };
    let found: typeof live | null = live;
    let asked = 0;
    const told: TaskCount[] = [];
    const resets: string[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async () => { asked += 1; return found; }, onChange: (_, c) => told.push(c), onReset: (id) => resets.push(id), now: () => now });
    await status.track(pane("agy"));
    expect(told).toEqual([count(1, 1, T0, false)]);
    found = null;
    now += 30_000;
    await status.track(pane("agy"));
    expect(asked).toBe(2);
    expect(told).toHaveLength(1);
    expect(status.countOf("p1")).toBe(1);
    expect(status.stale("p1")).toBe(false);
    await status.track(pane("agy"));
    await status.refresh([pane("agy")]);
    status.poll();
    expect(asked).toBe(2);
    found = live;
    now += 10_000;
    expect(status.stale("p1")).toBe(true);
    await status.track(pane("agy"));
    expect(asked).toBe(3);
    found = null;
    now += 30_000;
    await status.track(pane("agy"));
    expect(asked).toBe(4);
    expect(told).toHaveLength(1);
    expect(resets).toEqual([]);
    expect(status.countOf("p1")).toBe(1);
  });

  it("asks for a session that was not found only each ten seconds over the snapshots, and at once for a status of the pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1))}\n`);
    let found: { path: string; started: null; owner: null } | null = null;
    let asked = 0;
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async () => { asked += 1; return found; }, onChange: () => undefined, onReset: () => undefined, now: () => now });
    await status.refresh([pane("agy")]);
    expect(asked).toBe(1);
    await status.refresh([pane("agy")]);
    now += 9_999;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(1);
    now += 1;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    found = { path, started: null, owner: null };
    expect(status.stale("p1")).toBe(true);
    await status.track(pane("agy"));
    expect(asked).toBe(3);
    expect(status.countOf("p1")).toBe(1);
  });

  it("asks again by itself for a pane whose lookup failed, whatever it holds", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "updates.jsonl");
    writeFileSync(path, `${JSON.stringify(grok.prompt(0))}\n${JSON.stringify(grok.tasks(1, [["watch", "running", 1]]))}\n`);
    const session = (value: string): HerdrPane => ({ ...pane("grok"), agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value } } as HerdrPane);
    const live = { path, started: null, owner: null };
    let found: typeof live | null = live;
    const asked: (string | undefined)[] = [];
    const told: TaskCount[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async (looked) => { asked.push(looked.agent_session?.value); return found; }, onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => now });
    const looked = lookups(status);
    await status.track(session("one"));
    expect(told).toEqual([count(1, 1, T0)]);
    found = null;
    now += 30_000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one", "one"]);
    expect(status.countOf("p1")).toBe(1);
    now += 9_999;
    status.poll();
    await looked();
    expect(asked).toHaveLength(2);
    found = live;
    now += 1;
    status.poll();
    await looked();
    expect(asked).toEqual(["one", "one", "one"]);
    now += 19 * 60_000;
    status.poll();
    await looked();
    expect(asked).toHaveLength(3);
    found = null;
    await status.refresh([session("one")]);
    expect(asked).toHaveLength(4);
    expect(told).toHaveLength(1);
    now += 10_000;
    status.poll();
    await looked();
    expect(asked).toHaveLength(5);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    expect(status.countOf("p1")).toBe(0);
  });

  it("takes the grok session herdr reports next at once: what the pane held was the session before's", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const file = (name: string, tasks: [string, string, number][]) => {
      const path = join(root, name);
      writeFileSync(path, `${JSON.stringify(grok.prompt(0))}\n${JSON.stringify(grok.tasks(1, tasks))}\n`);
      return { path, started: null, owner: null };
    };
    const session = (value: string): HerdrPane => ({ ...pane("grok"), agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value } } as HerdrPane);
    // each session's file is found by its id, as Grok keeps the files of earlier sessions open
    const stores: Record<string, { path: string; started: null; owner: null } | null> = { one: file("one.jsonl", [["watch", "running", 1]]), two: file("two.jsonl", [["build", "running", 1], ["serve", "running", 1]]) };
    let busy = false;
    const asked: (string | undefined)[] = [];
    const told: TaskCount[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async (looked) => { asked.push(looked.agent_session?.value); return busy ? null : stores[looked.agent_session?.value ?? ""] ?? null; }, onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => now });
    const looked = lookups(status);
    await status.track(session("one"));
    expect(status.countOf("p1")).toBe(1);
    busy = true;
    now += 30_000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one", "one"]);
    expect(status.countOf("p1")).toBe(1);
    busy = false;
    now += 1000;
    await status.refresh([session("two")]);
    expect(asked).toEqual(["one", "one", "two"]);
    expect(status.countOf("p1")).toBe(2);
    now += 10_000;
    status.poll();
    await looked();
    expect(asked).toHaveLength(3);
    now += 1000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one", "one", "two", "one"]);
    expect(status.countOf("p1")).toBe(1);
    busy = true;
    now += 1000;
    await status.refresh([session("two")]);
    expect(asked).toHaveLength(5);
    expect(status.countOf("p1")).toBe(0);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    await status.refresh([session("two")]);
    expect(asked).toHaveLength(5);
  });

  it("keeps what a grok pane holds when herdr names no session for it, and asks by the session known", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "one.jsonl");
    writeFileSync(path, `${JSON.stringify(grok.prompt(0))}\n${JSON.stringify(grok.tasks(1, [["watch", "running", 1]]))}\n`);
    const session = (value: string): HerdrPane => ({ ...pane("grok"), agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value } } as HerdrPane);
    let busy = false;
    const asked: string[] = [];
    const told: TaskCount[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async (looked) => { asked.push(looked.agent_session?.value ?? "none"); return !busy && looked.agent_session?.value === "one" ? { path, started: null, owner: null } : null; }, onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => now });
    const looked = lookups(status);
    await status.track(session("one"));
    expect(told).toEqual([count(1, 1, T0)]);
    now += 1000;
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["one"]);
    expect(status.countOf("p1")).toBe(1);
    now += 1000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one"]);
    now += 28_000;
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["one", "one"]);
    busy = true;
    now += 30_000;
    await status.refresh([pane("grok")]);
    expect(asked).toHaveLength(3);
    expect(status.countOf("p1")).toBe(1);
    now += 1000;
    await status.refresh([session("one")]);
    await status.refresh([pane("grok")]);
    expect(asked).toHaveLength(3);
    busy = false;
    now += 9000;
    status.poll();
    await looked();
    expect(asked).toEqual(["one", "one", "one", "one"]);
    expect(status.countOf("p1")).toBe(1);
    expect(told).toHaveLength(1);
    busy = true;
    now += 30_000;
    await status.refresh([pane("grok")]);
    now += 10_000;
    await status.refresh([pane("grok")]);
    expect(asked).toHaveLength(6);
    expect(status.countOf("p1")).toBe(0);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    busy = false;
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["one", "one", "one", "one", "one", "one", "none"]);
    expect(status.countOf("p1")).toBe(0);
  });

  it("asks for a grok pane herdr names no session for as reported, when the session known is another agent's or the pane is let go meanwhile", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const file = (name: string, lines: unknown[]) => {
      const path = join(root, name);
      writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      return { path, started: null, owner: null };
    };
    const stores = { agy: file("agy.jsonl", [agy.prompt(0), agy.start(3, 1)]), grok: file("grok.jsonl", [grok.prompt(0), grok.tasks(1, [["build", "running", 1], ["serve", "running", 1]])]) };
    const session = (agent: "agy" | "grok", value: string): HerdrPane => ({ ...pane(agent), agent_session: { agent, kind: "id", source: `herdr:${agent}`, value } } as HerdrPane);
    let lookup = async (looked: HerdrPane): Promise<typeof stores.agy | null> => looked.agent === "agy" ? stores.agy : looked.agent_session?.value === "one" ? stores.grok : null;
    const found = lookup;
    const asked: string[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: (looked) => { asked.push(`${looked.agent}:${looked.agent_session?.value ?? "none"}`); return lookup(looked); }, onChange: () => undefined, onReset: () => undefined, now: () => now });
    await status.track(session("agy", "a"));
    expect(status.countOf("p1")).toBe(1);
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["agy:a", "grok:none"]);
    expect(status.countOf("p1")).toBe(0);
    await status.refresh([session("grok", "one")]);
    expect(status.countOf("p1")).toBe(2);
    lookup = async () => null;
    now += 30_000;
    await status.refresh([session("grok", "one")]);
    expect(asked).toEqual(["agy:a", "grok:none", "grok:one", "grok:one"]);
    expect(status.countOf("p1")).toBe(2);
    now += 10_000;
    const second = Promise.withResolvers<null>();
    lookup = () => second.promise;
    const snapshot = status.refresh([session("grok", "one")]);
    lookup = found;
    await status.track(pane("grok"));
    expect(asked).toHaveLength(5);
    second.resolve(null);
    await snapshot;
    expect(asked).toEqual(["agy:a", "grok:none", "grok:one", "grok:one", "grok:one", "grok:none"]);
    expect(status.countOf("p1")).toBe(0);
  });

  it("remembers a grok miss with the session it was of: it holds no lookup of another session off", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "two.jsonl");
    writeFileSync(path, `${JSON.stringify(grok.prompt(0))}\n${JSON.stringify(grok.tasks(1, [["build", "running", 1], ["serve", "running", 1]]))}\n`);
    const session = (agent: "agy" | "grok", value: string, paneId = "p1"): HerdrPane => ({ pane_id: paneId, agent, agent_session: { agent, kind: "id", source: `herdr:${agent}`, value } } as HerdrPane);
    const asked: string[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async (looked) => { asked.push(`${looked.agent}:${looked.agent_session?.value ?? "none"}`); return looked.agent_session?.value === "two" ? { path, started: null, owner: null } : null; }, onChange: () => undefined, onReset: () => undefined, now: () => now });
    await status.refresh([pane("grok")]);
    now += 1000;
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["grok:none"]);
    await status.refresh([session("grok", "one")]);
    expect(asked).toEqual(["grok:none", "grok:one"]);
    now += 1000;
    await status.refresh([session("grok", "one")]);
    expect(asked).toHaveLength(2);
    await status.refresh([session("grok", "two")]);
    expect(asked).toEqual(["grok:none", "grok:one", "grok:two"]);
    expect(status.countOf("p1")).toBe(2);
    await status.refresh([session("grok", "two"), session("agy", "a", "p2")]);
    now += 1000;
    await status.refresh([session("grok", "two"), session("agy", "b", "p2")]);
    expect(asked).toEqual(["grok:none", "grok:one", "grok:two", "agy:a"]);
    now += 9000;
    await status.refresh([session("grok", "two"), session("agy", "b", "p2")]);
    expect(asked).toEqual(["grok:none", "grok:one", "grok:two", "agy:a", "agy:b"]);
  });

  it("keeps each session's miss beside the others': herdr naming one, then none or another, in turn asks for each only every ten seconds", async () => {
    const session = (value: string): HerdrPane => ({ ...pane("grok"), agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value } } as HerdrPane);
    const asked: string[] = [];
    let now = T0;
    const status = new AgentTaskStatus({ resolve: async (looked) => { asked.push(looked.agent_session?.value ?? "none"); return null; }, onChange: () => undefined, onReset: () => undefined, now: () => now });
    for (let snapshot = 0; snapshot < 10; snapshot += 1) {
      await status.refresh([snapshot % 2 === 0 ? session("one") : pane("grok")]);
      now += 1000;
    }
    expect(asked).toEqual(["one", "none"]);
    await status.refresh([session("one")]);
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["one", "none", "one"]);
    now += 1000;
    await status.refresh([pane("grok")]);
    expect(asked).toEqual(["one", "none", "one", "none"]);
    for (let snapshot = 0; snapshot < 9; snapshot += 1) {
      await status.refresh([session(snapshot % 2 === 0 ? "two" : "one")]);
      now += 1000;
    }
    expect(asked).toEqual(["one", "none", "one", "none", "two"]);
    await status.refresh([session("one")]);
    await status.refresh([session("two")]);
    expect(asked).toEqual(["one", "none", "one", "none", "two", "one"]);
    now += 1000;
    await status.refresh([session("two")]);
    expect(asked).toEqual(["one", "none", "one", "none", "two", "one", "two"]);
  });

  it("starts the spacing over once a lookup finds a session: one that is found and one that is not, named in turn, are asked for at every snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "one.jsonl");
    writeFileSync(path, `${JSON.stringify(grok.prompt(0))}\n${JSON.stringify(grok.tasks(1, [["watch", "running", 1]]))}\n`);
    const session = (value: string): HerdrPane => ({ ...pane("grok"), agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value } } as HerdrPane);
    const asked: string[] = [];
    const told: number[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async (looked) => { asked.push(looked.agent_session?.value ?? "none"); return looked.agent_session?.value === "one" ? { path, started: null, owner: null } : null; }, onChange: (_, c) => told.push(c.running), onReset: () => undefined, now: () => now });
    for (let snapshot = 0; snapshot < 10; snapshot += 1) {
      await status.refresh([session(snapshot % 2 === 0 ? "one" : "two")]);
      now += 1000;
    }
    expect(asked).toEqual(["one", "two", "one", "two", "one", "two", "one", "two", "one", "two"]);
    expect(told).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    for (let snapshot = 0; snapshot < 9; snapshot += 1) {
      await status.refresh([session("two")]);
      now += 1000;
    }
    expect(asked).toHaveLength(10);
    await status.refresh([session("two")]);
    expect(asked).toHaveLength(11);
    expect(told).toHaveLength(10);
  });

  it("lets a pane go at once when the lookup that failed is another agent's there", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1))}\n`);
    let found: { path: string; started: null; owner: null } | null = { path, started: null, owner: null };
    let asked = 0;
    const told: TaskCount[] = [];
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: async () => { asked += 1; return found; }, onChange: (_, c) => told.push(c), onReset: () => undefined, now: () => now });
    await status.track(pane("agy"));
    found = null;
    now += 30_000;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    expect(status.countOf("p1")).toBe(1);
    await status.refresh([pane("grok")]);
    expect(asked).toBe(3);
    expect(status.countOf("p1")).toBe(0);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    await status.refresh([pane("grok")]);
    expect(asked).toBe(3);
    now += 10_000;
    await status.refresh([pane("grok")]);
    expect(asked).toBe(4);
  });

  it("gives a status that asked during a lookup that failed one of its own, and holds no snapshot off for a status's lookup of a pane with no session", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
    roots.push(root);
    const path = join(root, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(agy.prompt(0))}\n${JSON.stringify(agy.start(3, 1))}\n`);
    const live = { path, started: null, owner: null };
    let lookup: () => Promise<typeof live | null> = async () => null;
    let asked = 0;
    let now = T0 + 2 * 60_000;
    const status = new AgentTaskStatus({ resolve: () => { asked += 1; return lookup(); }, onChange: () => undefined, onReset: () => undefined, now: () => now });
    await status.track(pane("agy"));
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    now += 10_000;
    const first = Promise.withResolvers<null>();
    lookup = () => first.promise;
    const snapshot = status.refresh([pane("agy")]);
    lookup = async () => live;
    await status.track(pane("agy"));
    expect(asked).toBe(3);
    first.resolve(null);
    await snapshot;
    expect(asked).toBe(4);
    expect(status.countOf("p1")).toBe(1);
    now += 30_000;
    const second = Promise.withResolvers<null>();
    lookup = () => second.promise;
    const later = status.refresh([pane("agy")]);
    lookup = async () => null;
    await status.track(pane("agy"));
    second.resolve(null);
    await later;
    expect(asked).toBe(5);
    expect(status.countOf("p1")).toBe(1);
  });

  it("forgets a lookup that failed once the pane ended or runs another agent", async () => {
    let asked = 0;
    const status = new AgentTaskStatus({ resolve: async () => { asked += 1; return null; }, onChange: () => undefined, onReset: () => undefined, now: () => T0 });
    await status.refresh([pane("agy")]);
    await status.refresh([pane("agy")]);
    expect(asked).toBe(1);
    await status.refresh([pane("grok")]);
    expect(asked).toBe(2);
    await status.refresh([pane("claude")]);
    await status.refresh([pane("grok")]);
    expect(asked).toBe(3);
    status.forget("p1");
    await status.refresh([pane("grok")]);
    expect(asked).toBe(4);
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
