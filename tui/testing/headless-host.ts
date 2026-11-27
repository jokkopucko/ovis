import { guardedHost, type HostHooks, type HostSignal } from "../host/guard.ts";
import type { ColorDepth, Host, HostEnd, HostSize, ProbeResult } from "../host/index.ts";

export interface HeadlessOptions {
  cols?: number;
  rows?: number;
  /** false: stdin or stdout is not a terminal */
  terminal?: boolean;
  colorTerm?: string;
  /** what the host answers once the start probe is written (after the write returns); null: nothing */
  answer?: string | Uint8Array | null;
}

/**
 * The `Host` in memory, for tests and `tui/testing/run.ts`: the same guard as the real host over a
 * terminal made of arrays, a manual clock and signals the test delivers. It reads no stdin, writes
 * no stdout and hooks nothing of the process.
 */
export class HeadlessHost implements Host {
  private readonly host: Host;
  private readonly entries: string[] = [];
  private readonly held: string[] = [];
  private readonly chunks: Uint8Array[] = [];
  private readonly waiting: Uint8Array[] = [];
  private readonly timerList: { at: number; fire: () => void }[] = [];
  private current: HostSize;
  private now = 0;
  private sink: ((bytes: Uint8Array) => void) | null = null;
  private hooks: HostHooks | null = null;
  private failure: string | null = null;
  private attempts = 0;
  private interrupt: (() => void) | null = null;
  /** the code the host ended the process with, or the one a signal with no hook would have */
  exitCode: number | null = null;
  /** how many times the host stopped the process (a SIGTSTP) */
  suspends = 0;

  constructor(options: HeadlessOptions = {}) {
    this.current = { cols: options.cols ?? 80, rows: options.rows ?? 24 };
    const encoder = new TextEncoder();
    const answer = typeof options.answer === "string" ? encoder.encode(options.answer) : options.answer ?? null;
    this.host = guardedHost({
      isTerminal: options.terminal ?? true,
      colorTerm: options.colorTerm,
      setRaw: (on) => { this.entries.push(`raw ${on ? "on" : "off"}`); },
      write: (bytes) => {
        this.attempts++;
        const during = this.interrupt;
        this.interrupt = null;
        during?.();
        if (this.failure) throw Object.assign(new Error(`${this.failure}: write failed`), { code: this.failure });
        this.chunks.push(bytes.slice());
        this.entries.push(`write ${new TextDecoder().decode(bytes)}`);
        if (answer && new TextDecoder().decode(bytes).endsWith("\x1b[c")) queueMicrotask(() => this.feed(answer));
      },
      size: () => this.current,
      startReading: (sink) => { this.sink = sink; },
      readNow: () => { for (const bytes of this.waiting.splice(0)) this.sink?.(bytes); },
      stopReading: () => { this.sink = null; },
      timer: (ms, fire) => {
        const entry = { at: this.now + ms, fire };
        this.timerList.push(entry);
        return () => { const i = this.timerList.indexOf(entry); if (i !== -1) this.timerList.splice(i, 1); };
      },
      now: () => this.now,
      hook: (hooks) => { this.hooks = hooks; return () => { this.hooks = null; }; },
      exit: (code) => { this.exitCode ??= code; },
      suspend: (giveBack) => { giveBack(); this.suspends += 1; },
      hold: (held) => { this.held.push(`${held} after ${this.entries.at(-1) ?? "nothing"}`); },
    });
  }

  get colorDepth(): ColorDepth { return this.host.colorDepth; }
  enter(): boolean { return this.host.enter(); }
  leave(): void { this.host.leave(); }
  size(): HostSize { return this.host.size(); }
  onInput(listener: (bytes: Uint8Array) => void): () => void { return this.host.onInput(listener); }
  onResize(listener: (size: HostSize) => void): () => void { return this.host.onResize(listener); }
  onEnd(listener: (end: HostEnd) => void | Promise<void>): () => void { return this.host.onEnd(listener); }
  write(data: Uint8Array | string): boolean { return this.host.write(data); }
  probe(): Promise<ProbeResult> { return this.host.probe(); }
  watchDisplay(): void { this.host.watchDisplay(); }
  refreshDisplay(): void { this.host.refreshDisplay(); }
  drain(): Promise<void> { return this.host.drain(); }

  /** Bytes typed into the host: they arrive now, as one read. */
  feed(data: string | Uint8Array): void {
    this.sink?.(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  /** Bytes already read but not yet delivered: a drain reads them. */
  queue(data: string | Uint8Array): void {
    this.waiting.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  resize(cols: number, rows: number): void {
    this.current = { cols, rows };
    this.hooks?.resize();
  }

  /** A signal to the process: the host's hook when it holds one, else the default end. */
  signal(name: HostSignal): void {
    if (this.hooks) this.hooks.signal(name);
    else this.exitCode ??= 128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[name];
  }

  hangUp(): void {
    this.signal("SIGHUP");
  }

  /** A stop from outside (SIGTSTP), and the continue after it (SIGCONT). */
  stop(): void { this.hooks?.stop(); }
  cont(): void { this.hooks?.cont(); }

  /** The process exits (process.exit, or an error nobody caught). */
  processExit(): void {
    this.hooks?.exit();
  }

  /** Every write from now on fails with this system error code. */
  failWrites(code: string): void {
    this.failure = code;
  }

  /** Runs `during` inside the next write, before its bytes count as written. */
  duringNextWrite(during: () => void): void {
    this.interrupt = during;
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.timerList.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timerList.splice(this.timerList.indexOf(due), 1);
      this.now = due.at;
      due.fire();
    }
    this.now = until;
  }

  /** Lets promises the host settled run their callbacks. */
  async settled(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  timers(): number { return this.timerList.length; }
  hooked(): boolean { return this.hooks !== null; }
  writeAttempts(): number { return this.attempts; }
  /** raw-mode changes and writes, in order */
  log(): string[] { return [...this.entries]; }
  /** what the host said it holds, in order, each with the log entry it came after */
  holds(): string[] { return [...this.held]; }
  output(): string { return new TextDecoder().decode(Buffer.concat(this.chunks)); }
  bytes(): Uint8Array { return Buffer.concat(this.chunks); }
}
