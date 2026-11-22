/**
 * One admission order per PC (rows P21 and P22 of the account-opens-all design). Every row this PC admits carries an
 * `origin`: where it came from, by which path, and `admit_no`, its place in this PC's own order, taken from
 * `next_admit` in `account-pc.json` and never used twice. Age in any decision on this PC is that order: no account
 * registration number, no journal sequence and no clock stands in for it. Rows from before the upgrade are stamped
 * `legacy` once (T50) and keep their creation order among themselves; a row with no origin, or a tie, has no age and
 * so no authority over another row (T19). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { AccountSnapshotError, parseAdmissionOrigin, type AdmissionFrom, type AdmissionHow, type AdmissionOrigin } from "../../shared/account-snapshot.ts";

/** This PC's account state (P12, server/account/pc-binding.ts), which holds `next_admit`. */
export const ADMISSION_FILE = "account-pc.json";

export type OriginFrom = AdmissionFrom;
export type OriginHow = AdmissionHow;
/** A row's origin is the shared contract's (shared/account-snapshot.ts); `by` is the approving member's account key. */
export type RowOrigin = AdmissionOrigin;

/** Whether a stored origin is one the shared contract accepts: a legacy one only with admit_no 0, every other from 1. */
export function isRowOrigin(value: unknown): value is RowOrigin {
  try { parseAdmissionOrigin(value); return true; } catch (error) {
    if (error instanceof AccountSnapshotError) return false;
    throw error;
  }
}

interface AdmissionRow {
  readonly id: string;
  readonly created_at: string;
  readonly origin?: RowOrigin | undefined;
  readonly untrusted_created_at?: string;
}

export interface AdmissionPosition {
  readonly admit_no: number;
  readonly legacy_created_at?: number;
}

export function admissionPosition(row: AdmissionRow): AdmissionPosition | null {
  if (row.origin === undefined || row.untrusted_created_at === row.created_at) return null;
  const admit_no = row.origin.admit_no;
  const created = row.origin.from === "legacy" ? Date.parse(row.created_at) : NaN;
  return { admit_no, ...(Number.isFinite(created) ? { legacy_created_at: created } : {}) };
}

export function compareAdmissionPositions(a: AdmissionPosition | null, b: AdmissionPosition | null): "older" | "newer" | null {
  if (a === null || b === null) return null;
  if (a.admit_no !== b.admit_no) return a.admit_no < b.admit_no ? "older" : "newer";
  const left = a.legacy_created_at;
  const right = b.legacy_created_at;
  if (left === undefined || right === undefined || left === right) return null;
  return left < right ? "older" : "newer";
}

/**
 * Which of two rows joined this PC first: `older` when `a` did, `newer` when `b` did, null when they cannot be placed
 * against each other (a missing origin, or two legacy rows made at the same time). Null gives no authority either way.
 */
export function compareAdmission(a: AdmissionRow, b: AdmissionRow): "older" | "newer" | null {
  return a.id === b.id ? null : compareAdmissionPositions(admissionPosition(a), admissionPosition(b));
}

/** What a remote caller may act on: its own row, and the rows that joined this PC after it (T19 in 2d). */
export function remoteReach(caller: AdmissionRow, target: AdmissionRow): boolean {
  if (caller.id === target.id) return true;
  return compareAdmission(caller, target) === "older";
}


/** The stamp of a row that existed before the upgrade (T50): older than every later admission here. */
export function legacyOrigin(createdAt: string): RowOrigin {
  return { from: "legacy", how: "legacy", by: null, admit_no: 0, at: createdAt };
}
