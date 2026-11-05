import { createScanner, ScanError, SyntaxKind } from "jsonc-parser";

/** The relay wire generation: the envelope's first byte and WELCOME's `relay_protocol`. A PC on another one is refused outright. */
export const RELAY_PROTOCOL = 1;
/**
 * The oldest Ovis server the hosted shell connects to: 0.4.21 (package.json read 0.4.20 when the
 * relay landed; v0.4.21 itself holds no server/relay/, so the first release that does is newer).
 * Raise it only in a PR that makes the shell need a newer server API, with a changelog line. A
 * server below it gets the update screen (src/lib/relay/skew.ts). No CI job runs the shell against
 * older releases yet: that comes with the relay end-to-end run, once a release holds server/relay/.
 *
 * A branch the shell keeps for a server older than its own version is marked
 * `// COMPAT(relay): added in <v>, remove after <v+2>`, so raising this constant finds it.
 */
export const MIN_SERVER_VERSION = "0.4.21";
export const MAX_FRAME_BYTES = 16384;
export const ENVELOPE_BYTES = 8;
export const WS_START_CAPACITY = 16372;
export const WS_CONTINUATION_CAPACITY = 16376;

export const FrameType = {
  HELLO: 0x01, WELCOME: 0x02, AUTH: 0x03, AUTH_OK: 0x04,
  SESSION_ERROR: 0x05, GOAWAY: 0x06, PING: 0x07, PONG: 0x08,
  RECEIVED: 0x09, PAIR: 0x0a,
  HTTP_OPEN: 0x10, HTTP_ACCEPT: 0x11, HTTP_HEADERS: 0x12,
  HTTP_DATA: 0x13, HTTP_END: 0x14, HTTP_STOP_REQUEST: 0x15,
  WS_OPEN: 0x20, WS_ACCEPT: 0x21, WS_DATA: 0x22, WS_CLOSE: 0x23,
  CREDIT: 0x30, RESET: 0x31,
} as const;
export type FrameType = typeof FrameType[keyof typeof FrameType];
export const HTTP_END_FLAGS = { STOPPED: 0x0001 } as const;
export const WS_DATA_FLAGS = { START: 0x0001, END: 0x0002, TEXT: 0x0004 } as const;

export const SESSION_ERRORS = [
  "unsupported_version", "unsupported_extension", "unsupported_transport",
  "protocol_error", "auth_failed", "auth_revoked", "auth_changed",
  "flow_control_error", "resource_exhausted", "timeout", "internal_error",
] as const;
export type SessionError = typeof SESSION_ERRORS[number];
export const STREAM_ERRORS = [
  "cancelled", "refused", "bad_request", "body_too_large", "message_too_large",
  "stream_protocol_error", "upstream_lost", "slow_consumer", "resource_exhausted", "internal_error",
] as const;
export type StreamError = typeof STREAM_ERRORS[number];

export class MuxProtocolError extends Error {
  constructor(readonly code: SessionError, message: string) {
    super(message);
    this.name = "MuxProtocolError";
  }
}

export const LIMITS_V1 = {
  max_streams: 32, max_ws_streams: 8, max_sse_streams: 4,
  max_frame_bytes: 16384, http_window_bytes: 327680, ws_window_bytes: 1048576,
  max_ws_message_bytes: 1048576, max_request_body_bytes: 67108864,
} as const;
export type LimitsV1 = Omit<typeof LIMITS_V1, "max_streams" | "max_ws_streams" | "max_sse_streams"> & {
  readonly max_streams: number;
  readonly max_ws_streams: number;
  readonly max_sse_streams: number;
};

export const REQUEST_HEADERS = [
  "content-type", "accept", "range", "if-none-match", "if-modified-since",
  "content-length", "x-request-id", "x-herdr-machine", "x-herdr-update", "last-event-id",
] as const;
export const RESPONSE_HEADERS = [
  "content-type", "content-length", "content-range", "accept-ranges", "etag",
  "last-modified", "cache-control", "content-disposition", "retry-after", "x-request-id",
  "content-security-policy", "x-content-type-options", "cross-origin-resource-policy", "referrer-policy",
] as const;
/** The only read-only routes a browser resource may load through a shell worker. */
export const RELAY_RESOURCE_ROUTES = ["fs/file", "fs/favicon", "pane/conversation/image"] as const;
/** Also stamped into the classic service worker, from this one allowlist. Never decode the query. */
export const RELAY_RESOURCE_TARGET = `^/api/(?:machines/(?!(?:\\.|%2[eE]){1,2}/)(?:[A-Za-z0-9_!~*'().-]|%[0-9A-Fa-f]{2})+/)?(?:${RELAY_RESOURCE_ROUTES.join("|")})(?:\\?[^#\\r\\n]*)?$(?![\\s\\S])`;

export function isRelayResourceTarget(target: string): boolean {
  return new RegExp(RELAY_RESOURCE_TARGET).test(target);
}

export function relayResourcePath(serverId: string, target: string): string {
  if (!/^[0-9a-f]{32}$/.test(serverId) || !isRelayResourceTarget(target)) throw new TypeError("Invalid relay resource target");
  return `/s/${serverId}/~${target}`;
}

/** A path inside precisely this registration; no URL normalization or query reserialization. */
export function relayResourceTarget(scope: string, path: string): string | null {
  if (!/^\/s\/[0-9a-f]{32}\/$/.test(scope) || !path.startsWith(`${scope}~`)) return null;
  const target = path.slice(scope.length + 1);
  return isRelayResourceTarget(target) ? target : null;
}
export type HeaderList = readonly (readonly [string, string])[];
type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type JsonObject = { readonly [key: string]: unknown };
type Payloads = {
  readonly 0x01: { readonly protocol: "ovis-mux"; readonly versions: readonly number[]; readonly features: readonly string[]; readonly required_features: readonly string[] };
  readonly 0x02: { readonly protocol: "ovis-mux"; readonly version: 1; readonly features: readonly string[]; readonly limits: LimitsV1; readonly nonce: string; readonly server_version: string; readonly relay_protocol: number; readonly min_supported_client: string };
  readonly 0x03: { readonly scheme: "device-key"; readonly device_id: string; readonly signature: string };
  readonly 0x04: { readonly session_id: string; readonly device_id: string; readonly role: "drive" | "watch" };
  readonly 0x05: { readonly code: SessionError; readonly message: string };
  readonly 0x06: { readonly code: "shutdown" | "id_exhausted"; readonly last_open_id: number; readonly drain_ms: number };
  readonly 0x07: bigint;
  readonly 0x08: bigint;
  readonly 0x09: bigint;
  readonly 0x0a: { readonly code: string; readonly label: string; readonly public_key: string };
  readonly 0x10: { readonly device_id: string; readonly method: Method; readonly target: string; readonly headers: HeaderList; readonly body: "none" | "stream" };
  readonly 0x11: null;
  readonly 0x12: { readonly status: number; readonly headers: HeaderList };
  readonly 0x13: Uint8Array;
  readonly 0x14: { readonly trailers: HeaderList };
  readonly 0x15: null;
  readonly 0x20: { readonly device_id: string; readonly target: string; readonly headers: HeaderList; readonly protocols: readonly string[] };
  readonly 0x21: { readonly protocol: string | null; readonly headers: HeaderList };
  readonly 0x22: { readonly data: Uint8Array; readonly total_message_bytes?: number };
  readonly 0x23: { readonly code: number | null; readonly reason: string; readonly abort: boolean };
  readonly 0x30: bigint;
  readonly 0x31: { readonly code: StreamError; readonly message: string };
};
export type MuxFrame = {
  [T in FrameType]: { readonly type: T; readonly flags: number; readonly stream_id: number; readonly payload: Payloads[T] }
}[FrameType];

function requireProtocol(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MuxProtocolError("protocol_error", message);
}

/** Counts UTF-8 without allocating an encoded copy. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function text(value: unknown, maxBytes = MAX_FRAME_BYTES): string {
  requireProtocol(typeof value === "string" && value.length <= maxBytes && utf8Bytes(value) <= maxBytes, "Invalid string");
  return value;
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): JsonObject {
  requireProtocol(isObject(value), "Expected metadata object");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  requireProtocol(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max, "Invalid integer");
  return value;
}
function choice<const T extends readonly (string | number)[]>(value: unknown, choices: T): T[number] {
  for (const candidate of choices) if (value === candidate) return candidate;
  throw new MuxProtocolError("protocol_error", "Invalid value");
}
function hex(value: unknown, length: number): string {
  const result = text(value, length);
  requireProtocol(result.length === length && /^[0-9a-f]+$/.test(result), "Invalid hex identifier");
  return result;
}
function base64url(value: unknown, bytes: number): string {
  const result = text(value, Math.ceil(bytes * 4 / 3));
  requireProtocol(result.length === Math.ceil(bytes * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(result), "Invalid base64url length or alphabet");
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(result.at(-1) ?? "");
  requireProtocol(bytes % 3 === 0 || (last & (bytes % 3 === 1 ? 15 : 3)) === 0, "Noncanonical base64url");
  return result;
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export function validateHeaders(value: unknown, kind: "request" | "response" | "trailers", filterRequestHeaders = false): HeaderList {
  requireProtocol(Array.isArray(value) && value.length <= 64, "Invalid header list");
  let bytes = 0;
  let contentLength: string | undefined;
  const headers: (readonly [string, string])[] = [];
  const allowed: readonly string[] = kind === "request" ? REQUEST_HEADERS : RESPONSE_HEADERS;
  for (const pair of value) {
    requireProtocol(Array.isArray(pair) && pair.length === 2, "Invalid header pair");
    const name = text(pair[0], 12288);
    const val = text(pair[1], 12288);
    bytes += utf8Bytes(name) + utf8Bytes(val) + 4;
    requireProtocol(bytes <= 12288 && HTTP_TOKEN.test(name) && name === name.toLowerCase()
      && !/[\r\n\0]/.test(val), "Forbidden or oversized header");
    if (kind === "request" && filterRequestHeaders && !allowed.includes(name)) continue;
    requireProtocol(allowed.includes(name), "Forbidden or oversized header");
    if (kind === "trailers") {
      requireProtocol(!["content-length", "content-range", "content-type", "content-disposition", "x-request-id"].includes(name), "Forbidden trailer");
    }
    if (name === "content-length") {
      requireProtocol(/^[0-9]+$/.test(val) && (contentLength === undefined || contentLength === val), "Conflicting content-length");
      contentLength = val;
    }
    headers.push([name, val]);
  }
  return headers;
}

export function validateTarget(value: unknown): string {
  const target = text(value, 4096);
  requireProtocol(target.startsWith("/") && !target.startsWith("//") && !/[\\#\x00-\x20\x7f]/.test(target), "Invalid target");
  const path = target.split("?")[0] ?? "";
  requireProtocol(!path.includes("//") && (path === "/" || !path.endsWith("/")) && !/%2f|%5c/i.test(path), "Noncanonical target");
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch (error) {
    if (error instanceof URIError) throw new MuxProtocolError("protocol_error", "Invalid target escape");
    throw error;
  }
  requireProtocol(!/[\\#\x00-\x1f\x7f]/.test(decoded) && !decoded.split("/").some((part) => part === "." || part === ".."), "Noncanonical target");
  return target;
}

function list<T>(value: unknown, max: number, parse: (entry: unknown) => T): readonly T[] {
  requireProtocol(Array.isArray(value) && value.length <= max, "Invalid list");
  const result = value.map(parse);
  requireProtocol(new Set(result).size === result.length, "Duplicate list entry");
  return result;
}
function feature(value: unknown): string {
  const result = text(value, 32);
  requireProtocol(/^[a-z0-9-]{1,32}$/.test(result), "Invalid feature");
  return result;
}
function protocol(value: unknown): string {
  const result = text(value, 128);
  requireProtocol(HTTP_TOKEN.test(result), "Invalid WS subprotocol");
  return result;
}
function limits(value: unknown): LimitsV1 {
  const v = object(value);
  for (const key of ["max_frame_bytes", "http_window_bytes", "ws_window_bytes", "max_ws_message_bytes", "max_request_body_bytes"] as const) {
    requireProtocol(v[key] === LIMITS_V1[key], "Invalid v1 limit");
  }
  return {
    ...LIMITS_V1,
    max_streams: integer(v.max_streams, 1, 32),
    max_ws_streams: integer(v.max_ws_streams, 1, 8),
    max_sse_streams: integer(v.max_sse_streams, 1, 4),
  };
}
function streamId(value: unknown, allowZero: boolean): number {
  const id = integer(value, allowZero ? 0 : 1, 0x7fffffff);
  requireProtocol(id === 0 || id % 2 === 1, "Reserved stream id");
  return id;
}
function frameLimit(type: FrameType): number {
  switch (type) {
    case FrameType.HELLO: case FrameType.WELCOME: return 4096;
    case FrameType.HTTP_OPEN: case FrameType.HTTP_HEADERS: case FrameType.HTTP_DATA:
    case FrameType.HTTP_END: case FrameType.WS_OPEN: case FrameType.WS_ACCEPT:
    case FrameType.WS_DATA: return MAX_FRAME_BYTES;
    default: return 1024;
  }
}
function envelope(type: unknown, flags: unknown, id: unknown, size: number): FrameType {
  const t = choice(type, Object.values(FrameType));
  requireProtocol(size >= ENVELOPE_BYTES && size <= MAX_FRAME_BYTES && size <= frameLimit(t), "Invalid frame length");
  const f = integer(flags, 0, 0xffff);
  const mask = t === FrameType.HTTP_END ? 1 : t === FrameType.WS_DATA ? 7 : 0;
  requireProtocol((f & ~mask) === 0 && (t !== FrameType.WS_DATA || !(f & 4) || !!(f & 1)), "Reserved flags");
  if (t <= FrameType.PAIR) requireProtocol(id === 0, "Session frame needs stream zero");
  else streamId(id, false);
  return t;
}

/** Only payload-local rules live here; ordering, reassembly and credit belong to the engine. */
function metadata(type: FrameType, flags: number, stream_id: number, input: unknown, filterRequestHeaders = false): MuxFrame {
  const v = object(input);
  const common = { flags, stream_id };
  switch (type) {
    case FrameType.HELLO: {
      requireProtocol(v.protocol === "ovis-mux", "Invalid protocol");
      const versions = list(v.versions, 8, (n) => integer(n, 1, 65535));
      requireProtocol(versions.length > 0, "Empty versions");
      const features = list(v.features, 16, feature);
      const required_features = list(v.required_features, 16, feature);
      requireProtocol(required_features.every((f) => features.includes(f)), "Required features not offered");
      return { ...common, type, payload: { protocol: "ovis-mux", versions, features, required_features } };
    }
    case FrameType.WELCOME:
      requireProtocol(v.protocol === "ovis-mux" && v.version === 1, "Invalid welcome protocol");
      // another relay_protocol is read, not refused here: the shell names it an update (src/lib/relay/channel.ts)
      return { ...common, type, payload: { protocol: "ovis-mux", version: 1, features: list(v.features, 16, feature), limits: limits(v.limits),
        nonce: base64url(v.nonce, 32), server_version: text(v.server_version, 64), relay_protocol: integer(v.relay_protocol, 1, 65535), min_supported_client: text(v.min_supported_client, 64) } };
    case FrameType.AUTH:
      requireProtocol(v.scheme === "device-key", "Invalid auth scheme");
      return { ...common, type, payload: { scheme: "device-key", device_id: hex(v.device_id, 16), signature: base64url(v.signature, 64) } };
    case FrameType.PAIR: {
      const code = text(v.code, 6);
      requireProtocol(/^[0-9]{6}$/.test(code), "Invalid pairing code");
      // DER SubjectPublicKeyInfo for id-ecPublicKey + prime256v1 + an uncompressed P-256 point.
      const public_key = base64url(v.public_key, 91);
      const der = atob(public_key.replace(/-/g, "+").replace(/_/g, "/"));
      const prefix = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04];
      requireProtocol(prefix.every((byte, i) => der.charCodeAt(i) === byte), "Invalid P-256 SPKI");
      const label = text(v.label, 256);
      requireProtocol([...label].length <= 64, "Pair label too long");
      return { ...common, type, payload: { code, label, public_key } };
    }
    case FrameType.AUTH_OK:
      return { ...common, type, payload: { session_id: hex(v.session_id, 32), device_id: hex(v.device_id, 16), role: choice(v.role, ["drive", "watch"]) } };
    case FrameType.SESSION_ERROR:
      return { ...common, type, payload: { code: choice(v.code, SESSION_ERRORS), message: text(v.message, 256) } };
    case FrameType.GOAWAY:
      return { ...common, type, payload: { code: choice(v.code, ["shutdown", "id_exhausted"]), last_open_id: streamId(v.last_open_id, true), drain_ms: integer(v.drain_ms, 0, 5000) } };
    case FrameType.HTTP_OPEN: {
      const method = choice(v.method, ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
      const body = choice(v.body, ["none", "stream"]);
      requireProtocol((method !== "GET" && method !== "HEAD") || body === "none", "GET/HEAD body forbidden");
      return { ...common, type, payload: { device_id: hex(v.device_id, 16), method, target: validateTarget(v.target), headers: validateHeaders(v.headers, "request", filterRequestHeaders), body } };
    }
    case FrameType.HTTP_HEADERS: {
      const status = integer(v.status, 100, 599);
      requireProtocol(status !== 101, "Upgrade not tunneled");
      return { ...common, type, payload: { status, headers: validateHeaders(v.headers, "response") } };
    }
    case FrameType.HTTP_END: {
      const trailers = validateHeaders(v.trailers, "trailers");
      requireProtocol(!(flags & HTTP_END_FLAGS.STOPPED) || trailers.length === 0, "Stopped END needs empty trailers");
      return { ...common, type, payload: { trailers } };
    }
    case FrameType.WS_OPEN:
      return { ...common, type, payload: { device_id: hex(v.device_id, 16), target: validateTarget(v.target), headers: validateHeaders(v.headers, "request", filterRequestHeaders), protocols: list(v.protocols, 8, protocol) } };
    case FrameType.WS_ACCEPT:
      return { ...common, type, payload: { protocol: v.protocol === null ? null : protocol(v.protocol), headers: validateHeaders(v.headers, "response") } };
    case FrameType.WS_CLOSE: {
      const code = v.code === null ? null : integer(v.code, 1000, 4999);
      const reason = text(v.reason, 123);
      requireProtocol(code === null ? reason === "" : (code <= 1014 && ![1004, 1005, 1006].includes(code)) || code >= 3000, "Invalid WS close status");
      requireProtocol(typeof v.abort === "boolean", "Invalid abort flag");
      return { ...common, type, payload: { code, reason, abort: v.abort } };
    }
    case FrameType.RESET:
      return { ...common, type, payload: { code: choice(v.code, STREAM_ERRORS), message: text(v.message, 256) } };
    default: throw new MuxProtocolError("protocol_error", "Not a metadata frame");
  }
}

function wsFragment(flags: number, data: Uint8Array, total: unknown): Payloads[0x22] {
  if (flags & WS_DATA_FLAGS.START) {
    const length = integer(total, 0, LIMITS_V1.max_ws_message_bytes);
    requireProtocol(data.byteLength <= length && (!!(flags & WS_DATA_FLAGS.END) ? data.byteLength === length : data.byteLength < length), "Invalid first fragment length");
    requireProtocol(data.byteLength > 0 || ((flags & 3) === 3 && length === 0), "Empty nonfinal fragment");
    return { total_message_bytes: length, data };
  }
  requireProtocol(total === undefined && data.byteLength > 0, "Invalid continuation");
  return { data };
}

/** Iterative scan catches escaped duplicate keys, including unknown nested metadata. */
function parseMetadata(bytes: Uint8Array): unknown {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) {
    if (error instanceof TypeError) throw new MuxProtocolError("protocol_error", "Invalid UTF-8 metadata");
    throw error;
  }
  const scanner = createScanner(source);
  const objects: Set<string>[] = [];
  let previous = SyntaxKind.Unknown;
  let stringValue = "";
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    requireProtocol(scanner.getTokenError() === ScanError.None, "Invalid JSON token");
    if (token === SyntaxKind.Trivia || token === SyntaxKind.LineBreakTrivia) continue;
    switch (token) {
      case SyntaxKind.OpenBraceToken: objects.push(new Set()); break;
      case SyntaxKind.CloseBraceToken: objects.pop(); break;
      case SyntaxKind.StringLiteral: stringValue = scanner.getTokenValue(); break;
      case SyntaxKind.ColonToken: {
        const keys = objects.at(-1);
        requireProtocol(previous === SyntaxKind.StringLiteral && keys && !keys.has(stringValue), "Duplicate or invalid JSON key");
        keys.add(stringValue);
        break;
      }
      default: break;
    }
    previous = token;
  }
  try { return JSON.parse(source); }
  catch (error) {
    if (error instanceof SyntaxError) throw new MuxProtocolError("protocol_error", "Invalid JSON metadata");
    throw error;
  }
}

export function decodeFrame(bytes: Uint8Array, filterRequestHeaders = false): MuxFrame {
  // These gates precede views, slices, UTF-8 decoding and JSON parsing.
  requireProtocol(bytes instanceof Uint8Array && bytes.byteLength >= ENVELOPE_BYTES && bytes.byteLength <= MAX_FRAME_BYTES, "Invalid frame length");
  if (bytes[0] !== RELAY_PROTOCOL) throw new MuxProtocolError("unsupported_version", "Unsupported envelope version");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(2);
  const stream_id = view.getUint32(4);
  const type = envelope(bytes[1], flags, stream_id, bytes.byteLength);
  const payload = bytes.subarray(ENVELOPE_BYTES);
  switch (type) {
    case FrameType.HTTP_ACCEPT: case FrameType.HTTP_STOP_REQUEST:
      requireProtocol(payload.byteLength === 0, "Expected empty payload");
      return { type, flags, stream_id, payload: null };
    case FrameType.PING: case FrameType.PONG: case FrameType.RECEIVED: case FrameType.CREDIT:
      requireProtocol(payload.byteLength === 8, "Expected u64");
      return { type, flags, stream_id, payload: view.getBigUint64(8) };
    case FrameType.HTTP_DATA:
      requireProtocol(payload.byteLength > 0, "Empty DATA forbidden");
      return { type, flags, stream_id, payload };
    case FrameType.WS_DATA: {
      const start = !!(flags & WS_DATA_FLAGS.START);
      requireProtocol(!start || payload.byteLength >= 4, "Missing START length");
      return { type, flags, stream_id, payload: wsFragment(flags, start ? payload.subarray(4) : payload, start ? view.getUint32(8) : undefined) };
    }
    default: return metadata(type, flags, stream_id, parseMetadata(payload), filterRequestHeaders);
  }
}

/** Exact JSON wire size, before allocating serialization or encoded bytes. */
function jsonBytes(value: unknown): number {
  if (typeof value === "string") {
    let size = 2;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) size += 2;
      else if (c < 32) size += 6;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
      else if (c >= 0xd800 && c <= 0xdfff) size += 6;
      else size += c < 128 ? 1 : c < 2048 ? 2 : 3;
    }
    return size;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value).length;
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum: number, entry: unknown) => sum + jsonBytes(entry), 0);
  const entries = Object.entries(object(value));
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, entry]) => sum + jsonBytes(key) + 1 + jsonBytes(entry), 0);
}

export function encodeFrame(frame: MuxFrame): Uint8Array {
  const { flags, stream_id } = frame;
  const type = envelope(frame.type, flags, stream_id, ENVELOPE_BYTES);
  let payload: Uint8Array | bigint | JsonObject | null;
  let size: number;
  let startLength: number | undefined;
  switch (frame.type) {
    case FrameType.HTTP_ACCEPT: case FrameType.HTTP_STOP_REQUEST:
      requireProtocol(frame.payload === null, "Expected empty payload");
      payload = null; size = 0; break;
    case FrameType.PING: case FrameType.PONG: case FrameType.RECEIVED: case FrameType.CREDIT:
      requireProtocol(typeof frame.payload === "bigint" && frame.payload >= 0n && frame.payload <= 0xffffffffffffffffn, "Invalid u64");
      payload = frame.payload; size = 8; break;
    case FrameType.HTTP_DATA:
      requireProtocol(frame.payload instanceof Uint8Array && frame.payload.byteLength > 0, "Invalid DATA");
      payload = frame.payload; size = payload.byteLength; break;
    case FrameType.WS_DATA: {
      requireProtocol(frame.payload.data instanceof Uint8Array, "Invalid fragment bytes");
      const fragment = wsFragment(flags, frame.payload.data, frame.payload.total_message_bytes);
      payload = fragment.data; startLength = fragment.total_message_bytes;
      size = payload.byteLength + (startLength === undefined ? 0 : 4);
      break;
    }
    default:
      payload = object(metadata(type, flags, stream_id, frame.payload).payload);
      size = jsonBytes(payload);
  }
  envelope(type, flags, stream_id, size + ENVELOPE_BYTES);
  const result = new Uint8Array(size + ENVELOPE_BYTES);
  const view = new DataView(result.buffer);
  result[0] = RELAY_PROTOCOL; result[1] = type;
  view.setUint16(2, flags); view.setUint32(4, stream_id);
  if (typeof payload === "bigint") view.setBigUint64(8, payload);
  else if (payload instanceof Uint8Array) {
    if (startLength !== undefined) view.setUint32(8, startLength);
    result.set(payload, startLength === undefined ? 8 : 12);
  } else if (payload !== null) {
    new TextEncoder().encodeInto(JSON.stringify(payload), result.subarray(8));
  }
  return result;
}
