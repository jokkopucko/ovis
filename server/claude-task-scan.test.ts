import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanClaudeTasks } from "./claude-task-scan.ts";
import * as pool from "./file-pool.ts";
import type { FileTask, FileTaskResult } from "./file-tasks.ts";
import { errorResponse } from "./http.ts";
import { handleTasksRequest, type TaskTrackers } from "./tasks-routes.ts";

const roots: string[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  pool.setFilePoolOptions();
  await pool.fileThreadsClosed();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session() {
  const root = mkdtempSync(join(tmpdir(), "ovis-claude-task-scan-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  const dir = join(root, "session", "subagents");
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const json = (value: unknown) => `${JSON.stringify({ timestamp, ...(value as object) })}\n`;
  writeFileSync(path, json({ type: "user", message: { role: "user", content: "synthetic test prompt" } }));
  writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ description: "synthetic task", agentType: "reviewer", toolUseId: "toolu_a1" }));
  const agent = join(dir, "agent-a1.jsonl");
  writeFileSync(agent, json({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read" }] } }));
  return { path, agent, json };
}

/** Hold the real result on a file thread, without holding the test's event loop. */
function holdScans() {
  const cells = new Int32Array(new SharedArrayBuffer(8));
  cells[1] = -1;
  const release = () => { Atomics.store(cells, 0, 1); Atomics.notify(cells, 0); };
  releases.push(release);
  pool.setFilePoolOptions({ worker: new URL("./file-worker.fake.ts", import.meta.url), workers: 2, taskScans: 1, waiting: 2, longDeadlineMs: 10_000 });
  const run = pool.fileTask;
  const tasks: FileTask[] = [];
  const spy = spyOn(pool, "fileTask").mockImplementation(function<T extends FileTaskResult>(task: FileTask, signal?: AbortSignal, onRun?: () => void): Promise<T> {
    tasks.push(task);
    return run<T>(task.op === "claude-tasks" ? { ...task, gate: cells.buffer } as FileTask : task, signal, onRun);
  });
  releases.push(() => spy.mockRestore());
  return {
    tasks, release,
    async ran() {
      const deadline = Date.now() + 10_000;
      while (Atomics.load(cells, 1) === -1) {
        if (Date.now() > deadline) throw new Error("the held scan never reached its file thread");
        await Bun.sleep(10);
      }
    },
  };
}

const trackers = (read: () => ReturnType<TaskTrackers["claudeAgents"]["sessionOf"]>): TaskTrackers => ({
  omo: { sessionOf: () => null },
  claudeAgents: { sessionOf: read, ensure: async () => undefined },
  opencodeAgents: { sessionOf: () => null, ensure: () => false, beginRead: () => 0, tasksOf: async () => null },
});

const ask = (state: TaskTrackers) => {
  const request = new Request("http://localhost/api/pane/omo-tasks?pane_id=test-pane");
  return handleTasksRequest(request, new URL(request.url), "/api/pane/omo-tasks", state);
};

describe("Claude task-list scans", () => {
  it("reads real files on a worker and sees appends after an earlier result was delivered", async () => {
    const s = session();
    expect(await scanClaudeTasks({ path: s.path, live: true, startedAt: null })).toMatchObject([{ id: "a1", status: "running", title: "synthetic task" }]);
    appendFileSync(s.agent, s.json({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [] } }));
    expect(await scanClaudeTasks({ path: s.path, live: true, startedAt: null })).toMatchObject([{ id: "a1", status: "completed" }]);
    appendFileSync(s.agent, s.json({ type: "user", message: { role: "user", content: "synthetic resumed task" } }));
    expect(await scanClaudeTasks({ path: s.path, live: true, startedAt: null })).toMatchObject([{ id: "a1", status: "running" }]);
    expect(await scanClaudeTasks({ path: s.path, live: false, startedAt: null })).toMatchObject([{ id: "a1", status: "lost" }]);
  });

  it("shares overlapping task-list requests and serves unrelated HTTP while a worker is held", async () => {
    const s = session();
    const hold = holdScans();
    const state = trackers(() => ({ path: s.path, live: true, startedAt: null, read: 1 }));
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ ok: true });
        try { return await handleTasksRequest(request, url, url.pathname, state) ?? new Response(null, { status: 404 }); }
        catch (error) { return errorResponse(error); }
      },
    });
    try {
      let answered = 0;
      const first = fetch(`${server.url}api/pane/omo-tasks?pane_id=test-pane`).then((r) => { answered++; return r; });
      const second = fetch(`${server.url}api/pane/omo-tasks?pane_id=test-pane`).then((r) => { answered++; return r; });
      await hold.ran();
      const response = await fetch(`${server.url}health`, { signal: AbortSignal.timeout(2000) });
      expect(await response.json()).toEqual({ ok: true });
      expect(answered).toBe(0);
      expect(hold.tasks.filter((task) => task.op === "claude-tasks")).toHaveLength(1);
      hold.release();
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ tasks: [{ id: "a1", status: "running" }], runs: [] });
      }
    } finally { hold.release(); server.stop(true); }
  });

  it("cancels one waiter without cancelling another client sharing its scan", async () => {
    const s = session();
    const hold = holdScans();
    const abort = new AbortController();
    const first = scanClaudeTasks({ path: s.path, live: true, startedAt: null }, abort.signal);
    const rejected = first.catch((error: unknown) => error);
    const second = scanClaudeTasks({ path: s.path, live: true, startedAt: null });
    await hold.ran();
    abort.abort();
    expect(await rejected).toBeInstanceOf(pool.FileBusyError);
    hold.release();
    expect(await second).toMatchObject([{ id: "a1", status: "running" }]);
    expect(hold.tasks).toHaveLength(1);
    await expect(scanClaudeTasks({ path: s.path, live: true, startedAt: null }, AbortSignal.abort())).rejects.toBeInstanceOf(pool.FileBusyError);
    expect(hold.tasks).toHaveLength(1);
  });

  it("keeps a thread for other file routes while task-list scans occupy their scan allowance", async () => {
    const s = session();
    const other = session();
    const hold = holdScans();
    const first = scanClaudeTasks({ path: s.path, live: true, startedAt: null });
    await hold.ran();
    const second = scanClaudeTasks({ path: other.path, live: true, startedAt: null });
    expect(await pool.fileTask({ op: "info", path: s.path })).toMatchObject({ kind: "text" });
    expect(pool.filePoolSize()).toMatchObject({ threads: 2, waiting: 1 });
    hold.release();
    await Promise.all([first, second]);
  });

  it("starts a fresh scan when a new client arrives after the last waiter cancelled", async () => {
    const s = session();
    const hold = holdScans();
    const abort = new AbortController();
    const first = scanClaudeTasks({ path: s.path, live: true, startedAt: null }, abort.signal);
    const rejected = first.catch((error: unknown) => error);
    await hold.ran();
    abort.abort();
    const second = scanClaudeTasks({ path: s.path, live: true, startedAt: null });
    expect(await rejected).toBeInstanceOf(pool.FileBusyError);
    expect(hold.tasks).toHaveLength(2);
    hold.release();
    expect(await second).toMatchObject([{ id: "a1", status: "running" }]);
  });

  it("removes the initial queued file scan when its last client cancels", async () => {
    const s = session();
    pool.setFilePoolOptions({ workers: 0, waiting: 2 });
    const abort = new AbortController();
    const first = scanClaudeTasks({ path: s.path, live: true, startedAt: null }, abort.signal);
    const rejected = first.catch((error: unknown) => error);
    expect(pool.filePoolSize().waiting).toBe(1);
    abort.abort();
    expect(await rejected).toBeInstanceOf(pool.FileBusyError);
    expect(pool.filePoolSize().waiting).toBe(0);
  });

  it("refuses a scan when the pool is full and retries fresh once capacity returns", async () => {
    const s = session();
    pool.setFilePoolOptions({ workers: 0, waiting: 0 });
    await expect(scanClaudeTasks({ path: s.path, live: true, startedAt: null })).rejects.toBeInstanceOf(pool.FileBusyError);
    pool.setFilePoolOptions();
    expect(await scanClaudeTasks({ path: s.path, live: true, startedAt: null })).toMatchObject([{ id: "a1", status: "running" }]);
  });

  it("follows a pane that stops running Claude while its list is being read", async () => {
    const s = session();
    const hold = holdScans();
    let live = true;
    const response = ask(trackers(() => ({ path: s.path, live, startedAt: null, read: 1 })));
    await hold.ran();
    live = false;
    hold.release();
    expect(await (await response)!.json()).toMatchObject({ tasks: [{ id: "a1", status: "lost" }] });
    expect(hold.tasks).toHaveLength(2);
  });

  it("gives OpenCode priority if the pane changes agent during its Claude task-list read", async () => {
    const s = session();
    const hold = holdScans();
    const state = trackers(() => ({ path: s.path, live: true, startedAt: null, read: 1 }));
    const next = { path: "synthetic-opencode-store", session: "next", live: true };
    let codeNow = false;
    let codeReads = 0;
    state.opencodeAgents.sessionOf = () => codeNow ? next : null;
    state.opencodeAgents.tasksOf = async () => { codeReads++; return { tasks: [], unlisted: 0, read: next }; };
    const response = ask(state);
    await hold.ran();
    codeNow = true;
    hold.release();
    expect(await (await response)!.json()).toMatchObject({ tasks: [] });
    expect(codeReads).toBe(1);
  });

  it("discards a task-list result after its pane closes", async () => {
    const s = session();
    const hold = holdScans();
    let closed = false;
    const response = ask(trackers(() => closed ? null : { path: s.path, live: true, startedAt: null, read: 1 }));
    await hold.ran();
    closed = true;
    hold.release();
    expect(await (await response)!.json()).toMatchObject({ tasks: [], runs: [] });
  });

  it("does not return another agent session's list when the pane moves during a scan", async () => {
    const old = session();
    const current = session();
    const hold = holdScans();
    let read = { path: old.path, live: true, startedAt: null, read: 1 };
    const response = ask(trackers(() => read));
    await hold.ran();
    read = { path: current.path, live: true, startedAt: null, read: 2 };
    hold.release();
    expect(await (await response)!.json()).toMatchObject({ tasks: [{ id: "a1", status: "running" }] });
    expect(hold.tasks.filter((task) => task.op === "claude-tasks").map((task) => "path" in task ? task.path : null)).toEqual([old.path, current.path]);
  });

  it("retries a replaced lifetime even when its path, live flag and process start are identical", async () => {
    const s = session();
    const hold = holdScans();
    let read = 1;
    const response = ask(trackers(() => ({ path: s.path, live: true, startedAt: null, read })));
    await hold.ran();
    read++;
    hold.release();
    expect((await response)!.status).toBe(200);
    expect(hold.tasks).toHaveLength(2);
  });

  it("does not share an older lifetime's in-flight answer with a new request after replacement", async () => {
    const s = session();
    const hold = holdScans();
    let read = 1;
    const state = trackers(() => ({ path: s.path, live: true, startedAt: null, read }));
    const first = ask(state);
    await hold.ran();
    appendFileSync(s.agent, s.json({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [] } }));
    read++;
    const second = ask(state);
    expect(hold.tasks).toHaveLength(2);
    hold.release();
    for (const response of await Promise.all([first, second])) {
      expect(await response!.json()).toMatchObject({ tasks: [{ id: "a1", status: "completed" }] });
    }
    expect(hold.tasks).toHaveLength(2);
  });

  it("bounds retries for a pane whose lifetime keeps changing", async () => {
    const s = session();
    let read = 0;
    const response = await ask(trackers(() => ({ path: s.path, live: true, startedAt: null, read: ++read })));
    expect(await response!.json()).toMatchObject({ tasks: [], runs: [] });
  });
});
