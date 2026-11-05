/**
 * A relay client's side of a connection to a PC: Noise NK to its key, then Ovis Mux v1 admission with a device key
 * (docs/relay.md). The hosted app uses it (src/lib/relay/channel.ts), and so does a PC's server for a PC it added
 * through the relay (server/relay-pc.ts).
 */
import { openClientSecureChannel } from "./relay-e2ee.ts";
import type { SecureChannel, Transport } from "./relay-e2ee.ts";
import { decodeFrame, FrameType, LIMITS_V1, MuxProtocolError, RELAY_PROTOCOL } from "./relay-mux.ts";
import { MuxEngine } from "./relay-mux-engine.ts";
import type { MuxOptions, SessionFrame } from "./relay-mux-engine.ts";
import { isWssOrigin, SERVER_ID_PATTERN } from "./relay-offer.ts";
import type { RelayOffer } from "./relay-offer.ts";
import { getDevice, sign } from "./relay-device.ts";
import type { RelayDevice, RelayDeviceStore } from "./relay-device.ts";

export class UnsafeRelayDestinationError extends Error {
  readonly code = "unsafe_relay_destination";
  constructor(readonly field: "relay" | "server_id") {
    super(`Invalid relay destination: ${field}`);
    this.name = "UnsafeRelayDestinationError";
  }
}

/**
 * The relay never answered: the socket failed, closed, or stayed silent past ASSIGNMENT_MS before
 * the relay assigned this connection. The PC's state is unknown.
 */
export class RelayUnreachableError extends Error {
  readonly code = "relay_unreachable";
  constructor(readonly closeCode: number | null, readonly silent = false) {
    super(silent ? "The relay did not answer" : closeCode === null ? "The relay could not be reached"
      // 1006 is the browser's word for a connection that failed or dropped without a close frame
      : closeCode === 1006 ? "The relay connection failed (1006)" : `The relay closed the connection (${closeCode})`);
    this.name = "RelayUnreachableError";
  }
}

/**
 * The PC answered the relay (its handshake began) but did not finish admitting this device within
 * ADMISSION_MS: it is online, and something on it stalled. Neither the relay nor an offline PC.
 */
export class RelayAdmissionTimeoutError extends Error {
  readonly code = "admission_timeout";
  constructor(readonly phase: "handshake" | "welcome" | "auth") {
    super(`The PC did not finish the connection (${phase})`);
    this.name = "RelayAdmissionTimeoutError";
  }
}

/**
 * The relay assigned the connection and held it PC_ANSWER_MS, and no PC came for it: the PC is not
 * on the relay (stopped, restarting, or offline). The relay would have handed the connection to a
 * PC that came back meanwhile, so the attempt itself was the wait.
 */
export class RelayPcOfflineError extends MuxProtocolError {
  constructor() {
    super("timeout", "The PC did not answer through the relay");
    this.name = "RelayPcOfflineError";
  }
}

/** WebSocket.OPEN, so an injected socket need not be a WebSocket */
const OPEN = 1;

/** How long the relay may take to assign the connection: past it the relay is unreachable. */
export const ASSIGNMENT_MS = 10_000;
/** How long the PC may take to answer once the relay has assigned the connection: past it the PC is offline. */
export const PC_ANSWER_MS = 15_000;
/** How long the PC may take to finish admission once it has answered; the mux's own setup timer (relay-mux-engine.ts) agrees. */
export const ADMISSION_MS = 10_000;

export interface RelaySocket {
  binaryType: BinaryType;
  /** a WebSocket's: 1 while open; 2 once it is closing, before any close event */
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}
export interface RelayChannelOptions {
  readonly store: RelayDeviceStore;
  readonly socket?: (url: string) => RelaySocket;
  readonly label?: string;
  readonly signal?: AbortSignal;
  readonly onClose?: (error: Error) => void;
  /** how long the relay may hold the connection for the PC before it is called offline; PC_ANSWER_MS by default */
  readonly pcAnswerMs?: number;
  /** each request's deadline (MuxOptions.requestTimeoutMs); 60 s by default */
  readonly requestTimeoutMs?: MuxOptions["requestTimeoutMs"];
}
export interface RelayChannel {
  readonly mux: MuxEngine;
  readonly device: RelayDevice;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly role: "drive" | "watch";
  /** what the PC's WELCOME said of itself, for the version policy (skew.ts) */
  readonly server: RelayServerInfo;
  /**
   * False once the relay socket has left OPEN, possibly with no close event yet: a socket closed
   * under the page waits for the relay's answer to its close, and a browser drops what is sent meanwhile.
   */
  readonly carrierOpen: boolean;
  close(): void;
}
export interface RelayServerInfo {
  readonly version: string;
  readonly relayProtocol: number;
}

/** Resolves only after protected Noise, WELCOME and device admission all succeeded. Never retries. */
export async function openRelayChannel(offer: RelayOffer, options: RelayChannelOptions): Promise<RelayChannel> {
  if (typeof offer.relay !== "string" || !isWssOrigin(offer.relay)) throw new UnsafeRelayDestinationError("relay");
  if (typeof offer.server_id !== "string" || !SERVER_ID_PATTERN.test(offer.server_id)) throw new UnsafeRelayDestinationError("server_id");
  const url = new URL("/v1/ws", offer.relay);
  url.searchParams.set("server_id", offer.server_id);
  url.searchParams.set("role", "client");
  url.searchParams.set("v", "1");
  options.signal?.throwIfAborted();
  const store = options.store;
  const device = await getDevice(offer, store, options.label);
  options.signal?.throwIfAborted();
  const socket = (options.socket ?? ((address) => new WebSocket(address)))(url.href);
  socket.binaryType = "arraybuffer";
  return new Promise<RelayChannel>((resolve, reject) => {
    let phase: "assigned" | "handshake" | "welcome" | "auth" | "ready" | "closed" = "assigned";
    let secure: SecureChannel | undefined;
    let mux: MuxEngine | undefined;
    let connectionId = "";
    const limits = { ...LIMITS_V1 };
    let welcome: Uint8Array | undefined;
    let server: RelayServerInfo = { version: "", relayProtocol: RELAY_PROTOCOL };
    let receipt: Uint8Array | undefined;
    let incoming = Promise.resolve();
    const stop = (error: Error): void => {
      if (phase === "closed") return;
      const admitted = phase === "ready";
      phase = "closed";
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", aborted);
      mux?.carrierLost();
      secure?.close(4000, "relay channel closed");
      socket.close(4000, "relay channel closed");
      if (admitted) options.onClose?.(error);
      else reject(error);
    };
    const aborted = (): void => stop(new DOMException("Relay connection aborted", "AbortError"));
    // One deadline at a time, re-armed as the setup moves on, so a stall names the side that stalled:
    // the relay before it assigns the connection, the PC before its first frame, and the PC's
    // admission after that. The PC's handshake answer (its first frame, which may be text or
    // bytes) is what tells it apart from an offline one; frames before admission all come from it.
    let deadline = setTimeout(() => stop(new RelayUnreachableError(null, true)), ASSIGNMENT_MS);
    let heardPc = false;
    const expect = (ms: number, failure: () => Error): void => {
      clearTimeout(deadline);
      deadline = setTimeout(() => stop(failure()), ms);
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    const transport: Transport = {
      // a closing socket would drop the frame without an error: fail it, so the mux and its streams end
      send: (data) => {
        if (socket.readyState !== OPEN) throw new MuxProtocolError("internal_error", "Relay socket is not open");
        socket.send(data);
      },
      close: (code = 4000, reason = "") => socket.close(code, reason),
      onmessage: null, onclose: null, onerror: null,
    };
    const send = (frame: SessionFrame): Promise<void> => {
      if (!mux || phase === "closed") throw new MuxProtocolError("protocol_error", "Relay channel is closed");
      mux.sendSession(frame);
      return mux.flush();
    };
    const receive = async (data: string | ArrayBuffer): Promise<void> => {
      if (phase === "closed") return;
      if (typeof data === "string") throw new MuxProtocolError("protocol_error", "Expected binary mux frame");
      const bytes = new Uint8Array(data);
      if (phase === "ready") { mux?.receive(bytes); return; }
      const frame = decodeFrame(bytes);
      if (frame.type === FrameType.SESSION_ERROR) throw new MuxProtocolError(frame.payload.code, frame.payload.message);
      if (frame.type === FrameType.RECEIVED) {
        if (!mux || frame.payload > mux.stats.submitted) throw new MuxProtocolError("protocol_error", "Receipt exceeds submitted frames");
        receipt = bytes;
        return;
      }
      if (phase === "welcome" && frame.type === FrameType.WELCOME) {
        // before any credential: a PC of another relay generation is an update, not a pairing
        if (frame.payload.relay_protocol !== RELAY_PROTOCOL) throw new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${frame.payload.relay_protocol}`);
        server = { version: frame.payload.server_version, relayProtocol: frame.payload.relay_protocol };
        if (frame.payload.features.length) throw new MuxProtocolError("unsupported_extension", "Server selected unoffered features");
        phase = "auth";
        Object.assign(limits, frame.payload.limits);
        welcome = bytes;
        if (offer.code !== undefined) {
          await send({ type: FrameType.PAIR, flags: 0, stream_id: 0,
            payload: { code: offer.code, label: device.label, public_key: device.public_spki } });
        } else {
          if (device.device_id === null) throw new MuxProtocolError("auth_failed", "Pair this device first");
          const nonce = Uint8Array.from(atob(frame.payload.nonce.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
          const signature = await sign(device, nonce, offer.server_id);
          await send({ type: FrameType.AUTH, flags: 0, stream_id: 0,
            payload: { scheme: "device-key", device_id: device.device_id, signature } });
        }
        return;
      }
      if (phase !== "auth" || frame.type !== FrameType.AUTH_OK) {
        throw new MuxProtocolError("protocol_error", "Unexpected frame before AUTH_OK");
      }
      if (offer.code === undefined && frame.payload.device_id !== device.device_id) {
        throw new MuxProtocolError("auth_failed", "AUTH_OK named a different device");
      }
      const admitted = await store.update(offer.server_id, (current) => {
        // a first pairing's key is saved only now that the PC has admitted it (device.ts getDevice)
        const kept = current ?? (device.device_id === null ? device : undefined);
        if (!kept || kept.server_public_key !== device.server_public_key || kept.public_spki !== device.public_spki) {
          throw new MuxProtocolError("auth_changed", "Stored relay identity changed during authentication");
        }
        return { ...kept, device_id: frame.payload.device_id };
      });
      if (options.signal?.aborted || !secure?.isOpen() || !mux || !welcome) return;
      // Defer setup accounting until admission: receive() automatically emits RECEIVED.
      // Outgoing HELLO/AUTH already used the mux ledger, so inbound receipts are safe.
      mux.receive(welcome);
      mux.receive(bytes);
      if (receipt) mux.receive(receipt);
      mux.authenticate(admitted.device_id ?? frame.payload.device_id);
      phase = "ready";
      clearTimeout(deadline);
      resolve({ mux, device: admitted, connectionId, sessionId: frame.payload.session_id, role: frame.payload.role, server,
        get carrierOpen() { return phase === "ready" && socket.readyState === OPEN; },
        close: () => stop(new MuxProtocolError("internal_error", "Relay channel closed")) });
    };
    const failed = (error: unknown): void => stop(error instanceof Error ? error : new Error(String(error)));
    socket.onclose = (event) => {
      transport.onclose?.(event.code, event.reason);
      stop(phase === "assigned" ? new RelayUnreachableError(event.code) : new MuxProtocolError("internal_error", "Relay socket closed"));
    };
    socket.onerror = () => {
      const error = phase === "assigned" ? new RelayUnreachableError(null) : new MuxProtocolError("internal_error", "Relay socket failed");
      transport.onerror?.(error);
      stop(error);
    };
    socket.onmessage = (event) => {
      if (phase === "closed") return;
      if (phase !== "assigned") {
        if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) {
          stop(new MuxProtocolError("protocol_error", "Invalid relay carrier frame"));
          return;
        }
        if (!heardPc) {
          heardPc = true;
          expect(ADMISSION_MS, () => new RelayAdmissionTimeoutError(phase === "auth" ? "auth" : phase === "welcome" ? "welcome" : "handshake"));
        }
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
        return;
      }
      phase = "handshake";
      incoming = incoming.then(async () => {
        if (options.signal?.aborted) return;
        const assigned: unknown = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (!assigned || typeof assigned !== "object" || !("type" in assigned) || assigned.type !== "assigned"
          || !("connection_id" in assigned) || typeof assigned.connection_id !== "string"
          || !/^[0-9a-f]{32}$/.test(assigned.connection_id)) {
          throw new MuxProtocolError("protocol_error", "Invalid relay assignment");
        }
        connectionId = assigned.connection_id;
        phase = "welcome";
        if (!heardPc) expect(options.pcAnswerMs ?? PC_ANSWER_MS, () => new RelayPcOfflineError());
        const opened = Promise.withResolvers<void>();
        secure = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: offer.server_public_key,
          events: {
            onopen: () => opened.resolve(),
            onmessage: (data) => { incoming = incoming.then(() => receive(data)).catch(failed); },
            onerror: (error) => { opened.reject(error); stop(error); },
            onclose: () => { const error = new MuxProtocolError("internal_error", "Secure relay channel closed"); opened.reject(error); stop(error); },
          },
        });
        await opened.promise;
        if (!secure.isOpen()) return;
        const carrier = secure;
        mux = new MuxEngine({
          role: "client", send: (bytes) => carrier.send(bytes.slice().buffer),
          close: () => stop(new MuxProtocolError("internal_error", "Relay mux closed")),
          clock: { now: () => performance.now(), setTimeout: (callback, ms) => {
            const timer = setTimeout(() => {
              if (phase === "ready") callback();
              // the mux exists only once the PC answered: its setup timer firing is the PC's admission stalling
              else stop(new RelayAdmissionTimeoutError(phase === "auth" ? "auth" : "welcome"));
            }, ms);
            return () => clearTimeout(timer);
          } },
          outboundWireByteLength: (bytes) => carrier.outboundWireByteLength(bytes.slice().buffer),
          routingOverhead: 0, maxWireMessageBytes: 65536, limits, requestTimeoutMs: options.requestTimeoutMs,
          onClose: (error) => stop(error),
        });
        await send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
          payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
      }).catch(failed);
    };
  });
}
