/**
 * What the entry decides: before anything else runs, its arguments, which core it joins, whether it may join it from
 * where it runs, and where it keeps its records; at the end, what it says about how the screen ended and its exit code.
 * Pure: the environment, the arguments and the loop's end come in as values, and nothing here imports the screen's
 * heavy modules, so `-h`, `-V` and a bad argument are answered at once.
 */

import { join } from "node:path";
import { plainSession } from "../server/herdr-core/core-socket.ts";
import type { LoopEnd } from "./loop-end.ts";

export const USAGE = "usage: ovis tui [--session NAME] | -h | -V";

/** The exit codes: 0 detached, 1 the screen could not run (a code says why), 2 a wrong call, 70 a crash. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CRASH = 70;

export type Args =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; session: string | null }
  | { kind: "bad"; message: string };

export function parseArgs(argv: readonly string[]): Args {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) return { kind: "help" };
  if (argv.length === 1 && (argv[0] === "-V" || argv[0] === "--version")) return { kind: "version" };
  let session: string | null = null;
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const [flag, inline] = word.startsWith("--session=") ? ["--session", word.slice("--session=".length)] : [word, undefined];
    if (flag !== "--session") return { kind: "bad", message: `unknown argument ${JSON.stringify(word)}` };
    if (session !== null) return { kind: "bad", message: "--session is given twice" };
    const value = inline ?? argv[++at];
    if (value === undefined) return { kind: "bad", message: "--session needs a name" };
    if (plainSession(value) === null) return { kind: "bad", message: `--session ${JSON.stringify(value)} is not a session name (letters, digits, _ . -)` };
    session = value;
  }
  return { kind: "run", session };
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The environment the core's socket is worked out from: the session is the flag, else HC_SESSION, else `default`; a
 * `--session` flag clears an inherited HC_SOCKET, so the flag names the core.
 */
export function targetEnv(env: Env, session: string | null): Record<string, string | undefined> {
  if (session === null) return { ...env };
  return { ...env, HC_SESSION: session, HC_SOCKET: undefined };
}

/**
 * Whether the screen would run inside a pane of the very core it joins (its picture would show itself): it runs in a
 * terminal of a core (HC_TERMINAL_ID) and the socket it would join is that core's (HC_TERMINAL_SOCKET, else the socket
 * its own environment names). `same` compares two socket paths (test-session.ts `sameSocket`).
 */
export function insideOwnCore(env: Env, target: string, envCore: string, same: (path: string) => string): boolean {
  if (!env["HC_TERMINAL_ID"]) return false;
  return same(env["HC_TERMINAL_SOCKET"] || envCore) === same(target);
}

/** Where `ovis tui` hands the screen the folder it was typed in: the screen itself runs in the install's folder. */
export const SCREEN_FOLDER = "OVIS_TUI_CWD";

/**
 * Where `ovis tui` hands the screen the Ovis server's address (as `ovis status` reaches it over TCP), for the entries that
 * only the server does (herdr's New worktree and Delete worktree checkout...). No token goes with it: the screen holds none.
 */
export const SCREEN_SERVER = "OVIS_TUI_SERVER";
/** The desktop launcher's record path and verified process identity; an unverified desktop hands over no identity. */
export const SCREEN_DESKTOP_RECORD = "OVIS_TUI_DESKTOP_RECORD";
export const SCREEN_DESKTOP_IDENTITY = "OVIS_TUI_DESKTOP_IDENTITY";

/** The folder a new workspace starts in, the first one too: the one the launcher names, else the screen's own working folder. */
export function screenFolder(env: Env, cwd: string): string {
  return env[SCREEN_FOLDER] || cwd;
}

/** The screen's state folder: OVIS_TUI_STATE_DIR, else `ovis-tui` under XDG_STATE_HOME, else under `~/.local/state`. */
export function stateFolder(env: Env, home: string): string {
  if (env["OVIS_TUI_STATE_DIR"]) return env["OVIS_TUI_STATE_DIR"];
  return join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "ovis-tui");
}

/** What the entry does once the screen ended, a crash aside (the entry gives the terminal back and writes its record). */
export interface Ending {
  /** give the terminal back first: the loop could not */
  leave: boolean;
  /** the line for stdout, or none */
  out: string | null;
  /** the lines for stderr after it, each a stable code and its text */
  err: [code: string, text: string][];
  /** the exit code, or null: after a hang-up or a signal the host ends the process with 128 + the signal's number */
  exit: number | null;
}

export function ending(end: Exclude<LoopEnd, { kind: "crashed" }>, target: { path: string; session: string }): Ending {
  switch (end.kind) {
    case "quit":
      return {
        leave: false,
        out: `ovis tui: detached from herdr-core session ${target.session}; its terminals and agents keep running.`,
        // the quit stands when giving the terminal back failed; the line says so, so a garbled terminal has a reason
        err: end.leaveError === undefined ? [] : [[end.leaveError, "giving the terminal back failed; if it looks wrong, run `reset`"]],
        exit: EXIT_OK,
      };
    case "no_core":
      return { leave: false, out: null, err: [[end.code, `no herdr-core answers at ${target.path} (session ${target.session}); start one with \`hc server start\`, or run \`ovis tui\` to be asked`]], exit: EXIT_FAILED };
    case "incompatible":
      return { leave: false, out: null, err: [[end.code, end.reason]], exit: EXIT_FAILED };
    case "not_a_terminal":
      return { leave: false, out: null, err: [["not_a_terminal", "stdin and stdout must both be a terminal"]], exit: EXIT_FAILED };
    case "gone":
      // a hang-up is a signal: the host ends the process itself once the channels are closed
      if (end.why === "hangup") return { leave: false, out: null, err: [], exit: null };
      return { leave: true, out: null, err: [["terminal_gone", "the terminal refused a write; the agents keep running in herdr-core"]], exit: EXIT_FAILED };
    case "signal":
      return { leave: false, out: null, err: [], exit: null };
  }
}
