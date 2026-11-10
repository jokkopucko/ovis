import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob, type SshTarget } from "../shared/machines.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { herdrMachineId } from "./herdr-profile-state.ts";

it.each(["socket success", "socket failure", "session success", "session failure", "stale independent socket"])("keeps the old connection and workspaces until %s settles", async (outcome) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-herdr-move-"));
  const id = "12345678-1234-1234-1234-123456789abe";
  const a = { destination: "fixture-only", session: "a", herdr_socket: "/home/fixture/.config/herdr/sessions/a/herdr.sock" };
  const b = { ...a, ...(outcome.startsWith("session") ? { session: "b" } : {}), herdr_socket: "/home/fixture/desktop/herdr/sessions/b/herdr.sock" };
  const descriptor = (socket: string) => ({ socket_path: socket, pid: 4242, port: socket === a.herdr_socket ? 12345 : 12346, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true });
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: a }]));
  const relays: ReturnType<typeof Bun.serve>[] = [];
  let firstSsh: SshConnection | undefined, oldClosed = false;
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockImplementation(async function(this: SshConnection) { firstSsh ??= this; }),
    spyOn(SshConnection.prototype, "close").mockImplementation(function(this: SshConnection) { if (this === firstSsh) oldClosed = true; }),
    spyOn(posixHost, "inspect").mockImplementation(async (_ssh, _session, selected) => {
      if (selected === b.herdr_socket) { reached.resolve(); await release.promise; }
      if (selected === b.herdr_socket && outcome.endsWith("failure")) throw new Error("B refused connection");
      return { platform: "linux-x64", home: "/home/fixture", herdrPath: "", expectedSocket: selected!, bundleReady: true, bundleOlder: false,
        descriptors: [{ ...descriptor(selected!), ...(selected === b.herdr_socket && outcome === "stale independent socket" ? { managed_remote: false, pid: 9898 } : {}) }], runtimeDir: "/runtime", registryDir: "/registry" };
    }),
    spyOn(posixHost, "alive").mockImplementation(async (_ssh, pid) => pid !== 9898),
    // a chosen socket the PC verifies as this account's and answering
    spyOn(posixHost, "chosenSocketStatus").mockResolvedValue("usable"),
    spyOn(posixHost, "start").mockRejectedValue(new Error("B could not start")),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port, remotePort) => {
      const socket = remotePort === 12345 ? a.herdr_socket : b.herdr_socket;
      relays.push(Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge") return Response.json({ ...descriptor(socket), socket_id: socket, herdr: { protocol: 22, version: "0.9.3" } });
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [{ id: socket, name: socket }] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response("absent", { status: 404 });
      }, websocket: { message() {} } }));
    }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const run = (target: SshTarget) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const deadline = setTimeout(() => { off(); reject(new Error("setup did not settle")); }, 5000);
    const off = manager.subscribe(() => { if (job && ["failed", "connected"].includes(job.phase)) { off(); clearTimeout(deadline); resolve(job); } });
    job = manager.setup({ ...target, machine_id: id, update_remote: true }, { auto: true });
  });
  let moving: Promise<SetupJob> | undefined;
  try {
    expect((await run(a)).phase).toBe("connected");
    const previous = structuredClone(manager.list().find((pc) => pc.id === id)?.snapshot);
    const endpoint = manager.endpoint(id);
    moving = run(b); await reached.promise;
    expect(oldClosed).toBe(false);
    expect(manager.endpoint(id)).toEqual(endpoint);
    expect(manager.list().find((pc) => pc.id === id)?.snapshot).toEqual(previous);
    release.resolve();
    expect((await moving).phase).toBe(outcome.endsWith("success") ? "connected" : "failed");
    const pc = manager.list().find((pc) => pc.id === id);
    expect(pc?.target).toEqual(outcome.endsWith("success") ? b : a);
    expect(pc?.state).toBe("connected");
    expect(oldClosed).toBe(outcome.endsWith("success"));
    if (!outcome.endsWith("success")) { expect(manager.endpoint(id)).toEqual(endpoint); expect(pc?.snapshot).toEqual(previous); }
  } finally {
    release.resolve(); await moving?.catch(() => {}); manager.stop();
    for (const mock of mocks) mock.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

// default: the default session chosen by its socket (on the card of a PC that also runs its own Ovis, or beside a chosen
// session that stopped). It is remembered as herdr to start there when absent, never as that socket (#3518)
it.each(["manual", "catalog socket", "catalog new", "manual default", "catalog default"])("remembers %s choice through refresh, restart and reconnect", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-herdr-choice-"));
  const catalog = kind.startsWith("catalog");
  const byDefault = kind.endsWith("default");
  const id = catalog ? herdrMachineId("fixture-profile") : "12345678-1234-1234-1234-123456789abc";
  const profile = { id: "fixture-profile", label: "fixture", enabled: true, target: { destination: "fixture-only", ...(byDefault ? {} : { session: "work" }) } };
  // the session's own socket, as that PC spells it
  const own = (session?: string) => session ? `/home/fixture/.config/herdr/sessions/${session}/herdr.sock` : "/home/fixture/.config/herdr/herdr.sock";
  const socket = byDefault ? own() : kind === "catalog new" ? own("work") : "/home/fixture/desktop/herdr/sessions/work/herdr.sock";
  // what that PC answers when asked which herdr to use: for default, herdr's own session beside another one
  const found = [...(byDefault ? [{ socket_path: socket, label: "Default session" }] : []), { socket_path: byDefault ? own("work") : socket, session: "work", label: "work" }];
  const descriptor = { socket_path: socket, pid: 4242, port: 12345, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
  if (!catalog) writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  // bridged: the bridge that serves the default session's socket still runs, so a PC saved without that socket meets it
  let started = false, bridged = false;
  const relays: ReturnType<typeof Bun.serve>[] = [];
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(posixHost, "inspect").mockImplementation(async (_ssh, session, selected) => ({ platform: "linux-x64", home: "/home/fixture", herdrPath: "/fixture/herdr", expectedSocket: selected ?? (kind === "catalog new" ? socket : own()), defaultSocket: own(session), bundleReady: true, bundleOlder: false, descriptors: selected || started || bridged ? [descriptor] : [], runtimeDir: "/runtime", registryDir: "/registry" })),
    spyOn(posixHost, "herdrVersion").mockResolvedValue("herdr 0.9.3"),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(posixHost, "start").mockImplementation(async (_ssh, options) => { started = options.start_new_herdr === true; }),
    spyOn(posixHost, "descriptors").mockImplementation(async () => started ? [descriptor] : []),
    spyOn(posixHost, "foundSessions").mockResolvedValue({ gone: false, sessions: found }),
    spyOn(posixHost, "alive").mockResolvedValue(true),
    // a chosen socket the PC verifies as this account's and answering
    spyOn(posixHost, "chosenSocketStatus").mockResolvedValue("usable"),
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port) => {
      relays.push(Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge") return Response.json({ ...descriptor, socket_id: "fixture:1", herdr: { protocol: 22, version: "0.9.3" } });
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response("absent", { status: 404 });
      }, websocket: { message() {} } }));
    }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  if (catalog) manager.syncHerdrProfiles([profile]);
  const run = (target: SshTarget): Promise<SetupJob> => new Promise((resolve, reject) => {
    let job: SetupJob | undefined;
    const deadline = setTimeout(() => { off(); reject(new Error("setup did not finish")); }, 5000);
    const off = manager.subscribe(() => {
      if (!job || !["failed", "connected"].includes(job.phase)) return;
      clearTimeout(deadline); off(); resolve(job);
    });
    job = manager.setup({ ...target, machine_id: id, update_remote: true }, { auto: true });
  });
  try {
    const failed = await run(catalog ? profile.target : { destination: "fixture-only" });
    expect(failed).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: found });
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", found_herdr_sessions: found });
    const target = byDefault ? { destination: "fixture-only", herdr_socket: socket } : { destination: "fixture-only", session: "work", ...(kind === "catalog new" ? { start_new_herdr: true } : { herdr_socket: socket }) };
    // what the PC is saved with
    const saved = byDefault ? { destination: "fixture-only", start_new_herdr: true } : target;
    expect(await run(target)).toMatchObject({ phase: "connected", target });
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: null });
    expect(manager.list().find((pc) => pc.id === id)?.target).toEqual(saved);
    bridged = kind === "catalog default";
    // the catalog's next refresh keeps it too: the socket is not pinned again there
    if (catalog) { manager.syncHerdrProfiles([profile]); expect(manager.list().find((pc) => pc.id === id)?.target).toEqual(saved); }
    else { expect(JSON.parse(readFileSync(join(dir, "machines.json"), "utf8"))[0].target).toEqual(saved); manager.patch(id, { enabled: false }); }
    manager.stop();
    const restored = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
    try {
      if (catalog) {
        const connected = new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => { off(); reject(new Error("catalog reconnect did not finish")); }, 5000);
          const off = restored.subscribe(() => { if (restored.list().find((pc) => pc.id === id)?.state === "connected") { clearTimeout(deadline); off(); resolve(); } });
        });
        restored.syncHerdrProfiles([profile]);
        expect(restored.list().find((pc) => pc.id === id)?.target).toEqual(saved);
        await connected;
      }
      expect(restored.list().find((pc) => pc.id === id)?.target).toEqual(saved);
      if (kind === "manual default") {
        // That PC restarted since: no bridge is left there, and another herdr session runs before the default one. The
        // PC's bridge is started with leave to start herdr when absent (started), as chosen, so it connects by itself
        // instead of stopping at a new choice
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => { off(); reject(new Error("the reconnect did not finish")); }, 5000);
          const off = restored.subscribe(() => { if (["connected", "error"].includes(restored.list().find((pc) => pc.id === id)?.state ?? "")) { clearTimeout(deadline); off(); resolve(); } });
          restored.patch(id, { enabled: true });
        });
        expect(restored.list().find((pc) => pc.id === id)).toMatchObject({ state: "connected", action_required: null });
        expect(started).toBe(true);
      }
    }
    finally { restored.stop(); }
  } finally {
    manager.stop();
    for (const mock of mocks) mock.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("puts a chosen session that stopped on the card as a choice, and never retries it on its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "machine-herdr-gone-"));
  const id = "12345678-1234-1234-1234-123456789abd";
  const socket = "/home/fixture/desktop/herdr/sessions/work/herdr.sock";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only", session: "work", herdr_socket: socket } }]));
  let starts = 0;
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(posixHost, "inspect").mockImplementation(async () => ({ platform: "linux-x64", home: "/home/fixture", herdrPath: "", expectedSocket: socket, bundleReady: true, bundleOlder: false, descriptors: [], runtimeDir: "/runtime", registryDir: "/registry" })),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(posixHost, "start").mockImplementation(async () => { starts++; }),
    spyOn(posixHost, "descriptors").mockResolvedValue([]),
    spyOn(posixHost, "foundSessions").mockResolvedValue({ gone: true, sessions: [] }),
  ];
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater");
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  try {
    const failed = await new Promise<SetupJob>((resolve, reject) => {
      let job: SetupJob | undefined;
      const deadline = setTimeout(() => { off(); reject(new Error("setup did not finish")); }, 5000);
      const off = manager.subscribe(() => { if (job && ["failed", "connected"].includes(job.phase)) { clearTimeout(deadline); off(); resolve(job); } });
      job = manager.setup({ destination: "fixture-only", session: "work", herdr_socket: socket, machine_id: id, update_remote: true }, { auto: true });
    });
    expect(failed).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: [] });
    expect(failed.error).toContain("no longer running");
    const pc = manager.list().find((machine) => machine.id === id);
    expect(pc).toMatchObject({ action_required: "choose_herdr", found_herdr_sessions: [] });
    // an action for the owner, not a PC to try again later
    expect(retries).not.toHaveBeenCalled();
    expect(starts).toBe(1);
  } finally { manager.stop(); retries.mockRestore(); for (const mock of mocks) mock.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["refused", "gone", "usable"] as const)("reuses a live bridge for a chosen socket only once the PC verifies that socket (%s)", async (status) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-herdr-reuse-"));
  const id = "12345678-1234-1234-1234-123456789abe";
  // a bridge registered for a socket that is not this account's (or no longer answers)
  const socket = "/home/other/.config/herdr/herdr.sock";
  const descriptor = { socket_path: socket, pid: 4242, port: 12345, token: "b".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only", herdr_socket: socket } }]));
  let starts = 0;
  const checked: string[] = [];
  const relays: ReturnType<typeof Bun.serve>[] = [];
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(posixHost, "inspect").mockImplementation(async () => ({ platform: "linux-x64", home: "/home/fixture", herdrPath: "", expectedSocket: socket, bundleReady: true, bundleOlder: false, descriptors: [descriptor], runtimeDir: "/runtime", registryDir: "/registry" })),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(posixHost, "start").mockImplementation(async () => { starts++; }),
    spyOn(posixHost, "descriptors").mockResolvedValue([descriptor]),
    spyOn(posixHost, "alive").mockResolvedValue(true),
    spyOn(posixHost, "chosenSocketStatus").mockImplementation(async (_ssh, _inspection, path) => { checked.push(path); return status; }),
    spyOn(posixHost, "foundSessions").mockResolvedValue({ gone: true, sessions: [] }),
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port) => {
      relays.push(Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge") return Response.json({ ...descriptor, socket_id: "fixture:1", herdr: { protocol: 22, version: "0.9.3" } });
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response("absent", { status: 404 });
      }, websocket: { message() {} } }));
    }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  try {
    const settled = await new Promise<SetupJob>((resolve, reject) => {
      let job: SetupJob | undefined;
      const deadline = setTimeout(() => { off(); reject(new Error("setup did not finish")); }, 5000);
      const off = manager.subscribe(() => { if (job && ["failed", "connected"].includes(job.phase)) { clearTimeout(deadline); off(); resolve(job); } });
      job = manager.setup({ destination: "fixture-only", herdr_socket: socket, machine_id: id, update_remote: true }, { auto: true });
    });
    expect(checked).toEqual([socket]);
    if (status === "usable") { expect(settled.phase).toBe("connected"); expect(starts).toBe(0); }
    else {
      // never taken: the bridge started instead checks the socket itself and says why
      expect(starts).toBe(1);
      expect(settled).toMatchObject({ phase: "failed", action_required: "choose_herdr" });
    }
  } finally { manager.stop(); for (const mock of mocks) mock.mockRestore(); for (const relay of relays) relay.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
