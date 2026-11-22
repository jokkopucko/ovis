import "./adopt-legacy-env.ts";
import { dropDesktopOwnerFd } from "./account/local-confirm.ts";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { readUpdateIpcRequest } from "../shared/update.ts";
import { restoreRuntime } from "./herdr-core/runtime-file.ts";
import { defaultStateDir, HANDOVER_EXIT, moveLegacyStateDir, updateStateDir } from "./update-state.ts";
import { herdrMayListen, herdrSocketPath } from "./herdr/client.ts";
import { legacyLauncherStateDir, withLegacyNames } from "./legacy-env.ts";
import { COMPILED, ENTRIES, entryCommand, ROOT } from "./entries.ts";
import { installedBinaryAt, pluginBinaryOf } from "./updater.ts";
import { acquireOwnerDirectory } from "./owner-guard.ts";
import { profileFolderRefusal } from "./profile-marker.ts";
import { runCommand, updateChannel, Updater, type Release } from "./updater.ts";

const RUST_HOST_RETRY_MS = 6 * 60 * 60_000;
/**
 * How long a stopping supervisor waits for its Rust PTY host try to end: the try's 2 s SIGTERM grace,
 * then 5 s after its group's SIGKILL. A descendant that left the group, or one the kernel cannot kill
 * yet (D state), may keep the try's pipes open for good; the supervisor still exits, or the plugin
 * could never start it again.
 */
const RUST_HOST_STOP_MS = 7_000;

function installMissingRustHost(directory: string, signal: AbortSignal): Promise<void> | null {
  const bin = join(directory, "bin");
  if (process.platform === "win32" || !existsSync(join(directory, "scripts", "pty-sidecar.ts"))
    || existsSync(join(bin, "ovis-pty-sidecar.json"))) return null;
  const attempt = join(bin, "ovis-pty-sidecar.attempt");
  try {
    if (Date.now() - statSync(attempt).mtimeMs < RUST_HOST_RETRY_MS) return null;
  } catch {}
  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(attempt, `${new Date().toISOString()}\n`);
  } catch (error) {
    console.error("Rust PTY host install not tried: its attempt could not be marked", error);
    return null;
  }
  return runCommand(directory, [process.execPath, "scripts/pty-sidecar.ts", "install"], signal, 120_000).then(
    (output) => console.log(output),
    (error: unknown) => console.error("Rust PTY host install failed; terminals use the Node PTY sidecar", error),
  );
}

async function boundedStop(try_: Promise<void>, directory: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), RUST_HOST_STOP_MS); });
  const outcome = await Promise.race([try_.then(() => "ended" as const), late]);
  clearTimeout(timer);
  if (outcome === "late") console.warn(`Rust PTY host install in ${directory} did not end ${RUST_HOST_STOP_MS / 1000} s after it was stopped; exiting anyway. A process of it may still run.`);
}

export async function runSupervisor(root = ROOT) {
  // the desktop app's confirm channel is the server's alone: never passed on, never held by a child of this one
  dropDesktopOwnerFd(process.argv);
  root = resolve(root);
  const port = Number(process.env["PORT"] || DEFAULT_PORT);
  const host = process.env["HOST"] ?? "127.0.0.1";
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
  const origin = `http://${probeHost}:${port}`;
  // a launcher from before the rename finds its releases only under the old state dir: the move
  // waits for a launcher of this version
  const legacyStateDir = legacyLauncherStateDir(process.env);
  const supervisor = { root, port, directory: ROOT };
  // a folder a machine profile marked is its own: nothing of this launch happens there, the legacy move included
  // (server/profile-marker.ts)
  const marked = profileFolderRefusal(resolve(legacyStateDir ?? defaultStateDir(process.env, supervisor)));
  if (marked !== null) {
    console.error(marked);
    process.exit(1);
  }
  if (legacyStateDir === null) moveLegacyStateDir(process.env, supervisor);
  const appStateDir = resolve(legacyStateDir ?? defaultStateDir(process.env, supervisor));
  const socketPath = resolve(herdrSocketPath());
  const stateDir = updateStateDir(root, port, appStateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // A crash or a forced Windows shutdown skips lock cleanup, and the old PID may belong to
  // someone else by now: the lock records the owner's birth, so only a provably gone owner is replaced.
  const lock = acquireOwnerDirectory(join(stateDir, "supervisor.lock"), {
    running: "A managed server is already running for this checkout and port.",
    starting: "Another server is starting. Try again.",
  });
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let active: Release | null = null;
  let switching = true, stopping = false;
  let replacedSwitch: string | null = null;
  // The bridge answers before its first health check has passed here. An install taken in that
  // gap stopped the bridge under the check, and the start failed: commands wait for the start.
  const started = Promise.withResolvers<void>();
  const publish = () => {
    if (updater.status.phase === "error") console.error(`Update failed: ${updater.status.error}`);
    // revision_bound_install: this supervisor reads `update-install-revision` and installs only the revision it names
    try { child?.send({ type: "update-status", status: { ...updater.status, revision_bound_install: true }, notes: updater.notes, installed: updater.installed }); } catch {}
  };
  async function stopChild() {
    const prior = child;
    child = null;
    if (!prior || prior.exitCode !== null) return;
    prior.kill("SIGTERM");
    const timer = setTimeout(() => prior.kill("SIGKILL"), 6000);
    await prior.exited;
    clearTimeout(timer);
  }
  /**
   * A herdr TUI that is stopped is no failed start: Settings offers it, and the user starts herdr
   * later.
   */
  async function launch(release: Release | null) {
    if (stopping) throw new Error("Server is stopping");
    const bootId = crypto.randomUUID();
    const settings = { OVIS_MANAGED: "1", OVIS_RUNTIME_SWITCH: "1", OVIS_BOOT_ID: bootId, OVIS_STATE_DIR: appStateDir, OVIS_REVISION: release?.revision ?? "" };
    const candidate = Bun.spawn(COMPILED ? entryCommand("serve") : [process.execPath, ENTRIES.serve], {
      cwd: release?.directory ?? root, windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      // a launcher from before the rename runs from a checkout from before it, where a release that
      // fails falls back to: that bridge reads its settings under the old names
      env: { ...process.env, ...(legacyStateDir === null ? settings : withLegacyNames(settings)), HERDR_SOCKET: socketPath },
      ipc(message) {
        if (message?.type === "update-status-request") publish();
        if (message?.type === "runtime-restart" && typeof message.id === "string") {
          const id: string = message.id;
          void started.promise.then(() => {
            if (child === candidate) void restartForRuntime(id);
            else {
              if (switching) replacedSwitch = id;
              console.log("A runtime switch came from a bridge already replaced; the bridge now running started on the saved choice.");
            }
          });
        }
        // an unbound `install` (an older bridge's) is refused: an install names the revision offered
        const request = readUpdateIpcRequest(message);
        if (request) {
          if (request.command === "cancel") updater.cancel(request.install_id);
          else void started.promise.then(() => updater.request(request.command, true, request.command === "install" ? request.expected_revision : undefined, request.command === "install" ? request.install_id : undefined));
        }
      },
      onExit(proc, code) {
        if (child === proc && !switching && !stopping) {
          console.error(`Bridge exited unexpectedly (${code}).`);
          void shutdown(1);
        }
      },
    });
    child = candidate;
    const deadline = Date.now() + 20_000;
    const ours = (body: { web_ui?: { boot_id?: string } }) => body.web_ui?.boot_id === bootId;
    while (Date.now() < deadline && !stopping && candidate.exitCode === null) {
      try {
        const bridge = await fetch(`${origin}/api/health?scope=bridge`, { signal: AbortSignal.timeout(1000) });
        const own = await bridge.json() as { web_ui?: { boot_id?: string }; runtime?: string };
        // a bridge from before its own answer carried the boot id (an older checkout a release falls back
        // to): the whole health answer is the only check it can pass, as it always was
        const older = bridge.ok && own.web_ui === undefined;
        if (older || bridge.ok && ours(own)) {
          let ready = !older && (own.runtime === undefined || own.runtime === "herdr") && !await herdrMayListen(socketPath);
          if (!ready) {
            const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
            ready = response.ok && ours(await response.json() as { web_ui?: { boot_id?: string } });
          }
          if (ready) {
            try { candidate.send({ type: "bridge-accepted" }); } catch {}
            publish();
            return;
          }
        }
      } catch { /* wait for this exact bridge, never mistake another port owner for it */ }
      await Bun.sleep(100);
    }
    await stopChild();
    throw new Error("The new bridge failed its startup health check.");
  }
  let lane: Promise<unknown> = Promise.resolve();
  function exclusive<T>(change: () => Promise<T>): Promise<T> {
    const run = lane.then(change, change);
    lane = run.catch(() => {});
    return run;
  }
  function checkBridge() {
    if (!stopping && (child === null || child.exitCode !== null)) {
      console.error(child === null ? "No bridge is running after a failed change." : `Bridge exited unexpectedly (${child.exitCode}).`);
      void shutdown(1);
    }
  }
  function restartForRuntime(id: string) {
    return exclusive(async () => {
      if (stopping) { console.error("Not switching the runtime: Ovis is stopping."); return; }
      switching = true;
      try {
        await stopChild();
        try { await launch(active); }
        catch (error) {
          if (stopping || !restoreRuntime(appStateDir, port, id)) throw error;
          console.error(`The bridge failed to start on the chosen runtime (${error instanceof Error ? error.message : error}); going back to the previous one.`);
          await stopChild();
          await launch(active);
        }
      } catch (error) {
        console.error(error);
        await shutdown(1);
      } finally { switching = false; checkBridge(); }
    });
  }
  const pluginRoot = process.env["HERDR_PLUGIN_ROOT"];
  const launched = typeof process.send === "function";
  const updater = new Updater({ root, stateDir, autoUpdate: process.env["OVIS_AUTO_UPDATE"] === "1", publish,
    channel: () => updateChannel(process.env, appStateDir),
    pluginCheckout: pluginRoot !== undefined && resolve(pluginRoot) === root,
    // the herdr plugin's launcher runs this compiled server from its checkout's .ovis/server: herdr updates it
    pluginBinary: pluginBinaryOf(process.env["OVIS_PLUGIN_CHECKOUT"], COMPILED),
    installedBinary: installedBinaryAt(root, COMPILED),
    notice: process.env["OVIS_SUPERVISOR_FALLBACK"]
      ? "The updated supervisor failed to start, so the previous one is running this version. The next update tries again."
      : undefined,
    async afterInstall() {
      if (!launched || stopping) return;
      console.log("Update installed; handing over to the new supervisor.");
      await shutdown(HANDOVER_EXIT);
    },
    activate(next, commit) {
      return exclusive(async () => {
        switching = true;
        replacedSwitch = null;
        try {
          await stopChild();
          try { await launch(next); commit(); }
          catch (error) {
            await stopChild();
            if (replacedSwitch !== null && restoreRuntime(appStateDir, port, replacedSwitch)) console.error("Going back to the runtime from before the switch made during the update.");
            await launch(active);
            throw new Error(`${error instanceof Error ? error.message : error} Previous version restored.`);
          }
          active = next;
        } finally { replacedSwitch = null; switching = false; checkBridge(); }
      });
    },
  });
  const rustHostInstall = new AbortController();
  let rustHostTry: { directory: string; done: Promise<void> } | null = null;
  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true; updater.stop(); rustHostInstall.abort();
    // waited for, so that one of the try's group that ignores SIGTERM is still killed past the grace,
    // which an exit now would have dropped with it; past RUST_HOST_STOP_MS this lets go all the same,
    // and a process of the try may still run
    await Promise.all([stopChild(), rustHostTry && boundedStop(rustHostTry.done, rustHostTry.directory)]);
    lock.release();
    process.exit(code);
  }
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  try {
    active = await updater.initialize();
    try { await launch(active); }
    catch (error) {
      if (!active || active.directory === root) throw error;
      console.error("Saved release failed; starting the source checkout.", error);
      rmSync(join(stateDir, "current.json"), { force: true });
      active = await updater.initialize();
      await launch(active);
    }
    switching = false;
    started.resolve();
    updater.start();
    if (active && active.directory !== root && !stopping) {
      const done = installMissingRustHost(active.directory, rustHostInstall.signal);
      if (done !== null) rustHostTry = { directory: active.directory, done };
    }
    process.send?.({ type: "supervisor-ready" });
    console.log(`Managed updates: ${updater.status.auto_update ? "automatic install" : "automatic checks, install from Settings"}`);
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
}

if (import.meta.main) await runSupervisor(process.env["OVIS_SOURCE_ROOT"] || ROOT);
