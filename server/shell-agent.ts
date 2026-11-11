/**
 * Agents herdr's agent.start cannot launch (`herdr agent start --kind` lists its
 * kinds; omo, gjc and DeepSeek Harness's dsh-tui are not among them). The pane's shell runs the command
 * instead, and the pane's process tree, not the prompt, says when it is up.
 *
 * A Windows pane differs in three ways, each live-verified on a Windows PC (herdr 0.9.3):
 * - its shell is PowerShell or cmd: a quoted path alone is a string there, not a call;
 * - a newline in sent text is a line break in PowerShell's editor (it waits at `>>`): the
 *   command is run by the Enter key;
 * - process_info names only the shell, so the shell's children say whether the agent runs.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { herdrRpc } from "./herdr/client.ts";
import { isDshProcess } from "./dsh.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { isOmoProcess, omoProcessIdentity } from "./omo.ts";
import { psQuote } from "./powershell.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";
import { userHome } from "./user-home.ts";

/** kind -> the foreground-process test that proves the agent is running in the pane. */
export const SHELL_AGENTS: Record<string, (argv: readonly string[]) => boolean> = {
  omo: isOmoProcess,
  gjc: isGjcProcess,
  // dsh-tui's host process (node …/@deepseek-harness-tui/dsh-tui/lib/…/host-entry.js), behind its launcher shims
  "dsh-tui": isDshProcess,
};
/** The shell-started agents known to start on Windows; the others are not offered there. */
const WINDOWS_SHELL_AGENTS = new Set(["omo", "gjc"]);

export function isShellAgentKind(kind: string): boolean { return Object.hasOwn(SHELL_AGENTS, kind); }

/** Where this server finds `kind` on its own PATH; the pane's shell is herdr's child and may carry another PATH. */
export function shellAgentExecutable(kind: string, platform: string = process.platform, path: string = process.env["PATH"] ?? ""): string | null {
  if (platform === "win32" && !WINDOWS_SHELL_AGENTS.has(kind)) return null;
  return Bun.which(kind, { PATH: path });
}

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
};

const LOGIN_PATH_START = "__OVIS_LOGIN_PATH__";
const LOGIN_PATH_END = "__OVIS_LOGIN_PATH_END__";
/** The fixed text the login shell runs: no request's kind or argument is ever part of it. printenv prints PATH joined by `:` in fish too. */
const LOGIN_PATH_SCRIPT = `printf '\\n%s\\n' ${LOGIN_PATH_START}; printenv PATH; printf '%s\\n' ${LOGIN_PATH_END}`;
const LOGIN_ENV_START = "__OVIS_LOGIN_ENV__";
const LOGIN_ENV_END = "__OVIS_LOGIN_ENV_END__";
/**
 * The same for the whole environment, printed as JSON by this server's own runtime: `env` prints one
 * `NAME=value` per line, which a value holding a newline or an exported bash function
 * (`BASH_FUNC_f%%=() {…`) cannot be read back from. It reads no .env and no bunfig.toml (whose
 * preload would run in the home folder it starts in). Single quotes read the same in fish.
 */
const loginEnvScript = (runtime: string): string =>
  `printf '\\n%s\\n' ${LOGIN_ENV_START}; '${runtime}' --no-env-file --config=/dev/null -e 'process.stdout.write(JSON.stringify(process.env))'; printf '\\n%s\\n' ${LOGIN_ENV_END}`;

/** The user's login shell as an absolute executable: $SHELL, else the account's; null when neither is one. */
export function loginShell(env: Record<string, string | undefined> = process.env): string | null {
  let account: string | null = null;
  try { account = userInfo().shell; } catch { /* no passwd entry */ }
  for (const shell of [env["SHELL"], account]) if (shell && isAbsolute(shell) && isExecutableFile(shell)) return shell;
  return null;
}

/** The PATH between the markers of the probe's own output; the profile's chatter around them is ignored. */
export function parseLoginPath(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const start = lines.lastIndexOf(LOGIN_PATH_START);
  if (start === -1 || lines[start + 2] !== LOGIN_PATH_END) return null;
  const path = lines[start + 1]!.trim();
  return path === "" ? null : path;
}

/**
 * The variables the probe printed as JSON between its markers, those named as a shell variable can
 * be (an exported bash function's `BASH_FUNC_f%%` is not one); null when there is no such object.
 */
export function parseLoginEnv(output: string): Record<string, string> | null {
  const start = output.lastIndexOf(`\n${LOGIN_ENV_START}\n`);
  const end = output.lastIndexOf(`\n${LOGIN_ENV_END}\n`);
  if (start === -1 || end < start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(output.slice(start + LOGIN_ENV_START.length + 2, end)); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0])));
}

/** The login shell's PATH, or why it gave none. */
export type LoginPathResult = { path: string } | { path: null; reason: string };

export interface LoginPathProbe {
  /** the login shell's PATH; a miss says why: the shell failed, outran its time or said too much */
  (signal: AbortSignal): Promise<LoginPathResult>;
}

/**
 * Runs `shell -l -c` once with the fixed script and reads the PATH its profile sets. The shell runs
 * in a process group of its own, so a profile that leaves a child behind is killed with it; at
 * `timeoutMs`, past `maxBytes` of output (stdout and stderr together) or on `signal` the group is
 * killed and the shell reaped before this answers a miss. A shell SIGKILL cannot end (blocked in
 * the kernel, say on a hung home) is answered for `graceMs` after the kill and reaped when it
 * exits. The output is read until its pipes close, at most `graceMs` past the shell's exit.
 */
export function loginPathProbe(options: LoginShellOptions): LoginPathProbe {
  const probe = loginShellProbe(options, LOGIN_PATH_SCRIPT, parseLoginPath, "PATH");
  return async (signal) => {
    const result = await probe(signal);
    return result.value === null ? { path: null, reason: result.reason } : { path: result.value };
  };
}

/** The environment the user's login shell sets up, or why it gave none; run as loginPathProbe runs. */
export function loginEnvProbe(options: LoginShellOptions, runtime: string = process.execPath): (signal: AbortSignal) => Promise<{ value: Record<string, string> } | { value: null; reason: string }> {
  if (runtime.includes("'")) return async () => ({ value: null, reason: `${runtime} cannot be quoted for the login shell` });
  return loginShellProbe({ maxBytes: 256 * 1024, ...options }, loginEnvScript(runtime), parseLoginEnv, "environment");
}

/** `cwd`: where the shell starts (this process's folder when unset) */
interface LoginShellOptions { shell: string; env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number; maxBytes?: number; graceMs?: number }

function loginShellProbe<T>(options: LoginShellOptions, script: string, read: (output: string) => T | null, what: string): (signal: AbortSignal) => Promise<{ value: T } | { value: null; reason: string }> {
  const { shell, env = process.env, cwd, timeoutMs = 2000, maxBytes = 64 * 1024, graceMs = 500 } = options;
  type Result = { value: T } | { value: null; reason: string };
  return (signal) => new Promise<Result>((resolve) => {
    if (signal.aborted) { resolve({ value: null, reason: "stopped" }); return; }
    const child = spawn(shell, ["-l", "-c", script], { env, ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    /** why the group was killed; set once */
    let failure: string | null = null;
    let exited = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const done = (result: Result): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal.removeEventListener("abort", stopped);
      // nothing more is read: a process outside the group that kept the pipes open is not waited on
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const answer = (): void => {
      const value = read(Buffer.concat(chunks).toString("utf8"));
      done(value === null ? { value: null, reason: `${shell} -l printed no ${what} between its markers` } : { value });
    };
    const kill = (reason: string): void => {
      if (failure !== null) return;
      failure = `${shell} -l ${reason}`;
      // after the exit the group is already killed: only the output was still being read
      if (exited) { done({ value: null, reason: failure }); return; }
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      // the answer never waits on an exit SIGKILL may not bring; the exit handler still reaps it
      const killed = failure;
      grace = setTimeout(() => done({ value: null, reason: `${killed}, and did not end after SIGKILL` }), graceMs);
    };
    const stopped = (): void => kill("was stopped");
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs);
    signal.addEventListener("abort", stopped, { once: true });
    // both streams share one budget; only stdout carries the answer
    const count = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes > maxBytes) kill(`printed over ${maxBytes} bytes`);
      return failure === null;
    };
    child.stdout!.on("data", (chunk: Buffer) => { if (count(chunk)) chunks.push(chunk); });
    child.stderr!.on("data", count);
    // a shell that cannot be run never exits: its error is the answer
    child.on("error", (error: NodeJS.ErrnoException) => done({ value: null, reason: `${shell} could not run: ${error.code ?? error.message}` }));
    child.on("exit", (code, exitSignal) => {
      exited = true;
      // whatever the shell left in its group goes with it
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* the group is gone */ }
      if (failure !== null) { done({ value: null, reason: failure }); return; }
      if (code !== 0) { done({ value: null, reason: `${shell} -l ended with ${code === null ? exitSignal : `exit ${code}`}` }); return; }
      // stdout may still hold output at exit: it is read until close, bounded, as a process outside
      // the group (one the profile moved to a session of its own) may keep the pipe open
      grace = setTimeout(answer, graceMs);
    });
    child.on("close", () => { if (exited && failure === null) answer(); });
  });
}

/**
 * Where the shell-started agents are, for both the offer (`/api/agents`) and the start: this
 * server's own PATH first, then, on Unix, the PATH its user's login shell sets, for a server run
 * as a service with a bare PATH. One login shell is run for every kind missing from the service
 * PATH at once, only when an offer or a start asks for a kind the service PATH misses and the last
 * run is older than `ttlMs` (callers meanwhile share that run); its hits and misses are kept until
 * then, and nothing runs while nobody asks. A run that finds no PATH says why on the console, once
 * each time the reason changes. Only the fixed names of SHELL_AGENTS are looked up, and only
 * absolute executable files are kept.
 */
export class ShellAgentLocator {
  readonly #platform: string;
  readonly #servicePath: () => string;
  readonly #probe: LoginPathProbe | null;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #found = new Map<string, string>();
  /** the login PATH the last run read: a kind it missed is looked for there again at each read */
  #loginPath: string | null = null;
  /** when the last run ended; null before the first */
  #checkedAt: number | null = null;
  #running: Promise<void> | null = null;
  /** a refresh waiting for the run before it to end */
  #queued: Promise<void> | null = null;
  /** why the last run found no PATH, as last logged; null after one that found it */
  #failure: string | null = null;
  #abort = new AbortController();
  #stopped = false;

  constructor(options: {
    platform?: string;
    /** this server's PATH, read at each lookup */
    servicePath?: () => string;
    /** reads the login shell's PATH; null: this server's PATH alone (tests, and a server with no login shell) */
    probe?: LoginPathProbe | null;
    /** how long a run's answer is kept */
    ttlMs?: number;
    /** the clock the answer's age is read from */
    now?: () => number;
  } = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#servicePath = options.servicePath ?? (() => process.env["PATH"] ?? "");
    // Windows keeps its own PATH and allowlist: no Unix login shell is asked there
    const shell = this.#platform === "win32" || options.probe !== undefined ? null : loginShell();
    this.#probe = this.#platform === "win32" ? null : options.probe !== undefined ? options.probe : shell === null ? null : loginPathProbe({ shell });
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** The kept answer while it is younger than ttlMs; otherwise one login-shell run, shared by every caller meanwhile. */
  #fresh(probe: LoginPathProbe): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#running !== null) return this.#running;
    if (this.#checkedAt !== null && this.#now() - this.#checkedAt < this.#ttlMs) return Promise.resolve();
    const run: Promise<void> = this.#lookup(probe).finally(() => { if (this.#running === run) this.#running = null; });
    this.#running = run;
    return run;
  }

  async #lookup(probe: LoginPathProbe): Promise<void> {
    const missing = Object.keys(SHELL_AGENTS).filter((kind) => shellAgentExecutable(kind, this.#platform, this.#servicePath()) === null);
    const found = new Map<string, string>();
    const result = missing.length === 0 ? null : await probe(this.#abort.signal).catch((error: unknown): LoginPathResult => ({ path: null, reason: `the login shell probe failed: ${error instanceof Error ? error.message : String(error)}` }));
    if (this.#stopped) return;
    if (result?.path) {
      for (const kind of missing) {
        const executable = Bun.which(kind, { PATH: result.path });
        if (executable !== null && isAbsolute(executable) && isExecutableFile(executable)) found.set(kind, executable);
      }
    }
    // a failed run proves nothing is there: it answers as a miss until the next one
    this.#found = found;
    this.#loginPath = result?.path ?? null;
    this.#checkedAt = this.#now();
    if (result === null) return;
    const failure = result.path === null ? result.reason : null;
    if (failure !== null && failure !== this.#failure) console.warn(`shell agents: no login-shell PATH (${failure}); shell-started agents are looked up on this server's PATH alone`);
    this.#failure = failure;
  }

  /**
   * The absolute executable `kind` is started by, or null. A kind the service PATH misses waits
   * for a login-shell run when the kept answer is missing or older than ttlMs; a kind that run
   * missed is looked for again on the PATH it read, so one installed since is found at once; a path
   * a run found that is no longer an executable is not replaced by anything else until the next run.
   */
  async executable(kind: string): Promise<string | null> {
    if (!isShellAgentKind(kind)) return null;
    const own = shellAgentExecutable(kind, this.#platform, this.#servicePath());
    if (own !== null || this.#probe === null) return own;
    await this.#fresh(this.#probe);
    const found = this.#found.get(kind);
    if (found !== undefined) return isExecutableFile(found) ? found : null;
    // installed since the run (an install from the catalog): the kept login PATH has it, no new shell
    const late = this.#loginPath === null ? null : Bun.which(kind, { PATH: this.#loginPath });
    if (late === null || !isAbsolute(late) || !isExecutableFile(late)) return null;
    this.#found.set(kind, late);
    return late;
  }

  /**
   * Asks the login shell again, whatever the kept answer's age (an install may have changed its PATH):
   * a run already out may have read the PATH before the install, so this one starts after it, and
   * every read meanwhile waits for it.
   */
  refresh(): Promise<void> {
    if (this.#probe === null || this.#stopped) return Promise.resolve();
    // one already waiting to start covers this one too
    if (this.#queued !== null) return this.#queued;
    const probe = this.#probe;
    const run: Promise<void> = (this.#running ?? Promise.resolve()).then(() => { if (this.#queued === run) this.#queued = null; return this.#lookup(probe); }).finally(() => { if (this.#running === run) this.#running = null; });
    this.#queued = run;
    this.#running = run;
    return run;
  }

  /** Kills a login shell still running and runs no more; later lookups use this server's PATH and the last run's answer. */
  stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    return this.#running ?? Promise.resolve();
  }
}

/** This server's PATH alone: what a caller that names no locator gets. */
const servicePathOnly = new ShellAgentLocator({ probe: null });

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
/** cmd.exe has no escape for a quote inside quotes, and expands %NAME%. */
export function cmdQuote(word: string): string {
  if (/["%\r\n]/.test(word)) throw new Error("this argument cannot be typed into cmd.exe");
  // a backslash right before the closing quote would escape it for the program's own parser
  return `"${word.replace(/\\+$/, (run) => run + run)}"`;
}

export type PaneShell = "posix" | "powershell" | "cmd";
/** Which shell a pane runs, from the program herdr reports in front of it. */
export function paneShell(argv0: string): PaneShell {
  const name = argv0.split(/[\\/]/).pop()!.toLowerCase();
  if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") return "powershell";
  if (name === "cmd.exe") return "cmd";
  return "posix";
}

/** The line that runs `executable` with `args` in that shell. */
export function shellCommandLine(shell: PaneShell, executable: string, args: readonly string[]): string {
  if (shell === "powershell") return ["&", psQuote(executable), ...args.map(psQuote)].join(" ");
  if (shell === "cmd") return [executable, ...args].map(cmdQuote).join(" ");
  return [executable, ...args].map(quote).join(" ");
}

/** What .NET takes for whitespace (Char.IsWhiteSpace): Windows PowerShell 5.1 quotes a native argument that holds any after an even number of `"`. */
const DOTNET_WHITESPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
/**
 * What cmd reads in a line outside its quotes. An agent PowerShell starts through a `.cmd` file alone
 * has its arguments read by cmd again, where `&` would end the agent's line and run the rest as a
 * command.
 */
const CMD_SPECIAL = /[&|<>^%]/;
/**
 * Whether cmd reads `arg`'s `&`, `|`, `<` and `>` as text: both PowerShells put an argument holding a
 * space in one pair of quotes, where cmd does (live-verified, 5.1.26100 and 7.6 to npm's shim), as
 * long as no `"` in any argument of the line toggles cmd's quotes, which runs across arguments
 * (#3092), and no `!` names a variable delayed expansion would put there, one holding a `"` for a
 * shim's `call` to read again. Not with a `%` (cmd expands `%NAME%` inside quotes too) or a `^` (a
 * shim's `call` doubles it).
 */
const cmdQuotedText = (arg: string, args: readonly string[]): boolean =>
  arg.includes(" ") && !/[%^]/.test(arg) && !args.some((other) => /["!]/.test(other));

/**
 * `args` as a PowerShell line must give them for the native program it starts to read them back
 * unchanged. Windows PowerShell 5.1 (`powershell`) passes each as it is, in double quotes when it
 * holds whitespace after an even number of `"` (each one counts, an escaped one too), and drops an
 * empty one: an empty one goes as `""`, a quote as `\"` after its backslashes are doubled, and the
 * backslashes ending one with whitespace are doubled before the quote 5.1 closes it with
 * (live-verified, 5.1.26100 to node.exe). One whose whitespace all follows an odd number of `"`
 * (`"fix the bug"`, `x="a b"`) would go unquoted, split at its spaces: it throws. PowerShell 7 (`pwsh`)
 * escapes them itself from 7.3 and passes them as 5.1 does before that: they go as they are, and
 * one the two would pass differently throws. So does one holding what cmd reads outside its quotes
 * (CMD_SPECIAL) but where it reads it as text (cmdQuotedText): which file the agent's name finds is
 * the pane's PowerShell's to say, not this one's.
 */
export function powershellNativeArgs(program: "powershell" | "pwsh", args: readonly string[]): string[] {
  return args.map((arg) => {
    if (CMD_SPECIAL.test(arg) && !cmdQuotedText(arg, args)) throw new Error("cmd would read this argument again if the agent starts through a .cmd file");
    const spaced = DOTNET_WHITESPACE.test(arg);
    if (program === "pwsh") {
      if (arg === "" || arg.includes('"') || (spaced && arg.endsWith("\\"))) throw new Error("PowerShell 7 may not pass this argument unchanged");
      return arg;
    }
    if (arg === "") return '""';
    const escaped = arg.replace(/(\\*)"/g, (_, run: string) => `${run}${run}\\"`);
    if (!spaced) return escaped;
    const encoded = escaped.replace(/\\+$/, (run) => run + run);
    // a part between its quotes follows as many of them as its index: 5.1 quotes the argument for whitespace in an even one
    if (!encoded.split('"').some((part, index) => index % 2 === 0 && DOTNET_WHITESPACE.test(part))) throw new Error("Windows PowerShell 5.1 would split this argument");
    return encoded;
  });
}

interface ProcessInfo { process_info?: { shell_pid?: number; foreground_processes?: { pid: number; argv?: string[]; cwd?: string }[] } }
const processInfo = (paneId: string) => herdrRpc<ProcessInfo>("pane.process_info", { pane_id: paneId }).catch(() => null);

/**
 * Types the agent's absolute path and args into the pane's shell and resolves once
 * `kind` is its foreground process, with that process's pid; null on Windows, where it is
 * found among the shell's descendants and not in front. The path comes from the same
 * `locator` `/api/agents` asked, so the offer and the start agree whatever the pane shell's
 * PATH says.
 */
export async function startShellAgent(kind: string, paneId: string, args: string[] = [], options: { command?: string; timeoutMs?: number; locator?: ShellAgentLocator } = {}): Promise<number | null> {
  const isProcess = SHELL_AGENTS[kind];
  if (!isProcess) throw new Error(`${kind} is not a shell-started agent`);
  const windows = process.platform === "win32";
  if (options.command !== undefined || !windows) {
    let command = options.command;
    if (command === undefined) {
      const executable = await (options.locator ?? servicePathOnly).executable(kind);
      if (!executable) throw new Error(`${kind} is not on this server's PATH or its login shell's`);
      command = shellCommandLine("posix", executable, []);
    }
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${[command, ...args.map(quote)].join(" ")}\n` });
  } else {
    const executable = await (options.locator ?? servicePathOnly).executable(kind);
    if (!executable) throw new Error(`${kind} is not on this server's PATH`);
    const shell = paneShell((await processInfo(paneId))?.process_info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
    await herdrRpc("pane.send_text", { pane_id: paneId, text: shellCommandLine(shell, executable, args) });
    await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const info = await processInfo(paneId);
    const started = info?.process_info?.foreground_processes?.find((entry) => kind === "omo" ? omoProcessIdentity(entry, "", userHome()) !== null : isProcess(entry.argv ?? []));
    if (started) return started.pid;
    const shellPid = info?.process_info?.shell_pid;
    // the table query never outlasts what is left of the start's own time
    if (windows && typeof shellPid === "number" && descendantArgv(await windowsProcessTable(Math.max(500, Math.min(10_000, deadline - Date.now()))), shellPid).some(isProcess)) return null;
    await Bun.sleep(250);
  }
  throw new Error(`${kind} did not start in the pane`);
}
