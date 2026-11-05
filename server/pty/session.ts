import { join } from "node:path";
import { disableRustHost, rustSidecar, spawnErrorReason } from "./host.ts";
import { nodeSidecarAvailable, realNode } from "./sidecar.ts";

const HOST_SCRIPT = join(import.meta.dir, "pty-host.mjs");

export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  /** Extra environment for the command, on top of this process's own. */
  env?: Record<string, string>;
  /** A private CLI gets only its supplied environment, not the server's credentials and hooks. */
  inheritEnv?: boolean;
}

/** Writes a line to a child's stdin. On Windows a pipe write settles later, so a child that already
 * closed its end (EPIPE) rejects the returned promise instead of throwing; swallow both, never crash. */
export function writeLine(sink: import("bun").FileSink, line: string): boolean {
  const quiet = (pending: unknown) => { if (pending instanceof Promise) pending.catch(() => {}); };
  try {
    quiet(sink.write(line)); quiet(sink.flush());
    return true;
  } catch {
    return false; // host already gone
  }
}

/**
 * A command running on a real PTY, hosted by the Rust host or, as the fallback, the Node sidecar (see pty-host.mjs for
 * why output flow control currently needs node-pty, and why it is the prebuilt
 * @lydell/node-pty distribution of it).
 */
export class PtySession {
  readonly host: "node" | "rust";
  readonly exited: Promise<void>;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private closed = false;
  private paused = false;

  constructor(private readonly options: PtySessionOptions) {
    // The bridge's bearer token is for browsers; neither the sidecar nor the attach needs it.
    const env = { ...(options.inheritEnv === false ? {} : process.env), ...options.env };
    delete env["OVIS_TOKEN"];
    delete env["HERDR_WEB_TOKEN"];
    const args = [String(options.cols), String(options.rows), options.command, ...options.args];
    const spawnOptions = { stdin: "pipe", stdout: "pipe", stderr: "inherit", env } as const;
    // only a real Node runs pty-host.mjs: `bun run` puts a `node` that is Bun on a PC without one
    const node = () => {
      const executable = nodeSidecarAvailable() ? realNode(options.inheritEnv === false ? process.env : env) : null;
      if (!executable) throw new Error("no PTY host: the Rust host cannot run and this PC has no Node for the PTY sidecar");
      return Bun.spawn([executable, HOST_SCRIPT, ...args], spawnOptions);
    };
    const rust = rustSidecar();
    if (rust) {
      try {
        this.proc = Bun.spawn([rust, ...args], spawnOptions);
        this.host = "rust";
      } catch (error) {
        const reason = `${rust} could not be started (${spawnErrorReason(error)})`;
        if (!nodeSidecarAvailable()) throw new Error(`no PTY host: ${reason}, and this PC has no Node for the PTY sidecar`);
        this.proc = node();
        this.host = "node";
        disableRustHost(reason);
      }
    } else {
      this.proc = node();
      this.host = "node";
    }

    // Process exit can precede the final stdout read. Deliver every byte before
    // onExit lets the server remove the attachment.
    this.exited = Promise.all([this.proc.exited, this.pump()]).then(([code]) => {
      // with no Node to fall back to, switching the Rust host off would leave every later attach without a host
      if (this.host === "rust" && !this.closed && this.proc.signalCode !== null) {
        if (nodeSidecarAvailable()) disableRustHost(`the Rust PTY host ended by ${this.proc.signalCode}`);
        else console.error(`Rust PTY host: ended by ${this.proc.signalCode}; kept, as this PC has no Node for the PTY sidecar`);
      }
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
      /* the pty closed underneath us; onExit reports it */
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
    return this.send({ t: "i", d: data });
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

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    const sink = this.proc.stdin;
    try {
      if (sink && typeof sink !== "number" && "end" in sink) sink.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
