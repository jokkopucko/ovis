/**
 * A PC with any trace of herdr's TUI keeps herdr and nothing is run to decide it; only a PC with
 * none looks for herdr-core, asking a candidate `--version` and nothing else (every other hc
 * command starts a core).
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { HerdrCoreFacts, HerdrRuntimeFacts, RuntimeLock, RuntimeSource } from "../../shared/machines.ts";
import { herdrConfigPath } from "../herdr-sidebar.ts";
import { userHome } from "../user-home.ts";
import { coreSocket } from "./core-socket.ts";
import { discoverHc, type FoundHc } from "./discovery.ts";
import type { Runtime } from "./runtime.ts";
import { readSavedRuntime, runtimeFile, saveRuntime } from "./runtime-file.ts";

type Env = Record<string, string | undefined>;

export interface RuntimeTraces {
  /** herdr's TUI is installed: OVIS_HERDR_BIN's herdr, a herdr on the PATH, in ~/.local/bin or (Windows) %LOCALAPPDATA%\Programs\Herdr\bin, or its config.toml */
  tuiInstalled: boolean;
  tuiRunning: boolean;
  appInstalled: boolean;
  coreRunning: boolean;
}

export interface TraceOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** where the system keeps apps for every user (/Applications on macOS); tests pass their own */
  systemAppDirs?: readonly string[];
}

export function runtimeTraces(options: TraceOptions = {}): RuntimeTraces {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome(env, platform);
  const exe = platform === "win32" ? ".exe" : "";
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  // herdr's own files: its folder as herdr resolves it (herdrConfigPath: XDG_CONFIG_HOME when it is set,
  // else %APPDATA% on Windows), and the default the server asks (herdrSocketPath)
  const appData = env["APPDATA"] || join(home, "AppData", "Roaming");
  const herdrDirs = [...new Set([dirname(herdrConfigPath({ ...env, HERDR_CONFIG_PATH: undefined }, platform, home)), platform === "win32" ? join(appData, "herdr") : join(home, ".config", "herdr")])];
  // where herdr's installer puts it: ~/.local/bin, and %LOCALAPPDATA%\Programs\Herdr\bin on Windows
  const installDir = platform === "win32" ? join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "Programs", "Herdr", "bin") : join(home, ".local", "bin");
  // Windows spells the key Path, and a copy of process.env keeps that spelling (as scripts/plugin.ts reads it)
  const path = env[platform === "win32" ? Object.keys(env).sort().find((key) => key.toLowerCase() === "path") ?? "PATH" : "PATH"] ?? "";
  const herdrOnPath = path.split(platform === "win32" ? ";" : delimiter).filter((dir) => dir !== "")
    .some((dir) => isFile(join(dir, `herdr${exe}`)));
  const named = env["OVIS_HERDR_BIN"];
  // a bare name is looked up on PATH, as the spawn does (server/core/terminal-process.ts)
  const namedFound = named !== undefined && named !== "" && (/[\\/]/.test(named) ? isFile(named) : Bun.which(named, { PATH: path }) !== null);
  // HERDR_CONFIG_PATH names herdr's config wherever it is kept (herdrConfigPath in server/herdr-sidebar.ts)
  const configPath = env["HERDR_CONFIG_PATH"];
  const tuiInstalled = herdrOnPath || namedFound || isFile(join(installDir, `herdr${exe}`)) || herdrDirs.some((dir) => isFile(join(dir, "config.toml")))
    || (configPath !== undefined && configPath !== "" && isFile(configPath));
  // the socket HERDR_SOCKET names and the default one are both traces: a stale variable hides no running TUI
  const tuiRunning = [env["HERDR_SOCKET"], ...herdrDirs.map((dir) => join(dir, "herdr.sock"))].some((socket) => socket !== undefined && socket !== "" && exists(socket));
  const systemApps = options.systemAppDirs ?? (platform === "darwin" ? ["/Applications"] : []);
  const appInstalled = (platform === "win32"
    ? [join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "Programs", "herdr-app")]
    : [join(home, ".local", "share", "herdr-app"), join(home, "Applications", "Herdr.app"), ...systemApps.map((dir) => join(dir, "Herdr.app"))])
    .concat(join(config, "herdr-app"))
    .some(exists);
  return { tuiInstalled, tuiRunning, appInstalled, coreRunning: coreSocket({ env, home, platform }).running };
}

export interface RuntimeChoice {
  runtime: Runtime;
  source: RuntimeSource;
  reason: string;
}

export function environmentRuntime(env: Env = process.env): Runtime | undefined {
  const value = env["OVIS_RUNTIME"];
  if (value === undefined || value === "") return undefined;
  if (value === "herdr" || value === "herdr-core" || value === "alt-runtime") return value;
  throw new Error(`OVIS_RUNTIME=${value} is not a runtime Ovis knows: use herdr (the default), herdr-core or alt-runtime`);
}

export interface ChooseOptions extends TraceOptions {
  stateDir: string;
  port: number;
  find?: () => Promise<FoundHc | null>;
}

export async function chooseRuntime(options: ChooseOptions): Promise<RuntimeChoice> {
  const env = options.env ?? process.env;
  const named = environmentRuntime(env);
  if (named !== undefined) return { runtime: named, source: "env", reason: `OVIS_RUNTIME=${named}` };
  const platform = options.platform ?? process.platform;
  if (!servesCore(platform)) return { runtime: "herdr", source: "detected", reason: `herdr-core is not served on ${platform}` };
  const saved = readSavedRuntime(options.stateDir, options.port);
  if (saved !== null) return { runtime: saved.runtime, source: "saved", reason: `chosen in Settings (${runtimeFile(options.port)})` };
  if (platform === "win32") return { runtime: "herdr", source: "detected", reason: "herdr is the default on Windows; Settings switches to herdr-core" };
  const traces = runtimeTraces(options);
  if (traces.tuiInstalled || traces.tuiRunning) return { runtime: "herdr", source: "detected", reason: "herdr's TUI is on this PC" };
  if (!traces.appInstalled && !traces.coreRunning) return { runtime: "herdr", source: "detected", reason: "neither herdr's TUI nor the Herdr app is on this PC" };
  const core = await (options.find ?? (() => discoverHc({ env, ...(options.home === undefined ? {} : { home: options.home }), ...(options.platform === undefined ? {} : { platform: options.platform }) })))();
  if (core === null) return { runtime: "herdr", source: "detected", reason: "the Herdr app is on this PC, but no herdr-core answered --version" };
  return { runtime: "herdr-core", source: "detected", reason: `no herdr TUI on this PC, and the Herdr app's core (hc ${core.version}) is` };
}

/**
 * `managed`: a launcher that restarts the server on a switch started it, which says so with
 * OVIS_RUNTIME_SWITCH (an older supervisor a release fell back to does not, and would ignore the
 * request).
 */
export function runtimeLock(env: Env = process.env, platform: NodeJS.Platform = process.platform, managed?: boolean, ipc = typeof process.send === "function"): RuntimeLock | null {
  managed ??= env["OVIS_MANAGED"] === "1" && env["OVIS_RUNTIME_SWITCH"] === "1" && ipc;
  if (environmentRuntime(env) !== undefined) return "env";
  if (!managed) return "unmanaged";
  if (!servesCore(platform)) return "platform";
  return null;
}

function servesCore(platform: NodeJS.Platform): boolean {
  return platform === "linux" || platform === "darwin" || platform === "win32";
}

export type SwitchAnswer = { ok: true } | { ok: false; status: number; code: string; message: string };

export interface RuntimeService {
  facts: () => HerdrRuntimeFacts;
  request: (target: unknown) => SwitchAnswer;
  switching?: () => boolean;
}

export interface RuntimeServiceOptions {
  stateDir: string;
  port: number;
  serving: Runtime;
  source: RuntimeSource;
  fallback?: "no_herdr_core" | "no_alt_runtime";
  env: Env;
  core: () => HerdrCoreFacts | undefined;
  restart: (id: string) => void;
  platform?: NodeJS.Platform;
  managed?: boolean;
  systemAppDirs?: readonly string[];
  accepted?: () => boolean;
}

export function runtimeService(options: RuntimeServiceOptions): RuntimeService {
  const platform = options.platform ?? process.platform;
  const facts = (): HerdrRuntimeFacts => {
    const traces = runtimeTraces({ env: options.env, platform, ...(options.systemAppDirs ? { systemAppDirs: options.systemAppDirs } : {}) });
    const locked = runtimeLock(options.env, platform, options.managed);
    const other: Runtime = options.serving === "herdr" ? "herdr-core" : "herdr";
    const available = other === "herdr-core" ? (options.core()?.version ?? null) !== null : traces.tuiInstalled || traces.tuiRunning;
    return {
      serving: options.serving, source: options.source,
      tui: { installed: traces.tuiInstalled, running: traces.tuiRunning }, app_installed: traces.appInstalled,
      switch_to: locked === null && available ? other : null, locked,
      ...(options.fallback ? { fallback: options.fallback } : {}),
    };
  };
  let requested = false;
  return {
    facts,
    switching: () => requested || options.accepted?.() === false,
    request: (target) => {
      if (target !== "herdr" && target !== "herdr-core" && target !== "alt-runtime") return { ok: false, status: 400, code: "invalid_runtime", message: "runtime must be herdr, herdr-core or alt-runtime" };
      const now = facts();
      if (now.locked !== null) return { ok: false, status: 409, code: "runtime_locked", message: now.locked === "env" ? "OVIS_RUNTIME in the server's environment decides the runtime" : now.locked === "unmanaged" ? "this server was not started by Ovis's launcher, so it cannot restart itself" : `herdr-core is not served on ${platform}` };
      if (requested || options.accepted?.() === false) return { ok: false, status: 409, code: "runtime_switching", message: requested ? "the server is already restarting on another runtime" : "the server is still starting; switch once it is up" };
      if (now.switch_to !== target) return { ok: false, status: 409, code: "runtime_unavailable", message: target === now.serving ? `this server already serves ${target}` : `${target} is not on this PC` };
      const id = randomUUID();
      saveRuntime(options.stateDir, options.port, { runtime: target, previous: options.serving, id, ...(options.source === "detected" ? { previous_detected: true } : {}) });
      requested = true;
      options.restart(id);
      return { ok: true };
    },
  };
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function exists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}
