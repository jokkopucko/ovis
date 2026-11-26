import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { bridgeAgentNews, MachineManager, SOURCE_CHECK_INTERVAL_MS } from "./machines.ts";
import { privateStateFs } from "./private-state.ts";
import type { PushService } from "./push.ts";
import { REMOTE_LIMITS, RemoteResponseTooLarge } from "./remote-json.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("fixture did not reach the expected state");
}

function snapshot(agent_status = "working"): SessionSnapshot {
  return {
    protocol: 22, version: "fixture", workspaces: [], tabs: [], layouts: [], agents: [],
    panes: [{ pane_id: "fixture:p1", agent: "codex", agent_status, focused: false, revision: 1, tab_id: "fixture:t1", terminal_id: "fixture:terminal", workspace_id: "fixture" }],
  };
}

const OVER_SNAPSHOT_CAP = 96 * 1024 * 1024;
function padded(value: unknown, total: number): { stream: ReadableStream<Uint8Array>; cancelled: Promise<void> } {
  const json = JSON.stringify(value);
  const space = new Uint8Array(64 * 1024).fill(0x20);
  const cancelled = Promise.withResolvers<void>();
  let left = total - json.length;
  let opened = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!opened) { opened = true; controller.enqueue(new TextEncoder().encode(json.slice(0, 1))); return; }
      if (left > 0) { const size = Math.min(left, space.length); left -= size; controller.enqueue(space.slice(0, size)); return; }
      controller.enqueue(new TextEncoder().encode(json.slice(1)));
      controller.close();
    },
    cancel() { cancelled.resolve(); },
  });
  return { stream, cancelled: cancelled.promise };
}
async function within(event: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([event, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the oversized snapshot was not cancelled")), 5000); })]); }
  finally { clearTimeout(timer); }
}

function responses() {
  let current = snapshot();
  let hold = false;
  let calls = 0;
  const pending: (() => void)[] = [];
  let waited: (() => void) | null = null;
  return {
    read(): Promise<SessionSnapshot> {
      calls++;
      const captured = structuredClone(current);
      return new Promise((resolve) => { if (hold) { pending.push(() => resolve(captured)); waited?.(); } else resolve(captured); });
    },
    held: (): Promise<void> => pending.length > 0 ? Promise.resolve() : new Promise((resolve) => { waited = resolve; }),
    hold: () => { hold = true; },
    set: (next: SessionSnapshot) => { current = next; },
    calls: () => calls,
    waiting: () => pending.length,
    answer: () => pending.shift()!(),
    finish: () => { hold = false; while (pending.length) pending.shift()!(); },
  };
}

async function fixture(options: { bootId?: string; now?: () => number; serverId?: () => string | undefined; moveOfferMs?: { idle: number; active: number } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herdr-machine-refresh-"));
  const path = join(root, "herdr.sock");
  const local = responses();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      if (request.method === "pane.process_info") { socket.end(JSON.stringify({ id: request.id, result: { process_info: { foreground_processes: [] } } }) + "\n"); return; }
      if (request.method !== "session.snapshot") throw new Error(`unexpected fixture RPC: ${request.method}`);
      void local.read().then((captured) => socket.end(JSON.stringify({ id: request.id, result: { snapshot: captured } }) + "\n"));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
  const manager = new MachineManager(join(root, "state"), push, new CompletionTracker(null), undefined, options);
  cleanups.push(() => {
    manager.stop(); local.finish();
    for (const socket of sockets) socket.destroy();
    server.close();
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previousSocket;
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => manager.list()[0]?.state === "connected");
  const drive = manager as unknown as {
    localBusy: boolean;
    machines: Map<string, TestRuntime>;
    runtime(machine: Machine): TestRuntime;
    refresh(runtime: TestRuntime): Promise<void>;
    observe(runtime: TestRuntime): Promise<void>;
    disconnect(runtime: TestRuntime): void;
  };
  const rosters: string[] = [];
  const stopRecording = manager.subscribe((event) => {
    if (event.type === "machines") for (const machine of event.machines) {
      const status = machine.snapshot?.panes[0]?.agent_status;
      if (status) rosters.push(`${machine.id}:${status}`);
    }
  });
  return { manager, drive, local, rosters, stopRecording };
}

it("keeps internal machine listeners without counting them as roster viewers", async () => {
  const { manager, stopRecording } = await fixture();
  stopRecording();
  const heard: string[] = [];
  const unsubscribe = manager.subscribe((event) => { heard.push(event.type); }, { internal: true });
  expect(manager.rosterWatched).toBe(false);
  const stopWatching = manager.subscribe(() => {});
  expect(manager.rosterWatched).toBe(true);
  stopWatching();
  expect(manager.rosterWatched).toBe(false);
  manager.localMessage({ type: "session-changed" });
  expect(heard).toEqual(["machines", "machine-message"]);
  unsubscribe();
});

type TestRuntime = {
  machine: Machine;
  endpoint?: { url: string; token: string };
  ssh?: { close(): void; onExit?: () => void };
  generation: number;
  refreshing: boolean;
  refreshQueued: boolean;
  retry?: ReturnType<typeof setTimeout>;
};

async function remoteFixture(options: { bootId?: string; now?: () => number; serverId?: () => string | undefined; moveOfferMs?: { idle: number; active: number } } = {}) {
  const local = await fixture(options);
  let health: ((request: Request) => Response | Promise<Response>) | null = null;
  let move: (() => Response | Promise<Response>) | null = null;
  const remote = responses();
  let observer: { send(data: string): unknown } | undefined;
  let observing = false;
  let httpStatus = 200;
  let sshCloses = 0;
  let terminalCloses = 0;
  let answerNext: ((captured: SessionSnapshot) => Promise<Response>) | null = null;
  let observedNext: (() => void) | undefined;
  const bridge = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, server) {
      if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
      if (new URL(request.url).pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      if (health && new URL(request.url).pathname === "/api/health") return health(request);
      if (new URL(request.url).pathname === "/api/runtime/move") return move ? move() : Response.json({ error: { code: "not_found", message: "unknown endpoint /api/runtime/move" } }, { status: 404 });
      const status = httpStatus;
      const captured = await remote.read();
      const answer = answerNext;
      answerNext = null;
      return answer ? answer(captured) : Response.json({ snapshot: captured }, { status });
    },
    websocket: { open(ws) { observer = ws; }, message(_ws, data) { observing = JSON.parse(String(data)).mode === "observe"; if (observing) observedNext?.(); } },
  });
  cleanups.push(() => { remote.finish(); bridge.stop(true); });
  const runtime = local.drive.runtime({ id: "remote", name: "Fixture PC", kind: "ssh", enabled: true, state: "connecting", error: null, snapshot: null });
  runtime.endpoint = { url: `http://127.0.0.1:${bridge.port}`, token: "fixture-token" };
  runtime.ssh = { close() { sshCloses++; } };
  local.drive.machines.set(runtime.machine.id, runtime);
  await local.drive.observe(runtime);
  await until(() => observing);
  local.manager.trackTerminal(runtime.machine.id, () => { terminalCloses++; });
  return {
    ...local, remote, runtime, endpoint: runtime.endpoint,
    send: (message: ServerMessage) => observer!.send(JSON.stringify(message)),
    setHttpStatus: (status: number) => { httpStatus = status; },
    setHealth: (answer: typeof health) => { health = answer; },
    setMove: (answer: typeof move) => { move = answer; },
    answerNext: (answer: (captured: SessionSnapshot) => Promise<Response>) => { answerNext = answer; },
    observed: (): Promise<void> => new Promise((resolve) => { observedNext = resolve; }),
    sshCloses: () => sshCloses,
    terminalCloses: () => terminalCloses,
  };
}

it("records a remote bridge failure and a later recovery without its address or token", async () => {
  const f = await remoteFixture();
  f.runtime.machine.name = "private-machine-name";
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  cleanups.push(() => warn.mockRestore());
  const records = () => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((record) => record.event.startsWith("machine.remote."));
  const generation = f.runtime.generation;
  f.setHttpStatus(503);
  const failure = await f.drive.refresh(f.runtime).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  const drive = f.manager as unknown as { lost(runtime: TestRuntime, generation: number, error: unknown): void };
  drive.lost(f.runtime, generation, failure);
  drive.lost(f.runtime, generation, new Error("private-stale-error"));
  expect(records()).toHaveLength(1);
  expect(records()[0]).toMatchObject({ event: "machine.remote.failed", operation: "bridge", code: "connection_lost" });
  clearTimeout(f.runtime.retry);
  f.setHttpStatus(200);
  f.runtime.endpoint = f.endpoint;
  f.runtime.ssh = { close() {} };
  await f.drive.observe(f.runtime);
  await until(() => records().length === 2);
  expect(records()[1]).toMatchObject({ event: "machine.remote.recovered", episode_id: records()[0].episode_id });
  expect(lines.join("\n")).not.toContain("private-");
  expect(lines.join("\n")).not.toContain("fixture-token");
  expect(lines.join("\n")).not.toContain(f.endpoint.url);
});

describe("machine snapshot refresh races", () => {
  it("preserves newest snapshot on oversized stale refresh", async () => {
    const { manager, drive, rosters, remote, runtime, send, answerNext } = await remoteFixture();
    const asked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cancelled: Promise<void> | undefined;
    answerNext(async (captured) => {
      asked.resolve();
      await release.promise;
      const body = padded({ snapshot: captured }, OVER_SNAPSHOT_CAP);
      cancelled = body.cancelled;
      return new Response(body.stream);
    });
    const loading = drive.refresh(runtime);
    await asked.promise;
    remote.set(snapshot("blocked"));
    const streamed = new Promise<void>((resolve) => {
      const off = manager.subscribe((event) => {
        if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "pane-status") { queueMicrotask(off); resolve(); }
      });
    });
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await streamed;
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    rosters.length = 0;
    release.resolve();
    await loading;
    await within(cancelled!);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(runtime.machine.error).toBeNull();
    expect(rosters).not.toContain("remote:working");
    expect(remote.calls()).toBe(3);
  });

  it("fails an oversized current refresh without its address or token, then recovers", async () => {
    const { drive, runtime, endpoint, answerNext } = await remoteFixture();
    let cancelled: Promise<void> | undefined;
    answerNext(async (captured) => {
      const body = padded({ snapshot: { ...captured, panes: [{ ...captured.panes[0], agent_status: "done" }] } }, OVER_SNAPSHOT_CAP);
      cancelled = body.cancelled;
      return new Response(body.stream);
    });
    const failure = await drive.refresh(runtime).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteResponseTooLarge);
    expect(String(failure)).not.toContain(endpoint!.url);
    expect(String(failure)).not.toContain("fixture-token");
    await within(cancelled!);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("working");
    await drive.refresh(runtime);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("working");
    expect(runtime.machine.error).toBeNull();
  });

  it("preserves a remote bridge's finish identity through HTTP snapshots and status events", async () => {
    const { manager, drive, remote, runtime, send } = await remoteFixture();
    const current = snapshot("done");
    current.finish_epoch = "remote-server";
    current.panes[0]!.finish_id = 3;
    remote.set(current);
    await drive.refresh(runtime);
    expect(runtime.machine.snapshot).toMatchObject({ finish_epoch: "remote-server", panes: [{ finish_id: 3 }] });
    const received = new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("no remote finish event")); }, 2000);
      const unsubscribe = manager.subscribe((event) => {
        if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "pane-status") {
          clearTimeout(timer); unsubscribe(); resolve(event.message);
        }
      });
    });
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "done", finish_id: 4, finish_epoch: "remote-server" });
    expect(await received).toMatchObject({ finish_id: 4, finish_epoch: "remote-server" });
    expect(runtime.machine.snapshot?.panes[0]?.finish_id).toBe(4);
  });

  it("ends a remote PC's herdr run for read finishes only once a read of the PC names another, never from a saved snapshot", async () => {
    const { manager, drive } = await fixture();
    const saved = { ...snapshot("done"), finish_epoch: "saved-run" };
    drive.machines.set("saved", drive.runtime({ id: "saved", name: "Saved PC", kind: "ssh", enabled: true, state: "disconnected", error: null, snapshot: saved }));
    expect(manager.list().find((machine) => machine.id === "saved")?.snapshot?.finish_epoch).toBe("saved-run");
    expect(manager.finishEnded("saved", "saved-run")).toBe(false);

    const { manager: live, drive: liveDrive, remote, runtime } = await remoteFixture();
    remote.set({ ...snapshot("done"), finish_epoch: "remote-server" });
    await liveDrive.refresh(runtime);
    expect(live.finishEnded("remote", "remote-server")).toBe(false);
    remote.set({ ...snapshot("done"), finish_epoch: "remote-next" });
    await liveDrive.refresh(runtime);
    expect([live.finishEnded("remote", "remote-server"), live.finishEnded("remote", "remote-next")]).toEqual([true, false]);
  });

  it("keeps a newer local status and retries the invalidated snapshot", async () => {
    const { manager, drive, local, rosters } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    local.set(snapshot("blocked"));
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "working" });
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    rosters.length = 0;
    local.answer();
    await until(() => !drive.localBusy || local.waiting() === 1);
    expect(manager.list()[0]?.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(local.calls()).toBe(3);
    local.answer();
    await loading;
    expect(rosters).not.toContain("local:working");
    expect(rosters).toContain("local:blocked");
  });

  it("queues a local structure refresh requested while another is pending", async () => {
    const { manager, drive, local } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    local.set({ ...snapshot("blocked"), panes: [] });
    manager.localMessage({ type: "session-changed" });
    local.answer();
    await until(() => !drive.localBusy || local.waiting() === 1);
    expect(local.calls()).toBe(3);
    local.answer();
    await loading;
    expect(manager.list()[0]?.snapshot?.panes).toEqual([]);
  });

  it("reads the roster again when herdr names a local pane's agent anew, not at the next 5 s read", async () => {
    const { manager, drive, local } = await fixture();
    await manager.refreshLocal();
    manager.localAgents(snapshot("idle").panes);
    await until(() => !drive.localBusy && manager.list()[0]?.snapshot?.panes[0]?.agent === "codex");
    const before = local.calls();
    local.set({ ...snapshot("idle"), panes: [{ ...snapshot("idle").panes[0]!, agent: "opencode" }] });
    manager.localAgents([{ pane_id: "fixture:p1", agent: "opencode" }]);
    await until(() => manager.list()[0]?.snapshot?.panes[0]?.agent === "opencode");
    expect(local.calls()).toBe(before + 1);
    manager.localAgents([{ pane_id: "fixture:p1", agent: "opencode" }]);
    manager.localAgents([{ pane_id: "fixture:p1", agent: "opencode" }, { pane_id: "fixture:p2", agent: null }]);
    await until(() => !drive.localBusy);
    expect(local.calls()).toBe(before + 1);
  });

  it("hears a pane's agent anew once the pane has gone: its id used again by the same agent is read at once", async () => {
    const { manager, drive, local } = await fixture();
    await manager.refreshLocal();
    manager.localAgents(snapshot("idle").panes);
    await until(() => !drive.localBusy);
    local.set({ ...snapshot("idle"), panes: [] });
    await manager.refreshLocal();
    const closed = local.calls();
    local.set(snapshot("idle"));
    manager.localAgents(snapshot("idle").panes);
    await until(() => manager.list()[0]?.snapshot?.panes[0]?.agent === "codex" && !drive.localBusy);
    expect(local.calls()).toBe(closed + 1);
    manager.localMessage({ type: "pane-exited", pane_id: "fixture:p1" });
    await until(() => !drive.localBusy);
    const ended = local.calls();
    manager.localAgents(snapshot("idle").panes);
    await until(() => local.calls() === ended + 1 && !drive.localBusy);
  });

  it("keeps a newer remote status and retries the invalidated HTTP snapshot", async () => {
    const { drive, rosters, remote, runtime, send } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    remote.set(snapshot("blocked"));
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    rosters.length = 0;
    remote.answer();
    await until(() => !runtime.refreshing || remote.waiting() === 1);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(remote.calls()).toBe(3);
    remote.answer();
    await loading;
    expect(rosters).not.toContain("remote:working");
    expect(rosters).toContain("remote:blocked");
  });

  it("preserves a streamed remote snapshot received during an HTTP load", async () => {
    const { drive, rosters, remote, runtime, send } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    remote.set(snapshot("blocked"));
    send({ type: "snapshot", snapshot: snapshot("blocked") });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    rosters.length = 0;
    remote.answer();
    await until(() => !runtime.refreshing || remote.waiting() === 1);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(remote.calls()).toBe(3);
    remote.answer();
    await loading;
    expect(rosters).toEqual(["local:working", "remote:blocked"]);
  });

  for (const event of ["pane-status", "snapshot"] as const) {
    it(`retries an obsolete remote error after a newer ${event} without disconnecting`, async () => {
      const { rosters, remote, runtime, endpoint, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
      const generation = runtime.generation;
      remote.hold();
      setHttpStatus(503);
      send({ type: "session-changed" });
      await until(() => remote.waiting() === 1);
      setHttpStatus(200);
      remote.set(snapshot("blocked"));
      send(event === "pane-status"
        ? { type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" }
        : { type: "snapshot", snapshot: snapshot("blocked") });
      await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
      rosters.length = 0;
      remote.answer();
      await until(() => remote.waiting() === 1 || runtime.machine.state !== "connected");
      expect(remote.calls()).toBe(3);
      expect(runtime.machine.state).toBe("connected");
      expect(runtime.machine.error).toBeNull();
      expect(runtime.endpoint).toBe(endpoint);
      expect(runtime.generation).toBe(generation);
      expect(runtime.retry).toBeUndefined();
      expect(sshCloses()).toBe(0);
      expect(terminalCloses()).toBe(0);
      remote.answer();
      await until(() => !runtime.refreshing);
      expect(remote.calls()).toBe(3);
      expect(runtime.machine.state).toBe("connected");
      expect(runtime.machine.error).toBeNull();
      expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
      expect(runtime.retry).toBeUndefined();
      expect(sshCloses()).toBe(0);
      expect(terminalCloses()).toBe(0);
      expect(rosters).not.toContain("remote:working");
    });
  }

  it("reconnects after a current remote error from the observer", async () => {
    const { remote, runtime, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    remote.answer();
    await until(() => runtime.machine.state === "reconnecting");
    expect(remote.calls()).toBe(2);
    expect(runtime.machine.error).toBe("Remote herdr unavailable (503)");
    expect(runtime.endpoint).toBeUndefined();
    expect(runtime.retry).toBeDefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
  });

  it("does not swallow a current error after retrying an invalidated remote error", async () => {
    const { remote, runtime, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    remote.answer();
    await until(() => remote.waiting() === 1 || runtime.machine.state !== "connected");
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.state).toBe("connected");
    expect(runtime.retry).toBeUndefined();
    expect(sshCloses()).toBe(0);
    expect(terminalCloses()).toBe(0);
    remote.answer();
    await until(() => runtime.machine.state === "reconnecting");
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.error).toBe("Remote herdr unavailable (503)");
    expect(runtime.retry).toBeDefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
  });

  it("ignores an obsolete observer error after stop without retrying", async () => {
    const { manager, remote, runtime, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    manager.stop();
    remote.answer();
    await until(() => !runtime.refreshing);
    expect(remote.calls()).toBe(2);
    expect(runtime.machine.state).toBe("disconnected");
    expect(runtime.machine.error).toBeNull();
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(runtime.refreshQueued).toBe(false);
    expect(runtime.retry).toBeUndefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
  });

  it("ignores an old observer error while loading a replacement bridge", async () => {
    const { manager, drive, remote, runtime, endpoint, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    send({ type: "snapshot", snapshot: snapshot("blocked") });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    drive.disconnect(runtime);
    const generation = runtime.generation;
    let replacementSshCloses = 0;
    let replacementTerminalCloses = 0;
    runtime.endpoint = endpoint;
    runtime.ssh = { close() { replacementSshCloses++; } };
    manager.trackTerminal(runtime.machine.id, () => { replacementTerminalCloses++; });
    setHttpStatus(200);
    remote.set(snapshot("blocked"));
    await drive.observe(runtime);
    remote.answer();
    await until(() => remote.waiting() === 1 || runtime.machine.state !== "connected");
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.state).toBe("connected");
    remote.answer();
    await until(() => !runtime.refreshing);
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.state).toBe("connected");
    expect(runtime.machine.error).toBeNull();
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(runtime.generation).toBe(generation);
    expect(runtime.endpoint).toBe(endpoint);
    expect(runtime.retry).toBeUndefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
    expect(replacementSshCloses).toBe(0);
    expect(replacementTerminalCloses).toBe(0);
  });

  it("drops a remote refresh and its queued retry when the bridge disconnects", async () => {
    const { drive, rosters, remote, runtime, send } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    drive.disconnect(runtime);
    rosters.length = 0;
    remote.answer();
    await loading;
    expect(remote.calls()).toBe(2);
    expect(runtime.machine.state).toBe("disconnected");
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(rosters).toEqual([]);
  });

  it("handles a replacement bridge's failed queued load with its own generation", async () => {
    const { drive, remote, runtime, endpoint, setHttpStatus } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    drive.disconnect(runtime);
    runtime.endpoint = endpoint;
    runtime.ssh = { close() {} };
    setHttpStatus(503);
    await drive.observe(runtime);
    remote.answer();
    await until(() => remote.waiting() === 1);
    expect(remote.calls()).toBe(3);
    remote.answer();
    expect(await loading.then(() => null, (error: unknown) => error)).toBeNull();
    await until(() => runtime.machine.state === "reconnecting");
    expect(runtime.machine.error).toBe("Remote herdr unavailable (503)");
  });

  it("stops a local refresh without publishing or retrying its pending response", async () => {
    const { manager, local, rosters } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    manager.stop();
    rosters.length = 0;
    local.answer();
    await loading;
    expect(local.calls()).toBe(2);
    expect(manager.list()[0]?.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(rosters).toEqual([]);
  });
});

describe("a bridge's agent news (#555)", () => {
  const pane = (agent: string | null) => [{ pane_id: "p1", agent }];
  const bridge = () => { let told = 0; return { news: bridgeAgentNews(() => { told++; }), told: () => told }; };

  it("tells its connection server of an agent first seen in a reconciled snapshot, once", () => {
    const { news, told } = bridge();
    news.reconciled(pane(null));
    expect(told()).toBe(0);
    // herdr names an agent there with no status event: only a reconcile shows it
    news.reconciled(pane("claude"));
    expect(told()).toBe(1);
    news.reconciled(pane("claude"));
    expect(told()).toBe(1);
  });

  it("leaves an agent named in a status event to that event's own frame", () => {
    const { news, told } = bridge();
    news.reconciled(pane(null));
    news.status(pane("codex"));
    news.reconciled(pane("codex"));
    expect(told()).toBe(0);
  });

  it("forgets no pane a reconcile left out for being newer than its snapshot", () => {
    const { news, told } = bridge();
    news.reconciled(pane("claude"));
    expect(told()).toBe(1);
    news.reconciled([]);
    news.status(pane("claude"));
    news.reconciled(pane("claude"));
    expect(told()).toBe(1);
  });

  it("hears a pane's id anew once the pane ended", () => {
    const { news, told } = bridge();
    news.reconciled(pane("claude"));
    news.ended("p1");
    news.reconciled(pane("claude"));
    expect(told()).toBe(2);
  });
});

const paired = (epoch: string, seq: number, agent_status = "working"): SessionSnapshot => ({ ...snapshot(agent_status), order_epoch: epoch, read_seq: seq });
function gatedHealth() {
  const calls: { request: Request; answer(boot: string | null, status?: number): void; reply(response: Response): void }[] = [];
  let started = 0;
  let woken: (() => void) | null = null;
  const handler = (request: Request) => new Promise<Response>((resolve) => {
    started++;
    calls.push({ request, answer: (boot, status = 200) => resolve(Response.json({ ok: true, web_ui: { boot_id: boot, revision: null } }, { status })), reply: resolve });
    woken?.();
  });
  const next = async () => {
    while (calls.length === 0) await new Promise<void>((resolve) => { woken = resolve; });
    return calls.shift()!;
  };
  return { handler, next, started: () => started };
}
function published(manager: MachineManager, check: (machines: Machine[]) => boolean): Promise<Machine[]> {
  return new Promise((resolve) => {
    const stop = manager.subscribe((event) => { if (event.type === "machines" && check(event.machines)) { stop(); resolve(event.machines); } });
  });
}
function remotePairs(manager: MachineManager): string[] {
  const pairs: string[] = [];
  manager.subscribe((event) => {
    if (event.type !== "machines") return;
    const snap = event.machines.find((machine) => machine.id === "remote")?.snapshot;
    if (snap?.order_epoch) pairs.push(`${snap.order_epoch}:${snap.read_seq}`);
  });
  return pairs;
}
function heard(manager: MachineManager, send: (message: ServerMessage) => void): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const stop = manager.subscribe((event) => {
      if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "pane-exited" && event.message.pane_id === "fixture:marker") { stop(); resolve(); }
    });
  });
  send({ type: "pane-exited", pane_id: "fixture:marker" });
  return done;
}
const remoteOf = (manager: MachineManager) => manager.list().find((machine) => machine.id === "remote");

describe("workspace order evidence through the manager", () => {
  it("a remote opening snapshot cannot acquire freshness on arrival", async () => {
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture();
    setHealth(() => Response.json({ ok: true, web_ui: { boot_id: "R", revision: null } }));
    const pairs = remotePairs(manager);
    remote.set(paired("R", 0));
    remote.hold();
    const before = remote.calls();
    const loading = drive.refresh(runtime);
    await remote.held();
    send({ type: "snapshot", snapshot: paired("R", 0) });
    await published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.order_epoch === "R"));
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R", read_seq: 0 });
    remote.set(paired("R", 1));
    remote.answer();
    await remote.held();
    remote.answer();
    await loading;
    expect(remote.calls() - before).toBe(2);
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R", read_seq: 1 });
    expect(pairs).toEqual(expect.arrayContaining(["R:0", "R:1"]));
    expect(pairs.indexOf("R:1")).toBeGreaterThan(pairs.lastIndexOf("R:0"));
  });

  it("fresh HTTP before stale websocket never regresses the cache or order", async () => {
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture();
    setHealth(() => Response.json({ ok: true, web_ui: { boot_id: "R", revision: null } }));
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R"));
    remote.set(paired("R", 1));
    await drive.refresh(runtime);
    await proved;
    const pairs = remotePairs(manager);
    send({ type: "snapshot", snapshot: paired("R", 0, "blocked") });
    await heard(manager, send);
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R", read_seq: 1, panes: [{ agent_status: "working" }] });
    expect(pairs).not.toContain("R:0");
    const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines"), manager);
    const roster = await response.json() as { machines: Machine[] };
    expect(roster.machines.find((machine) => machine.id === "remote")?.snapshot).toMatchObject({ order_epoch: "R", read_seq: 1 });
  });

  it("a late read of a herdr run an HTTP read showed ended cannot bring it back with the same order pair (#2206)", async () => {
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture();
    setHealth(() => Response.json({ ok: true, web_ui: { boot_id: "R", revision: null } }));
    const run = (finish_epoch: string, agent_status = "done"): SessionSnapshot => ({ ...paired("R", 0, agent_status), finish_epoch });
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.finish_epoch === "A"));
    remote.set(run("A"));
    await drive.refresh(runtime);
    await proved;
    remote.set(run("B"));
    await drive.refresh(runtime);
    expect(remoteOf(manager)?.snapshot).toMatchObject({ finish_epoch: "B", order_epoch: "R", read_seq: 0 });
    const told: string[] = [];
    manager.subscribe((event) => { if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "pane-status") told.push(event.message.finish_epoch ?? ""); });
    send({ type: "snapshot", snapshot: run("A", "blocked") });
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked", finish_id: 9, finish_epoch: "A" });
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "done", finish_id: 2, finish_epoch: "B" });
    await heard(manager, send);
    expect(remoteOf(manager)?.snapshot).toMatchObject({ finish_epoch: "B", panes: [{ agent_status: "done" }] });
    expect(told).toEqual(["B"]);
    expect([manager.finishEnded("remote", "A"), manager.finishEnded("remote", "B")]).toEqual([true, false]);
    remote.hold();
    send({ type: "snapshot", snapshot: run("C") });
    await heard(manager, send);
    expect(remoteOf(manager)?.snapshot?.finish_epoch).toBe("C");
    expect([manager.finishEnded("remote", "B"), manager.finishEnded("remote", "C")]).toEqual([false, false]);
    const reread = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.finish_epoch === "B"));
    remote.finish();
    await reread;
    expect([manager.finishEnded("remote", "A"), manager.finishEnded("remote", "C")]).toEqual([true, true]);
  });

  it("a snapshot held for health that a status laid another run over names no server for that run (#2206)", async () => {
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture();
    const health = gatedHealth();
    setHealth(health.handler);
    const run = (finish_epoch: string): SessionSnapshot => ({ ...paired("R", 0, "done"), finish_epoch });
    remote.set(run("A"));
    await drive.refresh(runtime);
    const call = await health.next();
    remote.hold();
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "done", finish_id: 1, finish_epoch: "B" });
    await heard(manager, send);
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R"));
    call.answer("R");
    await proved;
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R", finish_epoch: "B" });
    remote.set(run("C"));
    const settled = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.finish_epoch === "C"));
    remote.finish();
    await settled;
    expect(manager.finishEnded("remote", "B")).toBe(true);
    const told: string[] = [];
    manager.subscribe((event) => { if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "pane-status") told.push(event.message.finish_epoch ?? ""); });
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "working", finish_id: 1, finish_epoch: "B" });
    await heard(manager, send);
    expect(told).toEqual(["B"]);
    expect(manager.finishEnded("remote", "B")).toBe(false);
  });

  it("a status heard before a connection's health proof cannot end its run for good under the cached roster's server (#2206)", async () => {
    let clock = 0;
    const { manager, drive, remote, runtime, endpoint, send, setHealth, observed } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    const run = (server: string, finish_epoch: string, seq = 0, agent_status = "done"): SessionSnapshot => ({ ...paired(server, seq, agent_status), finish_epoch });
    const reconnect = async () => {
      const open = observed();
      drive.disconnect(runtime);
      runtime.endpoint = endpoint; runtime.ssh = { close() {} };
      clock += SOURCE_CHECK_INTERVAL_MS;
      await drive.observe(runtime);
      await open;
    };
    remote.set(run("R", "A"));
    await drive.refresh(runtime);
    const provedR = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.finish_epoch === "A"));
    (await health.next()).answer("R");
    await provedR;
    await drive.refresh(runtime);
    remote.set(run("S", "B"));
    await reconnect();
    const slow = await health.next();
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "working", finish_id: 1, finish_epoch: "B" });
    await heard(manager, send);
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R", finish_epoch: "B" });
    remote.set(run("R", "A", 1));
    await reconnect();
    slow.answer("S");
    const backR = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.read_seq === 1));
    (await health.next()).answer("R");
    await backR;
    await drive.refresh(runtime);
    expect([manager.finishEnded("remote", "A"), manager.finishEnded("remote", "B")]).toEqual([false, true]);
    remote.set(run("S", "B", 2, "blocked"));
    await reconnect();
    expect((runtime as unknown as { verification?: unknown }).verification).toBeDefined();
    const backS = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.order_epoch === "S"));
    (await health.next()).answer("S");
    await backS;
    expect(remoteOf(manager)?.snapshot).toMatchObject({ finish_epoch: "B", panes: [{ agent_status: "blocked" }] });
    expect(manager.finishEnded("remote", "B")).toBe(false);
  });

  it("remote epoch proof comes only from manager sideband health", async () => {
    const { manager, runtime, send, setHealth } = await remoteFixture({ bootId: "local-boot" });
    const health = gatedHealth();
    setHealth(health.handler);
    expect(manager.list()[0]?.source_boot_id).toBe("local-boot");
    send({ type: "snapshot", snapshot: paired("R", 0) });
    const call = await health.next();
    expect(call.request.headers.get("authorization")).toBe(`Bearer ${runtime.endpoint!.token}`);
    // the snapshot's epoch is not proof: until health answers, there is none
    expect(remoteOf(manager)?.source_boot_id).toBeUndefined();
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R"));
    call.answer("R");
    await proved;
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R", read_seq: 0 });
  });

  it("names each PC by the relay ID its own server has: this one's, and a remote one's from its health (#2876)", async () => {
    const own = "ab".repeat(16), theirs = "cd".repeat(16);
    const { manager, send, setHealth } = await remoteFixture({ serverId: () => own });
    setHealth(() => Response.json({ ok: true, web_ui: { boot_id: "R", revision: null, server_id: theirs } }));
    expect(manager.list()[0]?.server_id).toBe(own);
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R"));
    send({ type: "snapshot", snapshot: paired("R", 0) });
    await proved;
    expect(remoteOf(manager)?.server_id).toBe(theirs);
  });

  it("keeps an SSH PC's relay ID across a restart, so its alerts are known by it before it answers (#2876)", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-machine-id-"));
    const id = "0f0f0f0f-0000-4000-8000-000000000001", theirs = "cd".repeat(16);
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "Office", enabled: false, target: { destination: "office" }, server_id: theirs, snapshot: null }]));
    const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null));
    cleanups.push(() => { manager.stop(); rmSync(dir, { recursive: true, force: true }); });
    expect(manager.list().find((machine) => machine.id === id)?.server_id).toBe(theirs);
    manager.patch(id, { name: "Office 2" });
    expect(JSON.parse(readFileSync(join(dir, "machines.json"), "utf8"))[0].server_id).toBe(theirs);
  });

  it("a connection's first epoch is published only once its health proves it", async () => {
    const { manager, send, setHealth } = await remoteFixture();
    const health = gatedHealth();
    setHealth(health.handler);
    const pairs = remotePairs(manager);
    send({ type: "snapshot", snapshot: paired("R", 0, "blocked") });
    const call = await health.next();
    await heard(manager, send);
    expect(remoteOf(manager)?.snapshot?.order_epoch).toBeUndefined();
    expect(pairs).toEqual([]);
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.order_epoch === "R"));
    call.answer("R");
    await proved;
    expect(remoteOf(manager)).toMatchObject({ source_boot_id: "R", snapshot: { order_epoch: "R", read_seq: 0, panes: [{ agent_status: "blocked" }] } });
  });

  it("a reconnect cannot replace a cached epoch before health proves the new one", async () => {
    let clock = 0;
    const { manager, drive, remote, runtime, endpoint, setHealth } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    remote.set(paired("R1", 5));
    await drive.refresh(runtime);
    (await health.next()).answer("R1");
    await published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R1"));
    drive.disconnect(runtime);
    runtime.endpoint = endpoint;
    clock = SOURCE_CHECK_INTERVAL_MS;
    const pairs = remotePairs(manager);
    remote.set(paired("R2", 0, "blocked"));
    await drive.refresh(runtime);
    const call = await health.next();
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R1", read_seq: 5 });
    expect(remoteOf(manager)?.source_boot_id).toBeUndefined();
    expect(pairs).not.toContain("R2:0");
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.order_epoch === "R2"));
    call.answer("R2");
    await proved;
    expect(remoteOf(manager)).toMatchObject({ source_boot_id: "R2", snapshot: { order_epoch: "R2", read_seq: 0 } });
  });

  it("restored remote state has no boot proof", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-machine-restored-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const id = "0f2b2a4c-1111-4222-8333-944455556666";
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "machines.json"), JSON.stringify([{ id, name: "saved", enabled: false, target: { destination: "saved" }, source_boot_id: "R", snapshot: paired("R", 4) }]));
    const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
    const manager = new MachineManager(join(root, "state"), push, new CompletionTracker(null), async () => snapshot());
    cleanups.push(() => manager.stop());
    const saved = manager.list().find((machine) => machine.id === id);
    expect(saved?.snapshot).toMatchObject({ order_epoch: "R", read_seq: 4 });
    expect(saved?.source_boot_id).toBeUndefined();
  });

  it("old-generation health cannot retire a receipt epoch", async () => {
    let clock = 0;
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    remote.set(paired("R1", 2));
    await drive.refresh(runtime);
    (await health.next()).answer("R1");
    await published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R1"));
    clock = SOURCE_CHECK_INTERVAL_MS;
    send({ type: "snapshot", snapshot: paired("R2", 0, "blocked") });
    const stale = await health.next();
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R1", read_seq: 2 });
    const check = (runtime as unknown as { verification?: { promise: Promise<string | null> } }).verification!.promise;
    runtime.generation++;
    const pairs = remotePairs(manager);
    stale.answer("R2");
    expect(await check).toBeNull();
    expect(remoteOf(manager)).toMatchObject({ source_boot_id: "R1", snapshot: { order_epoch: "R1", read_seq: 2 } });
    expect(pairs).not.toContain("R2:0");
  });

  it("a health answer past its ceiling proves nothing, and one at it proves the epoch", async () => {
    let clock = 0;
    const { manager, runtime, send, setHealth } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    const sized = (boot: string, total: number) => new Response(padded({ ok: true, web_ui: { boot_id: boot, revision: null } }, total).stream);
    const pairs = remotePairs(manager);
    send({ type: "snapshot", snapshot: paired("R", 0) });
    const over = await health.next();
    const check = (runtime as unknown as { verification?: { promise: Promise<string | null> } }).verification!.promise;
    over.reply(sized("R", REMOTE_LIMITS.health + 1));
    expect(await check).toBeNull();
    expect(remoteOf(manager)?.source_boot_id).toBeUndefined();
    expect(pairs).toEqual([]);
    clock = SOURCE_CHECK_INTERVAL_MS;
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R" && machine.snapshot?.order_epoch === "R"));
    send({ type: "snapshot", snapshot: paired("R", 0) });
    (await health.next()).reply(sized("R", REMOTE_LIMITS.health));
    await proved;
  });

  it("a validation superseded in the same generation publishes nothing", async () => {
    const { manager, runtime, send, setHealth } = await remoteFixture();
    const health = gatedHealth();
    setHealth(health.handler);
    send({ type: "snapshot", snapshot: paired("R1", 0) });
    const stale = await health.next();
    const check = (runtime as unknown as { verification?: { promise: Promise<string | null> } }).verification!.promise;
    const generation = runtime.generation;
    runtime.endpoint = { ...runtime.endpoint! };
    const pairs = remotePairs(manager);
    stale.answer("R1");
    expect(await check).toBeNull();
    await heard(manager, send);
    expect(runtime.generation).toBe(generation);
    expect(remoteOf(manager)?.source_boot_id).toBeUndefined();
    expect(remoteOf(manager)?.snapshot?.order_epoch).toBeUndefined();
    expect(pairs).toEqual([]);
  });

  it("a proven source restart replaces the cache with the new server's read", async () => {
    let clock = 0;
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    remote.set(paired("R1", 3));
    await drive.refresh(runtime);
    (await health.next()).answer("R1");
    await published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R1"));
    clock = SOURCE_CHECK_INTERVAL_MS;
    send({ type: "snapshot", snapshot: paired("R2", 0, "blocked") });
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R2" && machine.snapshot?.order_epoch === "R2"));
    (await health.next()).answer("R2");
    await proved;
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R2", read_seq: 0, panes: [{ agent_status: "blocked" }] });
  });

  it("a snapshot held for health cannot overwrite a status heard while it waited", async () => {
    let clock = 0;
    const { manager, drive, remote, runtime, send, setHealth } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    remote.set(paired("R1", 3));
    await drive.refresh(runtime);
    (await health.next()).answer("R1");
    await published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R1"));
    clock = SOURCE_CHECK_INTERVAL_MS;
    remote.set(paired("R2", 1, "blocked"));
    remote.hold();
    send({ type: "snapshot", snapshot: paired("R2", 0, "working") });
    const call = await health.next();
    const statusHeard = new Promise<void>((resolve) => {
      const stop = manager.subscribe((event) => { if (event.type === "machine-message" && event.message.type === "pane-status") { stop(); resolve(); } });
    });
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await statusHeard;
    await remote.held();
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R1", read_seq: 3, panes: [{ agent_status: "blocked" }] });
    const pairs = remotePairs(manager);
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R2"));
    call.answer("R2");
    await proved;
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R2", read_seq: 0, panes: [{ agent_status: "blocked" }] });
    const current = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.snapshot?.read_seq === 1));
    remote.finish();
    await current;
    expect(remoteOf(manager)?.snapshot).toMatchObject({ order_epoch: "R2", read_seq: 1, panes: [{ agent_status: "blocked" }] });
    expect(pairs.filter((pair) => pair.startsWith("R2:"))).toEqual(["R2:0", "R2:1"]);
  });

  it("concurrent verification queries start one health call", async () => {
    const { manager, setHealth } = await remoteFixture();
    const health = gatedHealth();
    setHealth(health.handler);
    const answers = Array.from({ length: 32 }, () => manager.verifySourceBoot("remote", new AbortController().signal));
    const call = await health.next();
    expect(health.started()).toBe(1);
    call.answer("R");
    const settled = await Promise.all(answers);
    expect(health.started()).toBe(1);
    expect(settled[0]).toEqual({ boot_id: "R" });
    expect(settled.slice(1).every((answer) => "refused" in answer && answer.refused === "unverified")).toBe(true);
  });

  it("sequential verification queries obey the per-PC start interval", async () => {
    let clock = 0;
    const { manager, drive, endpoint, setHealth } = await remoteFixture({ now: () => clock });
    setHealth(() => Response.json({ ok: true, web_ui: { boot_id: "R", revision: null } }));
    const second = drive.runtime({ id: "remote-2", name: "Second fixture", kind: "ssh", enabled: true, state: "connected", error: null, snapshot: null });
    second.endpoint = endpoint;
    drive.machines.set("remote-2", second);
    expect(await manager.verifySourceBoot("remote")).toEqual({ boot_id: "R" });
    clock = 500;
    expect(await manager.verifySourceBoot("remote")).toEqual({ refused: "interval" });
    expect(await manager.verifySourceBoot("remote-2")).toEqual({ boot_id: "R" });
    clock = SOURCE_CHECK_INTERVAL_MS - 1;
    expect(await manager.verifySourceBoot("remote")).toEqual({ refused: "interval" });
    clock = SOURCE_CHECK_INTERVAL_MS;
    expect(await manager.verifySourceBoot("remote")).toEqual({ boot_id: "R" });
    second.generation++;
    clock = SOURCE_CHECK_INTERVAL_MS + 400;
    expect(await manager.verifySourceBoot("remote-2")).toEqual({ refused: "interval" });
  });

  it("a caller's abort ends only its own wait, and a lost connection refuses every caller", async () => {
    const { manager, drive, runtime, setHealth } = await remoteFixture();
    const health = gatedHealth();
    setHealth(health.handler);
    const leaving = new AbortController();
    const asked = manager.verifySourceBoot("remote", leaving.signal);
    const call = await health.next();
    leaving.abort();
    expect(await asked).toEqual({ refused: "unverified" });
    const proved = published(manager, (machines) => machines.some((machine) => machine.id === "remote" && machine.source_boot_id === "R"));
    call.answer("R");
    await proved;
    let clock = 0;
    (manager as unknown as { now: () => number }).now = () => clock;
    (manager as unknown as { sourceStarts: Map<string, number> }).sourceStarts.clear();
    const lost = manager.verifySourceBoot("remote", new AbortController().signal);
    await health.next();
    drive.disconnect(runtime);
    expect(await lost).toEqual({ refused: "unverified" });
    expect(remoteOf(manager)?.source_boot_id).toBeUndefined();
  });

  it("a failed health answer proves nothing and a later one can", async () => {
    let clock = 0;
    const { manager, setHealth } = await remoteFixture({ now: () => clock });
    const health = gatedHealth();
    setHealth(health.handler);
    const first = manager.verifySourceBoot("remote");
    (await health.next()).answer(null, 503);
    expect(await first).toEqual({ refused: "unverified" });
    expect(remoteOf(manager)?.source_boot_id).toBeUndefined();
    clock = SOURCE_CHECK_INTERVAL_MS;
    const again = manager.verifySourceBoot("remote");
    (await health.next()).answer("R");
    expect(await again).toEqual({ boot_id: "R" });
  });

  it("the local PC answers with this server's boot id, with no remote call", async () => {
    const { manager, setHealth } = await remoteFixture({ bootId: "local-boot" });
    const health = gatedHealth();
    setHealth(health.handler);
    expect(await manager.verifySourceBoot("local")).toEqual({ boot_id: "local-boot" });
    expect(await manager.verifySourceBoot("nobody")).toEqual({ refused: "unknown" });
    expect(health.started()).toBe(0);
  });

  it("GET /api/machines?verify_source_boot answers a fresh proof or a refusal", async () => {
    let clock = 0;
    const { manager, setHealth } = await remoteFixture({ bootId: "local-boot", now: () => clock });
    setHealth(() => Response.json({ ok: true, web_ui: { boot_id: "R", revision: null } }));
    const ask = (query: string) => handleMachineRequest(new Request(`http://127.0.0.1/api/machines${query}`), manager);
    const plain = await ask("");
    expect(Object.keys(await plain.json())).toEqual(["machines"]);
    expect((await ask("?verify_source_boot=")).status).toBe(400);
    expect((await ask("?verify_source_boot=remote&verify_source_boot=local")).status).toBe(400);
    expect((await ask("?verify_source_boot=nobody")).status).toBe(404);
    const local = await ask("?verify_source_boot=local");
    expect(local.headers.get("cache-control")).toBe("no-store");
    expect((await local.json() as { verified_source_boot: unknown }).verified_source_boot).toEqual({ machine_id: "local", boot_id: "local-boot" });
    const remote = await ask("?verify_source_boot=remote");
    expect((await remote.json() as { verified_source_boot: unknown }).verified_source_boot).toEqual({ machine_id: "remote", boot_id: "R" });
    const refused = await ask("?verify_source_boot=remote");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toMatchObject({ error: { code: "source_unverified" } });
    expect(JSON.stringify(await (await ask("")).json())).not.toContain("fixture-token");
  });
});

describe("saving a remote PC's snapshot", () => {
  it("rewrites machines.json durably, and only when a refresh changed what it holds", async () => {
    const callbacks = new Map<unknown, () => void>();
    const realSetTimeout = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout");
    cleanups.push(() => timers.mockRestore());
    timers.mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
      const timer = realSetTimeout(callback, ms, ...args);
      callbacks.set(timer, callback);
      return timer;
    }) as unknown as typeof setTimeout);
    const { manager, drive, remote, runtime } = await remoteFixture();
    const internals = manager as unknown as { stateDir: string; saveTimer?: ReturnType<typeof setTimeout> };
    // each durable write creates its temporary file exclusively ("wx") and fsyncs it
    const temporaries: string[] = [];
    const open = spyOn(privateStateFs, "openSync");
    const fsync = spyOn(privateStateFs, "fsyncSync");
    cleanups.push(() => { open.mockRestore(); fsync.mockRestore(); });
    open.mockImplementation(((path: string, flags: string, mode?: number) => {
      if (flags === "wx" && path.includes("machines.json")) temporaries.push(path);
      return openSync(path, flags, mode);
    }) as typeof openSync);
    const refreshed = async () => {
      await drive.refresh(runtime);
      const timer = internals.saveTimer;
      const save = callbacks.get(timer);
      expect(save).toBeDefined();
      clearTimeout(timer);
      save!();
      expect(internals.saveTimer).toBeUndefined();
    };
    const saved = () => JSON.parse(readFileSync(join(internals.stateDir, "machines.json"), "utf8")) as { snapshot: SessionSnapshot | null }[];

    await refreshed();
    expect(temporaries).toHaveLength(1);
    expect(fsync).toHaveBeenCalled();
    expect(saved()[0]!.snapshot?.panes[0]?.agent_status).toBe("working");

    await refreshed();
    await refreshed();
    expect(temporaries).toHaveLength(1);

    remote.set(snapshot("done"));
    await refreshed();
    expect(temporaries).toHaveLength(2);
    expect(saved()[0]!.snapshot?.panes[0]?.agent_status).toBe("done");
  });
});

it("shows a connected PC's move to herdr-core on its roster, one read at a time, often while it runs, and drops it when the PC goes", async () => {
  const f = await remoteFixture({ moveOfferMs: { idle: 60_000, active: 1 } });
  await until(() => f.runtime.machine.runtime_move === null);
  const told: unknown[] = [];
  f.manager.subscribe((event) => { if (event.type === "machines") told.push(event.machines.find((machine) => machine.id === "remote")?.runtime_move); });
  let answer: unknown = { available: true, plan: { workspaces: [], panes: [], ready: true, revision: "r1" }, status: { state: "idle" } };
  let failing = false;
  let reads = 0;
  let open = 0;
  let most = 0;
  let held: ReturnType<typeof Promise.withResolvers<void>> | null = Promise.withResolvers<void>();
  f.setMove(async () => {
    reads++; open++; most = Math.max(most, open);
    if (held) await held.promise;
    open--;
    return failing ? Response.json({ error: { code: "connect_failed", message: "herdr did not answer" } }, { status: 502 }) : Response.json(answer);
  });
  f.manager.moveOfferSoon("remote");
  await until(() => open === 1);
  f.manager.moveOfferSoon("remote");
  held.resolve(); held = null;
  await until(() => reads === 2 && open === 0);
  expect(most).toBe(1);
  expect(f.runtime.machine.runtime_move).toEqual({ serving: "herdr", offered: true, reason: null, status: { state: "idle" } });
  expect(told).toContainEqual({ serving: "herdr", offered: true, reason: null, status: { state: "idle" } });
  answer = { available: true, plan: { workspaces: [], panes: [], ready: false, revision: "r1" }, status: { state: "waiting", revision: "r1" } };
  f.manager.moveOfferSoon("remote");
  await until(() => reads >= 6);
  expect(f.runtime.machine.runtime_move?.status).toEqual({ state: "waiting" });
  failing = true;
  const before = reads;
  await until(() => reads >= before + 3);
  expect(f.runtime.machine.runtime_move?.status).toEqual({ state: "waiting" });
  failing = false;
  // a move that could not finish names folders and agents' words: the roster tells only how it ended
  const secret = "/home/someone/secret-project";
  answer = { available: true, plan: { workspaces: [], panes: [], ready: true, revision: "r2" }, status: { state: "rolled_back", reason: `could not start ${secret}`, left: [{ pane_id: "w1:p1", agent: "claude", why: `${secret} is gone` }] } };
  await until(() => f.runtime.machine.runtime_move?.status.state === "rolled_back");
  expect(f.runtime.machine.runtime_move?.status).toEqual({ state: "rolled_back", left: 1 });
  const watched = await handleMachineRequest(new Request("http://127.0.0.1/api/machines"), f.manager, undefined, undefined, true);
  expect(await watched.text()).not.toContain("secret-project");
  // a reason this version does not know is not carried: it could be any words of that PC's
  answer = { available: false, reason: `cannot move ${secret}`, status: { state: "idle" } };
  f.manager.moveOfferSoon("remote");
  await until(() => f.runtime.machine.runtime_move === null);
  answer = { available: false, reason: "not_herdr", status: { state: "idle" } };
  f.manager.moveOfferSoon("remote");
  await until(() => f.runtime.machine.runtime_move?.serving === "herdr-core");
  expect(f.runtime.machine.runtime_move).toEqual({ serving: "herdr-core", offered: false, reason: "not_herdr", status: { state: "idle" } });
  f.drive.disconnect(f.runtime);
  expect(f.runtime.machine.runtime_move).toBeUndefined();
});
