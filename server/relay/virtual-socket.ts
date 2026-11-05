import type { WsStream } from "../../shared/relay-mux-engine.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import type { createCore, SocketData } from "../core/index.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_LOW_BYTES } from "../output-window.ts";

export type RelaySocketHandlers = ReturnType<typeof createCore>["socketHandlers"];
type SocketLike = Parameters<RelaySocketHandlers["open"]>[0];

/** One logical socket, never the carrier's queue. RECEIVED is not CREDIT or a terminal ACK. */
export class VirtualSocket implements SocketLike {
  private closing = false;
  private ended = false;
  private detached = false;
  private aboveLow = false;
  readonly closed: Promise<void>;

  constructor(readonly data: SocketData, private readonly stream: WsStream, private readonly handlers: RelaySocketHandlers) {
    const closed = Promise.withResolvers<void>();
    this.closed = closed.promise;
    stream.onClose = ({ code, reason }) => {
      this.ended = true;
      this.detach(code, reason);
      closed.resolve();
    };
    // As on a native socket, the peer's CLOSE ends the connection once the messages before it
    // were handed over: input still waiting to be typed then goes nowhere.
    stream.onPeerClose = ({ code, reason }) => this.detach(code, reason);
    // Handed over without waiting for the last one's handling, as a native socket does: a role
    // change must reach the core before a key still in flight is typed. A local close, unlike
    // the peer's drain, has already detached the core and must accept no more input.
    stream.onMessage = (message) => {
      if (this.closing || this.detached || !stream.live) return;
      void Promise.resolve(handlers.message(this, typeof message === "string" ? message : Buffer.from(message)))
        .catch(() => { if (stream.live) stream.reset("internal_error"); });
    };
  }

  /** The peer closed, and the messages it sent before that are still being handed over. */
  private get peerDraining(): boolean {
    return this.stream.closedByPeer && !this.closing && !this.detached && !this.ended && this.stream.live;
  }

  get readyState(): number {
    if (this.ended || !this.stream.live) return WebSocket.CLOSED;
    // A native socket is still open while it hands over the messages before the peer's close.
    if (this.peerDraining) return WebSocket.OPEN;
    if (this.closing || this.stream.endedIn || this.stream.endedOut) return WebSocket.CLOSING;
    return this.stream.accepted ? WebSocket.OPEN : WebSocket.CONNECTING;
  }

  open(): void {
    this.stream.accept();
    // Like native sockets, messages need not wait for open's asynchronous snapshot.
    void Promise.resolve(this.handlers.open(this)).catch(() => this.stream.reset("internal_error"));
  }

  send(text: string): number {
    // A reply to such a message: the peer, which closed, would read it before the close, and
    // our close went out already. Never 0, which the core takes for a stalled socket and closes.
    if (this.peerDraining) return Buffer.byteLength(text);
    if (this.readyState !== WebSocket.OPEN) return 0;
    const bytes = Buffer.byteLength(text);
    if (this.getBufferedAmount() + bytes > OUTPUT_HARD_BYTES) {
      this.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
      return 0;
    }
    this.stream.send(text);
    if (!this.stream.live) return 0;
    this.aboveLow ||= this.getBufferedAmount() >= OUTPUT_LOW_BYTES;
    // WsStream accepted the entire message. -1 is already queued, never a retry request.
    return this.stream.queuedBytes > 0 ? -1 : bytes;
  }

  getBufferedAmount(): number {
    return this.stream.getBufferedAmount();
  }

  /** Called after mux receive: only a peer receipt can reduce queued + in-flight bytes. */
  drain(): void {
    if (this.readyState !== WebSocket.OPEN || !this.aboveLow || this.getBufferedAmount() >= OUTPUT_LOW_BYTES) return;
    this.aboveLow = false;
    this.handlers.drain(this);
  }

  close(code = 1000, reason = ""): void {
    if (this.closing || this.ended || this.detached || !this.stream.live) return;
    this.closing = true;
    // MachineRelay maps upstream disappearance to 1012 on native sockets. Mux carries RESET.
    if (code === 1006 || code === 1012 && this.data.relay) this.stream.reset("upstream_lost");
    else this.stream.close(code, reason, code === OUTPUT_STALLED_CLOSE_CODE);
    // A last client's attachment must not wait for the peer's CLOSE response.
    this.detach(code, reason);
  }

  private detach(code: number, reason: string): void {
    if (this.detached) return;
    this.detached = true;
    this.handlers.close(this, code, reason);
  }
}
