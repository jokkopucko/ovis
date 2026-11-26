import type { Socket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "../../server/pty/session.ts";
import { GhosttyEngine, GhosttyModule } from "../../shared/ghostty/engine.ts";

/**
 * Runs a command on a real pseudo-terminal for tests, through server/pty/session.ts on the Rust PTY
 * host (built, or installed in bin/). The command is the leader of the pty's session; this process
 * only holds the PTY host.
 *
 * Kill guard: every wait ends at the run's deadline, and the deadline ends the run through the PTY
 * host's own handle (SIGTERM to the host this run started; the host hangs up the command's group and
 * kills what is left 2 s later). When this test process dies, the host's stdin closes and the host
 * does the same by itself. Nothing is ever signalled by pid number.
 *
 * `runSupervised` puts `supervise.ts` between the host and the entry: it reads the termios before and
 * after, and it alone signals the entry, through the handle of the child it started.
 */
export const PTY_DEADLINE_MS = 20_000;
const SUPERVISOR = join(import.meta.dir, "supervise.ts");

export interface PtyOptions {
  command: string[];
  /** the whole environment of the PTY host and the command: nothing is inherited */
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  deadlineMs?: number;
  /** opt-in: ends the run, through the PTY host, once its output passes this many characters; unset, the transcript is unbounded */
  maxOutputChars?: number;
  /** called with each piece of output as it arrives */
  onData?: (text: string) => void;
}

export interface PtyRun {
  /** everything the command wrote to the pty so far, as UTF-8 */
  output(): string;
  /** resolves once the output contains `match`; rejects at the deadline or when the command ended without it */
  until(match: string | RegExp, what?: string): Promise<void>;
  /** types into the pty, as a terminal's keyboard would */
  type(text: string): void;
  resize(cols: number, rows: number): void;
  /** the PTY host's exit code once every byte was read; null after `stop` or the deadline */
  readonly exited: Promise<number | null>;
  /** hangs the pty up through the PTY host and waits for the end */
  stop(): Promise<void>;
}

const WASM = join(import.meta.dir, "..", "..", "shared", "ghostty", "ghostty-vt.wasm");

/** Capture the last visible alternate screen, before restoring the caller's original screen. */
export function screenOutput(output: string): string {
  const enter = output.lastIndexOf("\x1b[?1049h");
  if (enter < 0) return output;
  const leave = output.indexOf("\x1b[?1049l", enter);
  return output.slice(enter, leave < 0 ? undefined : leave);
}

/** Answer the host's queries in arrival order, including a query split across reads. */
export function answerQueries(send: (text: string) => void, answers: ReadonlyArray<readonly [string, string]>): (text: string) => void {
  let tail = "";
  const overlap = Math.max(0, ...answers.map(([query]) => query.length - 1));
  return (text) => {
    const window = tail + text;
    const found: [number, string][] = [];
    for (const [query, answer] of answers) {
      for (let at = window.indexOf(query); at !== -1; at = window.indexOf(query, at + 1)) {
        if (at + query.length > tail.length) found.push([at, answer]);
      }
    }
    tail = window.slice(window.length - Math.min(window.length, overlap));
    for (const [, answer] of found.sort((a, b) => a[0] - b[0])) send(answer);
  };
}

/** The cell grid the output leaves on a terminal of this size, one line a row, trailing blanks cut. */
export async function gridText(output: string, cols: number, rows: number): Promise<string> {
  const module = new GhosttyModule(new WebAssembly.Instance(new WebAssembly.Module(await Bun.file(WASM).arrayBuffer()), {}));
  // laid out the way herdr-core lays graphemes out, as the screen's own panes are
  const engine = new GhosttyEngine(module, cols, rows, { widths: "core", images: false });
  try {
    engine.write(new TextEncoder().encode(output));
    const lines: string[] = Array.from({ length: rows }, () => "");
    engine.frameAll((y, runs) => { lines[y] = runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd(); });
    return `${lines.join("\n")}\n`;
  } finally {
    engine.dispose();
  }
}

/** Ask the emulated host for its cursor position after replaying the captured display bytes. */
export async function hostCursorReport(output: string, cols: number, rows: number): Promise<string> {
  const module = new GhosttyModule(new WebAssembly.Instance(new WebAssembly.Module(await Bun.file(WASM).arrayBuffer()), {}));
  const encoder = new TextEncoder();
  let reply = "";
  const engine = new GhosttyEngine(module, cols, rows, {
    widths: "core", images: false, events: { onReply: (bytes) => { reply = Buffer.from(bytes).toString("latin1"); } },
  });
  try {
    engine.write(encoder.encode(output));
    reply = "";
    engine.write(encoder.encode("\x1b[6n"));
    return reply;
  } finally {
    engine.dispose();
  }
}

const live = new Set<() => Promise<void>>();

/** Ends every run still going, through each one's PTY host: for afterAll and a test's signal handlers. */
export async function stopAllPtyRuns(): Promise<void> {
  await Promise.all([...live].map((stop) => stop()));
}

export function runOnPty(options: PtyOptions): PtyRun {
  const [command, ...args] = options.command;
  if (!command) throw new Error("runOnPty: no command");
  const deadlineMs = options.deadlineMs ?? PTY_DEADLINE_MS;
  let output = "";
  let ended = false;
  let timedOut = false;
  let overflowed = false;
  const { maxOutputChars } = options;
  let code: number | null = null;
  const wakers = new Set<() => void>();
  const wake = () => { for (const waker of [...wakers]) waker(); };
  const session = new PtySession({
    command, args, cols: options.cols ?? 80, rows: options.rows ?? 24, env: options.env, inheritEnv: false,
    onData: (data) => {
      if (overflowed) return;
      output += data;
      if (maxOutputChars !== undefined && output.length > maxOutputChars) {
        overflowed = true;
        session.kill();
      }
      options.onData?.(data);
      wake();
    },
    onExit: (exit) => { code = exit; },
  });
  const deadline = setTimeout(() => { timedOut = true; session.kill(); wake(); }, deadlineMs);
  const stop = async () => { session.kill(); await exited; };
  const exited = session.exited.then(() => {
    ended = true;
    clearTimeout(deadline);
    live.delete(stop);
    wake();
    return code;
  });
  live.add(stop);
  return {
    output: () => output,
    type: (text) => { session.write(text); },
    resize: (cols, rows) => { session.resize(cols, rows); },
    exited,
    stop,
    until: (match, what) => new Promise<void>((resolve, reject) => {
      const check = () => {
        // a run past its limit never matches: its transcript is incomplete, so a marker in it proves nothing
        if (!overflowed && (typeof match === "string" ? output.includes(match) : match.test(output))) {
          wakers.delete(check);
          resolve();
        } else if (timedOut || ended || overflowed) {
          wakers.delete(check);
          const why = overflowed ? `the output passed ${maxOutputChars} characters`
            : timedOut ? `the deadline of ${deadlineMs} ms passed` : "the command ended";
          reject(new Error(`${why} before ${what ?? JSON.stringify(String(match))}; output: ${JSON.stringify(output.slice(-2000))}`));
        }
      };
      wakers.add(check);
      check();
    }),
  };
}

export interface Termios {
  canonical: boolean;
  echo: boolean;
  signals: boolean;
  /** `stty -a` as printed */
  text: string;
}

export function parseStty(text: string): Termios {
  const words = new Set(text.split(/[\s;]+/));
  return { canonical: words.has("icanon"), echo: words.has("echo"), signals: words.has("isig"), text };
}

export interface EntryEnd {
  /** the entry's exit code; 128 + n when signal n ended it */
  code: number;
  signal: string | null;
  before: Termios;
  /** null when the pty was gone and `stty` could not read it */
  after: Termios | null;
  stderr: string;
}

export type EntrySignal = "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGTSTP" | "SIGCONT";

export interface SupervisedRun extends PtyRun {
  /** the supervisor started the entry */
  readonly started: Promise<void>;
  /** sends `name` to the entry, through the supervisor's handle on it */
  signal(name: EntrySignal): void;
  /** the pty's termios now */
  stty(): Promise<Termios>;
  readonly ended: Promise<EntryEnd>;
}

interface Message { t: string; id?: number; text?: string | null; code?: number; signal?: string | null; before?: string | null; after?: string | null; stderr?: string }

/** Runs `entry` on a pty under the supervisor (see the top of this file). */
export function runSupervised(options: Omit<PtyOptions, "command"> & { entry: string[] }): SupervisedRun {
  const folder = mkdtempSync(join(options.env["TMPDIR"] || tmpdir(), "pty-"));
  const path = join(folder, "s");
  let conn: Socket<undefined> | null = null;
  let connected = false;
  let reported = false;
  const queued: string[] = [];
  const send = (message: Record<string, unknown>) => {
    const line = `${JSON.stringify(message)}\n`;
    if (conn) conn.write(line);
    else queued.push(line);
  };
  let settleStarted!: { resolve: () => void; reject: (error: Error) => void };
  let settleEnded!: { resolve: (end: EntryEnd) => void; reject: (error: Error) => void };
  const started = new Promise<void>((resolve, reject) => { settleStarted = { resolve, reject }; });
  const ended = new Promise<EntryEnd>((resolve, reject) => { settleEnded = { resolve, reject }; });
  // a run whose caller never asks is not an unhandled rejection
  started.catch(() => {});
  ended.catch(() => {});
  const asked = new Map<number, { resolve: (termios: Termios) => void; reject: (error: Error) => void }>();
  let nextId = 0;

  const fail = (why: string) => {
    const error = new Error(`${why}; output: ${JSON.stringify(run.output().slice(-2000))}`);
    settleStarted.reject(error);
    if (!reported) settleEnded.reject(error);
    for (const waiter of asked.values()) waiter.reject(error);
    asked.clear();
  };

  const handle = (message: Message) => {
    if (message.t === "started") settleStarted.resolve();
    else if (message.t === "stty" && message.id !== undefined) {
      const waiter = asked.get(message.id);
      asked.delete(message.id);
      if (message.text) waiter?.resolve(parseStty(message.text));
      else waiter?.reject(new Error("stty could not read the pty"));
    } else if (message.t === "ended") {
      reported = true;
      const end = {
        code: message.code!, signal: message.signal ?? null, before: parseStty(message.before ?? ""),
        after: message.after ? parseStty(message.after) : null, stderr: message.stderr ?? "",
      };
      // this report comes over the supervisor's socket and can overtake the entry's last output on the pty: the end is
      // told once the pty has ended too, which is once its output was all read
      void run.exited.then(() => settleEnded.resolve(end));
    }
  };

  let buffered = "";
  let socketClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => { socketClosed = resolve; });
  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      open(socket) {
        conn = socket;
        connected = true;
        for (const line of queued.splice(0)) socket.write(line);
      },
      data(_socket, data) {
        buffered += data.toString();
        for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
          handle(JSON.parse(buffered.slice(0, at)) as Message);
          buffered = buffered.slice(at + 1);
        }
      },
      close() {
        conn = null;
        // a request still open gets no answer any more, whether or not the end was reported
        fail(reported ? "the supervisor closed before answering" : "the supervisor ended without reporting the entry's end");
        socketClosed();
      },
    },
  });

  const run = runOnPty({ ...options, command: [process.execPath, SUPERVISOR, path, ...options.entry] });
  void run.exited.then(async () => {
    if (connected) await closed;
    else fail("the supervisor never connected");
    server.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  return {
    ...run,
    started,
    ended,
    signal: (name) => send({ t: "signal", name }),
    stty: () => new Promise<Termios>((resolve, reject) => {
      const id = nextId++;
      asked.set(id, { resolve, reject });
      send({ t: "stty", id });
    }),
  };
}
