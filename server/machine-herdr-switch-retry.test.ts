import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob, type SshTarget } from "../shared/machines.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import { createPushService } from "./push.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";

it.each([
  { loss: "before", result: "connected", session: "a" },
  { loss: "during", result: "connected", session: "b" },
  { loss: "before", result: "failed", session: "a" },
  { loss: "during", result: "failed", session: "b" },
])("pauses old retries when the link drops $loss a switch, then the switch is $result", async ({ loss, result, session }) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-herdr-switch-retry-"));
  const id = "12345678-1234-1234-1234-123456789abf";
  const a = { destination: "fixture-only", session: "a", herdr_socket: "/home/fixture/.config/herdr/sessions/a/herdr.sock" };
  const b = { ...a, session, herdr_socket: "/home/fixture/.config/herdr/sessions/b/herdr.sock" };
  const descriptor = (socket: string) => ({ socket_path: socket, pid: 4242, port: socket === a.herdr_socket ? 12345 : 12346, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true });
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), resumed = Promise.withResolvers<void>();
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: a }]));
  const relays: ReturnType<typeof Bun.serve>[] = [];
  let firstSsh: SshConnection | undefined, oldLost = false, oldStarts = 0, sshStarts = 0, clock = 0;
  const timers = new Map<number, () => void>();
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const mocks = [
    // Hold retry deadlines, not the setup or test deadlines: advance them explicitly, without a sleep.
    spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(set, {
      apply(target, _receiver, [fn, delay, ...args]: unknown[]) {
        if (typeof fn !== "function" || delay !== undefined && typeof delay !== "number") throw new Error("Expected timer callback and delay");
        const retry = typeof delay === "number" && [1000, 2000, 4000, 8000, 16000, 32000, 60000].includes(delay);
        const callback = () => fn(...args);
        const handle = target(callback, retry ? 600_000 : delay);
        if (retry) timers.set(Number(handle), callback);
        return handle;
      },
    })),
    spyOn(globalThis, "clearTimeout").mockImplementation((handle) => { timers.delete(Number(handle)); clear(Number(handle)); }),
    spyOn(SshConnection.prototype, "start").mockImplementation(async function(this: SshConnection) { firstSsh ??= this; sshStarts++; }),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(posixHost, "inspect").mockImplementation(async (_ssh, _session, selected) => {
      if (!selected) throw new Error("Expected an explicit socket");
      if (selected === b.herdr_socket) { reached.resolve(); await release.promise; if (result === "failed") throw new Error("B refused connection"); }
      return { platform: "linux-x64", home: "/home/fixture", herdrPath: "/fixture/herdr", expectedSocket: selected, bundleReady: true, bundleOlder: false,
        descriptors: selected === a.herdr_socket && oldLost ? [] : [descriptor(selected)], runtimeDir: "/runtime", registryDir: "/registry" };
    }),
    spyOn(posixHost, "herdrVersion").mockResolvedValue("herdr 0.9.3"),
    spyOn(posixHost, "alive").mockResolvedValue(true),
    // a chosen socket the PC verifies as this account's and answering
    spyOn(posixHost, "chosenSocketStatus").mockResolvedValue("usable"),
    spyOn(posixHost, "start").mockImplementation(async () => { oldStarts++; resumed.resolve(); throw new Error("Old bridge unavailable"); }),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    // the SSH tunnel to a bridge: its relay listens on a port of its own (port 0), never on a number freed for it, which
    // another process on a busy host may take first
    spyOn(MachineManager.prototype as unknown as { tunnel(ssh: SshConnection, descriptor: { port: number; token: string }): Promise<{ url: string; token: string }> }, "tunnel").mockImplementation(async (_ssh, { port: remotePort, token }) => {
      const socket = remotePort === 12345 ? a.herdr_socket : b.herdr_socket;
      const relay = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge") return Response.json({ ...descriptor(socket), socket_id: socket, herdr: { protocol: 22, version: "0.9.3" } });
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [{ id: socket, name: socket }] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response("absent", { status: 404 });
      }, websocket: { message() {} } });
      relays.push(relay);
      return { url: `http://127.0.0.1:${relay.port}`, token };
    }),
  ];
  const manager = new MachineManager(dir, createPushService({ stateDir: dir }), new CompletionTracker(null), async () => { throw new Error("isolated"); }, { now: () => clock });
  const run = (target: SshTarget) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const deadline = set(() => { off(); reject(new Error("setup did not settle")); }, 5000);
    const off = manager.subscribe(() => { if (job && ["failed", "connected"].includes(job.phase)) { off(); clear(deadline); resolve(job); } });
    job = manager.setup({ ...target, machine_id: id, update_remote: true }, { auto: true });
  });
  const advanceRetries = () => {
    clock += 60_000;
    for (const [handle, callback] of [...timers]) { clear(handle); timers.delete(handle); callback(); }
  };
  const drop = () => {
    if (!firstSsh?.onExit) throw new Error("The old connection has no exit listener");
    oldLost = true; firstSsh.onExit();
    expect(manager.list().find((pc) => pc.id === id)?.state).toBe("reconnecting");
  };
  let moving: Promise<SetupJob> | undefined;
  try {
    expect((await run(a)).phase).toBe("connected");
    if (loss === "before") drop();
    moving = run(b); await reached.promise;
    if (loss === "during") drop();
    advanceRetries();
    manager.retryNow(id);
    release.resolve();
    const job = await moving;
    expect(job).toMatchObject({ phase: result, error: result === "connected" ? null : "B refused connection" });
    expect(sshStarts).toBe(2);
    expect(oldStarts).toBe(0);
    expect(manager.list().find((pc) => pc.id === id)?.target).toEqual(result === "connected" ? b : a);
    if (result === "failed") {
      const deadline = set(() => resumed.reject(new Error("Old PC retries did not resume")), 5000);
      try { advanceRetries(); await resumed.promise; } finally { clear(deadline); }
      expect(oldStarts).toBe(1);
    }
  } finally {
    release.resolve(); await moving?.catch(() => {}); manager.stop();
    for (const handle of timers.keys()) clear(handle);
    for (const mock of mocks) mock.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
