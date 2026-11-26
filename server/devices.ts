/**
 * Paired devices: the per-device credential a phone (or anyone the owner lets in) uses
 * instead of the shared token. The owner starts a pairing on the PC and gets a short code
 * that lives ten minutes; the device sends the code once and receives a token of its own
 * in an HttpOnly cookie. Only a hash of that token is stored, so devices.json in the state
 * dir (0600, written whole, and flushed before it replaces the old list whenever access
 * changes: private-state.ts) reveals nothing if read. Revocation also closes that device's
 * active streams; revoking all is one write of an empty, gated registry, after which every
 * credential (paired, pending or unconfirmed) is void. A device is either allowed to drive
 * (type, answer, manage) or only to watch. A durable enrollment is announced (`onPaired`) once
 * its write succeeded, so every other session can hear of a device it did not pair.
 */
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { admissionPosition, compareAdmission, compareAdmissionPositions, isRowOrigin, legacyOrigin, type AdmissionPosition, type RowOrigin } from "./account/admission-order.ts";
import { type ClearReason, LIST_REMOVED, type ListBound, PcAccountState } from "./account/pc-binding.ts";
import type { ListAuthority } from "./account/list-follow.ts";
import type { BlockAsOf, LiftCause, SafetyGot, SafetyLog, SafetyState } from "./account/safety-log.ts";
import type { RemovalEvidence } from "./account/removal-evidence.ts";
import { rowDrop } from "./account/row-drop-evidence.ts";
import { RevokeAllIntent } from "./account/revoke-all-intent.ts";
import type { RecoveryCandidate, RecoveryReleases } from "./account/recovery.ts";
import { endedJournalRows, type DeviceJournal, type JournalEntry, type JournalInput } from "./account/device-journal.ts";
import type { AccountOrder, LiftOrder } from "./account/account-order.ts";
import { HandedLifts } from "./account/handed-lift.ts";
import type { AccessAnswer, AccountRow, AccountRowSource } from "./account/account-devices.ts";
import type { CatchUpGate } from "./account/catch-up-gate.ts";
import { accountOpensAll, type DeviceNotice, type NoticeReplay } from "../shared/account-devices-api.ts";
import { accountDeviceId, AccountRecordError, isDeviceSafetyRecord, isIsoTime, parseAccountRecord, parseSafetyRecord, verifySafetyRecord, type AddRecord, type BlockRecord, type DeviceLiftRecord, type RemoveRecord, type SafetyRecord } from "../shared/account-records.ts";
import { PromotedHolds } from "./account/promoted-holds.ts";
import { mayEndHold, type Sayer } from "./account/join-hold.ts";
import type { BlockReceipt } from "../shared/account-devices-api.ts";
import { verifyRelayProof } from "./relay/auth-proof.ts";
import { logAccess } from "./connection-diagnostics.ts";
import { type AccountPairing, type AccountPairingEnd, type AccountPairingState, type AccountPairingTurnedAway, type DevicePairedEvent, type DeviceRemovedEvent, type DevicePairToken, type DeviceRole, type DevicesRevokedAll, type PairedDevice, type DeviceConnection, STREAM_COOKIE_PREFIX } from "../shared/protocol.ts";
import type { MuxClock } from "../shared/relay-mux-engine.ts";
import { ownerAccess, type Access } from "./access.ts";
import { CLEAR_LEGACY_DEVICE_COOKIE, COOKIE_MAX_AGE_SECONDS, DEVICE_COOKIE_CLEARED, deviceCookie, isSecureRequest, noContent, parseCookies } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { privateStateRefusal, writePrivateState } from "./private-state.ts";
import { STABLE_NODE_ID } from "./tailscale.ts";
import type { TailnetNodes } from "./tailnet-nodes.ts";

/** How long a pairing code pairs new devices. */
export const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const LAST_SEEN_WRITE_MS = 60_000;
const UNCONFIRMED_FIRST_PAIR_LIMIT = 8;
const LABEL_MAX = 48;
const PAIRING_WINDOW_MS = 10 * 60_000;
/** A device that paired with a code made for a PC in no account has this long to link itself into an account. */
export const PAIRING_LINK_MS = 30_000;
/** The pairings one such code takes: each makes a row that waits to link, and nothing gives one back. */
export const PAIRING_USES = 5;
/** The links one waiting row may send; the next turns it away. */
const WAITING_LINKS = 5;
/** Codes made for an account that ended, kept for a read of how they ended (accountPairingState): the latest ones. */
const ENDED_ACCOUNT_CODES = 8;

/** A clock that only moves forward, never the PC's wall clock: what a waiting row's time is counted on (DeviceStore.useClock). */
const MONOTONIC: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    // a bound that is still running never keeps a stopping server alive
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class PairingRateLimitedError extends Error {
  readonly code = "pairing_rate_limited";
  constructor(readonly retryAfter: number) {
    super("Too many pairing attempts; try again later");
  }
}

/**
 * The paired device a request came from is paired no more: it was revoked while the request was on its way (a relay
 * round trip, a look-up of who asks). It gets no pairing code: a code held by a device that is already gone is one
 * no revoke ends.
 */
/** A link would replace a key approved on this PC's screen, from an app that did not ask to (T7): nothing changed. */
export class ReplacementNeedsAppError extends Error {
  constructor() { super("Replacing a key approved on this PC's screen needs an app that shows the replacement's fingerprint"); }
}

export class DeviceGoneError extends Error {
  readonly code = "unauthorized";
  constructor() {
    super("this device is no longer paired");
  }
}

/**
 * The paired device a request came from may only watch by now: it was made one while the request was on its way (a
 * relay round trip). It gets no pairing code either: holding one is a driver's right.
 */
export class DeviceReadOnlyError extends Error {
  readonly code = "read_only";
  constructor() {
    super("this device can only watch");
  }
}

/**
 * This PC is in an account, so no code is made that would put it in one (DeviceStore.pairingForNoAccount): a device
 * joins a PC that has members by signing in to their account, with a member's approval (docs/account.md).
 */
/** The final admission guard refused (G3): the PC is locked or closed to the key. Nothing was written. */
/** What a key confirm proves to the admission guard: that code's reserved key, confirmed on this PC's screen or by ovis recover. */
export interface ConfirmProof { readonly codeId: string; readonly key: string; readonly source: "screen" | "recover"; readonly recoveredOver?: readonly string[] }
/** The proofs admitConfirmed made from a live reservation; admits() honours no other. */
const MINTED_PROOFS = new WeakSet<ConfirmProof>();
/** How long a key waiting to replace a screen-approved key waits for its confirm (P22). */
const REPLACEMENT_TTL_MS = 5 * 60_000;

export type KeyRemovedCause = "revoke" | "remove" | "block" | "revoke_all";

export class AdmissionRefusedError extends Error {
  constructor() { super("This PC admits no new device while a lock, a block or a freeze stands"); }
}

export class PcInAccountError extends Error {
  readonly code = "in_account";
  constructor() {
    super("This PC is already in an Ovis account. Sign in to that account on the device to add it.");
  }
}

/**
 * An offer named the code it is to carry by its id (`x-ovis-pairing`), and that code is no longer the one pending, or
 * not one the offer can carry: no code is started, and the one pending stays as it was (pairingForAccount).
 */
export class PairingGoneError extends Error {
  readonly code = "pairing_gone";
  constructor() {
    super("The code this offer names is no longer the one pending on this PC; no new code was made.");
  }
}

/**
 * The relay tab's code is past its ten minutes while a device that paired with it in time may still link: no new code
 * is made, since one would end that device's pairing. `retryAfter`: the seconds until the last such device's time to
 * link is over.
 */
export class PairingFinishingError extends Error {
  readonly code = "pairing_finishing";
  constructor(readonly retryAfter: number) {
    super("A device that paired with this PC's code is still linking; a new code follows once it is done.");
  }
}

/** Canonical base64url SPKI containing a public P-256 key, never private key material. */
function isRelayPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return false;
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && key.export({ format: "der", type: "spki" }).equals(bytes);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export interface StoredDevice {
  id: string;
  label: string;
  role: DeviceRole;
  token_hash: string;
  relay_public_key?: string;
  created_at: string;
  last_seen_at: string | null;
  account?: string;
  /** the account member on this PC that approved it from another device; absent when this PC or a code admitted it */
  added_by?: string;
  linked_at?: string;
  /**
   * whether a `link` gave the row a key other than the one it was paired with here; false when every link kept
   * the paired key (the usual link, which only joins the account). Absent on a row never linked, and on one linked
   * before this was recorded: that one counts as kept, as it did then.
   */
  link_moved_key?: boolean;
  /** the signed `add` that let this row in, as received: /api/account/status lists it for a client to hand on */
  account_add?: unknown;
  /**
   * the account whose member approved the pairing that made the row, as it stood then: a remote approval, or a code a
   * member started (and still was a member of that account when the code was used); `added_by` names that member.
   * Absent when `added_by` names a starter that was no member then, and on every other row. Only a link into this same
   * account counts as the member's (linkAccountKey): any other is on the device's own word.
   */
  member_approved_in?: string;
  /**
   * On the row of another PC of the account that was taken in to watch (a vouched join): the relay key that join
   * proved, as 64 hex. It says which PC the row is, so that on a PC pinned to its account's list the list answers
   * for it: the row opens a session only while the list holds that relay key as a PC that is in. Absent on every
   * other row, and on such a row made before this was recorded.
   */
  vouched_pc?: string;
  /**
   * how a `link` made the row a member (docs/account.md, "How a device joined"): set once, by the link that took it from
   * no account into one, and kept by every later link. Absent on a row that became a member before this was recorded,
   * and on one an account member's signature (`add`) or approval (`member_approved_in`, for that account) stands behind. A value this PC does
   * not know is kept as it is and counts as `word`.
   */
  joined_by?: JoinedBy;
  /** where this PC admitted the row from, and its place in this PC's own order (server/account/admission-order.ts) */
  origin?: RowOrigin;
  /** A clock-ahead legacy stamp has no authority, even after the clock catches up. */
  untrusted_created_at?: string;
  /** Cookie paired locally during this binding's service opt-out. It has a normal admission number. */
  off_pair_binding?: string;
  /** Service lines in force when the owner recovered this key here; never covers a later freeze. */
  recovered_over?: readonly string[];
  invalid_origin?: true;
  /** a copy a sibling merge brought into this dir with the release flag on: no row of this dir's own, never legacy (T50) */
  imported?: true;
  /** A promoted list admission keeps the original notice ID until its hold ends. */
  held?: string;
  /** A promoted admission's open notice when the member no longer carries a hold. */
  carried_notice?: string;
  /** the account removals of its key that its pairing on this PC knew, and stands over (P13) */
  paired_over?: string[];
  /** the Tailscale StableNodeIDs its own credential arrived from, oldest first: removing the row keeps them out (tailnet-nodes.ts) */
  tailnet_nodes?: string[];
}

/**
 * `code`: the row paired with a code made for a PC in no account and linked into the account that code held it to, on
 * a PC from before such a link needed the account's word; `service`: such a code was alive and the account service
 * vouched for the key the row took (records.ts applyLink);
 * `word`: any other link, on the device's own word.
 */
export type JoinedBy = "code" | "service" | "word";
/** The marks of a member something other than the device itself vouched for: every other mark is its own word. */
export const VOUCHED: ReadonlySet<unknown> = new Set<JoinedBy>(["code", "service"]);

/**
 * The three ways relay pairing failures are counted (docs/account.md, "Who may admit a device"): codes
 * and comparisons for this PC alone, comparisons asking to join the account, and another PC of the
 * account vouched for, so a flood of one kind cannot pause the others.
 */
export type PairingPath = "code" | "account" | "vouched";
/** The relay's paths, and codes typed on the LAN HTTPS listener (server/lan-https.ts), counted apart so LAN guessing cannot pause relay pairing. */
export type PairingFailurePath = PairingPath | "lan";

interface UnconfirmedFirstPair {
  device: StoredDevice;
  expires: number;
  origin: readonly string[];
}

/**
 * A browser's stream keys (shared/protocol.ts, "Browser stream keys"): HttpOnly cookies named
 * `ovis_stream_<32 hex>` with the value `1`. They grant nothing. The key is in the NAME, so
 * two answers that each issue one (two tabs opening at once, before either had a key) add two
 * cookies instead of the second overwriting the first: every later request of that browser,
 * the pairing included, carries every key any of its streams was opened with.
 */
const STREAM_KEYS_MAX = 8;
const STREAM_KEY = /^[0-9a-f]{32}$/;

/** Malformed names or values are ignored, never refused. */
export function streamKeys(request: Request): string[] {
  const keys: string[] = [];
  for (const [name, value] of parseCookies(request.headers.get("cookie"))) {
    if (!name.startsWith(STREAM_COOKIE_PREFIX) || value !== "1") continue;
    const key = name.slice(STREAM_COOKIE_PREFIX.length);
    if (STREAM_KEY.test(key) && !keys.includes(key)) keys.push(key);
    if (keys.length === STREAM_KEYS_MAX) break;
  }
  return keys;
}

/** The request names `application/json` among the types it accepts: a browser's fetch sends `*\/*` and never asks. */
function acceptsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((type) => type.split(";")[0]!.trim().toLowerCase() === "application/json");
}

export function newStreamKey(): string {
  return randomBytes(16).toString("hex");
}

export function streamCookie(key: string, secure: boolean): string {
  return `${STREAM_COOKIE_PREFIX}${key}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function sameBrowser(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

export interface DeviceMatch {
  id: string;
  label: string;
  role: DeviceRole;
  /**
   * Set by the relay session on one request, never kept: the row waited to link when that request began
   * (server/relay/session.ts), so the request is one of its two calls.
   */
  provisional?: true;
}

/** What stood when a link arrived (DeviceStore.linkArrived): its checks are held to it. */
export interface LinkArrival {
  /** whether the row had paired with a code made for a PC in no account and not linked */
  readonly provisional: boolean;
  /**
   * the code made for a PC in no account that was alive (DeviceStore.pinnedCode), or null: while one is, every link
   * is held to its account and needs the account service's word. Compared only with what is alive later
   */
  readonly pinned: object | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function normalizeLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return label || fallback;
}

export function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "drive" || value === "watch";
}

/**
 * `placeholder`: written only to close the gate where there was no registry (state-merge.ts); it says
 * nothing about which devices were revoked. The store's next save drops the mark.
 */
export type DeviceRegistry = { kind: "missing" } | { kind: "ok"; gateClosedAt: string | null; devices: StoredDevice[]; placeholder: boolean } | { kind: "bad" };

export function readDeviceRegistry(path: string, opensAll = accountOpensAll(), repair = true): DeviceRegistry {
  // one another account could write is as unreadable as a damaged one: the gate stays closed
  const refused = privateStateRefusal(path, undefined, undefined, repair);
  if (refused !== null) {
    console.error(`devices.json is not trusted: ${refused}`);
    return { kind: "bad" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
  }
  return parseDeviceRegistry(parsed, opensAll);
}

export function parseDeviceRegistry(parsed: unknown, opensAll: boolean): Exclude<DeviceRegistry, { kind: "missing" }> {
  if (!isJsonObject(parsed) || !Array.isArray(parsed.devices)
    || !(parsed.gate_closed_at === null || typeof parsed.gate_closed_at === "string")
    || !parsed.devices.every((d) => isJsonObject(d) && typeof d.id === "string"
      && typeof d.token_hash === "string" && isDeviceRole(d.role)
      && (d.relay_public_key === undefined || isRelayPublicKey(d.relay_public_key))
      && typeof d.label === "string" && typeof d.created_at === "string"
      && (d.last_seen_at === null || typeof d.last_seen_at === "string")
      && (d.account === undefined || typeof d.account === "string")
      && (d.added_by === undefined || typeof d.added_by === "string")
      && (d.vouched_pc === undefined || (typeof d.vouched_pc === "string" && /^[0-9a-f]{64}$/.test(d.vouched_pc)))
      && (d.linked_at === undefined || typeof d.linked_at === "string")
      && (d.link_moved_key === undefined || typeof d.link_moved_key === "boolean")
      && (d.imported === undefined || d.imported === true)
      && (d.invalid_origin === undefined || d.invalid_origin === true)
      && (d.off_pair_binding === undefined || (typeof d.off_pair_binding === "string" && /^[0-9a-f]{32}$/.test(d.off_pair_binding)))
      && (d.recovered_over === undefined || Array.isArray(d.recovered_over) && d.recovered_over.every(id => typeof id === "string" && /^(?:f:)?[0-9a-f]{64}$/.test(id)))
      && (d.untrusted_created_at === undefined || typeof d.untrusted_created_at === "string")
      && (d.account_add === undefined || isJsonObject(d.account_add))
      && (!opensAll || (d.held === undefined || (typeof d.held === "string" && /^[0-9a-f]{32}$/.test(d.held)))
        && (d.carried_notice === undefined || (typeof d.carried_notice === "string" && /^[0-9a-f]{32}$/.test(d.carried_notice))))
      && (d.paired_over === undefined || (Array.isArray(d.paired_over) && d.paired_over.every((id) => typeof id === "string")))
      && (d.tailnet_nodes === undefined || (Array.isArray(d.tailnet_nodes) && d.tailnet_nodes.every((id) => typeof id === "string" && STABLE_NODE_ID.test(id))))
      )) return { kind: "bad" };
  // an origin that cannot be read is no age (P22): the row stays, without it
  const devices = (parsed.devices as StoredDevice[]).map((d) => d.origin === undefined || isRowOrigin(d.origin) ? d
    : (({ origin: _unreadable, ...rest }) => ({ ...rest, invalid_origin: true as const }))(d));
  return { kind: "ok", gateClosedAt: parsed.gate_closed_at, devices, placeholder: parsed.placeholder === true && parsed.devices.length === 0 };
}

/**
 * A key removed through the account, kept in `account-tombstones.json` beside devices.json; `records`
 * are the signed `remove`s that removed it, as received, one per signer (at most
 * TOMBSTONE_RECORDS_MAX), which a client relays to a PC it enrolls (#2956).
 */
export interface AccountTombstone { key: string; account: string; record_id: string; removed_at: string; records?: unknown[] }

/** Signed removals kept per tombstone: one per signer, so a PC where only a later signer is a member can still apply one. */
export const TOMBSTONE_RECORDS_MAX = 8;

function withRecords(records: readonly unknown[] | undefined, more: readonly unknown[]): unknown[] | undefined {
  const signer = (record: unknown) => isJsonObject(record) ? record.signer : undefined;
  const kept = [...records ?? []];
  for (const record of more) {
    if (kept.length >= TOMBSTONE_RECORDS_MAX || kept.some((own) => signer(own) === signer(record))) continue;
    kept.push(record);
  }
  return kept.length ? kept : undefined;
}

/** Every tombstone a folder holds, its pending file's included, as read before any merge coalesces them (T48). */
export function folderTombstones(dir: string): AccountTombstone[] {
  // An unreadable file is refused where it is read for real: by mergeAccountTombstones or by its own folder's store.
  return ["account-tombstones.json", "account-tombstones.pending.json"].flatMap((file) => readTombstones(join(dir, file)) ?? []);
}

/** The same file shape for startup recovery, without opening a DeviceStore. */
export function parseTombstones(value: unknown): AccountTombstone[] | null {
  if (!isJsonObject(value) || value.v !== 1 || !Array.isArray(value.tombstones)
    || !value.tombstones.every((t) => isJsonObject(t) && typeof t.key === "string" && typeof t.account === "string"
      && typeof t.record_id === "string" && typeof t.removed_at === "string" && (t.records === undefined || Array.isArray(t.records)))) return null;
  return value.tombstones as AccountTombstone[];
}

/** Null for a file that exists and will not parse; an absent file holds no tombstones. */
function readTombstones(path: string): AccountTombstone[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  return parseTombstones(parsed);
}

/**
 * The tombstones of two state dirs that share one device registry (state-merge.ts), written to both:
 * a key removed in either stays removed in both. Per key the later removal is kept. A file that will
 * not parse is left as it is, and the store then refuses account records there.
 */
export function mergeAccountTombstones(active: string, sibling: string, opensAll = false): string | null {
  // with the flag on every local time met isIsoTime; with it off, main's own string order
  const after = (a: string, b: string) => opensAll ? Date.parse(a) > Date.parse(b) : a > b;
  const paths = [join(active, "account-tombstones.json"), join(sibling, "account-tombstones.json")];
  const read = paths.map(readTombstones);
  // the active dir's own unreadable file stops its store anyway; a sibling's must too, or its removals are lost
  if (read[1] === null) return `Cannot read ${paths[1]}: account records are refused until it is restored or fixed.`;
  if (read[0] === null) return null;
  const pending = [active, sibling].flatMap((dir) => readTombstones(join(dir, "account-tombstones.pending.json")) ?? []);
  const merged = new Map<string, AccountTombstone>();
  for (const tombstone of [...read.flatMap((list) => list ?? []), ...pending]) {
    const kept = merged.get(tombstone.key);
    if (!kept) { merged.set(tombstone.key, tombstone); continue; }
    // the account's removal outranks a revoke on the PC (only it keeps a relay code out), with the later of the two times
    const local = (t: AccountTombstone) => t.record_id === "local";
    const winner = local(kept) && !local(tombstone) ? tombstone : !local(kept) && local(tombstone) ? kept : after(tombstone.removed_at, kept.removed_at) ? tombstone : kept;
    const removedAt = after(tombstone.removed_at, kept.removed_at) ? tombstone.removed_at : kept.removed_at;
    const records = local(winner) ? undefined : withRecords(winner.records, [...kept.records ?? [], ...tombstone.records ?? []]);
    const { records: _records, ...rest } = winner;
    merged.set(tombstone.key, { ...rest, removed_at: removedAt, ...(records ? { records } : {}) });
  }
  const tombstones = [...merged.values()];
  for (const [index, path] of paths.entries()) {
    if ((read[index] ?? []).length !== tombstones.length || tombstones.some((t) => !read[index]?.some((own) => own.key === t.key && own.removed_at === t.removed_at && own.record_id === t.record_id && JSON.stringify(own.records ?? []) === JSON.stringify(t.records ?? [])))) {
      writePrivateState(path, { v: 1, tombstones });
    }
  }
  return null;
}

/**
 * A device that paired with a code made for a PC in no account and has not linked: in memory only, never in
 * devices.json, and shown to its own relay session alone (DeviceStore.sessionRow).
 */
interface ProvisionalRow {
  /** a screen or recover confirm of its key (T72): its link admits it with that origin */
  readonly confirmed?: { readonly proof: ConfirmProof; readonly how: "code" | "qr"; readonly by?: string };
  readonly id: string;
  readonly label: string;
  /** the key its PAIR named; only an AUTH proves it */
  readonly key: string;
  /** on the store's clock */
  readonly pairedAt: number;
  /** the links it sent */
  links: number;
  /** what its last link is waiting for, or got: the account service's word, or no answer from it */
  link?: "asked" | "service_unreachable";
  /** ends its link window: set again while a replacement of its key waits on the screen */
  cancel: () => void;
}

/** What a code made for a PC in no account holds besides its six digits: the pairings it still takes, and the rows that wait to link. */
interface WaitingRows {
  usesLeft: number;
  readonly rows: Map<string, ProvisionalRow>;
  /** Once confirmed, only this row can use the code to join; its link window stays open. */
  confirmedId?: string;
  /** set while the link of one of its rows is written (promote): the device the code's end names */
  joined?: { readonly device_id: string; readonly label: string };
  /** every row of this code that went without becoming a member, oldest first */
  readonly turnedAway: AccountPairingTurnedAway[];
}

/**
 * Whether the row is a pairing of its current key made on this PC (a code, or a comparison approved here): not a
 * row an account record or a remote approval made (`added_by`), and not one a `link` moved onto the key from the
 * key it was paired with, which never paired this key here. A link that kept the paired key changes nothing.
 */
export function repairEvidenceRows(rows: readonly StoredDevice[], latest: number) {
  return rows.map(row => ({ relay_public_key: row.relay_public_key, created_at: row.created_at,
    pairedHere: pairedHere(row) && !row.imported && !row.invalid_origin && row.untrusted_created_at !== row.created_at
      && isIsoTime(row.created_at) && Date.parse(row.created_at) <= latest }));
}

function unnumberedPairing(row: StoredDevice, entries: readonly JournalEntry[]): boolean {
  return row.origin === undefined && !row.imported && !row.invalid_origin && row.held === undefined
    && row.carried_notice === undefined && row.paired_over === undefined && isIsoTime(row.created_at)
    && !entries.some(entry => entry.row === row.id);
}

export function futureLegacyPairing(row: StoredDevice, entries: readonly JournalEntry[], now: number): boolean {
  return !row.imported && (row.origin?.from === "legacy" || unnumberedPairing(row, entries)) && isIsoTime(row.created_at) && Date.parse(row.created_at) > now + DAY_MS;
}

function pairedHere(device: StoredDevice): boolean {
  return device.added_by === undefined && device.link_moved_key !== true;
}

/**
 * A row a first-link code of this PC paired, whose link kept the key that code admitted: it was numbered as it linked
 * (`link`), by no member, and its key never moved. The credential is this PC's own; its membership is the account's.
 */
function keptFirstLinkKey(row: StoredDevice): boolean {
  const origin = row.origin;
  return origin?.from === "remote" && origin.how === "link" && origin.by === null && row.link_moved_key === false;
}

function keepsPairingOnUnlist(row: StoredDevice): boolean {
  const origin = row.origin;
  return !row.imported && !row.invalid_origin && (origin?.from === "pc" || (pairedHere(row) && row.account_add === undefined &&
    (origin?.from === "legacy" || (origin?.from === "remote" && (origin.how === "code" || origin.how === "digits") && origin.by === null) || keptFirstLinkKey(row))));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a thrown value says, for a log line; a value that cannot be told says so. */
function describe(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); } catch { return "an error that cannot be described"; }
}
/** How many keys may hold a reservation of one code at once (T71). */
export const PENDING_PER_CODE = 5;
const tailnetNodesOf = (rows: readonly StoredDevice[]): string[] => [...new Set(rows.flatMap((d) => d.tailnet_nodes ?? []))];

export class DeviceStore {
  private devices: StoredDevice[] = [];
  /** when the first device was paired: from then on, only this PC, the owner's login, a device or the token get in */
  private gateClosedAt: string | null = null;
  /**
   * `remote`: started through the relay, so it never lets a removed key back in; `startedBy`: the account
   * member that started it there, whose addition the new device then is; `holders`: the paired devices that
   * started it or were handed it, on any transport. It ends when one of them is revoked (`revoke`)
   */
  /**
   * `open`: started by a request the open LAN alone let in (access.ts `via: "open"`), so it ends when the gate closes;
   * `noAccountOnly`: made to put this PC in an account (pairingForNoAccount), so it ends when the PC is in one;
   * `waiting`: what such a code holds, the devices that paired with it through the relay and have not linked;
   * `id`: names the code to a caller that ends or reads it (endPairing, accountPairingState);
   * `named`: such a code made for one account (startAccountPairing), whose waiting devices are taken into it alone;
   * `expires`: the wall-clock end of its ten minutes, which its `expires_at` shows; `deadline`: the same end on the
   * store's clock, which only moves forward; `over`: set the first time either says its ten minutes are over (codeOver)
   */
  private pending: { code: string; id: string; expires: number; deadline: number; over?: true; attempts: number; lanAttempts?: number; remote: boolean; startedBy: string | null; approvedIn?: string; memberRequired: boolean; ownPc?: boolean; open?: boolean; noAccountOnly?: boolean; atPc?: true; holders: Set<string>; waiting?: WaitingRows; named?: { readonly account: string }; issuedUnder?: string; reserved?: Map<string, { readonly key: string; readonly how: "code" | "qr" }>; cancelExpiry?: () => void } | null = null;
  private readonly pairingEndedListeners = new Set<(codeId: string) => void>();
  /** How the latest codes made for an account ended, newest last: ENDED_ACCOUNT_CODES at most, in memory only. */
  private endedAccountCodes: Extract<AccountPairingState, { state: "ended" }>[] = [];
  /** What a row that waits to link, and the redemption of a code, is bounded on (useClock). */
  private clock: MuxClock = MONOTONIC;
  private codeIssues: number[] = [];
  private readonly relayFailures: Record<PairingFailurePath, { at: number[]; blockedUntil: number }> = {
    code: { at: [], blockedUntil: 0 }, account: { at: [], blockedUntil: 0 }, vouched: { at: [], blockedUntil: 0 }, lan: { at: [], blockedUntil: 0 },
  };
  /** First-pair cookies are not devices, and do not close the gate, until one returns. */
  private unconfirmedFirstPairs: UnconfirmedFirstPair[] = [];
  private readonly path: string;
  private readonly revocations = new Map<string, Set<(waiting?: true) => void>>();
  private readonly relinks = new Map<string, Set<(sessionId: string) => void>>();
  /** keys waiting to replace a screen-approved key, by row (T72): in memory only, so a restart drops them (P22) */
  private readonly replacements = new Map<string, { key: string; account: string; at: number; challenge: string; sessionId: string; vouched: boolean; ownWord: boolean; waitingRow?: true }>();
  private readonly revokeAllListeners = new Set<() => void>();
  private readonly gateListeners = new Set<() => void>();
  private readonly pairings = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  private readonly codeStarts = new Set<() => void>();
  private readonly removals = new Set<(event: DeviceRemovedEvent, key: string | undefined) => void>();
  private readonly tombstonePath: string;
  private readonly pendingTombstonePath: string;
  /** Keys removed through the account (docs/account.md, rule 5); only a pairing on this PC clears one. */
  private tombstones: AccountTombstone[] = [];
  /** Why account records cannot be applied: a tombstone file that will not parse is not an empty one. */
  private accountProblem: string | null = null;
  readonly error: string | null = null;

  /**
   * `blocked`: why the registry may lack devices that must stay paired (state-merge.ts could not
   * take over the other state dir's): the store then stays gated and changes nothing, as for a
   * damaged registry, while the devices it holds still get in.
   */
  /** `accountBlocked`: why account records cannot be trusted here (a sibling dir's tombstones that could not be merged). */
  /**
   * `account`: the account-opens-all state, with OVIS_ACCOUNT_OPENS_ALL on. `safety`, the safety log
   * (server/account/safety-log.ts), and `pc`, this PC's account state (server/account/pc-binding.ts): while either
   * fails closed no device signs in or pairs and account records are refused, so only this PC itself gets in. With
   * `pc`, every row admitted gets its origin and the PC's account is its binding, not its rows.
   */
  private readonly safety: SafetyLog | null;
  private accountOrder: AccountOrder | null = null;
  private accountOrderServerId: (() => string | null) | undefined;
  readonly handedLifts: HandedLifts;
  private joinedRows: AccountRowSource | null = null;
  private readonly promotedHolds = new PromotedHolds((key) => this.admits(key), (row) => {
    if (this.opensAll()) this.releasePromoted(row);
  });
  private catchUp: CatchUpGate | null = null;
  private releases?: RecoveryReleases;
  private readonly pc: PcAccountState | null;
  private readonly evidence: RemovalEvidence | null;
  private readonly accountHeld: ((key: string) => boolean) | undefined;
  private readonly siblingLegacyCredential: ((row: StoredDevice) => boolean) | undefined;
  /** every tombstone of this folder and its sibling as read before any coalescing merge (T48): each is evidence */
  private readonly carried: readonly AccountTombstone[];
  private readonly journal: DeviceJournal | null;
  private readonly noticeListeners = new Set<(entry: JournalEntry) => void>();
  private readonly listAdmissions = new Set<(rows: readonly AccountRow[]) => void>();
  private readonly listedChanges = new Set<() => void>();
  private readonly keyRemovedListeners = new Set<(key: string, cause: KeyRemovedCause) => void>();
  /** A deny that could not reach the disk (P8 step 1): only this PC itself gets in until one is written. */
  private denyProblem: string | null = null;
  private readonly revokeAllPath: string;
  private readonly stateDirPath: string;
  private readonly revokeAllIntent: RevokeAllIntent | null;
  /** A restored file is not part of this process's view until the next open. */
  private waitingForListedRestore = false;
  private futureProblem: string | null = null;
  private readonly restampProblem: string | null;
  constructor(stateDir: string, blocked: string | null = null, accountBlocked: string | null = null, account: { safety?: SafetyLog | null; pc?: PcAccountState | null; removals?: RemovalEvidence | null; journal?: DeviceJournal | null; carried?: readonly AccountTombstone[]; joinedRows?: AccountRowSource | ((devices: DeviceStore) => AccountRowSource | null) | null; held?: (key: string) => boolean; restampProblem?: string | undefined; restampRetry?: boolean; reconcileRestamp?: boolean; revokeAllOnly?: boolean; siblingLegacyCredential?: (row: StoredDevice) => boolean } = {}) {
    this.joinedRows = typeof account.joinedRows === "function" ? account.joinedRows(this) : account.joinedRows ?? null;
    this.safety = account.safety ?? null;
    this.handedLifts = new HandedLifts(stateDir);
    this.pc = account.pc ?? null;
    // a clear from before the add-at-the-PC rule is dated now, before anything this run admits
    this.pc?.addAtPcSince();
    this.stateDirPath = stateDir;
    this.revokeAllPath = join(stateDir, "revoke-all.json");
    this.evidence = account.removals ?? null;
    this.accountHeld = account.held;
    this.siblingLegacyCredential = account.siblingLegacyCredential;
    // removal evidence this PC wrote once and that is gone now is damage, never a fresh start (S19)
    if (this.evidence !== null && this.pc?.evidenceWritten() === true) this.evidence.missingAfterWritten();
    this.carried = account.carried ?? [];
    this.journal = account.journal ?? null;
    this.restampProblem = account.restampProblem ?? null;
    this.path = join(stateDir, "devices.json");
    this.tombstonePath = join(stateDir, "account-tombstones.json");
    this.pendingTombstonePath = join(stateDir, "account-tombstones.pending.json");
    const tombstones = readTombstones(this.tombstonePath);
    const pendingRead = readTombstones(this.pendingTombstonePath);
    const pending = pendingRead ?? [];
    if (accountBlocked !== null) this.accountProblem = accountBlocked;
    // a pending tombstone file that cannot be read holds Revokes nobody can tell: kept, and the PC refuses (S19)
    if (pendingRead === null && this.evidence !== null) this.accountProblem = `Cannot read ${this.pendingTombstonePath}: account records are refused until it is restored or fixed.`;
    if (tombstones === null) {
      this.accountProblem = `Cannot read ${this.tombstonePath}: account records are refused until it is restored or fixed.`;
      this.tombstones = pending;
    } else this.tombstones = [...tombstones, ...pending.filter((t) => !tombstones.some((own) => own.key === t.key))];
    const read = readDeviceRegistry(this.path, this.opensAll(), this.restampProblem === null);
    if (read.kind === "ok") {
      this.gateClosedAt = read.gateClosedAt;
      this.devices = read.devices;
    } else if (read.kind === "bad") {
      // A damaged registry is not a first installation. Keep it intact for recovery and
      // let the existing local/token/Tailscale routes provide access to the owner.
      this.error = `Cannot read ${this.path}. Restore a valid devices.json or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      console.error(this.error);
    }
    if (blocked !== null && this.error === null) {
      this.error = blocked;
      console.error(this.error);
    }
    // the tombstone files' own repair asks only whether they could be read: a strict safety log is a separate refusal
    // a Revoke all that stopped half way is finished before anything is served, whatever else could not be read (P8, T41)
    this.revokeAllIntent = this.evidence === null ? null : new RevokeAllIntent(stateDir, this.revokeAllRows());
    if (this.evidence) this.journal?.checkRowReceipts(this.evidence.rowDrops);
    if (this.restampProblem !== null) {
      // A sibling that finished rolling back may not yet have its own journal companions.
      if (account.restampRetry && this.restampRefusal(true) === null) {
        if (!account.reconcileRestamp) this.migrate();
        this.prepareRestampAudit();
      }
      return;
    }
    if (this.journal?.strict || this.evidence?.strict) return;
    // an account registry that will not read is not empty: every intent stays and nothing is written until it reads
    if (this.joinedRows?.blocked()) return;
    if (this.error === null) {
      try {
        this.resumeRevokeAll();
      } catch {
        // what could not be finished on disk is finished in memory, and the PC fails closed until a start finishes it
        this.devices = [];
        this.gateClosedAt ??= new Date().toISOString();
      }
    }
    if (account.revokeAllOnly) return;
    // a strict order changes nothing else on disk, not even a repair: its damage stays visible (S29)
    // a damaged pending file beside a readable tombstone file: the Revokes the readable one holds are evidence at once,
    // and neither file is touched until the damaged one is repaired (T26, S19)
    const now = Date.now();
    if (this.error === null && this.evidence !== null && this.evidence.strict === null && this.safety?.strict == null && this.pc?.strict == null) {
      if (this.accountProblem === null) this.quarantineLegacyClock(now);
      if (pendingRead === null && tombstones !== null) this.evidence.importDenials([...this.carried, ...tombstones]);
    }
    // Malformed legacy tombstones are damaged evidence. Valid Step 1 dates retain the denial
    // without making its wall clock authoritative for Step 2 (S19, P13).
    if (this.evidence !== null) {
      const invalidRevoke = [...this.carried, ...this.tombstones]
        .find(t => t.record_id === "local" && !isIsoTime(t.removed_at));
      const ahead = invalidRevoke?.removed_at ?? this.ownTimes().find(t => !isIsoTime(t) || Date.parse(t) > now + DAY_MS);
      if (ahead !== undefined) this.futureProblem = `A time this PC wrote lies in the future (${ahead}): account records are refused until it is repaired.`;
    }
    if (this.error === null && this.accountProblem === null && this.futureProblem === null && this.pc?.strict == null && !this.revokeAllIntent?.strict) {
      if (this.evidence !== null) {
        const evidence = this.evidence;
        evidence.recover(() => {
          this.finishJournalledRemovals();
          // A standing lock ends its remaining rows before anything is served.
          if (this.safety?.strict === null && this.safety.inForce.locked === true) this.endUnlockedRows();
          this.takeInEvidence([...tombstones ?? [], ...pending]);
          // the log is the truth (P24): restore any missing block marker before anything is served
          this.markBlockTargets();
          this.joinedRows?.pruneDenied(evidence);
        });
        if (evidence.strict !== null) return;
      } else {
        if (pending.length) {
          this.writeTombstones(this.tombstones);
          rmSync(this.pendingTombstonePath, { force: true });
        }
        this.finishInterruptedWrites();
      }
    }
    // a start that cannot write still knows which rows a standing lock ended: they stay out for this whole run, also
    // after an unlock, and an unlock waits until they are written (pendingLockRemovals, S2-18)
    if (this.evidence !== null && this.safety?.strict === null && this.safety.inForce.locked === true) {
      for (const device of this.devices) if (device.origin?.from !== "pc") this.lockHeld.add(device.id);
    }
    // the one-time legacy pass asks only whether the registry could be read: nothing is admitted before it (T50)
    if (this.error === null) this.migrate();
    if (this.futureProblem !== null && this.restampRefusal(false) === null) {
      // Normally replay makes the journal's companions. A clock-blocked startup skips replay, but the first
      // restamp audit still needs both companions to exist before the recovery socket can take a request.
      this.prepareRestampAudit();
    }
    if (this.error === null && this.accountError === null) this.applyWaitingBlocks();
    // evidence on disk at start counts as written, also for a PC that wrote it before this mark existed (S19)
    if (this.error === null && this.evidence?.onDisk === true && this.evidence.strict === null) this.pc?.noteEvidenceWritten();
  }

  private prepareRestampAudit(): void {
    this.evidence?.recover(() => {
      this.pc?.ensureRestampAudit();
      this.evidence?.ensureFile();
      this.safety?.ensureFile();
    });
  }

  /**
   * At load (T26, P13): every tombstone of both files, the pending one's included, is taken in as evidence before
   * anything is coalesced; the tombstone file is written again from the evidence; the pending file goes; and every row
   * the evidence covers goes. Nothing of it is told to anyone: no session is open yet.
   */
  /**
   * The rows a lock standing at open ended but this start could not write out (S2-18): refused for the whole run, and
   * an unlock is refused while any is left, so a later start without the lock cannot bring them back.
   */
  pendingLockRemovals(): string[] { return [...this.lockHeld]; }
  private readonly lockHeld = new Set<string>();

  /**
   * Whether the last journal entry naming row `id` removed it (P24): read at open from the journal on disk, and
   * followed from there, so a row admitted again since (journalAdmission) is no longer one.
   */
  private journalEnded(id: string): boolean {
    if (this.journalEndedRows === null) {
      this.journalEndedRows = endedJournalRows(this.journal?.strict === null ? this.journal.entries() : []);
    }
    return this.journalEndedRows.has(id);
  }
  private journalEndedRows: Set<string> | null = null;

  /**
   * The journal is the truth (P24): a removal is journalled before devices.json is written, so a stop between the two
   * leaves a row whose last journal entry ends it. Every such row ends here, at open and before anything is served,
   * whatever kind of removal it was; nothing is journalled again. The one finisher of journalled removals.
   */
  private finishJournalledRemovals(): void {
    if (this.journal === null || this.journal.strict !== null) return;
    const kept = this.devices.filter((d) => !this.journalEnded(d.id));
    if (kept.length === this.devices.length) return;
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.save(kept, gate);
    this.devices = kept;
    this.gateClosedAt = gate;
  }

  private takeInEvidence(found: readonly AccountTombstone[]): void {
    // evidence that cannot be trusted is never written over, and nothing is taken in while the safety log cannot be
    // read: a removal would record no forgettings it outranks, and an old forget redelivered later would end it (S19, T61)
    if (this.evidence!.strict !== null || this.safety?.strict != null) return;
    this.evidence!.takeIn([...this.carried, ...found], repairEvidenceRows(this.devices, Date.now() + DAY_MS), Date.now());
    // the tombstone file is written from the evidence before the pending file goes, so nothing pending is lost (T26)
    this.writeTombstones(this.evidence!.tombstones());
    rmSync(this.pendingTombstonePath, { force: true });
    const kept = this.devices.filter((d) => !this.coveredByEvidence(d));
    if (kept.length !== this.devices.length) {
      // a deny recovered at start raises the generation, as the live path does (P8, T41)
      this.pc?.raiseGen();
      const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
      this.save(kept, gate);
      this.devices = kept;
      this.gateClosedAt = gate;
    }
  }

  /**
   * The store's one sequence of times (T26, P13): never before `now`, and always after every time this store has
   * ordered (a row's making, a Revoke, an unrevoke, a tombstone), so what is made after something is always later.
   */
  /**
   * Whether time `a` is after (or with `orSame`, not before) time `b`. With the flag on both are parsed, as every time
   * met isIsoTime at open; with it off, main's own string order, whatever the files hold.
   */
  private later(a: string, b: string, orSame = false): boolean {
    if (this.evidence === null) return orSame ? a >= b : a > b;
    return orSame ? Date.parse(a) >= Date.parse(b) : Date.parse(a) > Date.parse(b);
  }

  /** The times this PC wrote itself: rows' making, its own tombstones and Revokes; never a time a record carries (P13). */
  private ownTimes(): string[] {
    return [...this.devices.filter(row => !row.imported && row.untrusted_created_at !== row.created_at).map(row => row.created_at), ...(this.joinedRows?.rows() ?? []).map(row => row.confirmed_at),
      ...this.evidence?.times() ?? []];
  }

  /** An unstamped Step-1 registry row, including a pairing written during rollback. */
  private legacyFromRegistry(row: StoredDevice): boolean { return unnumberedPairing(row, this.journal?.entries() ?? []); }

  private quarantineLegacyClock(now: number): void {
    const marked = this.devices.map(row => {
      return futureLegacyPairing(row, this.journal?.entries() ?? [], now) && row.untrusted_created_at !== row.created_at
        ? { ...row, untrusted_created_at: row.created_at } : row;
    });
    const bad = marked.find(row => row.untrusted_created_at === row.created_at);
    if (!bad) return;
    if (marked.every((row, index) => row === this.devices[index])) return;
    this.devices = marked;
    try { this.save(marked); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      this.accountProblem ??= `Cannot record an untrusted pairing time: ${error.message}`;
    }
  }

  nextStamp(now: number): string {
    const times = this.ownTimes();
    const last = Math.max(Number.NEGATIVE_INFINITY, ...times.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t)));
    return new Date(Math.max(now, last + 1)).toISOString();
  }

  /** The tombstone file as the evidence writes it (P13), written only when it changed. */
  private refreshTombstones(): void {
    const next = this.evidence!.tombstones();
    if (JSON.stringify(next) !== JSON.stringify(this.tombstones)) this.writeTombstones(next);
  }

  /**
   * Whether the evidence keeps this row out (P13): a Revoke of its key stands, or a standing marker of its key covers
   * it. A marker covers a row of its account, or one that names no account while this PC is in that account, unless
   * that row names no account and was paired here knowing every standing removal of the marker (`paired_over`).
   */
  private coveredByEvidence(device: Pick<StoredDevice, "relay_public_key" | "account" | "paired_over">): boolean {
    return this.evidence?.covers(device, this.account()) ?? false;
  }

  /**
   * A stop between the two writes of a removal leaves a row and the tombstone of its key; one between
   * the two writes of a pairing on this PC does too. Their times tell them apart: a row made after the
   * key's removal is the pairing's, and the tombstone goes; one made before it is the removal's, and
   * the row goes (`stale`, which nothing admits meanwhile).
   */
  private finishInterruptedWrites(): void {
    const tombstones = this.tombstones.filter((t) => !this.devices.some((d) => d.relay_public_key === t.key && !this.stale(d)));
    if (tombstones.length !== this.tombstones.length) {
      writePrivateState(this.tombstonePath, { v: 1, tombstones });
      this.tombstones = tombstones;
    }
    const devices = this.devices.filter((d) => !this.stale(d));
    if (devices.length !== this.devices.length) {
      const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
      this.save(devices, gate);
      this.devices = devices;
      this.gateClosedAt = gate;
    }
  }

  /** A row whose key was removed at or after the row was made: revoked, whether or not its own write happened yet. */
  private stale(device: StoredDevice): boolean {
    // while a lock stands only a row confirmed on this PC's screen gets in, whether or not its teardown ran (P11, T46)
    // a row whose last journal entry removed it is out, whether or not the start could finish that removal (P24)
    if (this.failedRows.has(device.id) || (device.relay_public_key !== undefined && this.failedDenies.has(device.relay_public_key))) return true;
    // a removal by the account's list that this PC acted on and has only in its mark so far (list-follow.ts) keeps
    // every row of the key out, as the removal's record will once it is on disk
    if (device.relay_public_key !== undefined && this.signedList?.owesRemoval(device.relay_public_key) === true) return true;
    // this server follows no list and found the PC pinned to one (closeAccountPart): no row under an account's id
    if (this.pinClosed !== null && device.relay_public_key !== undefined && accountDeviceId(this.pinClosed.serverId, device.relay_public_key) === device.id) return true;
    // main's own rule stays the floor under the evidence: a tombstone of this PC keeps its key out, whatever path took
    // the evidence in or skipped it (P13, rule 1)
    const tombstoned = device.relay_public_key !== undefined
      && this.tombstones.some((t) => t.key === device.relay_public_key
        && (device.untrusted_created_at === device.created_at || !pairedHere(device) || this.later(t.removed_at, device.created_at, true)));
    return tombstoned || (this.evidence !== null && (this.lockHeld.has(device.id) || this.journalEnded(device.id) || this.coveredByEvidence(device) || this.frozen(device) || (this.safety?.inForce.locked === true && device.origin?.from !== "pc")));
  }

  get accountError(): string | null {
    return this.accountIntegrityError ?? this.pinClosed?.reason ?? null;
  }

  /**
   * This server follows no list (it was started with Step 2 turned off) and found the PC pinned to its account's list
   * by another Ovis on this folder. It cannot ask the list, so it closes its account part: no session and no sign-in
   * under an account's id for a key, no account record, and `accountError` says why. A pairing this PC made itself
   * under an id of its own goes on. It stays so until this server is started again, which then follows the list.
   */
  closeAccountPart(reason: string, serverId: string): void {
    if (this.pinClosed !== null) return;
    this.pinClosed = { reason, serverId };
    this.closeListGovernedSessions(serverId);
  }
  private pinClosed: { readonly reason: string; readonly serverId: string } | null = null;

  /** The sessions of every row of this PC's own devices that holds `key` end, as for a row that changed under them. */
  closeKeySessions(key: string): void {
    for (const row of [...this.devices]) if (row.relay_public_key === key) this.closeAccountSessions(row.id);
  }

  /** A local denial does not need the listed registry; it still needs the rest of the PC's safety state. */
  get revokeAllError(): string | null {
    return this.revokeIntegrityError ?? this.denyProblem;
  }

  private get revokeIntegrityError(): string | null {
    return this.safety?.strict ?? this.pc?.strict ?? this.evidence?.strict ?? this.journal?.strict ?? this.accountProblem ?? this.restampProblem ?? this.futureProblem;
  }

  private get accountIntegrityError(): string | null {
    return this.revokeIntegrityError ?? this.denyProblem ?? this.revokeAllIntent?.strict ?? this.joinedRows?.blocked() ?? null;
  }

  /** A failed deny shuts out devices, not the PC's retry of a device removal. */
  localRemovalRetry(): boolean {
    return this.denyProblem !== null && this.revokeIntegrityError === null && this.error === null;
  }

  /** Restamp is not a repair for any other unreadable account or registry state. */
  restampRefusal(retry: boolean): string | null {
    return this.error ?? this.safety?.strict ?? this.pc?.strict ?? this.evidence?.strict ?? this.journal?.strict ?? this.denyProblem
      ?? this.accountProblem ?? this.revokeAllIntent?.strict ?? this.joinedRows?.blocked()
      ?? (retry ? null : this.restampProblem ?? (this.futureProblem === null ? "This PC is not closed by a future timestamp." : null));
  }

  /** No device gets in by a row or a code when the PC cannot trust its account state. */
  get failsClosed(): boolean {
    // one rule (S19): with the flag on, anything that makes account records refused makes only this PC get in
    return (this.safety !== null || this.pc !== null || this.evidence !== null) && this.accountIntegrityError !== null;
  }

  pendingNotMeRows(): ReadonlySet<string> {
    const account = this.account();
    const keys = new Set(this.safety?.waitingBlocks().filter(({ record }) => record.account === account).map(({ record }) => record.target));
    return new Set(this.devices.filter(row => row.relay_public_key !== undefined && keys.has(row.relay_public_key)).map(row => row.id));
  }


  /**
   * The one-time migration of a PC from before the upgrade (T50): the rows' one account becomes the binding, and every
   * row gets `legacy`. The rows go to disk before the account file that ends the migration, so a stop between the two
   * runs it again on the next start and never stamps a row admitted since. Rows of two accounts fail closed first.
   */
  private migrate(): void {
    if (this.pc === null || this.error !== null) return;
    // When removal replay was postponed, recovery checks the projected survivors,
    // not the stale members on disk. A migrated binding needs no startup write.
    if (this.futureProblem !== null && !this.pc.migrating) return;
    const rows = this.futureProblem === null ? this.devices : this.devices.filter(row =>
      !this.journalEnded(row.id) && !this.lockHeld.has(row.id) && !this.coveredByEvidence(row));
    const numbered = this.devices.flatMap((d) => d.origin === undefined || d.origin.from === "legacy" ? [] : [d.origin.admit_no]);
    try { this.pc.settlePending(rows); }
    catch (error) { this.pc.unwritten(error); return; }
    // a row the journal already ended is no member, also on a start that could not replay its removal yet (P24)
    const members = [...new Set(rows.flatMap((d) => d.account === undefined || this.journalEnded(d.id) ? [] : [d.account]))];
    if (!this.pc.migrating) {
      this.pc.checkAbove(numbered);
      this.pc.checkMembers(members);
      return;
    }
    // a PC that ever had a device, its rows revoked since, is no first-device PC (T67): its gate stayed closed
    const hadDevices = this.devices.length > 0 || this.gateClosedAt !== null;
    // S2-03's counter file: the rows are numbered already, and only the binding is migrated (T50)
    if (this.pc.upgrading) {
      this.pc.checkAbove(numbered);
      const account = this.pc.migrationAccount(rows);
      if (this.pc.strict !== null) return;
      try { this.pc.migrate(account, hadDevices); } catch (error) { this.pc.unwritten(error); }
      return;
    }
    // a row numbered here means this folder had an account file: its loss is damage, and nothing is stamped (P21)
    if (numbered.length > 0) { this.pc.missingBeside(); return; }
    const account = this.pc.migrationAccount(rows);
    if (this.pc.strict !== null) return;
    if (!this.stampLegacyRows()) return;
    try { this.pc.migrate(account, hadDevices); } catch (error) { this.pc.unwritten(error); }
  }

  private stampLegacyRows(): boolean {
    const next = this.devices.map(row => this.legacyFromRegistry(row) ? { ...row, origin: legacyOrigin(row.created_at) } : row);
    if (next.every((row, i) => row === this.devices[i])) return true;
    try { this.save(next); } catch (error) { this.pc?.unwritten(error); return false; }
    this.devices = next;
    return true;
  }

  /**
   * The one final admission guard (G3, rule R1), asked in the commit turn of every admission and widening: false while
   * the PC fails closed or is locked, and while a block or a freeze stands that `key` is newer than. Newer is decided
   * on this PC by admission order: a key with no row here, or a row with no place in the order, counts as newer.
   * Holds and account removals always deny the key; only a pairing on this PC can end a local Revoke (P13).
   */
  admits(key: string | undefined, confirm?: ConfirmProof, options?: { pairingHere?: boolean; retainId?: string }): boolean {
    if (options?.retainId !== undefined) {
      const row = this.devices.find(device => device.id === options.retainId);
      return row !== undefined && row.relay_public_key === key && this.admissionAllowed(key, confirm, { retainedRow: row });
    }
    return this.admissionAllowed(key, confirm, options);
  }

  private admissionAllowed(key: string | undefined, proof: ConfirmProof | "list" | "legacy_credential" | undefined, options?: { pairingHere?: boolean; retainedRow?: StoredDevice }): boolean {
    if (this.failsClosed || (this.opensAll() && proof !== "legacy_credential" && this.accountError !== null)) return false;
    const state = this.safety?.state();
    if (state === undefined) return true;
    if (key !== undefined) {
      if (proof !== "legacy_credential" && this.devices.some(row => row.relay_public_key === key && row.untrusted_created_at === row.created_at)) return false;
      if (this.accountHeld?.(key) || this.removedByAccount(key)) return false;
      if (!options?.pairingHere && (this.isTombstoned(key) || (this.evidence?.standingRevokes(key).length ?? 0) > 0)) return false;
    }
    // only a proof admitConfirmed minted from a live reservation counts: a hand-built one passes nothing
    const confirm = typeof proof === "string" ? undefined : proof;
    const confirmed = confirm !== undefined && MINTED_PROOFS.has(confirm) && key !== undefined && confirm.key === key;
    // a locked PC admits only the key approved on its own screen (P11); a recover admit is ended by the lock (P22)
    if (state.locked && !(confirmed && confirm.source === "screen")) return false;
    if (state.freezes.length === 0) return true;
    // a key confirm on this PC's own screen, or ovis recover --admit, of this very key passes a freeze (P23, rule R1)
    if (confirmed) return true;
    return this.passesFreezes(state.freezes, key, proof, options?.retainedRow);
  }

  /**
   * Whether a block or a freeze in force on this PC keeps `key` out, whatever else would admit it: a key with no row here
   * counts as newer than its target. What a join refused for it is told, apart from a hold or a removal.
   */
  keptOutByBlock(key: string): boolean {
    const freezes = this.safety?.state().freezes ?? [];
    return freezes.length > 0 && !this.passesFreezes(freezes, key, undefined, undefined);
  }

  private passesFreezes(freezes: SafetyState["freezes"], key: string | undefined, proof: ConfirmProof | "list" | "legacy_credential" | undefined, retainedRow: StoredDevice | undefined): boolean {
    const rows = proof === "legacy_credential" && retainedRow ? [retainedRow] : key === undefined ? [] : this.devices.filter((d) => d.relay_public_key === key);
    // Only retaining a current list admission can use its age: a new pairing or readmission cannot inherit it.
    const listed = proof === "list" && key !== undefined ? this.joinedRows?.rowsByKey(key).find(candidate => candidate.state !== "expired") : undefined;
    if (listed) rows.push(this.joinedAsStored(listed));
    return freezes.every(({ record, asof, targetOnlyCompanion }) => {
      if (key === record.target) return false;
      if (record.kind === "freeze") {
        return this.beforeServiceCutoff(key, record, retainedRow, targetOnlyCompanion === true && proof === "legacy_credential");
      }
      return rows.length > 0 && rows.every((row) => !this.newerThanFreeze(row, record.id, asof));
    });
  }

  /** Hears every end of a code (cancel, expiry, an admission, Revoke all, a relay identity reset), by its id (T71). */
  onPairingEnded(listener: (codeId: string) => void): () => void {
    this.pairingEndedListeners.add(listener);
    return () => { this.pairingEndedListeners.delete(listener); };
  }

  /** P14: this PC's denial counter, 0 while the release flag is off; the admission guard compares it (records.ts). */
  gen(): number { return this.pc?.gen() ?? 0; }

  /** Hears every lift appended to this PC's safety log once it is on disk: its target key and cause (seam for S2-27). */
  onLifted(listener: (target: string, cause: LiftCause) => void): () => void {
    return this.safety?.onLifted(listener) ?? (() => {});
  }

  /** A list read is not local pairing: it cannot supersede any standing removal. */
  admitsFromList(key: string, account: string): boolean {
    return this.admissionAllowed(key, "list") && !this.isTombstoned(key) && !this.coveredByEvidence({ relay_public_key: key, account });
  }

  /** Hears every key a deny takes, in the deny turn, rows or not (Revoke, account remove, block, Revoke all). */
  onKeyRemoved(listener: (key: string, cause: KeyRemovedCause) => void): () => void {
    this.keyRemovedListeners.add(listener);
    return () => { this.keyRemovedListeners.delete(listener); };
  }

  /**
   * A code redeemed by a device that named `key`, checked as a pairing checks it (a wrong code spends a guess) and
   * nothing written: the code's one use is reserved for that key until it is confirmed on this PC's screen, released,
   * or the code ends. With the release flag off it takes no code.
   */
  redeemCode(code: string, how: "code" | "qr", key: string, now = Date.now()): { ok: true; codeId: string; closesAt: string; origin: "pc" | "relay"; accountScope: string | null } | { ok: false; reason: "flag_off" | "invalid_key" | "invalid_code" | "in_use" } {
    if (this.safety === null) return { ok: false, reason: "flag_off" };
    if (!isRelayPublicKey(key)) return { ok: false, reason: "invalid_key" };
    this.assertRelayPairing("code", now);
    if (this.pending?.waiting?.confirmedId !== undefined) return { ok: false, reason: "in_use" };
    if (!this.checkPairingCode(code, now)) { this.noteRelayFailure("code", now); return { ok: false, reason: "invalid_code" }; }
    const pending = this.pending!;
    pending.reserved ??= new Map();
    if (!pending.reserved.has(key) && pending.reserved.size >= PENDING_PER_CODE) return { ok: false, reason: "in_use" };
    pending.reserved.set(key, { key, how });
    return { ok: true, codeId: pending.id, closesAt: new Date(pending.expires).toISOString(), origin: pending.remote ? "relay" : "pc", accountScope: this.account() };
  }

  /** The pending redemption of `key` under `codeId` ended (declined, expired, dropped): its use is free again. */
  releaseRedemption(codeId: string, key: string): void {
    if (this.pending?.id === codeId) this.pending.reserved?.delete(key);
  }

  /**
   * The key a redemption reserved, confirmed: on this PC's screen (`screen`, origin pc) or by `ovis recover --admit`
   * (`recover`). Every guard is asked again in this turn, and only the very key and code reserved commit. A key a row
   * already holds gives that row the new origin and makes no second row (T5 in 2d).
   */
  admitConfirmed(confirm: { codeId: string; key: string; label: string; source: "screen" | "recover"; by?: string; unrevokes?: readonly string[] }, now = Date.now()): DeviceMatch | null {
    const pending = this.pending;
    const reserved = pending?.reserved?.get(confirm.key);
    if (this.safety === null || this.pc === null || pending === null || pending.id !== confirm.codeId || reserved === undefined || this.codeOver(pending, now)) return null;
    if (confirm.source === "recover" && (this.isTombstoned(confirm.key) || this.safety.inForce.blocks.some(entry => entry.record.target === confirm.key)
      || this.safety.inForce.freezes.some(entry => entry.record.target === confirm.key))) return null;
    const recovery = confirm.source === "recover" ? Object.freeze([...new Set([
      ...this.safety.inForce.blocks, ...this.safety.inForce.freezes,
    ].map(({ record }) => record.id))]) : undefined;
    const proof: ConfirmProof = { codeId: confirm.codeId, key: confirm.key, source: confirm.source,
      ...(recovery ? { recoveredOver: recovery } : {}) };
    MINTED_PROOFS.add(Object.freeze(proof));
    const pairingHere = confirm.source === "screen";
    if (!this.admits(confirm.key, proof, { pairingHere })) return null;
    // a Revoke that stands keeps the key out unless this confirm names it (P13)
    const revokes = this.evidence?.standingRevokes(confirm.key) ?? [];
    if (revokes.some((revoke) => confirm.source === "recover" || !(confirm.unrevokes ?? []).includes(revoke.id))) return null;
    // a first-link code: the confirmed key waits to link, as a plain pairing of it would, and only its link admits it;
    // the code's other reservations end here, so it admits one key (T72, T7 in 2d)
    if (pending.waiting !== undefined) {
      const row = this.waitToLink(pending.waiting, confirm.label, confirm.key, now, { proof, how: reserved.how, ...(confirm.by === undefined ? {} : { by: confirm.by }) });
      pending.waiting.confirmedId = row.id;
      delete pending.reserved;
      return row;
    }
    const origin = this.pc.admit(confirm.source === "screen" ? "pc" : "recover", reserved.how, null, now);
    const over = recovery ? { recovered_over: recovery } : {};
    const existing = this.devices.find((d) => d.relay_public_key === confirm.key);
    if (existing !== undefined) {
      const updated = { ...existing, origin, ...over };
      if (proof.source === "screen") {
        delete updated.imported;
        delete updated.invalid_origin;
      }
      const next = this.devices.map((d) => d === existing ? updated : d);
      this.save(next);
      this.devices = next;
      if (proof.source === "recover" && this.admits(confirm.key, undefined, { retainId: updated.id })) this.catchUp?.recoveredHere(updated.id);
      this.voidPending();
      return { id: existing.id, label: existing.label, role: existing.role };
    }
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label: normalizeLabel(confirm.label, "Device"), role: "drive", token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: confirm.key, created_at: new Date(now).toISOString(), last_seen_at: null, origin, ...over };
    if (!this.enroll(device, now, [], true, { confirm: proof, pairingHere, ...(confirm.by === undefined ? {} : { by: confirm.by }) })) return null;
    if (revokes.length > 0) this.clearTombstone(confirm.key);
    return { id: device.id, label: device.label, role: device.role };
  }

  /** P16: a screen-confirmed row is never newer; an unplaced row counts as newer. */
  private newerThanFreeze(device: StoredDevice, id: string, asof: BlockAsOf | undefined): boolean {
    if (asof?.target_only === true) return false;
    if (this.approvedOver(device, id)) return false;
    if (asof?.joined == null) return true;
    if (device.relay_public_key === undefined && (device.imported || device.untrusted_created_at !== undefined
      || (device.origin?.from === "legacy" && device.origin.at !== device.created_at))) return true;
    const cutoff = { admit_no: asof.joined, ...(asof.legacy_created_at === undefined ? {} : { legacy_created_at: asof.legacy_created_at }) };
    return compareAdmissionPositions(admissionPosition(device), cutoff) !== "older";
  }

  private approvedOver(row: StoredDevice, id: string): boolean {
    return !row.imported && !row.invalid_origin && (row.origin?.from === "pc"
      || (row.origin?.from === "recover" && row.recovered_over?.some(known => known.replace(/^f:/, "") === id.replace(/^f:/, "")) === true));
  }

  /** An owner's approval belongs to the exact row retained here, not to a new grant for the same key. */
  private beforeServiceCutoff(key: string | undefined, line: Extract<SafetyRecord, { kind: "freeze" }>, row?: StoredDevice, allowLegacy = false): boolean {
    if (key === line.target) return false;
    if (key !== undefined && row?.relay_public_key === key && this.approvedOver(row, line.id)) return true;
    const no = key === undefined ? null : this.accountOrder?.no(key) ?? this.joinedRows?.rowsByKey(key)[0]?.no;
    if (no == null) return allowLegacy && row !== undefined && this.isLegacyCredential(row);
    return key !== undefined && this.accountOrder?.late(key) === false && no <= line.after;
  }

  private frozen(device: StoredDevice): boolean {
    const state = this.safety?.inForce;
    if (!state) return false;
    if (state.blocks.some(entry => device.relay_public_key !== entry.record.target && this.newerThanFreeze(device, entry.record.id, entry.asof))) return true;
    const key = device.relay_public_key;
    return state.freezes.some(({ record, targetOnlyCompanion }) => targetOnlyCompanion && record.kind === "freeze"
      && !this.beforeServiceCutoff(key, record, device, true));
  }

  /**
   * "Not me" (T51): a block record, its signature verified before anything else, then committed in one turn. Valid on
   * this PC only when the signer is a drive member here, not frozen, and every row of the target joined this PC after
   * the signer's row, by this PC's own admission order: the record's numbers are claims and decide nothing (P21). A
   * target this PC has no row of waits for the order table (S2-10) and applies nothing.
   */
  async applyBlock(value: unknown, got: SafetyGot, onRaise?: () => void): Promise<BlockReceipt> {
    const refused = (id: string, reason: Extract<BlockReceipt, { outcome: "refused" }>["reason"]): BlockReceipt => ({ outcome: "refused", id, reason });
    let record: SafetyRecord;
    try { record = parseSafetyRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) return refused(typeof (value as { id?: unknown })?.id === "string" ? (value as { id: string }).id : "", "record_invalid");
      throw error;
    }
    if (record.kind !== "block" || this.safety === null || this.failsClosed) return refused(record.id, "record_invalid");
    if (!await verifySafetyRecord(record)) return refused(record.id, "record_invalid");
    return this.commitBlock(record, got, onRaise);
  }

  /** Every block in force gives its target a marker and takes its rows, as its commit turn would have (P24). */
  private markBlockTargets(): void {
    for (const entry of this.safety?.state().blocks ?? []) {
      const record = entry.record as BlockRecord;
      if (!this.evidence!.addRemoval(record.target, record.account, { id: record.id, at: record.signed_at, records: [record] })) continue;
      this.refreshTombstones();
      const targets = this.devices.filter((d) => d.relay_public_key === record.target);
      if (targets.length > 0) this.save(this.devices.filter((d) => !targets.includes(d)));
      this.devices = this.devices.filter((d) => !targets.includes(d));
    }
  }

  /** The commit turn of a verified block, in P8's order, with no wait inside. */
  private commitBlock(record: BlockRecord, got: SafetyGot, onRaise?: () => void, reconciled = false): BlockReceipt {
    const refused = (reason: Extract<BlockReceipt, { outcome: "refused" }>["reason"]): BlockReceipt => ({ outcome: "refused", id: record.id, reason });
    const { safety, evidence } = this;
    if (safety === null || this.failsClosed) return refused("record_invalid");
    const known = safety.receipt(record.id);
    if (known !== null && known.outcome !== "refused") return known;
    if (evidence === null || record.account !== this.account()) return refused("record_invalid");
    // the target's rows in both stores: the account rows (S2-25) are targets as devices.json rows are
    const allTargets = this.rowsOfKey(record.target);
    const targets = this.devices.filter((d) => d.relay_public_key === record.target);
    const joinedTargets = allTargets.filter((d) => !targets.includes(d));
    const serverId = this.accountOrderServerId?.() ?? null;
    const bindId = this.pc?.binding()?.bind_id;
    // The first delivery stays in the receipt. A committed whole read supplies its own proof for queued records.
    const useAccountOrder = reconciled || got === "mailbox" || got === "snapshot";
    const order = useAccountOrder && serverId !== null && this.accountOrder !== null
      && this.accountOrder.lastVersion(bindId, serverId) !== null ? this.accountOrder : null;
    // Local rollback provenance identifies the target only; it never gives that row order or signing authority.
    const legacyTarget = targets.length > 0 && targets.every(row => row.origin?.from === "legacy" || this.legacyFromRegistry(row)
      || (row.imported && this.siblingLegacyCredential?.(row) === true))
      && targets.some(row => row.imported || row.untrusted_created_at === row.created_at);
    const placed = (key: string) => bindId !== undefined && order?.listedOn(key, bindId) === true ? order.no(key) : null;
    const pinnedSigner = placed(record.signer);
    const pinnedTarget = placed(record.target);
    const denyByAccountOrder = order != null && legacyTarget && pinnedSigner != null && pinnedTarget != null;
    // A signer speaks from the live standing of the store that owns its row: holds, expiry and opt-out included.
    const standing = (row: StoredDevice): boolean => {
      if (this.devices.includes(row)) return this.memberAdmitted(row, Date.now());
      const listed = this.joinedRows?.row(row.id);
      const access = listed ? this.listedAccess(listed) : null;
      return access !== null && "ok" in access;
    };
    const signers = legacyTarget && useAccountOrder
      ? this.memberRows(record.signer, record.account).filter(row => !row.imported && !row.invalid_origin && row.held === undefined
        && admissionPosition(row) !== null && standing(row) && this.admissionAllowed(record.signer, "legacy_credential", { retainedRow: row }))
      : this.signingRows(record.signer, record.account);
    if (signers.length === 0) return refused("signer_not_member");
    if (signers.some((d) => this.frozen(d))) return refused("frozen");
    if (denyByAccountOrder && (!order.registered(record.signer, record.account)
      || order.late(record.signer) || pinnedSigner !== record.signer_no || pinnedTarget !== record.target_no
      || pinnedSigner >= pinnedTarget)) return refused("signer_not_older");
    if (legacyTarget && !denyByAccountOrder) {
      if (!safety.wait({ record, got, signer_removed: false })) return refused("record_invalid");
      return refused("unknown_target");
    }
    // a target this PC has no row of: the block waits, ends nobody, and is judged when its target is here (P19)
    if (allTargets.length === 0) {
      if (!safety.wait({ record, got, signer_removed: false })) return refused("record_invalid");
      return refused("unknown_target");
    }
    let cutoff: AdmissionPosition | null = null;
    for (const target of allTargets) {
      if (denyByAccountOrder) break;
      const position = admissionPosition(target);
      if (position === null || !signers.every((signer) => compareAdmission(signer, target) === "older")) return refused("signer_not_older");
      if (cutoff === null || compareAdmissionPositions(position, cutoff) === "older") cutoff = position;
    }
    const signerNo = Math.min(...signers.map((d) => d.origin!.admit_no));
    if (cutoff === null && !denyByAccountOrder) return refused("unknown_target");
    const asof: BlockAsOf = denyByAccountOrder
      ? { signer_no: pinnedSigner, target_no: pinnedTarget, after: null, joined: null, signer_removed: false, target_only: true }
      : { signer_no: signerNo, target_no: cutoff!.admit_no, after: cutoff!.admit_no, joined: cutoff!.admit_no, signer_removed: false,
        ...(cutoff!.legacy_created_at === undefined ? {} : { legacy_created_at: cutoff!.legacy_created_at }) };
    const affected = this.devices.filter((d) => d.relay_public_key !== record.target && this.newerThanFreeze(d, record.id, asof));
    let receipt = refused("record_invalid");
    // P8: advance gen before a durable log receipt can be replayed.
    const denied = this.deny([record.target], () => {
      const appended = safety.append({ record, got, asof });
      if (appended.outcome !== "applied") throw new Error(`Block log append did not apply: ${appended.outcome}`);
      receipt = appended;
      evidence.addRemoval(record.target, record.account, { id: record.id, at: new Date().toISOString(), records: [record], drop: rowDrop(this.joinedRows?.rowsByKey(record.target)[0], "block"), tailnetNodes: tailnetNodesOf(targets) });
      this.refreshTombstones();
    }, { genFirst: true });
    if (denied !== null) {
      this.keepOut([...targets, ...affected], false);
      for (const target of joinedTargets) this.closeAccountSessions(target.id);
      return refused("record_invalid");
    }
    if (this.pc !== null) onRaise?.();
    this.keepOut(affected, false);
    // the account rows it freezes end their sessions in this turn too; its account-row targets end and leave their store
    const joinedIds = new Set(joinedTargets.map((d) => d.id));
    const frozenListed = (this.joinedRows?.rows() ?? []).filter(row => !joinedIds.has(row.id) && this.newerThanFreeze(this.joinedAsStored(row), record.id, asof));
    this.catchUp?.noteFreeze(record.target, [...affected, ...frozenListed].map(row => row.id));
    for (const row of frozenListed) this.closeAccountSessions(row.id);
    if (joinedIds.size > 0) {
      try { this.joinedRows?.removeRows([...joinedIds], "block", id => this.closeAccountSessions(id)); }
      catch (error) { console.error(`[devices] the account rows of a blocked key could not be written after its deny; they stay denied by its marker: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.dropWaiting([record.target], "block");
    safety.unwait(record.id);
    this.keepOutNodesOfRecordDrop(targets);
    try { this.drop(targets, "pc"); }
    catch (error) { console.error(`[devices] the registry write of a block failed after its deny; the next start finishes it: ${error instanceof Error ? error.message : String(error)}`); }
    return receipt;
  }

  /** The drive member rows of `key` in `account` that stand here: what a signer of the account is on this PC. */
  private memberRows(key: string, account: string): StoredDevice[] {
    return this.rowsOfKey(key).filter((d) => d.role === "drive" && d.account === account && d.origin !== undefined && !this.coveredByEvidence(d));
  }

  /** A held row is still a member (its existing blocks stand), but it cannot sign a new block or lift. */
  private signingRows(key: string, account: string): StoredDevice[] {
    return this.memberRows(key, account).filter(row => this.canSpeak(row.id));
  }

  /** A join hold permits only the row's own leave; a catch-up wait permits no signature. */
  private canSpeak(id: string, ownLeave = false): boolean {
    if (this.accountError !== null) return false;
    const member = this.devices.find(row => row.id === id);
    if (member) return (this.pc === null || member.untrusted_created_at !== member.created_at)
      && !this.catchingUp(id, false) && this.memberAdmitted(member, Date.now(), ownLeave);
    const row = this.joinedRows?.row(id);
    const access = row ? this.listedAccess(row) : null;
    return access !== null && ("ok" in access || (ownLeave && access.refused === "join_hold"));
  }

  private memberAdmitted(row: StoredDevice, now: number, ownLeave = false): boolean {
    // Rollback keeps held rows for the owner, but cannot interpret or end their holds.
    if (this.safety === null) return !Object.hasOwn(row, "held");
    return ownLeave || this.promotedHolds.refusal(row, now) === null;
  }

  /**
   * The waiting blocks judged again (P19, T51): one whose signer is no member here any more is dropped and writes
   * nothing; one whose target is here now applies, or is refused for good; the rest wait.
   */
  /**
   * Seam for D's S2-25: an account-list commit writes its rows through `write` (which returns their ids); the waiting
   * blocks are then judged as an enrollment judges them, in the same turn, and the ids of the rows that still stand
   * come back. A write that throws, or a PC that fails closed after it, lets no row stand (T51, P19).
   */
  admitListedRows(write: () => readonly string[]): string[] {
    const ids = write();
    this.applyWaitingBlocks();
    if (this.failsClosed) return [];
    return ids.filter((id) => this.has(id));
  }

  applyWaitingBlocks(reconciled = false): void {
    if (this.safety === null) return;
    for (const { record, got, signer_removed: signerRemoved } of [...this.safety.waitingBlocks()]) {
      if (this.failsClosed) return;
      if (this.safety.receipt(record.id) !== null) { this.safety.unwait(record.id); continue; }
      if (signerRemoved || this.memberRows(record.signer, record.account).length === 0) { this.safety.unwait(record.id); continue; }
      if (this.rowsOfKey(record.target).length === 0) continue;
      const receipt = this.commitBlock(record, got, undefined, reconciled);
      if (!this.failsClosed && receipt.outcome === "refused" && receipt.reason !== "unknown_target") this.safety.unwait(record.id);
    }
  }

  /**
   * P23 way 3: only a live individual Revoke or account removal of a signer's row lifts its blocks.
   */
  private liftOrphanedBlocks(key: string | undefined, account?: string): void {
    if (key === undefined || this.safety === null || this.safety.strict !== null) return;
    for (const entry of this.safety.state().blocks) {
      const { record } = entry;
      if (record.signer !== key || (account !== undefined && record.account !== account)) continue;
      if (this.memberRows(key, record.account).length > 0) continue;
      this.safety.append({ record: { v: 1, id: randomBytes(16).toString("hex"), kind: "lift", account: record.account, target: record.id, signer: "pc", signed_at: new Date().toISOString(), forget: false, signature: "" }, got: "pc", cause: "orphan" });
    }
  }

  /**
   * Whether a device's lift may end a block here (P23 way 1, T52): its signature is its signer's, the block is in this
   * log, and the signer is a member here whose every row joined this PC before the blocked key did.
   */
  async liftAuthority(value: unknown, order: LiftOrder | null = this.accountOrder): Promise<boolean> {
    let record: SafetyRecord;
    try { record = parseSafetyRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) return false;
      throw error;
    }
    if (record.kind !== "lift" || !isDeviceSafetyRecord(record) || this.safety === null) return false;
    return await verifySafetyRecord(record) && this.liftStanding(record, order);
  }

  /** Recheck a signature-verified lift synchronously when the deciding read changes standing. */
  liftStanding(record: DeviceLiftRecord, order: LiftOrder | null): boolean {
    if (this.safety === null) return false;
    const blocked = this.safety.state().blocks.find((entry) => entry.record.id === record.target);
    if (blocked === undefined) {
      const line = this.safety.state().freezes.find((entry) => entry.record.id === `f:${record.target}`)?.record;
      const bound = this.pc?.binding()?.bind_id;
      if (line?.kind !== "freeze" || line.account !== record.account || !order || order.late(record.signer) || bound === undefined
        || !order.listedOn(record.signer, bound) || !order.listedOn(line.target, bound)) return false;
      const signerNo = order.no(record.signer);
      const targetNo = order.no(line.target);
      return signerNo !== null && targetNo !== null && signerNo < Math.min(targetNo, line.after)
        && this.signingRows(record.signer, record.account).some((row) => !this.frozen(row));
    }
    const joined = blocked.asof?.joined;
    if (joined === null || joined === undefined) return false;
    // a key the account's order marks late is not trusted as older than the key it would free (P21, T52)
    if (order?.late(record.signer) ?? false) return false;
    const signers = this.signingRows(record.signer, record.account);
    return signers.length > 0 && signers.every((d) => d.origin!.admit_no < joined && !this.frozen(d));
  }

  canRevokeAsPc(access: Access): boolean {
    if (access.level !== "full" || !ownerAccess(access)) return false;
    return access.via === "local" ||
      ((access.via === "tailscale" || access.via === "token") && !this.safety?.inForce.locked && this.accountError === null);
  }

  /** R1/T19: Revoke is key-wide, so a remote caller may revoke its own row alone or a set of entirely newer rows. */
  remoteRevoke(callerId: string | null, targetId: string): "allowed" | "older" | "unorderable" {
    if (this.accountError !== null) return "unorderable";
    const caller = callerId === null ? undefined : this.anyRow(callerId);
    const target = this.anyRow(targetId);
    if (caller === undefined || target === undefined || caller.untrusted_created_at === caller.created_at) return "unorderable";
    const rows = target.relay_public_key === undefined ? [target] : this.rowsOfKey(target.relay_public_key);
    if (rows.some((row) => row.id === caller.id)) return rows.length === 1 ? "allowed" : "unorderable";
    // rule B: every row of the target joined after every row of the caller's key, in both stores
    const callers = caller.relay_public_key === undefined ? [caller] : this.rowsOfKey(caller.relay_public_key);
    const verdicts = rows.flatMap((row) => callers.map((from) => compareAdmission(from, row)));
    if (verdicts.every((verdict) => verdict === "older")) return "allowed";
    return verdicts.includes("newer") ? "older" : "unorderable";
  }

  /**
   * Admission-order authority (P21/T36): a self-leave needs no age; another key needs at least one target row,
   * and every target row must be newer than every member row of the signer.
   */
  removeAuthority(signer: string, key: string, account: string): boolean {
    if (signer === key) return true;
    // an account-joined key signs only its own remove (P5, ruling 1): only devices.json member rows count here
    if (!this.memberRows(signer, account).some((row) => this.devices.includes(row))) return false;
    // rule B: every target row joined after every row of the signer's key, account-joined rows included
    const signers = this.rowsOfKey(signer);
    const targets = this.rowsOfKey(key);
    return signers.length > 0 && targets.length > 0 && targets.every((target) => signers.every((row) => compareAdmission(row, target) === "older"));
  }

  /** The origin of the row `id` in devices.json (P22), or null for a row this PC holds no origin of. */
  originOf(id: string): RowOrigin | null {
    return this.devices.find((d) => d.id === id)?.origin ?? null;
  }

  /**
   * The lock turned on (T46): every row not confirmed on this PC's screen (origin from `pc`) ends in this turn, its
   * sessions closed first, each journalled as a drop for the lock. Returns the ids that went.
   */
  endUnlockedRows(): string[] {
    if (this.evidence === null) return [];
    this.recheckListedSessions();
    const gone = this.devices.filter((d) => d.origin?.from !== "pc");
    this.drop(gone, "pc", "locked");
    return gone.map((d) => d.id);
  }

  /** Step 2 (S2-24): the account's order as this PC's whole reads saw it; set only while Step 2 is on. */
  attachAccountOrder(order: AccountOrder | null, serverId?: () => string | null): void {
    order?.recordJoins(this.devices);
    this.accountOrder = order;
    this.accountOrderServerId = serverId;
  }

  /** Whether the account-opens-all release flag is on for this store. */
  opensAll(): boolean { return this.safety !== null; }

  /** Unbound PCs pair as in Step 1. Unreadable account state is never proof of being unbound. */
  accountPolicyActive(): boolean { return this.opensAll() && (this.account() !== null || this.accountError !== null); }

  /** A standing denial still needs this PC's approval path after it leaves its account. */
  screenApprovalActive(): boolean {
    const state = this.safety?.inForce;
    return this.accountPolicyActive() || (state !== undefined && (state.locked || state.blocks.length > 0 || state.freezes.length > 0));
  }

  /**
   * One press (docs/account.md): binds this PC, in no account, to `account` on the account service's word for it. Only
   * with the release flag on; a PC already in an account is refused here as at the route.
   */
  bindByService(account: string, listingId?: string): void {
    this.assertWritable();
    if (this.pc === null) throw new Error("One press needs OVIS_ACCOUNT_OPENS_ALL");
    if (this.account() !== null) throw new Error("This PC is already in an account");
    this.pc.bindByService(account, listingId);
  }

  /**
   * Binds this PC, in no account, to `account` by the account's signed list (PcAccountState.bindByList): its own entry
   * on a list a person at this PC confirmed. Only with the release flag on. An account whose list removed this relay
   * identity takes it back on no path. Answers the binding the file holds after the write (PcAccountState.bindByList).
   */
  bindByList(account: string, list: string, serverId: string): ListBound {
    this.assertWritable();
    if (this.pc === null) throw new Error("A signed list needs OVIS_ACCOUNT_OPENS_ALL");
    if (this.account() !== null) throw new Error("This PC is already in an account");
    if (this.listRemovedFrom(account)) throw new Error("This PC was removed from that account");
    return this.pc.bindByList(account, list, serverId);
  }

  /** The id of this PC's binding when it stands on the account service's word alone (bindByService), else null. */
  serviceBinding(): string | null { const binding = this.pc?.binding(); return binding?.service === true ? binding.bind_id : null; }

  serviceListing(): string | undefined { return this.pc?.binding()?.listing_id; }
  pinServiceListing(binding: string, listing: string): void { this.pc?.pinListing(binding, listing); }
  /** PcAccountState.awaitsFirstListing. */
  awaitsFirstListing(): boolean { return this.pc?.awaitsFirstListing() === true; }
  /** The id of this PC's binding when a device's link (or the rows it was upgraded from) made it, else null. */
  linkBinding(): string | null { const binding = this.pc?.binding(); return binding && binding.service !== true && binding.pending !== true ? binding.bind_id : null; }

  /**
   * PcAccountState.addAtPcSince: a link joins this PC to an account only under a code it issued itself (issuedAtPc), or
   * from a device whose digits this PC's own screen approved since it left (approvedHereSince).
   */
  addAtPcRequired(): boolean { return this.pc?.addAtPcSince() != null; }

  /** Whether the row `id` was let in by digits approved on this PC's own screen, by no member, after its account stopped listing it. */
  approvedAtPcSinceClear(id: string): boolean {
    const since = this.pc?.addAtPcSince();
    const origin = this.devices.find(row => row.id === id)?.origin;
    return since != null && origin !== undefined && origin.admit_no >= since && origin.by === null && (origin.from === "pc" || (origin.from === "remote" && origin.how === "digits"));
  }

  /** Whether the code `pinned` (pinnedCode) was started at this PC itself, by its own window or command, and is still the code pending. */
  issuedAtPc(pinned: object): boolean { return this.pending === pinned && this.pending.atPc === true; }

  /** Whether a device of the account this PC left is told to add it again (relay/session.ts): while the add at the PC is owed. */
  readdRequired(): boolean { return this.addAtPcRequired(); }

  /** Whether `proof` is by a key this PC knew as the account's when it left: the one peer told why it left (relay/session.ts). */
  async provedFormerAccountKey(deviceId: string, proof: { nonce: Uint8Array; signature: string; serverId: string }): Promise<boolean> {
    if (proof.nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) return false;
    const key = this.formerAccountKey(proof.serverId, deviceId);
    return key !== undefined && await verifyRelayProof(key, proof);
  }

  /**
   * The key the row `deviceId` held for the account this PC left: a key a whole read numbered, for the row the
   * account's list would have made of it, or the key of a devices.json row that left with the account (its journal
   * entry, the last of that row). Never a key removed here or by the account.
   */
  private formerAccountKey(serverId: string, deviceId: string): string | undefined {
    const listed = this.accountOrder?.relayKey(serverId, deviceId);
    const last = this.journal?.strict === null ? this.journal.entries().filter(entry => entry.row === deviceId).at(-1) : undefined;
    const key = listed !== undefined && this.accountOrder?.no(listed) != null ? listed
      : last?.kind === "remove" && last.how === "unlisted" ? last.key ?? undefined : undefined;
    return key !== undefined && !this.isTombstoned(key) && !this.removedByAccount(key) ? key : undefined;
  }

  /**
   * T56 for devices.json: the last whole read is an hour old, so until the next one every row that stands on the
   * account alone (accountOnly) waits, its sessions closed, as the account's listed rows do, and so does one made
   * meanwhile. One of them that paired its key here keeps its access; what it may do for the account waits.
   */
  staleAccountMembers(): void {
    this.catchUp?.staleRead();
    for (const row of [...this.devices]) if (this.catchingUp(row.id)) this.closeAccountSessions(row.id);
  }

  /** On a PC pinned to its signed list, whether that list lets this row's key in now: such a row waits for no read of the account service. */
  private listAdmits(device: StoredDevice): boolean {
    return device.relay_public_key !== undefined && this.signedList?.role(device.relay_public_key) != null;
  }

  private waitsOnStaleRead(device: StoredDevice, credential: boolean): boolean {
    if (this.catchUp?.readStale() !== true || (device.account === undefined && device.member_approved_in === undefined)) return false;
    if (this.listAdmits(device)) return false;
    // admitted here by `ovis recover`, with a key its link kept: the credential is this PC's own, as a first-link key is
    const recovered = device.origin?.from === "recover" && pairedHere(device) && device.account_add === undefined && !device.imported && !device.invalid_origin;
    if (!keepsPairingOnUnlist(device) && !recovered) return true;
    // the credential is this PC's own and stays; the membership its link gave it is the account's and waits
    return (keptFirstLinkKey(device) || recovered) && !credential;
  }

  /** The account's listed rows whose keys a whole snapshot names as removed go, their sessions closed: what a read that widens nothing still does. */
  dropListedRemoved(keys: readonly string[]): void {
    const ids = keys.flatMap(key => this.joinedRows?.rowsByKey(key) ?? []).map(row => row.id);
    if (ids.length) this.joinedRows?.removeRows(ids, "remove", id => this.closeAccountSessions(id));
  }

  /** Whether the row `id` only waits for a whole read: its sign-in is put off, never refused as a removed device's. */
  waitsForRead(id: string): boolean {
    if (this.devices.some(row => row.id === id)) return this.catchingUp(id);
    const row = this.joinedRows?.row(id) ?? null;
    const access = row && this.listedAccess(row);
    return access !== null && !("ok" in access) && access.refused === "catching_up";
  }

  accountOnly(id: string): boolean {
    const member = this.devices.find(row => row.id === id);
    return member ? (member.account !== undefined || member.member_approved_in !== undefined) && !keepsPairingOnUnlist(member) : this.isAccountRow(id);
  }

  deviceNumber(id: string): number | null {
    return this.joinedRows?.row(id)?.no ?? this.originOf(id)?.admit_no ?? null;
  }

  private unbindingSessions: number | null = null;
  noteRelayRevoked(): void {
    if (this.unbindingSessions !== null) this.unbindingSessions++;
  }

  /** The PC leaves its account, for one of the named reasons (P12); nothing else clears the binding. */
  /** `removedAs`: with `by` LIST_REMOVED, the relay identity the list removed (PcAccountState.clear). */
  clearAccountBinding(reason: ClearReason, by: string, removedAs?: string): boolean {
    // a PC pinned to its account's signed list leaves on that list's word (LIST_REMOVED) or by an act at the PC, never
    // because the account service stopped listing it: that only costs it the service
    if (reason === "unlisted" && by !== LIST_REMOVED && this.listFollowed()) return false;
    const pc = this.pc ?? (existsSync(join(this.stateDirPath, "account-pc.json")) ? PcAccountState.open(this.stateDirPath) : null);
    // also where another Ovis server on this folder pinned the binding after this one read it: asked of the file,
    // before a row is ended for a clear that will not be written
    pc?.refresh();
    if (reason === "unlisted" && by !== LIST_REMOVED && pc?.binding()?.list !== undefined) return false;
    if (reason !== "revoke_all") this.resumeRevokeAll();
    const binding = pc?.binding();
    if (!pc || !binding || pc.strict !== null) return false;
    try {
      // The binding clear is the commit point: after it reaches disk no row can still name the old account.
      this.assertWritable();
      this.unbindingSessions = 0;
      this.endAccountRows(reason);
      this.settleMemberRows(binding.account, reason);
      return pc.clear(reason, by, by === LIST_REMOVED ? removedAs : undefined);
    } catch (error) {
      pc.unwritten(error, "This PC could not finish clearing its account");
      throw error;
    } finally {
      if (this.unbindingSessions !== null) logAccess({ event: "account.sessions.closed", count: this.unbindingSessions });
      this.unbindingSessions = null;
    }
  }

  private settleMemberRows(account: string, reason: ClearReason): void {
    const members = this.devices.filter(row => row.account === account || row.member_approved_in === account);
    if (!members.length) return;
    // A removal that covered the member must not stop covering it just because its account field is gone.
    const gone = members.filter(row => !keepsPairingOnUnlist(row) || this.coveredByEvidence(row));
    if (gone.length) this.drop(gone, "pc", reason);
    if (gone.length === members.length) return;
    const next = this.devices.map(row => {
      if (row.account !== account && row.member_approved_in !== account) return row;
      const { account: _account, linked_at: _linked, member_approved_in: _approval,
        account_add: _add, joined_by: _joined, ...paired } = row;
      return paired;
    });
    this.save(next);
    this.devices = next;
  }

  /** Every account-joined row ends: its sessions close first, then it leaves account-devices.json (T44, P8 order). */
  private endAccountRows(reason: ClearReason): void {
    const ids = (this.joinedRows?.rows() ?? []).map((row) => row.id);
    // an account that stopped listing this PC removed it, as a removal of each of its rows would
    if (ids.length) this.joinedRows?.removeRows(ids, reason === "unlisted" ? "remove" : reason, id => this.closeAccountSessions(id));
  }

  /**
   * Writes `write` (the row of a link) with the binding of a PC in no account in the same turn, binding first: a row
   * that is not written takes its binding back (T13, T59).
   */
  private bindingWith<T>(account: string, key: string, write: () => T): T {
    if (this.pc === null) return write();
    if (this.pc.account() !== null) {
      const result = write();
      // a key other than the one that bound the PC joined it: the PC has had other devices, for good (T67, H2)
      if (this.pc.first()?.key !== key) this.pc.setOthersEver();
      return result;
    }
    const { commit, takeBack } = this.pc.bind(account, key);
    const onDisk = () => this.devices.some((d) => d.relay_public_key === key && d.account === account);
    let result: T;
    try { result = write(); } catch (error) {
      // a failure after the row reached the disk takes nothing back: the admission is durable (T13)
      if (!onDisk()) {
        try { takeBack(); } catch (left) { console.error(`[devices] the binding of a link that was not written could not be taken back: ${left instanceof Error ? left.message : String(left)}`); }
        throw error;
      }
      this.commitBinding(commit);
      throw error;
    }
    this.commitBinding(commit);
    return result;
  }

  /** The binding of a first link whose row is on disk stands; one that cannot be marked so leaves the PC strict (S19). */
  private commitBinding(commit: () => void): void {
    // the row is on disk but its binding cannot be made to stand: the PC fails closed and the link is no success; the
    // next start finds the binding pending beside its row and makes it stand (settlePending)
    try { commit(); } catch (error) { this.pc?.unwritten(error); throw error; }
  }

  /** The origin a row admitted now carries; none while the release flag is off. Every path is `remote` until a key confirm on this PC's screen exists (P22). */
  private admitted(device: StoredDevice, now: number, path: { startedBy?: string | null; digits?: boolean } = {}): StoredDevice {
    if (this.pc === null || device.origin !== undefined) return device;
    // `by` is the account member who approved it, by its account key, and only a member (P22): the member named on the
    // row, or the one that started the code this pairing redeemed; a link approves nothing
    // a link that moves the key admits a key nobody approved (P22)
    const approverId = device.linked_at !== undefined ? undefined : device.added_by ?? path.startedBy ?? undefined;
    const approver = approverId !== undefined && this.isAccountApprover(approverId) ? this.devices.find((d) => d.id === approverId) : undefined;
    const how = device.linked_at !== undefined ? "link" : device.account_add !== undefined ? "add" : approver !== undefined ? "member" : path.digits === true ? "digits" : "code";
    const by = approver?.relay_public_key ?? null;
    // a key this folder numbers is its own here, whatever copy the row came in as (P21)
    const { imported: _copied, ...own } = device;
    return { ...own, origin: this.pc.admit("remote", how, by, now) };
  }

  /**
   * Whether the gate is closed to strangers: it is from the first pairing on, and stays so when
   * every device is revoked (revoking must never reopen the LAN); this PC itself always gets in.
   */
  get gated(): boolean {
    // what access reads: a PC that fails closed is closed to strangers, paired or not (S19)
    return this.failsClosed || this.rawGated;
  }

  /** The gate as the registry holds it, for what is persisted and announced (closeGate, save); access reads gated. */
  private get rawGated(): boolean {
    return this.error !== null || this.gateClosedAt !== null || this.devices.length > 0;
  }

  /**
   * Hears of the gate closing to strangers (`gated` turning true): the first device's cookie came back, or the
   * relay was turned on. Told once, right after the call that closed it (save). Whoever the open LAN let in has
   * no access from then on, and neither a later device nor a revoke opens the gate again. Never told of a gate
   * that is closed already: endWithGate.
   */
  onGateClosed(listener: () => void): () => void {
    this.gateListeners.add(listener);
    return () => { this.gateListeners.delete(listener); };
  }

  /** The end of what the open LAN alone let in: `close` when the gate closes, at once when it is closed already. */
  endWithGate(close: () => void): () => void {
    if (this.rawGated) { close(); return () => {}; }
    return this.onGateClosed(close);
  }

  /** Relay opt-in closes open LAN access before any outbound connection is made. */
  /** Closes the registry's own gate, whatever the safety log says; closing a closed gate does nothing. */
  closeGate(): void {
    // a registry that could not be read is closed already (rawGated): nothing to write, and nothing to throw
    if (this.rawGated) return;
    this.assertWritable();
    const gate = new Date().toISOString();
    this.save(this.devices, gate);
    this.gateClosedAt = gate;
    this.voidPending();
    this.unconfirmedFirstPairs = [];
  }

  onLinked(id: string, listener: (sessionId: string) => void): () => void {
    const listeners = this.relinks.get(id) ?? new Set<(sessionId: string) => void>();
    listeners.add(listener);
    this.relinks.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.relinks.delete(id);
    };
  }

  /**
   * Ends stale authority on revocation or role changes, never a label-only update. Called immediately for an already-revoked identity.
   * `waiting`: the row that went had paired with a code made for a PC in no account and not linked (dropProvisional).
   */
  onRevoke(id: string, close: (waiting?: true) => void): () => void {
    // a row that waits to link has sessions too: they end when it goes, as a device's do when it is revoked
    if (!this.devices.some((device) => device.id === id) && this.pending?.waiting?.rows.has(id) !== true && (this.joinedRows?.row(id) ?? null) === null) { close(); return () => {}; }
    const listeners = this.revocations.get(id) ?? new Set<(waiting?: true) => void>();
    listeners.add(close);
    this.revocations.set(id, listeners);
    const release = this.releases?.releaseOf(id);
    const unwatch = release ? this.releases?.watch(release, close) : undefined;
    return () => {
      unwatch?.();
      listeners.delete(close);
      if (listeners.size === 0) this.revocations.delete(id);
    };
  }

  /**
   * Hears of every durable enrollment: a gated pairing, or a first-pair cookie confirmed. Never an
   * unconfirmed credential, a last-seen write or a failed one.
   */
  onPaired(listener: (event: DevicePairedEvent, origin: readonly string[]) => void): () => void {
    this.pairings.add(listener);
    return () => { this.pairings.delete(listener); };
  }

  /**
   * After the registry write that made `device` durable, and only then. `enrolledAt` is that write's
   * moment, not the credential's issue: a first-pair cookie confirmed later is enrolled when it returns.
   */
  private announce(device: StoredDevice, enrolledAt: number, origin: readonly string[]): void {
    const approver = device.added_by === undefined ? undefined : this.devices.find((d) => d.id === device.added_by);
    const event: DevicePairedEvent = {
      type: "device-paired", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, enrolled_at: new Date(enrolledAt).toISOString(),
      ...(approver ? { approved_by: { device_id: approver.id, label: approver.label } } : {}),
    };
    // with the flag off, main's own order: a listener that throws fails the pairing
    if (this.safety === null) { for (const listener of this.pairings) listener(event, origin); return; }
    // each on its own: one that throws skips nobody else (G14)
    for (const listener of [...this.pairings]) {
      try { listener(event, origin); } catch (error) { console.warn(`[devices] a pairing listener failed: ${describe(error)}`); }
    }
  }

  private assertWritable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  /** `withAccounts`: add the account fields of member rows, for a caller that may drive (GET /api/devices). */
  list(currentId: string | null, withAccounts = false): PairedDevice[] {
    return this.devices.map((d) => ({
      id: d.id, label: d.label, role: d.role, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.id === currentId,
      ...(d.relay_public_key === undefined ? {} : { via_relay: true as const }),
      ...(withAccounts && d.account !== undefined && d.relay_public_key !== undefined
        ? { account: d.account, account_key: d.relay_public_key, ...(d.added_by === undefined ? {} : { added_by: d.added_by }) } : {}),
    }));
  }

  /**
   * The account-joined rows GET /api/devices shows after `list`, which stays devices.json alone for its other callers.
   * A row is shown while it stands as admitted here (AccountRowSource.standing), in its hold or the wait after a start
   * too. One that can no longer sign in here is left out: expired (by its state or the clock), refused by the admission
   * guard as its hold ended, or stale (accountRowStale: removal evidence, a tombstone, a freeze, the lock, a failed
   * deny, unreadable account state). A key devices.json holds is listed once, as its row there. Reading it changes no
   * row: no hold ends, nothing expires.
   */
  listAccountJoined(currentId: string | null): PairedDevice[] {
    return (this.joinedRows?.rows() ?? []).filter((row) => this.listsJoined(row)).map((row) => this.joinedAsPaired(row, currentId));
  }

  /** Whether GET /api/devices lists the account row `id` (listAccountJoined). */
  listsAccountRow(id: string): boolean {
    const row = this.joinedRows?.row(id) ?? null;
    return row !== null && this.listsJoined(row);
  }

  private listsJoined(row: AccountRow): boolean {
    return this.joinedRows?.standing(row.id) === true && !this.accountRowStale(row)
      && !this.devices.some((d) => d.id === row.id || d.relay_public_key === row.key);
  }

  /** An account-joined row as GET /api/devices and PATCH /api/devices/:id answer it: last seen by the day this PC keeps. */
  private joinedAsPaired(row: AccountRow, currentId: string | null): PairedDevice {
    return { id: row.id, label: row.label, role: this.joinedRole(row), created_at: row.confirmed_at,
      last_seen_at: row.last_signin_day === null ? null : `${row.last_signin_day}T00:00:00.000Z`,
      current: row.id === currentId, via_relay: true, through_account: true };
  }

  /**
   * The rows one whole read let in (AccountRowPorts.admitted). Not announced as a pairing is (onPaired): every older
   * device hears of each by its journal notice, so only this PC's own window is told (server/join-notices.ts).
   */
  announceListAdmissions(rows: readonly AccountRow[]): void {
    for (const listener of [...this.listAdmissions]) {
      try { listener(rows); } catch (error) { console.warn(`[devices] a list admission listener failed: ${describe(error)}`); }
    }
  }

  onListAdmissions(listener: (rows: readonly AccountRow[]) => void): () => void {
    this.listAdmissions.add(listener);
    return () => { this.listAdmissions.delete(listener); };
  }

  /** Hears that an account row may have stopped being listed: after a write of either file, a refusal, a safety change. */
  onListedChange(listener: () => void): () => void {
    this.listedChanges.add(listener);
    return () => { this.listedChanges.delete(listener); };
  }

  private listedChanged(): void {
    for (const listener of [...this.listedChanges]) {
      try { listener(); } catch (error) { console.warn(`[devices] a listed-row listener failed: ${describe(error)}`); }
    }
  }

  /**
   * Hears of every new six-digit code, which replaces the one pending, and of a code ended (endPairing):
   * either way a typed relay code bound to the old one goes (server/relay/pair-code.ts).
   */
  onPairingStarted(listener: () => void): () => void {
    this.codeStarts.add(listener);
    return () => { this.codeStarts.delete(listener); };
  }

  /** Whether the code `codeId` is the one pending and not over, even before its expiry timer has run (S13-1). */
  codeLive(codeId: string, now = Date.now()): boolean {
    const pending = this.pending;
    return pending !== null && pending.id === codeId && !this.codeOver(pending, now);
  }

  activePairing(now = Date.now()): PairingCode | null {
    const pending = this.pending;
    if (pending === null || this.codeOver(pending, now) || pending.attempts >= CODE_ATTEMPTS) return null;
    return { code: pending.code, expires_at: new Date(pending.expires).toISOString() };
  }

  /**
   * A fresh six-digit code, replacing any code still pending. `by`: the paired device whose request started it
   * (null for this PC itself), which holds it from then on. One that is paired no more by now, or may only watch by
   * now, starts nothing (assertHolder), and the code pending stays as it was.
   */
  startPairing(now = Date.now(), from: { remote: boolean; startedBy: string | null; memberRequired: boolean; ownPc?: boolean; open?: boolean; noAccountOnly?: boolean; by?: string | null; account?: string; issuedUnder?: string } = { remote: false, startedBy: null, memberRequired: false, ownPc: true }): PairingCode {
    this.assertWritable();
    const { by = null, account, issuedUnder, ...how } = from;
    if (by !== null) this.assertHolder(by);
    if (how.startedBy !== null && !this.has(how.startedBy)) throw new DeviceGoneError();
    this.pruneUnconfirmedFirstPairs(now);
    this.codeIssues = this.codeIssues.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (this.codeIssues.length >= 10) throw new PairingRateLimitedError(Math.ceil(((this.codeIssues[0] ?? now) + PAIRING_WINDOW_MS - now) / 1000));
    this.codeIssues.push(now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // the code this one replaces takes the rows that waited under it along
    this.voidPending("replaced");
    this.pending = {
      code, id: randomBytes(16).toString("hex"), expires: now + CODE_TTL_MS, deadline: this.clock.now() + CODE_TTL_MS, attempts: 0, ...how,
      // the account its starter approves the pairing for, judged as the code is made: a starter that joins later approved nothing
      ...(how.startedBy !== null && this.approverAccount(how.startedBy) !== null ? { approvedIn: this.approverAccount(how.startedBy)! } : {}),
      holders: new Set([by, how.startedBy].filter((id): id is string => id !== null)),
      ...(how.noAccountOnly === true ? { waiting: { usesLeft: PAIRING_USES, rows: new Map<string, ProvisionalRow>(), turnedAway: [] } } : {}),
      // no paired device asked for it: a person at this PC did (addAtPcRequired)
      ...(how.noAccountOnly === true && by === null ? { atPc: true as const } : {}),
      ...(how.noAccountOnly === true && account !== undefined ? { named: { account } } : {}),
      ...(how.noAccountOnly === true && issuedUnder !== undefined ? { issuedUnder } : {}),
    };
    if (this.safety !== null) {
      // the code ends on the store's own clock when its ten minutes are over, not at the next look (T71)
      const pending = this.pending;
      pending.cancelExpiry = this.clock.setTimeout(() => {
        if (this.pending !== pending) return;
        pending.over = true;
        this.expirePending();
      }, CODE_TTL_MS + 1);
    }
    const started = { code, expires_at: new Date(this.pending.expires).toISOString() };
    for (const listener of this.codeStarts) listener();
    return started;
  }

  /**
   * The code of the QR code that puts this PC in an account: a signed-in device that scans it links itself as the
   * PC's first member, with no approval here (the relay tab's QR code, POST /api/relay/offer with
   * `x-ovis-no-account-only`). So it is made only while the PC is in no account (PcInAccountError otherwise, and the
   * code pending stays as it was), and it ends when the PC joins one (endNoAccountCode). The code pending when that
   * was made the same way, else a fresh one: never a code another place started, which may be on a screen as digits.
   * A device that pairs with it through the relay is no device yet: it waits to link (pairProvisional), and the
   * code takes PAIRING_USES such pairings. No other offer carries it (pairingForOffer), and it is redeemed through
   * the relay only (pair). `by` as in startPairing. `issuedUnder`: the account named for this PC as the code is made
   * (RelayService.offer); a device that waits under the code is taken into that account only (issuedUnder), and a code
   * pending that was made under another is not carried on: a fresh one replaces it.
   */
  pairingForNoAccount(by: string | null = null, now = Date.now(), issuedUnder?: string): PairingCode {
    if (by !== null) this.assertHolder(by);
    if (this.account() !== null) throw new PcInAccountError();
    const active = this.activePairing(now);
    const pending = this.pending;
    // never a code made for one account: the device that pairs with this one is taken into the account named for the PC
    const carried = pending?.noAccountOnly === true && pending.named === undefined && pending.issuedUnder === issuedUnder;
    if (active !== null && carried) {
      if (by !== null) pending.holders.add(by);
      else pending.atPc = true;
      return active;
    }
    // past its ten minutes, the code stays while a device that paired with it in time may still link (expirePending)
    if (carried && this.codeOver(pending, now)) {
      this.expirePending();
      const rows = [...this.pending === pending ? pending.waiting?.rows.values() ?? [] : []];
      if (rows.length > 0) throw new PairingFinishingError(Math.max(1, Math.ceil(Math.max(...rows.map((row) => row.pairedAt + PAIRING_LINK_MS - this.clock.now())) / 1000)));
    }
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by, ...(issuedUnder === undefined ? {} : { issuedUnder }) });
  }

  /**
   * The account named for this PC when the relay tab's code that the row `id` waits under was made (pairingForNoAccount),
   * whatever is named now: its link is taken into that account only. Null for a row that does not wait under such a code.
   */
  issuedUnder(id: string): string | null {
    return this.pending?.waiting?.rows.has(id) === true && this.pending.named === undefined ? this.pending.issuedUnder ?? null : null;
  }

  /**
   * The code of an offer asked for with `x-ovis-expect-account: <account>` (docs/account.md, "A code made for an
   * account"): the code pending when that was made for the same account, else a fresh one (startAccountPairing).
   * `want`: the id of the code pending to carry; `new` asks for a fresh one. An id that names no code this offer can
   * carry starts none (PairingGoneError): a fresh code would replace the one pending, which another run may have made
   * since, with the devices that wait under it. `by` as in startPairing.
   */
  pairingForAccount(account: string, by: string | null = null, now = Date.now(), want?: string): PairingCode & AccountPairing {
    if (by !== null) this.assertHolder(by);
    // a code made for an account ends when the PC joins one (endNoAccountCode): one still pending is for a PC in none
    const active = this.activePairing(now);
    const pending = this.pending;
    if (active !== null && pending?.named?.account === account && (want === undefined || want === pending.id)) {
      if (by !== null) pending.holders.add(by);
      else pending.atPc = true;
      return { ...active, expect_account: account, pairing: { id: pending.id } };
    }
    // a PC in an account says so first (startAccountPairing)
    if (want !== undefined && want !== "new" && this.account() === null) throw new PairingGoneError();
    return this.startAccountPairing(account, by, now);
  }

  /**
   * A fresh code made for `account`, replacing any code pending. It is the code of the QR code that puts this PC in
   * an account (pairingForNoAccount), with one difference: a device that pairs with it and waits to link is taken
   * into `account` alone, whatever account was named for this PC (server/account/records.ts applyLink). So it is made
   * only while the PC is in no account (PcInAccountError otherwise, and the code pending stays as it was). Its id
   * names it for a read of its state (accountPairingState). `by` as in startPairing.
   */
  startAccountPairing(account: string, by: string | null = null, now = Date.now()): PairingCode & AccountPairing {
    if (this.account() !== null) throw new PcInAccountError();
    const started = this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by, account });
    return { ...started, expect_account: account, pairing: { id: this.pending!.id } };
  }

  /**
   * Ends the relay tab's code (pairingForNoAccount) and the rows that wait to link under it, as endPairing does; a code
   * made for an account, or another code, stays. False when that code is not the one pending.
   */
  endNoAccountPairing(): boolean {
    if (this.pending?.noAccountOnly !== true || this.pending.named !== undefined) return false;
    return this.endPairing();
  }

  /**
   * The account that the code a waiting row paired with was made for (startAccountPairing), also once that code's ten
   * minutes are over: the row is held to it until it links or goes. Null for the relay tab's code, and for a row that
   * does not wait to link.
   */
  waitingFor(id: string): string | null {
    return this.pending?.waiting?.rows.has(id) === true ? this.pending.named?.account ?? null : null;
  }

  /**
   * The code made for a PC in no account that is alive now (pairingForNoAccount, startAccountPairing): the code pending
   * and the PC still in no account, within its ten minutes or, past them, while a device that paired with it in time
   * still waits to link (expirePending; it pairs no new device then). Null for none. What it returns names that code
   * and no later one, so a link holds it from its arrival to its write (LinkArrival).
   */
  pinnedCode(now = Date.now()): object | null {
    if (this.pending?.noAccountOnly === true && this.codeOver(this.pending, now)) this.expirePending();
    const pending = this.pending;
    return pending?.noAccountOnly === true && this.account() === null && (!this.codeOver(pending, now) || (pending.waiting?.rows.size ?? 0) > 0) ? pending : null;
  }

  /** The account a code from pinnedCode was made for (startAccountPairing); null for the relay tab's code, or a code no longer pending. */
  pinnedFor(pinned: object): string | null {
    return this.pending === pinned ? this.pending.named?.account ?? null : null;
  }

  /** Whether `code` is the six digits of a code that pinnedCode names now: its offer carries the mark (shared/relay-offer.ts `admission`). */
  isPinnedCode(code: string): boolean {
    return this.pinnedCode() !== null && this.pending !== null && same(code, this.pending.code);
  }

  /** What the last link of the row `id` that waits to link waits for or got (records.ts applyLink); the keep shows it. */
  noteLink(id: string, link: "asked" | "service_unreachable"): void {
    const row = this.pending?.waiting?.rows.get(id);
    if (row) row.link = link;
  }

  /** The clock a row that waits to link is bounded on (useClock): the wait of its link for the account service is too. */
  waitClock(): MuxClock {
    return this.clock;
  }

  /**
   * Whether the code made for an account that `id` names is still the pending one, and how it ended. A code whose ten
   * minutes are over pairs no new device, and stays the pending one only while a device that paired with it in time
   * may still link (expirePending): with none, it has ended at this read, whether or not anything used it since. While
   * it lives, the rows that wait under it, and every row of it that went without becoming a member.
   */
  accountPairingState(id: string, now = Date.now()): AccountPairingState {
    const pending = this.pending;
    if (pending?.named !== undefined && pending.id === id) {
      if (this.codeOver(pending, now)) this.expirePending();
      if (this.pending === pending) {
        const waiting = [...pending.waiting?.rows.values() ?? []].map((row) => ({ id: row.id, label: row.label, link: row.link ?? "not_sent" as const }));
        return { state: "live", id, expect_account: pending.named.account, expires_at: new Date(pending.expires).toISOString(), waiting, turned_away: [...pending.waiting?.turnedAway ?? []] };
      }
    }
    return this.endedAccountCodes.find((ended) => ended.id === id) ?? { state: "unknown" };
  }

  /**
   * The code of every other relay offer (POST /api/relay/offer without `x-ovis-no-account-only`): the code pending,
   * else a fresh one. Never the code made for a PC in no account (pairingForNoAccount): the device that pairs with
   * that one waits to link, and this offer is for a device that is paired at once. With that code pending a fresh
   * one is started, which replaces it as every new code does. `want` as in pairingForAccount, `by` as in startPairing.
   */
  pairingForOffer(by: string | null = null, now = Date.now(), want?: string): PairingCode {
    const active = this.activePairing(now);
    if (active !== null && this.pending?.noAccountOnly !== true && (want === undefined || want === this.pending?.id)) return active;
    if (want !== undefined && want !== "new") throw new PairingGoneError();
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, by });
  }

  /**
   * A row just became an account member. A code made only for a PC in no account goes: left pending, whoever scans it
   * next would be paired with a PC that has members, with nobody approving and nobody asked.
   */
  private endNoAccountCode(): void {
    if (this.pending?.noAccountOnly === true && this.account() !== null) this.endPairing(undefined, "joined");
  }

  /**
   * The paired device `id` is handed the code pending (a relay offer it asked for carries it): it holds it too.
   * Called before the code leaves this PC: a device that is paired no more, or may only watch, by now is handed
   * nothing (assertHolder).
   */
  holdPairing(id: string): void {
    this.assertHolder(id);
    this.pending?.holders.add(id);
  }

  /**
   * The paired device `id` may still hold a pairing code: checked right before one is started or handed to it, since
   * its request may have waited (on the relay, say) while it was removed (DeviceGoneError) or made one that only
   * watches (DeviceReadOnlyError).
   */
  private assertHolder(id: string): void {
    if (!this.has(id)) throw new DeviceGoneError();
    if (!this.canHoldCode(id)) throw new DeviceReadOnlyError();
  }

  /**
   * Whether the code pending is past its ten minutes: from the first time the wall clock `now`, or the store's clock,
   * which only moves forward, said so. A clock set back or forward and back again gives no time back, so a code kept
   * past its ten minutes for the devices that paired with it in time (expirePending) never pairs a new one. Those
   * devices keep their own time to link, on the store's clock.
   */
  private codeOver(pending: { expires: number; deadline: number; over?: true }, now: number): boolean {
    if (now > pending.expires || this.clock.now() > pending.deadline) pending.over = true;
    return pending.over === true;
  }

  /** The id of the code pending (endPairing, accountPairingState); null when none is. */
  pairingId(): string | null {
    return this.pending?.id ?? null;
  }

  /**
   * Takes the pending six-digit code back, and the typed relay code bound to it: nothing it was shown as pairs any more.
   * With `match`, only when its `code` and its `id`, each that is given, are the pending code's, so a caller never ends
   * a pairing started after its own; false when it did not. `why`: what a code made for an account is remembered to
   * have ended by.
   */
  endPairing(match?: { readonly code?: string; readonly id?: string }, why: AccountPairingEnd = "cancelled"): boolean {
    const pending = this.pending;
    if (match !== undefined && (pending === null || (match.code !== undefined && !same(match.code, pending.code)) || (match.id !== undefined && match.id !== pending.id))) return false;
    this.voidPending(why);
    for (const listener of this.codeStarts) listener();
    return true;
  }

  /**
   * The clock a row that waits to link is bounded on, and a code's redemption with it (codeOver). It only moves
   * forward (performance.now by default), so a PC's wall clock set back extends none of those bounds. A test hands in
   * one it moves by hand.
   */
  useClock(clock: MuxClock): void {
    this.clock = clock;
  }

  /**
   * Drops the code pending, with nobody told; the rows that waited to link under it go with it. A code made for an
   * account is remembered as ended by `why` (accountPairingState).
   */
  private voidPending(why: AccountPairingEnd = "cancelled"): void {
    const waiting = this.pending?.waiting;
    const id = this.pending?.id;
    const named = this.pending?.named;
    this.pending?.cancelExpiry?.();
    this.pending = null;
    // every end of a code is heard: its reservations go with it (T71, S2-13 PendingRedemptions.dropCode)
    if (id !== undefined) for (const listener of [...this.pairingEndedListeners]) {
      try { listener(id); } catch (error) { console.warn(`[devices] a pairing-end listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (waiting) for (const row of [...waiting.rows.values()]) this.dropProvisional(waiting, row, "code_ended");
    if (named && id !== undefined) {
      const joined = why === "joined" ? waiting?.joined : undefined;
      this.endedAccountCodes = [...this.endedAccountCodes, { state: "ended" as const, id, expect_account: named.account, ended: { why, at: new Date().toISOString() }, ...(joined ? { joined } : {}), turned_away: [...waiting?.turnedAway ?? []] }]
        .slice(-ENDED_ACCOUNT_CODES);
    }
  }

  /**
   * The code pending is past its ten minutes: it pairs no new device. It goes now, unless devices that paired with it
   * in time still wait to link: each keeps its own PAIRING_LINK_MS, and the code goes with the last of them
   * (dropProvisional), or when one links.
   */
  private expirePending(): void {
    const waiting = this.pending?.waiting;
    // a row whose time is over goes at this look (provisional)
    if (waiting) for (const id of [...waiting.rows.keys()]) this.provisional(id);
    if (this.pending !== null && (this.pending.waiting?.rows.size ?? 0) === 0) this.voidPending("expired");
  }

  /**
   * A row that waits to link goes: its sessions end `auth_revoked`, and a later sign-in with its id fails. Nothing
   * was written for it, so nothing is unwritten and no tombstone is left. Its use stays spent; a code with no use
   * left, or past its ten minutes (expirePending), ends as the last row that waited under it goes. `why`, with the
   * account its link named when that was the reason, goes into the code's history (accountPairingState).
   */
  private dropProvisional(waiting: WaitingRows, row: ProvisionalRow, why: AccountPairingTurnedAway["why"], account?: string): void {
    if (!waiting.rows.delete(row.id)) return;
    row.cancel();
    waiting.turnedAway.push({ n: waiting.turnedAway.length + 1, id: row.id, label: row.label, why, link: row.link ?? (row.links > 0 ? "sent" : "not_sent"), ...(account === undefined ? {} : { account }) });
    const listeners = this.revocations.get(row.id);
    this.revocations.delete(row.id);
    for (const close of listeners ?? []) close(true);
    if (this.pending?.waiting !== waiting || waiting.rows.size > 0) return;
    if (waiting.usesLeft === 0) this.endPairing(undefined, "overused");
    else if (this.codeOver(this.pending, Date.now())) this.endPairing(undefined, "expired");
  }

  /**
   * `keys` were removed on this PC in this turn (a revoke, a revoke of all, an account's removal): every row that
   * waits to link with one of them goes with it, once the removal is written and before anything else is. Such a
   * row paired before the removal, and its link would take it back (promote clears the tombstone of a key its row
   * kept). So a tombstone that stands when a waiting row links stood when that row paired.
   */
  private dropWaiting(keys: readonly string[], cause: KeyRemovedCause = "remove"): void {
    // every key a deny takes ends its reservation and is told, each listener on its own (S2-13)
    for (const key of keys) {
      this.pending?.reserved?.delete(key);
      for (const listener of [...this.keyRemovedListeners]) {
        try { listener(key, cause); } catch (error) { console.warn(`[devices] a key removal listener failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    const waiting = this.pending?.waiting;
    if (!waiting) return;
    for (const row of [...waiting.rows.values()]) if (keys.includes(row.key)) this.dropProvisional(waiting, row, "removed");
  }

  /**
   * The row `id` that waits to link, by the clock read now: one whose PAIRING_LINK_MS are over is gone at the first
   * look, whether or not its timer has run.
   */
  private provisional(id: string): ProvisionalRow | undefined {
    const waiting = this.pending?.waiting;
    const row = waiting?.rows.get(id);
    if (!waiting || !row) return undefined;
    if (this.clock.now() - row.pairedAt < PAIRING_LINK_MS) return row;
    this.dropProvisional(waiting, row, "link_timeout");
    return undefined;
  }

  /**
   * The row `id` as its own relay session may see it: a device, or one that waits to link (`provisional`). Nothing
   * else is shown a waiting row: no list, no route and no holder of a code knows it, and its role is the one with
   * the fewest rights. This look reads no clock: the two calls such a row may make do (provisionalStands,
   * linkArrived), so a row whose time is over is gone at the first of them, and can make no other call meanwhile.
   */
  sessionRow(id: string): { role: DeviceRole; key: string | undefined; provisional: boolean } | null {
    const device = this.devices.find((d) => d.id === id);
    // a row its evidence covers serves no request, whatever session it holds (S14); while the PC fails closed no
    // session opens another stream either: only this PC itself gets in (S19, P8)
    if (device && this.catchingUp(id)) return null;
    if (this.evidence !== null && (this.failsClosed || (device !== undefined && this.stale(device)))) return null;
    if (device) return this.memberAdmitted(device, Date.now()) ? { role: device.role, key: device.relay_public_key, provisional: false } : null;
    const waiting = this.pending?.waiting?.rows.get(id);
    if (waiting) return { role: "watch", key: waiting.key, provisional: true };
    // an account-joined row serves while it is usable here: out of its hold and its waits, and not covered or frozen
    const row = this.joinedRows?.row(id) ?? null;
    const access = row && this.listedAccess(row);
    if (!row || !access || !("ok" in access)) return null;
    // every request of its session is use this PC sees (P9, T54); the store writes the day at most once
    this.joinedRows!.seen(id);
    return { role: this.joinedRole(row), key: row.key, provisional: false };
  }

  /**
   * Step 2 (S2-25): the account-joined rows (server/account/account-devices.ts), set only while Step 2 is on.
   * They never enter devices.json (P1); they sign in by relay AUTH with their registered key and are drive principals
   * once usable, judged by the same evidence and freezes as a devices.json row.
   */
  attachAccountRows(source: AccountRowSource | null): void { this.joinedRows = source; }

  /**
   * The account's signed list as this PC follows it (server/account/list-follow.ts). Once the PC is pinned to a list,
   * its account rows are the list's, with the role the list gives each, and the account service's word takes the PC
   * out of its account no more.
   */
  attachList(list: ListAuthority | null): void { this.signedList = list; }
  private signedList: ListAuthority | null = null;

  /** Whether this PC lets its account's devices in by its signed list alone. */
  listFollowed(): boolean { return this.signedList?.pinned() === true; }

  /** Whether this PC's relay identity was removed from `account` by that account's list: it joins it again on no path. */
  listRemovedFrom(account: string): boolean { return this.signedList?.removedFrom(account) === true; }

  /** Whether the PC may be reset as the new PC that `account`'s list removed it as `serverId` (PcAccountState.readdReset), read from disk now. */
  readdReset(account: string, serverId: string): "removed" | "in_account" | "not_removed" {
    return this.pc === null ? "not_removed" : this.pc.readdReset(account, serverId);
  }

  /** What an account row may do: on a pinned PC what the list says of its key, and to watch for a key the list no longer lets in. */
  private joinedRole(row: AccountRow): DeviceRole {
    const role = this.signedList?.role(row.key);
    return role === undefined ? "drive" : role ?? "watch";
  }

  /** Whether any device holds a session here: the PC then reads its list more often. */
  sessionsOpen(): boolean { return this.revocations.size > 0; }

  /** An account row as the order, evidence and freeze checks see a row: its key, this PC's account, its admission order. */
  private joinedAsStored(row: AccountRow): StoredDevice {
    return { id: row.id, label: row.label, role: this.joinedRole(row), token_hash: "", relay_public_key: row.key, created_at: row.confirmed_at, last_seen_at: null, account: this.account() ?? undefined, origin: row.origin };
  }

  private accountRowStale(row: AccountRow): boolean {
    const stored = this.joinedAsStored(row);
    const state = this.safety?.inForce;
    // on a pinned PC a row stands only while the list lets its key in: a time that passed, an alarm, a removal
    return this.accountError !== null || state?.locked === true || this.signedList?.role(row.key) === null || this.failedRows.has(row.id) || this.failedDenies.has(row.key)
      || this.isTombstoned(row.key) || this.coveredByEvidence(stored) || this.frozen(stored)
      || (state?.freezes.some(({ record }) => record.target === row.key || (record.kind === "freeze" &&
        (this.accountOrder?.late(row.key) !== false || (this.accountOrder.no(row.key) ?? row.no) > record.after))) ?? false);
  }

  /** One standing verdict for a proved list sign-in and its HTTP and WebSocket sessions. */
  private listedAccess(row: AccountRow): AccessAnswer | null {
    return this.accountRowStale(row) ? null : this.joinedRows?.access(row.id) ?? null;
  }

  /** A durable safety change can end a stream without a new request from its owner. */
  recheckListedSessions(): void {
    for (const row of this.joinedRows?.rows() ?? []) {
      if (this.accountRowStale(row)) this.closeAccountSessions(row.id);
    }
    this.listedChanged();
  }

  /** A row of either store by id, an account row as the order checks see it. */
  private anyRow(id: string): StoredDevice | undefined {
    const row = this.joinedRows?.row(id) ?? null;
    return this.devices.find((d) => d.id === id) ?? (row === null ? undefined : this.joinedAsStored(row));
  }

  /** Every row of `key` in either store, the account rows as the order checks see them. */
  private rowsOfKey(key: string): StoredDevice[] {
    return [...this.devices.filter((d) => d.relay_public_key === key), ...(this.joinedRows?.rowsByKey(key) ?? []).map((row) => this.joinedAsStored(row))];
  }

  /**
   * A relay AUTH for an account-joined row: null when no such row stands here or the signature is not its key's, so a
   * caller without the key learns nothing; else the row's own verdict, read after the proof (T66).
   */
  async matchAccountRelay(deviceId: string, nonce: Uint8Array, signature: string, serverId: string): Promise<{ match: DeviceMatch } | { refused: Exclude<AccessAnswer, { ok: true }>; holdUntil: string | null; readmission?: ReturnType<AccountRowSource["readmission"]> } | null> {
    if (this.joinedRows === null || this.accountError !== null || nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const member = this.devices.find((d) => d.id === deviceId);
    const row = this.joinedRows.row(deviceId);
    if (member ? !member.held || this.stale(member) : !row || this.accountRowStale(row)) return null;
    const key = member?.relay_public_key ?? row?.key;
    if (!key || !await verifyRelayProof(key, { nonce, signature, serverId }) || this.accountError !== null) return null;
    const currentMember = this.devices.find((d) => d.id === deviceId);
    if (member) {
      if (!currentMember || currentMember.relay_public_key !== key || this.stale(currentMember)) return null;
      return this.promotedHolds.refusal(currentMember, Date.now()) ?? { match: { id: deviceId, label: currentMember.label, role: currentMember.role } };
    }
    const current = this.joinedRows.row(deviceId);
    if (currentMember || current === null || current.key !== key) return null;
    const answer = this.listedAccess(current);
    if (!answer) return null;
    if ("ok" in answer) {
      this.joinedRows.seen(deviceId);
      return { match: { id: current.id, label: current.label, role: this.joinedRole(current) } };
    }
    return { refused: answer, holdUntil: this.joinedRows.row(deviceId)?.hold_until ?? null, readmission: this.joinedRows.readmission(deviceId) };
  }


  /**
   * On a PC pinned to its signed list: a sign-in under the account id of a key (`accountDeviceId(serverId, key)`)
   * that the list lets in, where this PC holds that key only by a pairing of its own, whose row has an id of its own.
   * An app that opens the PC through its account knows the key by that account id alone, and the list holds the key,
   * so it is let in: as the role the list gives the key, whatever role the pairing has. The session is that row's, so
   * a Revoke of the pairing ends it; the caller ends it when the list lets the key in no more (listRoleOf). Null for
   * any other id, a signature that is not the key's, and on a PC that follows no list.
   */
  async matchListKey(deviceId: string, nonce: Uint8Array, signature: string, serverId: string, now = Date.now()): Promise<{ match: DeviceMatch; key: string } | null> {
    if (!this.listFollowed() || this.failsClosed || nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const row = this.devices.find((d) => d.relay_public_key !== undefined && d.id !== deviceId && accountDeviceId(serverId, d.relay_public_key) === deviceId);
    const key = row?.relay_public_key;
    if (row === undefined || key === undefined || this.stale(row)) return null;
    const verified = await verifyRelayProof(key, { nonce, signature, serverId });
    // whatever changed while the proof was checked is read again now (T66)
    const current = this.devices.find((d) => d.id === row.id);
    const role = this.listRoleOf(key);
    if (!verified || this.failsClosed || current === undefined || current.relay_public_key !== key || this.stale(current) || !this.memberAdmitted(current, now) || role === null) return null;
    return { match: { id: current.id, label: current.label, role }, key };
  }

  /**
   * On a PC that follows a list, the pairing of this PC's own that holds `key` under an id that is not the account's
   * for it (what matchListKey signs such a key in over), or null. The list answers for the key; the row only carries
   * its session, and a Revoke of the pairing ends that.
   */
  listPairing(key: string, serverId: string, now = Date.now()): { readonly id: string; readonly label: string } | null {
    if (!this.listFollowed() || this.failsClosed) return null;
    const row = this.devices.find((d) => d.relay_public_key === key && d.id !== accountDeviceId(serverId, key));
    return row === undefined || this.stale(row) || !this.memberAdmitted(row, now) ? null : { id: row.id, label: row.label };
  }

  /**
   * On a PC pinned to its list, the key of row `id` when that id is the account's own for the key
   * (accountDeviceId): the id an app opens the PC through its account by. The list alone answers for such an id,
   * whoever wrote the row and whenever (a member's v1 add before the pin, a join approved by digits): the row gives
   * it no role, no time and no way in. Null for a pairing under an id of its own, and on a PC that follows no list.
   */
  listGoverned(id: string, serverId: string): string | null {
    if (!this.listFollowed()) return null;
    const key = this.devices.find((d) => d.id === id)?.relay_public_key;
    return key !== undefined && accountDeviceId(serverId, key) === id ? key : null;
  }

  /**
   * On a PC pinned to its list, what the list says of the row `id` when that row is another PC of the account (it
   * records the relay key its join proved, `vouched_pc`): the row's own role, to watch, while the list holds that
   * relay key as a PC that is in; null when it does not. Undefined for any other row, and on a PC that follows no list.
   */
  vouchedPcRole(id: string): DeviceRole | null | undefined {
    if (!this.listFollowed()) return undefined;
    const row = this.devices.find((d) => d.id === id);
    if (row === undefined || row.vouched_pc === undefined) return undefined;
    return this.signedList?.holdsPc(row.vouched_pc) === true ? row.role : null;
  }

  /**
   * The PC pinned its list: every session open under the account's id for a key (listGoverned) ends as one whose row
   * changed under it (`auth_changed`), whoever wrote the row, so its next sign-in gets the list's answer.
   */
  closeListGovernedSessions(serverId: string): void {
    for (const row of [...this.devices]) {
      if (row.relay_public_key !== undefined && accountDeviceId(serverId, row.relay_public_key) === row.id) this.closeAccountSessions(row.id);
    }
  }

  /** The role the list this PC is pinned to gives `key` now; null when it lets the key in as nothing, and on a PC that follows no list. */
  listRoleOf(key: string): DeviceRole | null {
    return this.listFollowed() ? this.signedList?.role(key) ?? null : null;
  }

  /**
   * "It's me" (T53) from the row `sayerId` for the admission notice `noticeId`: the held account row it names ends its
   * hold only when the sayer drives, is usable here, is older on this PC and was admitted here over an hour ago, and the
   * final admission check passes. A notice it ends is decided.
   */
  itsMe(sayerId: string, noticeId: string, provedKey: string): boolean {
    const notice = this.journal?.openNotices().find((entry) => entry.id === noticeId);
    const sayer = this.provedSayer(sayerId, provedKey);
    if (!notice?.row || !notice.key || !sayer) return false;
    const member = this.devices.find((d) => d.held === notice.id || d.id === notice.row);
    if (member) {
      if (!this.promotedHolds.mayConfirm(member, notice, { sayer, accountNo: this.accountOrder?.no(notice.key) ?? null, now: Date.now() })) return false;
      const decision = this.journal?.append({ ...notice, kind: "confirm", how: "its_me", by: provedKey }, notice.id);
      if (!decision) return false;
      this.releasePromoted(member);
      this.publish(decision);
      return true;
    }
    const held = this.joinedRows?.row(notice.row);
    return held?.key === notice.key && held.origin.admit_no === notice.no && (this.joinedRows?.itsMe(held.id, sayer) ?? false);
  }

  private provedSayer(id: string, key: string | undefined): Sayer | null {
    const row = this.anyRow(id);
    if (!key || row?.relay_public_key !== key || !row.origin || this.accountError !== null) return null;
    const joined = this.joinedRows?.row(id);
    // a sayer whose own devices.json row still waits for the first whole read (S2-27) cannot vouch for another row
    const live = this.canSpeak(id) && !(joined ? this.accountRowStale(joined) : this.stale(row));
    return { key, drives: row.role === "drive", state: live ? "live" : "waiting", no: this.accountOrder?.no(key) ?? null,
      late: this.accountOrder?.late(key) ?? false, admitNo: row.origin.admit_no, admittedAt: Date.parse(row.origin.at) };
  }

  resumePromotedHolds(): void { this.promotedHolds.resume(this.devices, Date.now()); }

  private releasePromoted(row: StoredDevice): void {
    const { held, carried_notice: carried, ...live } = row;
    if (row.origin?.from === "pc" && (held || carried)) this.replaceDevice(row, live);
    else if (held) this.replaceDevice(row, { ...live, carried_notice: held });
  }

  private replaceDevice(row: StoredDevice, updated: StoredDevice): void {
    const next = this.devices.map((d) => d === row ? updated : d);
    this.save(next);
    this.devices = next;
    if (row.held && !updated.held) this.promotedHolds.forget(row.held);
  }


  /** Step 2 (S2-27): the wait after a start for devices.json rows not paired at this PC; set only while Step 2 is on. */
  attachCatchUp(gate: CatchUpGate | null, releases?: RecoveryReleases): void {
    this.catchUp = gate;
    this.releases = releases;
  }

  listedRecoveryCandidate(row: AccountRow): RecoveryCandidate {
    const stored = this.joinedAsStored(row);
    return { id: row.id, key: row.key, label: row.label, origin: row.origin, waiting: "catching_up",
      joinHold: row.state === "hold", expired: row.state === "expired", openNotice: this.listNotice(row) !== undefined,
      covered: this.isTombstoned(row.key) || this.coveredByEvidence(stored),
      held: this.accountHeld?.(row.key) === true || this.safety?.inForce.locked === true,
      frozen: this.accountRowStale(row) || !this.admitsFromList(row.key, this.account() ?? ""),
      lastSeenAt: row.last_signin_day };
  }

  private isLegacyCredential(device: StoredDevice): boolean {
    return !device.invalid_origin && (device.imported
      ? this.siblingLegacyCredential?.(device) === true && !this.journal?.entries().some(entry => entry.row === device.id)
      : device.origin?.from === "legacy" || this.legacyFromRegistry(device));
  }

  /** Whether the devices.json row `id` waits for the first whole read (T41). */
  catchingUp(id: string, credential = true): boolean {
    const device = this.devices.find((d) => d.id === id);
    if (device === undefined) return false;
    if (this.waitsOnStaleRead(device, credential)) return true;
    // A Step-1 writer may have added a credential during rollback. It gets no admission order.
    const offPair = device.off_pair_binding !== undefined && !device.imported && device.relay_public_key === undefined
      && this.pc?.binding()?.bind_id === device.off_pair_binding && this.pc.serviceStep2Off();
    return this.catchUp?.waits({ id, origin: device.origin }, credential && (this.isLegacyCredential(device) || offPair)
      ? () => this.admissionAllowed(device.relay_public_key, "legacy_credential", { retainedRow: device }) : undefined,
      // the pairing a PC keeps when it leaves its account is its own; what the row may do for the account waits on
      credential ? () => keepsPairingOnUnlist(device) && this.admits(device.relay_public_key, undefined, { retainId: device.id }) : undefined,
      () => this.listAdmits(device) && this.admits(device.relay_public_key, undefined, { retainId: device.id })) ?? false;
  }

  /** CatchUpGate.narrowedRead, for a whole snapshot read that could widen nothing. */
  narrowedRead(): void { this.catchUp?.narrowedRead(); }

  /** Whether `id` is an account-joined row (S2-26): its every route goes through accountRowMay. */
  isAccountRow(id: string): boolean { return !this.devices.some((d) => d.id === id) && (this.joinedRows?.row(id) ?? null) !== null; }

  /** The account rows' store ends the sessions of a row it dropped (P8 step 3 for a list drop, T35). */
  closeAccountSessions(id: string): void {
    const listeners = this.revocations.get(id);
    this.revocations.delete(id);
    for (const close of listeners ?? []) close();
  }

  /** Whether the row `id` still waits to link: its code is the one pending, and its PAIRING_LINK_MS are not over by the clock read now. */
  provisionalStands(id: string): boolean {
    return this.provisional(id) !== undefined;
  }

  /**
   * A row that waits to link is turned away: its link named another account than the one this PC is for
   * (`account_mismatch`, with the account it named), or the account service did not vouch for its key (`unverified`).
   * It goes at once, as when its time runs out. Its use of the code stays spent, and the code stays.
   */
  turnAway(id: string, why: "account_mismatch" | "unverified", account?: string): void {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (row && waiting) this.dropProvisional(waiting, row, why, account);
  }

  /**
   * A link came from the row `id` (POST /api/account/link), before its signature is checked: whether the row is one
   * that waits to link. `wasProvisional`: its relay session said so when the request began, so a row that went
   * since is never taken for a device. A waiting row sends WAITING_LINKS links; the next turns it away, and null
   * says so.
   */
  linkArrived(id: string, wasProvisional = false, counted = true): LinkArrival | null {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    // `counted` false: the row asks again where it stands after it named its account's list (listNamedBy), which is no
    // new try of anything: only its first naming is one of its few
    if (row && waiting && counted) {
      row.links += 1;
      if (row.links > WAITING_LINKS) { this.dropProvisional(waiting, row, "link_refused"); return null; }
    }
    return { provisional: wasProvisional || row !== undefined, pinned: this.pinnedCode() };
  }

  /**
   * The link of a row that waits (linkAccountKey): the row becomes a device and a member of `link.account` in one
   * write of devices.json. First the check again, right before anything is written: the row still waits and still
   * names the key the link starts from, the PC is still in no account, and no account removed the key the row would
   * hold. Null when one of them fails, and nothing is written; a write that throws leaves the row waiting. Once the
   * row is written the code it paired with has done what it was for: it ends, every other row that waited goes, the
   * row's other sessions end (`auth_changed`), and the device is announced. Last, the tombstone of a key the row
   * kept is cleared. It is this PC's own removal of that key (Revoke, Revoke all), and it stood when the row paired:
   * one made since would have taken the row (dropWaiting). That write's failure is logged and changes nothing of the
   * above; the next start clears it.
   */
  private promote(id: string, link: { oldKey: string; key: string; account: string }, sessionId: string, vouched: boolean, replacement = false, screen?: ConfirmProof): PairedDevice | null {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (!row || !waiting || row.key !== link.oldKey || this.account() !== null || this.removedByAccount(link.key)) return null;
    if (waiting.confirmedId !== undefined && waiting.confirmedId !== row.id) return null;
    const renewed = link.key === link.oldKey ? this.pairingsRenewedBy(link.key) : [];
    if (renewed === null) return null;
    // Only a same-key screen confirmation, or this PC's screen confirm of a moved key as its replacement, carries a
    // confirm proof (T72, P22)
    const kept = link.key === row.key ? row.confirmed : undefined;
    const confirm = screen !== undefined ? { proof: screen, how: "link" as const, by: undefined } : kept;
    const path = confirm === undefined ? {} : {
      confirm: confirm.proof, pairingHere: confirm.proof.source === "screen", ...(confirm.by === undefined ? {} : { by: confirm.by }),
    };
    if (!this.admits(link.key, confirm?.proof, path)) return null;
    const now = Date.now();
    // a link that moves the key its PAIR named admits a key nobody here approved: with the flag on it waits, as a
    // stored row's does, for a confirm of its own on this PC's screen, and the row waits with it (P22, T7, T72)
    if (this.pc !== null && link.key !== link.oldKey && screen === undefined) {
      if (!replacement) throw new ReplacementNeedsAppError();
      this.replacements.set(id, { key: link.key, account: link.account, at: now, challenge: randomBytes(32).toString("base64url"), sessionId, vouched, ownWord: true, waitingRow: true });
      row.cancel();
      row.cancel = this.clock.setTimeout(() => this.dropProvisional(waiting, row, "link_timeout"), REPLACEMENT_TTL_MS);
      return { id: row.id, label: row.label, role: "watch", created_at: new Date(now).toISOString(), last_seen_at: null, current: false, via_relay: true };
    }
    const at = new Date(now).toISOString();
    // the removal of a key the row keeps, by this PC (removedByAccount refused the account's above)
    const removedAt = link.key === link.oldKey ? this.tombstones.find((t) => t.key === link.key)?.removed_at : undefined;
    const device: StoredDevice = {
      id: row.id, label: row.label, role: "drive", token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: link.key,
      // made at this write, not at its pairing, and after that removal even on a wall clock set back since: the row
      // is newer than the removal, so a stop before the tombstone is cleared leaves a row that the next start keeps
      // (finishInterruptedWrites, or with the flag on RemovalEvidence.takeIn)
      created_at: removedAt !== undefined && removedAt >= at ? new Date(Date.parse(removedAt) + 1).toISOString() : at, last_seen_at: at, account: link.account, linked_at: at, link_moved_key: link.key !== link.oldKey, joined_by: vouched ? "service" : "code",
    };
    // no waiting row from here on: the end of its code, which this write brings, takes the rows that still wait
    waiting.rows.delete(row.id);
    // the end of its code, which this write brings, names the device it brought in
    waiting.joined = { device_id: row.id, label: row.label };
    let enrolled: boolean;
    try {
      if (confirm !== undefined && this.pc !== null) {
        device.origin = this.pc.admit(confirm.proof.source === "screen" ? "pc" : "recover", confirm.how, null, now);
        if (confirm.proof.recoveredOver) device.recovered_over = confirm.proof.recoveredOver;
      }
      enrolled = this.bindingWith(link.account, link.key, () => this.enroll(device, now, [], false, { ...path, renews: renewed }));
    } catch (error) {
      waiting.rows.set(row.id, row);
      delete waiting.joined;
      throw error;
    }
    row.cancel();
    if (!enrolled) return null;
    this.retireRenewed(renewed);
    for (const listener of [...this.relinks.get(id) ?? []]) listener(sessionId);
    if (link.key === link.oldKey) {
      try { this.clearTombstone(link.key); }
      catch (error) { console.error(`[devices] the tombstone of a key that paired again could not be cleared; the next start clears it: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return this.list(null).find((d) => d.id === id) ?? null;
  }

  /**
   * The rows of `key` that the link of a row waiting with that same key takes the place of (promote): the pairings this
   * PC already has of a device that paired again with a code made for a PC in no account. The link is signed with the
   * key, so its sender is the device those rows are for, and a device new to this PC would be taken with the same code.
   * Null when one of them is no pairing a new one may stand in for: it only watches, is in an account, or is kept out.
   */
  pairingsRenewedBy(key: string): readonly StoredDevice[] | null {
    const rows = this.devices.filter(row => row.relay_public_key === key);
    return rows.every(row => row.role === "drive" && row.account === undefined && !this.stale(row) && !this.replacements.has(row.id)) ? rows : null;
  }

  /**
   * The rows a new pairing of their key took the place of are out of devices.json already (enroll). Their sessions
   * end as a row's do when its link changes it, so a page still open with one signs in again with the record its
   * device holds now, and no removal is announced: nobody removed the device.
   */
  private retireRenewed(rows: readonly StoredDevice[]): void {
    for (const row of rows) {
      for (const listener of [...this.relinks.get(row.id) ?? []]) listener("");
      this.closeAccountSessions(row.id);
      try { this.journalRemoval(row, "pc", "renewed"); }
      catch (error) { console.error(`[devices] the end of a pairing that was renewed could not be journalled: ${describe(error)}`); }
    }
  }

  pair(code: string, label: string, role: DeviceRole, now = Date.now(), origin: readonly string[] = [], localCodeOnly = false): { token: string; device: DeviceMatch } | null {
    if (!this.admits(undefined)) return null;
    this.assertWritable();
    this.pruneUnconfirmedFirstPairs(now);
    // a code started through the relay is never redeemed on the LAN listener, nor are its guesses spent there:
    // it would make a credential no relay key or account removal reaches
    if (localCodeOnly && this.pending?.remote === true) return null;
    // a code made for a PC in no account is redeemed through the relay only, and no try is spent on it here: the
    // device it is for links itself into an account with the key it paired with (pairProvisional), and a device
    // paired here holds a cookie and no key
    if (this.pending?.waiting) return null;
    if (!this.checkPairingCode(code, now, localCodeOnly)) return null;
    // a member's code goes with the member here too (pairRelay)
    const startedBy = this.pending?.startedBy ?? null;
    if (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy))) return null;
    const token = randomBytes(32).toString("hex");
    const created_at = new Date(now).toISOString();
    // An owner-issued local code during service opt-out pairs a cookie, never a Step-2 key.
    const offBinding = this.pending?.ownPc === true && !this.pending.remote && this.pc?.serviceStep2Off()
      ? this.pc.binding()?.bind_id : undefined;
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label, role, token_hash: hash(token), created_at,
      last_seen_at: null, ...(offBinding === undefined ? {} : { off_pair_binding: offBinding }) };
    if (!this.gated) {
      this.voidPending();
      this.unconfirmedFirstPairs.push({ device, expires: now + CODE_TTL_MS, origin });
      if (this.unconfirmedFirstPairs.length > UNCONFIRMED_FIRST_PAIR_LIMIT) this.unconfirmedFirstPairs.shift();
      return { token, device: { id: device.id, label: device.label, role: device.role } };
    }
    if (!this.enroll(device, now, origin, true, { startedBy })) return null;
    return { token, device: { id: device.id, label: device.label, role: device.role } };
  }

  /**
   * Both transports spend the same pending code's five guesses. The LAN HTTPS listener has five of its
   * own instead (`lan`), so a stranger there cannot spend a code a phone is about to type in elsewhere.
   */
  private checkPairingCode(code: string, now: number, lan = false): boolean {
    const pending = this.pending;
    if (pending === null) return false;
    // the devices that paired with it in time still have their own time to link (expirePending)
    if (this.codeOver(pending, now)) { this.expirePending(); return false; }
    // made for a PC in no account, and the PC is in one: it ended as the PC joined (endNoAccountCode), and pairs nobody
    if (pending.noAccountOnly === true && this.account() !== null) { this.endPairing(undefined, "joined"); return false; }
    if (lan) {
      if ((pending.lanAttempts ?? 0) >= CODE_ATTEMPTS) return false;
      if (same(code.replace(/\D/g, ""), pending.code)) return true;
      pending.lanAttempts = (pending.lanAttempts ?? 0) + 1;
      return false;
    }
    if (!same(code.replace(/\D/g, ""), pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_ATTEMPTS) this.voidPending("guessed");
      return false;
    }
    return true;
  }

  /** One authorization write precedes every state change and enrollment announcement. */
  private enroll(admitting: StoredDevice, now: number, origin: readonly string[], codeSpent = true, path: { startedBy?: string | null; digits?: boolean; confirm?: ConfirmProof; by?: string; pairingHere?: boolean; replaces?: StoredDevice; renews?: readonly StoredDevice[] } = {}, signerKey?: string): boolean {
    // the final guard, in the commit turn: nothing waits between it and the write
    if (!this.admits(admitting.relay_public_key, path.confirm, path)) throw new AdmissionRefusedError();
    const initial = this.knowingRemovals(this.admitted(admitting, now, path));
    const rows = initial.relay_public_key ? this.joinedRows?.rowsByKey(initial.relay_public_key) ?? [] : [];
    // The list ID is derived from the key and unique on this PC; a pairing may choose a different member ID.
    const joined = rows[0];
    const at = this.evidence === null ? initial.created_at : this.nextStamp(Date.parse(initial.created_at));
    const admitted = { ...initial, created_at: at, ...(joined && initial.origin ? { origin: { ...initial.origin, at } } : {}) };
    const notice = joined && this.listNotice(joined);
    const signerId = path.replaces?.id ?? admitted.added_by;
    const signer = signerKey && signerId ? this.provedSayer(signerId, signerKey) : null;
    const held = joined && !path.confirm && this.carriesJoinHold(admitted, joined, now, signer);
    if (held && !notice) throw new Error("The held admission has no durable notice");
    const device = held && notice ? { ...admitted, held: notice.id }
      : notice && !path.confirm && admitted.origin?.from === "remote" ? { ...admitted, carried_notice: notice.id } : admitted;
    // A waiting first link enrolls its own binding row. Every other member enrollment consumes T67.
    if (device.account !== undefined && device.linked_at === undefined) this.pc?.setOthersEver();
    let entry: JournalEntry | null = null;
    const standing = this.admitListedRows(() => {
      entry = this.journalAdmission(device, joined, notice, path.by);
      const next = path.replaces ? this.devices.map(row => row === path.replaces ? device : row) : [...this.devices.filter(row => !path.renews?.includes(row)), device];
      const gate = path.replaces && !this.opensAll() ? this.gateClosedAt : this.gateClosedAt ?? device.created_at;
      this.save(next, gate);
      this.devices = next;
      this.gateClosedAt = gate;
      return [device.id];
    });
    if (!standing.includes(device.id)) {
      if (codeSpent && !this.has(device.id)) this.voidPending();
      return false;
    }
    if (joined) this.journal?.openListedRows(standing);
    if (entry) this.publish(entry);
    if (device.held && joined) this.promotedHolds.carry(device.held, joined.hold_until);
    // Save the replacement before retiring the list row (restart finishes an interrupted transfer).
    // removeRows detaches the old authority and closes its sessions before persisting the removal.
    if (rows.length) this.joinedRows?.removeRows(rows.map(row => row.id), "promoted", id => this.closeAccountSessions(id));
    this.accountOrder?.recordJoins([device]);
    // A link changes an existing pairing. It neither spends a code nor announces another pairing.
    if (path.replaces) return true;
    if (codeSpent) this.voidPending();
    if (device.account !== undefined) this.endNoAccountCode();
    // A relay enrollment closes the gate immediately, invalidating every first-cookie candidate.
    if (device.relay_public_key !== undefined) this.unconfirmedFirstPairs = [];
    this.announce(device, now, origin);
    return true;
  }

  /**
   * No cookie is issued: even the first relay pairing is durable and closes the gate at once. `admit` is asked once
   * the code holds and nothing else refuses the key, before any device is made: false makes none, spends no code and
   * counts no failure (server/relay/session.ts, a relay pass that allows no new sessions). It is asked only for a
   * key new to this PC (isNewKey).
   */
  pairRelay(code: string, label: string, publicKey: string, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    // On an ordinary accountless PC a driving phone may start a new pairing over this PC's local Revoke.
    // This is not a screen confirmation: it never overrides a lock, an account removal, or a freeze.
    const starter = this.pending?.startedBy;
    const pairingHere = this.pending?.remote === false || (this.pending?.remote === true && this.pending.waiting === undefined &&
      starter != null && !this.screenApprovalActive() && this.canHoldCode(starter) && this.isTombstoned(publicKey));
    if (!this.admits(publicKey, undefined, { pairingHere })) return null;
    this.assertRelayPairing("code", now);
    // a code made for a PC in no account makes no device: the one that pairs with it waits to link
    const waiting = this.pending?.waiting;
    if (waiting) return this.pairProvisional(waiting, code, label, publicKey, now, admit);
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    // a code started through the relay is not a pairing made on this PC (docs/account.md, rule 5)
    const remote = this.pending?.remote ?? false;
    const startedBy = this.pending?.startedBy ?? null;
    // a code started through the relay is not a pairing made on this PC; a member's code goes with the member.
    // On a PC in no account such a code may bring back a key this PC revoked itself, as before account linking;
    // never one the account removed
    const accountless = this.account() === null;
    const refusedKey = accountless ? this.removedByAccount(publicKey) : this.isTombstoned(publicKey);
    if ((remote && (this.accountError !== null || refusedKey)) || (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy)))) {
      this.noteRelayFailure("code", now);
      return null;
    }
    // a device let in by a code started through the relay is its starter's addition, not a pairing made on this PC (removeAccountKey);
    // one that brings back a key this PC revoked itself (on a PC in no account) undoes that revoke, and is the PC's own
    // pairing, so a tombstone that comes back (a sibling dir, a stop before it is cleared) takes it only if newer
    const undoesRevoke = remote && accountless && this.isTombstoned(publicKey);
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    // the starter's approval stands only while it is still a member of the account it approved for
    const approvedIn = startedBy !== null && this.pending?.approvedIn !== undefined && this.approverAccount(startedBy) === this.pending.approvedIn ? this.pending.approvedIn : undefined;
    const paired = this.enrollRelay(label, publicKey, now, true, undoesRevoke ? { pairingHere } : { addedBy: startedBy ?? undefined, approvedIn, pairingHere });
    if (paired === null) return null;
    if (!remote || accountless) this.clearTombstone(publicKey);
    return paired;
  }

  /**
   * PAIR with a code made for a PC in no account: no device yet. The row it makes is in memory and in no list, and
   * has PAIRING_LINK_MS to link itself into an account (promote); until then its answer names the role with the
   * fewest rights. It spends one of the code's uses and does not end the code. A right code with no use left makes
   * nothing and counts neither as a wrong try nor as a failed pairing; a wrong one counts as ever. Nothing is
   * written, and a removed key is not judged here: the link is (records.ts applyLink, promote).
   */
  private pairProvisional(waiting: WaitingRows, code: string, label: string, publicKey: string, now: number, admit?: () => boolean): { device: DeviceMatch } | null {
    if (waiting.confirmedId !== undefined) return null;
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    if (waiting.usesLeft === 0) return null;
    // asked last, as for any pairing: a relay pass that takes no new device makes no row and spends no use
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    return { device: this.waitToLink(waiting, label, publicKey, now) };
  }

  /** A row in memory that has PAIRING_LINK_MS to link itself into an account; a screen confirm rides along to its link. */
  private waitToLink(waiting: WaitingRows, label: string, publicKey: string, _now: number, confirmed?: ProvisionalRow["confirmed"]): DeviceMatch {
    let id = randomBytes(8).toString("hex");
    while (this.has(id) || waiting.rows.has(id)) id = randomBytes(8).toString("hex");
    const row: ProvisionalRow = {
      id, label: normalizeLabel(label, "Device"), key: publicKey, pairedAt: this.clock.now(), links: 0,
      cancel: this.clock.setTimeout(() => this.dropProvisional(waiting, row, "link_timeout"), PAIRING_LINK_MS),
      ...(confirmed ? { confirmed } : {}),
    };
    waiting.usesLeft -= 1;
    waiting.rows.set(id, row);
    return { id, label: row.label, role: "watch" };
  }

  assertRelayPairing(path: PairingFailurePath = "code", now = Date.now()): void {
    this.assertWritable();
    const { blockedUntil } = this.relayFailures[path];
    if (now < blockedUntil) throw new PairingRateLimitedError(Math.ceil((blockedUntil - now) / 1000));
  }

  noteRelayFailure(path: PairingFailurePath = "code", now = Date.now()): void {
    const count = this.relayFailures[path];
    count.at = count.at.filter((at) => now - at < PAIRING_WINDOW_MS);
    count.at.push(now);
    if (count.at.length >= 20) count.blockedUntil = now + PAIRING_WINDOW_MS;
  }

  /**
   * A pairing by comparing digits that was approved (server/relay/session.ts): on this PC, or by the
   * account member `addedBy` through the relay. No code is spent. `admit` as in pairRelay: asked last and only for
   * a key new to this PC, false makes no device and counts no failure.
   */
  pairRelayApproved(label: string, publicKey: string, approval: { path: PairingPath; addedBy?: string; id?: string; vouchedPc?: string }, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    const pairingHere = approval.addedBy === undefined;
    if (!this.admits(publicKey, undefined, { pairingHere })) return null;
    this.assertRelayPairing(approval.path, now);
    if (!isRelayPublicKey(publicKey)) { this.noteRelayFailure(approval.path, now); return null; }
    // an approver revoked or demoted while the device waited approves nothing
    if (approval.addedBy !== undefined && !this.isAccountApprover(approval.addedBy)) { this.noteRelayFailure(approval.path, now); return null; }
    // Legacy account-member approvals never take a tombstoned key.
    if (approval.addedBy !== undefined && (this.accountError !== null || this.isTombstoned(publicKey))) { this.noteRelayFailure(approval.path, now); return null; }
    const listed = approval.addedBy === undefined ? undefined : this.joinedRows?.rowsByKey(publicKey)[0];
    const carried = approval.addedBy === undefined || !this.opensAll() ? undefined : this.devices.find(d => d.relay_public_key === publicKey && d.held);
    const id = approval.id ?? listed?.id ?? carried?.id;
    if (carried && approval.addedBy !== undefined) {
      const notice = this.openNotices().find(n => n.id === carried.held);
      const sayer = this.provedSayer(approval.addedBy, this.relayKeyOf(approval.addedBy));
      if (!listed && carried.id === id && !this.stale(carried) && !this.keyHeldByOther(publicKey, carried.id) && notice && sayer
        && this.promotedHolds.mayConfirm(carried, notice, { sayer, accountNo: this.accountOrder?.no(publicKey) ?? null, now })) {
        this.releasePromoted(carried);
        return { device: { id: carried.id, label: carried.label, role: carried.role } };
      }
      this.noteRelayFailure(approval.path, now);
      return null;
    }
    // approved on this PC for a key whose row here already stands (its phone never heard the first answer): that row
    // is let in, as its own sign-in would be, and nothing is written
    const standing = pairingHere && id !== undefined ? this.devices.find(d => d.id === id && d.relay_public_key === publicKey) : undefined;
    if (standing !== undefined && !this.stale(standing) && !this.catchingUp(standing.id)) return { device: { id: standing.id, label: standing.label, role: standing.role } };
    const collision = listed
      ? id !== listed.id || !this.canAddAt(listed.id, publicKey) || this.keyHeldByOther(publicKey, listed.id)
      : id !== undefined && this.has(id);
    if (collision) { this.noteRelayFailure(approval.path, now); return null; }
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    // another PC of the account's server only watches here (docs/account.md, "Adding a PC of your account"): it is one row for
    // every device of that PC, and a Revoke or block of one of them here cannot reach it through that PC
    const role = approval.path === "vouched" ? "watch" : "drive";
    const paired = this.enrollRelay(label, publicKey, now, false, { addedBy: approval.addedBy, approvedIn: approval.addedBy === undefined ? undefined : this.approverAccount(approval.addedBy) ?? undefined, digits: true, pairingHere, role, ...(approval.path === "vouched" && approval.vouchedPc !== undefined ? { vouchedPc: approval.vouchedPc } : {}) }, id);
    if (paired === null) return null;
    // written after the row, so a stop between the two leaves a row newer than its tombstone: the next start ends that
    // Revoke (finishInterruptedWrites, or with the flag on RemovalEvidence.takeIn)
    if (approval.addedBy === undefined) this.clearTombstone(publicKey);
    return paired;
  }

  /**
   * Whether a pairing with `key` makes a device new to this PC, which `admit` may refuse (pairRelay). A key a row
   * here already holds does not: a paired phone that opens the pairing QR again, or one that forgot this PC and pairs
   * again with the key its account gave it, is the device this PC knows, and refusing it would cut off someone the
   * limit never meant. The trade-off: PAIR does not prove the key, so someone holding a pairing that would succeed
   * (the owner's code, or digits the owner confirmed) who also names a paired device's public key gets the session
   * that pairing opens past the limit. They cannot sign in with it afterwards (AUTH needs the private key), so each
   * further session takes another pairing that succeeds; on a PC in no account a driving session may start that code
   * itself (devices routes, pair/start). It takes a client changed to name another device's key, on a limit a
   * changed PC could skip anyway.
   */
  private isNewKey(key: string): boolean { return !this.hasKey(key); }

  account(): string | null {
    if (this.pc !== null) return this.pc.account();
    return this.devices.find((d) => d.account !== undefined)?.account ?? null;
  }

  /** Whether the row `id`, or another row of its key that a revoke of it would take too (revoke), is a member of `account`. */
  isMemberOf(id: string, account: string): boolean {
    const key = this.relayKeyOf(id);
    return this.devices.some((d) => (d.id === id || (key !== undefined && d.relay_public_key === key)) && d.account === account && d.relay_public_key !== undefined);
  }

  /** A drive account member whose session signed in with the row's current key: a session left from an older key acts as no member. */
  isAccountApproverSession(id: string, sessionKey: string): boolean {
    return sessionKey !== "" && this.relayKeyOf(id) === sessionKey && this.isAccountApprover(id);
  }

  hasAccountApprover(): boolean { return this.devices.some((d) => this.isAccountApprover(d.id)); }

  /** A drive account member: the only device that may approve a pairing or start a code through the relay (docs/account.md). */
  isAccountApprover(id: string): boolean {
    const device = this.devices.find((d) => d.id === id);
    if (device === undefined || device.role !== "drive" || device.account === undefined || device.relay_public_key === undefined || this.stale(device) || !this.canSpeak(id)) return false;
    // On a PC pinned to its account's list, what may add a device to the list may approve a join, and nothing else:
    // a member of this PC's own devices counts only while the list holds its key to drive with full power, read from
    // the PC's copy now. A row the list does not hold (a v1 add from before the pin, say) approves nobody
    return !this.listFollowed() || this.signedList?.allowsJoins(device.relay_public_key) === true;
  }

  /** The account `id` may approve a pairing for (isAccountApprover), or null. */
  private approverAccount(id: string): string | null {
    return this.isAccountApprover(id) ? this.devices.find((d) => d.id === id)?.account ?? null : null;
  }

  private enrollRelay(label: string, publicKey: string, now: number, codeSpent: boolean, { addedBy, approvedIn, digits, pairingHere, role = "drive", vouchedPc }: { addedBy?: string | undefined; approvedIn?: string | undefined; digits?: boolean; pairingHere: boolean; role?: DeviceRole; vouchedPc?: string | undefined }, id = randomBytes(8).toString("hex")): { device: DeviceMatch } | null {
    const device: StoredDevice = {
      id, label: normalizeLabel(label, "Device"), role,
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: publicKey,
      // PAIR authenticates this relay session too, so the device is seen as it pairs.
      created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
      ...(addedBy === undefined ? {} : { added_by: addedBy }),
      // what a later link reads to tell a member's approval from a code a device outside the account started
      ...(addedBy !== undefined && approvedIn !== undefined ? { member_approved_in: approvedIn } : {}),
      ...(vouchedPc === undefined ? {} : { vouched_pc: vouchedPc }),
    };
    const enrolled = !codeSpent && addedBy !== undefined && approvedIn !== undefined
      ? this.enrollApproved(device, this.relayKeyOf(addedBy), now)
      : this.enroll(device, now, [], codeSpent, { ...(digits === undefined ? {} : { digits }), pairingHere });
    if (!enrolled) return null;
    return { device: { id: device.id, label: device.label, role: device.role } };
  }

  async refusedRelayReceipts(deviceId: string, proof: { nonce: Uint8Array; signature: string; serverId: string }): Promise<readonly BlockReceipt[]> {
    const binding = this.pc?.binding();
    const order = this.accountOrder;
    if (!binding || !order || !this.safety || this.accountError !== null || order.lastVersion(binding.bind_id, proof.serverId) === null) return [];
    const key = this.relayKeyOf(deviceId) ?? order.relayKey(proof.serverId, deviceId);
    if (!key || order.no(key) === null || !await verifyRelayProof(key, proof)) return [];
    if (this.pc?.binding()?.bind_id !== binding.bind_id || order.lastVersion(binding.bind_id, proof.serverId) === null || this.accountError !== null) return [];
    return this.safety.receiptsBySigner(key, binding.account).filter((receipt) => receipt.outcome === "applied");
  }

  /** The transport owns a fresh 32-byte nonce per session and consumes AUTH only once. */
  async matchRelay(deviceId: string, nonce: Uint8Array, signature: string, serverId: string, now = Date.now()): Promise<DeviceMatch | null> {
    if (this.failsClosed) return null;
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key !== undefined);
    // a row that waits to link signs in as any row does, by the key its PAIR named, while it stands; only that
    // sign-in proves the key
    const waiting = device === undefined ? this.provisional(deviceId) : undefined;
    const publicKey = device?.relay_public_key ?? waiting?.key;
    if (publicKey === undefined || (device !== undefined && this.stale(device))) return null;
    const verified = await verifyRelayProof(publicKey, { nonce, signature, serverId });
    // a log that turned strict while the proof was checked refuses it too (S19)
    if (this.failsClosed) return null;
    // the row went, or linked, while its signature was checked: the proof was for a row that is no more
    if (waiting !== undefined) return verified && this.provisional(deviceId) === waiting ? { id: waiting.id, label: waiting.label, role: "watch" } : null;
    // Authorization changes during WebCrypto invalidate the proof; a rename does not.
    const current = this.devices.find((d) => d.id === deviceId);
    // a block, a freeze or a removal that came while the proof was checked ends it here, before any stream (T66)
    if (!verified || !current || device === undefined || current.role !== device.role || current.relay_public_key !== device.relay_public_key || this.stale(current) || !this.memberAdmitted(current, now)) return null;
    this.noteSeen(current, now);
    return { id: current.id, label: current.label, role: current.role };
  }

  match(token: string | undefined, now = Date.now()): DeviceMatch | null {
    this.pruneUnconfirmedFirstPairs(now);
    if (!token) return null;
    const digest = hash(token);
    const candidateIndex = this.unconfirmedFirstPairs.findIndex(({ device }) => same(digest, device.token_hash));
    if (candidateIndex !== -1) {
      const { device: candidate, origin } = this.unconfirmedFirstPairs[candidateIndex]!;
      if (!this.admits(undefined)) return null;
      const admitted = this.admitted({ ...candidate, last_seen_at: new Date(now).toISOString() }, now);
      const confirmed = this.safety === null ? admitted : { ...admitted, created_at: this.nextStamp(Date.parse(admitted.created_at)) };
      const entry = this.journalAdmission(confirmed);
      const next = [...this.devices, confirmed];
      const gate = this.gateClosedAt ?? confirmed.created_at;
      // This is an authorization write, not last-seen telemetry: do not match the cookie
      // unless the device and closed gate reached disk together.
      this.save(next, gate);
      this.devices = next;
      this.gateClosedAt = gate;
      if (entry) this.publish(entry);
      // Once one first-pair cookie closes the gate, every sibling candidate is stale:
      // subsequent devices must be issued through the gated pairing flow.
      this.unconfirmedFirstPairs = [];
      // So is a code the open LAN started: it admits whoever holds it, and until now anyone on the LAN could start
      // one. It ends with the gate, and whoever shows it is told (endPairing). A code this PC, its token or its owner's
      // login started stays: the request that brings the first cookie back may be the one that redeems it.
      if (this.pending?.open) this.endPairing();
      this.announce(confirmed, now, origin);
      return this.catchingUp(confirmed.id) ? null : { id: confirmed.id, label: confirmed.label, role: confirmed.role };
    }
    for (const device of this.devices) {
      if (!same(digest, device.token_hash)) continue;
      if (this.failsClosed) return null;
      // a row its evidence covers or a block freezes opens nothing, whichever way it signs in (S14, S22)
      if (this.catchingUp(device.id) || (this.evidence !== null && this.stale(device)) || !this.memberAdmitted(device, now)) return null;
      this.noteSeen(device, now);
      return { id: device.id, label: device.label, role: device.role };
    }
    return null;
  }

  private noteSeen(device: StoredDevice, now: number): void {
    const seen = device.last_seen_at === null ? 0 : Date.parse(device.last_seen_at);
    if (this.error !== null || now - seen < LAST_SEEN_WRITE_MS) return;
    try {
      const next = this.devices.map((d) => d === device ? { ...d, last_seen_at: new Date(now).toISOString() } : d);
      // devices.json is also the authorization registry: a torn write here would lock every device out
      this.save(next);
      this.devices = next;
    } catch { /* last-seen telemetry must not deny an otherwise valid credential */ }
  }

  update(id: string, patch: { label?: string; role?: DeviceRole }): PairedDevice | null {
    this.assertWritable();
    const device = this.devices.find((d) => d.id === id);
    if (!device) {
      if (patch.label === undefined || patch.role !== undefined) return null;
      const row = this.joinedRows?.rename(id, patch.label);
      return row ? this.joinedAsPaired(row, null) : null;
    }
    const updated = { ...device, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.role === undefined ? {} : { role: patch.role }) };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    if (updated.role !== device.role) {
      const listeners = this.revocations.get(id);
      this.revocations.delete(id);
      for (const close of listeners ?? []) close();
    }
    return { id: updated.id, label: updated.label, role: updated.role, created_at: updated.created_at, last_seen_at: updated.last_seen_at, current: false, ...(updated.relay_public_key === undefined ? {} : { via_relay: true as const }) };
  }

  /** Hears of every device that lost its access, after the write that took it (DeviceRemovedEvent). */
  onRemoved(listener: (event: DeviceRemovedEvent, key: string | undefined) => void): () => void {
    this.removals.add(listener);
    return () => { this.removals.delete(listener); };
  }

  private announceRemoval(device: StoredDevice, by: DeviceRemovedEvent["by"]): void {
    const event: DeviceRemovedEvent = { type: "device-removed", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, removed_at: new Date().toISOString(), ...(by === undefined ? {} : { by }) };
    if (this.safety === null) { for (const listener of [...this.removals]) listener(event, device.relay_public_key); return; }
    for (const listener of [...this.removals]) {
      try { listener(event, device.relay_public_key); } catch (error) { console.warn(`[devices] a removal listener failed: ${describe(error)}`); }
    }
  }

  /**
   * An admission's journal entry, on disk before its row (G14): a journal that cannot be written throws, and nobody
   * is admitted. Then every listener hears it, each on its own.
   */
  private journalAdmission(device: StoredDevice, joined?: AccountRow, notice?: JournalEntry, by?: string): JournalEntry | null {
    if (this.journal === null) return null;
    const recovered = device.origin?.from === "recover";
    const promotion = joined !== undefined;
    const entry = this.journal.append({ kind: promotion ? "promote" : "admit", ...(promotion ? { awaitingListCheck: true } : {}),
      how: recovered ? "recover" : device.origin?.how ?? "code", key: device.relay_public_key ?? null, no: device.origin?.admit_no ?? null, row: device.id, label: device.label, by: recovered ? by ?? null : promotion ? device.origin?.by ?? null : device.added_by ?? null, account: device.account ?? notice?.account ?? null });
    // the row's last journal entry is this admission from here on, not the removal that open read (journalEnded)
    this.journalEndedRows?.delete(device.id);
    return entry;
  }

  /** A removal's journal entry, after its deny (P8 step 4). A journal that cannot be written stops no removal. */
  private journalRemoval(device: StoredDevice, by: DeviceRemovedEvent["by"], why?: string, user?: string): void {
    if (this.journal === null) return;
    // the journal is first (P24): an entry that cannot be written throws, and the caller writes nothing after it
    this.publish(this.journal.append({ kind: "remove", how: why ?? (typeof by === "object" ? "member" : "pc"), key: device.relay_public_key ?? null, no: device.origin?.admit_no ?? null, row: device.id, label: device.label, by: user ?? (typeof by === "object" ? by.device_id : null), account: device.account ?? null }, device.held ?? device.carried_notice));
  }

  publish(entry: JournalEntry): void {
    for (const listener of [...this.noticeListeners]) {
      try { listener(entry); } catch (error) { console.warn(`[devices] a notice listener failed: ${describe(error)}`); }
    }
  }

  /** Hears every journal entry once it is on disk, to send it to the rows connected now (P10). */
  onNotice(listener: (entry: JournalEntry) => void): () => void {
    this.noticeListeners.add(listener);
    return () => { this.noticeListeners.delete(listener); };
  }

  /**
   * Whether the row `id` is told of `entry`: entries about rows that joined this PC after it (T57); a row with no age hears
   * none, and a row never hears of its own key's admission (a listed row and the row its approval made are one device).
   */
  private tells(id: string, entry: JournalEntry): boolean {
    const row = this.anyRow(id);
    if (row?.origin === undefined || entry.row === id || (entry.key !== null && entry.key === row.relay_public_key)) return false;
    if (row.origin.from === "legacy") return true;
    return entry.no !== null && row.origin.admit_no < entry.no;
  }

  /** The notice of `entry` for the row `id`, or null when that row is not told of it. */
  noticeFor(id: string, entry: JournalEntry): DeviceNotice | null {
    return this.journal !== null && this.tells(id, entry) ? this.journal.notice(entry) : null;
  }

  /** What the row `id` is told at its connect, before anything else on its stream (T57); null with no journal. */
  noticeReplay(id: string): NoticeReplay | null {
    return this.journal === null || !this.has(id) ? null : this.journal.replay(id, (entry) => this.tells(id, entry));
  }

  /** The row `id` saw up to `seq`: it decides nothing (T57). */
  noticeSeen(id: string, seq: number): void {
    if (this.journal !== null && this.has(id)) this.journal.ack(id, seq);
  }

  openNotices(): readonly JournalEntry[] { return this.journal?.openNotices() ?? []; }

  /** Reconcile only against known registries, after a write or on recovery. A transfer may keep the original notice. */
  settleListNotices(rows: readonly AccountRow[], members = this.devices): void {
    try {
      if (this.error !== null || this.journal?.strict !== null) return;
      this.journal.settleList(n => {
        const member = members.find(m => m.relay_public_key === n.key);
        if (member) return member.held === n.id || member.carried_notice === n.id;
        return rows.some(r => r.id === n.row && r.key === n.key && (r.state === "hold" || r.state === "live")
          && (r.origin.admit_no === n.no || r.no === n.no));
      });
    } finally { this.listedChanged(); }
  }

  mayAnswerNotice(caller: string | undefined, id: string): boolean {
    const notice = this.openNotices().find(n => n.id === id);
    const row = caller && this.anyRow(caller);
    return !!row && !!notice?.account && notice.account === row.account && notice.row !== caller && row.relay_public_key !== notice.key;
  }

  /** A journal entry of this PC's own, on disk before the change it records; nothing with the release flag off (P15). */
  journalEvent(input: JournalInput): void {
    if (this.journal === null) return;
    this.publish(this.journal.append(input));
  }

  /** An admission notice was decided ("Not me" applied, T51): it leaves `open`. */
  decideNotice(id: string, replay = false): void {
    if (replay) {
      const notice = this.openNotices().find(entry => entry.id === id);
      if (!notice?.key || this.failsClosed || this.rowsOfKey(notice.key).length > 0) return;
    }
    this.journal?.decide(id);
  }

  /** The nodes the owner's tailnet requests are checked against (tailnet-nodes.ts); none on a store that has none. */
  attachTailnetNodes(nodes: TailnetNodes): void {
    this.tailnet = nodes;
    // the nodes a durable denial names stay out across a restart, whether or not their own block landed
    if (this.evidence !== null && this.evidence.strict === null) nodes.takeDenials(this.evidence.tailnetDenials());
  }
  private tailnet: TailnetNodes | null = null;

  /** A row's credential arrived from the tailnet node `nodeId`: kept on the row, at its first use and each change. */
  noteTailnetNode(rowId: string, nodeId: string): void {
    const device = this.devices.find((d) => d.id === rowId);
    if (this.error !== null || device === undefined || device.tailnet_nodes?.includes(nodeId)) return;
    // every node is kept, none trimmed: each is one its removal must keep out (a phone's node changes only when set up again)
    const updated = { ...device, tailnet_nodes: [...device.tailnet_nodes ?? [], nodeId] };
    const next = this.devices.map((d) => d === device ? updated : d);
    try {
      this.save(next);
      this.devices = next;
    } catch (error) { console.warn(`[devices] the tailnet node of ${rowId} was not saved: ${describe(error)}`); }
  }

  tailnetRowsOf(nodeId: string): string[] {
    return this.devices.filter((d) => d.tailnet_nodes?.includes(nodeId)).map((d) => d.id);
  }

  /**
   * Blocks tailnet nodes, each journalled first (P24): an entry or a block that cannot be written throws, and the
   * removal it belongs to does not happen. `row`: the row whose removal blocks them, for the journal.
   */
  keepOutTailnetNodes(nodes: readonly { readonly id: string; readonly hostname?: string }[], row: string | null = null): string[] {
    const tailnet = this.tailnet;
    if (tailnet === null) return [];
    // only a saved block lets the removal go on: the fail-closed state after a failed write ends with this run
    const fresh = nodes.filter((node) => !tailnet.holds(node.id));
    if (nodes.length === 0) return [];
    try {
      // the nodes already blocked are blocked again with this removal's time (TailnetNodes.block); only new ones are journalled
      for (const node of fresh) this.journalEvent({ kind: "tailnet", how: "block", key: null, no: null, row, label: `${node.hostname ?? tailnet.hostnameOf(node.id)} · ${node.id}`, by: null, account: null });
      return tailnet.block(nodes);
    } catch (error) {
      // a block that did not land keeps every node out for this run: the removal it belongs to may already stand
      tailnet.failClosed(`A Tailscale device could not be kept out (${describe(error)}): no Tailscale login is let in until this PC restarts.`);
      throw error;
    }
  }

  /** Allow on this PC's own window: the node is let in by its login again, journalled first. */
  allowTailnetNode(id: string): void {
    const tailnet = this.tailnet;
    if (tailnet === null) throw new Error("This PC keeps no Tailscale devices out.");
    this.journalEvent({ kind: "tailnet", how: "allow", key: null, no: null, row: null, label: `${tailnet.hostnameOf(id)} · ${id}`, by: null, account: null });
    tailnet.allow(id);
  }

  private keepOutNodesOf(rows: readonly StoredDevice[]): void {
    this.keepOutTailnetNodes(tailnetNodesOf(rows).map((id) => ({ id })), rows[0]?.id ?? null);
  }

  /**
   * An account record's drop (a block, Not me included, or a member's remove) keeps the dropped rows' nodes out with it.
   * Its deny already carries those nodes (removal evidence, `tailnet_nodes`), so a node block that fails here leaves the
   * list closed for this run, and the next start blocks them from the deny (attachTailnetNodes).
   */
  private keepOutNodesOfRecordDrop(rows: readonly StoredDevice[]): void {
    try { this.keepOutNodesOf(rows); }
    catch (error) { console.error(`[devices] the Tailscale devices of a dropped row could not be kept out: ${describe(error)}`); }
  }

  revoke(id: string, by: DeviceRemovedEvent["by"] = "pc"): boolean {
    this.assertWritable();
    this.resumeRevokeAll();
    const target = this.anyRow(id);
    if (!target) return false;
    // the nodes its credential came from are kept out before the row goes: a block not written removes nothing
    this.keepOutNodesOf(this.devices.filter((d) => d.id === id || (target.relay_public_key !== undefined && d.relay_public_key === target.relay_public_key)));
    if (this.evidence !== null) {
      const key = target.relay_public_key;
      const rows = this.devices.filter((d) => d === target || (key !== undefined && d.relay_public_key === key));
      const denied = this.deny(key === undefined ? [] : [key], () => this.tombstone([target], Date.now()));
      if (key !== undefined) this.dropWaiting([key]);
      const joined = key === undefined ? [] : this.joinedRows?.rowsByKey(key) ?? [];
      if (denied !== null) {
        this.keepOut(rows);
        for (const row of joined) this.closeAccountSessions(row.id);
        throw denied;
      }
      this.dropBeforeWrite(rows, by, undefined, { ids: joined.map(row => row.id), reason: "revoke" }, undefined, { key });
      return true;
    }
    // a revoke on this PC wins over the account: its key cannot come back by a record (docs/account.md, rule 1)
    this.tombstone([target], Date.now());
    // the key's other rows that tombstone takes go with it now, as the next start would take them (finishInterruptedWrites)
    const key = target.relay_public_key;
    this.drop(this.devices.filter((d) => d === target || (key !== undefined && d.relay_public_key === key && this.stale(d))), by);
    return true;
  }

  /**
   * `ovis recover --remove` (T70, T73): a removal at this PC of a row, by its id, or of a key, with or without a row
   * here. Its Revoke stands and is journalled before the rows go; the blocks that key signed here are lifted by the
   * PC (liftOrphanedBlocks). `user` is the OS user who ran it, on each journal line (P24). Only with the release flag on,
   * and refused while this PC's account state is unreadable.
   */
  removeKey(input: { target: string; by: "local"; user?: string }): { removed: string[] } | { refused: "log_unreadable" | "unknown" } {
    if (this.evidence === null || this.failsClosed) return { refused: "log_unreadable" };
    const named = this.devices.find((d) => d.id === input.target);
    const key = named !== undefined ? named.relay_public_key : isRelayPublicKey(input.target) ? input.target : undefined;
    if (named === undefined && key === undefined) return { refused: "unknown" };
    const gone = this.devices.filter((d) => d === named || (key !== undefined && d.relay_public_key === key));
    this.keepOutNodesOf(gone);
    const now = Date.now();
    const evidence = this.evidence;
    const denied = this.deny(key === undefined ? [] : [key], () => {
      if (gone.length > 0) this.tombstone(gone, now);
      else { evidence.addRevoke(key!, null, now); this.refreshTombstones(); this.dropWaiting([key!], "revoke"); }
    });
    // a deny not on disk writes nothing else: the rows stay out by row for this run and the PC closed (P8)
    if (denied !== null) { this.keepOut(gone); throw denied; }
    // a removal of a signer here, by its own key: the blocks it signed go with it (P23 way 3, T73)
    if (gone.length > 0) this.dropBeforeWrite(gone, "pc", "recover", undefined, input.user, { key });
    else {
      try { this.journalEvent({ kind: "remove", how: "recover", key: key!, no: null, row: null, label: "", by: input.user ?? null, account: null }); } catch (error) {
        this.denyProblem = `A removal could not be journalled (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until one is.`;
        throw error;
      }
      this.liftOrphanedBlocks(key!);
    }
    return { removed: gone.map((d) => d.id) };
  }

  /** The rows `gone` lose their access in one write; their sessions close and each removal is announced. */
  private drop(gone: readonly StoredDevice[], by: DeviceRemovedEvent["by"], why?: string, user?: string): void {
    if (this.evidence !== null) { this.dropBeforeWrite(gone, by, why, undefined, user); return; }
    const next = this.devices.filter((d) => !gone.includes(d));
    // A valid older/manual registry can have devices without a gate timestamp. Removing its
    // last device must still leave durable evidence that this store was once gated.
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    // A code the device started or was handed goes with it. Whoever it passed the code to would otherwise pair after
    // it was removed, on a PC in no account with nobody approving (a member's code already needs its member)
    if (gone.some((d) => this.pending?.holders.has(d.id))) this.endPairing(undefined, "revoked");
    for (const device of gone) {
      const listeners = this.revocations.get(device.id);
      this.revocations.delete(device.id);
      for (const close of listeners ?? []) close();
    }
    for (const device of gone) this.announceRemoval(device, by);
  }

  /**
   * Told on every revokeAll, after the empty registry is saved: a relay pairing by comparing digits
   * that is still under way (server/relay/session.ts) ends there, approved or not, so no device is
   * made from a comparison the owner's "revoke all" came after.
   */
  onRevokeAll(listener: () => void): () => void {
    this.revokeAllListeners.add(listener);
    return () => { this.revokeAllListeners.delete(listener); };
  }

  /**
   * Every paired device loses its access in one durable write, the caller's own included; the
   * ids it returns are for the cleanup that follows (push subscriptions, page media). The write
   * comes first and alone: until it succeeds nothing changes, and if it throws, the registry,
   * every credential and every listener stay as they were. After it, the pending code and every
   * unconfirmed first-pair credential are void as well, and every revoked device's streams close.
   * The gate stays closed, with a timestamp even when nothing was ever confirmed (only first-pair
   * candidates existed): revoking must never reopen the LAN, not even after a restart.
   */
  revokeAll(user?: string): string[] {
    this.assertWritable();
    // every tailnet node seen so far, and every one a row's credential came from, stays out with them
    const nodes = new Set([...this.tailnet?.seenIds() ?? [], ...this.devices.flatMap((d) => d.tailnet_nodes ?? [])]);
    this.keepOutTailnetNodes([...nodes].map((id) => ({ id })));
    if (this.revokeAllIntent !== null) return this.revokeAllInOrder(this.revokeAllIntent, user);
    this.endAccountRows("revoke_all");
    this.tombstone(this.devices, Date.now());
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.save([], gate);
    const gone = this.devices;
    const revoked = this.devices.map((device) => device.id);
    this.devices = [];
    this.gateClosedAt = gate;
    this.voidPending("revoked");
    this.unconfirmedFirstPairs = [];
    // the PC leaves its account with every row (P8, P12); one that could not be written keeps the PC bound, never less
    let unbound: unknown = null;
    try { this.clearAccountBinding("revoke_all", "pc"); }
    catch (error) {
      // the PC fails closed until its account state is written: Revoke all is not reported done (S19)
      unbound = error;
      this.pc?.unwritten(error);
      console.error(`[devices] Revoke all could not clear this PC's account: ${error instanceof Error ? error.message : String(error)}`);
    }
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    for (const listener of [...this.revokeAllListeners]) listener();
    for (const device of gone) this.announceRemoval(device, "pc");
    if (unbound !== null) throw unbound;
    return revoked;
  }

  has(id: string): boolean { return this.devices.some((device) => device.id === id) || (this.joinedRows?.row(id) ?? null) !== null; }

  /** When the row `id` was added here (an account row: when it was confirmed), or undefined for none. */
  addedAt(id: string): string | undefined { return this.anyRow(id)?.created_at; }

  /** Whether the device may answer a pane's prompt: paired to drive, not to watch. */
  canDrive(id: string): boolean {
    if (!this.opensAll()) return this.devices.some(row => row.id === id && row.role === "drive" && !Object.hasOwn(row, "held"));
    return this.sessionRow(id)?.role === "drive";
  }

  /** Holding a pairing code requires an ordinary paired member, not just a drive session. */
  canHoldCode(id: string): boolean { return (!this.opensAll() || this.accountError === null) && this.devices.some(device => device.id === id) && this.canDrive(id); }

  private pruneUnconfirmedFirstPairs(now: number): void {
    this.unconfirmedFirstPairs = this.unconfirmedFirstPairs.filter(({ expires }) => now <= expires);
  }

  /**
   * P8 step 1, the deny on disk with `gen` raised. One that cannot be written still lets the caller close what it
   * removes, and makes this PC fail closed until a later deny is written; returned, never acknowledged.
   */
  private deny(keys: readonly string[], write: () => void, { genFirst = false } = {}): Error | null {
    try {
      if (genFirst) this.pc?.raiseGen();
      write();
      if (!genFirst) this.pc?.raiseGen();
      if (this.evidence?.onDisk === true) this.pc?.noteEvidenceWritten();
      // only the deny of the very key that failed ends its closing, and never while a Revoke all is unfinished on disk
      for (const key of keys) this.failedDenies.delete(key);
      this.settleDenies();
      return null;
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      for (const key of keys) this.failedDenies.add(key);
      this.denyProblem = `A removal could not be written (${failed.message}): only this PC itself gets in until one is.`;
      return failed;
    }
  }

  /** Keys whose deny could not be written this run: their rows stay on disk, out of every session here (P8). */
  private readonly failedDenies = new Set<string>();

  /** Rows, keyed or not (cookie rows), whose removal was not written this run: out until their own removal lands (P8). */
  private readonly failedRows = new Set<string>();

  /** The PC opens again only when no failed key, no failed row and no unfinished Revoke all is left (P8, S19). */
  private settleDenies(): void {
    if (this.failedDenies.size === 0 && this.failedRows.size === 0 && !existsSync(this.revokeAllPath)) this.denyProblem = null;
  }

  /**
   * A deny that did not land: its rows' sessions end and the rows are out for this run; nothing is written (P8). An
   * account removal's rows are kept out by their key (failedDenies) alone, since which rows it covers is not known.
   */
  private keepOut(rows: readonly StoredDevice[], byRow = true): void {
    if (this.failsClosed) this.recheckListedSessions();
    for (const device of rows) {
      if (byRow) this.failedRows.add(device.id);
      const listeners = this.revocations.get(device.id);
      this.revocations.delete(device.id);
      for (const close of listeners ?? []) close();
    }
  }

  /**
   * P8 steps 2 to 5 for rows the deny already covers: the gate in memory, the rows out of memory, their sessions and
   * codes ended, each removal told; then the registry write, whose failure is thrown only after all of that.
   */
  private dropBeforeWrite(gone: readonly StoredDevice[], by: DeviceRemovedEvent["by"], why?: string, joined?: { ids: string[]; reason: "remove" | "revoke" }, user?: string, removedSigner?: { key: string | undefined; account?: string }): void {
    if (gone.length === 0 && !joined?.ids.length) return;
    const next = this.devices.filter((d) => !gone.includes(d));
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.devices = next;
    this.gateClosedAt = gate;
    if (gone.some((d) => this.pending?.holders.has(d.id))) this.endPairing(undefined, "revoked");
    for (const device of gone) this.closeAccountSessions(device.id);
    if (joined?.ids.length) {
      this.joinedRows?.removeRows(joined.ids, joined.reason, id => this.closeAccountSessions(id));
    }
    try { for (const device of gone) this.journalRemoval(device, by, why, user); } catch (error) {
      // a removal its journal does not hold writes nothing more: its rows stay out by row and the PC closed (P24, P8)
      for (const device of gone) this.failedRows.add(device.id);
      this.denyProblem = `A removal could not be journalled (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until one is.`;
      throw error;
    }
    if (removedSigner !== undefined) this.liftOrphanedBlocks(removedSigner.key, removedSigner.account);
    // the registry write is these rows' own deny when they hold no key (cookie rows): one that fails keeps them out for
    // this run and the PC closed until a write lands (P8, S19); a removal is told once the write is tried (P8 step 5)
    try { this.save(next, gate); } catch (error) {
      for (const device of gone) this.failedRows.add(device.id);
      this.denyProblem = `A removal could not be written (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until one is.`;
      throw error;
    }
    // the removal is on disk: those rows' own failures end, and only now is it told (P8 step 5)
    for (const device of gone) this.failedRows.delete(device.id);
    this.settleDenies();
    for (const device of gone) this.announceRemoval(device, by);
  }

  /**
   * Revoke all in P8's order: `revoke-all.json` first, then the gate, the codes, the candidates and every row out of
   * memory with its sessions, then the evidence, the empty registry and the PC's account. A write that fails is thrown
   * after the closing; the file stays, and the next start finishes the work before serving (T20). `user`: the OS user
   * of `ovis recover --revoke-all`, journalled beside each removal (P24).
   */
  private revokeAllInOrder(intent: RevokeAllIntent, user?: string): string[] {
    const unavailable = this.waitingForListedRestore || this.joinedRows?.blocked() || this.joinedRows?.missing();
    if (intent.remainingListedOnly && unavailable && !this.devices.length) return [];
    if (!unavailable) this.resumeRevokeAll();
    const now = this.nextStamp(Date.now());
    // the file names every row it covers, a pending one's too, so it is finished from itself and never from less (T20)
    const gone = this.revokeAllRows();
    const gateWasOpen = !this.rawGated;
    // a registry that will not read, or is missing on a PC in an account, may hold listed rows: count it as some, so
    // the intent outlives it. A PC never bound has none
    const unknown = this.waitingForListedRestore || this.joinedRows?.blocked() || (this.joinedRows?.missing() && (this.pc?.binding() || intent.listed > 0));
    const listed = unknown ? 1 : this.joinedRows?.rows().length ?? 0;
    const denied = this.deny(gone.flatMap((row) => row.relay_public_key ?? []), () => intent.begin(gone, now, listed, unknown ? this.pc?.nextAdmission() ?? null : null));
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? now;
    // a file that could not be written holds nothing: the rows stay where the next Revoke all finds them, out of every
    // session meanwhile, and the PC closed (P8, T20)
    if (denied !== null) {
      this.keepOut(gone);
      this.gateClosedAt = gate;
      this.voidPending("revoked");
      this.unconfirmedFirstPairs = [];
      if (gateWasOpen) this.tellGateClosed();
      throw denied;
    }
    this.devices = [];
    this.gateClosedAt = gate;
    this.voidPending("revoked");
    this.unconfirmedFirstPairs = [];
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    for (const listener of [...this.revokeAllListeners]) listener();
    // a gate that was open closes here, whatever the writes below do: what the open LAN let in ends (T3)
    if (gateWasOpen) this.tellGateClosed();
    // its intent is on disk: the journal first, then the removals told, then the writes; any that fails leaves the PC
    // closed until a start finishes it (P8, P24, T20)
    try {
      for (const device of gone) this.journalRemoval(device, "pc", user === undefined ? undefined : "recover", user);
      for (const device of gone) this.announceRemoval(device, "pc");
      if (unknown) {
        this.waitingForListedRestore = true;
        this.tombstone(gone, Date.parse(now), "revoke_all");
        this.save([], gate);
        this.pc?.clear("revoke_all", "pc");
        intent.awaitListed();
        return gone.map(row => row.id);
      }
      intent.finish(rows => this.completeRevokeAll(intent, rows, gate));
      this.refreshAfterRevokeAll();
    } catch (error) {
      this.denyProblem = `Revoke all could not be finished (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is.`;
      throw error;
    }
    return gone.map((device) => device.id);
  }

  private resumeRevokeAll(): void {
    const intent = this.revokeAllIntent;
    if (intent?.finish(rows => {
      this.pc?.raiseGen();
      this.completeRevokeAll(intent, rows, this.gateClosedAt ?? new Date().toISOString());
    })) this.refreshAfterRevokeAll();
  }

  /**
   * The one finisher of a Revoke all, new or resumed: only while the listed registry can show every row the intent
   * covers. One that will not read, or is gone while the intent covered listed rows, keeps the intent (S19, T41).
   */
  private completeRevokeAll(intent: RevokeAllIntent, rows: readonly StoredDevice[], gate: string): void {
    this.assertWritable();
    const blocked = this.joinedRows?.blocked();
    if (blocked) throw new Error(blocked);
    if (this.waitingForListedRestore || (intent.listed > 0 && this.joinedRows?.missing())) {
      this.waitingForListedRestore = true;
      throw new Error("account-devices.json is missing while Revoke all covers listed rows: only this PC itself gets in until it is restored.");
    }
    if (this.evidence) this.joinedRows?.pruneDenied(this.evidence, "revoke_all");
    const joined = this.joinedRows?.rows().filter(row => intent.covers(row.origin.admit_no)) ?? [];
    this.tombstone([...rows, ...joined.map((row) => this.joinedAsStored(row))], Date.now(), "revoke_all");
    if (joined.length) this.joinedRows?.removeRows(joined.map(row => row.id), "revoke_all", id => this.closeAccountSessions(id));
    if (intent.remainingListedOnly) return;
    this.save([], gate);
    this.devices = [];
    this.gateClosedAt = gate;
    // the file goes only once the PC has left its account: a binding that cannot be read keeps it (P12)
    if (this.pc?.strict != null) throw new Error(this.pc.strict);
    try { this.clearAccountBinding("revoke_all", "pc"); } catch (error) {
      this.pc?.unwritten(error, "Revoke all could not clear this PC's account");
      throw error;
    }
    // every row and key it covered is revoked on disk now: their earlier failures end
    for (const row of rows) {
      this.failedRows.delete(row.id);
      if (row.relay_public_key !== undefined) this.failedDenies.delete(row.relay_public_key);
    }
  }

  /** Only after the intent is unlinked can a successful retry clear its prior failure and publish the tombstones. */
  private refreshAfterRevokeAll(): void {
    this.settleDenies();
    if (this.evidence?.strict === null && this.accountError === null) this.refreshTombstones();
  }

  /** The rows a Revoke all covers: those its pending file names, and every row this store holds now (T20). */
  private revokeAllRows(): StoredDevice[] {
    let named: StoredDevice[] = [];
    try {
      const doc = JSON.parse(readFileSync(this.revokeAllPath, "utf8")) as { rows?: unknown };
      if (Array.isArray(doc.rows)) named = doc.rows.filter((row): row is StoredDevice => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string");
    } catch { /* no pending file, or one that names no rows: the rows held now */ }
    return [...named.filter((row) => !this.devices.some((d) => d.id === row.id)), ...this.devices];
  }

  private save(devices = this.devices, gateClosedAt = this.gateClosedAt): void {
    const closes = !this.rawGated && (gateClosedAt !== null || devices.length > 0);
    writePrivateState(this.path, { gate_closed_at: gateClosedAt, devices });
    if (this.joinedRows && !this.joinedRows.blocked() && !this.joinedRows.missing()) this.settleListNotices(this.joinedRows.rows(), devices);
    // The write that closes the gate: onGateClosed. Told once the caller has set the store's own fields, which each
    // does right after this returns, and before anything else of this process runs (no frame of a connection is
    // read in between). Each on its own: one that throws ends neither the others nor the pairing that closed the gate.
    if (closes) this.tellGateClosed();
  }

  private tellGateClosed(): void {
    queueMicrotask(() => {
      for (const listener of [...this.gateListeners]) {
        try { listener(); } catch (error) { console.warn(`[devices] ending what the open LAN let in failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }

  /** The drive member of `account` whose key is `key`, the only signer whose `add` or `remove` applies. */
  /** The member of `account` holding `key`: a drive one, unless `anyRole` (a device signing its own leave). */
  accountSigner(key: string, account: string, anyRole = false): DeviceMatch | null {
    const device = this.devices.find((d) => d.relay_public_key === key && d.account === account && (anyRole || d.role === "drive") && !this.stale(d) && this.canSpeak(d.id, anyRole));
    if (device) return { id: device.id, label: device.label, role: device.role };
    // an account-joined key signs its own leave, held or not (P5, S25); it signs nothing else here
    const joined = anyRole && account === this.account() ? this.joinedRows?.rowsByKey(key)[0] : undefined;
    return joined && this.canSpeak(joined.id, true) && !this.accountRowStale(joined) ? { id: joined.id, label: joined.label, role: this.joinedRole(joined) } : null;
  }

  accountRows(): { members: number; unlinked: string[]; own_word: string[] } {
    const groups = this.accountGroups();
    return {
      members: this.devices.filter((d) => d.account !== undefined).length,
      unlinked: groups.unlinked.map((d) => d.id), own_word: groups.own_word.map((d) => d.id),
    };
  }

  /**
   * The rows the owner is shown apart (/api/account/status, the owner's /api/health, `ovis status`): relay rows in no
   * account, and members whose link was on their own word (`joined_by`). A row is in one of them at most.
   */
  accountGroups(): { unlinked: { id: string; label: string }[]; own_word: { id: string; label: string }[] } {
    const shown = (d: StoredDevice) => ({ id: d.id, label: d.label });
    return {
      unlinked: this.devices.filter((d) => d.account === undefined && d.relay_public_key !== undefined).map(shown),
      own_word: this.devices.filter((d) => d.account !== undefined && d.joined_by !== undefined && !VOUCHED.has(d.joined_by)).map(shown),
    };
  }

  isTombstoned(key: string): boolean { return this.tombstones.some((t) => t.key === key); }

  /** Whether an account's removal keeps `key` out (the tombstone of a `remove`), not only a revoke made on this PC. */
  removedByAccount(key: string): boolean { return this.tombstones.some((t) => t.key === key && t.record_id !== "local"); }

  /** Every key this PC keeps out, signed removal or not (a Revoke here, a record that no longer parses): /api/account/status `blocked`. */
  tombstoneKeys(): string[] { return [...new Set(this.tombstones.map((t) => t.key))]; }

  /** Every key this PC holds a removal of its own against (holdsRemoval) that it can name: what it tells a device of its account. */
  removalKeys(): string[] {
    const keys = [...this.tombstoneKeys(), ...this.evidence?.tombstones().map((tombstone) => tombstone.key) ?? [], ...this.safety?.inForce.blocks.flatMap(({ record }) => (record.target === null ? [] : [record.target])) ?? []];
    return [...new Set(keys)].sort();
  }

  /**
   * Whether the session of row `id`, signed in with `sessionKey`, is one of a device of this PC's account: a row the
   * account let in, or a pairing of the account's member. Its own row, as it stands now.
   */
  accountSession(id: string, sessionKey: string): boolean {
    const account = this.account();
    if (account === null || sessionKey === "") return false;
    const joined = this.joinedRows?.row(id) ?? null;
    if (joined !== null) return joined.key === sessionKey && joined.state !== "expired";
    const device = this.devices.find((candidate) => candidate.id === id);
    return device !== undefined && device.account === account && device.relay_public_key === sessionKey && !this.stale(device);
  }

  /**
   * Whether this PC holds a removal of its own against `key`: a person's Revoke here, a signed removal or block it
   * applied, or a removal a member handed it with an enrollment. Nothing the account service says unsigned is one.
   */
  holdsRemoval(key: string): boolean {
    const account = this.account() ?? undefined;
    return this.isTombstoned(key) || (this.evidence?.standingRevokes(key).length ?? 0) > 0 || this.accountHeld?.(key) === true
      || this.coveredByEvidence({ relay_public_key: key, account }) || (this.safety?.inForce.blocks.some(({ record }) => record.target === key) ?? false);
  }

  /** The signed `add`s behind this PC's account rows, as received: what /api/account/status lists. One that no longer parses or names another key is left out. */
  accountAdds(): AddRecord[] {
    const account = this.account();
    return this.devices.flatMap((d) => {
      if (account === null || d.account_add === undefined || this.stale(d)) return [];
      try {
        const record = parseAccountRecord(d.account_add);
        return record.kind === "add" && record.key === d.relay_public_key && record.account === account ? [record] : [];
      } catch (error) {
        if (error instanceof AccountRecordError) return [];
        throw error;
      }
    });
  }

  /**
   * Keeps `record` on the row it is for when that row's approver signed it and none is kept yet: the
   * approver of a remote approval hands its add to this PC too (an `unchanged` add), so the PC can
   * list it for a client to pass on.
   */
  keepAccountAdd(record: AddRecord, signerId: string): void {
    const device = this.devices.find((d) => d.relay_public_key === record.key && d.added_by === signerId && (d.account_add === undefined || (d.account_add as { key?: unknown }).key !== d.relay_public_key) && !this.stale(d));
    if (!device) return;
    const next = this.devices.map((d) => d === device ? { ...d, account_add: record } : d);
    this.save(next);
    this.devices = next;
  }

  /** The signed `remove`s behind this PC's tombstones for its account, as received: what /api/account/status lists. One that no longer parses is left out. */
  accountRemovals(): RemoveRecord[] {
    const account = this.account();
    return this.tombstones.flatMap((t) => t.account !== account ? [] : (t.records ?? []).flatMap((value) => {
      try {
        const record = parseAccountRecord(value);
        return record.kind === "remove" && record.key === t.key && record.account === t.account ? [record] : [];
      } catch (error) {
        if (error instanceof AccountRecordError) return [];
        throw error;
      }
    }));
  }

  hasKey(key: string): boolean { return this.devices.some((d) => d.relay_public_key === key && !this.stale(d)); }

  acceptsRelayKey(key: string): boolean { return isRelayPublicKey(key); }

  wasAddedByMember(key: string): boolean { return this.devices.some((d) => d.relay_public_key === key && d.added_by !== undefined && !this.stale(d)); }

  keyHeldByOther(key: string, id: string): boolean { return this.devices.some((d) => d.relay_public_key === key && d.id !== id); }

  relayKeyOf(id: string): string | undefined { return this.devices.find((d) => d.id === id)?.relay_public_key; }

  /** Only the list row for this very key may transfer its ID to a member. */
  canAddAt(id: string, key: string): boolean {
    const joined = this.joinedRows?.row(id);
    return !this.devices.some((row) => row.id === id) && (!joined || joined.key === key);
  }

  private listNotice(row: AccountRow): JournalEntry | undefined {
    return this.journal?.openNotices().find((notice) => notice.row === row.id && notice.key === row.key && notice.no === row.origin.admit_no);
  }

  private carriesJoinHold(device: StoredDevice, joined: AccountRow, now: number, signer: Sayer | null): boolean {
    if (joined.state !== "hold" || (device.origin?.from === "pc" && ["code", "digits", "qr", "confirmed"].includes(device.origin.how))) return false;
    if (joined.hold_until !== null && Date.parse(joined.hold_until) <= now) return false;
    return !signer || !mayEndHold(signer, { key: joined.key, no: joined.no, admitNo: joined.origin.admit_no }, now);
  }

  /** An `add` that verified: a new member row, announced like any other enrollment. Never for a tombstoned key. */
  addAccountDevice(entry: { id: string; key: string; label: string; role: DeviceRole; account: string; addedBy: string; record?: AddRecord }, now = Date.now()): DeviceMatch {
    this.assertAccountWritable();
    if (this.isTombstoned(entry.key)) throw new Error("tombstoned key");
    // an id another row holds would merge two devices' authority; a derived id collides only for the same key
    if (!this.canAddAt(entry.id, entry.key)) throw new Error("device id in use");
    const device: StoredDevice = {
      id: entry.id, label: normalizeLabel(entry.label, "Device"), role: entry.role,
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: entry.key,
      created_at: new Date(now).toISOString(), last_seen_at: null, account: entry.account, added_by: entry.addedBy,
      ...(entry.record === undefined ? {} : { account_add: entry.record }),
    };
    if (!this.enrollApproved(device, entry.record?.signer, now)) throw new AdmissionRefusedError();
    // another key joined the account: the PC has had other devices, for good (T67, H2)
    if (this.pc !== null && this.pc.first()?.key !== entry.key) this.pc.setOthersEver();
    return { id: device.id, label: device.label, role: device.role };
  }

  /** Signed add and member digits have different membership metadata, but transfer the same listing and hold. */
  private enrollApproved(device: StoredDevice, signerKey: string | undefined, now: number): boolean {
    const listed = device.relay_public_key && this.joinedRows?.rowsByKey(device.relay_public_key).length;
    const approved = listed && this.pc ? { ...device, origin: this.pc.admit("remote", "promoted", signerKey ?? null, now) } : device;
    return this.enroll(approved, now, [], false, undefined, signerKey);
  }

  /**
   * A `remove` that verified: the tombstone is written first, so a crash between the two writes
   * leaves the key refused; then the rows that wait to link with the key go (dropWaiting), and every
   * row holding the key is revoked, closing its sessions.
   */
  removeAccountKey(key: string, account: string, record: { id: string; issuedAt: string; by?: { device_id: string; label: string }; signed?: RemoveRecord }, now = Date.now()): boolean {
    // a deny that failed earlier does not keep a removal from trying again: its landing is what ends the closing (P8)
    if (this.evidence !== null) {
      this.assertWritable();
      const refused = this.safety?.strict ?? this.pc?.strict ?? this.evidence.strict ?? this.accountProblem ?? this.restampProblem ?? this.futureProblem;
      if (refused !== null) throw new Error(refused);
    } else this.assertAccountWritable();
    if (this.evidence !== null) {
      // account-scoped evidence first, whatever rows this PC holds and with no time compared (T16 in 2d); every row
      // it covers goes, row by row, and a Revoke this PC made is never coalesced into it (T22)
      let added = false;
      const denied = this.deny([key], () => {
        const drop = this.account() === account ? rowDrop(this.joinedRows?.rowsByKey(key)[0], "remove") : undefined;
        added = this.evidence!.addRemoval(key, account, { id: record.id, at: new Date(now).toISOString(), drop, ...(record.signed ? { records: [record.signed] } : {}), tailnetNodes: tailnetNodesOf(this.devices.filter((d) => d.relay_public_key === key)) });
        this.refreshTombstones();
      });
      this.dropWaiting([key]);
      // with no deny on disk the evidence cannot say which rows it covers: every row of the key goes for this run
      if (denied !== null) {
        this.keepOut(this.devices.filter((d) => d.relay_public_key === key), false);
        for (const row of this.joinedRows?.rowsByKey(key) ?? []) this.closeAccountSessions(row.id);
        throw denied;
      }
      const gone = this.devices.filter((d) => d.relay_public_key === key && this.coveredByEvidence(d));
      const ids = (this.joinedRows?.rowsByKey(key) ?? []).filter((row) => this.coveredByEvidence(this.joinedAsStored(row))).map((row) => row.id);
      this.keepOutNodesOfRecordDrop(gone);
      this.dropBeforeWrite(gone, record.by, undefined, { ids, reason: "remove" }, undefined, { key, account });
      return added || gone.length > 0 || ids.length > 0;
    }
    // a pairing of this key made on this PC after the removal was signed wins: a replayed or late remove
    // leaves it and its key be, and takes only the key's other rows. Any other row goes, however late the remove
    // arrives (pairedHere).
    const newer = (d: StoredDevice) => d.relay_public_key === key && pairedHere(d) && this.later(d.created_at, record.issuedAt);
    if (this.devices.some(newer)) {
      const gone = this.devices.filter((d) => d.relay_public_key === key && !newer(d));
      // no denial goes to disk before this drop: its nodes' block does, and one that fails drops nothing
      this.keepOutNodesOf(gone);
      if (gone.length) this.drop(gone, record.by);
      return gone.length > 0;
    }
    const recordId = record.id;
    const fresh = !this.isTombstoned(key);
    const removal: AccountTombstone = { key, account, record_id: recordId, removed_at: new Date(now).toISOString(), ...(record.signed ? { records: [record.signed] } : {}) };
    const kept = this.tombstones.find((t) => t.key === key);
    if (fresh) this.writeTombstones([...this.tombstones, removal]);
    // a key this PC revoked first becomes the account's removal, so a code started through the relay cannot bring it back
    else if (kept?.record_id === "local") this.writeTombstones(this.tombstones.map((t) => t.key === key ? removal : t));
    // another signer's removal of a removed key is kept beside the first, for a PC where only that signer is a member (#2956)
    else if (kept && record.signed && kept.account === account) {
      const records = withRecords(kept.records, [record.signed]);
      if ((records?.length ?? 0) !== (kept.records?.length ?? 0)) this.writeTombstones(this.tombstones.map((t) => t === kept ? { ...t, ...(records ? { records } : {}) } : t));
    }
    this.dropWaiting([key]);
    const ids = this.devices.filter((d) => d.relay_public_key === key).map((d) => d.id);
    for (const id of ids) this.revoke(id, record.by);
    return fresh || ids.length > 0;
  }

  /**
   * A `link` the device `deviceId` sent over its own session `sessionId`: its row takes `key` and joins
   * `account` in one write. The row's other sessions signed in with a key it no longer has, so they end
   * (`auth_changed`); the linking one goes on until it signs in again with the new key. A row that waits to link
   * is no device yet: its link makes it one (promote).
   */
  linkAccountKey(deviceId: string, oldKey: string, key: string, account: string, sessionId = "", vouched = false, replacement = false): PairedDevice | null {
    this.assertAccountWritable();
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key === oldKey);
    if (!device) return this.promote(deviceId, { oldKey, key, account }, sessionId, vouched, replacement);
    if (this.pc !== null && device.untrusted_created_at === device.created_at) return null;
    const moved = key !== oldKey || device.link_moved_key === true;
    // the link that takes a row from no account into one is on the device's own word unless a member of that same
    // account approved its pairing: a code started by a device outside the account names its starter in `added_by` and
    // approves nothing, and an approval for another account does not carry over
    const ownWord = device.account === undefined && device.member_approved_in !== account;
    // a key approved on this PC's screen is never replaced by a link alone: the new key waits for a confirm of its own
    // there, and nothing changes until then (P22, T7, T72)
    if (this.pc !== null && key !== oldKey && device.origin?.from === "pc") {
      // only an app that shows the fingerprint it computes itself may ask: to any other, a confirm is a blind yes
      if (!replacement) throw new ReplacementNeedsAppError();
      // the challenge the confirm's fingerprint is made over: this PC's own, new with each link, so none can be chosen
      this.replacements.set(deviceId, { key, account, at: Date.now(), challenge: randomBytes(32).toString("base64url"), sessionId, vouched, ownWord });
      return this.list(null).find((d) => d.id === deviceId) ?? null;
    }
    const linked: StoredDevice = { ...device, relay_public_key: key, account, linked_at: new Date().toISOString(), link_moved_key: moved, ...(ownWord ? { joined_by: vouched ? "service" as const : "word" as const } : {}) };
    // Linking widens membership even if it keeps the key (G3); flag-off links retain the moved-key-only check.
    if ((this.safety !== null || key !== oldKey) && !this.admits(key)) return null;
    // the new key has no age of the key before it, flag on or off, until this PC numbers it (P22)
    const { origin: _oldKeys, ...movedKey } = linked;
    if (this.pc?.account() === account && (device.account !== account || oldKey !== key)) this.pc.setOthersEver();
    if (!this.bindingWith(account, key, () => {
      if (key !== oldKey) {
        const signerKey = device.account === account && this.isAccountApproverSession(deviceId, oldKey) ? oldKey : undefined;
        return this.enroll(movedKey, Date.now(), [], false, { replaces: device }, signerKey);
      } else {
        this.replaceDevice(device, linked);
        this.accountOrder?.recordJoins([linked]);
        return true;
      }
    })) return null;
    this.endNoAccountCode();
    for (const listener of [...this.relinks.get(deviceId) ?? []]) listener(sessionId);
    return this.list(null).find((d) => d.id === deviceId) ?? null;
  }

  /** The key waiting to replace the screen-approved key of row `id` (T72), or null: dropped after five minutes. */
  pendingReplacement(id: string, now = Date.now()): { readonly key: string; readonly account: string; readonly at: number; readonly challenge: string } | null {
    const waiting = this.replacements.get(id);
    if (waiting === undefined) return null;
    if (now - waiting.at > REPLACEMENT_TTL_MS) { this.replacements.delete(id); return null; }
    return { key: waiting.key, account: waiting.account, at: waiting.at, challenge: waiting.challenge };
  }

  /** The replacement of row `id` was declined on this PC's screen: the approved key stays. */
  declineReplacement(id: string): void { this.replacements.delete(id); }

  /**
   * The replacement of row `id` confirmed on this PC's screen (T72): only the very key waiting, within five minutes, and
   * only when G3 admits it in this turn. The row takes the key and its account and keeps `pc`, with how `link` and a
   * new number; the confirm is spent.
   */
  replaceConfirmed(confirm: { row: string; key: string; source: "screen" }, now = Date.now()): DeviceMatch | null {
    const waiting = this.pendingReplacement(confirm.row, now);
    if (waiting === null || waiting.key !== confirm.key || this.pc === null) return null;
    const { sessionId, vouched, ownWord, waitingRow } = this.replacements.get(confirm.row)!;
    this.replacements.delete(confirm.row);
    const proof: ConfirmProof = { codeId: `replace:${confirm.row}`, key: confirm.key, source: confirm.source };
    MINTED_PROOFS.add(Object.freeze(proof));
    // a row waiting to link joins now, with the confirmed key: its link, held until this confirm (T72)
    if (waitingRow === true) {
      const row = this.provisional(confirm.row);
      if (row === undefined) return null;
      const joined = this.promote(confirm.row, { oldKey: row.key, key: confirm.key, account: waiting.account }, sessionId, vouched, false, proof);
      return joined === null ? null : { id: joined.id, label: joined.label, role: joined.role };
    }
    const device = this.devices.find((d) => d.id === confirm.row);
    if (device === undefined) return null;
    if (!this.admits(confirm.key, proof)) return null;
    const updated: StoredDevice = { ...device, relay_public_key: confirm.key, account: waiting.account, linked_at: new Date(now).toISOString(), link_moved_key: true, ...(ownWord ? { joined_by: vouched ? "service" as const : "word" as const } : {}), origin: this.pc.admit("pc", "link", null, now) };
    delete updated.imported;
    delete updated.invalid_origin;
    this.bindingWith(waiting.account, confirm.key, () => this.enroll(updated, now, [], false, { replaces: device, confirm: proof }));
    this.endNoAccountCode();
    for (const listener of [...this.relinks.get(confirm.row) ?? []]) listener(sessionId);
    return { id: updated.id, label: updated.label, role: updated.role };
  }

  /** A pairing of a key on this PC names the account removals it knew (`paired_over`), and stands over them (P13, T23). */
  private knowingRemovals(device: StoredDevice): StoredDevice {
    if (this.evidence === null || device.relay_public_key === undefined || !pairedHere(device)) return device;
    const over = this.evidence.pairedOver(device.relay_public_key);
    return over.length ? { ...device, paired_over: over } : device;
  }

  /**
   * A pairing made on this PC (a code, or a comparison approved here) lets a removed key back in. With removal
   * evidence it ends the Revokes of the key by name and leaves the account's markers standing (T21, T23).
   */
  private clearTombstone(key: string): void {
    if (this.evidence !== null) {
      if (this.accountError !== null) return;
      this.evidence.unrevoke(key, "pc", Date.now());
      this.refreshTombstones();
      return;
    }
    if (this.accountError !== null || !this.isTombstoned(key)) return;
    this.writeTombstones(this.tombstones.filter((t) => t.key !== key));
  }

  /**
   * Tombstones for the relay keys of rows this PC revokes, written before the revoke itself. The rows that wait to
   * link with one of those keys go next, before the revoke as well (dropWaiting).
   */
  private tombstone(rows: readonly StoredDevice[], now: number, how: "revoke" | "revoke_all" = "revoke"): void {
    // each Revoke is its own evidence, also of a key that already has a tombstone, and also while the tombstone files
    // cannot be read, so it outlives their repair (P13)
    // a Revoke is stamped after every row this store holds, whatever the wall clock says (P13)
    if (this.evidence !== null) now = Date.parse(this.nextStamp(now));
    if (this.evidence !== null && this.evidence.strict === null) {
      for (const key of new Set(rows.flatMap((d) => d.relay_public_key ?? []))) this.evidence.addRevoke(key, rows.find((d) => d.relay_public_key === key)?.account ?? null, now, rowDrop(this.joinedRows?.rowsByKey(key)[0], how));
    }
    // the evidence holds the Revoke when it is sound; a tombstone file that cannot be read is left as it is (S19)
    if (this.evidence !== null && this.evidence.strict === null) {
      if (this.accountIntegrityError === null) this.refreshTombstones();
      this.dropWaiting(rows.flatMap((d) => d.relay_public_key ?? []), "revoke");
      return;
    }
    // evidence that cannot be trusted holds nothing: the Revoke leaves main's tombstone, which keeps the key out at once
    // (stale) and becomes a Revoke at the first start that takes the evidence in (P13, rule 1)
    const keys = [...new Set(rows.flatMap((d) => d.relay_public_key === undefined || this.isTombstoned(d.relay_public_key) ? [] : [d.relay_public_key]))];
    const removedAt = new Date(now).toISOString();
    const next = [...this.tombstones,
      ...keys.map((key) => ({ key, account: rows.find((d) => d.relay_public_key === key)?.account ?? "", record_id: "local", removed_at: removedAt }))];
    if (keys.length) {
      // with the main file unreadable the revoke still wins: its tombstone waits beside it
      if (this.accountProblem !== null || this.restampProblem !== null || this.futureProblem !== null) {
        writePrivateState(this.pendingTombstonePath, { v: 1, tombstones: next });
        this.tombstones = next;
      } else this.writeTombstones(next);
    }
    this.dropWaiting(rows.flatMap((d) => d.relay_public_key ?? []), "revoke");
  }

  private writeTombstones(next: AccountTombstone[]): void {
    writePrivateState(this.tombstonePath, { v: 1, tombstones: next });
    this.tombstones = next;
  }

  private assertAccountWritable(): void {
    this.assertWritable();
    if (this.accountError !== null) throw new Error(this.accountError);
  }
}

export interface DeviceConnections {
  list(): Map<string, DeviceConnection>;
  check(timeoutMs: number): Promise<void>;
}

const CHECK_MS = 3_000;

/**
 * /api/devices*. Pairing itself is public, like /api/auth: it is how a device gets in. The
 * rest reaches here only through the gate in index.ts, and anything that changes the list
 * needs the app's own mutation guard (same origin + X-Herdr-Machine), like the other mutations.
 * `onRevoked` is told the id of every device a request revoked, once the registry says so: the
 * cleanup that follows (push subscriptions, page media) works from those ids, never from the path.
 */
export async function handleDeviceRequest(request: Request, pathname: string, store: DeviceStore, access: Access, relayKey: string | null, onRevoked?: (ids: string[]) => void, lanHttps = false, connections?: DeviceConnections, ownWindow = false): Promise<Response> {
  if (store.error !== null) return jsonResponse({ error: { code: "device_store_unavailable", message: access.level === "full" ? store.error : "Device pairing is unavailable; ask the owner to check Settings → Devices on the host." } }, 503);
  const json = async (): Promise<Record<string, unknown> | Response> => {
    try {
      const body = (await request.json()) as unknown;
      return isJsonObject(body) ? body : badRequest("invalid_body", "request body must be a JSON object");
    } catch { return badRequest("invalid_json", "request body must be JSON"); }
  };
  if (pathname === "/api/devices/pair") {
    setRequestRoute(pathname);
    if (access.level === "full" && access.via === "relay") return jsonResponse({ error: { code: "device_key_required", message: "Pair relay devices through the encrypted channel" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await json();
    if (body instanceof Response) return body;
    if (typeof body["code"] !== "string") return badRequest("missing_code", "code is required");
    // the LAN HTTPS listener counts its wrong codes like the relay does, apart from it
    if (lanHttps) {
      try { store.assertRelayPairing("lan"); } catch (error) {
        if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
        throw error;
      }
    }
    const firstPair = !store.gated;
    const paired = store.pair(body["code"], normalizeLabel(body["label"], "Device"), "drive", Date.now(), streamKeys(request), lanHttps);
    if (paired === null) {
      if (lanHttps) store.noteRelayFailure("lan");
      return jsonResponse({ error: { code: "invalid_code", message: "the code is wrong, spent or expired; start a new pairing on the PC" } }, 401);
    }
    const cookies = [deviceCookie(paired.token, isSecureRequest(request)), CLEAR_LEGACY_DEVICE_COOKIE];
    if (!acceptsJson(request)) return noContent(...cookies);
    // a script asked for the token itself, to send as `Authorization: Device <token>` (#2744); a
    // browser never asks, so its page never reads the credential its HttpOnly cookie keeps. A first
    // pairing waits in memory for its cookie to come back; a script may store the token and use it
    // after a restart, so its pairing is confirmed (written, gate closed) before the answer
    if (firstPair) store.match(paired.token);
    const answer = jsonResponse({ token: paired.token } satisfies DevicePairToken, 200, { "cache-control": "no-store" });
    for (const cookie of cookies) answer.headers.append("set-cookie", cookie);
    return answer;
  }
  const orderedRevoke = store.accountPolicyActive() && access.level === "full" && !store.canRevokeAsPc(access);
  if (pathname === "/api/devices") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const drive = access.level === "full" && access.role === "drive";
    // how the other devices are connected, and pinging them all, is for a caller that may manage them:
    // not a watching device, nor a Portal visitor, who see the list as before
    const manager = drive && access.via !== "portal";
    if (manager && connections && new URL(request.url).searchParams.get("check") === "1") await connections.check(CHECK_MS);
    const live = manager ? connections?.list() ?? new Map<string, DeviceConnection>() : new Map<string, DeviceConnection>();
    // Callers without PC-level Revoke authority get their verdict for each row (T19, T20).
    const callerId = access.level === "full" ? access.device?.id ?? null : null;
    const pendingNotMe = ownWindow && drive ? store.pendingNotMeRows() : null;
    const devices = [...store.list(callerId, drive), ...store.listAccountJoined(callerId)]
      .map((device) => { const connection = live.get(device.id); return connection ? { ...device, connection } : device; })
      .map((device) => pendingNotMe?.has(device.id) ? { ...device, not_me_waiting: true as const } : device)
      .map((device) => orderedRevoke ? { ...device, remote_revoke: drive ? store.remoteRevoke(callerId, device.id) : "read_only" as const } : device);
    return jsonResponse({ devices, ...(orderedRevoke ? { revoke_all: "local_only" as const } : {}) }, 200, { "cache-control": "no-store" });
  }
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_origin", message: "Manage devices from this app" } }, 403);
  if (access.level === "full" && access.role === "watch") return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  if (pathname === "/api/devices/pair/start") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    // a code admits whoever holds it, so through the relay to a PC in an account only those who may approve a pairing
    // may start one; a PC in no account keeps letting any driving relay device start one, as before
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "Start a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    try {
      const remote = access.level === "full" && access.via === "relay";
      // its starter is recorded as the new device's adder; on a PC in an account that starter must stay a member
      const startedBy = remote ? access.device?.id ?? null : null;
      // the paired device that asks, through the relay or at this PC's own address: the code goes when it is revoked
      const by = access.level === "full" ? access.device?.id ?? null : null;
      const open = access.level === "full" && access.via === "open";
      return jsonResponse(store.startPairing(Date.now(), { remote, startedBy, memberRequired: remote && store.account() !== null, ownPc: ownWindow, by, ...(open ? { open } : {}) }), 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
      if (error instanceof DeviceGoneError) return jsonResponse({ error: { code: error.code, message: error.message } }, 401, { "cache-control": "no-store" });
      throw error;
    }
  }
  if (pathname === "/api/devices/pair/cancel") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    // whoever may start a code may take it back (the same rule as /pair/start)
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "End a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    const text = await request.text();
    let body: unknown = {};
    try { if (text.trim() !== "") body = JSON.parse(text); } catch { return badRequest("invalid_json", "request body must be JSON"); }
    if (!isJsonObject(body)) return badRequest("invalid_body", "code must be the six-digit pairing code");
    const { code, id } = body;
    if (code !== undefined && (typeof code !== "string" || !/^\d{6}$/.test(code))) return badRequest("invalid_body", "code must be the six-digit pairing code");
    if (id !== undefined && (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))) return badRequest("invalid_body", "id must be the pairing's id");
    const match = code === undefined && id === undefined ? undefined : { ...code !== undefined ? { code } : {}, ...id !== undefined ? { id } : {} };
    return jsonResponse({ ok: true, cancelled: store.endPairing(match) }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/devices/revoke-all") {
    setRequestRoute("/api/devices/revoke-all");
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (orderedRevoke) return jsonResponse({ error: { code: "local_required", message: "Revoke all is done at that PC" } }, 403);
    const revoked = store.revokeAll();
    onRevoked?.(revoked);
    // the caller's own device cookie, if it holds one, names a device that is gone, under either name
    const answer = jsonResponse({ revoked: revoked.length } satisfies DevicesRevokedAll, 200, { "cache-control": "no-store" });
    answer.headers.append("set-cookie", DEVICE_COOKIE_CLEARED);
    answer.headers.append("set-cookie", CLEAR_LEGACY_DEVICE_COOKIE);
    return answer;
  }
  const id = pathname.slice("/api/devices/".length);
  setRequestRoute("/api/devices/:device_id");
  if (!/^[0-9a-f]{16}$/.test(id)) return badRequest("invalid_device", "no such device");
  if (request.method === "DELETE") {
    // `x-ovis-unless-account`: the caller removes the device because it is no member of that account (`ovis add`,
    // of a device its code let in). One that became a member of it since the caller read the list stays. The check
    // and the revoke are one step here, so no link comes between them. Membership is what the row says: a first
    // member linked itself and named its account, which nothing here proves (docs/account.md, rule 4)
    const unless = request.headers.get("x-ovis-unless-account");
    // Without PC-level authority, a paired caller can only Revoke by admission order (T19).
    if (orderedRevoke && store.has(id) && store.remoteRevoke(access.device?.id ?? null, id) !== "allowed") {
      return jsonResponse({ error: { code: "older_device", message: "removing an older device is done from that PC or from an older device" } }, 403);
    }
    if (unless !== null && store.isMemberOf(id, unless)) return jsonResponse({ error: { code: "account_member", message: "that device is a member of the account by now" } }, 409);
    // a revoke takes the key's other rows too (DeviceStore.revoke): each one's cleanup runs, not the named row's alone
    const removed: string[] = [];
    const unlisten = store.onRemoved((event) => removed.push(event.device_id));
    let revoked: boolean;
    try { revoked = store.revoke(id, access.level === "full" && access.device ? { device_id: access.device.id, label: access.device.label } : "pc"); }
    finally { unlisten(); }
    if (!revoked) return jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
    onRevoked?.(removed);
    return noContent();
  }
  if (request.method === "PATCH") {
    const body = await json();
    if (body instanceof Response) return body;
    const updated = store.update(id, { label: normalizeLabel(body["label"], "Device") });
    return updated ? jsonResponse(updated) : jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
  }
  return badRequest("method_not_allowed", "use PATCH or DELETE");
}
