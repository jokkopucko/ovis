/**
 * The account snapshot a PC reads from the account service, and the account-joined rows a PC keeps
 * from it. Shapes and validators only: what a PC does with a snapshot is decided elsewhere.
 */
import { AccountRecordError, accountDeviceId, isAccountKeyEncoding, isDeviceSafetyRecord, parseSafetyRecord, type BlockRecord, type DeviceLiftRecord, type SafetyRecord } from "./account-records.ts";

/** Wire format of a snapshot page and of `account-devices.json`. */
export const ACCOUNT_SNAPSHOT_V = 1;
/** Device table P6: the service no longer holds the snapshot a page asked for; the whole read is thrown away. */
export const SNAPSHOT_GONE = "snapshot_gone";
/** Device table P6: the most entries one list of one page holds; the service pages longer lists. */
export const SNAPSHOT_PAGE_MAX = 500;
/** Device table S21: the most account-joined rows `account-devices.json` holds. */
export const ACCOUNT_ROWS_MAX = 1000;

export class AccountSnapshotError extends Error {
  readonly code = "snapshot_invalid";
}

function fail(message: string): never {
  throw new AccountSnapshotError(message);
}

/** Device table P6, P21: a registered key with its place in the account's order and whether the list may admit it. */
export interface SnapshotDevice {
  readonly key: string; readonly no: number; readonly eligible: boolean; readonly label: string;
  readonly two_step?: "set" | "unknown"; readonly provider?: "google" | "github" | "apple";
}
/** Device table P6, P21: a removed key keeps its `no`, with no end date. */
export interface SnapshotRemoved { readonly key: string; readonly no: number }
/** Device table P16, G12: the service's freeze line for one block; keys above `after` are not listed. */
export interface SnapshotFreezeLine { readonly block: string; readonly target: string; readonly after: number }

/** What one snapshot says, the same on every page; pages split the lists. */
interface SnapshotBody {
  readonly devices: readonly SnapshotDevice[];
  readonly removed: readonly SnapshotRemoved[];
  readonly blocks: readonly BlockRecord[];
  readonly lifts: readonly DeviceLiftRecord[];
  readonly freezes: readonly SnapshotFreezeLine[];
}

/**
 * Device table P6, G1, H4: one page of a read. Every page carries the same `snapshot` id, for this
 * `account` and this PC (`server_id`); `version` only refuses a snapshot older than the last applied.
 * Device table T58: `methods_version` is the account's sign-in-method version, the same on every page, so a
 * PC journals a committed method change from a whole read only.
 */
export interface AccountSnapshotPage extends SnapshotBody {
  readonly v: 1;
  readonly snapshot: string;
  readonly account: string;
  readonly server_id: string;
  readonly version: number;
  readonly methods_version: number;
  readonly page: number;
  readonly last: boolean;
}

/** Device table P6, G1: a whole read, assembled from pages that all carried one snapshot id. */
export interface AccountSnapshot extends SnapshotBody {
  readonly snapshot: string;
  readonly account: string;
  readonly server_id: string;
  readonly version: number;
  readonly methods_version: number;
}

const SNAPSHOT_ID = /^[0-9a-f]{32}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_ID = /^[0-9a-f]{32}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isOrder = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_MS.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 48 && !/[\p{Cc}\p{Cs}]/u.test(v);
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && isIso(`${v}T00:00:00.000Z`);

/** With a projection, keep only declared wire fields. Safety and on-disk objects remain exact. */
function object(value: unknown, fields: readonly string[], what: string, projection?: { optional: readonly string[] }): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} is a JSON object`);
  const record = value as Record<string, unknown>;
  for (const name of fields) if (!Object.hasOwn(record, name)) fail(`${what} has no ${name}`);
  if (projection) {
    const names = [...fields, ...projection.optional.filter(name => Object.hasOwn(record, name))];
    return Object.fromEntries(names.map(name => [name, record[name]]));
  }
  for (const name of Object.keys(record)) if (!fields.includes(name)) fail(`Unexpected field ${name} in ${what}`);
  return record;
}

function list<T>(value: unknown, what: string, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) fail(`${what} is a list`);
  if (value.length > max) fail(`${what} has more than ${max} entries`);
  return Array.from(value, item);
}

/** A nested safety record of this page's account; its own parse error is this page's. */
function pageRecord(entry: unknown, account: unknown): SafetyRecord {
  let record: SafetyRecord;
  try {
    record = parseSafetyRecord(entry);
  } catch (error) {
    if (error instanceof AccountRecordError) fail(`Invalid record: ${error.message}`);
    throw error;
  }
  check(record.account === account, "A record of another account");
  return record;
}

function check(ok: boolean, message: string): void {
  if (!ok) fail(message);
}

const PAGE_FIELDS = ["v", "snapshot", "account", "server_id", "version", "methods_version", "page", "last", "devices", "removed", "blocks", "lifts", "freezes"];

/** Unknown page and device fields are extensions. A missing required part is not an empty one. */
export function parseSnapshotPage(value: unknown): AccountSnapshotPage {
  const page = object(value, PAGE_FIELDS, "A snapshot page", { optional: [] });
  check(page.v === ACCOUNT_SNAPSHOT_V, "Unknown snapshot version");
  check(typeof page.snapshot === "string" && SNAPSHOT_ID.test(page.snapshot), "Invalid snapshot id");
  check(typeof page.account === "string" && ACCOUNT.test(page.account), "Invalid account");
  check(typeof page.server_id === "string" && SERVER_ID.test(page.server_id), "Invalid server_id");
  check(isOrder(page.version), "Invalid version");
  check(Number.isSafeInteger(page.methods_version) && (page.methods_version as number) >= 0, "Invalid methods_version");
  check(Number.isSafeInteger(page.page) && (page.page as number) >= 0, "Invalid page");
  check(typeof page.last === "boolean", "Invalid last");
  const devices = list(page.devices, "devices", SNAPSHOT_PAGE_MAX, (entry): SnapshotDevice => {
    const { key, no, eligible, label, provider, two_step } = object(entry, ["key", "no", "eligible", "label"], "A device", { optional: ["two_step", "provider"] });
    if (!isAccountKeyEncoding(key) || !isOrder(no) || typeof eligible !== "boolean" || !isLabel(label)) fail("Invalid device");
    return { key, no, eligible, label, two_step: two_step === "set" ? "set" : "unknown",
      ...(provider === "google" || provider === "github" || provider === "apple" ? { provider } : {}) };
  });
  list(page.removed, "removed", SNAPSHOT_PAGE_MAX, (entry) => {
    const removed = object(entry, ["key", "no"], "A removed key");
    check(isAccountKeyEncoding(removed.key) && isOrder(removed.no), "Invalid removed key");
  });
  list(page.blocks, "blocks", SNAPSHOT_PAGE_MAX, (entry) => check(pageRecord(entry, page.account).kind === "block", "Not a block"));
  list(page.lifts, "lifts", SNAPSHOT_PAGE_MAX, (entry) => {
    const lift = pageRecord(entry, page.account);
    check(lift.kind === "lift" && isDeviceSafetyRecord(lift), "Not a device lift");
  });
  list(page.freezes, "freezes", SNAPSHOT_PAGE_MAX, (entry) => {
    const line = object(entry, ["block", "target", "after"], "A freeze line");
    check(typeof line.block === "string" && /^[0-9a-f]{64}$/.test(line.block) && isAccountKeyEncoding(line.target) && isOrder(line.after), "Invalid freeze line");
  });
  return { ...(page as unknown as AccountSnapshotPage), devices };
}

/**
 * Device table P6, G1, T58: pages 0..n in order, each with the same snapshot id, account, PC, version and methods_version,
 * and only the last saying so. `lastApplied` is the version of the last snapshot this PC applied.
 * Keys and numbers are unique across `devices` and `removed`; blocks and lifts are unique in the read.
 * G12: each freeze line names a block from the snapshot or the PC's safety log (`knownBlocks`).
 */
export function assembleSnapshot(pages: readonly AccountSnapshotPage[], expected: { account: string; server_id: string; lastApplied: number | null; knownBlocks?: ReadonlySet<string> }): AccountSnapshot {
  const first = pages[0];
  if (first === undefined) fail("A read has at least one page");
  pages.forEach((page, index) => {
    check(page.snapshot === first.snapshot && page.version === first.version && page.methods_version === first.methods_version, "Pages of different snapshots");
    check(page.account === expected.account && page.server_id === expected.server_id, "A page for another account or PC");
    check(page.page === index, "Pages out of order");
    check(page.last === (index === pages.length - 1), "The read did not end on its last page");
  });
  check(expected.lastApplied === null || first.version >= expected.lastApplied, "A snapshot older than the last applied");
  const snapshot: AccountSnapshot = {
    snapshot: first.snapshot, account: first.account, server_id: first.server_id, version: first.version, methods_version: first.methods_version,
    devices: pages.flatMap((page) => page.devices), removed: pages.flatMap((page) => page.removed),
    blocks: pages.flatMap((page) => page.blocks), lifts: pages.flatMap((page) => page.lifts), freezes: pages.flatMap((page) => page.freezes),
  };
  const keys = new Set<string>();
  const numbers = new Set<number>();
  for (const { key, no } of [...snapshot.devices, ...snapshot.removed]) {
    check(!keys.has(key) && !numbers.has(no), "A key or a number appears twice");
    keys.add(key);
    numbers.add(no);
  }
  const blocks = new Set(snapshot.blocks.map((record) => record.id));
  check(blocks.size === snapshot.blocks.length, "A block appears twice");
  check(new Set(snapshot.lifts.map((record) => record.id)).size === snapshot.lifts.length, "A lift appears twice");
  for (const line of snapshot.freezes) check(blocks.has(line.block) || (expected.knownBlocks?.has(line.block) ?? false), "A freeze line names a block nobody holds");
  return snapshot;
}

/** Device table P22: where a row was admitted from. `recover` is `ovis recover --admit` (R11); `legacy` is a row from before the upgrade (T50). */
export type AdmissionFrom = "pc" | "remote" | "recover" | "legacy";
/** Device table P22: the path that admitted it. */
export type AdmissionHow = "list" | "add" | "member" | "code" | "digits" | "qr" | "promoted" | "confirmed" | "link" | "legacy";
const FROM: readonly string[] = ["pc", "remote", "recover", "legacy"];
const HOW: readonly string[] = ["list", "add", "member", "code", "digits", "qr", "promoted", "confirmed", "link", "legacy"];

/**
 * Device table P22: written in the turn that admits a row. `admit_no` orders admissions on this PC and is
 * the age every PC decision compares (P21); `by` names the approving key, or null when nobody did.
 */
export interface AdmissionOrigin { readonly from: AdmissionFrom; readonly how: AdmissionHow; readonly by: string | null; readonly admit_no: number; readonly at: string }

/**
 * Device table S21, S25, S27, T34, P17: an account-joined row's state. In `hold`, `hold_until` is the end of its
 * join hold, or null while its notice is not yet durably published: the join is refused `join_hold` with no
 * deadline yet, and the 10 seconds start only at durable publication. Outside `hold` it is null.
 */
export type AccountRowState = "hold" | "live" | "expired";

/** Device table S21: one row of `account-devices.json`. `no` is the service's order, `origin.admit_no` this PC's. */
export interface AccountJoinedRow {
  readonly id: string;
  readonly key: string;
  readonly no: number;
  readonly label: string;
  readonly origin: AdmissionOrigin;
  readonly confirmed_at: string;
  readonly last_signin_day: string | null;
  readonly state: AccountRowState;
  readonly hold_until: string | null;
}

/**
 * Device table S21, P1: `account-devices.json`, kept apart from `devices.json`; it names the snapshot it was last
 * written from. Device table T44: the cleared state (after left_on_pc, revoke_all or identity_reset) has
 * `account` and `snapshot` both null and no devices.
 */
export type AccountDevicesFile =
  | { readonly v: 1; readonly account: string; readonly server_id: string; readonly snapshot: string; readonly version: number; readonly devices: readonly AccountJoinedRow[] }
  | { readonly v: 1; readonly account: null; readonly server_id: string; readonly snapshot: null; readonly version: number; readonly devices: readonly [] };

/** Device table P22: an origin as stored; throws AccountSnapshotError for one that does not parse, and the caller decides what that row may do. */
export function parseAdmissionOrigin(value: unknown): AdmissionOrigin {
  const origin = object(value, ["from", "how", "by", "admit_no", "at"], "An origin");
  check(FROM.includes(origin.from as string) && HOW.includes(origin.how as string), "Invalid origin path");
  // `pc` is a key confirm on this PC's screen: a code, digits or a QR redeemed there, a row confirmed there (T68), a replacement confirmed there (T72)
  check(origin.from !== "pc" || ["code", "digits", "qr", "confirmed", "link"].includes(origin.how as string), "Only a key confirm at this PC is from pc");
  // T70: `ovis recover --admit` lets in a pending redemption, which a code, digits or a QR made
  check(origin.from !== "recover" || ["code", "digits", "qr"].includes(origin.how as string), "Only a pending redemption is let in by recover");
  check((origin.from === "legacy") === (origin.how === "legacy"), "A legacy row is legacy both ways");
  check(origin.by === null || isAccountKeyEncoding(origin.by), "Invalid origin by");
  // T50: a row from before the upgrade is stamped admit_no 0 by this PC's own upgrade pass, and only such a row
  check((origin.from === "legacy" ? origin.admit_no === 0 : isOrder(origin.admit_no)) && isIso(origin.at), "Invalid origin order");
  return origin as unknown as AdmissionOrigin;
}

const ROW_FIELDS = ["id", "key", "no", "label", "origin", "confirmed_at", "last_signin_day", "state", "hold_until"];

/** Device table S21, T44: the file as read from disk, every row checked; throws AccountSnapshotError. */
export function parseAccountDevicesFile(value: unknown): AccountDevicesFile {
  const file = object(value, ["v", "account", "server_id", "snapshot", "version", "devices"], "account-devices.json");
  check(file.v === ACCOUNT_SNAPSHOT_V, "Unknown file version");
  check(typeof file.server_id === "string" && SERVER_ID.test(file.server_id) && isOrder(file.version), "Invalid PC or version");
  const cleared = file.account === null && file.snapshot === null && Array.isArray(file.devices) && file.devices.length === 0;
  check(cleared || (typeof file.account === "string" && ACCOUNT.test(file.account) && typeof file.snapshot === "string" && SNAPSHOT_ID.test(file.snapshot)), "Invalid account or snapshot");
  const ids = new Set<unknown>();
  list(file.devices, "devices", ACCOUNT_ROWS_MAX, (entry) => {
    const row = object(entry, ROW_FIELDS, "A row");
    check(isAccountKeyEncoding(row.key) && isOrder(row.no) && isLabel(row.label) && isIso(row.confirmed_at), "Invalid row");
    // S21: the id is the key's accountDeviceId on this PC, and the list admitted it
    check(row.id === accountDeviceId(file.server_id as string, row.key as string) && !ids.has(row.id), "Invalid row id");
    ids.add(row.id);
    const origin = parseAdmissionOrigin(row.origin);
    check(origin.from === "remote" && origin.how === "list", "An account-joined row came in from the list");
    check(row.last_signin_day === null || isDay(row.last_signin_day), "Invalid last_signin_day");
    check(row.state === "hold" ? row.hold_until === null || isIso(row.hold_until) : (row.state === "live" || row.state === "expired") && row.hold_until === null, "Invalid state");
  });
  return file as unknown as AccountDevicesFile;
}

/**
 * Device table P9, section 5, T54: the days this PC saw each key used, sent with page 0 of a snapshot read. A UTC day per
 * key, each key once, at most SNAPSHOT_PAGE_MAX. The service keeps the latest day per (account, key), and a day only
 * delays an expiry: it never makes a key eligible. A breached or hostile PC of the account can keep a still signed-in
 * key from expiring for lack of use; it cannot add, lift or bring back a key.
 */
export interface UsedDay { readonly key: string; readonly day: string }
export type UsedReport = readonly UsedDay[];

/** Throws AccountSnapshotError. */
export function parseUsedReport(value: unknown): UsedReport {
  const seen = new Set<string>();
  list(value, "used", SNAPSHOT_PAGE_MAX, (entry) => {
    const used = object(entry, ["key", "day"], "A used day");
    check(isAccountKeyEncoding(used.key) && isDay(used.day) && !seen.has(used.key as string), "Invalid used day");
    seen.add(used.key as string);
  });
  return value as UsedReport;
}
