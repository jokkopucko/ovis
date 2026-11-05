/**
 * Whether each catalog agent is on this PC, and which version: its executable found the way
 * /api/agents finds it, then asked for its version with the catalog's own flag, under a time limit.
 * A version is kept for as long as the executable file is the same one (path, size, modification
 * time): an install or an update shows on the next read, and an unchanged executable is never asked
 * twice. Nothing here installs, updates or signs in.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { meetsMinVersion, parseVersion, type AgentCatalogEntry, type AgentInstallState, type CatalogPlatform } from "../shared/agent-catalog.ts";
import { loginPathProbe, loginShell, shellCommandLine, type LoginPathProbe } from "./shell-agent.ts";

/** How long one `--version` may run before it is killed and reported as timed out. */
export const VERSION_TIMEOUT_MS = 5_000;
/** At most this much of what a version flag prints is read: a version is one short line. */
const VERSION_OUTPUT_BYTES = 4096;
/** Version flags run at once at most: a first read of the whole catalog starts one process per agent. */
const PARALLEL_RUNS = 4;
/** How long output is still read after the version flag's own process exited. */
const EXIT_GRACE_MS = 200;
/** How long a timed-out read stands before it is tried again: it may have been a slow first start (an npm shim's cold cache). */
export const TIMEOUT_KEPT_MS = 60_000;

/**
 * Where a catalog binary is on this PC, as an absolute path, or null. `searchPath`, when the locator
 * has one: the PATH it looks on, the login shell's included once read, which its version flag is
 * run with too (a script's interpreter, nvm's node, may be on that PATH only).
 */
export type Locate = ((binary: string) => Promise<string | null>) & { searchPath?: () => string; refresh?: () => Promise<void> };

/** How long the login shell's PATH is kept before a lookup that misses reads it again. */
export const LOGIN_PATH_KEPT_MS = 60_000;

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
};

/**
 * Finds a catalog binary on this server's PATH, then on the PATH its user's login shell sets.
 * Installers put agents in ~/.local/bin and the like, which a login shell adds and a server run as
 * a service often lacks: without the second look, an agent an install just put there reads as not
 * installed. The login shell runs only for a binary the service PATH misses, at most once per
 * LOGIN_PATH_KEPT_MS, shared by every lookup meanwhile; only absolute executable files count.
 */
export function catalogLocator(options: { probe: LoginPathProbe | null; servicePath?: () => string; now?: () => number; signal?: AbortSignal }): Locate {
  const servicePath = options.servicePath ?? (() => process.env["PATH"] ?? "");
  const now = options.now ?? Date.now;
  const signal = options.signal ?? new AbortController().signal;
  let kept: { path: string | null; at: number } | null = null;
  let reading: Promise<string | null> | null = null;
  const loginPath = (probe: LoginPathProbe): Promise<string | null> => {
    // a read already out (a refresh after an install) is newer than what is kept
    if (reading !== null) return reading;
    if (kept !== null && now() - kept.at < LOGIN_PATH_KEPT_MS) return Promise.resolve(kept.path);
    const run: Promise<string | null> = probe(signal)
      .then((result) => result.path, () => null)
      .then((path) => { kept = { path, at: now() }; return path; })
      .finally(() => { if (reading === run) reading = null; });
    reading = run;
    return run;
  };
  // a plain GET runs what it finds: only absolute PATH entries count, never `.`, an empty or a relative
  // one, which would make whatever is in the server's working folder an agent
  const find = (binary: string, path: string): string | null => {
    const absolute = path.split(delimiter).filter((entry) => entry !== "" && isAbsolute(entry)).join(delimiter);
    if (absolute === "") return null;
    const found = Bun.which(binary, { PATH: absolute });
    return found !== null && isAbsolute(found) && isExecutableFile(found) ? found : null;
  };
  const locate = async (binary: string): Promise<string | null> => {
    const own = find(binary, servicePath());
    if (own !== null || options.probe === null) return own;
    const path = await loginPath(options.probe);
    return path === null ? null : find(binary, path);
  };
  // reads the login PATH again after any read already out (it may predate an install); refreshes asked
  // for while that one waits to start join it: one login shell for them all
  let queued: Promise<string | null> | null = null;
  const refresh = (): Promise<void> => {
    if (options.probe === null) return Promise.resolve();
    if (queued !== null) return queued.then(() => undefined);
    const probe = options.probe;
    const run: Promise<string | null> = (reading ?? Promise.resolve(null))
      .then(() => { if (queued === run) queued = null; return probe(signal).then((result) => result.path, () => null); })
      .then((path) => { kept = { path, at: now() }; return path; })
      .finally(() => { if (reading === run) reading = null; });
    queued = run;
    reading = run;
    return run.then(() => undefined);
  };
  return Object.assign(locate, { searchPath: () => [servicePath(), kept?.path ?? ""].filter((part) => part !== "").join(delimiter), refresh });
}

/** The login-shell PATH probe of the real entrypoints: none on Windows, nor where the user has no login shell. */
export function defaultLoginProbe(platform: string = process.platform): LoginPathProbe | null {
  if (platform === "win32") return null;
  const shell = loginShell();
  return shell === null ? null : loginPathProbe({ shell });
}

export interface VersionRun {
  /** what the process printed on each stream, at most VERSION_OUTPUT_BYTES of each */
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}
/** `path`: the PATH the flag runs with, instead of this server's own (not on Windows) */
export type RunVersion = (executable: string, args: readonly string[], timeoutMs: number, path?: string, signal?: AbortSignal) => Promise<VersionRun>;

/** Reads at most VERSION_OUTPUT_BYTES, and nothing more once `stop` settles: a process the timeout ended may have left a child holding the pipe. */
async function readBounded(stream: ReadableStream<Uint8Array>, stop: Promise<void>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stopped = stop.then(() => ({ done: true as const, value: undefined }));
  try {
    while (size < VERSION_OUTPUT_BYTES) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // the rest is not wanted: a process that keeps printing must not hold this read open
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, VERSION_OUTPUT_BYTES));
}

/** Ends `pid` and every process it started: its process group off Windows, its process tree on Windows. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is gone already */ }
}

/**
 * The process that runs `executable args`. On Windows a .cmd or .bat (the shim npm installs an agent
 * as) is a batch file, which only cmd.exe runs: it goes through `cmd.exe /d /s /c "<line>"`, the line
 * quoted as cmd reads it, with Bun's own argument quoting off so cmd gets it as written.
 */
export function versionSpawn(executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform, comspec: string | undefined = process.env["ComSpec"]): { cmd: string[]; windowsVerbatimArguments: boolean } {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) return { cmd: [executable, ...args], windowsVerbatimArguments: false };
  return { cmd: [comspec || "cmd.exe", "/d", "/s", "/c", `"${shellCommandLine("cmd", executable, args)}"`], windowsVerbatimArguments: true };
}

/**
 * Runs `executable args` with no input and this server's environment, in a process group of its own.
 * At `timeoutMs` the whole group is killed and its output no longer read: a version flag that starts
 * a child holding stdout open (an npm shim, a launcher) would otherwise outlast the timeout.
 */
export const runVersion: RunVersion = async (executable, args, timeoutMs, path, signal) => {
  if (signal?.aborted) return { stdout: "", stderr: "", exitCode: null, timedOut: false };
  const { cmd, windowsVerbatimArguments } = versionSpawn(executable, args);
  const env = path === undefined || process.platform === "win32" ? undefined : { ...process.env, PATH: path };
  const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32", windowsVerbatimArguments, windowsHide: true, env });
  let timedOut = false;
  let stopReading!: () => void;
  const stop = new Promise<void>((resolve) => { stopReading = resolve; });
  const abort = () => { killTree(child.pid); stopReading(); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); stopReading(); }, timeoutMs);
  // a flag that answered and exited may have left a child holding its output: what it printed is
  // read for a moment more, then the reading stops, and the child is ended below
  let grace: ReturnType<typeof setTimeout> | undefined;
  const exited = child.exited.then((code) => { if (!signal?.aborted) grace = setTimeout(stopReading, EXIT_GRACE_MS); return code; });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([readBounded(child.stdout, stop), readBounded(child.stderr, stop), Promise.race([exited, stop.then(() => null)])]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    clearTimeout(grace);
    // a version flag that answered may still have left a child behind: nothing it started outlives the read
    if (!timedOut && process.platform !== "win32") killTree(child.pid);
  }
};

interface Kept {
  /** the executable file as it was when its version was read */
  fingerprint: string;
  version: string | null;
  error: AgentInstallState["version_error"];
  /** when a timed-out read is tried again; null: kept while the file is the same */
  retryAt: number | null;
}

/**
 * The executable file as it is now: which file (device and inode) and when it last changed. A file
 * renamed over it is another inode, and its ctime moves even when its size and mtime were copied.
 */
const fingerprintOf = (executable: string): string | null => {
  try {
    const stat = statSync(executable, { bigint: true });
    return stat.isFile() ? [executable, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("\0") : null;
  } catch {
    return null;
  }
};

export class AgentDetector {
  readonly #locate: Locate;
  readonly #run: RunVersion;
  readonly #timeoutMs: number;
  /** by executable path: the version read from the file the fingerprint names */
  readonly #kept = new Map<string, Kept>();
  /** by fingerprint: a version read in progress, shared by every caller meanwhile */
  readonly #running = new Map<string, Promise<Kept>>();
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #lifetime = new AbortController();

  readonly #now: () => number;
  readonly #home: string;
  readonly #env: Record<string, string | undefined>;

  constructor(options: { locate: Locate; run?: RunVersion; timeoutMs?: number; now?: () => number; home?: string; env?: Record<string, string | undefined> }) {
    this.#locate = options.locate;
    this.#run = options.run ?? runVersion;
    this.#timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#home = options.home ?? homedir();
    this.#env = options.env ?? process.env;
  }

  /** End active process groups and release queued reads without starting more version flags. */
  close(): void {
    this.#lifetime.abort();
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  /** `binary` in one of the installer's folders (detect.install_dirs), as an executable file, or null. */
  #inInstallDirs(binary: string, dirs: readonly string[], platform: CatalogPlatform): string | null {
    const names = platform === "windows" ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary];
    for (const dir of dirs) {
      const variable = /^%([A-Z_]+)%\//.exec(dir);
      const base = dir.startsWith("~/") ? join(this.#home, dir.slice(2)) : variable !== null ? (this.#env[variable[1]!] ? join(this.#env[variable[1]!]!, dir.slice(variable[0].length)) : null) : null;
      if (base === null) continue;
      for (const name of names) if (isExecutableFile(join(base, name))) return join(base, name);
    }
    return null;
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#lifetime.signal.aborted && this.#active >= PARALLEL_RUNS) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await work();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  async #version(executable: string, fingerprint: string, args: readonly string[], timeoutMs: number, path: string): Promise<Kept> {
    const kept = this.#kept.get(executable);
    if (kept?.fingerprint === fingerprint && (kept.retryAt === null || this.#now() < kept.retryAt)) return kept;
    const running = this.#running.get(fingerprint);
    if (running) return running;
    const read = this.#slot(async (): Promise<Kept> => {
      try {
        if (this.#lifetime.signal.aborted) return { fingerprint, version: null, error: "failed", retryAt: null };
        const run = await this.#run(executable, args, timeoutMs, path, this.#lifetime.signal);
        if (run.timedOut) return { fingerprint, version: null, error: "timeout", retryAt: this.#now() + TIMEOUT_KEPT_MS };
        // a flag that failed proves the agent does not run: its error (a wrapper's missing target,
        // with Node's version in the path) is never read for a version. A failure is asked again
        // after a while: a wrapper's target can be repaired while the wrapper stays the same file.
        if (run.exitCode !== 0) return { fingerprint, version: null, error: "failed", retryAt: this.#now() + TIMEOUT_KEPT_MS };
        // the version is read from what the flag printed as its answer only, never from stderr
        const version = parseVersion(run.stdout);
        return { fingerprint, version, error: version === null ? "unreadable" : null, retryAt: null };
      } catch {
        return { fingerprint, version: null, error: "failed", retryAt: this.#now() + TIMEOUT_KEPT_MS };
      }
    }).then((result) => {
      this.#kept.set(executable, result);
      return result;
    }).finally(() => this.#running.delete(fingerprint));
    this.#running.set(fingerprint, read);
    return read;
  }

  /** The executable `binary` would be started as on this PC: PATH first, then the installer's own folders; null where none is. */
  /** `binary` on this server's PATH or the login shell's, as kept; no installer folder. */
  onPath(binary: string): Promise<string | null> {
    return this.#locate(binary);
  }

  /** `binary` in one of its installer's folders, or null (`inInstallDirs`, for GET /api/agents). */
  inInstallFolder(binary: string, dirs: readonly string[], platform: CatalogPlatform): string | null {
    return this.#inInstallDirs(binary, dirs, platform);
  }

  /** Reads the login shell's PATH again (an install may have changed it). */
  refreshPath(): Promise<void> {
    return this.#locate.refresh?.() ?? Promise.resolve();
  }

  async executable(binary: string, dirs: readonly string[], platform: CatalogPlatform | null): Promise<string | null> {
    return (await this.#locate(binary)) ?? (platform === null ? null : this.#inInstallDirs(binary, dirs, platform));
  }

  /**
   * Whether `entry` is on this PC: the first of its binaries found, and that one's version. Where
   * another program has the binary's name (detect.unreliable_on), nothing is looked up or run; while
   * a program it needs (detect.needs) is missing, it is not installed and nothing is run either.
   */
  async state(entry: AgentCatalogEntry, platform: CatalogPlatform | null): Promise<AgentInstallState> {
    const missing: AgentInstallState = { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
    if (platform !== null && entry.detect.unreliable_on?.[platform] !== undefined) {
      return { installed: null, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
    }
    const dirs = platform === null ? [] : entry.detect.install_dirs?.[platform] ?? [];
    for (const needed of entry.detect.needs ?? []) if ((await this.executable(needed, dirs, platform)) === null) return missing;
    for (const binary of entry.detect.binaries) {
      const onPath = await this.#locate(binary);
      const executable = onPath ?? (platform === null ? null : this.#inInstallDirs(binary, entry.detect.install_dirs?.[platform] ?? [], platform));
      if (executable === null) continue;
      const fingerprint = fingerprintOf(executable);
      if (fingerprint === null) continue;
      // the agent's own folder first (npm's global folder holds its node), then the PATH it was found on
      const path = [dirname(executable), this.#locate.searchPath?.() ?? process.env["PATH"] ?? ""].filter((part) => part !== "").join(delimiter);
      const { version, error } = await this.#version(executable, fingerprint, entry.detect.version_args, entry.detect.version_timeout_ms ?? this.#timeoutMs, path);
      return {
        installed: true,
        binary,
        on_path: onPath !== null,
        version,
        version_error: error,
        meets_min_version: entry.min_version === null || version === null ? null : meetsMinVersion(version, entry.min_version.version),
      };
    }
    return missing;
  }
}
