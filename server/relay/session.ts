import { randomBytes } from "node:crypto";
import type { SecureChannel } from "../../shared/relay-e2ee.ts";
import { MuxEngine, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { HttpStream, MuxClock, SessionFrame, WsStream } from "../../shared/relay-mux-engine.ts";
import { FrameType, LIMITS_V1, RELAY_PROTOCOL, REQUEST_HEADERS, RESPONSE_HEADERS, WS_CONTINUATION_CAPACITY } from "../../shared/relay-mux.ts";
import type { HeaderList, SessionError } from "../../shared/relay-mux.ts";
import { PairingRateLimitedError, type DeviceMatch } from "../devices.ts";
import { handleRequest } from "../dispatch.ts";
import type { RequestServices, ServerContext } from "../dispatch.ts";
import type { EventStreamBudget } from "../machine-api.ts";
import { VirtualSocket, type RelaySocketHandlers } from "./virtual-socket.ts";

export const RELAY_ORIGIN = "https://relay.ovis.invalid";
const SOURCE_LIMIT = 3 * 1024 * 1024;
const SESSION_LIMIT = 32 * 1024 * 1024;
export const relayClock: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Shared by HTTP and the WebSocket adapter; client identity headers never become Request headers. */
export function relayHeaders(list: HeaderList): Headers {
  const headers = new Headers();
  const allowed: readonly string[] = REQUEST_HEADERS;
  for (const [name, value] of list) if (allowed.includes(name)) headers.append(name, value);
  headers.set("origin", RELAY_ORIGIN);
  headers.set("sec-fetch-site", "same-origin");
  headers.set("accept-encoding", "identity");
  return headers;
}

export interface RelaySessionOptions {
  readonly channel: SecureChannel;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  readonly serverId: string;
  readonly serverVersion: string;
  readonly minSupportedClient: string;
  readonly routingOverhead: number;
  readonly maxWireMessageBytes: number;
  readonly clock?: MuxClock;
  readonly dispatch?: typeof handleRequest;
  /** The core's SocketLike handlers. Without either adapter, WS_OPEN is refused. */
  readonly websocket?: RelaySocketHandlers;
  /** Owns the upgrade and socket lifecycle, including stream disposal. Absent adapters refuse WS_OPEN. */
  readonly onWs?: (stream: WsStream, exchange: RelayWebSocketRequest) => void;
  readonly onClose?: (code: SessionError) => void;
  /** The client signed in or paired: from here on the carrier counts as a device's session. */
  readonly onAuthenticated?: (deviceId: string) => void;
}

export interface RelayWebSocketRequest {
  readonly request: Request;
  readonly context: ServerContext;
  upgrade?: Parameters<ServerContext["upgrade"]>[1];
}

/**
 * One protected carrier, one immutable principal, no replay. The carrier wires its plaintext
 * onmessage callback to receive(); construction requires the Noise handshake to have completed.
 */
export class RelaySession {
  readonly mux: MuxEngine;
  readonly sessionId = randomBytes(16).toString("hex");
  private state: "hello" | "auth" | "verifying" | "ready" | "closed" = "hello";
  private readonly nonce = randomBytes(32);
  private device: DeviceMatch | undefined;
  private unwatch: (() => void) | undefined;
  private sourceBytes = 0;
  private readonly clock: MuxClock;
  private readonly activity = new Map<number, () => void>();
  private readonly sockets = new Map<WsStream, VirtualSocket | undefined>();
  private readonly requests = new Set<HttpStream>();

  constructor(private readonly options: RelaySessionOptions) {
    if (!options.channel.isOpen() || options.channel.securityMode() !== "protected") {
      throw new Error("Relay sessions require an open protected channel");
    }
    this.clock = options.clock ?? relayClock;
    this.mux = new MuxEngine({
      role: "server", clock: this.clock,
      send: (bytes) => {
        this.touch(bytes);
        return options.channel.send(bytes.slice().buffer);
      },
      outboundWireByteLength: (bytes) => options.channel.outboundWireByteLength(bytes.slice().buffer),
      routingOverhead: options.routingOverhead, maxWireMessageBytes: options.maxWireMessageBytes,
      // The dispatcher sets the route's budget, including overrides selected from a request body.
      requestTimeoutMs: () => 0,
      filterRequestHeaders: true,
      close: (code) => options.channel.close(code),
      onClose: (error) => {
        this.state = "closed";
        this.unwatch?.();
        this.unwatch = undefined;
        options.onClose?.(error.code);
      },
      onSession: (frame) => {
        void this.admit(frame).catch((error: unknown) => {
          if (error instanceof PairingRateLimitedError) this.mux.fail("auth_failed", error.message);
          else this.close("internal_error");
        });
      },
      onHttp: (stream) => { void this.http(stream); },
      onWs: (stream) => {
        const device = this.principal();
        if (!device) { stream.reset("refused"); return; }
        if (!options.onWs && !options.websocket) { stream.reset("refused"); return; }
        this.sockets.set(stream, undefined);
        const abort = new AbortController();
        let timer: (() => void) | undefined;
        const exchange: RelayWebSocketRequest = {
          request: new Request(RELAY_ORIGIN + stream.request.target, {
            headers: relayHeaders(stream.request.headers), signal: abort.signal,
          }),
          context: this.context(device, (_request, seconds) => {
            timer?.();
            timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
          }, (_request, upgrade) => {
            if (!stream.live || this.state !== "ready") return false;
            exchange.upgrade = upgrade;
            return true;
          }),
        };
        stream.onDispose = () => {
          timer?.();
          abort.abort();
          exchange.upgrade?.data.relay?.close();
          this.sockets.delete(stream);
        };
        if (options.onWs) options.onWs(stream, exchange);
        else void this.websocket(stream, exchange);
      },
    });
    options.channel.onClose(() => this.mux.carrierLost());
  }

  /** A sign-in or pairing is being checked, or its AUTH_OK waits to be sent. */
  get verifying(): boolean { return this.state === "verifying"; }

  get bufferedBytes(): number { return this.sourceBytes + this.mux.stats.bufferedBytes; }

  receive(data: string | ArrayBuffer): void {
    if (typeof data === "string") { this.close("protocol_error"); return; }
    const bytes = new Uint8Array(data);
    this.mux.receive(bytes);
    for (const socket of this.sockets.values()) socket?.drain();
    if (this.mux.active) this.touch(bytes);
  }

  private touch(bytes: Uint8Array): void {
    if (bytes.byteLength >= 8) this.activity.get(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4))?.();
  }

  close(code: SessionError = "auth_revoked"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.unwatch?.();
    this.unwatch = undefined;
    if (code !== "auth_revoked" && code !== "auth_changed") { this.mux.fail(code, code); return; }
    // Stop application work now, but let the known WS policy close reach the peer before
    // SESSION_ERROR tears down the carrier. WsStream bounds both draining and the close exchange.
    for (const stream of this.requests) stream.reset("cancelled");
    const closing: Promise<void>[] = [];
    for (const [stream, socket] of this.sockets) {
      if (!socket) { stream.reset("cancelled"); continue; }
      closing.push(socket.closed);
      socket.close(1008, "Device access revoked");
    }
    // An aborting CLOSE notifies locally before its urgent frame is submitted.
    if (closing.length) void Promise.all(closing).then(() => this.mux.flush()).then(() => this.mux.fail(code, code));
    else this.mux.fail(code, code);
  }

  private async admit(frame: SessionFrame): Promise<void> {
    switch (frame.type) {
      case FrameType.HELLO:
        if (this.state !== "hello") { this.close("protocol_error"); return; }
        if (!frame.payload.versions.includes(1)) { this.close("unsupported_version"); return; }
        if (frame.payload.required_features.length) { this.close("unsupported_extension"); return; }
        this.state = "auth";
        this.mux.sendSession({
          type: FrameType.WELCOME, flags: 0, stream_id: 0,
          payload: {
            protocol: "ovis-mux", version: 1, features: [], limits: LIMITS_V1,
            nonce: this.nonce.toString("base64url"), server_version: this.options.serverVersion,
            relay_protocol: RELAY_PROTOCOL, min_supported_client: this.options.minSupportedClient,
          },
        });
        return;
      case FrameType.AUTH: case FrameType.PAIR: {
        if (this.state !== "auth") { this.close("protocol_error"); return; }
        this.state = "verifying";
        const devices = this.options.services.devices;
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        const device = frame.type === FrameType.AUTH
          ? await devices.matchRelay(frame.payload.device_id, this.nonce, frame.payload.signature, this.options.serverId)
          : devices.pairRelay(frame.payload.code, frame.payload.label, frame.payload.public_key)?.device;
        if (!this.mux.active) return;
        if (!device) { this.close("auth_failed"); return; }
        this.unwatch = devices.onRevoke(device.id, () => this.close(devices.has(device.id) ? "auth_changed" : "auth_revoked"));
        if (!devices.has(device.id) || !this.mux.active) { this.unwatch(); return; }
        if (devices.list(null).find((current) => current.id === device.id)?.role !== device.role) {
          this.close("auth_changed");
          return;
        }
        this.device = Object.freeze(device);
        // The commit callback runs before the sink: synchronous carriers can immediately OPEN.
        // Until then OPEN is still unauthenticated, even while AUTH_OK waits behind receipt credit.
        this.mux.enqueueControl({
          type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
          payload: { session_id: this.sessionId, device_id: device.id, role: device.role },
        }, undefined, () => {
          if (!devices.has(device.id)) { this.close("auth_revoked"); return; }
          this.mux.authenticate(device.id);
          this.state = "ready";
          this.options.onAuthenticated?.(device.id);
        });
        return;
      }
      case FrameType.WELCOME: case FrameType.AUTH_OK:
        this.close("protocol_error");
    }
  }

  private principal(): DeviceMatch | undefined {
    if (this.state === "closed") return;
    if (this.state !== "ready" || !this.device) { this.close("protocol_error"); return; }
    if (!this.options.services.devices.has(this.device.id)) { this.close("auth_revoked"); return; }
    return this.device;
  }

  private async websocket(stream: WsStream, exchange: RelayWebSocketRequest): Promise<void> {
    try {
      const response = await (this.options.dispatch ?? handleRequest)(exchange.request, exchange.context);
      if (!stream.live || this.state !== "ready") {
        exchange.upgrade?.data.relay?.close();
        await response?.body?.cancel();
        return;
      }
      const handlers = this.options.websocket;
      if (exchange.upgrade && handlers) {
        const socket = new VirtualSocket(exchange.upgrade.data, stream, handlers);
        this.sockets.set(stream, socket);
        socket.open();
        return;
      }
      if (!response) { stream.reset("internal_error"); return; }
      const allowed: readonly string[] = RESPONSE_HEADERS;
      const rejection = stream.reject(response.status, [...response.headers].filter(([name]) => allowed.includes(name)));
      // Rejection transfers disposal to an HTTP stream; it still owns the request signal.
      if (response.body) await rejection.sendBody(response.body);
      else rejection.end();
    } catch (error) {
      exchange.upgrade?.data.relay?.close();
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    }
  }

  private context(device: DeviceMatch, timeout: ServerContext["timeout"], upgrade: ServerContext["upgrade"],
    relayBodyBudget?: EventStreamBudget): ServerContext {
    return {
      services: this.options.services, port: this.options.port, requestIP: () => null, timeout, upgrade,
      peer: { kind: "relay", device, sessionId: this.sessionId }, relayBodyBudget,
    };
  }

  private async http(stream: HttpStream): Promise<void> {
    const device = this.principal();
    if (!device) { stream.reset("refused"); return; }
    this.requests.add(stream);
    const abort = new AbortController();
    let timer: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let held = 0;
    let queued = 0;
    let seconds = 60;
    const touch = () => {
      timer?.();
      timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
    };
    const timeout: ServerContext["timeout"] = (_request, budget) => { seconds = budget; touch(); };
    const id = stream.id;
    if (id !== undefined) this.activity.set(id, touch);
    const budget: EventStreamBudget = {
      reserve: (bytes) => {
        if (queued + bytes > SOURCE_LIMIT || this.sourceBytes + bytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          stream.reset("resource_exhausted");
          return false;
        }
        queued += bytes;
        this.sourceBytes += bytes;
        return true;
      },
      release: (bytes) => { queued -= bytes; this.sourceBytes -= bytes; },
    };
    stream.onDispose = async () => {
      this.requests.delete(stream);
      timer?.();
      if (id !== undefined) this.activity.delete(id);
      abort.abort();
      await reader?.cancel();
    };
    touch();
    try {
      const request = new Request(RELAY_ORIGIN + stream.request.target, {
        method: stream.request.method, headers: relayHeaders(stream.request.headers),
        body: stream.request.body === "stream" ? stream.body : undefined, signal: abort.signal,
      });
      const context = this.context(device, timeout, () => false, budget);
      if (stream.request.body === "stream") stream.accept();
      const response = await (this.options.dispatch ?? handleRequest)(request, context);
      // The engine may have answered an unknown-length upload with 413 while dispatch was reading it.
      if (!stream.live || stream.final) { await response?.body?.cancel(); return; }
      if (!response) { stream.reset("internal_error"); return; }
      reader = response.body?.getReader();
      const allowed: readonly string[] = RESPONSE_HEADERS;
      stream.headers(response.status, [...response.headers].filter(([name]) => allowed.includes(name)));
      if (!stream.live) return;
      if (!reader || stream.noBody) {
        await reader?.cancel();
        stream.end();
        return;
      }
      while (stream.live) {
        const chunk = await reader.read();
        if (!stream.live) return;
        if (chunk.done) { stream.end(); return; }
        held = chunk.value.byteLength;
        if (held + this.sourceBytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          held = 0;
          stream.reset("resource_exhausted");
          return;
        }
        this.sourceBytes += held;
        for (let offset = 0; offset < chunk.value.byteLength && stream.live; offset += WS_CONTINUATION_CAPACITY) {
          await stream.write(chunk.value.subarray(offset, offset + WS_CONTINUATION_CAPACITY));
        }
        this.sourceBytes -= held;
        held = 0;
      }
    } catch (error) {
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    } finally {
      this.sourceBytes -= held;
      reader?.releaseLock();
      reader = undefined;
    }
  }
}
