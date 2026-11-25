/**
 * `ovis tui`: Ovis's own screen of herdr-core's terminals (tui/main.ts, the entry `tui`) in this terminal.
 * scripts/plugin.ts hands the command here before its own work at import, so it reads and writes nothing of Ovis's
 * state or config dirs. Its `--help` is the command line's own (scripts/plugin-cli.ts), like every command's.
 *
 * The launcher finds the core the screen joins, starts the screen as a child and stays until it ends: it gives the
 * terminal back when the screen died by a signal. When no core answers, it asks before it starts one; no other path
 * starts a core. It reads the local server's address for the screen's worktree actions but does not contact it or
 * take the plugin's lifecycle lock.
 */
import { existsSync, mkdtempSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { constants, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { isatty } from "node:tty";
import { FFIType } from "bun:ffi";
import { COMPILED, entryCommand, ROOT } from "../server/entries.ts";
import { mergeEnvLayers } from "../server/legacy-env.ts";
import { coreLaunchEnv, withoutAskpass } from "../server/herdr-core/core-env.ts";
import { coreSocket } from "../server/herdr-core/core-socket.ts";
import { type Held, undoHeld } from "../tui/host/guard.ts";
import { makeHold, readHold, SCREEN_HOLD } from "../tui/host/hold.ts";
import { EXIT_FAILED, parseArgs, SCREEN_FOLDER, SCREEN_SERVER, targetEnv } from "../tui/start.ts";
import { openLibc } from "../tui/host/libc.ts";
import { loopbackOrigin } from "../shared/loopback-origin.ts";
import { appOrigin } from "./plugin-port.ts";
import { execWaiter } from "./plugin-tui-waiter.ts";
import { discardTyped, macExecEnv } from "./libc.ts";
import { readPluginSettings } from "./plugin-settings.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The setting that named the old hc-tui program: the screen is part of Ovis now. */
const TUI_BIN_VARIABLE = "OVIS_TUI_BIN";

/** Ovis's own names, and the names they had before (server/legacy-env.ts): the server's settings, its tokens and keys. */
const OVIS_OWN = /^(?:OVIS_|HERDR_WEB_)/;

/**
 * The Ovis names the screen reads itself: where it keeps its state (tui/start.ts), and the switch of the guard that
 * keeps a test off the user's own core (server/herdr/test-session.ts). The folder and the hold file it is handed are
 * the launcher's to name, never the caller's.
 */
const SCREEN_READS: ReadonlySet<string> = new Set(["OVIS_TUI_STATE_DIR", "OVIS_ALLOW_LIVE_HERDR"]);

/**
 * The screen's environment: the caller's (with the chosen core), without any of Ovis's own names but the ones the
 * screen reads, without another core's scope and without Ovis's SSH askpass.
 */
export function tuiEnv(caller: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(withoutAskpass(caller))) {
    if (value !== undefined && key !== "HC_SCOPE" && (SCREEN_READS.has(key) || !OVIS_OWN.test(key))) env[key] = value;
  }
  return env;
}

/**
 * The `.env` files Bun loads from the working folder when it starts, for every mode (NODE_ENV) at once: `.env`,
 * `.env.local`, `.env.<mode>` and `.env.<mode>.local`. More files than one mode loads only drops more names below.
 */
const DOTENV_FILES = [".env", ".env.local", ...["development", "production", "test"].flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])];

/**
 * The environment the user's shell gave this process, without what Bun took from the working folder at its start (the
 * `.env` files; a `bunfig.toml` preload runs before any of this). Prefer the NUL-separated copy from the kernel.
 * Without it, drop every name the files assign, whatever its value: nothing here can tell a value the shell gave from
 * one a file gave, for PATH, HOME, TERM, USER, LOGNAME and SHELL as for any other name.
 */
export function shellEnv(from: { kernel: string | null; env: Env; dotenv: readonly string[] }): Record<string, string> {
  if (from.kernel !== null) {
    return Object.fromEntries(from.kernel.split("\0").filter((entry) => entry.indexOf("=") > 0).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  }
  const given = new Set<string>();
  // Scan names only: an assignment-looking line inside a quoted value can only make this more conservative.
  for (const text of from.dotenv) for (const [, name] of text.matchAll(/^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*[=:]/gm)) {
    if (name !== undefined) given.add(name);
  }
  return Object.fromEntries(Object.entries(from.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !given.has(entry[0])));
}

/** The Linux or macOS copy of the environment this process was started with, untouched by Bun's `.env` loading. */
export function kernelEnv(): string | null {
  if (process.platform === "darwin") return macExecEnv();
  if (process.platform !== "linux") return null;
  try { return readFileSync("/proc/self/environ", "utf8"); } catch { return null; }
}

/** Prefer the kernel's copy; only read the folder's `.env` files on the fallback path. */
export function callerEnv(from: { kernel: () => string | null; env: Env; cwd: string }): Record<string, string> {
  const kernel = from.kernel();
  const read = (file: string) => {
    try { return readFileSync(file, "utf8"); } catch { return null; }
  };
  const dotenv = kernel !== null ? [] : DOTENV_FILES.map((name) => read(join(from.cwd, name))).filter((text): text is string => text !== null);
  return shellEnv({ kernel, env: from.env, dotenv });
}

export const WINDOWS_MESSAGE = "ovis tui: the terminal client runs on Linux and macOS only.\n";

/**
 * The question, and the space that follows it once what was typed up to the question is thrown away: from that space
 * on, a line that is typed is an answer.
 */
const QUESTION = "herdr-core is not running. Start it? [Y/n]";
const ANSWER_FROM_HERE = " ";

/** How long a core `hc server start` started has to answer a connect, and how often one is tried meanwhile. */
const CORE_WAIT_MS = 30_000;
const CORE_RETRY_MS = 100;

/**
 * Whether a core answers at `socket` before `ms` are over: `probe` connects every CORE_RETRY_MS until one does. A core
 * that was just started listens a moment later, and nothing but a connect says when.
 */
export async function answersWithin(probe: (socket: string) => Promise<Probe>, socket: string, ms: number): Promise<boolean> {
  for (const deadline = performance.now() + ms; performance.now() < deadline; ) {
    if ((await probe(socket)).kind === "core") return true;
    await Bun.sleep(CORE_RETRY_MS);
  }
  return false;
}

/**
 * The core the screen joins, as the environment the screen and a core it starts get: a `--session` flag (it clears an
 * inherited HC_SOCKET), else HC_SOCKET or HC_SESSION of the caller, else the ones Ovis's settings files name (the
 * installer writes them there), else hc's own `default`.
 */
function coreChoice(session: string | null, caller: Env, settings: Env): Record<string, string | undefined> {
  if (session !== null) return targetEnv(caller, session);
  const named = (env: Env) => Boolean(env["HC_SOCKET"]) || Boolean(env["HC_SESSION"]);
  if (named(caller) || !named(settings)) return { ...caller };
  return { ...caller, HC_SOCKET: settings["HC_SOCKET"] || undefined, HC_SESSION: settings["HC_SESSION"] || undefined };
}

const shellWord = (value: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** The command that starts the chosen core from the caller's shell, the core's names written out. */
function startCommand(chosen: Env, caller: Env): string {
  const words = caller["HC_SOCKET"] && !chosen["HC_SOCKET"] ? ["env", "-u", "HC_SOCKET"] : [];
  for (const name of ["HC_SOCKET", "HC_SESSION"]) if (chosen[name]) words.push(`${name}=${shellWord(chosen[name]!)}`);
  return [...words, "hc", "server", "start"].join(" ");
}

/**
 * What says which hc runs: OVIS_HC_BIN and the app's mark on its own, as Ovis's settings files name them, else the
 * caller. They are all of the settings and of Ovis's own names that the search for hc is given.
 */
function hcSelector(caller: Env, settings: Env): Record<string, string> {
  return Object.fromEntries(["OVIS_HC_BIN", "OVIS_HC_BIN_BUNDLED"].flatMap((name) => {
    const value = settings[name] ?? caller[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

/** Enter (an empty line), `y` or `yes` starts a core; `n`, the end of the input and anything else do not. */
const saidYes = (line: string | null) => line !== null && ["", "y", "yes"].includes(line.trim().toLowerCase());

/** One connect to a core's socket: something accepts it, nothing listens there, or the connect failed otherwise. */
export type Probe = { kind: "core" } | { kind: "none" } | { kind: "failed"; code: string; reason: string };

/** The screen as a child process. */
export interface Screen {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals): void;
}

/** How the screen is started: the entry `tui`, the folder it runs in, and its file from source (null: compiled in). */
export interface ScreenStart {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly file: string | null;
}

/**
 * The screen runs in the install's own folder, never the caller's: Bun loads the `.env` files and runs the
 * `bunfig.toml` preload of its working folder, and a compiled Bun program does so whatever it is told. From source
 * Bun is also told to load no `.env`, as a checkout may hold one for a dev server. (Exported for its table test: which
 * binary runs is fixed at build time, and the seam is smaller than building one per case.)
 */
export function screenStart(compiled: boolean = COMPILED, root: string = ROOT): ScreenStart {
  const [bin, entry] = entryCommand("tui", root, compiled);
  return compiled ? { command: [bin, entry], cwd: root, file: null } : { command: [bin, "--no-env-file", entry], cwd: root, file: entry };
}

/** The launcher's own file in which the screen says which of the terminal's modes it holds (tui/host/hold.ts). */
export interface HoldFile {
  readonly path: string;
  /** what the screen last said it holds */
  held(): Held;
  remove(): void;
}

/** The terminal's settings, read before the screen starts and written back when it died by a signal. */
export interface TerminalSettings {
  save(): Uint8Array | null;
  restore(saved: Uint8Array): void;
  write(bytes: string): void;
}

/** Everything the launcher touches outside itself, so each case can be run without a terminal, a core or hc. */
export interface LaunchParts {
  readonly platform: NodeJS.Platform;
  /** stdin and stdout are both terminals */
  readonly isTty: boolean;
  /** the caller's environment */
  readonly caller: Env;
  /** the account's home, even when the caller's HOME was withheld */
  readonly home?: string;
  /** Ovis's settings files (`env`, `.env`) */
  readonly settings: Env;
  readonly screen: ScreenStart;
  /** the folder `ovis tui` was typed in: a new workspace starts there, the first one too */
  readonly folder: string;
  probe(socket: string): Promise<Probe>;
  /** whether the core that was just started answers at `socket` within `ms` (`answersWithin`) */
  answers(socket: string, ms: number): Promise<boolean>;
  /**
   * hc with its trust checks, without the login shell's PATH; null when there is none. `env`: where it is looked for
   * and what its `--version` runs in, the environment its core would start in. `selector`: which hc the settings or
   * the caller name (`hcSelector`), which reaches the search alone, never the program
   */
  findHc(env: Record<string, string>, selector: Env): Promise<string | null>;
  /** `hc server start` in `env`: its exit code, and what it said on stderr */
  startCore(hc: string, env: Record<string, string>): Promise<{ code: number; err: string }>;
  /** throws away what was typed and not read yet; false where it cannot (no answer is read then) */
  discard(): boolean;
  /** writes `text` to the terminal; false where it could not */
  show(text: string): boolean;
  /** a line typed at the terminal in cooked mode and sent with Enter; null at the end of the input, text before it or not */
  line(): string | null;
  run(command: readonly string[], options: { env: Record<string, string>; cwd: string }): Screen;
  /** Replace this process with the waiter; returns only if unavailable. */
  handOver?: typeof execWaiter;
  /** a hold file for one screen, made and checked; null where none can be made (nothing is undone for that screen) */
  holdFile(): HoldFile | null;
  readonly terminal: TerminalSettings;
  /** listens for a signal; what it returns stops listening */
  on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void): () => void;
  err(text: string): void;
}

/**
 * `ovis tui [--session NAME]`: the screen on the chosen core, with a yes asked before a core is started; `-h`, `-V` and
 * a wrong argument go to the screen's entry as they are, which answers them. The exit code is the screen's, 128 + the
 * signal that ended it, or 1 when it did not start.
 */
export function launchTui(argv: readonly string[], parts: LaunchParts): Promise<number> {
  return launch(argv, parts, "explicit").then((code) => code ?? EXIT_FAILED);
}

export const isBareTui = (argv: readonly string[]): boolean => argv[0] === undefined || argv[0] === "--session" || argv[0].startsWith("--session=");

/** A bare invocation only joins a core that already answers. Null leaves the invocation to `ovis status`. */
export function launchBareTui(argv: readonly string[], parts: LaunchParts): Promise<number | null> {
  if (!isBareTui(argv) || !parts.isTty || parts.platform === "win32") return Promise.resolve(null);
  return launch(argv, parts, "bare");
}

async function launch(argv: readonly string[], parts: LaunchParts, mode: "bare" | "explicit"): Promise<number | null> {
  const say = (code: string, text: string) => parts.err(`ovis tui: ${code}: ${text}\n`);
  if (parts.platform === "win32") {
    parts.err(WINDOWS_MESSAGE);
    return EXIT_FAILED;
  }
  const args = parseArgs(argv);
  if (args.kind !== "run") return mode === "bare" ? null : runScreen([...argv], tuiEnv(parts.caller), parts);
  const warnOldBinary = () => {
    if (parts.caller[TUI_BIN_VARIABLE] || parts.settings[TUI_BIN_VARIABLE]) say("tui_bin_unused", `${TUI_BIN_VARIABLE} is no longer used: the screen is part of Ovis now`);
  };
  if (mode === "explicit") warnOldBinary();
  const chosen = coreChoice(args.session, parts.caller, parts.settings);
  const target = coreSocket({ env: chosen });
  const found = await parts.probe(target.path);
  if (mode === "bare" && found.kind !== "core") return null;
  if (mode === "bare") warnOldBinary();
  if (found.kind === "failed") {
    say(found.code, found.reason);
    return EXIT_FAILED;
  }
  if (found.kind === "none") {
    const refused = () => {
      say("no_core", `herdr-core session ${target.session} is not running at ${target.path}; start it with:\n  ${startCommand(chosen, parts.caller)}`);
      return EXIT_FAILED;
    };
    if (!parts.isTty) return refused();
    // Only a line typed after the question is an answer to it: an Enter typed ahead would start a core unread. What was
    // typed is thrown away before the question, so that nothing is asked where that cannot be done, and again once the
    // question is written, for a key that came in between. Where either fails, no answer is read and nothing started.
    if (!parts.discard() || !parts.show(QUESTION) || !parts.discard() || !parts.show(ANSWER_FROM_HERE)) return refused();
    if (!saidYes(parts.line())) return refused();
    // hc is looked for, asked its version and started in one environment: the caller's without Ovis's own names
    const launch = coreLaunchEnv(chosen);
    const hc = await parts.findHc(launch, hcSelector(parts.caller, parts.settings));
    if (hc === null) {
      say("no_hc", "no herdr-core (hc) program was found on this PC; install it, or name it with OVIS_HC_BIN");
      return EXIT_FAILED;
    }
    const started = await parts.startCore(hc, launch);
    if (started.code !== 0) {
      say("start_failed", `${hc} server start exited ${started.code}${started.err.trim() === "" ? "" : `: ${started.err.trim()}`}`);
      return EXIT_FAILED;
    }
    if (!(await parts.answers(target.path, CORE_WAIT_MS))) {
      say("no_answer", `herdr-core was started but did not answer at ${target.path} within ${CORE_WAIT_MS / 1000} s`);
      return EXIT_FAILED;
    }
  }
  if (!parts.isTty) {
    say("not_a_terminal", "stdin and stdout must both be a terminal");
    return EXIT_FAILED;
  }
  const home = parts.home ?? (parts.caller["HOME"] || accountHome());
  const origin = loopbackOrigin(appOrigin(mergeEnvLayers([parts.caller, parts.settings]), home));
  return runScreen([], { ...tuiEnv(chosen), [SCREEN_FOLDER]: parts.folder, [SCREEN_SERVER]: origin ?? "" }, parts);
}

/**
 * Runs the screen with the terminal handed over and stays until it ends. The screen holds the terminal in raw mode and
 * owns Ctrl+C, so a SIGINT sent to the whole group is ignored from before it starts; a SIGTERM or SIGHUP sent to this
 * process alone is passed on. A screen that died by a signal could not give the terminal back: this process writes back
 * the settings it read before the start and undoes the modes the screen said it held when it died (its hold file), no
 * others: a screen killed before it turned its modes on, or stopped from its shell after it had undone them, holds
 * none, and undoing them all the same would take the caller's own (the shell's keyboard protocol entry, its bracketed
 * paste). So a screen that had no hold file to say it in has nothing undone. After any other end it writes nothing:
 * the screen gave the terminal back itself.
 */
async function runScreen(argv: string[], env: Record<string, string>, parts: LaunchParts): Promise<number> {
  const offs = [parts.on("SIGINT", () => undefined)];
  let child: Screen | undefined;
  let hold: HoldFile | null = null;
  for (const signal of ["SIGTERM", "SIGHUP"] as const) offs.push(parts.on(signal, () => child?.kill(signal)));
  try {
    // Bun's own "Module not found" would be all a user saw of an install that lost the screen's file
    if (parts.screen.file !== null && !existsSync(parts.screen.file)) {
      parts.err(`ovis tui: screen_missing: the screen's file ${parts.screen.file} is missing; reinstall Ovis\n`);
      return EXIT_FAILED;
    }
    hold = parts.holdFile();
    const command = [...parts.screen.command, ...argv];
    const options = { env: hold === null ? env : { ...env, [SCREEN_HOLD]: hold.path }, cwd: parts.screen.cwd };
    try {
      if (hold !== null) parts.handOver?.(command, options, hold.path);
      const saved = parts.terminal.save();
      child = parts.run(command, options);
      const end = await child.exited;
      if (end.signal === null) return end.code ?? EXIT_FAILED;
      if (saved !== null) parts.terminal.restore(saved);
      const undo = undoHeld(hold?.held() ?? "none");
      if (undo !== "") parts.terminal.write(undo);
      return 128 + (constants.signals[end.signal] ?? 0);
    } catch (error) {
      parts.err(`ovis tui: start_failed: the screen could not be started: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILED;
    }
  } finally {
    hold?.remove();
    for (const off of offs) off();
  }
}

/** Bytes enough for any system's `struct termios` (60 on Linux, 72 on macOS). */
const TERMIOS_BYTES = 256;
const TCSANOW = 0;

/** The terminal on stdin and stdout, its settings through the C library; nothing where that cannot be opened. */
function systemTerminal(): TerminalSettings {
  const libc = openLibc({
    tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  return {
    save: () => {
      const saved = new Uint8Array(TERMIOS_BYTES);
      return libc !== null && libc.symbols.tcgetattr(0, saved) === 0 ? saved : null;
    },
    restore: (saved) => { libc?.symbols.tcsetattr(0, TCSANOW, saved); },
    write: (bytes) => {
      try { writeSync(1, bytes); } catch { /* the terminal is gone: nothing to give back */ }
    },
  };
}

/**
 * A line typed at the terminal in cooked mode, read a byte at a time straight from fd 0 so no reader stays to take
 * the screen's keys. Only a line its newline ended is one: text the end of the input cut short (Ctrl+D after it, then
 * Ctrl+D again) was never sent, and is no line. (Exported, with `read`, for its table test; the terminal's own side
 * of it runs in scripts/plugin-tui.contract.test.ts.)
 */
export function readLine(read: (one: Buffer) => number = (one) => readSync(0, one, 0, 1, null)): string | null {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let got = 0;
    try { got = read(one); } catch { return null; }
    if (got === 0) return null;
    if (one[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
    bytes.push(one[0]!);
  }
}


/**
 * A folder of this run's own with the hold file in it, in the first of `temps` that takes one. Only an absolute
 * folder is tried: the screen runs in another folder than this process, where a relative path names another file. The
 * file is made here and read back, so the path the screen is handed is one that works.
 */
function systemHoldFile(temps: readonly string[]): HoldFile | null {
  for (const temp of temps) {
    if (!isAbsolute(temp)) continue;
    let dir: string;
    try { dir = mkdtempSync(join(temp, "ovis-tui-")); } catch { continue; }
    const path = join(dir, "held");
    const remove = () => { rmSync(dir, { recursive: true, force: true }); };
    if (makeHold(path)) return { path, held: () => readHold(path), remove };
    remove();
  }
  return null;
}

/**
 * The launcher's parts on this system for a caller's environment and home: the process's terminal and signals,
 * Bun.spawn, hc. `home` is where Ovis's settings and hc's usual folders are looked for.
 */
export function systemParts(caller: Env, home: string): LaunchParts {
  const probe = async (socket: string): Promise<Probe> => {
    const { connectCoreSocket } = await import("../server/herdr-core/socket-transport.ts");
    try {
      (await connectCoreSocket(socket)).kill();
      return { kind: "core" };
    } catch (error) {
      const kind = (error as { kind?: unknown }).kind;
      if (kind === "no_core") return { kind: "none" };
      return { kind: "failed", code: typeof kind === "string" ? kind : "connect_failed", reason: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    platform: process.platform,
    isTty: isatty(0) && isatty(1),
    caller,
    home,
    settings: readPluginSettings(caller, home),
    screen: screenStart(),
    folder: process.cwd(),
    probe,
    answers: (socket, ms) => answersWithin(probe, socket, ms),
    findHc: async (env, selector) => {
      const { findHc } = await import("../server/herdr-core/discovery.ts");
      // `home` is given, never read from `env`: with no HOME there, hc's usual folders would be looked for under the working folder
      return (await findHc({ env: { ...env, ...selector }, versionEnv: env, home, loginShellPath: async () => null }))?.bin ?? null;
    },
    startCore: async (hc, env) => {
      const child = Bun.spawn([hc, "server", "start"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, err };
    },
    discard: discardTyped,
    show: (text) => {
      try { writeSync(1, text); return true; } catch { return false; }
    },
    line: () => readLine(),
    run: (command, options) => {
      const child = Bun.spawn([...command], { env: options.env, cwd: options.cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return { exited: child.exited.then((code) => ({ code: child.signalCode === null ? code : null, signal: child.signalCode as NodeJS.Signals | null })), kill: (signal) => child.kill(signal) };
    },
    // the shell's temp folder, else the system's: os.tmpdir() would read this process's TMPDIR, which a `.env` of the
    // working folder may have set
    holdFile: () => systemHoldFile([caller["TMPDIR"] ?? "", "/tmp"]),
    terminal: systemTerminal(),
    on: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    err: (text) => process.stderr.write(text),
  };
}

/** The account's own home, from the system's user database: never a value a folder's `.env` could have given. */
function accountHome(): string {
  // an account the database does not hold (a bare uid in a container) has no home to look in
  try { return userInfo().homedir; } catch { return "/"; }
}

/**
 * `ovis tui <args>`, for scripts/plugin.ts before its own work: the exit code. The home is the shell's HOME, else
 * `account`'s: os.homedir() would read this process's HOME, which a `.env` of the working folder may have set.
 */
export async function runTui(args: readonly string[], kernel: () => string | null = kernelEnv, account: () => string = accountHome): Promise<number> {
  // the screen and a core it starts get what the shell gave, never what Bun took from the working folder
  const caller = callerEnv({ kernel, env: process.env, cwd: process.cwd() });
  return launchTui(args, { ...systemParts(caller, caller["HOME"] || account()), handOver: execWaiter });
}

export function runBareTui(args: readonly string[]): Promise<number | null> {
  if (!isBareTui(args) || process.platform === "win32" || !isatty(0) || !isatty(1)) return Promise.resolve(null);
  const caller = callerEnv({ kernel: kernelEnv, env: process.env, cwd: process.cwd() });
  return launchBareTui(args, { ...systemParts(caller, caller["HOME"] || accountHome()), handOver: execWaiter });
}
