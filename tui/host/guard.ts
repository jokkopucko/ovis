import { DRAIN_WAIT_MS, REPLY_WAIT_MS, SIGNAL_END_WAIT_MS } from "../model/deadlines.ts";
import type { ColorDepth, Host, HostEnd, HostSize, ProbeResult } from "./index.ts";
import { DISPLAY_QUERY, emptyProbe, PROBE_QUERY, ReplyFilter, withReply } from "./probe.ts";

/**
 * What `enter` turns on, in order, after raw mode: the alternate screen, the cursor hidden, focus
 * reports, bracketed paste, mouse 1002 and 1003 (any motion, as herdr asks: a pointer over a menu chooses its entry) with
 * SGR 1006, and one kitty keyboard entry with flag 1.
 * LEAVE undoes exactly these in reverse; raw mode goes last.
 */
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?1004h\x1b[?2004h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[>1u";
export const LEAVE = "\x1b[<u\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l";
/** Colour-scheme notifications (2031), the one mode the screen turns on later, through `watchDisplay`. */
const WATCH_DISPLAY = "\x1b[?2031h";
const UNWATCH_DISPLAY = "\x1b[?2031l";
/** What undoes every mode the screen can turn on: LEAVE's, and the colour-scheme watch before them. */
export const LEAVE_ALL = `${UNWATCH_DISPLAY}${LEAVE}`;

/** Which of the terminal's modes the screen holds: none, ENTER's, or ENTER's and the colour-scheme watch. */
export type Held = "none" | "modes" | "modes+watch";

/** The bytes that give back what is held, for the screen itself and for a process that does it once the screen died. */
export const undoHeld = (held: Held): string => held === "none" ? "" : held === "modes" ? LEAVE : LEAVE_ALL;
/**
 * Sent again after a resize and a focus-in, as some hosts drop them. The kitty flags are set on the
 * entry already pushed (`=1;1`), so the stack still holds one entry of ours.
 */
const MODES_AGAIN = "\x1b[?1004h\x1b[?2004h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[=1;1u";
const FOCUS_IN = Buffer.from("\x1b[I");
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

export type HostSignal = keyof typeof SIGNAL_NUMBERS;

/** The process events the host listens to while it holds the terminal. */
export interface HostHooks {
  signal(name: HostSignal): void;
  exit(): void;
  resize(): void;
  /** a stop from outside (SIGTSTP): the terminal is given back, then the process stops */
  stop(): void;
  /** the process goes on after a stop (SIGCONT) */
  cont(): void;
}

/** What a host is made of: the real one wires the process (unix.ts), the headless one memory. */
export interface TerminalPort {
  /** stdin and stdout are both terminals */
  readonly isTerminal: boolean;
  readonly colorTerm: string | undefined;
  setRaw(on: boolean): void;
  /** writes all of `bytes`; throws the system error when the write fails */
  write(bytes: Uint8Array): void;
  size(): HostSize;
  startReading(sink: (bytes: Uint8Array) => void): void;
  /** hands what is already read (and not yet delivered) to the sink, at once */
  readNow(): void;
  stopReading(): void;
  timer(ms: number, fire: () => void): () => void;
  /** the clock the timers run on, in ms */
  now(): number;
  /** installs the hooks; returns their removal */
  hook(hooks: HostHooks): () => void;
  exit(code: number): void;
  /**
   * Stops this process as the default action of SIGTSTP would (a handler for SIGTSTP replaces that action), once
   * `giveBack` has given the terminal back. A continue that comes from the moment it is called cancels the stop, so a
   * shell's `fg` is never lost however soon it comes. Where the job was continued already, before it was called, it gives
   * the terminal back and does not stop. Which of the two it is may be settled after it returns: once the process that
   * started this one is seen stopped at the same signal, or once the continue is heard. Either way the continue is heard
   * (`cont`).
   */
  suspend(giveBack: () => void): void;
  /**
   * Told which modes the screen holds: before it turns them on, and once it has undone them (at a stop from outside,
   * just before it undoes them). Whoever started the screen reads it after the screen died without giving the terminal
   * back (tui/host/hold.ts).
   */
  hold(held: Held): void;
}

/** EIO and EPIPE: the terminal is gone; EAGAIN reaches here only once the port gave up waiting for it. */
const isGone = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EIO" || code === "EPIPE" || code === "EAGAIN";
};

/**
 * The one implementation of the `Host` rules over a port: every mode undone once, in reverse order,
 * on leave, exit and signal; the probe's replies kept inside; gone reported once.
 */
export function guardedHost(port: TerminalPort): Host {
  const encoder = new TextEncoder();
  const inputs = new Set<(bytes: Uint8Array) => void>();
  const resizes = new Set<(size: HostSize) => void>();
  const ends = new Set<(end: HostEnd) => void | Promise<void>>();
  const colorDepth: ColorDepth = port.colorTerm === "truecolor" || port.colorTerm === "24bit" ? "truecolor" : "256";

  let state: "idle" | "entered" | "left" = "idle";
  let rawOn = false;
  let modesOn = false;
  let watchingDisplay = false;
  let gone = false;
  let ending = false;
  let entering = false;
  let deferred: HostSignal | null = null;
  /**
   * The terminal was given back at a stop from outside and is not taken again before the continue: nothing is written
   * meanwhile, as the process may run on a while before it stops (or not stop at all, continued already). The continue
   * enters again and asks for a repaint.
   */
  let suspended = false;
  let unhook: (() => void) | null = null;

  const filter = new ReplyFilter();
  let phase: "none" | "probing" | "late" | "done" = "none";
  let probeResult = emptyProbe();
  let probePromise: Promise<ProbeResult> | null = null;
  let settleProbe: ((result: ProbeResult) => void) | null = null;
  let cancelProbeTimer: (() => void) | null = null;
  let cancelHoldTimer: (() => void) | null = null;
  let focusTail: Uint8Array = new Uint8Array(0);

  let drainState: { cancel: () => void; resolve: () => void } | null = null;
  let drainPromise: Promise<void> | null = null;

  /** The port is told what is held now: called before a write that turns modes on, and after one that undoes them. */
  const holding = () => port.hold(!modesOn ? "none" : watchingDisplay ? "modes+watch" : "modes");

  const reportGone = (why: "hangup" | "write-failed") => {
    if (gone) return [];
    gone = true;
    return [...ends].map((listener) => listener({ kind: "gone", why }));
  };

  /** One write to the terminal; false when it is gone (reported here, once). */
  const send = (bytes: Uint8Array): boolean => {
    if (gone) return false;
    try {
      port.write(bytes);
      return true;
    } catch (error) {
      if (!isGone(error)) throw error;
      reportGone("write-failed");
      return false;
    }
  };

  const finishProbe = (answered: boolean) => {
    if (phase !== "probing") return;
    cancelProbeTimer?.();
    cancelProbeTimer = null;
    phase = answered ? "done" : "late";
    settleProbe?.(probeResult);
    settleProbe = null;
  };

  const finishDrain = () => {
    if (!drainState) return;
    const { cancel, resolve } = drainState;
    drainState = null;
    cancel();
    drainPromise = null;
    resolve();
  };

  const modesAgain = () => {
    if (state === "entered" && !ending) send(encoder.encode(MODES_AGAIN));
  };

  const resized = () => {
    if (state !== "entered" || ending || suspended) return;
    modesAgain();
    const size = port.size();
    for (const listener of resizes) listener(size);
  };

  /** A focus-in report anywhere in the input, one split across two reads included. */
  const sawFocusIn = (input: Uint8Array): boolean => {
    const joined = Buffer.concat([focusTail, input]);
    const found = joined.includes(FOCUS_IN);
    focusTail = found ? new Uint8Array(0) : joined.subarray(-2).slice();
    return found;
  };

  /** Input bytes, in order, to the listeners (after a focus-in, the modes again); a drain that runs waits DRAIN_WAIT_MS more. */
  const deliver = (input: Uint8Array) => {
    if (drainState) {
      drainState.cancel();
      drainState.cancel = port.timer(DRAIN_WAIT_MS, finishDrain);
    }
    if (input.length === 0) return;
    if (sawFocusIn(input)) modesAgain();
    for (const listener of inputs) listener(input);
  };

  /** One timer for the sequence the filter holds: when its wait ends, it goes out whole. */
  const armHold = () => {
    cancelHoldTimer?.();
    cancelHoldTimer = null;
    const due = filter.deadline();
    if (due === undefined) return;
    cancelHoldTimer = port.timer(Math.max(0, due - port.now()), () => {
      cancelHoldTimer = null;
      if (state !== "entered") return;
      deliver(filter.expire(port.now()));
      armHold();
    });
  };

  const take = (chunk: Uint8Array) => {
    if (state !== "entered") return;
    if (phase !== "probing" && phase !== "late") { deliver(chunk); return; }
    const taken = filter.feed(chunk, port.now(), phase === "late" && watchingDisplay);
    if (phase === "probing") for (const reply of taken.replies) probeResult = withReply(probeResult, reply);
    if (taken.rest) {
      if (phase === "probing") finishProbe(true);
      phase = "done";
      deliver(Buffer.concat([taken.input, taken.rest]));
    } else deliver(taken.input);
    armHold();
  };

  const leave = () => {
    if (state !== "entered") return;
    state = "left";
    port.stopReading();
    cancelHoldTimer?.();
    cancelHoldTimer = null;
    finishProbe(false);
    finishDrain();
    // a write error that is not gone is thrown once the terminal is given back, never before
    let failed: { error: unknown } | null = null;
    if (modesOn) {
      try { send(encoder.encode(watchingDisplay ? LEAVE_ALL : LEAVE)); } catch (error) { failed = { error }; }
    }
    modesOn = false;
    holding();
    if (rawOn) {
      rawOn = false;
      try { port.setRaw(false); } catch { /* the terminal is gone: nothing left to restore */ }
    }
    // after a signal the hooks stay until the process ends, so a second signal finds the restore done
    if (!ending) { unhook?.(); unhook = null; }
    if (failed) throw failed.error;
  };

  /**
   * A stop from outside (SIGTSTP, as a shell's job control sends): every mode undone as on leave, raw mode off, then the
   * process stops, so whatever reads the terminal meanwhile gets no mouse reports; on SIGCONT the modes are entered again
   * and the resize listeners told, so the screen is repainted whole.
   */
  const stopped = () => {
    if (state !== "entered" || ending || suspended) return;
    port.suspend(() => {
      port.stopReading();
      // Said before the leave bytes here, not after as on leave: a shell continues the job as soon as it has the
      // terminal back, before this process may have stopped.
      const held = modesOn;
      modesOn = false;
      holding();
      if (held) {
        try { send(encoder.encode(watchingDisplay ? LEAVE_ALL : LEAVE)); } catch { /* the terminal is gone: nothing to restore */ }
      }
      if (rawOn) {
        rawOn = false;
        try { port.setRaw(false); } catch { /* the terminal is gone */ }
      }
      // a stop cancelled by a continue still hears that continue next, and enters again then
      suspended = true;
    });
  };
  const continued = () => {
    if (!suspended || state !== "entered" || ending) return;
    suspended = false;
    port.setRaw(true);
    rawOn = true;
    modesOn = true;
    holding();
    send(encoder.encode(watchingDisplay ? `${ENTER}${WATCH_DISPLAY}` : ENTER));
    port.startReading(take);
    const size = port.size();
    for (const listener of resizes) listener(size);
  };

  const onSignal = (name: HostSignal) => {
    if (entering) { deferred ??= name; return; }
    if (ending) return;
    ending = true;
    // the signal decides the end: a leave write that failed changes neither the restore nor the exit code
    try { leave(); } catch { /* given back all the same: leave throws only after the restore */ }
    const pending = name === "SIGHUP" ? reportGone("hangup") : [...ends].map((listener) => listener({ kind: "signal", signal: name }));
    gone = true;
    const code = 128 + SIGNAL_NUMBERS[name];
    const waits = pending.filter((value): value is Promise<void> => value instanceof Promise);
    if (waits.length === 0) { port.exit(code); return; }
    let exited = false;
    const exit = () => { if (!exited) { exited = true; cancel(); port.exit(code); } };
    const cancel = port.timer(SIGNAL_END_WAIT_MS, exit);
    void Promise.allSettled(waits).then(exit);
  };

  return {
    colorDepth,

    enter() {
      if (state === "entered") return true;
      if (state === "left" || !port.isTerminal) return false;
      entering = true;
      try {
        unhook = port.hook({ signal: onSignal, exit: leave, resize: resized, stop: stopped, cont: continued });
        state = "entered";
        port.setRaw(true);
        rawOn = true;
        modesOn = true;
        holding();
        send(encoder.encode(ENTER));
        port.startReading(take);
      } catch (error) {
        entering = false;
        // the first error is the one enter reports; one the restore meets after it is not
        try { leave(); } catch { /* given back all the same: leave throws only after the restore */ }
        throw error;
      }
      entering = false;
      if (deferred) onSignal(deferred);
      return true;
    },

    leave,

    size: () => port.size(),

    onInput(listener) { inputs.add(listener); return () => { inputs.delete(listener); }; },
    onResize(listener) { resizes.add(listener); return () => { resizes.delete(listener); }; },
    onEnd(listener) { ends.add(listener); return () => { ends.delete(listener); }; },

    write(data) {
      if (state !== "entered" || suspended) return false;
      return send(typeof data === "string" ? encoder.encode(data) : data);
    },

    probe() {
      if (probePromise) return probePromise;
      if (state !== "entered" || gone) {
        probePromise = Promise.resolve(emptyProbe());
        return probePromise;
      }
      probePromise = new Promise<ProbeResult>((resolve) => { settleProbe = resolve; });
      phase = "probing";
      let sent = false;
      try {
        sent = send(encoder.encode(PROBE_QUERY));
      } finally {
        // a query that was not written, gone or thrown, ends the probe now: a later call gets that answer
        if (!sent) finishProbe(false);
      }
      if (phase === "probing") cancelProbeTimer = port.timer(REPLY_WAIT_MS, () => finishProbe(false));
      return probePromise;
    },

    watchDisplay() {
      if (state !== "entered" || watchingDisplay) return;
      watchingDisplay = true;
      holding();
      // while suspended, the continue turns it on with the rest
      if (!suspended) send(encoder.encode(WATCH_DISPLAY));
    },

    refreshDisplay() {
      if (state === "entered" && !suspended) send(encoder.encode(DISPLAY_QUERY));
    },

    drain() {
      if (drainPromise) return drainPromise;
      if (state !== "entered") return Promise.resolve();
      const drained = new Promise<void>((resolve) => {
        drainState = { cancel: port.timer(DRAIN_WAIT_MS, finishDrain), resolve };
      });
      drainPromise = drained;
      // what readNow hands on may end the drain at once (a listener that leaves): this call still answers its own promise
      port.readNow();
      return drained;
    },
  };
}
