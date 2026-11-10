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
  /** Waits for the lookups begun since it was last called: a poll does not wait for the one it begins. */
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
    // the agy process is gone (or its session unreadable): its timer will not fire. A pane at rest on a
    // timer gets no event that would look it up: the poll does, once its lookup is old
    found = null;
    now += 29_999;
    status.poll();
    expect(asked).toBe(1);
    now += 1;
    status.poll();
    await looked();
    expect(asked).toBe(2);
    // one lookup that failed drops nothing, and the polls that follow do not ask again at once
    expect(told).toHaveLength(1);
    expect(status.countOf("p1")).toBe(1);
    now += 9_999;
    status.poll();
    await looked();
    expect(asked).toBe(2);
    // the next one fails too, 40 s after the last that found it: nothing of the pane is held
    now += 1;
    status.poll();
    await looked();
    expect(asked).toBe(3);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    expect(status.countOf("p1")).toBe(0);
    // let go, the pane is asked for again as any whose session was not found, and held again once it is
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
    // herdr was busy, or a process read timed out: the timer's process still runs, and its hold stands
    found = null;
    now += 30_000;
    await status.track(pane("agy"));
    expect(asked).toBe(2);
    expect(told).toHaveLength(1);
    expect(status.countOf("p1")).toBe(1);
    // nobody asks again for ten seconds: a second failure in the same moment would tolerate nothing
    expect(status.stale("p1")).toBe(false);
    await status.track(pane("agy"));
    await status.refresh([pane("agy")]);
    status.poll();
    expect(asked).toBe(2);
    // found again as the same session: nothing was dropped or reset, and the miss is forgotten
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
    // every snapshot comes here, and each lookup is a herdr call and process reads
    await status.refresh([pane("agy")]);
    now += 9_999;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(1);
    now += 1;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    // a turn that ends within those ten seconds is held on its task only once its session is known:
    // the status that ends it looks the pane up now (server/core/status.ts)
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
    // a command is held to the hold's limit, so the poll does not look its pane up: a snapshot does
    found = null;
    now += 30_000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one", "one"]);
    expect(status.countOf("p1")).toBe(1);
    // no snapshot or status may follow for a while, and the miss is not left to wait for one
    now += 9_999;
    status.poll();
    await looked();
    expect(asked).toHaveLength(2);
    found = live;
    now += 1;
    status.poll();
    await looked();
    expect(asked).toEqual(["one", "one", "one"]);
    // found, the miss is forgotten and the poll leaves the pane to the snapshots again
    now += 19 * 60_000;
    status.poll();
    await looked();
    expect(asked).toHaveLength(3);
    // so a failure long after is a first one, and only the one the poll asks next lets the pane go
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
    // one lookup of that session fails, herdr being busy: its count stands
    busy = true;
    now += 30_000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one", "one"]);
    expect(status.countOf("p1")).toBe(1);
    // a second later herdr reports another session there: it is looked up now, inside the miss's
    // interval, and by its own id, not held off nor asked for by the id before
    busy = false;
    now += 1000;
    await status.refresh([session("two")]);
    expect(asked).toEqual(["one", "one", "two"]);
    expect(status.countOf("p1")).toBe(2);
    // nor does the poll ask for the session before any more
    now += 10_000;
    status.poll();
    await looked();
    expect(asked).toHaveLength(3);
    // with no miss before it either: the session known is not kept for RESOLVE_MS against herdr's newer word
    now += 1000;
    await status.refresh([session("one")]);
    expect(asked).toEqual(["one", "one", "two", "one"]);
    expect(status.countOf("p1")).toBe(1);
    // and a lookup of the newer session that fails lets the one before's count go at once: it is not that session's
    busy = true;
    now += 1000;
    await status.refresh([session("two")]);
    expect(asked).toHaveLength(5);
    expect(status.countOf("p1")).toBe(0);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    // then asked for as any session that was not found
    await status.refresh([session("two")]);
    expect(asked).toHaveLength(5);
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
    // one lookup of agy's session failed: its count stands
    found = null;
    now += 30_000;
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    expect(status.countOf("p1")).toBe(1);
    // grok runs there now, looked up at once: agy's count and hold are not grok's to keep through a miss
    await status.refresh([pane("grok")]);
    expect(asked).toBe(3);
    expect(status.countOf("p1")).toBe(0);
    expect(told.at(-1)).toEqual(count(0, 0, null));
    // and grok's session is asked for as any that was not found
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
    // a turn's end looked the pane up and did not find its session: the snapshot that follows asks all
    // the same, and only its own failure spaces the snapshots after it
    await status.track(pane("agy"));
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    await status.refresh([pane("agy")]);
    expect(asked).toBe(2);
    // a turn ends while a snapshot's lookup is under way, which then fails: the turn's end is not left
    // to the snapshots, ten seconds on, when its finish alert may be due
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
    // a pane that holds something is not asked for again in the same moment: that would be its second failure
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
    // grok there now is another session to find
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
