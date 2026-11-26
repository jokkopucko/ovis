export interface WatchStreamOptions {
  onFrame: (data: string) => void;
  onEnd: (reason?: string) => void;
  onScreen?: (data: string, cols: number, rows: number, full: boolean) => void;
}

export class WatchStreamParser {
  private pending = "";
  private readonly decoder = new TextDecoder();
  private ended = false;

  constructor(private readonly options: WatchStreamOptions) {}

  push(chunk: string): void {
    if (this.ended) return;
    this.pending += chunk;
    let start = 0;
    for (;;) {
      const newline = this.pending.indexOf("\n", start);
      if (newline < 0) break;
      this.line(this.pending.slice(start, newline));
      start = newline + 1;
      if (this.ended) break;
    }
    this.pending = this.ended ? "" : this.pending.slice(start);
  }

  finish(): void {
    if (this.ended) return;
    this.line(this.pending);
    this.pending = "";
    if (!this.ended) this.flush();
  }

  private flush(): void {
    const data = this.decoder.decode();
    if (data) this.options.onFrame(data);
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof record !== "object" || record === null || !("type" in record)) return;
    // herdr 0.9.3 labels a frame `encoding:"ansi"`: what the bytes are; `bytes` itself is always base64
    if (record.type === "terminal.frame" && "encoding" in record && record.encoding === "ansi" && "bytes" in record && typeof record.bytes === "string") {
      const data = this.decoder.decode(Buffer.from(record.bytes, "base64"), { stream: true });
      if ("width" in record && typeof record.width === "number" && Number.isInteger(record.width) && record.width > 0 && record.width <= 1000
        && "height" in record && typeof record.height === "number" && Number.isInteger(record.height) && record.height > 0 && record.height <= 1000) {
        this.options.onScreen?.(data, record.width, record.height, "full" in record && record.full === true);
      }
      if (data) this.options.onFrame(data);
    } else if (record.type === "terminal.closed") {
      this.ended = true;
      this.flush();
      this.options.onEnd("reason" in record && typeof record.reason === "string" ? record.reason : undefined);
    }
  }
}

export interface PaneWatchOptions extends WatchStreamOptions {
  paneId: string;
  cols: number;
  rows: number;
  /** The same socket the bridge's RPCs use, not the CLI's default session. */
  socketPath: string;
  killGraceMs?: number;
}

const STDERR_TAIL_CHARS = 4096;
/**
 * Its exit is waited for: a pane's next view starts after it, and its place among a connection's watches is its
 * until then (core/connections.ts), so one that ignored the request would hold both for good.
 */
const KILL_GRACE_MS = 1_000;

/** A read-only viewport; unlike terminal attach it never owns the pane's size. */
export class PaneWatch {
  readonly exited: Promise<void>;
  private readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private killed = false;
  private ended = false;
  /** the process itself has exited; a child of its own may still hold its pipes open */
  private gone = false;
  private killer: ReturnType<typeof setTimeout> | undefined;
  private readonly readers: Array<{ cancel(): Promise<void> }> = [];
  private stderrTail = "";

  constructor(private readonly options: PaneWatchOptions) {
    this.proc = Bun.spawn(
      [process.env["OVIS_HERDR_BIN"] || "herdr", "terminal", "session", "observe", options.paneId,
        "--cols", String(options.cols), "--rows", String(options.rows)],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_SOCKET_PATH: options.socketPath } },
    );
    const parser = new WatchStreamParser({
      onFrame: (data) => {
        if (!this.killed && !this.ended) options.onFrame(data);
      },
      onEnd: () => {
        this.end();
        this.stopChild();
      },
    });
    // Drain both pipes before reporting the exit of a process that ended by itself: the last frame and
    // failure diagnostics can arrive after the process-exit notification. One asked to end, or whose
    // terminal closed, has nothing more to say: its exit is its process's own, whoever still holds its
    // pipes (a launcher that does not `exec` leaves its child holding them for as long as that runs).
    const drained = Promise.all([this.readStdout(parser), this.readStderr()]);
    this.exited = this.proc.exited.then(async (code) => {
      clearTimeout(this.killer);
      this.gone = true;
      if (this.killed || this.ended) this.dropOutput();
      await drained;
      if (!this.killed && !this.ended && code !== 0) {
        console.warn(`[watch] ${options.paneId} exited (${code}): ${this.stderrTail.trim()}`);
      }
      this.end();
    });
  }

  private dropOutput(): void {
    for (const reader of this.readers) {
      try { void reader.cancel().catch(() => {}); } catch {}
    }
  }

  private async readStdout(parser: WatchStreamParser): Promise<void> {
    const reader = this.proc.stdout.getReader();
    this.readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.killed) parser.push(decoder.decode(value, { stream: true }));
      }
      if (!this.killed) {
        parser.push(decoder.decode());
        parser.finish();
      }
    } catch (error) {
      if (!this.killed && !this.ended) {
        console.warn(`[watch] ${this.options.paneId} stdout failed: ${error instanceof Error ? error.message : String(error)}`);
        this.stopChild();
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    this.readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_CHARS);
      }
      this.stderrTail = (this.stderrTail + decoder.decode()).slice(-STDERR_TAIL_CHARS);
    } catch {
    } finally {
      reader.releaseLock();
    }
  }

  private end(): void {
    if (this.killed || this.ended) return;
    this.ended = true;
    this.options.onEnd();
  }

  private stopChild(): void {
    if (this.gone) return;
    try { this.proc.kill(); } catch {}
    if (this.killer) return;
    this.killer = setTimeout(() => {
      try { this.proc.kill("SIGKILL"); } catch {}
    }, this.options.killGraceMs ?? KILL_GRACE_MS);
    this.killer.unref?.();
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (this.gone) this.dropOutput();
    this.stopChild();
  }
}
