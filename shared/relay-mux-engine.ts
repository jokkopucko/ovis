import {
  decodeFrame, encodeFrame, FrameType, HTTP_END_FLAGS, LIMITS_V1, MAX_FRAME_BYTES,
  MuxProtocolError, WS_CONTINUATION_CAPACITY, WS_DATA_FLAGS, WS_START_CAPACITY,
} from "./relay-mux.ts";
import type { HeaderList, LimitsV1, MuxFrame, SessionError, StreamError } from "./relay-mux.ts";

type Payload<T extends MuxFrame["type"]> = Extract<MuxFrame, { type: T }>["payload"];
export type HttpRequest = Payload<typeof FrameType.HTTP_OPEN>;
export type HttpResponse = Payload<typeof FrameType.HTTP_HEADERS>;
export type WsRequest = Payload<typeof FrameType.WS_OPEN>;
export type SessionFrame = Extract<MuxFrame, { type: 1 | 2 | 3 | 4 | 10 }>;
type Traffic = "interactive" | "bulk" | "control";
type CancelTimer = () => void;
const U64_MAX = 0xffffffffffffffffn;
const KiB = 1024;
const MiB = 1024 * KiB;
// See docs/relay-mux-limits.md: >= 5 MB/s at 50 ms RTT, with 24 KiB kept for
// interactive records and an independent control reserve. Only RECEIVED releases flight.
export const MUX_FLIGHT = { ordinary: 408 * KiB, bulk: 384 * KiB, control: 16 * KiB, total: 424 * KiB } as const;
// Reserve before admitting streams; even counting reservations AND their payloads, the worst
// accounted total is 2 * 12 MiB + 4 MiB + 1 MiB + 64 KiB + 424 KiB < 32 MiB.
export const MUX_RECEIVE_RESERVATION_BYTES = 12 * MiB;
const QUEUE = { outgoing: 4 * MiB, nonterminal: 3 * MiB, metadata: MiB, control: 64 * KiB } as const;

export interface MuxClock {
  now(): number;
  /** The adapter owns platform timers; returning the cancellation function also works in browsers. */
  setTimeout(callback: () => void, milliseconds: number): CancelTimer;
}

export interface MuxOptions {
  readonly role: "client" | "server";
  readonly send: (frame: Uint8Array) => Promise<void>;
  readonly close: (code: number) => void;
  readonly clock: MuxClock;
  readonly outboundWireByteLength: (frame: Uint8Array) => number;
  readonly routingOverhead: number;
  readonly maxWireMessageBytes: number;
  readonly limits?: LimitsV1;
  readonly onHttp?: (stream: HttpStream) => void;
  readonly onWs?: (stream: WsStream) => void;
  /** Negotiation and device-key verification belong to the session adapter, not this engine. */
  readonly onSession?: (frame: SessionFrame) => void;
  readonly onClose?: (error: MuxProtocolError) => void;
  /** The HTTP adapter supplies its route policy, including slow machine operations and SSE. */
  readonly requestTimeoutMs?: (request: HttpRequest) => number;
  /** Server adapters may drop untrusted identity headers, after syntax and size validation. */
  readonly filterRequestHeaders?: boolean;
}

export class MuxStreamError extends Error {
  constructor(readonly code: StreamError, message: string = code) {
    super(message);
    this.name = "MuxStreamError";
  }
}

function check(condition: unknown, message: string, code: SessionError = "protocol_error"): asserts condition {
  if (!condition) throw new MuxProtocolError(code, message);
}
function add64(value: bigint, amount: number | bigint): bigint {
  const next = value + BigInt(amount);
  check(next <= U64_MAX, "Counter overflow", "flow_control_error");
  return next;
}
function contentLength(headers: HeaderList): bigint | undefined {
  const value = headers.find(([name]) => name === "content-length")?.[1];
  return value === undefined ? undefined : BigInt(value);
}
function isSse(headers: HeaderList): boolean {
  return headers.some(([name, value]) => name === "content-type" && value.split(";")[0]?.trim().toLowerCase() === "text/event-stream");
}
function classify(request: HttpRequest | WsRequest): "interactive" | "bulk" {
  const path = request.target.split("?")[0];
  return path?.startsWith("/ws") || ("method" in request && request.method === "GET" && path === "/api/machines/events")
    ? "interactive" : "bulk";
}

// All state below is per-channel mutable accounting. No counter or queue survives carrierLost().
interface Entry {
  readonly bytes: Uint8Array;
  readonly type: MuxFrame["type"];
  readonly owner?: MuxStream;
  readonly traffic: Traffic;
  readonly payloadBytes: number;
  readonly wire: number;
  readonly committed?: () => void;
  readonly failed?: (error: MuxStreamError) => void;
}
interface Flight {
  readonly through: bigint;
  readonly traffic: Traffic;
  readonly wire: number;
  readonly owner?: MuxStream;
  readonly payloadBytes: number;
}

class Bucket {
  private tokens: number;
  private updated: number;
  constructor(private readonly rate: number, private readonly burst: number, clock: MuxClock) {
    this.tokens = burst;
    this.updated = clock.now();
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.updated) * this.rate / 1000);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

abstract class MuxStream {
  id: number | undefined;
  readonly generation: number;
  readonly traffic: "interactive" | "bulk";
  readonly terminal: boolean;
  readonly queue: Entry[] = [];
  sent = 0n;
  peerConsumed = 0n;
  received = 0n;
  consumed = 0n;
  granted = 0n;
  sendWindow = 0;
  receiveWindow = 0;
  queuedBytes = 0;
  flightBytes = 0;
  inboundBytes = 0;
  pendingInbound = 0;
  metadataBytes = 0;
  reservation = 0;
  endedOut = false;
  endedIn = false;
  cancelled = false;
  retired = false;
  cleanupStarted = false;
  cleanupPending = 0;
  blockedTimer: CancelTimer | undefined;
  routeTimer: CancelTimer | undefined;
  /** Adapters abort their Request, detach backends and cancel subscriptions here. */
  onDispose: ((error?: MuxStreamError) => void | Promise<void>) | undefined;

  constructor(readonly engine: MuxEngine, readonly request: HttpRequest | WsRequest) {
    this.generation = engine.generation;
    this.traffic = classify(request);
    this.terminal = request.target.split("?")[0]?.startsWith("/ws") ?? false;
  }
  get live(): boolean {
    return !this.cancelled && !this.retired && this.engine.generation === this.generation && this.engine.active;
  }
  getBufferedAmount(): number { return this.queuedBytes + this.flightBytes; }
  reset(code: StreamError = "cancelled"): void { this.engine.reset(this, code); }
  abstract fail(error: MuxStreamError): void;
}

/**
 * Request-like metadata and an inbound body; write/end produce the opposite direction.
 * On clients body is the response; on servers body is the request. HWM zero is deliberate:
 * CREDIT is returned only by a pending read, never by ReadableStream prefetch.
 */
export class HttpStream extends MuxStream {
  declare readonly request: HttpRequest;
  readonly body: ReadableStream<Uint8Array>;
  response: HttpResponse | undefined;
  trailers: HeaderList = [];
  onHeaders: ((response: HttpResponse) => void) | undefined;
  onUploadStopped: (() => void) | undefined;
  accepted = false;
  stopped = false;
  endQueued = false;
  final = false;
  informational = 0;
  noBody = false;
  outgoingLength = 0n;
  incomingLength: bigint | undefined;
  expectedOutgoing: bigint | undefined;
  sse = false;
  private readonly chunks: Uint8Array[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readPending: (() => void) | undefined;
  private bodyClosed = false;
  private source: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(engine: MuxEngine, request: HttpRequest) {
    super(engine, request);
    const server = engine.options.role === "server";
    this.sendWindow = server ? LIMITS_V1.http_window_bytes : 0;
    this.receiveWindow = server ? 0 : LIMITS_V1.http_window_bytes;
    this.incomingLength = server ? contentLength(request.headers) : undefined;
    this.expectedOutgoing = server ? undefined : contentLength(request.headers);
    this.endedIn = server && request.body === "none";
    this.endedOut = !server && request.body === "none";
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      pull: () => new Promise<void>((resolve) => { this.readPending = resolve; this.deliver(); }),
      cancel: () => { this.bodyClosed = true; this.reset(); },
    }, { highWaterMark: 0 });
    if (this.endedIn) this.finishBody();
  }
  accept(): void {
    check(this.engine.options.role === "server" && this.request.body === "stream" && !this.accepted && !this.stopped, "Invalid HTTP_ACCEPT");
    if (!this.live) return;
    this.accepted = true;
    this.engine.enqueue(this, { type: FrameType.HTTP_ACCEPT, flags: 0, stream_id: this.id ?? 1, payload: null }, () => {
      this.receiveWindow = LIMITS_V1.http_window_bytes;
    });
  }
  headers(status: number, headers: HeaderList = []): void {
    check(this.engine.options.role === "server" && !this.final, "Invalid response headers");
    if (!this.live) return;
    const frame: MuxFrame = { type: FrameType.HTTP_HEADERS, flags: 0, stream_id: this.id ?? 1, payload: { status, headers } };
    encodeFrame(frame);
    if (status < 200) {
      check(++this.informational <= 8, "Too many informational responses");
    } else {
      this.final = true;
      this.noBody = this.request.method === "HEAD" || [204, 205, 304].includes(status);
      this.expectedOutgoing = this.request.method === "HEAD" || status === 304 ? undefined : contentLength(headers);
      if (isSse(headers) && !this.engine.admitSse(this)) return;
    }
    this.engine.enqueue(this, frame);
  }
  write(bytes: Uint8Array): Promise<void> {
    if (!this.live || this.stopped && this.engine.options.role === "client") return Promise.reject(new MuxStreamError("cancelled"));
    check(!this.endQueued && !this.endedOut && !this.noBody && bytes.length > 0, "Invalid HTTP body write");
    check(this.engine.options.role === "client" || this.final, "Body before response headers");
    if (!this.engine.canQueue(this, bytes.length)) {
      this.reset("resource_exhausted");
      return Promise.reject(new MuxStreamError("resource_exhausted"));
    }
    this.outgoingLength = add64(this.outgoingLength, bytes.length);
    const writes: Promise<void>[] = [];
    for (let offset = 0; offset < bytes.length; offset += WS_CONTINUATION_CAPACITY) {
      const data = bytes.subarray(offset, offset + WS_CONTINUATION_CAPACITY);
      writes.push(new Promise<void>((resolve, reject) => {
        this.engine.enqueue(this, { type: FrameType.HTTP_DATA, flags: 0, stream_id: this.id ?? 1, payload: data }, resolve, reject);
      }));
    }
    return Promise.all(writes).then(() => undefined);
  }
  async sendBody(body: ReadableStream<Uint8Array>): Promise<void> {
    check(!this.source, "Body producer already attached");
    const reader = body.getReader();
    this.source = reader;
    const uploadStopped = () => this.engine.options.role === "client" && this.stopped;
    try {
      while (this.live && !uploadStopped()) {
        const result = await reader.read();
        if (!this.live || uploadStopped()) return;
        if (result.done) { this.end(); return; }
        if (result.value.length) await this.write(result.value);
      }
    } catch (error) {
      if (this.live && !uploadStopped()) this.reset("internal_error");
      throw error;
    } finally {
      reader.releaseLock();
      if (this.source === reader) this.source = undefined;
    }
  }
  end(trailers: HeaderList = []): void {
    if (!this.live || this.endedOut || this.endQueued) return;
    check(this.engine.options.role === "client" || this.final, "END before final headers");
    if (this.expectedOutgoing !== undefined && this.outgoingLength !== this.expectedOutgoing
      && !(this.stopped && this.engine.options.role === "client")) {
      this.reset("stream_protocol_error");
      return;
    }
    if (this.engine.options.role === "server" && !this.endedIn) this.stopRequest();
    this.endQueued = true;
    this.engine.enqueue(this, { type: FrameType.HTTP_END, flags: 0, stream_id: this.id ?? 1, payload: { trailers } }, () => {
      this.endedOut = true;
      this.engine.retire(this);
    });
  }
  stopRequest(): void {
    check(this.engine.options.role === "server", "Only server stops requests");
    if (!this.live || this.stopped || this.endedIn) return;
    this.stopped = true;
    this.engine.dropAcceptance(this);
    this.failBody(new MuxStreamError("cancelled"));
    this.engine.enqueueControl({ type: FrameType.HTTP_STOP_REQUEST, flags: 0, stream_id: this.id ?? 1, payload: null }, this);
  }
  stopUpload(): void {
    this.stopped = true;
    // The response body is still being read, so its CREDIT must survive.
    this.engine.dropQueue(this, new MuxStreamError("cancelled"), false);
    this.cancelSource();
    this.onUploadStopped?.();
    if (this.endedOut) return; // A normal END already committed may cross STOP.
    this.endQueued = true;
    this.engine.enqueue(this, {
      type: FrameType.HTTP_END, flags: HTTP_END_FLAGS.STOPPED, stream_id: this.id ?? 1, payload: { trailers: [] },
    }, () => { this.endedOut = true; this.engine.retire(this); });
  }
  receiveData(data: Uint8Array): void {
    if (this.stopped && this.engine.options.role === "server") return;
    this.chunks.push(data.slice());
    this.inboundBytes += data.length;
    this.deliver();
  }
  finishBody(): void {
    this.deliver();
    this.engine.retire(this);
  }
  private deliver(): void {
    const chunk = this.readPending ? this.chunks.shift() : undefined;
    if (chunk) {
      this.inboundBytes -= chunk.length;
      this.controller?.enqueue(chunk);
      this.engine.consume(this, chunk.length);
      this.readPending?.();
      this.readPending = undefined;
    }
    if (this.endedIn && !this.chunks.length && !this.bodyClosed) {
      this.bodyClosed = true;
      this.controller?.close();
      this.readPending?.();
      this.readPending = undefined;
      this.engine.retire(this);
    }
  }
  private failBody(error: MuxStreamError): void {
    this.chunks.length = 0;
    this.inboundBytes = 0;
    if (!this.bodyClosed) this.controller?.error(error);
    this.bodyClosed = true;
    this.readPending?.();
    this.readPending = undefined;
  }
  private cancelSource(): void {
    const reader = this.source;
    if (reader) {
      // Cancellation is cleanup, not a resend opportunity. Keep the reservation until it settles.
      this.engine.cleanup(this, reader.cancel(new MuxStreamError("cancelled")));
    }
  }
  fail(error: MuxStreamError): void {
    this.failBody(error);
    this.cancelSource();
  }
}

export interface WsClose {
  readonly code: number;
  readonly reason: string;
  readonly clean: boolean;
}

export class WsStream extends MuxStream {
  declare readonly request: WsRequest;
  accepted = false;
  rejection: HttpStream | undefined;
  onAccept: ((protocol: string | null, headers: HeaderList) => void) | undefined;
  onClose: ((event: WsClose) => void) | undefined;
  /** The peer's graceful CLOSE arrived and every message before it was handled; onClose still follows. */
  onPeerClose: ((event: Omit<WsClose, "clean">) => void) | undefined;
  private handler: ((message: string | Uint8Array) => void | Promise<void>) | undefined;
  private readonly messages: { data: string | Uint8Array; bytes: number }[] = [];
  private delivering = false;
  private assembling: { data: Uint8Array; offset: number; text: boolean } | undefined;
  private closing: Payload<typeof FrameType.WS_CLOSE> | undefined;
  private receivedClose: Payload<typeof FrameType.WS_CLOSE> | undefined;
  private notified = false;
  private peerNotified = false;
  private peerFirst = false;
  private closeTimer: CancelTimer | undefined;

  set onMessage(handler: ((message: string | Uint8Array) => void | Promise<void>) | undefined) {
    this.handler = handler;
    this.deliver();
  }
  get onMessage(): ((message: string | Uint8Array) => void | Promise<void>) | undefined { return this.handler; }
  accept(protocol: string | null = null, headers: HeaderList = []): void {
    check(this.engine.options.role === "server" && !this.accepted && !this.rejection, "Invalid WS_ACCEPT");
    check(protocol === null || this.request.protocols.includes(protocol), "Unoffered WS protocol");
    if (!this.live) return;
    this.accepted = true;
    this.sendWindow = LIMITS_V1.ws_window_bytes;
    this.engine.enqueue(this, { type: FrameType.WS_ACCEPT, flags: 0, stream_id: this.id ?? 1, payload: { protocol, headers } }, () => {
      this.receiveWindow = LIMITS_V1.ws_window_bytes;
    });
  }
  reject(status: number, headers: HeaderList = []): HttpStream {
    check(this.engine.options.role === "server" && !this.accepted && !this.rejection && status >= 200, "Invalid WS rejection");
    const http = this.engine.rejectWs(this);
    http.headers(status, headers);
    return http;
  }
  /** Accepted once, even if still queued. Never retry this message based on this return value. */
  send(message: string | Uint8Array): number {
    if (!this.live || this.closing || this.rejection) throw new MuxStreamError("cancelled");
    if (message.length > LIMITS_V1.max_ws_message_bytes) { this.close(1009, "message too large", true); return 0; }
    const data = typeof message === "string" ? new TextEncoder().encode(message) : message;
    if (data.length > LIMITS_V1.max_ws_message_bytes) {
      this.close(1009, "message too large", true);
      return 0;
    }
    if (!this.engine.canQueue(this, data.length)) { this.reset("resource_exhausted"); return 0; }
    let offset = 0;
    do {
      const start = offset === 0;
      const size = Math.min(data.length - offset, start ? WS_START_CAPACITY : WS_CONTINUATION_CAPACITY);
      const end = offset + size === data.length;
      this.engine.enqueue(this, {
        type: FrameType.WS_DATA, stream_id: this.id ?? 1,
        flags: (start ? WS_DATA_FLAGS.START : 0) | (end ? WS_DATA_FLAGS.END : 0) | (start && typeof message === "string" ? WS_DATA_FLAGS.TEXT : 0),
        payload: { data: data.subarray(offset, offset + size), ...(start ? { total_message_bytes: data.length } : {}) },
      });
      offset += size;
    } while (offset < data.length);
    return this.getBufferedAmount();
  }
  receiveFragment(frame: Extract<MuxFrame, { type: typeof FrameType.WS_DATA }>): void {
    if (this.endedIn || this.rejection || !this.accepted) { this.reset("stream_protocol_error"); return; }
    if (frame.flags & WS_DATA_FLAGS.START) {
      if (this.assembling) { this.reset("stream_protocol_error"); return; }
      const length = frame.payload.total_message_bytes;
      if (length === undefined) { this.reset("stream_protocol_error"); return; }
      this.assembling = { data: new Uint8Array(length), offset: 0, text: !!(frame.flags & WS_DATA_FLAGS.TEXT) };
    }
    const message = this.assembling;
    if (!message || message.offset + frame.payload.data.length > message.data.length) {
      this.reset("stream_protocol_error"); return;
    }
    message.data.set(frame.payload.data, message.offset);
    message.offset += frame.payload.data.length;
    this.inboundBytes += frame.payload.data.length;
    if (!!(frame.flags & WS_DATA_FLAGS.END) !== (message.offset === message.data.length)) {
      this.reset("stream_protocol_error"); return;
    }
    if (!(frame.flags & WS_DATA_FLAGS.END)) return;
    this.assembling = undefined;
    let data: string | Uint8Array = message.data;
    if (message.text) {
      try { data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        this.close(1007, "invalid UTF-8", true);
        return;
      }
    }
    // Zero-length messages still own queue entries. Bound those independently of DATA credit.
    if (!this.engine.retainMetadata(this, 8)) return;
    this.pendingInbound++;
    this.messages.push({ data, bytes: message.offset });
    this.deliver();
  }
  private deliver(): void {
    if (this.delivering || !this.handler || !this.live) return;
    const message = this.messages.shift();
    if (!message) return;
    this.delivering = true;
    let result: void | Promise<void>;
    try { result = this.handler(message.data); }
    catch (error) { this.reset("internal_error"); return; }
    Promise.resolve(result).then(() => {
      if (!this.live || this.closing?.abort || this.receivedClose?.abort) return;
      this.delivering = false;
      this.inboundBytes -= message.bytes;
      this.pendingInbound--;
      this.engine.releaseMetadata(this, 8);
      this.engine.consume(this, message.bytes);
      this.peerClosed();
      this.finishClose();
      this.deliver();
    }, () => { if (this.live) this.reset("internal_error"); });
  }
  close(code: number | null = 1000, reason = "", abort = false): void {
    if (!this.live || this.closing && !abort) return;
    const payload = { code, reason, abort };
    encodeFrame({ type: FrameType.WS_CLOSE, flags: 0, stream_id: this.id ?? 1, payload });
    this.closing = payload;
    this.closeTimer?.();
    if (abort) {
      this.engine.dropQueue(this, new MuxStreamError("cancelled"));
      this.discardIncoming();
      this.endedIn = true;
      this.notify(payload, false);
      this.engine.dispose(this, new MuxStreamError("cancelled"));
      if (this.id === undefined) { this.reset(); return; }
      this.engine.enqueueControl({ type: FrameType.WS_CLOSE, flags: 0, stream_id: this.id, payload }, this, () => this.closeSent());
    } else {
      this.engine.enqueue(this, { type: FrameType.WS_CLOSE, flags: 0, stream_id: this.id ?? 1, payload }, () => this.closeSent());
      this.closeTimer = this.engine.timer(() => this.close(code, reason, true), 5000);
    }
  }
  receiveClose(payload: Payload<typeof FrameType.WS_CLOSE>): void {
    if (this.receivedClose) { this.reset("stream_protocol_error"); return; }
    this.receivedClose = payload;
    this.peerFirst = !this.closing && !payload.abort;
    this.endedIn = true;
    if (payload.abort) {
      this.discardIncoming();
      this.notify(payload, false);
    } else if (this.assembling) {
      this.reset("stream_protocol_error");
      return;
    }
    if (!this.closing || payload.abort && !this.endedOut) this.close(payload.code, payload.reason, payload.abort);
    this.peerClosed();
    if (this.endedOut) {
      this.closeTimer?.();
      this.finishClose();
    }
  }
  private closeSent(): void {
    this.endedOut = true;
    this.closeTimer?.();
    if (this.endedIn) {
      this.finishClose();
    } else this.closeTimer = this.engine.timer(() => this.reset("upstream_lost"), 5000);
  }
  /** The peer closed gracefully before this side did: messages it sent before that may still be handed over. */
  get closedByPeer(): boolean { return this.peerFirst; }
  private peerClosed(): void {
    if (!this.receivedClose || this.receivedClose.abort || this.pendingInbound || this.peerNotified || !this.live) return;
    this.peerNotified = true;
    this.onPeerClose?.({ code: this.receivedClose.code ?? 1005, reason: this.receivedClose.reason });
  }
  private finishClose(): void {
    if (!this.endedIn || !this.endedOut || this.pendingInbound) return;
    this.notify(this.receivedClose ?? this.closing, !this.closing?.abort && !this.receivedClose?.abort);
    this.engine.retire(this);
  }
  private notify(payload: Payload<typeof FrameType.WS_CLOSE> | undefined, clean: boolean): void {
    if (this.notified) return;
    this.notified = true;
    this.onClose?.({ code: payload ? payload.code ?? 1005 : 1006, reason: payload?.reason ?? "", clean });
  }
  private discardIncoming(): void {
    this.assembling = undefined;
    this.messages.length = 0;
    this.inboundBytes = 0;
    this.pendingInbound = 0;
  }
  fail(): void {
    this.closeTimer?.();
    this.discardIncoming();
    this.notify(this.receivedClose ?? (this.closing?.abort ? this.closing : undefined), false);
  }
}

export class MuxEngine {
  readonly limits: LimitsV1;
  /** Local admission can resume only after retirement releases the receive reservation. */
  onStreamAvailable: (() => void) | undefined;
  generation = 0;
  private state: "active" | "failing" | "closed" = "active";
  private deviceId: string | undefined;
  private lastOpenId = 0;
  private goaway = false;
  private readonly streams = new Set<MuxStream>();
  private readonly urgent: Entry[] = [];
  private readonly ledger: Flight[] = [];
  private readonly timers = new Map<CancelTimer, { pause: () => void; resume: () => void }>();
  private readonly openBucket: Bucket;
  private readonly frameBucket: Bucket;
  private submitted = 0n;
  private acknowledged = 0n;
  private receivedFrames = 0n;
  private receiptSent = 0n;
  private ordinaryFlight = 0;
  private bulkFlight = 0;
  private controlFlight = 0;
  private queued = 0;
  private nonterminalQueued = 0;
  private metadata = 0;
  private controlQueued = 0;
  private reserved = 0;
  private urgentBurst = 0;
  private cycle = 0;
  private readonly cursor = { interactive: 0, bulk: 0 };
  private sending = false;
  private scheduled = false;
  private readonly idleWaiters: (() => void)[] = [];
  private fatal: MuxProtocolError | undefined;
  private setupTimer: CancelTimer;
  private idleTimer: CancelTimer | undefined;
  private probeTimer: CancelTimer | undefined;
  private probe: bigint | undefined;
  private hidden = false;

  constructor(readonly options: MuxOptions) {
    this.limits = options.limits ?? LIMITS_V1;
    for (const key of ["max_streams", "max_ws_streams", "max_sse_streams"] as const) {
      check(Number.isInteger(this.limits[key]) && this.limits[key] > 0 && this.limits[key] <= LIMITS_V1[key], "Invalid concurrency limit");
    }
    const largest = options.outboundWireByteLength(new Uint8Array(MAX_FRAME_BYTES)) + options.routingOverhead;
    check(Number.isSafeInteger(largest) && largest >= MAX_FRAME_BYTES && largest <= MUX_FLIGHT.ordinary - MUX_FLIGHT.bulk
      && largest <= options.maxWireMessageBytes, "Transport cannot carry a maximum frame", "unsupported_transport");
    this.openBucket = new Bucket(32, 64, options.clock);
    this.frameBucket = new Bucket(4096, 8192, options.clock);
    this.setupTimer = this.timer(() => this.fail("timeout", "Mux setup timed out"), 10_000);
  }
  get active(): boolean { return this.state === "active"; }
  /** Wait for the ordered sender to become idle (which may mean credit-blocked, not delivered). */
  flush(): Promise<void> {
    if (this.state === "closed" || !this.sending && !this.scheduled) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }
  get senderIdle(): boolean { return this.state === "closed" || !this.sending && !this.scheduled; }
  get stats() {
    let inbound = 0;
    for (const stream of this.streams) inbound += stream.inboundBytes;
    return {
      streams: this.streams.size, lastOpenId: this.lastOpenId, queuedBytes: this.queued,
      nonterminalQueuedBytes: this.nonterminalQueued, metadataBytes: this.metadata,
      controlQueuedBytes: this.controlQueued, reservedBytes: this.reserved, inboundBytes: inbound,
      ordinaryFlightBytes: this.ordinaryFlight, bulkFlightBytes: this.bulkFlight, controlFlightBytes: this.controlFlight,
      submitted: this.submitted, acknowledged: this.acknowledged, receivedFrames: this.receivedFrames,
      bufferedBytes: this.queued + this.metadata + this.controlQueued + inbound + this.ordinaryFlight + this.controlFlight,
      // With fixed windows/concurrency this conservative count is below 32 MiB, including
      // a reservation as well as each counted inbound payload. Retained backing stores are
      // intentionally not counted (the plan's narrower payload/queue accounting contract).
      accountedBytes: this.reserved + this.queued + this.metadata + this.controlQueued + inbound + this.ordinaryFlight + this.controlFlight,
    };
  }
  /** Called once, only after the session layer verified AUTH/PAIR and AUTH_OK. */
  authenticate(deviceId: string): void {
    check(this.active && this.deviceId === undefined && /^[0-9a-f]{16}$/.test(deviceId), "Invalid authentication transition");
    this.deviceId = deviceId;
    this.setupTimer();
    this.refreshIdle();
  }
  sendSession(frame: SessionFrame): void {
    check(this.active && this.deviceId === undefined, "Session setup already ended");
    const clientFrame = frame.type === FrameType.HELLO || frame.type === FrameType.AUTH || frame.type === FrameType.PAIR;
    check(clientFrame === (this.options.role === "client"), "Wrong setup direction");
    this.enqueueControl(frame);
  }
  openHttp(request: Omit<HttpRequest, "device_id">): HttpStream {
    const metadata = { ...request, device_id: this.openDevice() };
    const frame: MuxFrame = { type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: metadata };
    const bytes = encodeFrame(frame);
    const stream = new HttpStream(this, metadata);
    if (!this.admit(stream, bytes.length)) throw new MuxStreamError("refused");
    this.enqueue(stream, frame);
    return stream;
  }
  openWs(request: Omit<WsRequest, "device_id">): WsStream {
    const metadata = { ...request, device_id: this.openDevice() };
    const frame: MuxFrame = { type: FrameType.WS_OPEN, flags: 0, stream_id: 1, payload: metadata };
    const bytes = encodeFrame(frame);
    const stream = new WsStream(this, metadata);
    if (!this.admit(stream, bytes.length)) throw new MuxStreamError("refused");
    this.enqueue(stream, frame);
    return stream;
  }
  private openDevice(): string {
    check(this.active && !this.goaway && this.options.role === "client" && this.deviceId !== undefined, "Cannot open a stream");
    return this.deviceId;
  }
  timer(callback: () => void, ms: number): CancelTimer {
    const generation = this.generation;
    let remaining = ms;
    let deadline = 0;
    let cancel: CancelTimer | undefined;
    const stop = () => { cancel?.(); this.timers.delete(stop); };
    const resume = () => {
      deadline = this.options.clock.now() + remaining;
      cancel = this.options.clock.setTimeout(() => {
        this.timers.delete(stop);
        if (this.generation === generation && this.state !== "closed") callback();
      }, remaining);
    };
    this.timers.set(stop, {
      pause: () => {
        if (cancel) remaining = Math.max(0, deadline - this.options.clock.now());
        cancel?.();
        cancel = undefined;
      },
      resume,
    });
    if (!this.hidden) resume();
    return stop;
  }
  private admit(stream: MuxStream, metadata: number): boolean {
    const ws = stream instanceof WsStream;
    const sse = stream instanceof HttpStream && stream.request.method === "GET" && stream.request.target.split("?")[0] === "/api/machines/events";
    const reservation = ws ? LIMITS_V1.ws_window_bytes : LIMITS_V1.http_window_bytes;
    if (this.streams.size >= this.limits.max_streams
      || ws && [...this.streams].filter((s) => s instanceof WsStream).length >= this.limits.max_ws_streams
      || sse && [...this.streams].filter((s) => s instanceof HttpStream && s.sse).length >= this.limits.max_sse_streams
      || this.metadata + metadata > QUEUE.metadata || this.reserved + reservation > MUX_RECEIVE_RESERVATION_BYTES) return false;
    this.streams.add(stream);
    stream.reservation = reservation;
    this.reserved += reservation;
    this.retainMetadata(stream, metadata);
    if (stream instanceof HttpStream) {
      stream.sse = sse;
      this.touch(stream);
    }
    return true;
  }
  private touch(stream: MuxStream): void {
    if (!(stream instanceof HttpStream) || stream.sse || !stream.live) return;
    stream.routeTimer?.();
    const timeout = this.options.requestTimeoutMs?.(stream.request)
      ?? (stream.request.target.split("?")[0] === "/api/machines/events" ? 0 : 60_000);
    if (timeout > 0) stream.routeTimer = this.timer(() => this.reset(stream, "upstream_lost"), timeout);
  }
  admitSse(stream: HttpStream): boolean {
    if (stream.sse) return true;
    if ([...this.streams].filter((s) => s instanceof HttpStream && s.sse).length >= this.limits.max_sse_streams) {
      this.reset(stream, "refused");
      return false;
    }
    stream.sse = true;
    stream.routeTimer?.();
    return true;
  }
  retainMetadata(stream: MuxStream, bytes: number): boolean {
    if (this.metadata + bytes > QUEUE.metadata) { this.reset(stream, "resource_exhausted"); return false; }
    stream.metadataBytes += bytes;
    this.metadata += bytes;
    return true;
  }
  releaseMetadata(stream: MuxStream, bytes: number): void {
    stream.metadataBytes -= bytes;
    this.metadata -= bytes;
  }
  canQueue(stream: MuxStream, bytes: number): boolean {
    return this.queued + bytes <= QUEUE.outgoing && (stream.terminal || this.nonterminalQueued + bytes <= QUEUE.nonterminal);
  }
  private entry(frame: MuxFrame, traffic: Traffic, owner?: MuxStream, committed?: () => void, failed?: Entry["failed"]): Entry {
    const bytes = encodeFrame(frame);
    const payloadBytes = frame.type === FrameType.HTTP_DATA ? frame.payload.length : frame.type === FrameType.WS_DATA ? frame.payload.data.length : 0;
    const wire = this.options.outboundWireByteLength(bytes) + this.options.routingOverhead;
    check(Number.isSafeInteger(wire) && wire >= bytes.length && wire <= this.options.maxWireMessageBytes, "Invalid wire cost", "unsupported_transport");
    return { bytes, type: frame.type, owner, traffic, payloadBytes, wire, committed, failed };
  }
  enqueue(stream: MuxStream, frame: MuxFrame, committed?: () => void, failed?: Entry["failed"]): void {
    if (!stream.live) { failed?.(new MuxStreamError("cancelled")); return; }
    const entry = this.entry(frame, frame.type === FrameType.WS_CLOSE ? "control" : stream.traffic, stream, committed, failed);
    const metadata = entry.bytes.length - entry.payloadBytes;
    if (!this.canQueue(stream, entry.payloadBytes) || !this.retainMetadata(stream, metadata)) {
      failed?.(new MuxStreamError("resource_exhausted"));
      this.reset(stream, "resource_exhausted");
      return;
    }
    stream.queue.push(entry);
    this.queued += entry.payloadBytes;
    stream.queuedBytes += entry.payloadBytes;
    if (!stream.terminal) this.nonterminalQueued += entry.payloadBytes;
    this.kick();
  }
  enqueueControl(frame: MuxFrame, stream?: MuxStream, committed?: () => void): void {
    if (!this.active) return;
    const entry = this.entry(frame, "control", stream, committed);
    // Coalesce consumption reports; duplicate CREDIT is not useful work.
    const previous = frame.type === FrameType.CREDIT
      ? this.urgent.findIndex((item) => item.type === frame.type && item.owner === stream) : -1;
    if (previous >= 0) {
      const old = this.urgent.splice(previous, 1)[0];
      if (old) this.controlQueued -= old.bytes.length;
    }
    if (this.controlQueued + entry.bytes.length > QUEUE.control) { this.fail("resource_exhausted", "Control queue exhausted"); return; }
    this.urgent.push(entry);
    this.controlQueued += entry.bytes.length;
    this.kick();
  }
  private kick(): void {
    if (this.scheduled || this.sending || this.state === "closed") return;
    this.scheduled = true;
    Promise.resolve().then(() => { this.scheduled = false; return this.pump(); });
  }
  private fits(entry: Entry): boolean {
    if (entry.traffic === "control") return this.controlFlight + entry.wire <= MUX_FLIGHT.control;
    return this.ordinaryFlight + entry.wire <= MUX_FLIGHT.ordinary
      && (entry.traffic !== "bulk" || this.bulkFlight + entry.wire <= MUX_FLIGHT.bulk);
  }
  private eligible(stream: MuxStream, entry: Entry): boolean {
    if (stream instanceof HttpStream && this.options.role === "client"
      && entry.type !== FrameType.HTTP_OPEN && !stream.accepted && !stream.stopped) return false;
    if (stream instanceof WsStream && entry.type === FrameType.WS_DATA && !stream.accepted) return false;
    if (entry.payloadBytes > 0) {
      const blocked = stream.sent - stream.peerConsumed + BigInt(entry.payloadBytes) > BigInt(stream.sendWindow);
      if (blocked) {
        stream.blockedTimer ??= this.timer(() => this.reset(stream, "slow_consumer"), 30_000);
        return false;
      }
    }
    return this.fits(entry);
  }
  private ordinary(): Entry | undefined {
    const preferred = this.cycle === 4 ? "bulk" : "interactive";
    for (const traffic of [preferred, preferred === "bulk" ? "interactive" : "bulk"] as const) {
      const streams = [...this.streams].filter((stream) => stream.traffic === traffic && stream.live);
      for (let i = 0; i < streams.length; i++) {
        const index = (this.cursor[traffic] + i) % streams.length;
        const stream = streams[index];
        const entry = stream?.queue[0];
        if (stream && entry && entry.traffic !== "control" && this.eligible(stream, entry)) {
          this.cursor[traffic] = (index + 1) % streams.length;
          this.cycle = (this.cycle + 1) % 5;
          stream.queue.shift();
          this.releaseEntry(entry);
          return entry;
        }
      }
    }
    return undefined;
  }
  private select(): Entry | undefined {
    const urgentIndex = this.urgent.findIndex((entry) => this.fits(entry));
    const urgent = this.urgent[urgentIndex];
    // Graceful CLOSE is urgent only once all previously accepted messages have drained.
    const closing = [...this.streams].find((s) => s.queue[0]?.traffic === "control" && this.fits(s.queue[0]));
    const receipt = this.receivedFrames > this.receiptSent;
    if (this.urgentBurst < 8 || ![...this.streams].some((s) => s.queue[0] && s.queue[0].traffic !== "control" && this.eligible(s, s.queue[0]))) {
      if (receipt) {
        this.receiptSent = this.receivedFrames;
        this.urgentBurst++;
        return this.entry({ type: FrameType.RECEIVED, flags: 0, stream_id: 0, payload: this.receiptSent }, "control");
      }
      if (urgent && this.fits(urgent)) {
        this.urgent.splice(urgentIndex, 1);
        this.controlQueued -= urgent.bytes.length;
        this.urgentBurst++;
        return urgent;
      }
      if (closing) {
        const entry = closing.queue.shift();
        if (entry) {
          this.releaseEntry(entry);
          this.urgentBurst++;
          return entry;
        }
      }
    }
    const ordinary = this.ordinary();
    if (ordinary) this.urgentBurst = 0;
    return ordinary;
  }
  private async pump(): Promise<void> {
    if (this.sending || this.state === "closed") return;
    this.sending = true;
    const generation = this.generation;
    try {
      while (this.generation === generation) {
        if (this.fatal) {
          const error = this.fatal;
          const entry = this.entry({ type: FrameType.SESSION_ERROR, flags: 0, stream_id: 0, payload: { code: error.code, message: error.message } }, "control");
          if (this.fits(entry)) await this.options.send(entry.bytes);
          this.shutdown(error);
          return;
        }
        const entry = this.select();
        if (!entry) return;
        const stream = entry.owner;
        if (stream && (entry.type === FrameType.HTTP_OPEN || entry.type === FrameType.WS_OPEN)) {
          stream.id = this.lastOpenId === 0 ? 1 : this.lastOpenId + 2;
          this.lastOpenId = stream.id;
          if (stream.id === 0x7fffffff) this.goAway("id_exhausted", 5000);
        }
        if (stream?.id !== undefined) {
          const id = stream.id;
          entry.bytes[4] = id >>> 24; entry.bytes[5] = id >>> 16; entry.bytes[6] = id >>> 8; entry.bytes[7] = id;
        }
        if (entry.type !== FrameType.RECEIVED) {
          this.submitted = add64(this.submitted, 1);
          this.ledger.push({ through: this.submitted, traffic: entry.traffic, wire: entry.wire, owner: stream, payloadBytes: entry.payloadBytes });
          if (entry.traffic === "control") this.controlFlight += entry.wire;
          else {
            this.ordinaryFlight += entry.wire;
            if (entry.traffic === "bulk") this.bulkFlight += entry.wire;
          }
          if (stream) {
            stream.sent = add64(stream.sent, entry.payloadBytes);
            stream.flightBytes += entry.payloadBytes;
          }
        }
        if (stream) this.touch(stream);
        // Commit state before invoking the sink: an in-memory/fast carrier can reply synchronously.
        entry.committed?.();
        if (this.generation !== generation || !this.active) return;
        await this.options.send(entry.bytes);
      }
    } catch (error) {
      // A rejected send may already have encrypted/submitted bytes. Never retry it.
      this.carrierLost(error instanceof MuxProtocolError ? error : new MuxProtocolError("internal_error", "Carrier send failed"));
    } finally {
      this.sending = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      if (this.state === "failing") this.kick();
    }
  }
  private releaseEntry(entry: Entry): void {
    const stream = entry.owner;
    if (!stream) return;
    this.queued -= entry.payloadBytes;
    stream.queuedBytes -= entry.payloadBytes;
    if (!stream.terminal) this.nonterminalQueued -= entry.payloadBytes;
    this.releaseMetadata(stream, entry.bytes.length - entry.payloadBytes);
  }
  dropQueue(stream: MuxStream, error: MuxStreamError, dropControl = true): void {
    for (const entry of stream.queue.splice(0)) {
      this.releaseEntry(entry);
      entry.failed?.(error);
    }
    stream.blockedTimer?.();
    stream.blockedTimer = undefined;
    if (!dropControl) return;
    for (let i = this.urgent.length - 1; i >= 0; i--) {
      const entry = this.urgent[i];
      if (entry?.owner === stream) {
        this.urgent.splice(i, 1);
        this.controlQueued -= entry.bytes.length;
      }
    }
  }
  dropAcceptance(stream: HttpStream): void {
    const index = stream.queue.findIndex((entry) => entry.type === FrameType.HTTP_ACCEPT);
    const entry = index < 0 ? undefined : stream.queue.splice(index, 1)[0];
    if (entry) this.releaseEntry(entry);
    for (let i = this.urgent.length - 1; i >= 0; i--) {
      const credit = this.urgent[i];
      if (credit?.owner === stream && credit.type === FrameType.CREDIT) {
        this.urgent.splice(i, 1);
        this.controlQueued -= credit.bytes.length;
      }
    }
  }
  receive(bytes: Uint8Array): void {
    if (!this.active) return;
    try {
      check(this.frameBucket.take(this.options.clock.now()), "Frame rate exceeded", "resource_exhausted");
      if (this.oversizedMessage(bytes)) {
        this.receivedFrames = add64(this.receivedFrames, 1);
        this.kick();
        return;
      }
      const frame = decodeFrame(bytes, this.options.filterRequestHeaders);
      this.refreshIdle();
      this.dispatch(frame, bytes.length);
      if (frame.type !== FrameType.RECEIVED && this.active) {
        this.receivedFrames = add64(this.receivedFrames, 1);
        this.kick();
      }
    } catch (error) {
      if (error instanceof MuxProtocolError) this.fail(error.code, error.message);
      else this.fail("internal_error", "Receive handler failed");
    }
  }
  /**
   * The codec bounds START lengths before returning a frame. Map that particular limit to
   * WS 1009, not a carrier error. Validate the original envelope through the codec using an
   * empty-message payload; no oversized declaration ever reaches reassembly allocation.
   */
  private oversizedMessage(bytes: Uint8Array): boolean {
    if (bytes.length < 12 || bytes.length > MAX_FRAME_BYTES || bytes[1] !== FrameType.WS_DATA || !((bytes[3] ?? 0) & WS_DATA_FLAGS.START)) return false;
    if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) <= LIMITS_V1.max_ws_message_bytes) return false;
    const envelope = bytes.slice(0, 12);
    envelope[3] = (envelope[3] ?? 0) | WS_DATA_FLAGS.END;
    envelope.fill(0, 8);
    const frame = decodeFrame(envelope);
    check(frame.stream_id <= this.lastOpenId, "Frame for future stream");
    const stream = [...this.streams].find((candidate) => candidate.id === frame.stream_id);
    if (stream?.live) {
      if (stream instanceof WsStream && stream.accepted) stream.close(1009, "message too large", true);
      else this.reset(stream, "stream_protocol_error");
    }
    this.refreshIdle();
    return true;
  }
  private dispatch(frame: MuxFrame, size: number): void {
    switch (frame.type) {
      case FrameType.RECEIVED: this.receipt(frame.payload); return;
      case FrameType.SESSION_ERROR: this.shutdown(new MuxProtocolError(frame.payload.code, frame.payload.message)); return;
      case FrameType.PING: this.enqueueControl({ ...frame, type: FrameType.PONG }); return;
      case FrameType.PONG:
        if (frame.payload === this.probe) { this.probe = undefined; this.probeTimer?.(); this.refreshIdle(); }
        return;
      case FrameType.GOAWAY:
        check(frame.payload.last_open_id <= this.lastOpenId, "Future GOAWAY watermark");
        this.goaway = true;
        for (const stream of this.streams) if (stream.id === undefined || stream.id > frame.payload.last_open_id) this.reset(stream, "refused", false);
        this.timer(() => this.carrierLost(new MuxProtocolError("timeout", "GOAWAY drained")), frame.payload.drain_ms);
        return;
      case FrameType.HELLO: case FrameType.WELCOME: case FrameType.AUTH: case FrameType.AUTH_OK: case FrameType.PAIR: {
        const clientFrame = frame.type === FrameType.HELLO || frame.type === FrameType.AUTH || frame.type === FrameType.PAIR;
        check(this.deviceId === undefined && clientFrame === (this.options.role === "server"), "Unexpected setup frame");
        this.options.onSession?.(frame);
        return;
      }
      case FrameType.HTTP_OPEN: case FrameType.WS_OPEN: {
        check(this.deviceId !== undefined && frame.payload.device_id === this.deviceId && this.options.role === "server", "Unauthenticated OPEN");
        check(frame.stream_id === (this.lastOpenId === 0 ? 1 : this.lastOpenId + 2), "Nonconsecutive OPEN");
        this.lastOpenId = frame.stream_id;
        check(this.openBucket.take(this.options.clock.now()), "OPEN rate exceeded", "resource_exhausted");
        const stream = frame.type === FrameType.HTTP_OPEN ? new HttpStream(this, frame.payload) : new WsStream(this, frame.payload);
        stream.id = frame.stream_id;
        if (this.goaway || !this.admit(stream, size)) {
          this.enqueueControl({ type: FrameType.RESET, flags: 0, stream_id: frame.stream_id, payload: { code: "refused", message: "" } });
          return;
        }
        if (stream instanceof HttpStream) {
          if (stream.request.body === "none" && (contentLength(stream.request.headers) ?? 0n) !== 0n) this.reset(stream, "bad_request");
          else if ((contentLength(stream.request.headers) ?? 0n) > BigInt(LIMITS_V1.max_request_body_bytes)) {
            stream.stopRequest(); stream.headers(413); stream.end();
          } else this.options.onHttp?.(stream);
        } else this.options.onWs?.(stream);
        if (this.lastOpenId === 0x7fffffff && !this.goaway) this.goAway("id_exhausted", 5000);
        return;
      }
      default: break;
    }
    check(frame.stream_id <= this.lastOpenId, "Frame for future stream");
    const stream = [...this.streams].find((candidate) => candidate.id === frame.stream_id);
    if (!stream || stream.cancelled) return;
    this.touch(stream);
    if (frame.type === FrameType.RESET) { this.reset(stream, frame.payload.code, false); return; }
    if (frame.type === FrameType.CREDIT) {
      check(frame.payload <= stream.sent, "CREDIT exceeds sent bytes", "flow_control_error");
      if (frame.payload > stream.peerConsumed) {
        stream.peerConsumed = frame.payload;
        stream.blockedTimer?.();
        stream.blockedTimer = undefined;
        this.kick();
      }
      return;
    }
    if (frame.type === FrameType.HTTP_DATA || frame.type === FrameType.WS_DATA) {
      const data = frame.type === FrameType.HTTP_DATA ? frame.payload : frame.payload.data;
      const next = add64(stream.received, data.length);
      check(next - stream.granted <= BigInt(stream.receiveWindow), "DATA exceeds granted credit", "flow_control_error");
      stream.received = next;
    }
    if (stream instanceof HttpStream) this.httpFrame(stream, frame, size);
    else if (stream instanceof WsStream) {
      switch (frame.type) {
        case FrameType.WS_ACCEPT:
          check(this.options.role === "client" && !stream.accepted && !stream.rejection, "Unexpected WS_ACCEPT");
          check(frame.payload.protocol === null || stream.request.protocols.includes(frame.payload.protocol), "Unoffered WS protocol");
          stream.accepted = true;
          stream.sendWindow = stream.receiveWindow = LIMITS_V1.ws_window_bytes;
          stream.onAccept?.(frame.payload.protocol, frame.payload.headers);
          this.kick();
          return;
        case FrameType.WS_DATA: stream.receiveFragment(frame); return;
        case FrameType.WS_CLOSE: stream.receiveClose(frame.payload); return;
        case FrameType.HTTP_HEADERS:
          check(this.options.role === "client" && !stream.accepted && frame.payload.status >= 200, "Invalid WS rejection");
          this.httpFrame(this.rejectWs(stream), frame, size);
          return;
        default: this.reset(stream, "stream_protocol_error");
      }
    }
  }
  private httpFrame(stream: HttpStream, frame: MuxFrame, size: number): void {
    const server = this.options.role === "server";
    switch (frame.type) {
      case FrameType.HTTP_ACCEPT:
        check(!server && stream.request.body === "stream" && !stream.accepted && !stream.stopped, "Unexpected HTTP_ACCEPT");
        stream.accepted = true; stream.sendWindow = LIMITS_V1.http_window_bytes; this.kick(); return;
      case FrameType.HTTP_HEADERS:
        check(!server && !stream.final, "Unexpected response headers");
        if (frame.payload.status < 200) check(++stream.informational <= 8, "Too many informational responses");
        else {
          stream.final = true;
          stream.noBody = stream.request.method === "HEAD" || [204, 205, 304].includes(frame.payload.status);
          stream.incomingLength = stream.request.method === "HEAD" || frame.payload.status === 304 ? undefined : contentLength(frame.payload.headers);
          if (isSse(frame.payload.headers) && !this.admitSse(stream)) return;
        }
        if (!this.retainMetadata(stream, size)) return;
        stream.response = frame.payload;
        stream.onHeaders?.(frame.payload);
        return;
      case FrameType.HTTP_DATA:
        if (stream.endedIn || server && !stream.accepted || !server && (!stream.final || stream.noBody)) {
          this.reset(stream, "stream_protocol_error"); return;
        }
        if (server && stream.stopped) return;
        if (server && stream.received > BigInt(LIMITS_V1.max_request_body_bytes)) {
          if (stream.final) this.reset(stream, "body_too_large");
          else { stream.stopRequest(); stream.headers(413); stream.end(); }
          return;
        }
        if (stream.incomingLength !== undefined && stream.received > stream.incomingLength) {
          this.reset(stream, "stream_protocol_error"); return;
        }
        stream.receiveData(frame.payload);
        return;
      case FrameType.HTTP_END: {
        const stopped = !!(frame.flags & HTTP_END_FLAGS.STOPPED);
        if (stream.endedIn || stopped && (!server || !stream.stopped) || !server && !stream.final
          || !stopped && stream.incomingLength !== undefined && stream.received !== stream.incomingLength) {
          this.reset(stream, "stream_protocol_error"); return;
        }
        if (!this.retainMetadata(stream, size)) return;
        stream.trailers = frame.payload.trailers;
        stream.endedIn = true;
        stream.finishBody();
        return;
      }
      case FrameType.HTTP_STOP_REQUEST:
        check(!server && stream.request.body === "stream" && !stream.stopped, "Unexpected STOP");
        stream.stopUpload(); return;
      default: this.reset(stream, "stream_protocol_error");
    }
  }
  rejectWs(stream: WsStream): HttpStream {
    this.dropQueue(stream, new MuxStreamError("refused"));
    const http = new HttpStream(this, { device_id: stream.request.device_id, method: "GET", target: stream.request.target, headers: stream.request.headers, body: "none" });
    http.id = stream.id;
    http.metadataBytes = stream.metadataBytes;
    stream.metadataBytes = 0;
    http.reservation = LIMITS_V1.http_window_bytes;
    this.reserved += http.reservation - stream.reservation;
    stream.reservation = 0;
    this.streams.delete(stream);
    this.streams.add(http);
    stream.rejection = http;
    http.onDispose = stream.onDispose;
    stream.cancelled = true;
    stream.fail();
    return http;
  }
  consume(stream: MuxStream, bytes: number): void {
    if (!stream.live || stream instanceof HttpStream && stream.stopped && this.options.role === "server") return;
    stream.consumed = add64(stream.consumed, bytes);
    if (bytes && stream.id !== undefined) {
      const consumed = stream.consumed;
      this.enqueueControl({ type: FrameType.CREDIT, flags: 0, stream_id: stream.id, payload: consumed }, stream, () => { stream.granted = consumed; });
    }
    this.retire(stream);
  }
  private receipt(through: bigint): void {
    check(through <= this.submitted, "Receipt exceeds submitted frames");
    if (through <= this.acknowledged) return;
    this.acknowledged = through;
    while (this.ledger[0] && this.ledger[0].through <= through) {
      const flight = this.ledger.shift();
      if (!flight) break;
      if (flight.traffic === "control") this.controlFlight -= flight.wire;
      else {
        this.ordinaryFlight -= flight.wire;
        if (flight.traffic === "bulk") this.bulkFlight -= flight.wire;
      }
      if (flight.owner) flight.owner.flightBytes -= flight.payloadBytes;
    }
    this.kick();
  }
  reset(stream: MuxStream, code: StreamError, transmit = true): void {
    if (stream.cancelled || stream.retired) return;
    const error = new MuxStreamError(code);
    stream.cancelled = true;
    this.dropQueue(stream, error);
    stream.endedIn = stream.endedOut = true;
    stream.fail(error);
    this.dispose(stream, error);
    if (transmit && stream.id !== undefined) this.enqueueControl({ type: FrameType.RESET, flags: 0, stream_id: stream.id, payload: { code, message: "" } });
    this.retire(stream);
  }
  cleanup(stream: MuxStream, completion: Promise<void>): void {
    stream.cleanupPending++;
    completion.then(() => { stream.cleanupPending--; this.retire(stream); }, () => {
      stream.cleanupPending--;
      if (stream.live) this.reset(stream, "internal_error");
      this.retire(stream);
    });
  }
  dispose(stream: MuxStream, error?: MuxStreamError): void {
    if (stream.cleanupStarted) return;
    stream.cleanupStarted = true;
    stream.routeTimer?.();
    stream.blockedTimer?.();
    try {
      const result = stream.onDispose?.(error);
      if (result) this.cleanup(stream, result);
    } catch (error) { this.fail("internal_error", "Stream cleanup failed"); }
  }
  retire(stream: MuxStream): void {
    if (stream.retired || !this.streams.has(stream) || !stream.endedIn || !stream.endedOut || stream.queue.length || stream.inboundBytes || stream.pendingInbound) return;
    this.dispose(stream);
    if (stream.cleanupPending) return;
    stream.retired = true;
    this.streams.delete(stream);
    this.metadata -= stream.metadataBytes;
    stream.metadataBytes = 0;
    this.reserved -= stream.reservation;
    stream.reservation = 0;
    queueMicrotask(() => { if (this.active) this.onStreamAvailable?.(); });
  }
  goAway(code: "shutdown" | "id_exhausted" = "shutdown", drainMs = 5000): void {
    if (!this.active) return;
    this.goaway = true;
    for (const stream of this.streams) if (stream.id === undefined) this.reset(stream, "refused", false);
    this.enqueueControl({ type: FrameType.GOAWAY, flags: 0, stream_id: 0, payload: { code, last_open_id: this.lastOpenId, drain_ms: drainMs } });
    this.timer(() => this.carrierLost(new MuxProtocolError("timeout", "GOAWAY drained")), drainMs);
  }
  private refreshIdle(): void {
    if (!this.deviceId || this.hidden || this.probe !== undefined || !this.active) return;
    this.idleTimer?.();
    if (this.options.role === "server") this.idleTimer = this.timer(() => this.ping(), 20_000);
  }
  ping(): void {
    if (!this.active || this.hidden) return;
    this.probeTimer?.();
    const random = crypto.getRandomValues(new Uint32Array(2));
    this.probe = (BigInt(random[0] ?? 0) << 32n) | BigInt(random[1] ?? 0);
    this.enqueueControl({ type: FrameType.PING, flags: 0, stream_id: 0, payload: this.probe });
    this.probeTimer = this.timer(() => this.fail("timeout", "PONG timed out"), 60_000);
  }
  setHidden(hidden: boolean): void {
    check(this.options.role === "client", "Only clients suspend liveness");
    const changed = this.hidden !== hidden;
    this.hidden = hidden;
    this.probe = undefined;
    this.probeTimer?.();
    this.idleTimer?.();
    if (changed) for (const timer of this.timers.values()) {
      if (hidden) timer.pause();
      else timer.resume();
    }
    if (!hidden) this.ping();
  }
  fail(code: SessionError, message: string): void {
    if (!this.active) return;
    this.state = "failing";
    this.fatal = new MuxProtocolError(code, message);
    for (const stream of this.streams) this.reset(stream, "upstream_lost", false);
    this.urgent.length = 0;
    this.controlQueued = 0;
    this.timer(() => this.shutdown(this.fatal ?? new MuxProtocolError(code, message)), 5000);
    this.kick();
  }
  carrierLost(error = new MuxProtocolError("internal_error", "Carrier lost")): void { this.shutdown(error); }
  private shutdown(error: MuxProtocolError): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.generation++;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    for (const stop of this.timers.keys()) stop();
    for (const stream of this.streams) this.reset(stream, "upstream_lost", false);
    this.urgent.length = 0;
    this.controlQueued = 0;
    for (const flight of this.ledger) if (flight.owner) flight.owner.flightBytes -= flight.payloadBytes;
    this.ledger.length = 0;
    this.ordinaryFlight = this.bulkFlight = this.controlFlight = 0;
    this.options.close(4000);
    this.options.onClose?.(error);
  }
}
