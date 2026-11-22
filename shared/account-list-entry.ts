/** A body is bytes, never JSON; nobody re-encodes an entry, so two members cannot differ over its bytes. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { SPKI_BYTES, SPKI_PREFIX } from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** Every body starts with these bytes; they differ from `ovis-account/1` and `ovis-relay-auth/1` at the sixth byte. */
export const LIST_BODY_PREFIX = "ovis-list/1";
/** The entry hash is SHA-256 over these bytes and the body. */
export const LIST_ENTRY_HASH_PREFIX = "ovis-list-entry/1";
export const LIST_BODY_MAX = 8192;
export const LIST_NAME_MAX = 32;
export const LIST_NUMBER_DIGITS = 15;
export const LIST_KEY_LENGTH = 122;
export const LIST_SIGNATURE_BYTES = 64;
export const LIST_SIGNATURE_TEXT_LENGTH = 86;

export type ListRefusalCode = "entry_malformed" | "chain_broken" | "signature_invalid" | "list_mismatch";

export class ListEntryError extends Error {
  constructor(readonly code: ListRefusalCode, message: string) {
    super(message);
    this.name = "ListEntryError";
  }
}

function refuse(code: ListRefusalCode, message: string): never {
  throw new ListEntryError(code, message);
}
const malformed = (message: string): never => refuse("entry_malformed", message);
function withinLimit(size: number): void {
  if (size > LIST_BODY_MAX) malformed(`A body is at most ${LIST_BODY_MAX} bytes, not ${size}`);
}

export interface ListField {
  readonly name: string;
  readonly value: Uint8Array;
}

export type SignerPower = "full" | "bound";

export interface EntryBody {
  readonly issued_at: number;
  readonly kind: string;
  readonly list: string;
  readonly prev: string;
  readonly seq: number;
  readonly signer: string;
  readonly v: number;
  /** The fields `adds` and `power`, which come together or not at all. */
  readonly adds?: { readonly key: string; readonly power: SignerPower };
  readonly ends?: string;
  /** Every other field, in body order: the envelope checks their names, never their values. */
  readonly own: readonly ListField[];
}

export interface Entry {
  readonly body: Uint8Array;
  readonly signature: Uint8Array;
}

export interface HeldEntry {
  readonly entry: Entry;
  readonly body: EntryBody;
  readonly hash: string;
  readonly list: string;
}

const HASH_PREFIX = utf8ToBytes(LIST_ENTRY_HASH_PREFIX);
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_FIELD = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const ENVELOPE_NAMES = new Set(["issued_at", "kind", "list", "prev", "seq", "signer", "v", "adds", "power", "ends"]);
const BODY_TEXT_MAX = Math.ceil((LIST_BODY_MAX * 4) / 3);
const NAME_FORM = new RegExp(`^[a-z][a-z_]{0,${LIST_NAME_MAX - 1}}$`);
const NUMBER_FORM = new RegExp(`^(?:0|[1-9][0-9]{0,${LIST_NUMBER_DIGITS - 1}})$`);

export function isListName(text: string): boolean {
  return NAME_FORM.test(text);
}

export function isListNumber(text: string): boolean {
  return NUMBER_FORM.test(text);
}

export function isListHash(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text);
}

/** The bytes a base64url text spells when it is their one spelling (no padding); null for anything else. */
function canonicalBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const bytes = fromBase64Url(text);
  return toBase64Url(bytes) === text ? bytes : null;
}

/** The 91 bytes of a key in its one spelling; null for anything else. */
function keyBytes(text: string): Uint8Array | null {
  if (text.length !== LIST_KEY_LENGTH) return null;
  const bytes = canonicalBase64Url(text);
  return bytes !== null && bytes.length === SPKI_BYTES && SPKI_PREFIX.every((byte, index) => bytes[index] === byte) ? bytes : null;
}

/** A P-256 public key in its one spelling: 122 base64url characters of SPKI DER with the uncompressed point. Not checked: that the point is on the curve (isListPoint). */
export function isListKeyEncoding(text: string): boolean {
  return keyBytes(text) !== null;
}

function bigOf(bytes: Uint8Array): bigint {
  return BigInt(`0x0${bytesToHex(bytes)}`);
}

/**
 * Whether a key in its one spelling names a point of P-256: its X and Y lie below p, and
 * Y² = X³ - 3X + b (mod p). That is the whole of it: the uncompressed spelling has no point at
 * infinity, and every point of the curve but that one has order n. Judged here, so that no
 * runtime's way of refusing a key decides anything.
 */
export function isListPoint(key: string): boolean {
  const bytes = keyBytes(key);
  if (bytes === null) return false;
  const x = bigOf(bytes.subarray(SPKI_PREFIX.length, SPKI_PREFIX.length + 32));
  const y = bigOf(bytes.subarray(SPKI_PREFIX.length + 32));
  if (x >= P256_FIELD || y >= P256_FIELD) return false;
  return (y * y - (x * x * x - 3n * x + P256_B)) % P256_FIELD === 0n;
}

/** Bytes as one character each, so a byte above 0x7f never matches a form. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * The field form (docs/account-list.md, "The form") under `prefix` (ASCII text, part of the bytes):
 * the fields, read strictly (the prefix, the lengths, names in form and strictly ascending, the end
 * exactly after the last field, at most LIST_BODY_MAX bytes in all); refuses `entry_malformed`. For
 * what is written "like an entry" under a prefix of its own.
 */
export function readFieldsUnder(prefix: string, bytes: Uint8Array): ListField[] {
  const head = utf8ToBytes(prefix);
  withinLimit(bytes.length);
  if (bytes.length < head.length || !head.every((byte, index) => bytes[index] === byte)) malformed(`A body starts with ${prefix}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const take = (offset: number, what: string): Uint8Array => {
    if (offset + 4 > bytes.length) malformed(`The body ends inside the length of a ${what}`);
    const length = view.getUint32(offset);
    if (offset + 4 + length > bytes.length) malformed(`The body ends inside a ${what}`);
    return bytes.subarray(offset + 4, offset + 4 + length);
  };
  const fields: ListField[] = [];
  let offset = head.length;
  let previous: string | null = null;
  while (offset < bytes.length) {
    const nameBytes = take(offset, "name");
    const name = latin1(nameBytes);
    if (!isListName(name)) malformed("A name is 1 to 32 bytes: a-z, then a-z or _");
    if (previous !== null && !(previous < name)) malformed(`Names ascend strictly: ${name} after ${previous}`);
    offset += 4 + nameBytes.length;
    const value = take(offset, "value");
    offset += 4 + value.length;
    fields.push({ name, value });
    previous = name;
  }
  return fields;
}

/** The field form under `prefix`: the one form of these fields, names ascending; refuses `entry_malformed` for fields it cannot hold. */
export function writeFieldsUnder(prefix: string, fields: readonly ListField[]): Uint8Array {
  const head = utf8ToBytes(prefix);
  const sorted = [...fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const size = sorted.reduce((sum, field) => sum + 8 + field.name.length + field.value.length, head.length);
  withinLimit(size);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(head);
  let offset = head.length;
  for (const { name, value } of sorted) {
    if (!isListName(name)) malformed("A name is 1 to 32 bytes: a-z, then a-z or _");
    view.setUint32(offset, name.length);
    bytes.set(utf8ToBytes(name), offset + 4);
    offset += 4 + name.length;
    view.setUint32(offset, value.length);
    bytes.set(value, offset + 4);
    offset += 4 + value.length;
  }
  readFieldsUnder(prefix, bytes);
  return bytes;
}

export function readFields(body: Uint8Array): ListField[] {
  return readFieldsUnder(LIST_BODY_PREFIX, body);
}

export function writeFields(fields: readonly ListField[]): Uint8Array {
  return writeFieldsUnder(LIST_BODY_PREFIX, fields);
}

export function readBody(body: Uint8Array): EntryBody {
  const fields = readFields(body);
  const values = new Map(fields.map((field) => [field.name, latin1(field.value)]));
  const text = (name: string): string => values.get(name) ?? malformed(`Every entry carries ${name}`);
  const number = (name: string): number => {
    const value = text(name);
    if (!isListNumber(value)) malformed(`${name} is a number: 1 to 15 digits, no leading zero`);
    return Number(value);
  };
  const key = (name: string, value: string): string => (isListKeyEncoding(value) ? value : malformed(`${name} is a key in its one spelling`));
  const listOrEmpty = (name: string): string => {
    const value = text(name);
    if (value !== "" && !isListHash(value)) malformed(`${name} is a hash, or empty`);
    return value;
  };

  const issued_at = number("issued_at");
  const kind = text("kind");
  if (!isListName(kind)) malformed("kind is 1 to 32 bytes in the form of a name");
  const list = listOrEmpty("list");
  const prev = listOrEmpty("prev");
  const seq = number("seq");
  const signer = key("signer", text("signer"));
  const v = number("v");
  if (v < 1) malformed("v is a number from 1");
  const adds = values.get("adds");
  const power = values.get("power");
  if ((adds === undefined) !== (power === undefined)) malformed("adds and power come together or not at all");
  if (power !== undefined && power !== "full" && power !== "bound") malformed("power is full or bound");
  const ends = values.get("ends");
  const own = fields.filter((field) => !ENVELOPE_NAMES.has(field.name));
  return {
    issued_at, kind, list, prev, seq, signer, v,
    ...(adds !== undefined && (power === "full" || power === "bound") ? { adds: { key: key("adds", adds), power } } : {}),
    ...(ends !== undefined ? { ends: key("ends", ends) } : {}),
    own,
  };
}

export function writeBody(body: EntryBody): Uint8Array {
  const taken = body.own.find(({ name }) => ENVELOPE_NAMES.has(name));
  if (taken) malformed(`${taken.name} is a field of the envelope: it is written from its own property, never through own`);
  const field = (name: string, value: string): ListField => ({ name, value: utf8ToBytes(value) });
  const fields = [
    field("issued_at", String(body.issued_at)), field("kind", body.kind), field("list", body.list), field("prev", body.prev),
    field("seq", String(body.seq)), field("signer", body.signer), field("v", String(body.v)),
    ...(body.adds ? [field("adds", body.adds.key), field("power", body.adds.power)] : []),
    ...(body.ends !== undefined ? [field("ends", body.ends)] : []),
    ...body.own,
  ];
  const bytes = writeFields(fields);
  readBody(bytes);
  return bytes;
}

/** The entry hash: SHA-256 over `ovis-list-entry/1` and the body, as 64 lowercase hex digits. The list id is entry 0's. */
export function entryHash(body: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(HASH_PREFIX, body)));
}

function scalarInRange(bytes: Uint8Array): boolean {
  const value = bigOf(bytes);
  return value > 0n && value < P256_ORDER;
}

/** The signature: whether it is 64 bytes whose `r` and `s` each lie from 1 to n-1; judged here, whatever the runtime's ECDSA accepts. */
export function signatureInRange(signature: Uint8Array): boolean {
  return signature.length === LIST_SIGNATURE_BYTES && scalarInRange(signature.subarray(0, 32)) && scalarInRange(signature.subarray(32));
}

/** Signs a body with the private half of its `signer`. */
export async function signEntry(body: EntryBody, privateKey: CryptoKey): Promise<Entry> {
  const bytes = writeBody(body);
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, new Uint8Array(bytes)));
  return { body: bytes, signature };
}

/**
 * The signature (docs/account-list.md, "The signature, the hash and the list id"): whether
 * `signature` (`r || s`, each from 1 to n-1, a high `s` included) is `signer`'s ECDSA
 * P-256 SHA-256 over `body`. A signature out of range, and a signer that is no key in its one
 * spelling or whose point is not on the curve, verify nothing: false, judged here before the
 * runtime is asked. So the runtime gets only a key it must take, and whatever it throws is a
 * fault, as is a runtime without WebCrypto (a page on plain http at a LAN address): it says
 * nothing about the entry. The body and the signature are copied before anything is judged, and
 * the runtime verifies those copies: the verdict is of the bytes as they were handed over,
 * whatever the caller does to them while the key is imported.
 */
export async function verifySignature(body: Uint8Array, signature: Uint8Array, signer: string): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here (crypto.subtle is missing), so no signature can be checked");
  if (signature.length !== LIST_SIGNATURE_BYTES) return false;
  const signed = new Uint8Array(body);
  const judged = new Uint8Array(signature);
  if (!signatureInRange(judged) || !isListPoint(signer)) return false;
  const key = await subtle.importKey("spki", new Uint8Array(fromBase64Url(signer)), P256, false, ["verify"]);
  return await subtle.verify(SIGN, key, judged, signed);
}

/**
 * When an entry holds (docs/account-list.md): entry n holds, given the entry before it (null for
 * entry 0) and nothing else: (1) its body has the form, (2) its `seq` is n and it continues the
 * chain, (3) its signature verifies. Checked in that order; throws ListEntryError with the first
 * that fails. Everything is read once, before the signature is awaited: the entry is copied (with
 * `new Uint8Array`: on Node's Buffer, `slice()` is a view of the same memory), once its sizes are
 * judged, and the seq, hash and list id of the entry before are taken. What comes back is built
 * from those alone, so it is of the bytes whose signature was checked and of the state they were
 * checked against, whatever the caller does to its buffers or to that state meanwhile or later.
 */
export async function entryHolds(shown: Entry, before: HeldEntry | null): Promise<HeldEntry> {
  const { body: shownBody, signature: shownSignature } = shown;
  if (shownSignature.length !== LIST_SIGNATURE_BYTES) malformed(`A signature is ${LIST_SIGNATURE_BYTES} bytes`);
  withinLimit(shownBody.length);
  const entry: Entry = { body: new Uint8Array(shownBody), signature: new Uint8Array(shownSignature) };
  const chain = before === null ? null : { seq: before.body.seq, hash: before.hash, list: before.list };
  const body = readBody(entry.body);
  const n = chain === null ? 0 : chain.seq + 1;
  if (body.seq !== n) refuse("chain_broken", `seq is ${body.seq}, not ${n}`);
  if (chain === null) {
    if (body.list !== "" || body.prev !== "") refuse("chain_broken", "Entry 0 has an empty list and prev");
    if (body.adds !== undefined || body.ends !== undefined) refuse("chain_broken", "Entry 0 carries no adds and no ends");
  } else {
    if (body.list !== chain.list) refuse("chain_broken", "list is not this list's id");
    if (body.prev !== chain.hash) refuse("chain_broken", "prev is not the hash of the entry before");
  }
  const hash = entryHash(entry.body);
  if (!(await verifySignature(entry.body, entry.signature, body.signer))) refuse("signature_invalid", "The signature is not the signer's over this body");
  return { entry, body, hash, list: chain === null ? hash : chain.list };
}

/**
 * The first state: entry 0, which holds, and its signer. Given a list id (by an offer or a join
 * line), only the entry with that hash is taken as entry 0: another refuses `list_mismatch`, after
 * the checks of entryHolds.
 */
export async function firstState(entry: Entry, givenList?: string): Promise<{ readonly first: HeldEntry; readonly signer: string }> {
  const first = await entryHolds(entry, null);
  if (givenList !== undefined && first.hash !== givenList) refuse("list_mismatch", "Entry 0 does not hash to the given list id");
  return { first, signer: first.body.signer };
}

export function entryToText(entry: Entry): string {
  return `${toBase64Url(entry.body)}.${toBase64Url(entry.signature)}`;
}

/** An entry's text, read strictly (two parts in their one spelling, nothing else); refuses `entry_malformed`. The body is judged by entryHolds. */
export function entryFromText(text: string): Entry {
  const parts = text.split(".");
  if (parts.length !== 2) malformed("An entry's text is two parts joined by one dot");
  const [bodyText = "", signatureText = ""] = parts;
  if (signatureText.length !== LIST_SIGNATURE_TEXT_LENGTH) malformed(`The signature part is ${LIST_SIGNATURE_TEXT_LENGTH} characters`);
  if (bodyText.length > BODY_TEXT_MAX) malformed(`A body is at most ${LIST_BODY_MAX} bytes`);
  const body = canonicalBase64Url(bodyText) ?? malformed("The body part is base64url in its one spelling");
  const signature = canonicalBase64Url(signatureText) ?? malformed("The signature part is base64url in its one spelling");
  return { body, signature };
}
