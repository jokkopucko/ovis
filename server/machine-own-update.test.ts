import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine, type SetupJob } from "../shared/machines.ts";
import { unmanagedUpdateStatus, type UpdateStatus } from "../shared/update.ts";
import { MachineManager } from "./machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import type { HerdrProfileState } from "./herdr-profile-state.ts";

// Nothing is installed, stopped or started on any PC, and no user's herdr or Ovis is touched.
const MACHINE_ID = "00000000-0000-4000-8000-000000000001";
const SOCKET = "/home/fixture/.config/herdr/herdr.sock";
const OFFERED = "f".repeat(40);
const OLD_TOKEN = "a".repeat(64), NEW_TOKEN = "b".repeat(64);
const REGISTERED_PORT = 29431, OWN_PORT = 7317;

interface Remote {
  status: UpdateStatus | null;
  install?: { status: number; code?: string }[];
  beforeInstall?: (Partial<UpdateStatus> | null)[];
  redirect?: { path: string; to: string };
  replacementPid?: unknown;
  replacementBundle?: string;
  replacementLiveBundle?: string;
  access?: Record<string, unknown> | null;
  bundle?: string;
  afterInstall?: { statuses: Partial<UpdateStatus>[]; restartAfter?: number };
  installHeld?: { reached(): void; gate: Promise<void> };
  runtime?: "bundle-ready" | "bundle-older" | null;
  managed?: boolean;
  elsewhere?: "stale-bridge";
}
const managedOffer = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  current_version: "0.4.16", latest_version: "0.4.18", current_revision: "c".repeat(40), latest_revision: OFFERED, revision_bound_install: true, ...patch });

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function pc(remote: Remote, options: { registered?: boolean; autoUpdate?: boolean; now?: () => number; ownUpdate?: { pollMs?: number; startMs?: number; checkMs?: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-own-update-"));
  let descriptor = { pid: 4242, port: REGISTERED_PORT, token: OLD_TOKEN, socket_path: SOCKET, managed_remote: remote.managed ?? false, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: remote.bundle ?? "35" };
  let heldBridge: { reached: ReturnType<typeof Promise.withResolvers<void>>; gate: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  const requests: string[] = [];
  const installs: unknown[] = [];
  const operations: string[] = [];
  let installed = false, readsSinceInstall = 0, readsBefore = 0, installAttempts = 0, restarted = false, listingsSinceRestart = 0;
  const probes: string[] = [];
  const destinations: string[] = [];
  let away: "removed" | "stale" | null = null;
  const sockets = new Set<{ close(): void }>();
  const listedAfterRestart = Promise.withResolvers<void>();
  const restart = () => { restarted = true; descriptor = { ...descriptor, pid: (remote.replacementPid ?? 4343) as number, token: NEW_TOKEN, bundle_version: remote.replacementBundle ?? REMOTE_BUNDLE_VERSION }; };
  const relays: ReturnType<typeof Bun.serve>[] = [];
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward, connected: SshConnection.prototype.connected };
  const bundle = spyOn(posixHost, "installBundle").mockImplementation(async () => { operations.push("install-bundle"); });
  cleanups.push(() => {
    Object.assign(SshConnection.prototype, real);
    bundle.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  SshConnection.prototype.start = async () => {};
  SshConnection.prototype.close = () => {};
  SshConnection.prototype.connected = () => true;
  SshConnection.prototype.run = async function (this: SshConnection, script: string) {
    destinations.push(this.target.destination);
    const runtime = remote.runtime === undefined ? "bundle-older" : remote.runtime;
    const elsewhere = remote.elsewhere && this.target.destination !== "fixture@pc.invalid";
    const listed = elsewhere ? JSON.stringify({ ...descriptor, pid: 5151, managed_remote: true }) : away === "removed" ? "" : JSON.stringify(descriptor);
    if (script.includes("uname")) return `Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\n${runtime ? `${runtime}\n` : ""}${listed}\n`;
    if (script.includes("socket=")) return SOCKET;
    if (script.includes("--version")) return "herdr 0.9.3";
    if (script.includes("kill -0")) { probes.push(script); return elsewhere || away === "stale" ? "" : "live"; }
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) {
      if (restarted && ++listingsSinceRestart === 2) listedAfterRestart.resolve();
      return listed;
    }
    // a stop, a start or anything else that changes the PC is not this app's to do there
    operations.push(script);
    throw new Error(`Unexpected remote command: ${script}`);
  };
  const heldSessions = new Map<string, { reached: ReturnType<typeof Promise.withResolvers<void>>; gate: ReturnType<typeof Promise.withResolvers<number | object>> }>();
  const rosters = new Map<string, object>();
  const heldHealth = new Map<string, { reached: ReturnType<typeof Promise.withResolvers<void>>; gate: ReturnType<typeof Promise.withResolvers<string>> }>();
  SshConnection.prototype.forward = async function (this: SshConnection, local: number, port: number) {
    expect(port).toBe(REGISTERED_PORT);
    const at = this.target.destination;
    const relay = Bun.serve({ hostname: "127.0.0.1", port: local, async fetch(request, server) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.headers.get("authorization") !== `Bearer ${descriptor.token}`) return new Response("unauthorized", { status: 401 });
      if (remote.redirect?.path === path) return new Response(null, { status: 307, headers: { location: remote.redirect.to } });
      if (path === "/api/access") return remote.access ? Response.json(remote.access) : new Response(remote.access === null ? "unauthorized" : "not found", { status: remote.access === null ? 401 : 404 });
      if (path === "/api/updates" && request.method === "GET" && installed && remote.afterInstall) {
        const { statuses, restartAfter } = remote.afterInstall;
        const answer = { ...remote.status, ...statuses[Math.min(readsSinceInstall, statuses.length - 1)] };
        if (++readsSinceInstall === restartAfter) restart();
        return Response.json(answer);
      }
      if (path === "/api/updates" && request.method === "GET" && !installed && readsBefore < (remote.beforeInstall?.length ?? 0)) {
        const before = remote.beforeInstall![readsBefore++];
        return before === null ? new Response("unavailable", { status: 503 }) : Response.json({ ...remote.status, ...before });
      }
      if (path === "/api/updates" && request.method === "GET") return remote.status ? Response.json(remote.status) : Response.json({ error: { code: "unauthorized", message: "token required" } }, { status: 401 });
      if (path === "/api/updates/cancel" && request.method === "POST") { if ((await request.json() as { install_id?: string }).install_id !== "11111111-2222-4333-8444-555555555555") return Response.json({ error: { code: "invalid_update_cancel" } }, { status: 400 }); if (remote.afterInstall) remote.afterInstall = { statuses: [{ phase: "error", error_code: "update_cancelled", error: "The update was cancelled before it was installed." }] }; return new Response(null, { status: 202 }); }
      if (path === "/api/updates/install" && request.method === "POST") {
        expect(request.headers.get("x-herdr-update")).toBe("1");
        if (remote.installHeld) { remote.installHeld.reached(); await remote.installHeld.gate; }
        installs.push(await request.json());
        const answer = remote.install?.[Math.min(installAttempts++, remote.install.length - 1)] ?? { status: 202 };
        if (answer.code === "update_busy" && remote.afterInstall) installed = true;
        if (answer.status !== 202) return Response.json({ error: { code: answer.code, message: "refused here" } }, { status: answer.status });
        installed = true;
        if (!remote.afterInstall) restart();
        return Response.json({ accepted: true, install_id: "11111111-2222-4333-8444-555555555555" }, { status: 202 });
      }
      if (path === "/api/bridge" && heldBridge) { const held = heldBridge; heldBridge = null; held.reached.resolve(); await held.gate.promise; }
      if (path === "/api/bridge") return Response.json({ ...descriptor, ...(restarted && remote.replacementLiveBundle ? { bundle_version: remote.replacementLiveBundle } : {}), socket_id: "fixture:1", herdr: { version: at === "fixture@pc.invalid" ? "0.9.3" : "0.9.4", protocol: 22 } });
      if (path === "/api/health" && heldHealth.has(at)) {
        const held = heldHealth.get(at)!; heldHealth.delete(at); held.reached.resolve();
        return Response.json({ web_ui: { boot_id: await held.gate.promise } });
      }
      if (path === "/api/session" && heldSessions.has(at)) {
        const held = heldSessions.get(at)!; heldSessions.delete(at); held.reached.resolve();
        const answer = await held.gate.promise;
        if (typeof answer === "object") return Response.json({ snapshot: answer });
        if (answer !== 200) return new Response("unavailable", { status: answer });
      }
      if (path === "/api/session") return Response.json({ snapshot: rosters.get(at) ?? { panes: [], workspaces: [], fixture_at: at, finish_epoch: `run@${at}` } });
      if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    }, websocket: { open(ws) { if (away) ws.close(); else sockets.add(ws); }, close(ws) { sockets.delete(ws); }, message() {} } });
    relays.push(relay);
  };
  const ovis = {
    stop(how: "removed" | "stale") { away = how; for (const socket of sockets) socket.close(); },
    start(patch: Partial<typeof descriptor> = {}) { away = null; descriptor = { ...descriptor, pid: 4545, token: NEW_TOKEN, ...patch }; },
  };
  const bridge = {
    hold() {
      const held = { reached: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() };
      heldBridge = held;
      cleanups.push(() => held.gate.resolve());
      return { reached: held.reached.promise, release: () => held.gate.resolve() };
    },
  };
  const session = {
    hold(at: string) {
      const held = { reached: Promise.withResolvers<void>(), gate: Promise.withResolvers<number | object>() };
      heldSessions.set(at, held);
      cleanups.push(() => held.gate.resolve(200));
      return { reached: held.reached.promise, release: (answer: number | object = 200) => held.gate.resolve(answer) };
    },
    set(at: string, roster: object) { rosters.set(at, roster); },
  };
  const health = {
    hold(at: string) {
      const held = { reached: Promise.withResolvers<void>(), gate: Promise.withResolvers<string>() };
      heldHealth.set(at, held);
      cleanups.push(() => held.gate.resolve(""));
      return { reached: held.reached.promise, release: (boot: string) => held.gate.resolve(boot) };
    },
  };
  mkdirSync(dir, { recursive: true });
  if (options.autoUpdate === false) writeFileSync(join(dir, "machine-settings.json"), JSON.stringify({ auto_update_bridges: false }));
  if (options.registered !== false) writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: MACHINE_ID, name: "Home server", target: { destination: "fixture@pc.invalid" }, enabled: true }]));
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); },
    { ...(options.ownUpdate ? { ownUpdate: options.ownUpdate } : {}), ...(options.now ? { now: options.now } : {}) });
  cleanups.push(() => manager.stop());
  const shown: Machine[] = [];
  cleanups.push(manager.subscribe((event) => {
    const machine = event.type === "machines" ? event.machines.find((m) => m.id === MACHINE_ID) : undefined;
    if (machine) shown.push(structuredClone(machine));
  }));
  const watch = (on: MachineManager) => (done: (machine: Machine) => boolean): Promise<Machine> => new Promise((resolve, reject) => {
    let last: Machine | undefined;
    const timer = setTimeout(() => { stop(); reject(new Error(`PC never reached the state: ${JSON.stringify(last)}`)); }, 4000);
    cleanups.push(() => { clearTimeout(timer); stop(); });
    const stop = on.subscribe((event) => {
      if (event.type !== "machines") return;
      last = event.machines.find((machine) => machine.id === MACHINE_ID);
      if (last && done(last)) { clearTimeout(timer); queueMicrotask(() => stop()); resolve(structuredClone(last)); }
    });
  });
  const until = watch(manager);
  const unsavable = (which: "registrations" | "profiles" = "registrations") => {
    if (which === "profiles") (manager as unknown as { profileState: HerdrProfileState }).profileState.reconcile("unrelated-profile", { destination: "someone@elsewhere.invalid" });
    const path = join(dir, which === "profiles" ? "herdr-profile-state.json" : "machines.json");
    const held = existsSync(path) ? readFileSync(path) : null;
    rmSync(path, { force: true }); mkdirSync(path);
    return () => { rmSync(path, { recursive: true, force: true }); if (held) writeFileSync(path, held, { mode: 0o600 }); };
  };
  const reopen = () => {
    manager.stop();
    const next = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); }, options.now ? { now: options.now } : {});
    cleanups.push(() => next.stop());
    return { manager: next, until: watch(next), now: () => next.list().find((machine) => machine.id === MACHINE_ID)! };
  };
  const stored = () => (JSON.parse(readFileSync(join(dir, "machines.json"), "utf8")) as { id: string; target: unknown; snapshot?: unknown }[]).find((m) => m.id === MACHINE_ID);
  const saved = () => stored()?.target;
  const settled = async (job: SetupJob) => {
    await (manager as unknown as { jobs: Map<string, { finished: Promise<void> }> }).jobs.get(job.id)?.finished;
    return manager.job(job.id)!;
  };
  const now = () => manager.list().find((machine) => machine.id === MACHINE_ID)!;
  return { manager, requests, installs, operations, probes, destinations, saved, stored, unsavable, reopen, settled, now, listedAfterRestart: listedAfterRestart.promise, until, ovis, bridge, session, health, shown };
}

describe("a PC whose own Ovis is away (#2047)", () => {
  for (const how of ["removed", "stale"] as const) for (const runtime of [null, "bundle-ready"] as const) {
    it(`waits for it, starting nothing in its place, and reconnects once it is back (descriptor ${how}${runtime ? ", this app's runtime on the PC" : ""})`, async () => {
      let clock = 0;
      const { manager, ovis, operations, installs, until, shown } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, runtime }, { now: () => clock });
      await until((machine) => machine.state === "connected");
      ovis.stop(how);
      await until((machine) => machine.state === "reconnecting" && machine.error === "SSH bridge connection interrupted");
      clock += 10_000; manager.retryNow(MACHINE_ID);
      const waiting = await until((machine) => machine.state === "reconnecting" && /own Ovis is not running/.test(machine.error ?? ""));
      expect(waiting.action_required ?? null).toBeNull();
      ovis.start();
      clock += 10_000; manager.retryNow(MACHINE_ID);
      await until((machine) => machine.state === "connected");
      expect(manager.endpoint(MACHINE_ID)?.token).toBe(NEW_TOKEN);
      expect(shown.filter((machine) => machine.action_required)).toEqual([]);
      expect(operations).toEqual([]);
      expect(installs).toEqual([]);
    });
  }

  // A setup at another SSH address is the user's to review there: the PC moves only once it connects there, and one
  // cancelled or failed leaves it at its own address, where it waits for its own Ovis (#2075)
  for (const runtime of ["bundle-ready", null] as const) {
    it(`${runtime ? "a ready runtime" : "nothing of this app's"} at another address, cancelled at approval, starts nothing and leaves the PC at its own`, async () => {
      let clock = 0;
      const { manager, ovis, operations, destinations, saved, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, runtime }, { now: () => clock });
      await until((machine) => machine.state === "connected");
      ovis.stop("removed");
      await until((machine) => machine.state === "reconnecting");
      const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid", update_remote: true });
      await until(() => manager.job(job.id)?.phase === "approval");
      manager.action(job.id, { action: "cancel" });
      await until((machine) => machine.state === "reconnecting" && !machine.updating);
      destinations.length = 0;
      clock += 10_000; manager.retryNow(MACHINE_ID);
      const waiting = await until((machine) => !!machine.error && !machine.updating);
      expect(operations).toEqual([]);
      expect(waiting).toMatchObject({ state: "reconnecting", target: { destination: "fixture@pc.invalid" }, error: expect.stringContaining("own Ovis is not running") });
      expect(new Set(destinations)).toEqual(new Set(["fixture@pc.invalid"]));
      manager.patch(MACHINE_ID, { name: "Home server" });
      expect(saved()).toEqual({ destination: "fixture@pc.invalid" });
    });
  }

  it("keeps knowing of its own Ovis when a setup at another address, which ran this app's bridge, is cancelled", async () => {
    let clock = 0;
    const { manager, ovis, operations, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, runtime: "bundle-ready", elsewhere: "stale-bridge" }, { now: () => clock });
    await until((machine) => machine.state === "connected");
    ovis.stop("removed");
    await until((machine) => machine.state === "reconnecting");
    const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid", update_remote: true });
    await until(() => manager.job(job.id)?.phase === "approval");
    manager.action(job.id, { action: "cancel" });
    await until((machine) => machine.state === "reconnecting" && !machine.updating);
    clock += 10_000; manager.retryNow(MACHINE_ID);
    const waiting = await until((machine) => !!machine.error && !machine.updating);
    expect(operations).toEqual([]);
    expect(waiting).toMatchObject({ state: "reconnecting", error: expect.stringContaining("own Ovis is not running") });
  });

  it("leaves the PC at its own address when a setup at another one fails after its approval, and tries only its own again", async () => {
    let clock = 0;
    const { manager, ovis, operations, destinations, saved, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, runtime: "bundle-ready" }, { now: () => clock });
    await until((machine) => machine.state === "connected");
    ovis.stop("removed");
    await until((machine) => machine.state === "reconnecting");
    const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid", update_remote: true });
    await until(() => manager.job(job.id)?.phase === "approval");
    manager.action(job.id, { action: "approve" });
    const left = await until((machine) => !machine.updating && machine.state !== "connecting");
    expect(manager.job(job.id)).toMatchObject({ phase: "failed", error: expect.stringContaining("Unexpected remote command") });
    // what was approved there, and only that: the runtime's install, then the start that failed
    expect(operations).toEqual(["install-bundle", expect.stringContaining('ovis-server" remote')]);
    const approved = [...operations];
    expect(left).toMatchObject({ state: "reconnecting", target: { destination: "fixture@pc.invalid" } });
    expect(left.action_required ?? null).toBeNull();
    destinations.length = 0;
    clock += 10_000; manager.retryNow(MACHINE_ID);
    await until((machine) => machine.state === "reconnecting" && /own Ovis is not running/.test(machine.error ?? ""));
    manager.updateBridge(MACHINE_ID);
    await until((machine) => !machine.updating && /own Ovis is not running/.test(machine.error ?? ""));
    expect(new Set(destinations)).toEqual(new Set(["fixture@pc.invalid"]));
    expect(operations).toEqual(approved);
    manager.patch(MACHINE_ID, { name: "Home server" });
    expect(saved()).toEqual({ destination: "fixture@pc.invalid" });
  });

  for (const end of ["cancelled", "failed"] as const) {
    it(`keeps its own herdr and roster when a setup at another address is ${end} on that address's first roster read`, async () => {
      const { manager, session, stored, settled, now, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION });
      await until((machine) => machine.state === "connected");
      expect(now()).toMatchObject({ herdr: { version: "0.9.3" }, snapshot: { fixture_at: "fixture@pc.invalid" } });
      const held = session.hold("other@second.invalid");
      const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid" });
      await held.reached;
      if (end === "cancelled") { manager.action(job.id, { action: "cancel" }); held.release(); } else held.release(500);
      expect((await settled(job)).phase).toBe(end);
      expect(now()).toMatchObject({ target: { destination: "fixture@pc.invalid" }, herdr: { version: "0.9.3" }, snapshot: { fixture_at: "fixture@pc.invalid" } });
      manager.patch(MACHINE_ID, { name: "Home server" });
      expect(stored()).toMatchObject({ target: { destination: "fixture@pc.invalid" }, snapshot: { fixture_at: "fixture@pc.invalid" } });
    });
  }

  it("keeps its own offer and words when a setup at another address fails while the PC is disabled", async () => {
    const { manager, settled, now, until } = pc({ status: managedOffer() }, { autoUpdate: false });
    const offered = await until((machine) => machine.action_required === "update_bridge");
    manager.patch(MACHINE_ID, { enabled: false });
    const job = await settled(manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid" }));
    expect(job).toMatchObject({ phase: "failed", action_required: "update_bridge", remote_ovis: { address: `second.invalid:${REGISTERED_PORT}` } });
    expect(now()).toMatchObject({ enabled: false, state: "disconnected", target: { destination: "fixture@pc.invalid" }, action_required: "update_bridge", error: offered.error, remote_ovis: offered.remote_ovis! });
  });

  it("keeps its own offer while a setup at another address waits for approval there, and when it is disabled meanwhile", async () => {
    const { manager, settled, now, until } = pc({ status: managedOffer() }, { autoUpdate: false });
    const offered = await until((machine) => machine.action_required === "update_bridge");
    expect(offered.remote_ovis).toMatchObject({ address: `pc.invalid:${REGISTERED_PORT}` });
    const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid", update_remote: true });
    await until(() => manager.job(job.id)?.phase === "approval");
    expect(manager.job(job.id)?.remote_ovis).toMatchObject({ address: `second.invalid:${REGISTERED_PORT}` });
    expect(now().remote_ovis).toEqual(offered.remote_ovis!);
    manager.patch(MACHINE_ID, { enabled: false });
    expect((await settled(job)).phase).toBe("cancelled");
    expect(now()).toMatchObject({ enabled: false, target: { destination: "fixture@pc.invalid" }, action_required: "update_bridge", remote_ovis: offered.remote_ovis! });
  });

  for (const fault of ["a roster it cannot read", "a move it cannot save", "a save of the herdr profiles' state that fails"] as const) {
    it(`stays at its own address when a setup at another address connects there but ends on ${fault}, also after a restart`, async () => {
      let clock = 0;
      const remote: Remote = { status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, runtime: "bundle-ready" };
      const { manager, session, operations, destinations, unsavable, reopen, stored, settled, now, until } = pc(remote, { now: () => clock });
      await until((machine) => machine.state === "connected");
      const held = session.hold("other@second.invalid");
      const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid" });
      await held.reached;
      let writable = () => {};
      if (fault === "a roster it cannot read") held.release({ panes: null, workspaces: [] });
      else { writable = unsavable(fault === "a move it cannot save" ? "registrations" : "profiles"); held.release(); }
      expect((await settled(job)).phase).toBe("failed");
      expect(now()).toMatchObject({ target: { destination: "fixture@pc.invalid" }, herdr: { version: "0.9.3" }, snapshot: { fixture_at: "fixture@pc.invalid" } });
      writable();
      expect(stored()).toMatchObject({ target: { destination: "fixture@pc.invalid" } });
      destinations.length = 0;
      clock += 10_000; manager.retryNow(MACHINE_ID);
      await until((machine) => machine.state === "connected");
      expect(new Set(destinations)).toEqual(new Set(["fixture@pc.invalid"]));
      expect(manager.finishEnded(MACHINE_ID, "run@other@second.invalid")).toBe(false);
      remote.elsewhere = "stale-bridge";
      destinations.length = 0;
      const after = reopen();
      expect(after.now().target).toEqual({ destination: "fixture@pc.invalid" });
      await after.until((machine) => machine.state === "connected");
      expect(new Set(destinations)).toEqual(new Set(["fixture@pc.invalid"]));
      expect(operations).toEqual([]);
    });
  }

  it("moves to another address once a setup connects there, with that address's herdr, roster and own Ovis", async () => {
    let clock = 0;
    const { manager, ovis, operations, destinations, stored, settled, now, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, runtime: "bundle-ready" }, { now: () => clock });
    await until((machine) => machine.state === "connected");
    ovis.stop("removed");
    await until((machine) => machine.state === "reconnecting" && machine.error === "SSH bridge connection interrupted");
    ovis.start();
    expect((await settled(manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid" }))).phase).toBe("connected");
    const moved = { target: { destination: "other@second.invalid" }, snapshot: { fixture_at: "other@second.invalid" } };
    expect(now()).toMatchObject({ ...moved, state: "connected", herdr: { version: "0.9.4" }, error: null });
    expect(stored()).toMatchObject(moved);
    ovis.stop("removed");
    await until((machine) => machine.state === "reconnecting");
    destinations.length = 0;
    clock += 10_000; manager.retryNow(MACHINE_ID);
    await until((machine) => machine.state === "reconnecting" && /own Ovis is not running/.test(machine.error ?? ""));
    expect(new Set(destinations)).toEqual(new Set(["other@second.invalid"]));
    expect(operations).toEqual([]);
  });

  it("takes none of its own address's roster to another while the roster there waits for that server's health", async () => {
    const { manager, session, health, stored, settled, now, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION });
    await until((machine) => machine.state === "connected");
    expect(now().snapshot).toMatchObject({ fixture_at: "fixture@pc.invalid" });
    const roster = session.hold("other@second.invalid");
    const proof = health.hold("other@second.invalid");
    const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid" });
    await roster.reached;
    roster.release({ panes: [], workspaces: [], order_epoch: "boot-b", read_seq: 1, fixture_at: "other@second.invalid" });
    expect((await settled(job)).phase).toBe("connected");
    await proof.reached;
    expect(now()).toMatchObject({ state: "connected", target: { destination: "other@second.invalid" }, snapshot: null });
    expect(stored()).toMatchObject({ target: { destination: "other@second.invalid" } });
    expect(stored()?.snapshot ?? null).toBeNull();
    proof.release("boot-b");
    const adopted = await until((machine) => machine.snapshot?.order_epoch === "boot-b");
    expect(adopted.snapshot).toMatchObject({ fixture_at: "other@second.invalid" });
    manager.patch(MACHINE_ID, { name: "Home server" });
    expect(stored()).toMatchObject({ target: { destination: "other@second.invalid" }, snapshot: { fixture_at: "other@second.invalid" } });
  });

  it("keeps a moved PC's herdr run its own server's once the move connects, so a later read of that server ends it for good (#2206)", async () => {
    const { manager, session, health, settled, now, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION });
    await until((machine) => machine.state === "connected");
    const roster = (finish_epoch: string) => ({ panes: [], workspaces: [], order_epoch: "boot-b", read_seq: 1, finish_epoch, fixture_at: "other@second.invalid" });
    session.set("other@second.invalid", roster("B"));
    const read = session.hold("other@second.invalid");
    const job = manager.setup({ machine_id: MACHINE_ID, destination: "other@second.invalid" });
    await read.reached;
    const proof = health.hold("other@second.invalid");
    const asked = manager.verifySourceBoot(MACHINE_ID);
    await proof.reached;
    proof.release("boot-b");
    expect(await asked).toEqual({ boot_id: "boot-b" });
    read.release();
    expect((await settled(job)).phase).toBe("connected");
    expect(now().snapshot).toMatchObject({ order_epoch: "boot-b", finish_epoch: "B" });
    const drive = manager as unknown as { machines: Map<string, unknown>; refresh(runtime: unknown): Promise<void> };
    session.set("other@second.invalid", roster("C"));
    await drive.refresh(drive.machines.get(MACHINE_ID));
    expect(now().snapshot?.finish_epoch).toBe("C");
    session.set("other@second.invalid", roster("B"));
    await drive.refresh(drive.machines.get(MACHINE_ID));
    expect(now().snapshot?.finish_epoch).toBe("C");
    expect(manager.finishEnded(MACHINE_ID, "B")).toBe(true);
  });

  it("is not unlearnt by an update cancelled before it answered: once that Ovis is away, the PC waits for it", async () => {
    let clock = 0;
    const { manager, ovis, bridge, operations, until } = pc({ status: managedOffer(), bundle: REMOTE_BUNDLE_VERSION, managed: true, runtime: "bundle-ready" }, { now: () => clock });
    await until((machine) => machine.state === "connected");
    const held = bridge.hold();
    const job = manager.updateBridge(MACHINE_ID);
    await held.reached;
    manager.action(job.id, { action: "cancel" });
    ovis.start({ managed_remote: false });
    manager.patch(MACHINE_ID, { enabled: false });
    manager.patch(MACHINE_ID, { enabled: true });
    await until((machine) => machine.state === "connected");
    held.release();
    await until((machine) => machine.state === "connected" && !machine.updating);
    ovis.stop("removed");
    await until((machine) => machine.state === "reconnecting");
    clock += 10_000; manager.retryNow(MACHINE_ID);
    await until((machine) => machine.state === "reconnecting" && /own Ovis is not running/.test(machine.error ?? ""));
    expect(operations).toEqual([]);
  });

  it("installs and starts nothing in its place when its update is tapped while it is away", async () => {
    const { manager, ovis, operations, installs, until } = pc({ status: managedOffer() }, { autoUpdate: false });
    await until((machine) => machine.action_required === "update_bridge");
    ovis.stop("removed");
    const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/${MACHINE_ID}/update-bridge`, {
      method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "x-herdr-update": "1" } }), manager, undefined, undefined, false, undefined, undefined, undefined, undefined, true);
    expect(response.status).toBeLessThan(300);
    const waiting = await until((machine) => machine.state === "reconnecting" && !machine.updating && /own Ovis is not running/.test(machine.error ?? ""));
    expect(waiting.action_required ?? null).toBeNull();
    expect(operations).toEqual([]);
    expect(installs).toEqual([]);
  });
});

describe("a PC whose own Ovis is older than this app", () => {
  it("updates itself through its own updater on reconnect, with automatic updates on, then connects", async () => {
    const { manager, installs, operations, until } = pc({ status: managedOffer(), access: { port: OWN_PORT, tailscale: { serving_url: null } } });
    const connected = await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
    expect(operations).toEqual([]);
    expect(connected.remote_ovis ?? null).toBeNull();
    expect(connected.action_required ?? null).toBeNull();
    expect(manager.endpoint(MACHINE_ID)?.token).toBe(NEW_TOKEN);
  });

  it("offers the update on the PC's card and waits when automatic updates are off", async () => {
    const { manager, installs, until } = pc({ status: managedOffer(), access: { port: OWN_PORT, tailscale: { serving_url: null } } }, { autoUpdate: false });
    const waiting = await until((machine) => machine.action_required === "update_bridge");
    expect(waiting.remote_ovis).toEqual({ version: "0.4.16", latest_version: "0.4.18", updatable: true, reason: null, address: `pc.invalid:${OWN_PORT}`, url: null });
    expect(waiting.error).toContain("own Ovis v0.4.16");
    expect(installs).toEqual([]);
    const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/${MACHINE_ID}/update-bridge`, {
      method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "x-herdr-update": "1" } }), manager, undefined, undefined, false, undefined, undefined, undefined, undefined, true);
    expect(response.status).toBeLessThan(300);
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("updates it through the one route the devices list uses, and keeps why a failed update failed on its card", async () => {
    const { manager, installs, until } = pc({ status: managedOffer(), afterInstall: { statuses: [{ phase: "building", step: "dependencies" }, { phase: "error", error: "bun install failed (exit 1)" }] } }, { autoUpdate: false, ownUpdate: { pollMs: 5 } });
    const waiting = await until((machine) => machine.action_required === "update_bridge");
    expect(waiting.ovis_update).toEqual({ how: "own", current_version: "0.4.16", latest_version: "0.4.18", updatable: true, reason: null, revision: OFFERED });
    const update = () => handleMachineRequest(new Request(`http://localhost:7317/api/machines/${MACHINE_ID}/update`, { method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "x-herdr-update": "1" } }), manager, undefined, undefined, false, undefined, undefined, undefined, undefined, true);
    const response = await update();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ job_id: expect.any(String) });
    const failed = await until((machine) => machine.state === "error" && !machine.updating);
    expect(failed.update_error).toMatch(/could not update itself: bun install failed/);
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
    expect(failed.ovis_update?.updatable).toBe(true);
    expect((await update()).status).toBe(202);
    expect(manager.list().find((machine) => machine.id === MACHINE_ID)?.update_error).toBeNull();
  });

  it("installs only the release it showed: one the PC offers instead by the time it is asked is refused, never installed", async () => {
    const remote: Remote = { status: managedOffer(), access: { port: OWN_PORT, tailscale: { serving_url: null } } };
    const { manager, installs, until } = pc(remote, { autoUpdate: false, ownUpdate: { pollMs: 5 } });
    const waiting = await until((machine) => machine.action_required === "update_bridge");
    expect(waiting.ovis_update?.revision).toBe(OFFERED);
    remote.status = managedOffer({ latest_revision: "e".repeat(40), latest_version: "0.4.19" });
    const asked = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/${MACHINE_ID}/update`, { method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ revision: OFFERED }) }), manager, undefined, undefined, false, undefined, undefined, undefined, undefined, true);
    expect(asked.status).toBe(202);
    const failed = await until((machine) => !machine.updating && typeof machine.update_error === "string");
    expect(failed.update_error).toContain("another release now than the one shown");
    expect(installs).toEqual([]);
  });

  it("shows the update a connected PC's own Ovis of this app's version offers, read through its tunnel", async () => {
    const { until } = pc({ status: managedOffer({ current_version: "0.5.0", latest_version: "0.5.1" }), bundle: REMOTE_BUNDLE_VERSION });
    const connected = await until((machine) => machine.state === "connected" && machine.ovis_update != null);
    expect(connected.ovis_update).toEqual({ how: "own", current_version: "0.5.0", latest_version: "0.5.1", updatable: true, reason: null, revision: OFFERED });
  });

  it("never asks that PC to stop its update when the PC is removed here: only a cancel asked for does", async () => {
    const { manager, requests, until } = pc({ status: managedOffer({ install_cancellable: true }), afterInstall: { statuses: [{ phase: "building", step: "build" }] } }, { ownUpdate: { pollMs: 5 } });
    const building = await until((machine) => /updating itself/.test(machine.updating?.step ?? ""));
    const jobs = (manager as unknown as { jobs: Map<string, { cancelling?: Promise<void> }> }).jobs;
    manager.remove(building.id);
    expect([...jobs.values()].some((job) => job.cancelling !== undefined)).toBe(false);
    expect(requests).not.toContain("POST /api/updates/cancel");
  });

  it("never asks that PC to stop its update when this server stops (its own restart, say): only a cancel asked for here does", async () => {
    const { manager, requests, until } = pc({ status: managedOffer({ install_cancellable: true }), afterInstall: { statuses: [{ phase: "building", step: "build" }] } }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => /updating itself/.test(machine.updating?.step ?? ""));
    const jobs = (manager as unknown as { jobs: Map<string, { cancelling?: Promise<void> }> }).jobs;
    manager.stop();
    expect([...jobs.values()].some((job) => job.cancelling !== undefined)).toBe(false);
    expect(requests).not.toContain("POST /api/updates/cancel");
  });

  it("says an update cancelled while the answer to its install request is on its way may still finish there, and stops nothing it cannot name", async () => {
    const arrived = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const { manager, requests, until } = pc({ status: managedOffer({ install_cancellable: true }), afterInstall: { statuses: [{ phase: "building", step: "build" }] }, installHeld: { reached: () => arrived.resolve(), gate: gate.promise } }, { ownUpdate: { pollMs: 5 } });
    await arrived.promise;
    const machine = manager.list().find((pc) => pc.updating)!;
    expect(manager.cancelUpdate(machine.id)).toBe(true);
    gate.resolve();
    const jobs = (manager as unknown as { jobs: Map<string, { public: { error: string | null } }> }).jobs;
    await until(() => [...jobs.values()].some((job) => /may still finish it there/.test(job.public.error ?? "")));
    // never a cancel without the install's id: it could stop another device's install
    expect(requests).not.toContain("POST /api/updates/cancel");
  });


  it("asks that PC to stop its update when the update is cancelled here while it builds, over the job's own connection", async () => {
    const { manager, requests, until } = pc({ status: managedOffer({ install_cancellable: true }), afterInstall: { statuses: [{ phase: "building", step: "build" }] } }, { ownUpdate: { pollMs: 5 } });
    const building = await until((machine) => /updating itself/.test(machine.updating?.step ?? ""));
    const close = SshConnection.prototype.close;
    SshConnection.prototype.close = function (this: SshConnection) { requests.push("SSH CLOSE"); return close.call(this); };
    cleanups.push(() => { SshConnection.prototype.close = close; });
    const from = requests.length;
    expect(manager.cancelUpdate(building.id)).toBe(true);
    await until(() => requests.includes("POST /api/updates/cancel"));
    const after = requests.slice(from);
    expect(after.indexOf("POST /api/updates/cancel")).toBeLessThan(after.includes("SSH CLOSE") ? after.indexOf("SSH CLOSE") : Infinity);
    const ended = await until((machine) => !machine.updating);
    expect(ended.update_error ?? "").not.toContain("may still finish");
  });

  it("follows an install that its own Settings already started instead of failing", async () => {
    const { installs, until } = pc({ status: managedOffer(), install: [{ status: 409, code: "update_busy" }],
      afterInstall: { statuses: [{ phase: "building", step: "build" }], restartAfter: 2 } }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  const checking = { phase: "checking" as const, available: false, latest_revision: null };
  for (const [when, beforeInstall] of [["when it is asked what it offers", [checking, checking, checking]], ["when the update starts", [{}, {}, checking, checking]]] as const) it(`waits out a check for releases running there ${when}, then asks for the install`, async () => {
    const { installs, until } = pc({ status: managedOffer(), beforeInstall: [...beforeInstall] }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("waits for a just-started updater's first check instead of taking it as offering nothing, then updates", async () => {
    const fresh = { checked_at: null, available: false, latest_revision: null, latest_version: null };
    const { installs, until } = pc({ status: managedOffer(), beforeInstall: [fresh, fresh] }, { ownUpdate: { pollMs: 5, checkMs: 2000 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("does not wait on an updater whose check failed, as one that cannot reach its releases never gets a check time", async () => {
    const failed = managedOffer({ phase: "error", error: "fetch failed", checked_at: null, available: false, latest_revision: null, latest_version: null });
    const { until } = pc({ status: failed }, { ownUpdate: { pollMs: 5, checkMs: 10_000 } });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.remote_ovis?.updatable).toBe(false);
  });

  it("tries again on its own, not waiting for a tap, when a check for releases there outlasts its wait", async () => {
    const { installs, until } = pc({ status: managedOffer(), beforeInstall: Array.from({ length: 10_000 }, () => checking) }, { ownUpdate: { pollMs: 5, checkMs: 20 } });
    const waiting = await until((machine) => machine.state === "reconnecting" && /still checking for updates/.test(machine.error ?? ""));
    expect(waiting.action_required ?? null).toBeNull();
    expect(installs).toEqual([]);
  });

  it("tries again on its own, not waiting for a tap, when a check for releases there outlasts its wait inside the update", async () => {
    const { installs, until } = pc({ status: managedOffer(), beforeInstall: [{}, {}, ...Array.from({ length: 10_000 }, () => checking)] }, { ownUpdate: { pollMs: 5, checkMs: 20 } });
    const waiting = await until((machine) => machine.state === "reconnecting" && !machine.updating && /still checking for updates/.test(machine.error ?? ""));
    expect(waiting.action_required ?? null).toBeNull();
    expect(installs).toEqual([]);
  });

  it("asks again when a check that started since it read the status made it answer busy", async () => {
    const { installs, until } = pc({ status: managedOffer(), install: [{ status: 409, code: "update_busy" }, { status: 202 }] }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }, { expected_revision: OFFERED }]);
  });

  for (const path of ["/api/updates", "/api/updates/install"]) it(`never follows a redirect from ${path} out of the tunnel`, async () => {
    // a server on this PC's own loopback that a followed redirect would reach
    const hits: string[] = [];
    const canary = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { hits.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ accepted: true }, { status: 202 }); } });
    cleanups.push(() => canary.stop(true));
    const { until } = pc({ status: managedOffer(), redirect: { path, to: `http://127.0.0.1:${canary.port}/api/herdr/update` } }, { ownUpdate: { pollMs: 5 } });
    const stopped = await until((machine) => !machine.updating && /\(307\)/.test(machine.error ?? ""));
    expect(stopped.state).toBe("error");
    expect(hits).toEqual([]);
  });

  it("tells an update that ended on another version as a setup that keeps where it answers, with no update on offer beside it", async () => {
    const { manager, installs, until } = pc({ status: managedOffer(), replacementBundle: "36", access: { port: OWN_PORT, tailscale: { serving_url: "https://home-server.example.ts.net" } } }, { ownUpdate: { pollMs: 5 } });
    const running = await until((machine) => !!machine.updating);
    const waiting = await until((machine) => machine.action_required === "setup" && !machine.updating);
    expect(waiting.error).toContain("still differs from this app's (v36");
    const refused = { version: null, latest_version: null, updatable: false, reason: waiting.error, address: `pc.invalid:${OWN_PORT}`, url: "https://home-server.example.ts.net" };
    expect(waiting.remote_ovis).toEqual(refused);
    expect(manager.job(running.updating!.job_id)).toMatchObject({ phase: "failed", action_required: "setup", remote_ovis: refused });
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("tells an update that ended on a newer version than this app's as an update of this app, with nothing on offer beside it", async () => {
    const { manager, installs, until } = pc({ status: managedOffer(), replacementBundle: String(Number(REMOTE_BUNDLE_VERSION) + 1), access: { port: OWN_PORT, tailscale: { serving_url: null } } }, { ownUpdate: { pollMs: 5 } });
    const running = await until((machine) => !!machine.updating);
    const waiting = await until((machine) => machine.action_required === "setup" && !machine.updating);
    expect(waiting.error).toContain("Update this app in Settings");
    expect(waiting.remote_ovis ?? null).toBeNull();
    expect(manager.job(running.updating!.job_id)).toMatchObject({ phase: "failed", action_required: "setup", remote_ovis: null });
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("keeps where it answers when its updated bridge answers an older version than it registered", async () => {
    const { manager, until } = pc({ status: managedOffer(), replacementLiveBundle: String(Number(REMOTE_BUNDLE_VERSION) - 1), access: { port: OWN_PORT, tailscale: { serving_url: "https://home-server.example.ts.net" } } }, { ownUpdate: { pollMs: 5 } });
    const running = await until((machine) => !!machine.updating);
    const waiting = await until((machine) => machine.action_required === "setup" && !machine.updating);
    expect(waiting.error).toContain("Update it through its own Settings");
    const refused = { version: null, latest_version: null, updatable: false, reason: waiting.error, address: `pc.invalid:${OWN_PORT}`, url: "https://home-server.example.ts.net" };
    expect(waiting.remote_ovis).toEqual(refused);
    expect(manager.job(running.updating!.job_id)).toMatchObject({ phase: "failed", action_required: "setup", remote_ovis: refused });
  });

  it("takes only a process id from its new bridge's descriptor into a command on that PC", async () => {
    const { probes, listedAfterRestart } = pc({ status: managedOffer(), replacementPid: "1; kill -TERM 4242; #",
      afterInstall: { statuses: [{ phase: "building", step: "build" }], restartAfter: 1 } }, { ownUpdate: { pollMs: 5 } });
    await listedAfterRestart;
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((script) => /^kill -0 \d+ /.test(script))).toBe(true);
  });

  it("waits out an earlier failure its status still shows right after it was asked, then connects", async () => {
    const earlier = { phase: "error" as const, error: "bun run build failed (exit 1)" };
    const { installs, until } = pc({ status: managedOffer(earlier),
      afterInstall: { statuses: [earlier, earlier, { phase: "building", step: "build", error: null }], restartAfter: 4 } }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  const failures: [string, Remote["status"], Partial<UpdateStatus>[], RegExp][] = [
    ["once its install ran", managedOffer(), [{ phase: "building", step: "dependencies" }, { phase: "error", error: "bun install failed (exit 1)" }], /could not update itself: bun install failed/],
    ["in other words than the earlier one, before it was seen running", managedOffer({ phase: "error", error: "an earlier failure" }), [{ phase: "error", error: "git fetch failed" }], /could not update itself: git fetch failed/],
  ];
  for (const [name, status, statuses, reason] of failures) it(`fails with that PC's words when it reports an error ${name}`, async () => {
    const { installs, until } = pc({ status, afterInstall: { statuses } }, { ownUpdate: { pollMs: 5 } });
    const failed = await until((machine) => machine.state === "error" && !machine.updating && reason.test(machine.error ?? ""));
    expect(failed.action_required).toBe("update_bridge");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("fails with the reason when the install it asked for never starts", async () => {
    const { installs, until } = pc({ status: managedOffer(), afterInstall: { statuses: [{ phase: "idle" }] } }, { ownUpdate: { pollMs: 5, startMs: 50 } });
    const failed = await until((machine) => machine.state === "error" && !machine.updating && /did not start its update/.test(machine.error ?? ""));
    expect(failed.error).toContain("Settings → Updates");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  const refusals: [string, Remote, RegExp, "replace" | "restart" | null][] = [
    ["not started by its updater", { status: { ...unmanagedUpdateStatus() } }, /does not update itself: Start with bun run start/, "replace"],
    ["the desktop app's server", { status: { ...unmanagedUpdateStatus(true) } }, /updates come with the app/, null],
    ["blocked there", { status: managedOffer({ blocked_reason: "The source checkout changed. Restart the app before updating." }) }, /cannot update itself now: The source checkout changed/, null],
    ["asks for its own token", { status: null }, /OVIS_TOKEN/, null],
    ["too old to install a named revision", { status: managedOffer({ revision_bound_install: undefined }) }, /too old to take an update/, "restart"],
    ["too old, with no newer release a restart would install", { status: managedOffer({ revision_bound_install: undefined, available: false, latest_revision: null, checked_at: "2026-11-08T00:00:00.000Z" }) }, /too old to take an update/, null],
    ["without a newer release on offer", { status: managedOffer({ available: false, latest_revision: null, checked_at: "2026-11-08T00:00:00.000Z" }) }, /no newer release on offer than v0\.4\.16/, null],
  ];
  for (const [name, remote, reason, fix] of refusals) it(`says why it cannot be updated from here when it is ${name}`, async () => {
    const { manager, installs, operations, until } = pc({ ...remote, access: { port: OWN_PORT, tailscale: { serving_url: "https://home-server.example.ts.net" } } });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.state).toBe("error");
    expect(waiting.error).toContain("independently managed web server");
    expect(waiting.error).toMatch(reason);
    expect(waiting.remote_ovis).toMatchObject({ updatable: false, address: `pc.invalid:${OWN_PORT}`, url: "https://home-server.example.ts.net" });
    expect(waiting.remote_ovis?.reason).toMatch(reason);
    const asked = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/${MACHINE_ID}/update`, { method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "x-herdr-update": "1" } }), manager, undefined, undefined, false, undefined, undefined, undefined, undefined, true);
    if (fix) {
      expect(waiting.ovis_update).toMatchObject({ how: "install", updatable: true, reason: null });
      expect(waiting.ovis_update?.steps?.[0]).toContain("process 4242");
      if (fix === "restart") expect(waiting.ovis_update?.revision).toBe(OFFERED);
      expect(asked.status).toBe(202);
      const { job_id } = await asked.json() as { job_id: string };
      expect(manager.installJob(job_id)).toMatchObject({ machine_id: MACHINE_ID, mode: fix, target: { destination: "fixture@pc.invalid" } });
      manager.cancelInstall(job_id);
    } else {
      expect(waiting.ovis_update).toMatchObject({ how: "own", updatable: false });
      expect(waiting.ovis_update?.reason).toMatch(reason);
      expect(asked.status).toBe(409);
      expect((await asked.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "update_unavailable", message: expect.stringMatching(reason) });
    }
    expect(installs).toEqual([]);
    expect(operations).toEqual([]);
  });

  it("keeps a restart's offer and the release it names while that PC's Ovis is away, as when the restart stopped it", async () => {
    let clock = 0;
    const { manager, ovis, until } = pc({ status: managedOffer({ revision_bound_install: undefined }) }, { now: () => clock });
    const offered = await until((machine) => machine.action_required === "setup");
    expect(offered.ovis_update).toMatchObject({ how: "install", updatable: true, revision: OFFERED });
    ovis.stop("removed");
    const internals = manager as unknown as { machines: Map<string, unknown>; reconnect(runtime: unknown): Promise<void> };
    clock += 10_000; void internals.reconnect(internals.machines.get(MACHINE_ID));
    const away = await until((machine) => /own Ovis is not running/.test(machine.error ?? ""));
    expect(away.ovis_update).toMatchObject({ how: "install", updatable: true, revision: OFFERED });
  });

  it("keeps a newer one's message, asks it nothing about its updates and links no address it did not give", async () => {
    const { requests, until } = pc({ status: managedOffer(), bundle: String(Number(REMOTE_BUNDLE_VERSION) + 1) });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.error).toContain("of a newer version");
    expect(waiting.error).toContain("Update this app in Settings");
    expect(waiting.remote_ovis ?? null).toBeNull();
    expect(requests.filter((request) => request.includes("/api/updates"))).toEqual([]);
  });

  it("links only an https address the PC names, and its own port over the registered one", async () => {
    const { until } = pc({ status: { ...unmanagedUpdateStatus() }, access: { port: OWN_PORT, tailscale: { serving_url: "http://plain.example" } } });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.remote_ovis).toMatchObject({ address: `pc.invalid:${OWN_PORT}`, url: null });
  });

  it("takes where it answers from its update status when its GET /api/access wants its own token (#2191)", async () => {
    const { requests, until } = pc({ status: managedOffer({ port: OWN_PORT, serving_url: "https://home-server.example.ts.net" }), access: null }, { autoUpdate: false });
    const waiting = await until((machine) => machine.action_required === "update_bridge");
    expect(waiting.remote_ovis).toMatchObject({ updatable: true, address: `pc.invalid:${OWN_PORT}`, url: "https://home-server.example.ts.net" });
    // it told both with its status: the route its token keeps closed to the bridge's is not asked
    expect(requests).not.toContain("GET /api/access");
  });

  it("keeps where it answers when a read after a check for releases fails", async () => {
    const { until } = pc({ status: managedOffer({ port: OWN_PORT, serving_url: "https://home-server.example.ts.net" }), access: null,
      beforeInstall: [{ phase: "checking", available: false, latest_revision: null }, null] }, { autoUpdate: false, ownUpdate: { pollMs: 5 } });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.remote_ovis).toMatchObject({ updatable: false, address: `pc.invalid:${OWN_PORT}`, url: "https://home-server.example.ts.net" });
    expect(waiting.remote_ovis?.reason).toMatch(/did not tell its update status \(503\)/);
  });

  it("tells a first connect the same, on the job the dialog reads", async () => {
    const { manager, installs } = pc({ status: managedOffer() }, { registered: false });
    const job = manager.setup({ destination: "fixture@pc.invalid" });
    await (manager as unknown as { jobs: Map<string, { finished: Promise<void> }> }).jobs.get(job.id)?.finished;
    const failed = manager.job(job.id) as SetupJob;
    expect(failed).toMatchObject({ phase: "failed", action_required: "update_bridge", remote_ovis: { updatable: true, latest_version: "0.4.18", address: `pc.invalid:${REGISTERED_PORT}` } });
    expect(installs).toEqual([]);
  });
});
