import { FFIType } from "bun:ffi";
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { LAUNCHER_STOP_LOOK_MS, LAUNCHER_STOP_WAIT_MS, WRITE_AGAIN_LIMIT, WRITE_AGAIN_PAUSE_MS } from "../model/deadlines.ts";
import { guardedHost, type HostHooks } from "./guard.ts";
import { openHold, SCREEN_HOLD } from "./hold.ts";
import type { Host } from "./index.ts";
import { openLibc } from "./libc.ts";

type Listener = () => void;

/** C's SIG_DFL and SIG_IGN, as `signal` takes them. */
const SIG_DFL = 0;
const SIG_IGN = 1;
/** sigset_t's size and pthread_sigmask's SIG_BLOCK and SIG_SETMASK: macOS, else Linux's. */
const SIGSET = process.platform === "darwin" ? { bytes: 4, block: 1, setMask: 3 } : { bytes: 128, block: 0, setMask: 2 };
const openSignal = () => openLibc({
  signal: { args: [FFIType.i32, FFIType.u64_fast], returns: FFIType.u64_fast },
  pthread_sigmask: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  raise: { args: [FFIType.i32], returns: FFIType.i32 },
  getpgrp: { args: [], returns: FFIType.i32 },
  getsid: { args: [FFIType.i32], returns: FFIType.i32 },
});

/**
 * Stops this process at SIGTSTP's default action once `giveBack` has run, with the stop asked for first and held
 * pending (SIGTSTP blocked, at its default action): a SIGCONT sent from then on discards a pending stop signal
 * (POSIX), so a continue that comes before the process could stop, the shell's `fg` once it saw the terminal given
 * back, cancels the stop instead of being lost to it. `decide` then settles it, at once or later: where the job was
 * continued before the stop was asked for, the pending stop is discarded (SIG_IGN), and the continue that came is heard
 * next, and the screen enters again. The stop lands when SIGTSTP is unblocked again; Bun's own handler comes back after
 * it. It stays at the default action until then: with Bun's handler in place while `decide` waits, the pending stop was
 * taken from this thread and never landed (5 of 100 runs of tui/host/restore.contract.test.ts in the CI runner image).
 */
function stopOnceGivenBack(libc: NonNullable<ReturnType<typeof openSignal>>, giveBack: () => void, decide: (settle: (continued: boolean) => void) => void): void {
  const tstp = constants.signals.SIGTSTP;
  const set = new Uint8Array(SIGSET.bytes);
  set[(tstp - 1) >> 3]! |= 1 << ((tstp - 1) & 7);
  const before = new Uint8Array(SIGSET.bytes);
  libc.symbols.pthread_sigmask(SIGSET.block, set, before);
  const handler = libc.symbols.signal(tstp, SIG_DFL);
  let settled = false;
  const settle = (continued: boolean) => {
    if (settled) return;
    settled = true;
    if (continued) libc.symbols.signal(tstp, SIG_IGN);
    libc.symbols.pthread_sigmask(SIGSET.setMask, before, null);
    libc.symbols.signal(tstp, handler);
  };
  try {
    // to this thread, which holds it blocked: pending until unblocked, or discarded by a continue
    libc.symbols.raise(tstp);
    giveBack();
    decide(settle);
  } catch (error) {
    settle(false);
    throw error;
  }
}

/** Linux's stop signals, as bits of /proc's signal masks. */
const STOP_BITS = ["SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU"].reduce((bits, name) => bits | (1n << BigInt(constants.signals[name as "SIGSTOP"] - 1)), 0n);

/** macOS's proc_pidinfo: PROC_PIDTBSDINFO's struct proc_bsdinfo, whose pbi_status (at byte 4) is SSTOP for a stopped process. */
const BSDINFO = { flavor: 3, bytes: 136, status: 4, stopped: 4 };
const openProcInfo = () => process.platform === "darwin"
  ? openLibc({ proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } })
  : null;

/**
 * Whether process `pid` is stopped, or a stop signal waits for it. On Linux the pending stop is read first, then each
 * thread's state. Neither shows a stop a thread has taken and not yet acted on: Linux lets go of the signal lock in
 * between (kernel/signal.c, `get_signal`), so a launcher read as running may still stop a moment later. On macOS its
 * status says whether it is stopped. Anything that cannot be read counts as stopped: the stop then goes on, as it did
 * before.
 */
function stopping(pid: number, procInfo: ReturnType<typeof openProcInfo>): boolean {
  try {
    if (process.platform !== "linux") {
      if (procInfo === null) return true;
      const info = new Uint8Array(BSDINFO.bytes);
      if (procInfo.symbols.proc_pidinfo(pid, BSDINFO.flavor, 0, info, BSDINFO.bytes) !== BSDINFO.bytes) return true;
      return new DataView(info.buffer).getUint32(BSDINFO.status, true) === BSDINFO.stopped;
    }
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    for (const name of ["SigPnd", "ShdPnd"]) {
      const mask = new RegExp(`^${name}:\\s*([0-9a-f]+)`, "m").exec(status)?.[1];
      if (mask !== undefined && (BigInt(`0x${mask}`) & STOP_BITS) !== 0n) return true;
    }
    return readdirSync(`/proc/${pid}/task`).some((task) => /^[Tt]/.test(readFileSync(`/proc/${pid}/task/${task}/stat`, "utf8").split(") ").at(-1) ?? "T"));
  } catch {
    return true;
  }
}

/**
 * Runs `restore` with SIGTTOU ignored, through `libc` (opened when the host is made, so a stop's restore takes no longer
 * than before). When the screen's job is stopped (a shell's Ctrl+Z, a stop from outside), the shell takes the terminal
 * back as soon as the job's first process stops, which can be before the screen has given the terminal back: the screen
 * is then a background process, and changing the terminal's settings stops it with SIGTTOU half way. The `fg` that
 * continues it would find it sending itself the stop it was about to send, and it would stay stopped in the foreground.
 * Ignored, the settings are written and the stop goes on as meant.
 */
function ttouIgnored(libc: ReturnType<typeof openSignal>, restore: () => void): void {
  if (libc === null) {
    restore();
    return;
  }
  const previous = libc.symbols.signal(constants.signals.SIGTTOU, SIG_IGN);
  try {
    restore();
  } finally {
    libc.symbols.signal(constants.signals.SIGTTOU, previous);
  }
}

export interface UnixStdin {
  isTTY?: boolean;
  setRawMode(on: boolean): unknown;
  on(event: "readable", listener: Listener): unknown;
  off(event: "readable", listener: Listener): unknown;
  read(): Uint8Array | string | null;
  pause(): unknown;
  ref?(): unknown;
  unref?(): unknown;
}

export interface UnixStdout {
  isTTY?: boolean;
  fd: number;
  columns?: number;
  rows?: number;
  on(event: "resize", listener: Listener): unknown;
  off(event: "resize", listener: Listener): unknown;
}

export interface UnixProcess {
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  exit(code: number): unknown;
  kill(pid: number, signal: string): unknown;
  readonly pid: number;
  readonly ppid: number;
}

export interface UnixHostParts {
  stdin: UnixStdin;
  stdout: UnixStdout;
  process: UnixProcess;
  env: Record<string, string | undefined>;
  writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  /** blocks this long between two tries of a refused write */
  pause: (ms: number) => void;
  /** stops this process once `giveBack` gave the terminal back, unless `decide` settles that the job was continued already (`stopOnceGivenBack`) */
  stop: (giveBack: () => void, decide: (settle: (continued: boolean) => void) => void) => void;
  /** whether a process is stopped, or about to stop (`stopping`) */
  stopping: (pid: number) => boolean;
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4));
/** a synchronous wait that does not spin: writes are synchronous, so the retry must be too */
const pauseSync = (ms: number) => { Atomics.wait(pauseCell, 0, 0, ms); };

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The host terminal of this process: stdin, stdout and their tty. Writes are synchronous, one
 * frame at a time (probe d: Bun writes to a tty synchronously and `drain` never fires); stdin is
 * read in paused mode, a `readable` event then `read()` until null, in whole chunks. The parts are
 * replaceable so its wiring can be tested without a terminal; the defaults are this process's own.
 */
export function createUnixHost(parts: Partial<UnixHostParts> = {}): Host {
  const stdin: UnixStdin = parts.stdin ?? process.stdin;
  const stdout: UnixStdout = parts.stdout ?? process.stdout;
  const proc: UnixProcess = parts.process ?? process;
  const env = parts.env ?? process.env;
  const write = parts.writeSync ?? writeSync;
  const pause = parts.pause ?? pauseSync;
  const signalLibc = openSignal();
  // A process group that leads its session (a pty's entry run on its own, with no job-control shell above it) is
  // orphaned: the system drops SIGTSTP's default stop there, and only SIGSTOP stops it. No shell's `fg` comes there.
  const stop = parts.stop ?? ((giveBack, decide) => {
    if (signalLibc === null || signalLibc.symbols.getpgrp() === signalLibc.symbols.getsid(0)) {
      giveBack();
      proc.kill(proc.pid, "SIGSTOP");
    } else stopOnceGivenBack(signalLibc, giveBack, decide);
  });
  const procInfo = parts.stopping ? null : openProcInfo();
  const isStopping = parts.stopping ?? ((pid: number) => stopping(pid, procInfo));
  const launched = Boolean(env[SCREEN_HOLD]);
  // the launcher's file, when a launcher started this screen: opened now, so that saying what is held is one write
  const hold = env[SCREEN_HOLD] ? openHold(env[SCREEN_HOLD]) : null;
  let sink: ((bytes: Uint8Array) => void) | null = null;

  const readAll = () => {
    for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) {
      sink?.(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
    }
  };

  return guardedHost({
    isTerminal: stdin.isTTY === true && stdout.isTTY === true,
    colorTerm: env["COLORTERM"],
    setRaw: (on) => { if (on) stdin.setRawMode(true); else ttouIgnored(signalLibc, () => stdin.setRawMode(false)); },
    write(bytes) {
      let refused = 0;
      for (let at = 0; at < bytes.length;) {
        try {
          at += write(stdout.fd, bytes, at, bytes.length - at);
          refused = 0;
        } catch (error) {
          // a tty another program left non-blocking: tried again, a while apart, up to a limit; then the
          // EAGAIN goes up and the guard reports the terminal gone
          if ((error as { code?: unknown }).code !== "EAGAIN" || ++refused > WRITE_AGAIN_LIMIT) throw error;
          pause(WRITE_AGAIN_PAUSE_MS);
        }
      }
    },
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    startReading(onBytes) {
      sink = onBytes;
      stdin.on("readable", readAll);
    },
    readNow: readAll,
    stopReading() {
      sink = null;
      stdin.off("readable", readAll);
      stdin.pause();
      // a paused stdin still holds the loop open in Bun; unref lets the process end, and fd 0 stays open
      stdin.unref?.();
    },
    timer(ms, fire) {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
    now: () => performance.now(),
    hook(hooks: HostHooks) {
      const signals = SIGNALS.map((name) => [name, () => hooks.signal(name)] as const);
      for (const [name, listener] of signals) proc.on(name, listener);
      proc.on("exit", hooks.exit);
      stdout.on("resize", hooks.resize);
      proc.on("SIGTSTP", hooks.stop);
      proc.on("SIGCONT", hooks.cont);
      return () => {
        for (const [name, listener] of signals) proc.off(name, listener);
        proc.off("exit", hooks.exit);
        stdout.off("resize", hooks.resize);
        proc.off("SIGTSTP", hooks.stop);
        proc.off("SIGCONT", hooks.cont);
      };
    },
    exit: (code) => { proc.exit(code); },
    // stopReading let go of the loop; it is held again before the stop, or a screen with nothing else to wait for could
    // end on its own the moment the continue wakes it, before the continue is heard. Started by a launcher (it named a
    // hold file), the job's first process is that launcher, which stops at the shell's SIGTSTP at once. When it is seen
    // running, either the shell continued the job before this handler ran, or the launcher took the signal and has not
    // stopped yet. The stop stays pending until one shows: the launcher stops, and so does this process; or the
    // continue, which reached this process too, is heard (after the guard entered again at it), and this process does
    // not stop; nor does it at a signal that ends it, which the guard is answering by then. Without the C library, this process stops by the one stop no handler can catch, as it did before, and so
    // does a screen whose group leads its session.
    suspend: (giveBack) => {
      stop(() => { giveBack(); stdin.ref?.(); }, (settle) => {
        if (!launched || isStopping(proc.ppid)) { settle(false); return; }
        const started = performance.now();
        let look: ReturnType<typeof setTimeout> | undefined;
        const finish = (continued: boolean) => {
          clearTimeout(look);
          for (const name of ["SIGCONT", ...SIGNALS]) proc.off(name, heard);
          settle(continued);
        };
        const heard = () => { finish(true); };
        const again = () => {
          if (isStopping(proc.ppid)) finish(false);
          else if (performance.now() - started >= LAUNCHER_STOP_WAIT_MS) finish(true);
          else look = setTimeout(again, LAUNCHER_STOP_LOOK_MS);
        };
        for (const name of ["SIGCONT", ...SIGNALS]) proc.on(name, heard);
        look = setTimeout(again, LAUNCHER_STOP_LOOK_MS);
      });
    },
    hold: (held) => { hold?.(held); },
  });
}
