/**
 * The join line of the signed list (a machine joins by an invite): what the device that made an invite
 * shows once, and what a machine pastes to join. It has one form, and the reader proves it by
 * writing the line again from what it read. The line carries an invite's private key: no refusal of
 * this file puts any part of a line into its message or its fields. No I/O; WebCrypto only.
 */
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { isListHash, verifySignature } from "./account-list-entry.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

export const JOIN_LINE_PREFIX = "ovis-join:1:";
/** The one PKCS8 form of a P-256 private key a line carries: version 0, the curve named once, ECPrivateKey version 1 with the public point. */
export const JOIN_SECRET_BYTES = 138;
/**
 * The longest line: the fixed members with room for any origin a DNS name spells (`https://`, 253, `:65535`: 267
 * characters) and more. The reader refuses a longer paste before it decodes any of it, and the writer writes none.
 */
export const JOIN_LINE_MAX_CHARS = 1024;

/**
 * Why a line is refused. `not_one_form` is a line whose parts are each in form but that the writer would have written otherwise;
 * `not_extractable` is the writer's alone: an invite's key the runtime will not let out, so no line can carry it.
 * `length` is a line longer than JOIN_LINE_MAX_CHARS; `scalar` a secret in its form whose private value is not from 1 to n-1.
 */
export type JoinLineReason = "prefix" | "length" | "base64url" | "json" | "members" | "version" | "service" | "list" | "secret" | "scalar"
  | "not_one_form" | "not_extractable";

export class JoinLineError extends Error {
  readonly code = "line_malformed";
  constructor(readonly reason: JoinLineReason, message: string) {
    super(message);
    this.name = "JoinLineError";
  }
}

function refuse(reason: JoinLineReason, message: string): never {
  throw new JoinLineError(reason, message);
}

/** WebCrypto, or a fault: a runtime without it (a page on plain http at a LAN address) says nothing about a line. */
function webCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here (crypto.subtle is missing), so no join line can be written or read");
  return subtle;
}

/** What a line holds once it is read. */
export interface JoinLine {
  /** The account service's origin. */
  readonly service: string;
  /** The list id. */
  readonly list: string;
  /** The invite's key: the public half of the line's secret, in the one spelling of a key. */
  readonly key: string;
  /** The line's secret, to sign `join` and the invite's read proof; it cannot be exported. */
  readonly privateKey: CryptoKey;
}

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** PKCS8 up to the private value: SEQUENCE(135) { INTEGER 0, AlgorithmIdentifier { id-ecPublicKey, prime256v1 }, OCTET STRING(109) { SEQUENCE(107) { INTEGER 1, OCTET STRING(32) } } }. */
const SECRET_HEAD = Uint8Array.from([
  0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20,
]);
/** After the private value: [1] { BIT STRING { 0 unused bits, 0x04, X, Y } }. */
const SECRET_MIDDLE = Uint8Array.from([0xa1, 0x44, 0x03, 0x42, 0x00, 0x04]);
const POINT_AT = SECRET_HEAD.length + 32 + SECRET_MIDDLE.length - 1;
/** SubjectPublicKeyInfo { id-ecPublicKey, prime256v1 } and the BIT STRING header, up to the 0x04 of the point. */
const SPKI_HEAD = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
/** The secret's base64url length: 138 bytes spell 184 characters, with nothing left over. */
const SECRET_CHARS = 184;
/** n, the order of P-256's group: a private value is from 1 to n-1 (account-list-entry.ts holds the same n for signatures). */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const PROBE = utf8ToBytes("ovis-join-secret-check/1");
const MEMBERS = ["v", "service", "list", "secret"] as const;

/** Base64url in its one spelling (no padding), or null. */
function oneSpelling(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const bytes = fromBase64Url(text);
  return toBase64Url(bytes) === text ? bytes : null;
}

/** An `https` origin in its one serialization: `https://host[:port]`, lower case, no default port, no path. */
export function isServiceOrigin(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === text;
}

/** Whether 32 bytes are a private value of P-256: from 1 to n-1, judged here, whatever the runtime's import accepts. */
function scalarInRange(d: Uint8Array): boolean {
  const value = BigInt(`0x${bytesToHex(d)}`);
  return value > 0n && value < P256_ORDER;
}

function lineJson(service: string, list: string, secret: string): string {
  return `{"v":1,"service":${JSON.stringify(service)},"list":${JSON.stringify(list)},"secret":${JSON.stringify(secret)}}`;
}

function lineText(service: string, list: string, secret: string): string {
  return `${JOIN_LINE_PREFIX}${toBase64Url(utf8ToBytes(lineJson(service, list, secret)))}`;
}

/**
 * The longest service a line has room for (469): the base64url of n bytes fits JOIN_LINE_MAX_CHARS after the prefix
 * exactly when n is at most 3/4 of that room, and the JSON holds the list id and the secret besides the service. A
 * longer service never fits, so the writer refuses it before anything else. A shorter one may still not fit once JSON
 * escapes it (a host may hold `"`): the writer measures the line it built too.
 */
const SERVICE_MAX_CHARS = Math.floor(((JOIN_LINE_MAX_CHARS - JOIN_LINE_PREFIX.length) * 3) / 4) - lineJson("", "", "").length - 64 - SECRET_CHARS;

function secretBytes(d: Uint8Array, x: Uint8Array, y: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(JOIN_SECRET_BYTES);
  bytes.set(SECRET_HEAD);
  bytes.set(d, SECRET_HEAD.length);
  bytes.set(SECRET_MIDDLE, SECRET_HEAD.length + 32);
  bytes.set(x, POINT_AT + 1);
  bytes.set(y, POINT_AT + 33);
  return bytes;
}

function jwkPart(value: string | undefined): Uint8Array {
  const bytes = value === undefined ? null : oneSpelling(value);
  if (bytes === null || bytes.length !== 32) refuse("secret", "The secret is not a P-256 private key");
  return bytes;
}

/**
 * The line for an invite: the service's origin, the list id and the invite's private key, which must
 * be extractable. The secret's 138 bytes are built here from the key's JWK, never taken from an
 * engine's PKCS8 export, so every runtime writes the same line, and no line longer than JOIN_LINE_MAX_CHARS. A service
 * too long for any such line is refused before it is parsed, the key exported or anything encoded. Refuses `line_malformed`; any other
 * failure of WebCrypto is a fault and goes up as the runtime threw it.
 */
export async function writeJoinLine(service: string, list: string, privateKey: CryptoKey): Promise<string> {
  const subtle = webCrypto();
  if (service.length > SERVICE_MAX_CHARS) refuse("length", `A join line is at most ${JOIN_LINE_MAX_CHARS} characters`);
  if (!isServiceOrigin(service)) refuse("service", "service is an https origin");
  if (!isListHash(list)) refuse("list", "list is a list id: 64 of 0-9a-f");
  let jwk: JsonWebKey;
  try {
    jwk = await subtle.exportKey("jwk", privateKey);
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidAccessError") refuse("not_extractable", "The invite's key is not extractable, so no line can carry it");
    throw error;
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") refuse("secret", "The secret is not a P-256 private key");
  const d = jwkPart(jwk.d);
  if (!scalarInRange(d)) refuse("scalar", "The secret's private value is not from 1 to n-1 of P-256");
  const line = lineText(service, list, toBase64Url(secretBytes(d, jwkPart(jwk.x), jwkPart(jwk.y))));
  if (line.length > JOIN_LINE_MAX_CHARS) refuse("length", `A join line is at most ${JOIN_LINE_MAX_CHARS} characters`);
  return line;
}

/**
 * The secret's bytes when they are the one PKCS8 form, measured before they are decoded; null for anything else. Nothing
 * here says whether the private value is in range or the point is its own.
 */
function secretForm(text: string): Uint8Array | null {
  if (text.length !== SECRET_CHARS) return null;
  const bytes = oneSpelling(text);
  if (bytes === null || bytes.length !== JOIN_SECRET_BYTES) return null;
  const at = (fixed: Uint8Array, offset: number) => fixed.every((byte, index) => bytes[offset + index] === byte);
  return at(SECRET_HEAD, 0) && at(SECRET_MIDDLE, SECRET_HEAD.length + 32) ? bytes : null;
}

/**
 * A pasted line, read strictly: the prefix, at most JOIN_LINE_MAX_CHARS characters (measured before
 * anything is decoded), base64url in its one spelling, a JSON object with the four members, each in its
 * form, a private value from 1 to n-1, the line written again from them equal to the line given, and a
 * secret that signs for the public point it carries. Refuses `line_malformed` with a reason, and never with
 * any part of the line. The secret's form fixes the point's SubjectPublicKeyInfo, so the key derived
 * from it is always a key in its one spelling. Throws (a fault, no refusal) without WebCrypto, and
 * passes up as it came any failure of WebCrypto other than its refusal of the secret's bytes as a key.
 */
export async function readJoinLine(line: string): Promise<JoinLine> {
  const subtle = webCrypto();
  if (!line.startsWith(JOIN_LINE_PREFIX)) refuse("prefix", `A join line starts with ${JOIN_LINE_PREFIX}`);
  if (line.length > JOIN_LINE_MAX_CHARS) refuse("length", `A join line is at most ${JOIN_LINE_MAX_CHARS} characters`);
  const bytes = oneSpelling(line.slice(JOIN_LINE_PREFIX.length)) ?? refuse("base64url", "The line is base64url in its one spelling after its prefix");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("json", "The line holds a JSON object");
  const members = value as Record<string, unknown>;
  const names = Object.keys(members);
  if (names.length !== MEMBERS.length || !MEMBERS.every((name) => Object.hasOwn(members, name))) refuse("members", "The line has exactly v, service, list and secret");
  if (members.v !== 1) refuse("version", "v is 1");
  const { service, list, secret } = members;
  if (typeof service !== "string" || !isServiceOrigin(service)) refuse("service", "service is an https origin");
  if (typeof list !== "string" || !isListHash(list)) refuse("list", "list is a list id: 64 of 0-9a-f");
  const pkcs8 = typeof secret === "string" ? secretForm(secret) : null;
  if (pkcs8 === null || typeof secret !== "string") refuse("secret", "The secret is not a P-256 private key in the line's one PKCS8 form");
  if (!scalarInRange(pkcs8.subarray(SECRET_HEAD.length, SECRET_HEAD.length + 32))) refuse("scalar", "The secret's private value is not from 1 to n-1 of P-256");
  if (lineText(service, list, secret) !== line) refuse("not_one_form", "The line is not in its one form");
  const key = toBase64Url(new Uint8Array([...SPKI_HEAD, ...pkcs8.subarray(POINT_AT, POINT_AT + 65)]));
  let privateKey: CryptoKey;
  try {
    privateKey = await subtle.importKey("pkcs8", new Uint8Array(pkcs8), P256, false, ["sign"]);
  } catch (error) {
    if (error instanceof DOMException && error.name === "DataError") refuse("secret", "The secret's private value or public point is not a valid P-256 key");
    throw error;
  }
  const signature = new Uint8Array(await subtle.sign(SIGN, privateKey, new Uint8Array(PROBE)));
  if (!(await verifySignature(PROBE, signature, key))) refuse("secret", "The secret does not sign for the public point it carries");
  return { service, list, key, privateKey };
}
