import {
  openClientSecureChannel as openClient, openDaemonSecureChannel as openDaemon,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, PROTECTED_RECORD_FAILED_CLOSE_CODE,
} from "./vendor/paseo-e2ee/e2ee.ts";
import type {
  ClientSecureChannelOptions as ClientOptions, DaemonSecureChannelOptions as DaemonOptions, Transport,
  TransportMessage,
} from "./vendor/paseo-e2ee/e2ee.ts";
import { protectedRecordByteLength } from "./vendor/paseo-e2ee/protected-records.ts";
import { importPublicKey as importKey } from "./vendor/paseo-e2ee/e2ee.ts";
import type { SecureChannel as Channel } from "./vendor/paseo-e2ee/e2ee.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { MAX_FRAME_BYTES } from "./relay-mux.ts";

export type ClientSecureChannelOptions = Omit<ClientOptions, "minimumMode">;
export type DaemonSecureChannelOptions = Omit<DaemonOptions, "minimumMode">;

export const MAX_CARRIER_BINARY_BYTES = protectedRecordByteLength(MAX_FRAME_BYTES);
export const MAX_CARRIER_TEXT_BYTES = 4 * Math.ceil(MAX_CARRIER_BINARY_BYTES / 3);
export const MAX_PRE_OPEN_SENDS = 200;
export const MAX_PRE_OPEN_SEND_BYTES = 1 << 20;
export const MAX_HANDSHAKE_INBOUND_MESSAGES = 256;
export const MAX_HANDSHAKE_INBOUND_BYTES = 2 << 20;
export const MAX_HANDSHAKE_INBOUND_BYTES_TOTAL = 16 << 20;
/** Charged per queued message on top of its data, so empty messages cannot escape the byte budgets. */
export const HANDSHAKE_MESSAGE_OVERHEAD_BYTES = 64;
const DAEMON_RECORD_FAILURE_CLOSE_CODE = 1011;

let handshakeInboundBytes = 0;

const BINDING_DOMAIN = utf8ToBytes("ovis-relay-channel-binding/1");

/**
 * The two Noise handshake messages one end of a channel sent and accepted, as the carrier saw them.
 * Both ends of one handshake hold the same pair; a relay that runs a handshake of its own with each
 * end (with its own key toward the phone) leaves each end a different pair, since it cannot make
 * the PC's first message's DH with the PC's secret key.
 */
interface HandshakeRecord {
  hello?: string;
  ready?: string;
  /** the client's latest inbound handshake text: the ready the vendor accepts is the one that opens it */
  latest?: string;
}
const bindings = new WeakMap<Channel, { record: HandshakeRecord; serverPublicKey: Uint8Array }>();

const carrierText = (data: string | ArrayBuffer): string => typeof data === "string" ? data : new TextDecoder().decode(data);

/** The protected Noise message of a hello or ready envelope (shared/vendor/paseo-e2ee/secure-channel.ts). */
function handshakeMessage(text: string | undefined): Uint8Array | undefined {
  if (text === undefined) return;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("protected" in value)) return;
    const envelope = value.protected;
    if (typeof envelope !== "object" || envelope === null || !("message" in envelope) || typeof envelope.message !== "string") return;
    return Uint8Array.from(atob(envelope.message), (c) => c.charCodeAt(0));
  } catch { return; }
}

const lengthPrefixed = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

/**
 * 32 bytes both ends of one protected handshake agree on and nobody else can make them share:
 * SHA-256 over a domain, the PC's static key and the two handshake messages. The pairing by
 * comparing digits (shared/relay-pair-sas.ts) is bound to it.
 */
export function channelBinding(channel: Channel): Uint8Array | undefined {
  const entry = bindings.get(channel);
  if (!entry || !channel.isOpen() || channel.securityMode() !== "protected") return;
  const hello = handshakeMessage(entry.record.hello);
  const ready = handshakeMessage(entry.record.ready);
  if (!hello || !ready) return;
  return sha256(concatBytes(BINDING_DOMAIN, entry.serverPublicKey, lengthPrefixed(hello), lengthPrefixed(ready)));
}

interface CarrierGuard {
  readonly transport: Transport;
  readonly endHandshake: () => void;
  readonly isClosed: () => boolean;
}

/**
 * Sits between the carrier and the vendored channel, which decodes and allocates a whole
 * message before any mux limit applies: an oversized message closes the carrier undecoded.
 * With `budget`, messages that arrive before the handshake completes count against the
 * per-connection and process-wide handshake limits, and the carrier closes past them.
 */
function guardCarrier(real: Transport, closeCode: () => number, budget: boolean,
  record: (direction: "in" | "out", data: string | ArrayBuffer) => void): CarrierGuard {
  let closed = false;
  const closing = Promise.withResolvers<never>();
  closing.promise.catch(() => {});
  let counting = budget;
  let messages = 0;
  let bytes = 0;
  const endHandshake = () => {
    if (!counting) return;
    counting = false;
    handshakeInboundBytes -= bytes;
  };
  const markClosed = () => {
    endHandshake();
    closed = true;
    closing.reject(new Error("Carrier closed"));
  };
  const refuse = (code: number, reason: string) => {
    if (closed) return;
    markClosed();
    real.close(code, reason);
  };
  const transport: Transport = {
    // Only a handshake send needs the race; afterwards each send would keep a reaction until close.
    send: (data) => { record("out", data); return sendGuarded(data); },
    close: (code, reason) => {
      markClosed();
      real.close(code, reason);
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const sendGuarded = (data: string | ArrayBuffer) => closed ? Promise.reject(new Error("Carrier closed"))
      : counting ? Promise.race([new Promise<void>((resolve) => resolve(real.send(data))), closing.promise])
      : real.send(data);
  real.onmessage = (message: TransportMessage) => {
    if (closed) return;
    const { data, isBinary } = message;
    if (!isBinary) record("in", data);
    const size = typeof data === "string" ? data.length : data.byteLength;
    // The vendor reads a text frame as base64 even when its data arrives as an ArrayBuffer.
    if (isBinary ? size > MAX_CARRIER_BINARY_BYTES
      : size > MAX_CARRIER_TEXT_BYTES || base64Bytes(data) > MAX_CARRIER_BINARY_BYTES) {
      refuse(closeCode(), "Carrier message too large");
      return;
    }
    if (counting) {
      const charge = (typeof data === "string" ? new TextEncoder().encode(data).byteLength : size)
        + HANDSHAKE_MESSAGE_OVERHEAD_BYTES;
      messages += 1;
      bytes += charge;
      handshakeInboundBytes += charge;
      if (messages > MAX_HANDSHAKE_INBOUND_MESSAGES || bytes > MAX_HANDSHAKE_INBOUND_BYTES
        || handshakeInboundBytes > MAX_HANDSHAKE_INBOUND_BYTES_TOTAL) {
        refuse(PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, "Too much handshake traffic");
        return;
      }
    }
    return transport.onmessage?.(message);
  };
  real.onclose = (code, reason) => {
    markClosed();
    transport.onclose?.(code, reason);
  };
  real.onerror = (error) => transport.onerror?.(error);
  return { transport, endHandshake, isClosed: () => closed };
}

function base64Bytes(text: string | ArrayBuffer): number {
  const length = typeof text === "string" ? text.length : text.byteLength;
  const code = typeof text === "string" ? (at: number) => text.charCodeAt(at) : (at: number) => new Uint8Array(text, at, 1)[0];
  const padding = length > 0 && code(length - 1) === 61 ? (length > 1 && code(length - 2) === 61 ? 2 : 1) : 0;
  return Math.floor((length - padding) * 3 / 4);
}

const byteLength = (data: string | ArrayBuffer, limit: number) =>
  typeof data !== "string" ? data.byteLength
    : data.length > limit ? data.length : new TextEncoder().encode(data).byteLength;

export async function openClientSecureChannel(transport: Transport, options: ClientSecureChannelOptions) {
  // Never put application sends into the vendor's separate pre-open queue: it can
  // be overtaken by onopen sends. One chain waits for the handshake, then sends all.
  const ready = Promise.withResolvers<void>();
  let handshaking = true;
  let pending = 0;
  let pendingBytes = 0;
  let closeError: Error | undefined;
  const outstanding = new Set<(error: Error) => void>();
  const rejectSends = () => {
    closeError ??= new Error("Secure channel closed");
    ready.resolve();
    for (const reject of outstanding) reject(closeError);
    outstanding.clear();
  };
  const record: HandshakeRecord = {};
  const guard = guardCarrier(transport,
    () => handshaking ? PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE : PROTECTED_RECORD_FAILED_CLOSE_CODE, false,
    (direction, data) => {
      if (!handshaking || typeof data !== "string" && !(data instanceof ArrayBuffer)) return;
      if (direction === "out") record.hello ??= carrierText(data);
      else record.latest = carrierText(data);
    });
  const channel = await openClient(guard.transport, {
    ...options, minimumMode: "protected",
    events: {
      ...options.events,
      onopen: () => {
        handshaking = false;
        record.ready = record.latest;
        ready.resolve();
        options.events?.onopen?.();
      },
      onclose: (code, reason) => {
        handshaking = false;
        rejectSends();
        options.events?.onclose?.(code, reason);
      },
    },
  });
  bindings.set(channel, { record, serverPublicKey: importKey(options.daemonPublicKeyB64) });
  channel.onClose(rejectSends);
  const send = channel.send.bind(channel);
  let chain = ready.promise;
  channel.send = (data) => {
    if (closeError) return Promise.reject(closeError);
    if (handshaking) {
      if (pending >= MAX_PRE_OPEN_SENDS) return Promise.reject(new RangeError("Too many pre-open sends"));
      const size = byteLength(data, MAX_PRE_OPEN_SEND_BYTES);
      if (pendingBytes + size > MAX_PRE_OPEN_SEND_BYTES) return Promise.reject(new RangeError("Too many pre-open bytes"));
      pending += 1;
      pendingBytes += size;
    }
    const result = Promise.withResolvers<void>();
    outstanding.add(result.reject);
    chain = chain.then(() => {
      if (closeError) throw closeError;
      return send(data);
    });
    void chain.then(() => {
      outstanding.delete(result.reject);
      result.resolve();
    }, (error: unknown) => {
      outstanding.delete(result.reject);
      result.reject(error);
    });
    return result.promise;
  };
  return channel;
}

export function openDaemonSecureChannel(transport: Transport, options: DaemonSecureChannelOptions) {
  let handshaking = true;
  // the daemon answers the first message it gets, which must be the hello, with its first send
  const record: HandshakeRecord = {};
  const guard = guardCarrier(transport,
    () => handshaking ? PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE : DAEMON_RECORD_FAILURE_CLOSE_CODE, true,
    (direction, data) => {
      if (typeof data !== "string" && !(data instanceof ArrayBuffer)) return;
      if (direction === "in") record.hello ??= carrierText(data);
      else record.ready ??= carrierText(data);
    });
  const opening = openDaemon(guard.transport, {
    ...options, minimumMode: "protected",
    events: {
      ...options.events,
      // The vendor may finish a handshake whose carrier already closed; that channel never opens.
      onopen: () => {
        handshaking = false;
        guard.endHandshake();
        if (!guard.isClosed()) options.events?.onopen?.();
      },
      // The vendor replays its queued messages right after onopen, past the guard.
      onmessage: (data) => {
        if (!guard.isClosed()) options.events?.onmessage?.(data);
      },
    },
  });
  // A refused handshake keeps counting until its carrier closes: the vendor may still queue.
  return opening.then((channel) => {
    if (guard.isClosed()) throw new Error("Connection closed during handshake");
    bindings.set(channel, { record, serverPublicKey: options.daemonKeyPair.publicKey });
    return channel;
  });
}

export {
  generateKeyPair, exportPublicKey, importPublicKey, exportSecretKey, importSecretKey,
  SecureChannelRejectedError, PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_CODE, PROTECTED_MODE_REQUIRED_CLOSE_REASON,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
} from "./vendor/paseo-e2ee/e2ee.ts";
export type {
  SecureChannel,
  SecureChannelEvents, SecurityMode, Transport, TransportMessage, KeyPair, SharedKey,
} from "./vendor/paseo-e2ee/e2ee.ts";
