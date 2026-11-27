import { expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob, type SetupRequest } from "../shared/machines.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost, windowsHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { readProcessBirth } from "./process-owner.ts";
import { tunnelRelays } from "./machine-tunnel.fixture.ts";

const retired = new Set<string>();

const quiet = ["unanswered", "server error", "unanswered other name"], open = ["wrong token", "redirect", "server error after proof"];
const waits = [...quiet, "server error later"];
// once chosen, its adapter socket is no longer this account's own: through a link, not a socket, in a folder others may
// enter, or another socket than the one the server reports; or in a folder another account could swap: outside the
// account's own roots, or below a folder others may write or another account owns
const confinement = ["socket link", "not a socket", "open folder", "other socket id", "outside home", "writable parent", "foreign parent", "foreign root parent", "runtime dir"];
it.each(["connect", "default bridge", "default herdr", "default herdr chosen", "default herdr installed", "default herdr older peer", "unbridged herdr", "herdr stopped, no bundle", "older peer, no bundle", "older peer, no bundle, bridged", "unanswered, no bundle", "newer bundle", "birthless", "unanswered", "server error", "server error later", "server error after proof", "older peer", "gone", "symlink", "reused pid", "changed port", "stopped after proof", "wrong token", "wrong pid", "managed", "wrong runtime", "redirect", "unanswered other name", ...confinement])("chooses the PC's own core server: %s", async (outcome) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "machine-core-choice-")));
  const id = "12345678-1234-1234-1234-123456789abc";
  const shared = join(dir, "shared");
  const stateDir = join(shared, "state");
  mkdirSync(shared, { mode: 0o755 });
  mkdirSync(stateDir, { mode: 0o700 });
  let home = dir, xdgRuntime = "", foreign = "";
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "stat"), [
    "#!/bin/sh",
    "for last; do :; done",
    `if [ "$1" = -c ] && [ "$2" = %u ] && [ -n "$FIXTURE_FOREIGN" ] && [ "$last" = "$FIXTURE_FOREIGN" ]; then echo 4242; exit 0; fi`,
    `if [ "$1" = -c ] && { [ "$last" = / ] || case "$FIXTURE_DIR" in "$last"/*) true ;; *) false ;; esac; }; then`,
    `  case "$2" in %u) echo 0; exit 0 ;; %a) echo 755; exit 0 ;; esac`,
    "fi",
    `exec ${JSON.stringify(Bun.which("stat"))} "$@"`,
  ].join("\n") + "\n", { mode: 0o755 });
  const path = `${bin}:${process.env["PATH"] ?? ""}`;
  const socket = join(stateDir, outcome === "unanswered other name" ? "other.sock" : "herdr-core.sock");
  let adapter = Bun.listen({ unix: socket, socket: { data() {} } });
  const socketId = () => { try { const stat = statSync(socket); return `${stat.dev}:${stat.ino}`; } catch { return "fixture:gone"; } };
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  const birth = readProcessBirth(process.pid);
  if (birth.state !== "identified") throw new Error("Test process birth unavailable");
  const descriptor = { socket_path: socket, pid: process.pid, ...(outcome === "birthless" ? {} : { birth: birth.birth }), port: 12345, token: randomBytes(32).toString("hex"), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: false };
  const bridge = { socket_path: join(dir, ".config/herdr/herdr.sock"), pid: process.pid, port: 23456, token: randomBytes(32).toString("hex"), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
  const beside = outcome.startsWith("default herdr");
  const bare = outcome.includes("no bundle");
  const bridged = outcome === "default bridge" || beside || outcome.endsWith("bridged");
  const older = outcome.startsWith("older peer") || outcome === "default herdr older peer";
  const workBridge = { ...bridge, socket_path: join(dir, ".config/herdr/sessions/work/herdr.sock"), port: 34567, token: randomBytes(32).toString("hex") };
  const listedHere = beside ? [bridge, workBridge, descriptor] : bridged ? [bridge, descriptor] : [descriptor];
  const registry = join(dir, ".config/herdr-web-ui/bridges");
  mkdirSync(registry, { recursive: true });
  const registration = join(registry, createHash("sha256").update(socket).digest("hex") + ".json");
  writeFileSync(registration, JSON.stringify(descriptor), { mode: 0o600 });
  const herdrDir = join(dir, ".config/herdr/sessions/work");
  mkdirSync(herdrDir, { recursive: true });
  const sessions = [{ socket_path: join(herdrDir, "herdr.sock"), session: "work", label: "work" }];
  const herdr = quiet.includes(outcome) ? undefined : Bun.listen({ unix: sessions[0]!.socket_path, socket: { data() {} } });
  const tui = outcome === "unbridged herdr" || beside || bare ? Bun.listen({ unix: join(dir, ".config/herdr/herdr.sock"), socket: { data() {} } }) : undefined;
  if (!herdr) sessions.length = 0;
  if (beside) sessions.push({ socket_path: bridge.socket_path, label: "Default session" } as typeof sessions[number]);
  const runtimeDir = join(dir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "ovis-server"), `#!/bin/sh\nshift\nexec "${process.execPath}" "${join(import.meta.dir, "remote-entry.ts")}" "$@"\n`, { mode: 0o755 });
  const relays: ReturnType<typeof Bun.serve>[] = [];
  let selected = false, starts = 0, installs = 0, answering = !quiet.includes(outcome) && outcome !== "unanswered, no bundle";
  let startedWith: Parameters<typeof posixHost.start>[1] | undefined;
  const commands: string[] = [];
  const realFetch = globalThis.fetch;
  const mocks = [
    spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => !answering && outcome.startsWith("unanswered") && String(input).includes("/api/bridge")
      ? Promise.reject(new DOMException("Fixture bridge answer timed out", "TimeoutError")) : realFetch(input, init), { preconnect: realFetch.preconnect })),
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "run").mockImplementation(async (command) => {
      commands.push(command);
      const shell = Bun.spawn(["sh", "-c", command], { env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: xdgRuntime, PATH: path, FIXTURE_DIR: dir, FIXTURE_FOREIGN: foreign, XDG_CONFIG_HOME: join(dir, ".config") }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(shell.stdout).text(), new Response(shell.stderr).text(), shell.exited]);
      if (code !== 0) throw new Error(err);
      return out;
    }),
    spyOn(posixHost, "herdrVersion").mockResolvedValue("herdr 0.9.0"),
    spyOn(posixHost, "inspect").mockImplementation(async (_ssh, session, chosen) => {
      const own = session ? join(dir, ".config/herdr/sessions", session, "herdr.sock") : bridge.socket_path;
      return { platform: "linux-x64", home: dir, herdrPath: "/fixture/herdr", expectedSocket: chosen ?? own, defaultSocket: own, bundleReady: outcome !== "unbridged herdr" && !bare, bundleOlder: false, descriptors: listedHere, runtimeDir: bare ? join(dir, "no-runtime") : runtimeDir, registryDir: registry };
    }),
    spyOn(posixHost, "descriptors").mockResolvedValue(listedHere),
    ...(beside ? [spyOn(posixHost, "chosenSocketStatus").mockResolvedValue("usable")] : []),
    spyOn(posixHost, "alive").mockImplementation(async () => !selected || outcome !== "stopped after proof"),
    spyOn(posixHost, "installBundle").mockImplementation(async () => { installs++; }),
    spyOn(posixHost, "start").mockImplementation(async (_ssh, options) => { starts++; startedWith = options; throw new Error("must not start herdr"); }),
    ...tunnelRelays(relays, (remotePort) => {
      const served = remotePort === bridge.port && bridged ? bridge : remotePort === workBridge.port && beside ? workBridge : descriptor;
      expect(remotePort).toBe(served.port);
      return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request, server) {
        // an ended case's token is refused, as a bridge refuses one it does not know; any other must be this bridge's
        const authorization = request.headers.get("authorization");
        if (authorization?.startsWith("Bearer ") && retired.has(authorization.slice("Bearer ".length))) return new Response(null, { status: 401 });
        expect(authorization).toBe(`Bearer ${served.token}`);
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge" && served !== descriptor) return Response.json({ ...served, socket_id: "fixture:tui", herdr: { protocol: 22, version: "0.9.0", runtime: "herdr" } });
        if (path === "/api/bridge") {
          const discovering = new URL(request.url).searchParams.get("discover") === "herdr";
          if ((!answering && outcome === "server error") || (selected && outcome === "server error later") || (selected && outcome === "server error after proof" && !discovering)) {
            return Response.json({ error: { code: "herdr_unavailable", message: "herdr-core is not answering" } }, { status: 500 });
          }
          if (selected && outcome === "wrong token") return new Response(null, { status: 401 });
          if (selected && outcome === "redirect") return Response.redirect("http://127.0.0.1:1/");
          return Response.json({ ...descriptor, pid: selected && outcome === "wrong pid" ? process.pid + 1 : process.pid, managed_remote: selected && outcome === "managed", socket_id: selected && outcome === "other socket id" ? "1:2" : socketId(), herdr: { protocol: 22, version: "0.1.17", runtime: selected && outcome === "wrong runtime" ? "herdr" : "herdr-core" }, ...(older ? {} : { found_herdr_sessions: sessions }),
            ...(selected && outcome === "newer bundle" && !discovering ? { bundle_version: String(Number(REMOTE_BUNDLE_VERSION) + 1) } : {}) });
        }
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [{ id: "core-work", name: "Existing core work" }] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response(null, { status: 404 });
      }, websocket: { message() {} } });
    }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater");
  const settle = (start: () => SetupJob) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const timeout = setTimeout(() => { off(); reject(new Error("setup did not settle")); }, 5000);
    const off = manager.subscribe(() => { if (job && ["failed", "connected", "approval"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); } });
    job = start();
  });
  const run = (request: SetupRequest, auto = true) => settle(() => manager.setup({ ...request, machine_id: id, update_remote: true }, { auto }));
  const reached = async (job: SetupJob, phases = ["failed", "connected", "approval"]) => {
    for (const deadline = Date.now() + 5000; !phases.includes(job.phase);) {
      if (Date.now() >= deadline) throw new Error("setup did not settle");
      await Bun.sleep(5);
    }
    return job;
  };
  const add = (request: SetupRequest) => reached(manager.setup({ ...request, update_remote: true }, { auto: false }));
  const reconnect = () => {
    const settled = Promise.withResolvers<"retry" | "decision">();
    retries.mockImplementation(() => settled.resolve("retry"));
    const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
    const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
    manager.patch(id, { enabled: true });
    return settled.promise.finally(() => { clearTimeout(timeout); off(); });
  };
  // a PC added beside its own answering Ovis connects to it, with no choice asked, and is saved with that Ovis
  const ownOvisAdded = (added: SetupJob) => {
    expect(added).toMatchObject({ phase: "connected", runtime: "herdr-core" });
    expect(added.action_required ?? null).toBeNull();
    expect(added.found_herdr_sessions).toBeUndefined();
    expect(manager.list().find((pc) => pc.id === added.machine_id)?.target).toEqual({ destination: "fixture-added", own_ovis: socket });
  };
  try {
    if (outcome === "default bridge") {
      for (const auto of [true, false]) {
        const reconnect = await run({ destination: "fixture-only" }, auto);
        expect(reconnect).toMatchObject({ phase: "connected", runtime: "herdr" });
        expect(reconnect.action_required ?? null).toBeNull();
        expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "connected", runtime: "herdr", action_required: null });
      }
      ownOvisAdded(await add({ destination: "fixture-added" }));
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "default herdr") {
      const saved = await run({ destination: "fixture-only" }, false);
      expect(saved).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(saved.action_required ?? null).toBeNull();
      // Advanced settings' "herdr instead of Ovis" adds the PC on its herdr, beside the Ovis
      expect(await add({ destination: "fixture-herdr", start_new_herdr: true })).toMatchObject({ phase: "connected", runtime: "herdr", target: { destination: "fixture-herdr", start_new_herdr: true } });
      ownOvisAdded(await add({ destination: "fixture-added" }));
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "default herdr older peer") {
      ownOvisAdded(await add({ destination: "fixture-added" }));
      expect(starts).toBe(0);
      return;
    }
    if (bare) {
      const added = await add({ destination: "fixture-added" });
      if (outcome === "older peer, no bundle, bridged") {
        ownOvisAdded(added);
        expect(starts).toBe(0);
        return;
      }
      if (outcome === "herdr stopped, no bundle") {
        ownOvisAdded(added);
        expect(starts).toBe(0);
        return;
      }
      if (outcome === "unanswered, no bundle") {
        expect(added.phase).toBe("approval");
        expect(added.action_required ?? null).toBeNull();
        expect(added.found_ovis).toBeUndefined();
        expect(starts).toBe(0);
        return;
      }
      ownOvisAdded(added);
      const chosen = await add({ destination: "fixture-default", herdr_socket: bridge.socket_path });
      expect(chosen.phase).toBe("approval");
      expect(starts).toBe(0);
      manager.action(chosen.id, { action: "approve" });
      await reached(chosen, ["failed", "connected"]);
      expect(installs).toBe(1);
      expect(startedWith).toMatchObject({ herdr_socket: bridge.socket_path });
      expect(startedWith?.start_new_herdr).toBeUndefined();
      const typed = await add({ destination: "fixture-typed", session: "work" });
      expect(typed.phase).toBe("approval");
      expect(typed.action_required ?? null).toBeNull();
      expect(typed.found_ovis).toBeUndefined();
      expect(typed.found_herdr_sessions).toBeUndefined();
      manager.action(typed.id, { action: "approve" });
      await reached(typed, ["failed", "connected"]);
      expect(installs).toBe(2);
      expect(startedWith).toMatchObject({ session: "work" });
      expect(startedWith?.herdr_socket).toBeUndefined();
      expect(startedWith?.start_new_herdr).toBeUndefined();
      return;
    }
    if (outcome === "default herdr chosen") {
      const byDefault = await add({ destination: "fixture-default", herdr_socket: bridge.socket_path });
      expect(byDefault).toMatchObject({ phase: "connected", runtime: "herdr" });
      const saved = { destination: "fixture-default", start_new_herdr: true };
      expect(manager.list().find((pc) => pc.id === byDefault.machine_id)?.target).toEqual(saved);
      expect((JSON.parse(readFileSync(join(dir, "machines.json"), "utf8")) as { id: string; target: unknown }[]).find((pc) => pc.id === byDefault.machine_id)?.target).toEqual(saved);
      const again = await settle(() => manager.setup({ ...saved, machine_id: byDefault.machine_id! }));
      expect(again).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(again.action_required ?? null).toBeNull();
      expect(manager.list().find((pc) => pc.id === byDefault.machine_id)?.target).toEqual(saved);
      const named = await add({ destination: "fixture-named", session: "work", herdr_socket: sessions[0]!.socket_path });
      expect(named).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(manager.list().find((pc) => pc.id === named.machine_id)?.target).toEqual({ destination: "fixture-named", session: "work", herdr_socket: sessions[0]!.socket_path });
      const other = await add({ destination: "fixture-other", herdr_socket: sessions[0]!.socket_path });
      expect(other).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(manager.list().find((pc) => pc.id === other.machine_id)?.target).toEqual({ destination: "fixture-other", herdr_socket: sessions[0]!.socket_path });
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "default herdr installed") {
      const installed = await settle(() => manager.setup({ destination: "fixture-installed" }, { keysOnly: true, fromInstall: true }));
      expect(installed).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(installed.action_required ?? null).toBeNull();
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "unbridged herdr") {
      const reconnect = await run({ destination: "fixture-only" });
      expect(reconnect.action_required).not.toBe("choose_herdr");
      expect(reconnect.found_ovis).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)?.action_required).not.toBe("choose_herdr");
      expect(starts).toBe(1);
      const asked = await run({ destination: "fixture-only" }, false);
      expect(asked.action_required).not.toBe("choose_herdr");
      expect(asked.found_ovis).toBeUndefined();
      expect(asked.phase).toBe("approval");
      expect(starts).toBe(1);
      return;
    }
    const offer = await run({ destination: "fixture-only" }, false);
    if (outcome === "unanswered other name") {
      expect(offer.found_ovis ?? []).not.toContainEqual(expect.objectContaining({ socket_path: socket }));
      return;
    }
    expect(offer).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
    // its registered port tells it apart from another Ovis on that PC; it runs this app's release, so it is not marked newer
    expect(offer.found_ovis).toEqual([{ socket_path: socket, runtime: "herdr-core", port: 12345 }]);
    expect(starts).toBe(0);
    if (quiet.includes(outcome)) {
      expect(offer.error).not.toContain("127.0.0.1");
      expect(offer.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
      const waiting = await run({ destination: "fixture-only", own_ovis: socket }, false);
      expect(waiting).toMatchObject({ phase: "failed", action_required: "choose_herdr", error: offer.error, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(starts).toBe(0);
      expect(manager.endpoint(id)).toBeUndefined();
      expect(retries).not.toHaveBeenCalled();
      answering = true;
    }
    expect((await run({ destination: "fixture-only", own_ovis: socket })).phase).toBe("connected");
    retries.mockClear();
    selected = true;
    if (outcome === "gone" || outcome === "symlink") rmSync(registration);
    if (outcome === "symlink") { writeFileSync(join(dir, "outside.json"), JSON.stringify(descriptor)); symlinkSync(join(dir, "outside.json"), registration); }
    if (outcome === "reused pid") descriptor.birth = { ...birth.birth, value: "not-this-process" };
    if (outcome === "changed port") writeFileSync(registration, JSON.stringify({ ...descriptor, port: 12346 }));
    if (confinement.includes(outcome)) {
      if (outcome === "socket link" || outcome === "not a socket") { adapter.stop(true); rmSync(socket, { force: true }); }
      if (outcome === "socket link") {
        // another folder's socket, reached through a link where the chosen server's socket was
        mkdirSync(join(dir, "elsewhere"), { mode: 0o700 });
        adapter = Bun.listen({ unix: join(dir, "elsewhere/herdr-core.sock"), socket: { data() {} } });
        symlinkSync(join(dir, "elsewhere/herdr-core.sock"), socket);
      }
      if (outcome === "not a socket") writeFileSync(socket, "");
      // a folder others may enter or write is not this account's own herdr-core folder
      if (outcome === "open folder") chmodSync(stateDir, 0o755);
      // the account's own folder, but outside its home (and no runtime dir): a parent it does not control could swap it
      // (its registration is still found: that home's .config is the fixture's)
      if (outcome === "outside home") { home = join(dir, "home"); mkdirSync(home); symlinkSync(join(dir, ".config"), join(home, ".config")); }
      if (outcome === "writable parent") chmodSync(shared, 0o777);
      // another account owns the folder above
      if (outcome === "foreign parent") foreign = shared;
      // or the folder above the account's home itself (the root): it could rename that root and put another in its place
      if (outcome === "foreign root parent") foreign = dirname(dir);
      // an XDG_RUNTIME_DIR of the account's own that is not /run/user/<uid> is no root of its own
      if (outcome === "runtime dir") { home = join(dir, "home"); mkdirSync(home); symlinkSync(join(dir, ".config"), join(home, ".config")); xdgRuntime = dir; }
      for (const attach of [() => run({ destination: "fixture-only", own_ovis: socket }), reconnect]) {
        retries.mockClear();
        const settled = await attach();
        if (typeof settled !== "string") expect(settled).toMatchObject({ phase: "failed", action_required: "choose_herdr" });
        else expect(settled).toBe("decision");
        expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "error", action_required: "choose_herdr", target: { own_ovis: socket } });
        expect(manager.list().find((pc) => pc.id === id)?.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
        expect(manager.endpoint(id)).toBeUndefined();
        expect(retries).not.toHaveBeenCalled();
        manager.patch(id, { enabled: false });
      }
      expect(starts).toBe(0);
      expect(installs).toBe(0);
      return;
    }
    if (waits.includes(outcome)) {
      if (quiet.includes(outcome)) answering = false;
      expect(await reconnect()).toBe("retry");
      expect(starts).toBe(0);
      expect(installs).toBe(0);
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ error: "Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.", action_required: null, target: { own_ovis: socket } });
      for (const command of commands) expect(command).not.toContain(descriptor.token);
      return;
    }
    const chosen = await run({ destination: "fixture-only", own_ovis: socket }, !["gone", "stopped after proof", ...open].includes(outcome));
    const connects = ["connect", "birthless", "older peer"].includes(outcome);
    expect(chosen.phase).toBe(connects ? "connected" : "failed");
    expect(starts).toBe(0);
    // the registration's token goes only in the tunnel's HTTP request, never in a command on that PC
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).not.toContain(descriptor.token);
    if (connects) {
      expect(chosen.runtime).toBe("herdr-core");
      expect(manager.list().find((pc) => pc.id === chosen.machine_id)).toMatchObject({ runtime: "herdr-core", target: { own_ovis: socket }, snapshot: { workspaces: [{ id: "core-work" }] } });
      manager.patch(chosen.machine_id!, { enabled: false });
      expect(manager.list().find((pc) => pc.id === chosen.machine_id)?.runtime).toBeUndefined();
    } else if (outcome === "newer bundle") {
      expect(chosen).toMatchObject({ phase: "failed", action_required: "setup" });
      expect(chosen.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
      expect(chosen.found_ovis).toBeUndefined();
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
    } else if (open.includes(outcome)) {
      expect(chosen).toMatchObject({ action_required: "choose_herdr", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(chosen.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(retries).not.toHaveBeenCalled();
    } else {
      expect(chosen).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: sessions });
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: sessions });
      expect(retries).not.toHaveBeenCalled();
    }
  } finally {
    for (const own of [descriptor, bridge, workBridge]) retired.add(own.token);
    manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); relays.forEach((relay) => relay.stop(true)); herdr?.stop(true); tui?.stop(true); adapter.stop(true); rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["registration removed", "process stopped"])("retries a saved PC whose chosen Ovis is gone instead of asking: %s", async (gone) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-core-gone-"));
  const id = "12345678-1234-1234-1234-123456789abe";
  const socket = "/home/fixture/.config/ovis/hc-adapter.sock";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only", own_ovis: socket } }]));
  const descriptor = { socket_path: socket, pid: 4242, port: 12345, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: false };
  const listed = gone === "registration removed" ? [] : [descriptor];
  let starts = 0;
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("no command is expected on that PC")),
    spyOn(posixHost, "inspect").mockResolvedValue({ platform: "linux-x64", home: "/home/fixture", herdrPath: "", expectedSocket: "/home/fixture/.config/herdr/herdr.sock", bundleReady: true, bundleOlder: false, descriptors: listed, runtimeDir: "/runtime", registryDir: "/registry" }),
    spyOn(posixHost, "descriptors").mockResolvedValue(listed),
    spyOn(posixHost, "alive").mockResolvedValue(false),
    spyOn(posixHost, "installBundle").mockImplementation(async () => { starts++; }),
    spyOn(posixHost, "start").mockImplementation(async () => { starts++; }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const settled = Promise.withResolvers<"retry" | "decision">();
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater").mockImplementation(() => settled.resolve("retry"));
  const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
  const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
  try {
    manager.patch(id, { enabled: true });
    expect(await settled.promise).toBe("retry");
    expect(starts).toBe(0);
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ error: "Start Ovis on that PC, or start a new herdr here", action_required: null, target: { own_ovis: socket } });
  } finally {
    clearTimeout(timeout); off(); manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["connection dropped", "discovery unavailable"])("tells why the choice could not list sessions: %s", async (failure) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-core-discovery-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  const socket = "/home/fixture/.config/ovis/hc-adapter.sock";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  const dropped = failure === "connection dropped";
  let starts = 0;
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "connected").mockImplementation(() => !dropped),
    spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("no command is expected on that PC")),
    spyOn(posixHost, "inspect").mockResolvedValue({ platform: "linux-x64", home: "/home/fixture", herdrPath: "", expectedSocket: "/home/fixture/.config/herdr/herdr.sock", bundleReady: true, bundleOlder: false, descriptors: [], runtimeDir: "/runtime", registryDir: "/registry" }),
    spyOn(posixHost, "discoverSessions").mockRejectedValue(new Error(dropped ? "Connection to fixture-only closed by remote host." : "SSH command failed (1)")),
    spyOn(posixHost, "start").mockImplementation(async () => { starts++; }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  try {
    const job = await new Promise<SetupJob>((resolve, reject) => {
      let job: SetupJob | undefined;
      const timeout = setTimeout(() => { off(); reject(new Error("setup did not settle")); }, 5000);
      const off = manager.subscribe(() => { if (job && ["failed", "connected"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); } });
      job = manager.setup({ destination: "fixture-only", own_ovis: socket, machine_id: id }, {});
    });
    expect(job.phase).toBe("failed");
    expect(starts).toBe(0);
    if (dropped) {
      expect(job.error).toBe("Connection to fixture-only closed by remote host.");
      expect(job.action_required).not.toBe("choose_herdr");
      expect(job.found_herdr_sessions).toBeUndefined();
    } else expect(job).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: [] });
  } finally {
    manager.stop(); mocks.forEach((mock) => mock.mockRestore()); rmSync(dir, { recursive: true, force: true });
  }
});

it("asks for a new choice instead of retrying when a saved Windows PC is set to use its own Ovis server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "machine-core-windows-"));
  const id = "12345678-1234-1234-1234-123456789abd";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only", own_ovis: "/home/fixture/.config/ovis/hc-adapter.sock" } }]));
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("no command is expected on that PC")),
    spyOn(posixHost, "inspect").mockRejectedValue(new Error("not a POSIX shell")),
    spyOn(windowsHost, "inspect").mockResolvedValue({ platform: "win32-x64", home: "C:\\Users\\fixture", herdrPath: "", expectedSocket: "\\\\.\\pipe\\herdr", bundleReady: true, bundleOlder: false, descriptors: [], runtimeDir: "C:\\runtime", registryDir: "C:\\registry" }),
    spyOn(windowsHost, "start").mockImplementation(async () => { throw new Error("must not start herdr"); }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const settled = Promise.withResolvers<"retry" | "decision">();
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater").mockImplementation(() => settled.resolve("retry"));
  const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
  const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
  try {
    manager.patch(id, { enabled: true });
    expect(await settled.promise).toBe("decision");
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "error", action_required: "setup" });
    expect(retries).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timeout); off(); manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); rmSync(dir, { recursive: true, force: true });
  }
});

it("spells the session's own socket beside the one chosen", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "machine-core-inspect-")));
  mkdirSync(join(dir, ".config/herdr/sessions/work"), { recursive: true });
  symlinkSync(dir, join(dir, "link"));
  const ssh = { run: async (command: string) => {
    const shell = Bun.spawn(["sh", "-c", command], { env: { PATH: process.env["PATH"] ?? "", HOME: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(shell.stdout).text(), new Response(shell.stderr).text(), shell.exited]);
    if (code !== 0) throw new Error(err);
    return out;
  } } as unknown as SshConnection;
  try {
    const own = join(dir, ".config/herdr/herdr.sock"), work = join(dir, ".config/herdr/sessions/work/herdr.sock");
    expect(await posixHost.inspect(ssh)).toMatchObject({ expectedSocket: own, defaultSocket: own });
    expect(await posixHost.inspect(ssh, undefined, join(dir, "link/.config/herdr/herdr.sock"))).toMatchObject({ expectedSocket: own, defaultSocket: own });
    expect(await posixHost.inspect(ssh, undefined, work)).toMatchObject({ expectedSocket: work, defaultSocket: own });
    expect(await posixHost.inspect(ssh, "work", work)).toMatchObject({ expectedSocket: work, defaultSocket: work });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// a registration's port and token go into an SSH forward and a request header: one that is no port or no bridge token
// of this app's opens no tunnel
it.each([
  ["port 0", { port: 0 }], ["port past 65535", { port: 65536 }], ["fractional port", { port: 1.5 }], ["port as text", { port: "12345" }],
  ["short token", { token: "a".repeat(63) }], ["upper-case token", { token: "A".repeat(64) }], ["token with a newline", { token: `${"a".repeat(64)}\n` }], ["no token", { token: undefined }],
] as const)("opens no tunnel for invalid bridge credentials: %s", async (_name, change) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-tunnel-credentials-"));
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const forwards: number[] = [];
  const ssh = { forward: async (_port: number, remotePort: number) => { forwards.push(remotePort); } } as unknown as SshConnection;
  const tunnel = (manager as unknown as { tunnel(ssh: SshConnection, descriptor: unknown): Promise<{ url: string; token: string }> }).tunnel.bind(manager);
  try {
    const valid = { port: 12345, token: "a".repeat(64) };
    expect(await tunnel(ssh, valid)).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), token: valid.token });
    expect(forwards).toEqual([valid.port]);
    await expect(tunnel(ssh, { ...valid, ...change })).rejects.toThrow("Invalid bridge credentials");
    expect(forwards).toEqual([valid.port]);
  } finally {
    manager.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
