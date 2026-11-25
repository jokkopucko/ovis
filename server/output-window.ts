// A fresh subscription id keeps delayed callbacks from acknowledging a later attach.
export const OUTPUT_HIGH_BYTES = 256 * 1024;
export const OUTPUT_LOW_BYTES = 64 * 1024;
export const OUTPUT_HARD_BYTES = 1024 * 1024;
export const OUTPUT_STALL_MS = 2000;
const ALT_SCREEN_MODE = "1049";
/** the slowest link a joiner's replay is given time for: 32 KiB/s, about 256 kbit/s */
export const OUTPUT_JOIN_BYTES_PER_SECOND = 32 * 1024;
export const OUTPUT_JOIN_MAX_MS = 15_000;
/**
 * The longest one client may hold the shared pty paused, however it acknowledges: a client
 * that ACKs a byte at a time (or a slow phone) would otherwise cap every peer at its own rate.
 * Draining 192 KiB from the high to the low watermark takes 6 s at the join rate above.
 */
export const OUTPUT_PAUSE_MAX_MS = 10_000;
/**
 * The same bound for a client that is the pane's only viewer: holding the pty paused then slows
 * no one but itself, and a slow phone parsing a burst of wide text (Korean, emoji) still ACKs
 * well past 10 s. It stays a fixed bound, so a client acknowledging a byte at a time still ends.
 */
export const OUTPUT_PAUSE_ALONE_MAX_MS = 60_000;

/**
 * What a frame carrying `text` costs on the wire: JSON escapes every control byte, so an ESC
 * becomes six. Flow credit still counts payload bytes; this only sizes time budgets.
 */
export function wireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

export type OutputVerdict = "flow" | "pause" | "stop";

export class OutputWindow {
  readonly id = crypto.randomUUID();
  sent = 0;
  acknowledged = 0;
  blocked = false;
  private stalledSince: number | undefined;
  private pausingSince: number | undefined;
  joinUntil: number | undefined;
  private readonly inFlight: { end: number; wire: number }[] = [];
  private head = 0;

  get pending(): number { return this.sent - this.acknowledged; }

  write(bytes: number, wire = 0): number {
    this.sent += bytes;
    if (wire > 0) this.inFlight.push({ end: this.sent, wire });
    if (this.pending >= OUTPUT_HIGH_BYTES) this.blocked = true;
    return this.sent;
  }

  /**
   * A late joiner is about to be sent `bytes` of replay. Its first ACK can only come once the
   * whole frame has crossed the link and been parsed, which takes a phone on a weak link longer
   * than the stall deadline (moshi-3): until that ACK, the client gets a budget sized to the
   * frame as serialized (`wireBytes`) instead, and is never a reason to pause the pty the other
   * clients share. `ahead` is what the socket already has queued in front of the frame (on a
   * reconnect every attached pane's replay goes out back to back): it crosses the link first.
   * `large` is a frame past the transport budget queued in front as well, a large session's
   * snapshot (#2566): its crossing time is added beyond the cap.
   */
  join(replay: string, ahead = 0, now = Date.now(), large = 0): void {
    this.joinUntil = now + Math.min(OUTPUT_JOIN_MAX_MS, OUTPUT_STALL_MS + crossingMs(ahead + wireBytes(replay))) + crossingMs(large);
  }

  acknowledge(id: string, offset: number): boolean {
    if (id !== this.id || !Number.isSafeInteger(offset) || offset < 0 || offset > this.sent) return false;
    if (offset > this.acknowledged) {
      this.acknowledged = offset;
      this.stalledSince = undefined;
      this.joinUntil = undefined;
      while (this.head < this.inFlight.length && this.inFlight[this.head]!.end <= offset) this.head++;
      if (this.head > 64 && this.head * 2 > this.inFlight.length) {
        this.inFlight.splice(0, this.head);
        this.head = 0;
      }
    }
    if (this.pending <= OUTPUT_LOW_BYTES) this.blocked = false;
    return true;
  }

  /**
   * Stalls are measured by ACK progress, not by the time since a frame was queued: a client
   * that is still acknowledging is draining, however much it has in flight. `buffered` is the
   * client's WebSocket send queue, which blocks it as well, unless this window has next to
   * nothing outstanding: the queue is shared by every pane on the socket, and a pane with
   * nothing to acknowledge can make no ACK progress, so another pane's backlog must not pause
   * or stop it (that pane's own window answers for it). The deadline is OUTPUT_STALL_MS plus
   * the time the oldest unacknowledged frame needs to cross a slow link: its ACK cannot come
   * before then. `alone`: no other client shares the pty, so a pause holds back no peer.
   */
  check(buffered: number, now = Date.now(), large = 0, alone = false): OutputVerdict {
    const pauseMax = alone ? OUTPUT_PAUSE_ALONE_MAX_MS : OUTPUT_PAUSE_MAX_MS;
    if (buffered >= OUTPUT_HARD_BYTES) return "stop";
    if (!this.blocked && (buffered < OUTPUT_HIGH_BYTES || this.pending <= OUTPUT_LOW_BYTES)) {
      this.stalledSince = undefined;
      this.pausingSince = undefined;
      return "flow";
    }
    this.stalledSince ??= now;
    if (this.joinUntil !== undefined) {
      if (now < this.joinUntil) return "flow";
      this.joinUntil = undefined;
    }
    this.pausingSince ??= now;
    if (large > 0) {
      this.stalledSince = undefined;
      return now - this.pausingSince >= pauseMax ? "stop" : "pause";
    }
    const oldest = this.inFlight[this.head];
    const deadline = OUTPUT_STALL_MS + (oldest ? Math.min(OUTPUT_JOIN_MAX_MS - OUTPUT_STALL_MS, crossingMs(oldest.wire)) : 0);
    return now - this.stalledSince >= deadline || now - this.pausingSince >= pauseMax ? "stop" : "pause";
  }
}

export function crossingMs(wire: number): number {
  return Math.ceil(wire * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
}

/** DEC private mode switches (CSI ? Pm h / CSI ? Pm l): alternate screen, mouse reporting, ... */
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;
/** xterm's modifyOtherKeys: CSI > 4 ; level m, off with CSI > 4 m, CSI > 4 n, or a bare CSI > m / CSI > n (every resource reset) */
const MODIFY_OTHER_KEYS = /\x1b\[>(4(?:;(\d*))?)?([mn])/g;
const INCOMPLETE_CSI = /^\x1b(\[[\x30-\x3f]*[\x20-\x2f]*)?$/;

/**
 * `herdr terminal attach` switches the alternate screen and mouse reporting on once,
 * at the start of the stream. A busy pane pushes that start out of the tail, and a
 * late joiner (a phone opening a pane a desktop tab holds) then got a terminal with
 * mouse reporting off: xterm turns a wheel there into arrow keys, so scrolling walked
 * the agent's prompt history instead of herdr's scrollback. A program's modifyOtherKeys
 * request is passed on the same way, once: without it the joiner sends Ctrl+Enter as Enter.
 */
export class ReplayBuffer {
  /**
   * The tail as UTF-8 at `bytes[start, end)`: an append encodes only its own output and a cut
   * decodes only what falls out: re-encoding a whole string tail on every append was the server's
   * largest CPU cost under busy agents. The output arrives from a streaming TextDecoder, so the
   * round trip loses nothing.
   */
  private bytes = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  /** order matters: 1016l after 1006h leaves xterm's mouse encoding at the default */
  private readonly modes = new Map<string, "h" | "l">();
  private modifyOtherKeys = 0;
  /**
   * Output has fallen out of the tail. Until then the tail is the whole stream, herdr's first
   * full draw included; after it a diff-based stream's tail may miss what was drawn only once.
   */
  truncated = false;

  constructor(private readonly limit: number) {}

  append(data: string): void {
    const size = Buffer.byteLength(data);
    if (this.end + size > this.bytes.length) {
      // twice what is held: the next copy comes only after about as much output again
      this.move(2 * (this.end - this.start + size));
    }
    this.end += this.bytes.write(data, this.end);
    const bytes = this.bytes;
    let start = Math.max(this.start, this.end - this.limit);
    while (start < this.end && (bytes[start]! & 0xc0) === 0x80) start++;
    // never cut a control sequence in two: its switch would be lost to both halves
    const escape = start > this.start ? bytes.subarray(this.start, start).lastIndexOf(0x1b) : -1;
    if (escape >= 0 && INCOMPLETE_CSI.test(bytes.toString("latin1", this.start + escape, start))) start = this.start + escape;
    if (start === this.start) return;
    this.truncated = true;
    const cut = bytes.toString("utf8", this.start, start);
    for (const [, params, state] of cut.matchAll(PRIVATE_MODES)) {
      for (const mode of params!.split(";").filter(Boolean)) {
        // Never restore ?2026h across a cut (it would pair with a retained ?2026l to settle a partial screen),
        // and never record an unmatched ?2026l (herdr-core's attach reset) on a stream that never used ?2026h.
        if (mode === "2026") {
          if (state === "h") {
            this.modes.delete(mode);
            this.modes.set(mode, "l");
          }
          continue;
        }
        this.modes.delete(mode);
        this.modes.set(mode, state as "h" | "l");
      }
    }
    for (const [, resource, level, final] of cut.matchAll(MODIFY_OTHER_KEYS)) this.modifyOtherKeys = resource && final === "m" ? Number(level || 0) : 0;
    this.start = start;
    // a burst far past the limit grew the buffer for itself: keep only room for what is left
    const kept = Math.max(this.limit, this.end - this.start);
    if (this.bytes.length > 4 * kept) this.move(2 * kept);
  }

  private move(capacity: number): void {
    const next = Buffer.allocUnsafe(capacity);
    this.end = this.bytes.copy(next, 0, this.start, this.end);
    this.start = 0;
    this.bytes = next;
  }

  text(): string {
    if (this.start === this.end) return "";
    const keys = this.modifyOtherKeys > 0 ? `\x1b[>4;${this.modifyOtherKeys}m` : "";
    return [...this.modes].map(([mode, state]) => `\x1b[?${mode}${state}`).join("") + keys + this.recent;
  }

  get alternateScreen(): boolean {
    return this.modes.get(ALT_SCREEN_MODE) === "h";
  }

  get recent(): string {
    return this.bytes.toString("utf8", this.start, this.end);
  }
}
