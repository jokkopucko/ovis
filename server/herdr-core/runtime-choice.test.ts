import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCoreFacts } from "../../shared/machines.ts";
import { chooseRuntime, runtimeLock, runtimeService, runtimeTraces } from "./runtime-choice.ts";
import { readSavedRuntime, restoreRuntime, saveRuntime } from "./runtime-file.ts";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** a home and a state folder of their own, and an environment that points nothing at the developer's */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "ovis-runtime-choice-"));
  cleanup = () => rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { HOME: home, PATH: join(root, "empty"), XDG_CONFIG_HOME: join(home, ".config"), XDG_RUNTIME_DIR: join(root, "run"), HC_SESSION: "test" };
  const touch = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, ""); };
  return { root, home, state, env, touch };
}

const core = { bin: "/stand-in/herdr-core", version: "0.1.17" };

it("reads the PC's traces from files alone", () => {
  const { home, env, touch, root } = scratch();
  expect(runtimeTraces({ env, home, platform: "darwin", systemAppDirs: [join(root, "Applications")] })).toEqual({ tuiInstalled: false, tuiRunning: false, appInstalled: false, coreRunning: false });
  mkdirSync(join(root, "Applications", "Herdr.app"), { recursive: true });
  expect(runtimeTraces({ env, home, platform: "darwin", systemAppDirs: [join(root, "Applications")] }).appInstalled).toBe(true);
  rmSync(join(root, "Applications"), { recursive: true });
  // a HERDR_SOCKET left from another session hides no TUI running at the default socket
  touch(join(home, ".config", "herdr", "herdr.sock"));
  expect(runtimeTraces({ env: { ...env, HERDR_SOCKET: join(root, "gone.sock") }, home, platform: "linux" }).tuiRunning).toBe(true);
  rmSync(join(home, ".config", "herdr", "herdr.sock"));
  touch(join(home, ".config", "herdr", "config.toml"));
  touch(join(home, ".config", "herdr", "herdr.sock"));
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  touch(join(root, "run", "herdr-core", "test.sock"));
  expect(runtimeTraces({ env, home, platform: "linux" })).toEqual({ tuiInstalled: true, tuiRunning: true, appInstalled: true, coreRunning: true });
});

it("reads herdr's traces where herdr keeps them on Windows", () => {
  const { home, env, touch, root } = scratch();
  const appData = join(root, "Roaming");
  const localAppData = join(root, "Local");
  const windows = { ...env, XDG_CONFIG_HOME: "", APPDATA: appData, LOCALAPPDATA: localAppData };
  expect(runtimeTraces({ env: windows, home, platform: "win32" })).toMatchObject({ tuiInstalled: false, tuiRunning: false });
  // herdr's installer puts herdr.exe in %LOCALAPPDATA%\Programs\Herdr\bin, which a service's PATH may not hold
  touch(join(localAppData, "Programs", "Herdr", "bin", "herdr.exe"));
  expect(runtimeTraces({ env: windows, home, platform: "win32" }).tuiInstalled).toBe(true);
  rmSync(join(localAppData, "Programs"), { recursive: true });
  // its config and its socket are in %APPDATA%\herdr
  touch(join(appData, "herdr", "config.toml"));
  touch(join(appData, "herdr", "herdr.sock"));
  expect(runtimeTraces({ env: windows, home, platform: "win32" })).toMatchObject({ tuiInstalled: true, tuiRunning: true });
  // the server asks %APPDATA%\herdr\herdr.sock (herdrSocketPath) even where XDG_CONFIG_HOME is set
  rmSync(join(appData, "herdr", "config.toml"));
  expect(runtimeTraces({ env: { ...windows, XDG_CONFIG_HOME: join(root, "xdg") }, home, platform: "win32" })).toMatchObject({ tuiInstalled: false, tuiRunning: true });
});

it("finds a herdr.exe on the Windows Path, whose key Windows spells Path", () => {
  const { home, env, touch, root } = scratch();
  const { PATH: _unused, ...rest } = env;
  const windows = { ...rest, XDG_CONFIG_HOME: "", APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local") };
  touch(join(root, "tools", "herdr.exe"));
  expect(runtimeTraces({ env: { ...windows, Path: `${join(root, "empty")};${join(root, "tools")}` }, home, platform: "win32" }).tuiInstalled).toBe(true);
});

it("keeps herdr wherever herdr's TUI left a trace, without looking for hc", async () => {
  const { home, state, env, touch, root } = scratch();
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  touch(join(root, "run", "herdr-core", "test.sock"));
  let looked = 0;
  const find = async () => { looked += 1; return core; };
  for (const trace of [join(home, ".config", "herdr", "config.toml"), join(home, ".local", "bin", "herdr"), join(home, ".config", "herdr", "herdr.sock")]) {
    touch(trace);
    expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
    rmSync(trace);
  }
  // a herdr OVIS_HERDR_BIN names outside those places is the TUI Ovis runs
  touch(join(root, "opt", "herdr"));
  expect(await chooseRuntime({ stateDir: state, port: 7, env: { ...env, OVIS_HERDR_BIN: join(root, "opt", "herdr") }, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
  // a config HERDR_CONFIG_PATH names is herdr's TUI too
  touch(join(root, "etc", "herdr.toml"));
  expect(await chooseRuntime({ stateDir: state, port: 7, env: { ...env, HERDR_CONFIG_PATH: join(root, "etc", "herdr.toml") }, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
  // a bare name is found on PATH, as the spawn finds it
  touch(join(root, "bin", "custom-herdr"));
  chmodSync(join(root, "bin", "custom-herdr"), 0o755);
  expect(await chooseRuntime({ stateDir: state, port: 7, env: { ...env, PATH: join(root, "bin"), OVIS_HERDR_BIN: "custom-herdr" }, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
  expect(looked).toBe(0);
});

it("chooses herdr-core on a PC with no TUI, a verified hc and the Herdr app or its running core", async () => {
  const { home, state, env, touch, root } = scratch();
  // neither the app nor a core: nothing is looked for
  let looked = 0;
  const find = async () => { looked += 1; return core; };
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr" });
  expect(looked).toBe(0);
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr-core", source: "detected" });
  // the app, but no hc that answers --version as herdr-core's
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find: async () => null })).toMatchObject({ runtime: "herdr" });
  rmSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  touch(join(root, "run", "herdr-core", "test.sock"));
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr-core", source: "detected" });
});

it("never chooses herdr-core by itself on Windows or where it is not served", async () => {
  const { home, state, env } = scratch();
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  mkdirSync(join(home, "AppData", "Local", "Programs", "herdr-app"), { recursive: true });
  for (const platform of ["win32", "freebsd"] as const) {
    expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform, find: async () => core })).toMatchObject({ runtime: "herdr", source: "detected" });
  }
  // where herdr-core is not served, not from a saved choice either, which a state folder carried over from another PC may hold
  saveRuntime(state, 7, { runtime: "herdr-core", previous: null });
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "freebsd", find: async () => core })).toMatchObject({ runtime: "herdr", source: "detected" });
});

it("serves on Windows the runtime chosen in Settings", async () => {
  const { home, state, env } = scratch();
  const find = async () => core;
  for (const runtime of ["herdr-core", "herdr"] as const) {
    saveRuntime(state, 7, { runtime, previous: null });
    expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "win32", find })).toMatchObject({ runtime, source: "saved" });
  }
});

it("takes OVIS_RUNTIME first, then the choice saved in Settings, then the PC's facts", async () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  const find = async () => core;
  saveRuntime(state, 7, { runtime: "herdr-core", previous: "herdr" });
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr-core", source: "saved" });
  expect(await chooseRuntime({ stateDir: state, port: 7, env: { ...env, OVIS_RUNTIME: "herdr" }, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "env" });
  await expect(chooseRuntime({ stateDir: state, port: 7, env: { ...env, OVIS_RUNTIME: "tmux" }, home, platform: "linux", find })).rejects.toThrow(/OVIS_RUNTIME=tmux/);
  // a saved file Ovis cannot read is no choice
  writeFileSync(join(state, "runtime-7.json"), "{ not json");
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
});

it("keeps each port's choice to itself, and a failed switch from the PC's facts goes back to the facts", async () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  saveRuntime(state, 7, { runtime: "herdr-core", previous: "herdr", id: "mine", previous_detected: true });
  expect(await chooseRuntime({ stateDir: state, port: 8, env, home, platform: "linux", find: async () => core })).toMatchObject({ runtime: "herdr", source: "detected" });
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find: async () => core })).toMatchObject({ runtime: "herdr-core", source: "saved" });
  expect(restoreRuntime(state, 7, "mine")).toBe(true);
  expect(readSavedRuntime(state, 7)).toBeNull();
  expect(await chooseRuntime({ stateDir: state, port: 7, env, home, platform: "linux", find: async () => core })).toMatchObject({ runtime: "herdr", source: "detected" });
});

it("takes a launcher that does not say it restarts on a switch for no launcher", () => {
  // an older supervisor a release fell back to sets OVIS_MANAGED but would ignore the request
  expect(runtimeLock({ OVIS_MANAGED: "1" }, "linux", undefined, true)).toBe("unmanaged");
  expect(runtimeLock({ OVIS_MANAGED: "1", OVIS_RUNTIME_SWITCH: "1" }, "linux", undefined, true)).toBeNull();
  // and without the launcher's IPC channel there is nobody to ask
  expect(runtimeLock({ OVIS_MANAGED: "1", OVIS_RUNTIME_SWITCH: "1" }, "linux", undefined, false)).toBe("unmanaged");
});

it("locks the switch when OVIS_RUNTIME decides, the server has no launcher, or herdr-core is not served on the OS", () => {
  expect(runtimeLock({ OVIS_RUNTIME: "herdr-core" }, "linux", true)).toBe("env");
  expect(runtimeLock({}, "linux", false)).toBe("unmanaged");
  expect(runtimeLock({}, "freebsd", true)).toBe("platform");
  expect(runtimeLock({}, "darwin", true)).toBeNull();
  // Windows serves herdr-core too: Settings switches there
  expect(runtimeLock({}, "win32", true)).toBeNull();
});

it("switches only to a runtime the PC has, saves it with the one it replaces, and asks for one restart", () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  const restarts: string[] = [];
  let coreFacts: HerdrCoreFacts | undefined = { version: null, session: "test", running: false };
  const service = runtimeService({ stateDir: state, port: 7, serving: "herdr", source: "detected", env, core: () => coreFacts, restart: (id) => { restarts.push(id); }, platform: "linux", managed: true, systemAppDirs: [] });
  expect(service.facts()).toMatchObject({ serving: "herdr", switch_to: null, locked: null, tui: { installed: true, running: false } });
  expect(service.request("herdr-core")).toMatchObject({ ok: false, status: 409, code: "runtime_unavailable" });
  expect(service.request("tmux")).toMatchObject({ ok: false, status: 400 });
  coreFacts = { version: "0.1.17", session: "test", running: false };
  expect(service.facts().switch_to).toBe("herdr-core");
  expect(service.request("herdr")).toMatchObject({ ok: false, code: "runtime_unavailable" });
  expect(readSavedRuntime(state, 7)).toBeNull();
  expect(restarts).toEqual([]);
  expect(service.switching?.()).toBe(false);
  expect(service.request("herdr-core")).toEqual({ ok: true });
  expect(restarts).toHaveLength(1);
  // a move asked for now is refused: the server is restarting
  expect(service.switching?.()).toBe(true);
  // the launcher is told which saved choice to put back if the start on it fails
  expect(readSavedRuntime(state, 7)).toEqual({ runtime: "herdr-core", previous: "herdr", id: restarts[0], previous_detected: true });
  // the restart is under way: a second switch waits for the server that comes next
  expect(service.request("herdr-core")).toMatchObject({ ok: false, code: "runtime_switching" });
  expect(restarts).toHaveLength(1);
});

it("refuses a switch, and saves nothing, where something else decides the runtime", () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  const core = () => ({ version: "0.1.17", session: "test", running: true });
  for (const [options, lock] of [[{ env: { ...env, OVIS_RUNTIME: "herdr" }, managed: true }, "env"], [{ env, managed: false }, "unmanaged"]] as const) {
    const service = runtimeService({ stateDir: state, port: 7, serving: "herdr", source: "detected", core, restart: () => { throw new Error("no restart"); }, platform: "linux", ...options });
    expect(service.facts()).toMatchObject({ switch_to: null, locked: lock });
    expect(service.request("herdr-core")).toMatchObject({ ok: false, status: 409, code: "runtime_locked" });
  }
  expect(readSavedRuntime(state, 7)).toBeNull();
});

it("saves no switch over a start the launcher has not taken yet, which it may still roll back", () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  let accepted = false;
  const restarts: string[] = [];
  const service = runtimeService({ stateDir: state, port: 7, serving: "herdr", source: "detected", env, core: () => ({ version: "0.1.17", session: "test", running: true }), restart: (id) => { restarts.push(id); }, platform: "linux", managed: true, systemAppDirs: [], accepted: () => accepted });
  expect(service.request("herdr-core")).toMatchObject({ ok: false, status: 409, code: "runtime_switching" });
  expect(readSavedRuntime(state, 7)).toBeNull();
  expect(restarts).toEqual([]);
  accepted = true;
  expect(service.request("herdr-core")).toEqual({ ok: true });
  expect(restarts).toHaveLength(1);
});

it("puts back only the choice the failed switch saved, never a later one", () => {
  const { state } = scratch();
  saveRuntime(state, 7, { runtime: "herdr-core", previous: "herdr", id: "first" });
  // another server sharing this state folder saved its own choice since
  saveRuntime(state, 7, { runtime: "herdr", previous: "herdr-core", id: "second" });
  expect(restoreRuntime(state, 7, "first")).toBe(false);
  expect(readSavedRuntime(state, 7)).toEqual({ runtime: "herdr", previous: "herdr-core", id: "second" });
  expect(restoreRuntime(state, 7, "second")).toBe(true);
  expect(readSavedRuntime(state, 7)).toEqual({ runtime: "herdr-core", previous: null });
  // nothing to go back to: the choice stays
  expect(restoreRuntime(state, 7, "second")).toBe(false);
  expect(JSON.parse(readFileSync(join(state, "runtime-7.json"), "utf8"))).toEqual({ runtime: "herdr-core", previous: null });
});

it.skipIf(process.platform === "win32")("writes the choice through nothing placed beside it beforehand", () => {
  const { state, root } = scratch();
  mkdirSync(state, { recursive: true });
  const target = join(root, "victim");
  writeFileSync(target, "kept");
  // every name a predictable temporary file could take is a link to the victim
  for (const pid of [process.pid, 1, 2]) symlinkSync(target, join(state, `runtime-7.json.${pid}.tmp`));
  saveRuntime(state, 7, { runtime: "herdr-core", previous: "herdr" });
  expect(readFileSync(target, "utf8")).toBe("kept");
  expect(readSavedRuntime(state, 7)).toEqual({ runtime: "herdr-core", previous: "herdr" });
});
