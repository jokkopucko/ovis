/** hc writes an attach's history replay in 16 KiB frames under 5 ms apart: a gap this long ends it */
export const ATTACH_BATCH_QUIET_MS = 15;
/** the longest an attach's first output is held: a program that prints all along never leaves a gap */
export const ATTACH_BATCH_MAX_MS = 150;
// Even 6x JSON escaping is only 240 KiB: below the 256 KiB watermark and 1 MiB legacy relay limit,
// and one ACK can arrive in 7.5 s at 32 KiB/s, before the shared pane's 10 s pause limit.
const ATTACH_FRAME_BYTES = 40 * 1024;

/**
 * Holds a herdr-core attach's first output (the cleared screen and the history hc replays) until hc goes quiet,
 * and passes it on as one frame. Sent frame by frame, a viewer draws the history between them: the pane is seen
 * scrolling down through it on every switch, instead of opening at its newest rows. Output past the first gap
 * goes on as it comes. Long replays are split into bounded frames.
 */
export class AttachBatch {
  private held: string[] = [];
  private bytes = 0;
  private state: "holding" | "streaming" | "closed" = "holding";
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly forward: (data: string) => void) {}

  push(data: string, fromCore = true): void {
    if (this.state === "closed") return;
    const size = Buffer.byteLength(data);
    if (this.state === "streaming" && size <= ATTACH_FRAME_BYTES) {
      this.forward(data);
      return;
    }
    if (this.bytes + size <= ATTACH_FRAME_BYTES) {
      this.held.push(data);
      this.bytes += size;
    } else {
      const bytes = Buffer.from(data);
      let start = 0;
      while (bytes.length - start > ATTACH_FRAME_BYTES - this.bytes) {
        let end = start + ATTACH_FRAME_BYTES - this.bytes;
        // The next frame must start at a UTF-8 character boundary.
        while ((bytes.readUInt8(end) & 0xc0) === 0x80) end--;
        if (end > start) this.held.push(bytes.toString("utf8", start, end));
        this.flush();
        start = end;
      }
      if (this.state !== "holding") {
        if (this.state === "streaming") this.forward(bytes.toString("utf8", start));
        return;
      }
      this.held.push(bytes.toString("utf8", start));
      this.bytes += bytes.length - start;
    }
    if (this.bytes === ATTACH_FRAME_BYTES) this.flush();
    if (this.state === "holding") {
      this.deadline ??= setTimeout(() => this.end(), ATTACH_BATCH_MAX_MS);
      if (fromCore) {
        clearTimeout(this.quiet);
        this.quiet = setTimeout(() => this.end(), ATTACH_BATCH_QUIET_MS);
      }
    }
  }

  /** passes on what is held, and everything after it as it comes (the attach ended, or hc went quiet) */
  end(): void {
    if (this.state === "closed") return;
    this.state = "streaming";
    this.clearTimers();
    this.flush();
  }

  cancel(): void {
    this.state = "closed";
    this.clearTimers();
    this.held = [];
    this.bytes = 0;
  }

  private clearTimers(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.deadline);
  }

  flush(): void {
    if (this.held.length === 0) return;
    const data = this.held.join("");
    this.held = [];
    this.bytes = 0;
    this.forward(data);
  }
}
