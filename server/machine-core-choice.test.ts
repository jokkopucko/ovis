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

// the bridge tokens of the cases already ended: a read one of their PCs still had under way (its move badge) may reach
// the port its relay let go, now a later case's relay
const retired = new Set<string>();

// quiet: the live server cannot prove itself at first (no answer, an HTTP error); open: once chosen, it no longer can
// unanswered other name: a live server of the account's, not answering, whose socket is not the core adapter's name
const quiet = ["unanswered", "server error", "unanswered other name"], open = ["wrong token", "redirect", "server error after proof"];
// waits: once chosen and connected, a reconnect meets it alive but not answering (no answer, or a 500 while its core
// adapter starts after a reboot): the saved PC tries again, starting nothing
const waits = [...quiet, "server error later"];
// once chosen, its adapter socket is no longer this account's own: through a link, not a socket, in a folder others may
// enter, or another socket than the one the server reports
// enter, or another socket than the one the server reports; or in a folder another account could swap: outside the
// account's own roots, or below a folder others may write or another account owns
const confinement = ["socket link", "not a socket", "open folder", "other socket id", "outside home", "writable parent", "foreign parent", "foreign root parent", "runtime dir"];
it.each(["connect", "default bridge", "default herdr", "default herdr chosen", "default herdr installed", "default herdr older peer", "unbridged herdr", "herdr stopped, no bundle", "older peer, no bundle", "older peer, no bundle, bridged", "unanswered, no bundle", "newer bundle", "birthless", "unanswered", "server error", "server error later", "server error after proof", "older peer", "gone", "symlink", "reused pid", "changed port", "stopped after proof", "wrong token", "wrong pid", "managed", "wrong runtime", "redirect", "unanswered other name", ...confinement])("chooses the PC's own core server: %s", async (outcome) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "machine-core-choice-")));
  const id = "12345678-1234-1234-1234-123456789abc";
  // the core adapter's socket in its server's own state folder (server/herdr-core/runtime.ts), as startRuntime leaves it
  const shared = join(dir, "shared");
  const stateDir = join(shared, "state");
  mkdirSync(shared, { mode: 0o755 });
  mkdirSync(stateDir, { mode: 0o700 });
  // the SSH account's home on that PC, and the PATH its commands run with (a stand-in stat, below)
  // xdgRuntime: its XDG_RUNTIME_DIR; foreign: a folder a stand-in stat says another account owns
  let home = dir, xdgRuntime = "", foreign = "";
  // The PC's folders above the fixture's are root's and writable by root alone, as on a usual system (this host's own
  // temporary folder may be shared and sticky): a stand-in stat says so, and says which folder another account owns
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
  // what the server reports of its socket, read as server/bridge.ts reads it (through a link)
  const socketId = () => { try { const stat = statSync(socket); return `${stat.dev}:${stat.ino}`; } catch { return "fixture:gone"; } };
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  const birth = readProcessBirth(process.pid);
  if (birth.state !== "identified") throw new Error("Test process birth unavailable");
  // birthless: an older server's registration, which recorded no process birth
  const descriptor = { socket_path: socket, pid: process.pid, ...(outcome === "birthless" ? {} : { birth: birth.birth }), port: 12345, token: randomBytes(32).toString("hex"), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: false };
  // default bridge: this app's bridge already serves the PC's default herdr socket, as on a saved PC that reconnects
  const bridge = { socket_path: join(dir, ".config/herdr/herdr.sock"), pid: process.pid, port: 23456, token: randomBytes(32).toString("hex"), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
  // default herdr: that herdr also answers at its socket, so the PC's own Ovis lists it among the account's sessions
  // (chosen: by its socket on the card of a PC being added; installed: met by the connect an install ends with)
  const beside = outcome.startsWith("default herdr");
  // no bundle: this app's runtime is not on that PC, so nothing there can list the account's sessions by the rule, and
  // herdr's own socket is all that says herdr runs there (bridged: this app's bridge of another time still serves it;
  // herdr stopped: the Ovis there, which names the sessions that run, does not name it)
  const bare = outcome.includes("no bundle");
  const bridged = outcome === "default bridge" || beside || outcome.endsWith("bridged");
  // an older Ovis there, which names no herdr sessions in its answer
  const older = outcome.startsWith("older peer") || outcome === "default herdr older peer";
  // and this app's bridge serves the account's named session too, for a setup that chooses it
  const workBridge = { ...bridge, socket_path: join(dir, ".config/herdr/sessions/work/herdr.sock"), port: 34567, token: randomBytes(32).toString("hex") };
  const listedHere = beside ? [bridge, workBridge, descriptor] : bridged ? [bridge, descriptor] : [descriptor];
  const registry = join(dir, ".config/herdr-web-ui/bridges");
  mkdirSync(registry, { recursive: true });
  const registration = join(registry, createHash("sha256").update(socket).digest("hex") + ".json");
  writeFileSync(registration, JSON.stringify(descriptor), { mode: 0o600 });
  const herdrDir = join(dir, ".config/herdr/sessions/work");
  mkdirSync(herdrDir, { recursive: true });
  const sessions = [{ socket_path: join(herdrDir, "herdr.sock"), session: "work", label: "work" }];
  // no TUI herdr runs beside a quiet core server, so nothing else could be offered
  const herdr = quiet.includes(outcome) ? undefined : Bun.listen({ unix: sessions[0]!.socket_path, socket: { data() {} } });
  // unbridged herdr: herdr answers at the PC's own socket with no bridge in front yet (right after an app update, before
  // this app's runtime is there again), beside the core server
  const tui = outcome === "unbridged herdr" || beside || bare ? Bun.listen({ unix: join(dir, ".config/herdr/herdr.sock"), socket: { data() {} } }) : undefined;
  if (!herdr) sessions.length = 0;
  if (beside) sessions.push({ socket_path: bridge.socket_path, label: "Default session" } as typeof sessions[number]);
  const runtimeDir = join(dir, "runtime");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  symlinkSync(process.execPath, join(runtimeDir, "bin/bun"));
  symlinkSync(import.meta.dir, join(runtimeDir, "server"));
  const relays: ReturnType<typeof Bun.serve>[] = [];
  let selected = false, starts = 0, installs = 0, answering = !quiet.includes(outcome) && outcome !== "unanswered, no bundle";
  // what the last bridge start was asked for
  let startedWith: Parameters<typeof posixHost.start>[1] | undefined;
  const commands: string[] = [];
  const realFetch = globalThis.fetch;
  const mocks = [
    // a live server that cannot answer right now: its identity request times out
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
    // as the PC answers: a chosen socket is the one its bridge registers, beside the own socket of the session named
    // (the default session's when none is)
    spyOn(posixHost, "inspect").mockImplementation(async (_ssh, session, chosen) => {
      const own = session ? join(dir, ".config/herdr/sessions", session, "herdr.sock") : bridge.socket_path;
      return { platform: "linux-x64", home: dir, herdrPath: "/fixture/herdr", expectedSocket: chosen ?? own, defaultSocket: own, bundleReady: outcome !== "unbridged herdr" && !bare, bundleOlder: false, descriptors: listedHere, runtimeDir: bare ? join(dir, "no-runtime") : runtimeDir, registryDir: registry };
    }),
    spyOn(posixHost, "descriptors").mockResolvedValue(listedHere),
    // default herdr: the fixture's sockets answer no herdr request, so a chosen one is said usable as a running herdr's is
    ...(beside ? [spyOn(posixHost, "chosenSocketStatus").mockResolvedValue("usable")] : []),
    spyOn(posixHost, "alive").mockImplementation(async () => !selected || outcome !== "stopped after proof"),
    spyOn(posixHost, "installBundle").mockImplementation(async () => { installs++; }),
    spyOn(posixHost, "start").mockImplementation(async (_ssh, options) => { starts++; startedWith = options; throw new Error("must not start herdr"); }),
    // the SSH tunnel to a bridge (machine-tunnel.fixture.ts)
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
          // the server cannot reach its core adapter right now: every identity request, or (after proof) the one after discovery
          const discovering = new URL(request.url).searchParams.get("discover") === "herdr";
          if ((!answering && outcome === "server error") || (selected && outcome === "server error later") || (selected && outcome === "server error after proof" && !discovering)) {
            return Response.json({ error: { code: "herdr_unavailable", message: "herdr-core is not answering" } }, { status: 500 });
          }
          if (selected && outcome === "wrong token") return new Response(null, { status: 401 });
          if (selected && outcome === "redirect") return Response.redirect("http://127.0.0.1:1/");
          return Response.json({ ...descriptor, pid: selected && outcome === "wrong pid" ? process.pid + 1 : process.pid, managed_remote: selected && outcome === "managed", socket_id: selected && outcome === "other socket id" ? "1:2" : socketId(), herdr: { protocol: 22, version: "0.1.17", runtime: selected && outcome === "wrong runtime" ? "herdr" : "herdr-core" }, ...(older ? {} : { found_herdr_sessions: sessions }),
            // newer bundle: the chosen Ovis was updated past this app since it was proven
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
  // a setup until it ends, or (approval) goes on, as before this choice existed, to what it installs or starts there
  const settle = (start: () => SetupJob) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const timeout = setTimeout(() => { off(); reject(new Error("setup did not settle")); }, 5000);
    const off = manager.subscribe(() => { if (job && ["failed", "connected", "approval"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); } });
    job = start();
  });
  // auto: a reconnect or an update that asks nobody; false, a setup the user started in its dialog
  const run = (request: SetupRequest, auto = true) => settle(() => manager.setup({ ...request, machine_id: id, update_remote: true }, { auto }));
  // a PC being added tells no subscriber when its setup stops for approval: its phase is read until it settles
  const reached = async (job: SetupJob, phases = ["failed", "connected", "approval"]) => {
    for (const deadline = Date.now() + 5000; !phases.includes(job.phase);) {
      if (Date.now() >= deadline) throw new Error("setup did not settle");
      await Bun.sleep(5);
    }
    return job;
  };
  // a PC being added in its dialog: no saved PC is named
  const add = (request: SetupRequest) => reached(manager.setup({ ...request, update_remote: true }, { auto: false }));
  // the saved PC's own reconnect: a retry scheduled, or a decision for the user, whichever comes first
  const reconnect = () => {
    const settled = Promise.withResolvers<"retry" | "decision">();
    retries.mockImplementation(() => settled.resolve("retry"));
    const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
    const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
    manager.patch(id, { enabled: true });
    return settled.promise.finally(() => { clearTimeout(timeout); off(); });
  };
  try {
    if (outcome === "default bridge") {
      // reconnects to its live bridge on its own, as before, and a setup started in its dialog connects to it too: no
      // choice nobody needs, nothing started, no retry
      for (const auto of [true, false]) {
        const reconnect = await run({ destination: "fixture-only" }, auto);
        expect(reconnect).toMatchObject({ phase: "connected", runtime: "herdr" });
        expect(reconnect.action_required ?? null).toBeNull();
        expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "connected", runtime: "herdr", action_required: null });
      }
      // a PC being added is not asked either: the herdr that bridge serves is not among the sessions found, so the card
      // could not choose it
      const added = await add({ destination: "fixture-added" });
      expect(added).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(added.action_required ?? null).toBeNull();
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "default herdr") {
      // a saved PC connects to its herdr as before, from its dialog too
      const saved = await run({ destination: "fixture-only" }, false);
      expect(saved).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(saved.action_required ?? null).toBeNull();
      // a PC being added is asked: its own Ovis beside the herdr that runs there, which is one of the choices
      const added = await add({ destination: "fixture-added" });
      expect(added).toMatchObject({ phase: "failed", action_required: "choose_herdr", error: "Choose this PC's Ovis server or a running herdr session.", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(added.found_herdr_sessions).toContainEqual(expect.objectContaining({ socket_path: bridge.socket_path }));
      expect(manager.endpoint(added.machine_id!)).toBeUndefined();
      // and connects to the one chosen
      expect(await add({ destination: "fixture-added", own_ovis: socket })).toMatchObject({ phase: "connected", runtime: "herdr-core" });
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "default herdr older peer") {
      // an older Ovis names no sessions itself: they are read on that PC, whose runtime of this app can, with the herdr
      // it would connect to among them, so the PC being added is asked as beside any Ovis (#3518)
      const added = await add({ destination: "fixture-added" });
      expect(added).toMatchObject({ phase: "failed", action_required: "choose_herdr", error: "Choose this PC's Ovis server or a running herdr session.", found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(added.found_herdr_sessions).toHaveLength(sessions.length);
      for (const row of sessions) expect(added.found_herdr_sessions).toContainEqual(row);
      expect(starts).toBe(0);
      return;
    }
    if (bare) {
      const added = await add({ destination: "fixture-added" });
      if (outcome === "older peer, no bundle, bridged") {
        // this app's bridge serves that socket already, and a socket chosen where no runtime can check it never reuses
        // its bridge: not asked, the PC connects to that bridge as before
        expect(added).toMatchObject({ phase: "connected", runtime: "herdr" });
        expect(added.action_required ?? null).toBeNull();
        expect(starts).toBe(0);
        return;
      }
      if (outcome === "herdr stopped, no bundle") {
        // the Ovis there names the account's sessions, and herdr's own is not one: its socket is what a stopped herdr
        // left. The PC being added is asked as one where no herdr runs, instead of going on to start herdr unasked
        // beside that Ovis (#3518)
        expect(added).toMatchObject({ phase: "failed", action_required: "choose_herdr", error: "Choose this PC's Ovis server or a running herdr session.", found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
        expect(added.found_herdr_sessions).toEqual(sessions);
        expect(starts).toBe(0);
        return;
      }
      if (outcome === "unanswered, no bundle") {
        // an Ovis that does not answer stops no PC whose herdr could not be listed beside it: as before, its setup goes
        // on to what it installs there
        expect(added.phase).toBe("approval");
        expect(added.action_required ?? null).toBeNull();
        expect(added.found_ovis).toBeUndefined();
        expect(starts).toBe(0);
        return;
      }
      // an older Ovis names no sessions and nothing on that PC can list them: the PC being added is asked all the same,
      // with herdr's own socket there as the session to choose, instead of being taken for a herdr PC unasked (#3518)
      expect(added).toMatchObject({ phase: "failed", action_required: "choose_herdr", error: "Choose this PC's Ovis server or a running herdr session.", found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(added.found_herdr_sessions).toEqual([{ socket_path: bridge.socket_path, label: "Default session" }]);
      expect(manager.endpoint(added.machine_id!)).toBeUndefined();
      expect(await add({ destination: "fixture-added", own_ovis: socket })).toMatchObject({ phase: "connected", runtime: "herdr-core" });
      // herdr chosen there is a chosen socket like any other: once the runtime is approved and installed, the bridge
      // started for it checks that socket and starts no herdr in its place (server/remote-entry.test.ts), so a socket a
      // stopped herdr left is told as "no longer running". The fixture's start ends the setup there
      const chosen = await add({ destination: "fixture-default", herdr_socket: bridge.socket_path });
      expect(chosen.phase).toBe("approval");
      expect(starts).toBe(0);
      manager.action(chosen.id, { action: "approve" });
      await reached(chosen, ["failed", "connected"]);
      expect(installs).toBe(1);
      expect(startedWith).toMatchObject({ herdr_socket: bridge.socket_path });
      expect(startedWith?.start_new_herdr).toBeUndefined();
      // A session named in the dialog gets no such row. Chosen, the row would be that session's socket, and the PC would
      // be saved with the socket: after that PC restarts, its bridge would say the session no longer runs instead of
      // starting it. Named, the session connects as before the card existed: the approval of what its setup installs
      // there, then a bridge started for the session by its name, which starts it when absent
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
      // "Use Default session" on that card names the default socket: the PC connects to it and is saved as herdr to start
      // there when absent, never as that socket. After its reboot it then starts herdr by itself, instead of stopping at
      // a session that is gone, or at a new choice because another session started first (#3518)
      const byDefault = await add({ destination: "fixture-default", herdr_socket: bridge.socket_path });
      expect(byDefault).toMatchObject({ phase: "connected", runtime: "herdr" });
      const saved = { destination: "fixture-default", start_new_herdr: true };
      expect(manager.list().find((pc) => pc.id === byDefault.machine_id)?.target).toEqual(saved);
      expect((JSON.parse(readFileSync(join(dir, "machines.json"), "utf8")) as { id: string; target: unknown }[]).find((pc) => pc.id === byDefault.machine_id)?.target).toEqual(saved);
      // saved, it is not asked again: its dialog, which sends what the PC is saved with, connects to its herdr
      const again = await settle(() => manager.setup({ ...saved, machine_id: byDefault.machine_id! }));
      expect(again).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(again.action_required ?? null).toBeNull();
      expect(manager.list().find((pc) => pc.id === byDefault.machine_id)?.target).toEqual(saved);
      // a named session's own socket stays the choice it was: only its name tells it from the default session's
      const named = await add({ destination: "fixture-named", session: "work", herdr_socket: sessions[0]!.socket_path });
      expect(named).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(manager.list().find((pc) => pc.id === named.machine_id)?.target).toEqual({ destination: "fixture-named", session: "work", herdr_socket: sessions[0]!.socket_path });
      // and so does that socket chosen with no session named: it is not the default session's
      const other = await add({ destination: "fixture-other", herdr_socket: sessions[0]!.socket_path });
      expect(other).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(manager.list().find((pc) => pc.id === other.machine_id)?.target).toEqual({ destination: "fixture-other", herdr_socket: sessions[0]!.socket_path });
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "default herdr installed") {
      // an install's own connect of a PC not added yet has no card to ask on: it connects to that herdr, as before (#3518)
      const installed = await settle(() => manager.setup({ destination: "fixture-installed" }, { keysOnly: true, fromInstall: true }));
      expect(installed).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(installed.action_required ?? null).toBeNull();
      expect(starts).toBe(0);
      return;
    }
    if (outcome === "unbridged herdr") {
      // a reconnect of a PC saved without an Ovis chosen does as before this choice existed: it starts this app's bridge
      // for its herdr (the fixture's start then fails), and offers no core server nobody asked for
      const reconnect = await run({ destination: "fixture-only" });
      expect(reconnect.action_required).not.toBe("choose_herdr");
      expect(reconnect.found_ovis).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)?.action_required).not.toBe("choose_herdr");
      expect(starts).toBe(1);
      // and so does a setup the user started: the bundle there is too old to apply the socket rule, but herdr's own
      // socket is there, so no choice nobody needs stops it
      const asked = await run({ destination: "fixture-only" }, false);
      expect(asked.action_required).not.toBe("choose_herdr");
      expect(asked.found_ovis).toBeUndefined();
      // it asks to install this app's runtime there first (that bundle is too old), as before: nothing is started yet
      expect(asked.phase).toBe("approval");
      expect(starts).toBe(1);
      return;
    }
    // the unasked choice: offered only in a setup the user started in its dialog
    const offer = await run({ destination: "fixture-only" }, false);
    if (outcome === "unanswered other name") {
      // never offered as herdr-core: no core adapter listens at another name, so choosing it could never connect
      expect(offer.found_ovis ?? []).not.toContainEqual(expect.objectContaining({ socket_path: socket }));
      return;
    }
    expect(offer).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
    expect(starts).toBe(0);
    if (quiet.includes(outcome)) {
      // a plain choice: neither the tunnel's address nor a reason to start Ovis on that PC (it runs)
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
      // the fresh setup (it reuses the live server: its update is not needed) and the saved PC's own reconnect both refuse
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
      // the plain words stay on the PC while it waits; no choice is pending
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ error: "Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.", action_required: null, target: { own_ovis: socket } });
      for (const command of commands) expect(command).not.toContain(descriptor.token);
      return;
    }
    // a chosen Ovis that is gone (no registration, its process stopped) asks only a setup started in its dialog; a
    // reconnect waits for it (below)
    // and so does one whose identity cannot be established (open)
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
      // a PC no longer connected tells no runtime: what runs there may change while it is away
      manager.patch(chosen.machine_id!, { enabled: false });
      expect(manager.list().find((pc) => pc.id === chosen.machine_id)?.runtime).toBeUndefined();
    } else if (outcome === "newer bundle") {
      // it answered with what it is: that decision is told in its own words, not as an Ovis to start there
      expect(chosen).toMatchObject({ phase: "failed", action_required: "setup" });
      expect(chosen.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
      expect(chosen.found_ovis).toBeUndefined();
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
    } else if (open.includes(outcome)) {
      // owned and live, its identity not established: still offered, never dropped, nothing started in its place
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

// After a reboot SSH answers before the user's Ovis has started: the saved PC waits for it (#2047), starting nothing
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
  // the PC's own reconnect ends in a retry scheduled or a decision for the user, whichever comes first
  const settled = Promise.withResolvers<"retry" | "decision">();
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater").mockImplementation(() => settled.resolve("retry"));
  const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
  const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
  try {
    manager.patch(id, { enabled: true });
    expect(await settled.promise).toBe("retry");
    expect(starts).toBe(0);
    // the plain words stay on the PC while it waits; no choice is pending
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ error: "Start Ovis on that PC, or start a new herdr here", action_required: null, target: { own_ovis: socket } });
  } finally {
    clearTimeout(timeout); off(); manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); rmSync(dir, { recursive: true, force: true });
  }
});

// The account's sessions are read on that PC for the choice: a dropped SSH connection is said as that, never as a PC with
// no herdr sessions, while a bundle that cannot run discovery still leaves the choice, with none listed
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
    // the chosen Ovis is gone: a setup started in its dialog gets the choice, with the sessions read there
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
  // the PC's own reconnect ends in a retry scheduled (the bug) or a decision for the user, whichever comes first
  const settled = Promise.withResolvers<"retry" | "decision">();
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater").mockImplementation(() => settled.resolve("retry"));
  const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
  const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
  try {
    manager.patch(id, { enabled: true });
    expect(await settled.promise).toBe("decision");
    // a decision for the user, as any MachineActionRequired: the PC waits for it instead of reconnecting
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "error", action_required: "setup" });
    expect(retries).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timeout); off(); manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); rmSync(dir, { recursive: true, force: true });
  }
});

// What tells the default session chosen by its socket (saved as no choice) from any other socket: both are spelled as
// the bridge spells its own, through a link too
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
    // the same tunnel opens for a valid registration, so the refusal is the change's
    expect(await tunnel(ssh, valid)).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), token: valid.token });
    expect(forwards).toEqual([valid.port]);
    await expect(tunnel(ssh, { ...valid, ...change })).rejects.toThrow("Invalid bridge credentials");
    expect(forwards).toEqual([valid.port]);
  } finally {
    manager.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
