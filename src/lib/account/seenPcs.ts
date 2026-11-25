/**
 * This device's own record of the PCs it has held end-to-end sessions with, for each account it was signed in to
 * (docs/account.md, "What a device remembers of its PCs"): since when, when last, and what the device did itself for
 * that PC. It only records. Nothing in the app decides by it yet; it is written now so that it has a history when
 * something does.
 *
 * A PC is named by the relay key its end-to-end channel is bound to (64 hex), never by what the account service's
 * directory says: a PC whose relay identity was reset is another row. It is kept in this browser's storage, per
 * account, and survives a sign-out: it is this device's memory, not the account's. Storage that was cleared only
 * loses the history.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";

/**
 * What this device did itself for a PC: paired with it at the PC (`paired`: a QR, a code, the digits), added it to the
 * account on this device (`added`), added it over SSH (`ssh`), or is that PC's own window (`window`); `invited`: the
 * PC joined with an invite of the account, which the line's own key proved for that PC, and the person pressed Add;
 * `none` where it only opened a PC it was shown. It moves from `none` to one of the others, never back and never
 * between them.
 */
export type SeenHow = "paired" | "added" | "ssh" | "window" | "invited" | "none";

/**
 * A value of `how` this build does not know: a later build wrote it. The row is kept as it is, through every write,
 * and the value is never replaced; for any decision it counts as `none` (howOf).
 */
export type OtherHow = string & { readonly other?: never };

/** `since`, `last`: seconds since 1970 by this device's clock, of the first and the latest session in which the PC let this device in; absent until there was one. */
export interface SeenPc { readonly since?: number; readonly last?: number; readonly how: SeenHow | OtherHow }

/** `tried`: when this device first tried to start or to join the account's list, in seconds; written once and cleared when that try ends. */
export interface SeenPcs { readonly v: 1; readonly account: string; readonly pcs: Readonly<Record<string, SeenPc>>; readonly tried?: number }

/** The most PCs kept for one account: the ones with the latest sessions. */
export const SEEN_PCS_MAX = 256;

const ENDPOINT = /^[0-9a-f]{64}$/;
const HOWS: readonly SeenHow[] = ["paired", "added", "ssh", "window", "invited", "none"];
/** The form a value of `how` takes, known to this build or not. */
const HOW = /^[a-z][a-z0-9_]{0,31}$/;

/** What `row` says this device did for its PC, for a decision: a value this build does not know counts as `none`. */
export function howOf(row: SeenPc | undefined): SeenHow {
  return row !== undefined && HOWS.includes(row.how as SeenHow) ? row.how as SeenHow : "none";
}
const keyOf = (account: string): string => `ovis:seen-pcs:${account}`;
const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readRow(value: unknown): SeenPc | null {
  // a value a later build wrote is kept as it is: no reader drops a row for its `how`
  if (!isRecord(value) || typeof value.how !== "string" || !HOW.test(value.how)) return null;
  const how = value.how as SeenHow | OtherHow;
  const { since, last } = value;
  if (since === undefined && last === undefined) return { how };
  return isSeconds(since) && isSeconds(last) && last >= since ? { since, last, how } : null;
}

/** The newest SEEN_PCS_MAX rows by their last session; a row with no session yet (an act alone) counts as the newest. */
function pruned(pcs: Readonly<Record<string, SeenPc>>): Record<string, SeenPc> {
  const rows = Object.entries(pcs);
  if (rows.length <= SEEN_PCS_MAX) return { ...pcs };
  return Object.fromEntries(rows.sort(([, a], [, b]) => (b.last ?? Infinity) - (a.last ?? Infinity)).slice(0, SEEN_PCS_MAX));
}

/** A session in which the PC at `endpoint` let this device in, at `at` seconds: `since` is written once and never moved, `last` only goes on. */
export function seenInSession(record: SeenPcs, endpoint: string, at: number, how: SeenHow): SeenPcs {
  const before = record.pcs[endpoint];
  const row: SeenPc = { since: before?.since ?? at, last: Math.max(before?.last ?? at, at), how: before === undefined || before.how === "none" ? how : before.how };
  return { ...record, pcs: pruned({ ...record.pcs, [endpoint]: row }) };
}

/** What this device did itself for the PC at `endpoint`, with or without a session yet. */
export function didFor(record: SeenPcs, endpoint: string, how: Exclude<SeenHow, "none">): SeenPcs {
  const before = record.pcs[endpoint];
  if (before !== undefined && before.how !== "none") return record;
  return { ...record, pcs: pruned({ ...record.pcs, [endpoint]: { ...before, how } }) };
}

export function withoutPc(record: SeenPcs, endpoint: string): SeenPcs {
  const { [endpoint]: _gone, ...pcs } = record.pcs;
  return { ...record, pcs };
}

const storageHere = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The record kept for `account`: empty where nothing is kept, the browser gives no storage, or what is kept is not in its form. */
export function readSeenPcs(account: string, storage: Storage | null = storageHere()): SeenPcs {
  const empty: SeenPcs = { v: 1, account, pcs: {} };
  let kept: unknown;
  try { kept = JSON.parse(storage?.getItem(keyOf(account)) ?? "null"); } catch { return empty; }
  if (!isRecord(kept) || kept.v !== 1 || kept.account !== account || !isRecord(kept.pcs)) return empty;
  const pcs: Record<string, SeenPc> = {};
  for (const [endpoint, value] of Object.entries(kept.pcs)) {
    const row = ENDPOINT.test(endpoint) ? readRow(value) : null;
    if (row !== null) pcs[endpoint] = row;
  }
  return { ...empty, pcs, ...(isSeconds(kept.tried) ? { tried: kept.tried } : {}) };
}

/** One change of an account's record, alone among this origin's pages where the browser has Web Locks: read, change, write. */
async function change(account: string, storage: Storage | null, edit: (record: SeenPcs) => SeenPcs): Promise<void> {
  if (storage === null) return;
  const write = async (): Promise<void> => {
    const before = readSeenPcs(account, storage);
    const after = edit(before);
    if (after === before) return;
    try { storage.setItem(keyOf(account), JSON.stringify(after)); } catch { /* no room, or no storage: the history starts later */ }
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  await (locks ? locks.request(`ovis:seen-pcs:${account}`, write) : write());
}

/** The PC at `endpoint` let this device in, in a session of a device signed in to `account`. */
export function noteSession(account: string, endpoint: string, how: SeenHow, now = Date.now(), storage: Storage | null = storageHere()): Promise<void> {
  if (!ENDPOINT.test(endpoint)) return Promise.resolve();
  return change(account, storage, (record) => seenInSession(record, endpoint, Math.floor(now / 1000), how));
}

/** This device did `how` for the PC at `endpoint`, for `account`. */
export function noteAct(account: string, endpoint: string, how: Exclude<SeenHow, "none">, storage: Storage | null = storageHere()): Promise<void> {
  if (!ENDPOINT.test(endpoint)) return Promise.resolve();
  return change(account, storage, (record) => didFor(record, endpoint, how));
}

/** The person took the PC with this id out of `account` on this device: its rows go (every relay key that gives the id). */
export function forgetSeenPc(account: string, serverId: string, storage: Storage | null = storageHere()): Promise<void> {
  return change(account, storage, (record) => {
    const gone = Object.keys(record.pcs).filter((endpoint) => deriveServerId(hexToBytes(endpoint)) === serverId);
    return gone.reduce(withoutPc, record);
  });
}

/** This device's first try to start or to join the account's list began now: written once. */
export function noteTried(account: string, now = Date.now(), storage: Storage | null = storageHere()): Promise<void> {
  return change(account, storage, (record) => record.tried === undefined ? { ...record, tried: Math.floor(now / 1000) } : record);
}

/** That try ended: in a start, in a place in the list, or in a refusal. */
export function clearTried(account: string, storage: Storage | null = storageHere()): Promise<void> {
  return change(account, storage, (record) => {
    if (record.tried === undefined) return record;
    const { tried: _ended, ...rest } = record;
    return rest;
  });
}
