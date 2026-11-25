import { createScanner, ScanError, SyntaxKind } from "jsonc-parser";
import { AccountDevicesApiError, parseBlockReceipt, parseHoldState, type BlockReceipt, type HoldState } from "./account-devices-api.ts";

/** The relay wire generation: the envelope's first byte and WELCOME's `relay_protocol`. A PC on another one is refused outright. */
export const RELAY_PROTOCOL = 1;
export const RELAY_HINTS = "relay-hints";
export const ACCOUNT_OPENS_ALL_FEATURE = "account-opens-all-1";
/** A client that offers it reads `account_unreachable` and `account_readd_required`; one without it takes either as a protocol error. */
export const ACCOUNT_LISTING_ERRORS = "account-listing-errors-1";
/**
 * A PC selects it only while it lets its account's devices in by the account's signed list alone (docs/account.md,
 * "The account's signed list on a PC"). A client that signs in with the key the list holds for it requires it, so a
 * PC that follows no list answers `unsupported_extension`. A client that offers it without requiring it reads
 * `account_list_required`; one without it takes that code as a protocol error.
 */
export const ACCOUNT_LIST_FEATURE = "account-list-1";
/**
 * A PC selects it only while it can let a new device into its account's signed list by itself: it is pinned to the
 * list, in it, its own key signs for the list, and a person at the PC decides (docs/account.md, "A PC allows a
 * device into the list"). A device that asks to join then sends its card in PAIR_REQUEST (`list_enc`, `list_card`),
 * and the AUTH_OK of a join the PC allowed names the list and the place of the entry that let the device in (`list`).
 * Not selected: this PC lets nobody into the list, and a join it allows makes its own pairing as before.
 */
export const ACCOUNT_LIST_ALLOW = "account-list-allow-1";
/** Eight numbered receipts fit the existing 1 KiB session error, even with safe-integer log numbers. */
export const AUTH_RECEIPTS_MAX = 8;
/** The address is a hint: Noise against the pinned PC key proves the PC. */
export const DIRECT_CARRIER = "direct-carrier";
/**
 * Offered beside DIRECT_CARRIER by a client that can also open a direct carrier on the PC's Tailscale
 * address (100.64.0.0/10): only then does AUTH_OK name one. A client without it would refuse the whole
 * AUTH_OK over an address its older isDirectCarrier does not take.
 */
export const DIRECT_TAILNET = "direct-tailnet";
export const MAX_DIRECT_CARRIERS = 4;
/**
 * Raise it only in a PR that makes the shell need a newer server API, with a changelog line. A
 * server below it gets the update screen (src/lib/relay/skew.ts).
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
  PAIR_REQUEST: 0x0b, PAIR_CHALLENGE: 0x0c, PAIR_REVEAL: 0x0d, PAIR_CONFIRM: 0x0e,
  HTTP_OPEN: 0x10, HTTP_ACCEPT: 0x11, HTTP_HEADERS: 0x12,
  HTTP_DATA: 0x13, HTTP_END: 0x14, HTTP_STOP_REQUEST: 0x15,
  WS_OPEN: 0x20, WS_ACCEPT: 0x21, WS_DATA: 0x22, WS_CLOSE: 0x23,
  CREDIT: 0x30, RESET: 0x31,
  // session frames again, past the stream ranges: 0x01-0x0f is full
  KEY_CHALLENGE: 0x40, KEY_PROVE: 0x41, KEY_PENDING: 0x42,
} as const;
export type FrameType = typeof FrameType[keyof typeof FrameType];
export const PAIR_SAS_FEATURE = "pair-sas";
/** A device that offers it proves the key it pairs with over a challenge the PC makes after the key was named. */
export const KEY_PROOF_FEATURE = "key-proof-1";
/** A code-adding PC asks before sending PAIR; only an account-bound Step 2 target selects it. */
export const PC_CODE_ACCOUNT_ONLY = "pc-code-account-only-1";
export const ACCOUNT_FEATURE = "account";
export const PAIR_INTENT_PC = "pair-intent-pc";
export const PAIR_INTENT_ACCOUNT = "pair-intent-account";
/**
 * A PC's server pairing with another PC of its account, vouched for by a signed-in device's admission
 * (docs/account.md, "Adding a PC of your account"): taken only under the account join's gates, shown to the
 * account's members as "pair this PC", and it makes a plain row there, never an account member.
 */
export const PAIR_INTENT_VOUCHED = "pair-intent-pc-vouched";
export const PAIR_PC_PROOF = "pair-pc-proof";
/**
 * Which PC a comparison waits on when the PC itself approves it on its own screen (an account join on a PC with no
 * member, docs/account.md design 5.3), named by its system so the phone can say where to press. A value a phone does
 * not know reads as "pc", so a later PC can name another.
 */
export const PAIR_APPROVERS = ["mac", "windows", "linux", "pc"] as const;
export type PairApprover = typeof PAIR_APPROVERS[number];
export const LARGE_WS_MESSAGES = "large-ws-messages";
/**
 * A phone without it refuses a
 * header it does not list, so a PC sends it only to a phone that offered this in HELLO.
 */
export const SERVER_TIME_HEADER = "server-time-header";
/**
 * A 4 MiB outgoing queue (relay-mux-engine.ts) holds one such message and, behind it, the 1 MiB a PC's
 * core still sends to a client while it drains (server/output-window.ts OUTPUT_HARD_BYTES).
 */
export const MAX_LARGE_WS_MESSAGE_BYTES = 3 * 1024 * 1024;
export const HTTP_END_FLAGS = { STOPPED: 0x0001 } as const;
export const WS_DATA_FLAGS = { START: 0x0001, END: 0x0002, TEXT: 0x0004 } as const;

export const SESSION_ERRORS = [
  "unsupported_version", "unsupported_extension", "unsupported_transport",
  "protocol_error", "auth_failed", "auth_revoked", "auth_changed",
  "flow_control_error", "resource_exhausted", "timeout", "internal_error",
  // Step 2, sent only by a PC with Step 2 on to an account-joined sign-in; `held` carries its HoldState
  "held", "not_listed", "admission",
  // sent only to a client that offered ACCOUNT_LISTING_ERRORS
  "account_unreachable", "account_readd_required",
  // sent only to a client that offered ACCOUNT_LIST_FEATURE and did not require it
  "account_list_required",
] as const;
export type SessionError = typeof SESSION_ERRORS[number];
export const STREAM_ERRORS = [
  "cancelled", "refused", "bad_request", "body_too_large", "message_too_large",
  "stream_protocol_error", "upstream_lost", "slow_consumer", "resource_exhausted", "internal_error",
] as const;
export type StreamError = typeof STREAM_ERRORS[number];

export class MuxProtocolError extends Error {
  /** `hold`: the hold state a `held` refusal carries (Step 2, S25); no other code has one. */
  constructor(readonly code: SessionError, message: string, readonly receipts?: readonly BlockReceipt[], readonly hold?: HoldState) {
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
  "x-server-time",
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
  readonly 0x02: { readonly protocol: "ovis-mux"; readonly version: 1; readonly features: readonly string[]; readonly limits: LimitsV1; readonly nonce: string; readonly server_version: string; readonly relay_protocol: number; readonly min_supported_client: string; readonly provisional?: true;
    /** ACCOUNT_LIST_FEATURE selected: the id of the list the PC is pinned to, which the app signs in by the key it holds for (R-E). */
    readonly list?: string };
  readonly 0x03: { readonly scheme: "device-key"; readonly device_id: string; readonly signature: string };
  readonly 0x04: { readonly session_id: string; readonly device_id: string; readonly role: "drive" | "watch"; readonly relays?: readonly string[]; readonly direct?: readonly string[];
    /** ACCOUNT_LIST_ALLOW: the list the PC let the device into, and the place of the entry that did. */
    readonly list?: { readonly id: string; readonly seq: number; readonly hash: string } };
  readonly 0x05: { readonly code: SessionError; readonly message: string; readonly hold?: HoldState; readonly receipts?: readonly BlockReceipt[] };
  readonly 0x06: { readonly code: "shutdown" | "id_exhausted"; readonly last_open_id: number; readonly drain_ms: number };
  readonly 0x07: bigint;
  readonly 0x08: bigint;
  readonly 0x09: bigint;
  readonly 0x0a: { readonly code: string; readonly label: string; readonly public_key: string };
  readonly 0x0b: { readonly label: string; readonly public_key: string; readonly commitment: string; readonly server_key?: string;
    /** ACCOUNT_LIST_ALLOW: the device's encryption key and its card for the list, both or neither. */
    readonly list_enc?: string; readonly list_card?: string;
    /** Set by the reader alone, in the place of `list_enc` and `list_card` that came out of their form. */
    readonly list_malformed?: true };
  /** `list`: with ACCOUNT_LIST_ALLOW selected, the id of the list the PC follows: the device stops early when its card names another. */
  readonly 0x0c: { readonly nonce: string; readonly approve_on?: PairApprover; readonly server_challenge?: string; readonly list?: string };
  readonly 0x0d: { readonly nonce: string; readonly server_proof?: string };
  readonly 0x0e: { readonly confirmed: true };
  readonly 0x10: { readonly device_id: string; readonly method: Method; readonly target: string; readonly headers: HeaderList; readonly body: "none" | "stream" };
  readonly 0x11: null;
  readonly 0x12: { readonly status: number; readonly headers: HeaderList };
  readonly 0x13: Uint8Array;
  readonly 0x14: { readonly trailers: HeaderList };
  readonly 0x15: null;
  readonly 0x40: { readonly challenge: string };
  readonly 0x41: { readonly signature: string };
  readonly 0x42: Readonly<Record<string, never>>;
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
/** A SESSION_ERROR's payload: a `held` refusal names its hold state, and no other code carries one. */
function sessionError(v: Record<string, unknown>): Payloads[0x05] {
  const code = choice(v.code, SESSION_ERRORS);
  const message = text(v.message, 256);
  requireProtocol((code === "held") === ("hold" in v), "Only a held refusal carries a hold state");
  requireProtocol(v.receipts === undefined || code === "auth_failed", "Only refused sign-ins carry receipts");
  try {
    return {
      code, message,
      ...(code === "held" ? { hold: parseHoldState(v.hold) } : {}),
      ...(v.receipts === undefined ? {} : { receipts: list(v.receipts, AUTH_RECEIPTS_MAX, parseBlockReceipt) }),
    };
  } catch (error) {
    if (error instanceof AccountDevicesApiError) throw new MuxProtocolError("protocol_error", "Invalid hold state or block receipt");
    throw error;
  }
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

/** DER SubjectPublicKeyInfo for id-ecPublicKey + prime256v1 + an uncompressed P-256 point. */
/** AUTH_OK's `list`: a list id and a place in it. */
function listPlace(value: unknown): { id: string; seq: number; hash: string } {
  const v = object(value);
  return { id: hex(v.id, 64), seq: integer(v.seq, 0, 999_999_999_999_999), hash: hex(v.hash, 64) };
}
function p256Spki(value: unknown): string {
  const public_key = base64url(value, 91);
  const der = atob(public_key.replace(/-/g, "+").replace(/_/g, "/"));
  const prefix = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04];
  requireProtocol(prefix.every((byte, i) => der.charCodeAt(i) === byte), "Invalid P-256 SPKI");
  return public_key;
}
function pairLabel(value: unknown): string {
  const label = text(value, 256);
  requireProtocol([...label].length <= 64, "Pair label too long");
  return label;
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
function relayOrigin(value: unknown): string {
  const result = text(value, 256);
  let origin: string | null = null;
  // relay-offer.ts isWssOrigin, not imported: relay-offer reaches this module through relay-e2ee
  try { const url = new URL(result); origin = url.protocol === "wss:" ? url.origin : null; } catch { }
  requireProtocol(origin === result, "Invalid relay origin");
  return result;
}
function directOrigin(value: unknown): string {
  const result = text(value, 32);
  requireProtocol(isDirectCarrier(result), "Invalid direct carrier");
  return result;
}

type Subnet = readonly [number, number, number];
const PRIVATE_IPV4: readonly Subnet[] = [[10, 0, 8], [172, 16, 12], [192, 168, 16], [169, 254, 16]];
/** Tailscale's IPv4 range (shared CGNAT space, which Tailscale assigns its nodes from). */
const TAILNET_IPV4: readonly Subnet[] = [[100, 64, 10]];

function carrierIn(text: string, subnets: readonly Subnet[]): boolean {
  const match = /^ws:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}):([1-9]\d{0,4})$/.exec(text);
  if (!match) return false;
  const octets = match[1]!.split(".").map(Number);
  const port = Number(match[2]);
  if (port > 65535 || octets.some((octet) => octet > 255)) return false;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return subnets.some(([a, b, bits]) => address >>> (32 - bits) === (((a << 24) | (b << 16)) >>> 0) >>> (32 - bits));
}

/** Exactly `ws://<Tailscale IPv4>:<port>`: an address in 100.64.0.0/10, a port written out, nothing else. */
export function isTailnetCarrier(text: string): boolean {
  return carrierIn(text, TAILNET_IPV4);
}

export function isTailnetAddress(address: string): boolean {
  return isTailnetCarrier(`ws://${address}:1`);
}

/**
 * Exactly `ws://<private IPv4>:<port>`: an RFC 1918, link-local or Tailscale (isTailnetCarrier) address, a
 * port written out, nothing else.
 */
export function isDirectCarrier(text: string): boolean {
  return carrierIn(text, PRIVATE_IPV4) || isTailnetCarrier(text);
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
  if (t < FrameType.HTTP_OPEN || t >= FrameType.KEY_CHALLENGE) requireProtocol(id === 0, "Session frame needs stream zero");
  else streamId(id, false);
  return t;
}

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
      return { ...common, type, payload: { protocol: "ovis-mux", version: 1, features: list(v.features, 16, feature), limits: limits(v.limits),
        nonce: base64url(v.nonce, 32), server_version: text(v.server_version, 64), relay_protocol: integer(v.relay_protocol, 1, 65535), min_supported_client: text(v.min_supported_client, 64),
        ...(v.provisional === undefined ? {} : (requireProtocol(v.provisional === true, "Invalid provisional welcome"), { provisional: true as const })),
        ...(v.list === undefined ? {} : { list: hex(v.list, 64) }) } };
    case FrameType.AUTH:
      requireProtocol(v.scheme === "device-key", "Invalid auth scheme");
      return { ...common, type, payload: { scheme: "device-key", device_id: hex(v.device_id, 16), signature: base64url(v.signature, 64) } };
    case FrameType.PAIR: {
      const code = text(v.code, 6);
      requireProtocol(/^[0-9]{6}$/.test(code), "Invalid pairing code");
      return { ...common, type, payload: { code, label: pairLabel(v.label), public_key: p256Spki(v.public_key) } };
    }
    case FrameType.PAIR_REQUEST:
      return { ...common, type, payload: { label: pairLabel(v.label), public_key: p256Spki(v.public_key), commitment: base64url(v.commitment, 32), ...(v.server_key === undefined ? {} : { server_key: hex(v.server_key, 64) }),
        ...listCard(v) } };
    case FrameType.PAIR_CHALLENGE:
      return { ...common, type, payload: { nonce: base64url(v.nonce, 32), ...(v.server_challenge === undefined ? {} : { server_challenge: text(v.server_challenge, 512) }),
        ...(v.approve_on === undefined ? {} : { approve_on: PAIR_APPROVERS.find((approver) => approver === v.approve_on) ?? "pc" }),
        ...(v.list === undefined ? {} : { list: hex(v.list, 64) }) } };
    case FrameType.PAIR_REVEAL:
      return { ...common, type, payload: { nonce: base64url(v.nonce, 32), ...(v.server_proof === undefined ? {} : { server_proof: text(v.server_proof, 256) }) } };
    case FrameType.KEY_CHALLENGE:
      return { ...common, type, payload: { challenge: base64url(v.challenge, 32) } };
    case FrameType.KEY_PROVE:
      return { ...common, type, payload: { signature: base64url(v.signature, 64) } };
    // the wait names nothing: a fingerprint the PC or the relay sent could be shown for another key
    case FrameType.KEY_PENDING:
      return { ...common, type, payload: {} };
    case FrameType.PAIR_CONFIRM:
      requireProtocol(v.confirmed === true && Object.keys(v).length === 1, "Invalid pairing confirmation");
      return { ...common, type, payload: { confirmed: true } };
    case FrameType.AUTH_OK:
      return { ...common, type, payload: { session_id: hex(v.session_id, 32), device_id: hex(v.device_id, 16), role: choice(v.role, ["drive", "watch"]),
        ...(v.relays === undefined ? {} : { relays: list(v.relays, 2, relayOrigin) }),
        ...(v.direct === undefined ? {} : { direct: list(v.direct, MAX_DIRECT_CARRIERS, directOrigin) }),
        ...(v.list === undefined ? {} : { list: listPlace(v.list) }) } };
    case FrameType.SESSION_ERROR:
      return { ...common, type, payload: sessionError(v) };
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
    // the engine holds each message to what its peer takes (LARGE_WS_MESSAGES) before this
    const length = integer(total, 0, MAX_LARGE_WS_MESSAGE_BYTES);
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

/**
 * The card a join may bring in PAIR_REQUEST (ACCOUNT_LIST_ALLOW): `list_enc` and `list_card`, both in their form. They
 * are an extension only a PC that selected the feature reads. So a frame whose members are out of that form (one
 * without the other, a key that is none) is still the PAIR_REQUEST it was before the extension: it is read, with
 * `list_malformed` in the members' place, and a PC that takes no card pairs as it always did. One that selected the
 * feature refuses it.
 */
function listCard(v: JsonObject): { list_enc: string; list_card: string } | { list_malformed: true } | Record<string, never> {
  if (v.list_enc === undefined && v.list_card === undefined && v.list_malformed === undefined) return {};
  try {
    if (v.list_malformed !== undefined) throw new MuxProtocolError("protocol_error", "Malformed list card");
    return { list_enc: p256Spki(v.list_enc), list_card: base64url(v.list_card, 64) };
  } catch (error) {
    if (!(error instanceof MuxProtocolError)) throw error;
    return { list_malformed: true };
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
      // nobody sends a card that is out of its form; only the reader lets one pass, as a member it then ignores
      requireProtocol(!(frame.type === FrameType.PAIR_REQUEST && payload.list_malformed === true), "A list card comes with its encryption key, each in its form");
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
