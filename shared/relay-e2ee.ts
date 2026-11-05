import {
  openClientSecureChannel as openClient, openDaemonSecureChannel as openDaemon,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, PROTECTED_RECORD_FAILED_CLOSE_CODE,
} from "./vendor/paseo-e2ee/e2ee.ts";
import type {
  ClientSecureChannelOptions as ClientOptions, DaemonSecureChannelOptions as DaemonOptions, Transport,
  TransportMessage,
} from "./vendor/paseo-e2ee/e2ee.ts";
import { protectedRecordByteLength } from "./vendor/paseo-e2ee/protected-records.ts";
import { MAX_FRAME_BYTES } from "./relay-mux.ts";

export type ClientSecureChannelOptions = Omit<ClientOptions, "minimumMode">;
export type DaemonSecureChannelOptions = Omit<DaemonOptions, "minimumMode">;

/** The largest carrier message a mux frame produces once protected, as binary and as base64 text. */
export const MAX_CARRIER_BINARY_BYTES = protectedRecordByteLength(MAX_FRAME_BYTES);
export const MAX_CARRIER_TEXT_BYTES = 4 * Math.ceil(MAX_CARRIER_BINARY_BYTES / 3);
/** What one client may queue before its handshake completes. */
export const MAX_PRE_OPEN_SENDS = 200;
export const MAX_PRE_OPEN_SEND_BYTES = 1 << 20;
/** What the daemon holds for one connection, and for all of them, until a handshake completes. */
export const MAX_HANDSHAKE_INBOUND_MESSAGES = 256;
export const MAX_HANDSHAKE_INBOUND_BYTES = 2 << 20;
export const MAX_HANDSHAKE_INBOUND_BYTES_TOTAL = 16 << 20;
/** Charged per queued message on top of its data, so empty messages cannot escape the byte budgets. */
export const HANDSHAKE_MESSAGE_OVERHEAD_BYTES = 64;
const DAEMON_RECORD_FAILURE_CLOSE_CODE = 1011;

let handshakeInboundBytes = 0;

interface CarrierGuard {
  readonly transport: Transport;
  /** Stops counting inbound messages against the handshake budgets and releases their bytes. */
  readonly endHandshake: () => void;
  readonly isClosed: () => boolean;
}

/**
 * Sits between the carrier and the vendored channel, which decodes and allocates a whole
 * message before any mux limit applies: an oversized message closes the carrier undecoded.
 * With `budget`, messages that arrive before the handshake completes count against the
 * per-connection and process-wide handshake limits, and the carrier closes past them.
 */
function guardCarrier(real: Transport, closeCode: () => number, budget: boolean): CarrierGuard {
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
    // A send still in flight (the daemon's ready, holding its queued messages) fails with the carrier.
    closing.reject(new Error("Carrier closed"));
  };
  const refuse = (code: number, reason: string) => {
    if (closed) return;
    markClosed();
    real.close(code, reason);
  };
  const transport: Transport = {
    // Only a handshake send needs the race; afterwards each send would keep a reaction until close.
    send: (data) => closed ? Promise.reject(new Error("Carrier closed"))
      : counting ? Promise.race([new Promise<void>((resolve) => resolve(real.send(data))), closing.promise])
      : real.send(data),
    close: (code, reason) => {
      markClosed();
      real.close(code, reason);
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  real.onmessage = (message: TransportMessage) => {
    if (closed) return;
    const { data, isBinary } = message;
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

/** The bytes a base64 text decodes to; other text (the JSON handshake) is only bounded by its length. */
function base64Bytes(text: string | ArrayBuffer): number {
  const length = typeof text === "string" ? text.length : text.byteLength;
  const code = typeof text === "string" ? (at: number) => text.charCodeAt(at) : (at: number) => new Uint8Array(text, at, 1)[0];
  const padding = length > 0 && code(length - 1) === 61 ? (length > 1 && code(length - 2) === 61 ? 2 : 1) : 0;
  return Math.floor((length - padding) * 3 / 4);
}

/** UTF-8 bytes, without encoding a string whose length alone already exceeds `limit`. */
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
  const guard = guardCarrier(transport,
    () => handshaking ? PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE : PROTECTED_RECORD_FAILED_CLOSE_CODE, false);
  const channel = await openClient(guard.transport, {
    ...options, minimumMode: "protected",
    events: {
      ...options.events,
      onopen: () => {
        handshaking = false;
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
    // Caller settlement must not wait for an in-flight transport promise on close.
    // Remove settled callers rather than retaining one close listener per send.
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
  const guard = guardCarrier(transport,
    () => handshaking ? PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE : DAEMON_RECORD_FAILURE_CLOSE_CODE, true);
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
