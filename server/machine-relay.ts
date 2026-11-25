import { createHmac, randomBytes } from "node:crypto";
import { RECEIPT_RESUME_ID } from "../shared/receipt-resume.ts";
import { authenticatedWebSocket } from "./remote-websocket.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { MachineManager } from "./machines.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { LARGE_REPLY_BYTES } from "./herdr/client.ts";

const SERVICE_RESTART_CLOSE_CODE = 1012;

/** Unlinkable receipt identities for one connection server lifetime; no browser-controlled namespace crosses PCs or devices. */
export class RelayReceiptIds {
  private readonly key = randomBytes(32);

  /**
   * Returns an opaque UUID stable for this server, PC, authenticated device and browser UUID.
   * Invalid browser UUIDs return undefined; restarting the server invalidates derived identities.
   */
  scope(machine: string, device: string | undefined, browser: string): string | undefined {
    if (!RECEIPT_RESUME_ID.test(browser)) return undefined;
    const digest = createHmac("sha256", this.key).update(JSON.stringify([machine, device ?? null, browser])).digest();
    digest[6] = (digest[6]! & 0x0f) | 0x40;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

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
  return code === OUTPUT_STALLED_CLOSE_CODE ? code : SERVICE_RESTART_CLOSE_CODE;
}

export class MachineRelay {
  private upstream: WebSocket;
  private client?: RelayClient;
  private waiting: string[] = [];
  private bytes = 0;
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
  constructor(manager: MachineManager, id: string, private readonly readOnly: boolean, private readonly browserSnapshot: (snapshot: SessionSnapshot) => SessionSnapshot,
    private readonly receiptId?: (browser: string) => string | undefined, browser?: string) {
    const endpoint = manager.endpoint(id);
    if (!endpoint) throw new Error("This PC is disconnected");
    const target = new URL(endpoint.url.replace("http:", "ws:") + "/ws");
    const scoped = !readOnly && browser ? receiptId?.(browser) : undefined;
    if (scoped) target.searchParams.set("receipt_resume_id", scoped);
    this.upstream = authenticatedWebSocket(target.href, endpoint.token);
    this.untrack = manager.trackTerminal(id, () => this.close(SERVICE_RESTART_CLOSE_CODE, "PC disconnected"));
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
   * order, and a snapshot among them re-written where a value leaves; a watch-only browser's features frame
   * leaves its `paste_dir`; the rest pass unread.
   */
  private told(raw: string): string {
    const pasteDir = this.readOnly && raw.includes('"paste_dir"');
    if (!raw.includes('"tokens"') && !pasteDir) return raw;
    let message: ServerMessage;
    try { message = JSON.parse(raw) as ServerMessage; } catch { return raw; }
    // a watch-only browser is not told the PC's upload folder (server/core/socket.ts), whatever its bridge says
    if (message.type === "features" && pasteDir) { const { paste_dir: _folder, ...features } = message; return JSON.stringify(features); }
    if (message.type !== "snapshot") return raw;
    const snapshot = this.browserSnapshot(message.snapshot);
    return snapshot === message.snapshot ? raw : JSON.stringify({ ...message, snapshot });
  }
  tick(now = Date.now()): void {
    if (this.closed) return;
    const client = this.client?.large?.() ? 0 : this.client?.getBufferedAmount() ?? 0;
    const buffered = Math.max(client, this.upstream.bufferedAmount);
    const code = this.stall.sample(buffered, now);
    if (code) this.close(code, "terminal transport stalled");
  }
  bind(client: RelayClient): void {
    this.client = client;
    if (this.closed) { client.close(SERVICE_RESTART_CLOSE_CODE, "Remote connection ended"); return; }
    for (const raw of this.waiting) this.send(raw);
    this.waiting = []; this.bytes = 0; this.large = 0;
  }
  private send(raw: string): void {
    if (this.closed || !this.client) return;
    if (this.client.send(raw) === 0) this.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
  }
  /**
   * Forwards browser frames with scoped resume IDs only for controlling attachments; raw browser
   * resume IDs and observer resume IDs are stripped. Malformed frames remain upstream's responsibility.
   */
  message(raw: string | Buffer): void {
    if (this.closed) return;
    if (this.upstream.readyState !== WebSocket.OPEN) { this.close(); return; }
    let text = String(raw);
    try {
      const message = JSON.parse(text);
      if (message?.type === "attach") {
        // The bridge authenticates this server's shared token, not the browser's device.
        // Only controlling clients receive a server-scoped receipt identity.
        const id = !this.readOnly && typeof message.receipt_resume_id === "string" ? this.receiptId?.(message.receipt_resume_id) : undefined;
        if (id) message.receipt_resume_id = id;
        else delete message.receipt_resume_id;
        text = JSON.stringify(message);
      } else if (this.readOnly && message?.type === "role") {
        text = JSON.stringify({ type: "role", mode: "observe" });
      }
    } catch {}
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
