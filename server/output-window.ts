// Count UTF-8 payload bytes, not JSON framing or UTF-16 string length. A fresh
// subscription id keeps delayed callbacks from acknowledging a later attach.
export const OUTPUT_HIGH_BYTES = 256 * 1024;
export const OUTPUT_LOW_BYTES = 64 * 1024;
export const OUTPUT_HARD_BYTES = 1024 * 1024;
/** how long a blocked client may go without its ACKs moving before it is closed with 4008 */
export const OUTPUT_STALL_MS = 2000;
/** the slowest link a joiner's replay is given time for: 32 KiB/s, about 256 kbit/s */
export const OUTPUT_JOIN_BYTES_PER_SECOND = 32 * 1024;
/** the longest a joiner may take to acknowledge its replay */
export const OUTPUT_JOIN_MAX_MS = 15_000;
/**
 * The longest one client may hold the shared pty paused, however it acknowledges: a client
 * that ACKs a byte at a time (or a slow phone) would otherwise cap every peer at its own rate.
 * Draining 192 KiB from the high to the low watermark takes 6 s at the join rate above.
 */
export const OUTPUT_PAUSE_MAX_MS = 10_000;

/**
 * What a frame carrying `text` costs on the wire: JSON escapes every control byte, so an ESC
 * becomes six. Flow credit still counts payload bytes; this only sizes time budgets.
 */
export function wireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

/** What the server does about one client: keep sending, pause the shared pty for it, or close it (4008). */
export type OutputVerdict = "flow" | "pause" | "stop";

export class OutputWindow {
  readonly id = crypto.randomUUID();
  sent = 0;
  acknowledged = 0;
  blocked = false;
  /** when the client last became blocked without its ACKs moving since */
  private stalledSince: number | undefined;
  /** when the client last started holding the shared pty paused, ACKs or not */
  private pausingSince: number | undefined;
  /** a joiner's replay is in flight and nothing is acknowledged yet: its budget ends here */
  joinUntil: number | undefined;
  /** frames sent and not yet acknowledged, oldest first from `head`: where each ends and its size on the wire */
  private readonly inFlight: { end: number; wire: number }[] = [];
  private head = 0;

  get pending(): number { return this.sent - this.acknowledged; }

  /**
   * `wire` is the frame's serialized size (`wireBytes`): the oldest unacknowledged frame must
   * cross the link before its ACK can come, so the stall deadline grows by its crossing time.
   */
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
    // Duplicate and out-of-order ACKs cannot release credit twice, nor restart the stall clock.
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
   * before then.
   */
  check(buffered: number, now = Date.now(), large = 0): OutputVerdict {
    if (buffered >= OUTPUT_HARD_BYTES) return "stop";
    if (!this.blocked && (buffered < OUTPUT_HIGH_BYTES || this.pending <= OUTPUT_LOW_BYTES)) {
      this.stalledSince = undefined;
      this.pausingSince = undefined;
      return "flow";
    }
    this.stalledSince ??= now;
    if (this.joinUntil !== undefined) {
      // within its budget a joiner holds only its own window up (bounded by OUTPUT_HARD_BYTES)
      if (now < this.joinUntil) return "flow";
      // past it the joiner is an ordinary client: one blocked through its budget with nothing
      // acknowledged is out of time, one that only now became blocked gets the usual deadline
      this.joinUntil = undefined;
    }
    this.pausingSince ??= now;
    // `large`: frames past the budget still queued on the socket, a session's snapshot (#2573). Output behind
    // one cannot be acknowledged before it has crossed, whenever it was queued, so the stall clock starts once
    // it is gone; the frame's own deadline (connections.ts `expire`) answers for a client that stops reading.
    // The pane is still paused, and for no longer than any client may hold the shared pty paused.
    if (large > 0) {
      this.stalledSince = undefined;
      return now - this.pausingSince >= OUTPUT_PAUSE_MAX_MS ? "stop" : "pause";
    }
    const oldest = this.inFlight[this.head];
    const deadline = OUTPUT_STALL_MS + (oldest ? Math.min(OUTPUT_JOIN_MAX_MS - OUTPUT_STALL_MS, crossingMs(oldest.wire)) : 0);
    return now - this.stalledSince >= deadline || now - this.pausingSince >= OUTPUT_PAUSE_MAX_MS ? "stop" : "pause";
  }
}

/** how long `wire` bytes take on the slowest link a budget allows for */
export function crossingMs(wire: number): number {
  return Math.ceil(wire * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
}

/** DEC private mode switches (CSI ? Pm h / CSI ? Pm l): alternate screen, mouse reporting, ... */
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;
/** xterm's modifyOtherKeys: CSI > 4 ; level m, off with CSI > 4 m, CSI > 4 n, or a bare CSI > m / CSI > n (every resource reset) */
const MODIFY_OTHER_KEYS = /\x1b\[>(4(?:;(\d*))?)?([mn])/g;
/** An ESC, or a CSI still missing its final byte. */
const INCOMPLETE_CSI = /^\x1b(\[[\x30-\x3f]*[\x20-\x2f]*)?$/;

/**
 * What a client joining a live attachment is sent: the bounded tail of the stream,
 * led by the private modes set by output that has already fallen out of it.
 *
 * `herdr terminal attach` switches the alternate screen and mouse reporting on once,
 * at the start of the stream. A busy pane pushes that start out of the tail, and a
 * late joiner (a phone opening a pane a desktop tab holds) then got a terminal with
 * mouse reporting off: xterm turns a wheel there into arrow keys, so scrolling walked
 * the agent's prompt history instead of herdr's scrollback. A program's modifyOtherKeys
 * request is passed on the same way, once: without it the joiner sends Ctrl+Enter as Enter.
 */
export class ReplayBuffer {
  private tail = "";
  /**
   * Each mode's last switch in the output before the tail, in the order of those last
   * switches: order matters (1016l after 1006h leaves xterm's mouse encoding at the default).
   */
  private readonly modes = new Map<string, "h" | "l">();
  /** the modifyOtherKeys level the output before the tail left, 0 when off */
  private modifyOtherKeys = 0;
  /**
   * Output has fallen out of the tail. Until then the tail is the whole stream, herdr's first
   * full draw included; after it a diff-based stream's tail may miss what was drawn only once.
   */
  truncated = false;

  constructor(private readonly limit: number) {}

  /** Keeps a bounded UTF-8 tail, never starting in the middle of a code point. */
  append(data: string): void {
    const bytes = Buffer.from(this.tail + data);
    let start = Math.max(0, bytes.length - this.limit);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    // never cut a control sequence in two: its switch would be lost to both halves
    const escape = start > 0 ? bytes.lastIndexOf(0x1b, start - 1) : -1;
    if (escape >= 0 && INCOMPLETE_CSI.test(bytes.subarray(escape, start).toString("latin1"))) start = escape;
    if (start === 0) {
      this.tail += data;
      return;
    }
    this.truncated = true;
    const cut = bytes.subarray(0, start).toString("utf8");
    for (const [, params, state] of cut.matchAll(PRIVATE_MODES)) {
      for (const mode of params!.split(";").filter(Boolean)) {
        this.modes.delete(mode);
        this.modes.set(mode, state as "h" | "l");
      }
    }
    for (const [, resource, level, final] of cut.matchAll(MODIFY_OTHER_KEYS)) this.modifyOtherKeys = resource && final === "m" ? Number(level || 0) : 0;
    this.tail = bytes.subarray(start).toString("utf8");
  }

  /** The stream as seen by a client joining now. Empty until the pane has written anything. */
  text(): string {
    if (!this.tail) return "";
    const keys = this.modifyOtherKeys > 0 ? `\x1b[>4;${this.modifyOtherKeys}m` : "";
    return [...this.modes].map(([mode, state]) => `\x1b[?${mode}${state}`).join("") + keys + this.tail;
  }

  /** whether the output before the tail left the alternate screen on: the tail starts on it */
  get alternateScreen(): boolean {
    return this.modes.get("1049") === "h";
  }

  /** The raw tail, for matching herdr's own error text. */
  get recent(): string {
    return this.tail;
  }
}
