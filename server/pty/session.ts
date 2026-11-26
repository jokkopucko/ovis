import { spawnErrorReason } from "../native-binary.ts";
import { RUST_HOST_FIX, rustSidecar } from "./host.ts";

/** How long a command asked to leave by itself (`leave`) has for it: what the host gives one to end after a hangup (KILL_AFTER). */
export const LEAVE_WITHIN_MS = 2000;

export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  env?: Record<string, string>;
  /** A private CLI gets only its supplied environment, not the server's credentials and hooks. */
  inheritEnv?: boolean;
  /**
   * The command's own way out, for `leave`: the keys it leaves at once it has read them, and what the input written
   * last may not end with for them to be read as that.
   */
  leaveAt?: { keys: string; notAfter: RegExp };
}

/** Writes a line to a child's stdin. On Windows a pipe write settles later, so a child that already
 * closed its end (EPIPE) rejects the returned promise instead of throwing; swallow both, never crash. */
export function writeLine(sink: import("bun").FileSink, line: string): boolean {
  const quiet = (pending: unknown) => { if (pending instanceof Promise) pending.catch(() => {}); };
  try {
    quiet(sink.write(line)); quiet(sink.flush());
    return true;
  } catch {
    return false;
  }
}

/** A command running on a real PTY, hosted by the Rust PTY host (crates/pty-sidecar). */
export class PtySession {
  readonly exited: Promise<void>;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private closed = false;
  private paused = false;
  /** the input written last, which `leaveAt.notAfter` is asked about */
  private last = "";
  private leaving: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PtySessionOptions) {
    // The bridge's bearer token is for browsers; neither the host nor the attach needs it.
    const env = { ...(options.inheritEnv === false ? {} : process.env), ...options.env };
    delete env["OVIS_TOKEN"];
    delete env["HERDR_WEB_TOKEN"];
    const host = rustSidecar();
    if (!host) throw new Error("no PTY host: the Rust PTY host cannot run here (the server's log says why)");
    try {
      this.proc = Bun.spawn([host, String(options.cols), String(options.rows), options.command, ...options.args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env });
    } catch (error) {
      throw new Error(`no PTY host: ${host} could not be started (${spawnErrorReason(error)}); to fix it, ${RUST_HOST_FIX}`);
    }

    // Process exit can precede the final stdout read. Deliver every byte before
    // onExit lets the server remove the attachment.
    this.exited = Promise.all([this.proc.exited, this.pump()]).then(([code]) => {
      if (!this.closed && this.proc.signalCode !== null) console.error(`Rust PTY host: ended by ${this.proc.signalCode}`);
      if (this.closed) return;
      this.closed = true;
      options.onExit(code ?? null);
    });
  }

  private async pump(): Promise<void> {
    const stream = this.proc.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        // stream:true keeps a multi-byte character split across reads intact
        const text = decoder.decode(value, { stream: true });
        if (text) this.options.onData(text);
      }
      const tail = decoder.decode();
      if (tail) this.options.onData(tail);
    } catch {
    } finally {
      reader.releaseLock();
    }
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.closed) return false;
    const sink = this.proc.stdin;
    if (!sink || typeof sink === "number" || !("write" in sink)) return false;
    return writeLine(sink, `${JSON.stringify(frame)}\n`);
  }

  write(data: string): boolean {
    if (!this.send({ t: "i", d: data })) return false;
    if (data) this.last = data;
    return true;
  }

  resize(cols: number, rows: number): void {
    this.send({ t: "r", c: cols, r: rows });
  }

  /**
   * Tells the command its window changed without changing it (SIGWINCH at the same size): a resize
   * to the size the pty already has delivers no signal. Ignored on Windows, which has no SIGWINCH.
   */
  winch(): void {
    this.send({ t: "w" });
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.send({ t: "p", paused: true });
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.send({ t: "p", paused: false });
  }

  /**
   * Lets the command leave by itself, with nothing more written to it: `leaveAt.keys` go in after everything written
   * so far, on the same stream, so a command that leaves when it reads them has read all of that first. A hangup
   * ends it with whatever it had not read yet. Killed as `kill` does when it has not left within LEAVE_WITHIN_MS, and
   * at once when it has no such keys or they would not be read as its way out.
   */
  leave(): void {
    if (this.closed) return;
    // paused, the command may be stuck writing output nobody reads, and never get to its input
    this.resume();
    const at = this.options.leaveAt;
    if (!at || at.notAfter.test(this.last) || !this.send({ t: "i", d: at.keys })) {
      this.kill();
      return;
    }
    this.closed = true;
    this.leaving = setTimeout(() => this.kill(), LEAVE_WITHIN_MS);
    void this.proc.exited.then(() => {
      clearTimeout(this.leaving);
      this.leaving = undefined;
    });
  }

  kill(): void {
    if (this.closed && this.leaving === undefined) return;
    clearTimeout(this.leaving);
    this.leaving = undefined;
    this.closed = true;
    const sink = this.proc.stdin;
    try {
      if (sink && typeof sink !== "number" && "end" in sink) sink.end();
    } catch {
    }
    try {
      this.proc.kill();
    } catch {
    }
  }
}
