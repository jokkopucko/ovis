import { authenticatedWebSocket } from "./remote-websocket.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { MachineManager } from "./machines.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { LARGE_REPLY_BYTES } from "./herdr/client.ts";

/**
 * The browser's socket as the core hands it over (connections.ts `relayClient`): `send` holds it to this PC's
 * transport budget and closes it past that, and `getBufferedAmount` is what counts against it, without what is
 * left of a large frame still draining (#2573), which `large` tells.
 */
interface RelayClient {
  send(data: string): number;
  getBufferedAmount(): number;
  large?(): number;
  close(code?: number, reason?: string): void;
}

/**
 * The relay's backstop against its own sockets backing up, with this PC's rule (reconcileOutput):
 * blocked only while OUTPUT_HIGH_BYTES or more is queued, closed after OUTPUT_STALL_MS of that.
 * A slow phone link keeps a few KB queued in userspace while output still moves, so any byte
 * must not count. The end-to-end ACK window is enforced by the remote bridge. A stall closes
 * with 4008 like this PC's: an overload is never auto-replayed. Returns the close code, or 0.
 */
export class RelayStallClock {
  private blockedAt: number | null = null;

  sample(buffered: number, now: number): number {
    if (buffered > OUTPUT_HARD_BYTES) return OUTPUT_STALLED_CLOSE_CODE;
    if (buffered < OUTPUT_HIGH_BYTES) this.blockedAt = null;
    else if (this.blockedAt === null) this.blockedAt = now;
    return this.blockedAt !== null && now - this.blockedAt >= OUTPUT_STALL_MS ? OUTPUT_STALLED_CLOSE_CODE : 0;
  }
}

/** The phone sees an upstream 4008 as is (the remote bridge's ACK window stalled); any other end is 1012. */
export function upstreamCloseCode(code: number): number {
  return code === OUTPUT_STALLED_CLOSE_CODE ? code : 1012;
}

/** Relay ACK frames unchanged: only xterm parsing releases remote output credit. */
export class MachineRelay {
  private upstream: WebSocket;
  private client?: RelayClient;
  private waiting: string[] = [];
  private bytes = 0;
  /** what waits of frames larger than the budget, a large session's snapshot (#2573): held to herdr's largest reply */
  private large = 0;
  private closed = false;
  private untrack: () => void;
  private timer: ReturnType<typeof setInterval>;
  private stall = new RelayStallClock();
  readonly ready: Promise<void>;

  /**
   * `browserSnapshot`: the PC's snapshot frame as the browser is told it, without the token values this
   * server's sidebar rows hide (#2160). Other frames pass as they came.
   */
  constructor(manager: MachineManager, id: string, private readonly readOnly: boolean, private readonly browserSnapshot: (snapshot: SessionSnapshot) => SessionSnapshot) {
    const endpoint = manager.endpoint(id);
    if (!endpoint) throw new Error("This PC is disconnected");
    this.upstream = authenticatedWebSocket(endpoint.url.replace("http:", "ws:") + "/ws", endpoint.token);
    this.untrack = manager.trackTerminal(id, () => this.close(1012, "PC disconnected"));
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.close(); reject(new Error("Remote websocket timed out")); }, 15_000);
      this.upstream.addEventListener("open", () => {
        if (this.readOnly) this.upstream.send(JSON.stringify({ type: "role", mode: "observe" }));
        clearTimeout(timeout); resolve();
      }, { once: true });
      this.upstream.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Remote websocket unavailable")); this.close(); }, { once: true });
      this.upstream.addEventListener("close", () => { clearTimeout(timeout); reject(new Error("Remote websocket closed")); }, { once: true });
    });
    this.upstream.onmessage = (event) => {
      const raw = this.told(String(event.data));
      if (this.closed) return;
      if (!this.client) {
        // a frame larger than the budget waits apart, as the browser's socket excuses it (connections.ts `send`)
        const bytes = Buffer.byteLength(raw);
        if (bytes > OUTPUT_HARD_BYTES) this.large += bytes; else this.bytes += bytes;
        if (this.bytes > OUTPUT_HARD_BYTES || this.large > LARGE_REPLY_BYTES) this.close(OUTPUT_STALLED_CLOSE_CODE, "output overflow");
        else this.waiting.push(raw);
      } else this.send(raw);
    };
    this.upstream.onclose = (event) => this.close(upstreamCloseCode(event.code), event.reason || "Remote connection ended");
    this.timer = setInterval(() => this.tick(), 100);
    this.timer.unref();
  }
  /**
   * A frame as the browser is told it: a frame that names `tokens` anywhere is read, whatever its key
   * order, and a snapshot among them re-written where a value leaves; the rest pass unread.
   */
  private told(raw: string): string {
    if (!raw.includes('"tokens"')) return raw;
    let message: ServerMessage;
    try { message = JSON.parse(raw) as ServerMessage; } catch { return raw; }
    if (message.type !== "snapshot") return raw;
    const snapshot = this.browserSnapshot(message.snapshot);
    return snapshot === message.snapshot ? raw : JSON.stringify({ ...message, snapshot });
  }
  /** One stall-clock sample of both sockets' queues; the 100 ms timer calls it, and tests inject `now`. */
  tick(now = Date.now()): void {
    if (this.closed) return;
    // what queues behind a large frame still draining cannot move before it: that frame's own deadline answers for it
    const client = this.client?.large?.() ? 0 : this.client?.getBufferedAmount() ?? 0;
    const buffered = Math.max(client, this.upstream.bufferedAmount);
    const code = this.stall.sample(buffered, now);
    if (code) this.close(code, "terminal transport stalled");
  }
  bind(client: RelayClient): void {
    this.client = client;
    if (this.closed) { client.close(1012, "Remote connection ended"); return; }
    for (const raw of this.waiting) this.send(raw);
    this.waiting = []; this.bytes = 0; this.large = 0;
  }
  private send(raw: string): void {
    if (this.closed || !this.client) return;
    if (this.client.send(raw) === 0) this.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
  }
  message(raw: string | Buffer): void {
    if (this.closed) return;
    if (this.upstream.readyState !== WebSocket.OPEN) { this.close(); return; }
    let text = String(raw);
    try {
      const message = JSON.parse(text);
      if (message?.type === "attach") {
        // Receipt resumption is local-only: the shared bridge token carries no trusted
        // origin-device namespace, so forwarding a browser UUID would cross devices.
        delete message.receipt_resume_id;
        text = JSON.stringify(message);
      } else if (this.readOnly && message?.type === "role") {
        text = JSON.stringify({ type: "role", mode: "observe" });
      }
    } catch { /* malformed frames are answered by the upstream server */ }
    if (this.upstream.bufferedAmount + Buffer.byteLength(text) > OUTPUT_HARD_BYTES) { this.close(OUTPUT_STALLED_CLOSE_CODE, "input overflow"); return; }
    this.upstream.send(text);
  }
  close(code = 1000, reason = "Closed"): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.untrack();
    this.waiting = []; this.bytes = 0; this.large = 0;
    const boundedReason = Buffer.from(reason).subarray(0, 100).toString("utf8");
    this.upstream.close(code, boundedReason); this.client?.close(code, boundedReason);
  }
}
