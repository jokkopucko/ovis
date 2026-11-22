/**
 * Account records (docs/account.md, "Records"): `add`, `remove` and `link`, each signed on its own
 * by a client's account key. Safety records (`block`, `freeze`, `lift`, `lock`, `unlock`, `forget`) are the
 * entries of a PC's safety log; they have a parser of their own, so nothing that reads the three
 * older kinds ever sees one.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** Signing bytes start with this; `AUTH` signs `ovis-relay-auth/1 ...`, which differs at the sixth byte. */
export const ACCOUNT_RECORD_PREFIX = "ovis-account/1";
/** Records one `/api/account/records` request may carry. */
export const ACCOUNT_RECORDS_MAX = 32;
/** Records one `/api/account/enroll` request may carry: the account's removes and adds, in one ordered batch. */
export const ACCOUNT_ENROLL_MAX = 512;
export const ACCOUNT_LABEL_MAX = 48;

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** DER of SubjectPublicKeyInfo { id-ecPublicKey, prime256v1 } and the BIT STRING header of an uncompressed point. */
export const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
export const SPKI_BYTES = 91;

export type AccountRecordKind = "add" | "remove" | "link";

interface Common {
  readonly v: 1;
  readonly account: string;
  readonly key: string;
  readonly issued_at: string;
  readonly id: string;
  readonly signer: string;
  readonly signature: string;
}
export interface AddRecord extends Common { readonly kind: "add"; readonly label: string; readonly role: "drive" | "watch" }
export interface RemoveRecord extends Common { readonly kind: "remove" }
export interface LinkRecord extends Common { readonly kind: "link"; readonly server_id: string; readonly device_id: string; readonly old_key: string }
export type AccountRecord = AddRecord | RemoveRecord | LinkRecord;

type Unsigned<T> = T extends AccountRecord ? Omit<T, "signature"> : never;
export type UnsignedAccountRecord = Unsigned<AccountRecord>;

/** Every field after `v` that the signature covers, in signing order. */
const SIGNED_FIELDS = {
  add: ["kind", "account", "key", "label", "role", "issued_at", "id", "signer"],
  remove: ["kind", "account", "key", "issued_at", "id", "signer"],
  link: ["kind", "account", "key", "server_id", "device_id", "old_key", "issued_at", "id", "signer"],
} as const satisfies Record<AccountRecordKind, readonly string[]>;

export class AccountRecordError extends Error {
  readonly code = "record_invalid";
}

function fail(message: string): never {
  throw new AccountRecordError(message);
}

/** Whether `text` is a P-256 public key as SPKI in canonical base64url; whether the point is on the curve is WebCrypto's to say. */
export function isAccountKeyEncoding(text: unknown): text is string {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{122}$/.test(text)) return false;
  const bytes = fromBase64Url(text);
  return bytes.length === SPKI_BYTES && toBase64Url(bytes) === text && SPKI_PREFIX.every((byte, index) => bytes[index] === byte);
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A time as this PC writes it: a four-digit-year ISO string with milliseconds that reads back as itself. */
export function isIsoTime(v: unknown): v is string {
  return typeof v === "string" && ISO_MS.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
}
const checks: Record<string, (value: unknown) => boolean> = {
  account: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v),
  key: isAccountKeyEncoding,
  signer: isAccountKeyEncoding,
  old_key: isAccountKeyEncoding,
  // the form normalizeLabel (server/devices.ts) leaves, so a PC stores exactly what was signed
  // a lone surrogate encodes as U+FFFD, so two labels would share one signature
  label: (v) => typeof v === "string" && v.length >= 1 && v.length <= ACCOUNT_LABEL_MAX
    && !/[\p{Cc}\p{Cs}]/u.test(v) && v === v.replace(/\s+/g, " ").trim(),
  role: (v) => v === "drive" || v === "watch",
  server_id: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v),
  device_id: (v) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v),
  issued_at: isIsoTime,
  id: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v),
  signature: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{86}$/.test(v) && toBase64Url(fromBase64Url(v)) === v,
};

/** A record from the wire, with every field checked and nothing extra; throws AccountRecordError. Says nothing about the signature. */
export function parseAccountRecord(value: unknown): AccountRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("A record is a JSON object");
  const object = value as Record<string, unknown>;
  const kind = object.kind;
  if (kind !== "add" && kind !== "remove" && kind !== "link") fail("Unknown record kind");
  if (object.v !== 1) fail("Unknown record version");
  const fields: readonly string[] = SIGNED_FIELDS[kind];
  const expected = new Set(["v", "signature", ...fields]);
  for (const name of Object.keys(object)) if (!expected.has(name)) fail(`Unexpected field ${name}`);
  for (const name of [...fields, "signature"]) {
    if (name === "kind") continue;
    if (!checks[name]?.(object[name])) fail(`Invalid ${name}`);
  }
  if (kind === "link" && object.signer !== object.key) fail("A link is signed by the key it links to");
  if (kind === "add" && object.signer === object.key) fail("A key cannot add itself");
  return object as unknown as AccountRecord;
}

/** `ovis-account/1`, then `v` and every field in signing order, each as a 4-byte big-endian length and its UTF-8 bytes. */
export function recordSigningBytes(record: UnsignedAccountRecord): Uint8Array {
  const fields = SIGNED_FIELDS[record.kind] as readonly (keyof typeof record)[];
  return signingBytes([record.v, ...fields.map((name) => record[name])]);
}

function signingBytes(values: readonly unknown[], domain = ACCOUNT_RECORD_PREFIX): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts = values.map((value) => encoder.encode(String(value)));
  const prefix = encoder.encode(domain);
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

/** Signs with the client's account key; `record.signer` must be that key's public half. */
export async function signAccountRecord<T extends UnsignedAccountRecord>(record: T, privateKey: CryptoKey): Promise<T & { signature: string }> {
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, recordSigningBytes(record) as Uint8Array<ArrayBuffer>));
  const signed = { ...record, signature: toBase64Url(signature) };
  parseAccountRecord(signed);
  return signed;
}

/** Whether `record.signature` is `record.signer`'s over its signing bytes. False, never a throw, for a key off the curve. */
export async function verifyAccountRecord(record: AccountRecord): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64Url(record.signer) as Uint8Array<ArrayBuffer>, P256, false, ["verify"]);
    const { signature, ...unsigned } = record;
    return await crypto.subtle.verify(SIGN, key, fromBase64Url(signature) as Uint8Array<ArrayBuffer>, recordSigningBytes(unsigned as UnsignedAccountRecord) as Uint8Array<ArrayBuffer>);
  } catch (error) {
    if (error instanceof DOMException || error instanceof TypeError) return false;
    throw error;
  }
}

/** Parses and verifies; throws AccountRecordError for a malformed record and returns null for a bad signature. */
export async function readAccountRecord(value: unknown): Promise<AccountRecord | null> {
  const record = parseAccountRecord(value);
  return await verifyAccountRecord(record) ? record : null;
}

export function newRecordId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function exportAccountKey(publicKey: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)));
}

/** The id a PC gives a device an `add` puts there; the client works out the same to sign in (docs/account.md, "Account members"). */
export function accountDeviceId(serverId: string, devicePublicKey: string): string {
  return bytesToHex(sha256(utf8ToBytes(`ovis-account-device/1${serverId}${devicePublicKey}`))).slice(0, 16);
}

/** Registration signing bytes start with this; records sign `ovis-account/1 ...` and relay auth `ovis-relay-auth/1 ...`. */
export const DEVICE_REGISTER_PREFIX = "ovis-device-register/1";

/**
 * Device table P2, P18: what a device signs to register its own sign-in key at the account service.
 * `ovis-device-register/1`, then the account, the key, the challenge id and the challenge, each as a 4-byte
 * big-endian length and its UTF-8 bytes: the account service's `registerSigningBytes`, which vendors this file.
 */
export function registerSigningBytes(account: string, key: string, challengeId: string, challenge: string): Uint8Array<ArrayBuffer> {
  return signingBytes([account, key, challengeId, challenge], DEVICE_REGISTER_PREFIX);
}

/** Device table P24 (rule R2): the kinds of the PC's safety log. */
export type SafetyRecordKind = "block" | "freeze" | "lift" | "lock" | "unlock" | "forget";

/** Device table P24: the fields every safety record has. `signed_at` is shown to people and orders nothing. */
interface SafetyCommon {
  readonly v: 1;
  readonly id: string;
  readonly account: string;
  readonly signed_at: string;
  readonly signature: string;
}
/**
 * Device table P16, T51 ("Not me"): removes `target` and freezes the keys newer than it. `id` is the SHA-256
 * of the signed bytes; `target_no` and `signer_no` are the two keys' places in the account's order (P21).
 */
export interface BlockRecord extends SafetyCommon { readonly kind: "block"; readonly target: string; readonly target_no: number; readonly signer: string; readonly signer_no: number; readonly nonce: string }
/** Device table P16, T52: a device's lift of the block whose id is `target`. `id` is the SHA-256 of the signed bytes. */
export interface DeviceLiftRecord extends SafetyCommon { readonly kind: "lift"; readonly target: string; readonly signer: string; readonly signer_no: number }
/** Device table P24, P16, T69: a lift the PC writes (at the PC, by `ovis recover --lift`, or when its signer is removed here); `forget` also ends the block's marker (T61). Random id. */
export interface PcLiftRecord extends SafetyCommon { readonly kind: "lift"; readonly target: string; readonly signer: "pc"; readonly forget: boolean; readonly signature: "" }
/** Device table P24, G12: a freeze line the service states for a block this PC does not hold. `id` is `f:` and that block's id. */
export interface FreezeRecord extends SafetyCommon { readonly kind: "freeze"; readonly target: string; readonly after: number; readonly signer: "service"; readonly signature: "" }
/** Device table P11, T46: the lock, only ever written by the PC. Random id. */
export interface LockRecord extends SafetyCommon { readonly kind: "lock"; readonly target: null; readonly signer: "pc"; readonly signature: "" }
/** Device table P11, T47: ends the lock whose id is `target`. Random id. */
export interface UnlockRecord extends SafetyCommon { readonly kind: "unlock"; readonly target: string; readonly signer: "pc"; readonly signature: "" }
/**
 * Device table T61, P13, P24: PC-local forgets the account's removals of the key `target` in `account`. It names a
 * key, never a record id, so it never ends a local Revoke (P13). Only ever written by the PC. Random id.
 */
export interface ForgetRecord extends SafetyCommon { readonly kind: "forget"; readonly target: string; readonly signer: "pc"; readonly signature: "" }

export type DeviceSafetyRecord = BlockRecord | DeviceLiftRecord;
export type SafetyRecord = DeviceSafetyRecord | PcLiftRecord | FreezeRecord | LockRecord | UnlockRecord | ForgetRecord;
export type UnsignedSafetyRecord = Omit<BlockRecord, "id" | "signature"> | Omit<DeviceLiftRecord, "id" | "signature">;

const SAFETY_SIGNED_FIELDS = {
  block: ["kind", "account", "target", "target_no", "signer", "signer_no", "signed_at", "nonce"],
  lift: ["kind", "account", "target", "signer", "signer_no", "signed_at"],
} as const;

const SAFETY_FIELDS: Record<string, readonly string[]> = {
  block: [...SAFETY_SIGNED_FIELDS.block, "id", "signature"],
  device_lift: [...SAFETY_SIGNED_FIELDS.lift, "id", "signature"],
  pc_lift: ["kind", "id", "account", "target", "signer", "signed_at", "forget", "signature"],
  freeze: ["kind", "id", "account", "target", "after", "signer", "signed_at", "signature"],
  lock: ["kind", "id", "account", "target", "signer", "signed_at", "signature"],
  unlock: ["kind", "id", "account", "target", "signer", "signed_at", "signature"],
  forget: ["kind", "id", "account", "target", "signer", "signed_at", "signature"],
};

const HASH_ID = /^[0-9a-f]{64}$/;
const order = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
/** Each check sees the whole record, since what a field may hold depends on the kind and on who wrote it. */
const safetyChecks: Record<string, (value: unknown, record: Record<string, unknown>) => boolean> = {
  account: checks.account!, signed_at: checks.issued_at!,
  target_no: order, signer_no: order, after: order,
  nonce: checks.id!,
  forget: (v) => typeof v === "boolean",
  signature: (v, r) => (r.signer === "pc" || r.signer === "service") ? v === "" : checks.signature!(v),
  signer: (v, r) => r.kind === "freeze" ? v === "service" : v === "pc" ? r.kind !== "block" : r.kind !== "lock" && r.kind !== "unlock" && r.kind !== "forget" && isAccountKeyEncoding(v),
  target: (v, r) => r.kind === "block" || r.kind === "freeze" || r.kind === "forget" ? isAccountKeyEncoding(v) : r.kind === "lock" ? v === null
    : r.kind === "unlock" ? checks.id!(v) : typeof v === "string" && HASH_ID.test(v),
  id: (v, r) => typeof v === "string" && (r.kind === "freeze" ? v.startsWith("f:") && HASH_ID.test(v.slice(2))
    : r.signer === "pc" ? checks.id!(v) : HASH_ID.test(v)),
};

/** The bytes a device signs for a block or a lift, in the same encoding and under the same prefix as the older records. */
export function safetySigningBytes(record: UnsignedSafetyRecord): Uint8Array {
  const fields = SAFETY_SIGNED_FIELDS[record.kind] as readonly (keyof typeof record)[];
  return signingBytes([record.v, ...fields.map((name) => record[name])]);
}

/** Device table P24: a device-signed record's id is the SHA-256 of its signed bytes, so one id is one record. */
export function safetyRecordId(record: UnsignedSafetyRecord): string {
  return bytesToHex(sha256(safetySigningBytes(record)));
}

/**
 * A safety record from the wire or the log, every field checked and nothing extra; throws AccountRecordError.
 * A device-signed record's id must be the hash of its bytes; a freeze's id is `f:` and a block id; a PC-written
 * record has a random id and an empty signature. Says nothing about the signature itself.
 */
export function parseSafetyRecord(value: unknown): SafetyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("A record is a JSON object");
  const object = value as Record<string, unknown>;
  const kind = object.kind;
  if (kind !== "block" && kind !== "freeze" && kind !== "lift" && kind !== "lock" && kind !== "unlock" && kind !== "forget") fail("Unknown record kind");
  if (object.v !== 1) fail("Unknown record version");
  const shape = kind === "lift" ? (object.signer === "pc" ? "pc_lift" : "device_lift") : kind;
  const fields = SAFETY_FIELDS[shape]!;
  const expected = new Set(["v", ...fields]);
  for (const name of Object.keys(object)) if (!expected.has(name)) fail(`Unexpected field ${name}`);
  for (const name of fields) {
    if (name === "kind") continue;
    if (!(name in object) || !safetyChecks[name]?.(object[name], object)) fail(`Invalid ${name}`);
  }
  // Device table P21: target_no and signer_no are claims; each PC judges the signer's age from its own table
  if (kind === "block" && object.target === object.signer) fail("A block names another key than its signer");
  if (shape === "block" || shape === "device_lift") {
    const { id, signature: _signature, ...unsigned } = object;
    if (id !== safetyRecordId(unsigned as unknown as UnsignedSafetyRecord)) fail("The id is not the hash of the signed bytes");
  }
  return object as unknown as SafetyRecord;
}

/** Device table P24: whether a device signed it (a block, or a lift not written by the PC). */
export function isDeviceSafetyRecord(record: SafetyRecord): record is DeviceSafetyRecord {
  return record.kind === "block" || (record.kind === "lift" && record.signer !== "pc");
}

/** Signs a block or a lift with the device's account key and gives it its id. */
export async function signSafetyRecord<T extends UnsignedSafetyRecord>(record: T, privateKey: CryptoKey): Promise<T & { id: string; signature: string }> {
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, safetySigningBytes(record) as Uint8Array<ArrayBuffer>));
  const signed = { ...record, id: safetyRecordId(record), signature: toBase64Url(signature) };
  parseSafetyRecord(signed);
  return signed;
}

/** Whether a block's or a device lift's signature is its signer's. False, never a throw, for a key off the curve. */
export async function verifySafetyRecord(record: DeviceSafetyRecord): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64Url(record.signer) as Uint8Array<ArrayBuffer>, P256, false, ["verify"]);
    const { id: _id, signature, ...unsigned } = record;
    return await crypto.subtle.verify(SIGN, key, fromBase64Url(signature) as Uint8Array<ArrayBuffer>, safetySigningBytes(unsigned as UnsignedSafetyRecord) as Uint8Array<ArrayBuffer>);
  } catch (error) {
    if (error instanceof DOMException || error instanceof TypeError) return false;
    throw error;
  }
}
