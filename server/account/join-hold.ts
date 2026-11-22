/**
 * The join hold of an account-joined row (Step 2, rows P17, S25, T53, Q18). The hold lasts JOIN_HOLD_MS from the
 * durable publication of the row's notice, or ends earlier by "It's me" from an established older row. Neither
 * ends it by itself: the caller asks the admission guard again in the same turn.
 */

export const JOIN_HOLD_MS = 10_000;
/** Q18: a row admitted on this PC within the last hour says no "It's me", however old its key. */
export const ITS_ME_MIN_AGE_MS = 60 * 60_000;

/** The row that says "It's me", over its own session with its key proved. */
export interface Sayer {
  readonly key: string;
  readonly drives: boolean;
  readonly state: "live" | "hold" | "waiting";
  /** The key's place in the account's order on this PC, null when it has none. */
  readonly no: number | null;
  readonly late: boolean;
  /** The row's admission number on this PC from an origin written in this directory, null when it has none. */
  readonly admitNo: number | null;
  /** When the row was admitted on this PC (origin.at). */
  readonly admittedAt: number;
}

export interface HeldRow {
  readonly key: string;
  readonly no: number | null;
  readonly admitNo: number | null;
}

function older(sayer: Sayer, held: HeldRow): boolean {
  if (sayer.no !== null) return held.no !== null && sayer.no < held.no;
  return sayer.admitNo !== null && held.admitNo !== null && sayer.admitNo < held.admitNo;
}

export function mayEndHold(sayer: Sayer, held: HeldRow, now: number): boolean {
  if (sayer.late || sayer.key === held.key || !sayer.drives || sayer.state !== "live") return false;
  // a time ahead of the clock counts as just now
  const admitted = Math.min(sayer.admittedAt, now);
  return now - admitted > ITS_ME_MIN_AGE_MS && older(sayer, held);
}

/** Seconds left of a join hold that ends at `holdUntil`; null while its notice is not published, so it has no end yet. */
export function holdSecondsLeft(holdUntil: number | null, now: number): number | null {
  if (holdUntil === null) return null;
  return Math.max(0, Math.ceil((holdUntil - now) / 1000));
}

/** T67's four facts, read in the commit turn. */
export interface FirstDeviceFacts {
  readonly key: string;
  readonly listKeys: readonly string[];
  readonly removedKeys: readonly string[];
  readonly otherRows: boolean;
  readonly othersEver: boolean;
  readonly firstListKey: string | null;
}

export function firstDevice(facts: FirstDeviceFacts): boolean {
  return !facts.othersEver && !facts.otherRows && facts.firstListKey === facts.key
    && facts.listKeys.every((key) => key === facts.key) && facts.removedKeys.length === 0;
}
