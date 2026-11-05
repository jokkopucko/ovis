/**
 * Finding herdr-core (`hc`) on this PC, the way the Herdr app does (herdr-app src/core_bin.rs),
 * and whether its core runs, without ever starting one.
 *
 * Every hc command but `--version` starts a core when none runs (`hc connect` and
 * `hc server status` included), which would leave a core and its systemd unit on a PC that only
 * uses herdr's TUI. So a candidate is only ever asked `--version`, and the core counts as running
 * when its socket file is there: nothing connects to it.
 */
import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { HerdrCoreFacts } from "../../shared/machines.ts";
import { readHerdrConfig } from "../herdr-sidebar.ts";
import { loginPathProbe, loginShell } from "../shell-agent.ts";
import { userHome } from "../user-home.ts";

type Env = Record<string, string | undefined>;

export interface FoundHc {
  /** the executable, as found */
  bin: string;
  /** what its `--version` says after `hc ` */
  version: string;
}

export interface FindHcOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** the PATH the user's login shell sets up, or null; the default asks `$SHELL -lc` */
  loginShellPath?: () => Promise<string | null>;
  /** where hc gets installed; the default is usualHcDirs */
  usualDirs?: readonly string[];
  /** how long one --version may take; PROBE_TIMEOUT_MS unset */
  timeoutMs?: number;
}

/** a slow or interactive shell profile, or a hanging binary, must not hold the server up */
const PROBE_TIMEOUT_MS = 3_000;
/** how long output is still read after the probe exits: what it left behind holding stdout is not waited on */
const EXIT_GRACE_MS = 500;
/** a version line, and a PATH, are short: anything longer is not what was asked for */
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/**
 * The first herdr-core found, or null. Where it looks, in order: OVIS_HC_BIN; this process's
 * PATH; the user's login shell's PATH (a server started by herdr's plugin or a service may not
 * carry it); then the usual install places. In each folder `herdr-core` comes before `hc`, the
 * name the core's installer gives it, and a candidate counts only when `--version` exits 0 and
 * says `hc …`: some window managers ship an unrelated `hc`.
 */
export async function findHc(options: FindHcOptions = {}): Promise<FoundHc | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome(env, platform);
  const exe = platform === "win32" ? ".exe" : "";
  const names = (dir: string) => [join(dir, `herdr-core${exe}`), join(dir, `hc${exe}`)];
  const dirsOn = (path: string | undefined) => (path ?? "").split(platform === "win32" ? ";" : delimiter).filter((dir) => dir !== "");
  const seen = new Set<string>();
  const pick = async (candidates: string[]): Promise<FoundHc | null> => {
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!isFile(candidate)) continue;
      const version = await hcVersion(candidate, env, options.timeoutMs ?? PROBE_TIMEOUT_MS);
      // absolute: a terminal attach runs it from another folder (server/core/terminal-process.ts)
      if (version !== null) return { bin: resolve(candidate), version };
    }
    return null;
  };
  // a bare name is looked up on the PATH, as a shell would run it
  const configured = env["OVIS_HC_BIN"];
  const named = configured && !/[\\/]/.test(configured) ? Bun.which(configured, { PATH: env["PATH"] ?? "" }) ?? configured : configured;
  return (named ? await pick([named]) : null)
    ?? await pick(dirsOn(env["PATH"]).flatMap(names))
    ?? await pick(dirsOn(await (options.loginShellPath ?? (() => loginShellPath(env, platform)))() ?? "").flatMap(names))
    ?? await pick((options.usualDirs ?? usualHcDirs(home, platform, env)).flatMap(names));
}

/** Where herdr-core gets installed: its own installer (~/.local/bin), Homebrew, mise, Nix, cargo. */
export function usualHcDirs(home: string, platform: NodeJS.Platform = process.platform, env: Env = process.env): string[] {
  if (platform === "win32") {
    return [join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "Programs", "herdr-core"), join(home, ".cargo", "bin")];
  }
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".nix-profile", "bin"),
    "/run/current-system/sw/bin",
    join(home, ".cargo", "bin"),
  ];
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** `0.1.17` when `bin --version` exits 0 and its output starts `hc 0.1.17`; null for anything else. The only hc command run here. */
async function hcVersion(bin: string, env: Env, timeoutMs: number): Promise<string | null> {
  const text = await probe([bin, "--version"], env, timeoutMs);
  const match = text === null ? null : /^hc (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)(?:\s|$)/.exec(text);
  return match ? match[1]! : null;
}

/** the login shell's PATH through the probe Agents uses too (server/shell-agent.ts): marked, bounded, its group killed */
async function loginShellPath(env: Env, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === "win32") return null;
  const shell = loginShell(env);
  if (shell === null) return null;
  return (await loginPathProbe({ shell, env, timeoutMs: PROBE_TIMEOUT_MS })(new AbortController().signal)).path;
}

/**
 * stdout of a command that exits 0 within `timeoutMs` and says no more than the limit, else null.
 * It runs in a process group of its own, killed once the answer is in: something it left behind
 * holding stdout is read for at most EXIT_GRACE_MS after the exit, never waited on.
 */
async function probe(argv: string[], env: Env, timeoutMs: number): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env, windowsHide: true, detached: process.platform !== "win32" });
  } catch {
    return null;
  }
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number) => new Promise<void>((resolve) => { timers.push(setTimeout(resolve, ms)); });
  const drained = (async (): Promise<boolean> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.length;
      if (size > PROBE_OUTPUT_LIMIT) return false;
      chunks.push(value);
    }
  })().catch(() => false);
  // one deadline for the whole probe: the output, then the exit
  const deadline = after(timeoutMs).then(() => "late" as const);
  try {
    const outcome = await Promise.race([
      drained.then((complete) => complete ? "read" as const : "too-much" as const),
      child.exited.then(() => after(EXIT_GRACE_MS)).then(() => "exited" as const),
      deadline,
    ]);
    if (outcome === "too-much" || outcome === "late") return null;
    const code = await Promise.race([child.exited, deadline.then(() => null)]);
    return code === 0 ? new TextDecoder().decode(Buffer.concat(chunks)) : null;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group has ended */ }
    }
    child.kill("SIGKILL");
    void reader.cancel().catch(() => {});
  }
}

export interface CoreSocketOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** `/run/user/<uid>` when that folder exists, else null: hc's runtime dir without XDG_RUNTIME_DIR */
  userRuntimeDir?: string | null;
}

export interface CoreSocket {
  session: string;
  path: string;
  /** the socket file is there; it is never connected to, so a core that died may leave one */
  running: boolean;
}

/**
 * Where the core of this environment listens, as hc works it out (herdr-core paths.rs): HC_SOCKET,
 * else `socket` in its config.toml, else `<session>.sock` in herdr-core under the runtime dir
 * (XDG_RUNTIME_DIR, else /run/user/<uid>), else beside the state in
 * `$XDG_STATE_HOME/herdr-core/<session>/` (macOS). The session is HC_SESSION, else `default`.
 */
export function coreSocket(options: CoreSocketOptions = {}): CoreSocket {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome(env, platform);
  const session = env["HC_SESSION"]?.trim() || "default";
  const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "herdr-core", "config.toml");
  const state = join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "herdr-core", session);
  const path = env["HC_SOCKET"] || configuredSocket(config) || defaultSocket();
  return { session, path, running: exists(path) };

  function defaultSocket(): string {
    if (platform === "win32") return `\\\\.\\pipe\\herdr-core-${(env["USERNAME"] ?? "").replace(/[^A-Za-z0-9]/g, "")}-${session}.sock`;
    const run = runtimeDir(env, options);
    return run === null ? join(state, `${session}.sock`) : join(run, "herdr-core", `${session}.sock`);
  }
}

function runtimeDir(env: Env, options: CoreSocketOptions): string | null {
  if (env["XDG_RUNTIME_DIR"]) return env["XDG_RUNTIME_DIR"];
  if (options.userRuntimeDir !== undefined) return options.userRuntimeDir;
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const dir = `/run/user/${uid}`;
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** `socket` in hc's config.toml, when it sets one */
function configuredSocket(config: string): string | null {
  // read as herdr's own config is: a regular file of a config's size, never a FIFO a health poll would block on
  const parsed = readHerdrConfig(config);
  const socket = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["socket"] : undefined;
  return typeof socket === "string" && socket !== "" ? socket : null;
}

function exists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

/** how long one look for hc stands: it runs a login shell and each candidate's --version */
const FIND_TTL_MS = 5 * 60_000;
let found: { at: number; hc: FoundHc | null } | null = null;
let finding: Promise<FoundHc | null> | null = null;

/**
 * Looks for hc again for Settings (one look at a time) and keeps the answer for herdrCoreFacts.
 * It never runs the login shell: its profile could run any command, `hc connect` included, from a
 * health request on a PC that never chose herdr-core. Only startRuntime looks there (findHc).
 */
export function discoverHc(options: Omit<FindHcOptions, "loginShellPath"> = {}): Promise<FoundHc | null> {
  finding ??= findHc({ ...options, loginShellPath: async () => null }).then((hc) => {
    found = { at: Date.now(), hc };
    return hc;
  }).finally(() => { finding = null; });
  return finding;
}

/**
 * What this PC has of herdr-core, for Settings: never waits. Undefined until the first look for hc
 * has ended; a look older than FIND_TTL_MS starts another, and this answer stays meanwhile.
 */
export function herdrCoreFacts(): HerdrCoreFacts | undefined {
  if (finding === null && (found === null || Date.now() - found.at > FIND_TTL_MS)) void discoverHc();
  if (found === null) return undefined;
  const socket = coreSocket();
  // hc takes only a plain folder name for a session; anything else is not told, so no path can be
  return { version: found.hc?.version ?? null, session: plainSession(socket.session), running: socket.running };
}

export function plainSession(session: string): string | null {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(session) && session !== "." && session !== ".." ? session : null;
}
