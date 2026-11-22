import type { AccountJoinedRow } from "../../shared/account-snapshot.ts";

export type RemovalReason = "remove" | "block" | "revoke" | "revoke_all";
export interface RowDrop {
  readonly row: string;
  readonly admit_no: number;
  readonly how: RemovalReason;
  readonly journalled?: number;
}

export function rowDrop(row: AccountJoinedRow | undefined, how: RemovalReason): RowDrop | undefined {
  return row && { row: row.id, admit_no: row.origin.admit_no, how };
}

export function isRowDrop(value: unknown): value is RowDrop {
  return typeof value === "object" && value !== null &&
    "row" in value && typeof value.row === "string" &&
    "admit_no" in value && typeof value.admit_no === "number" && Number.isSafeInteger(value.admit_no) && value.admit_no > 0 &&
    "how" in value && (value.how === "remove" || value.how === "block" || value.how === "revoke" || value.how === "revoke_all") &&
    (!("journalled" in value) || (typeof value.journalled === "number" && Number.isSafeInteger(value.journalled) && value.journalled > 0));
}

/** A PC can reuse a row ID, but not its admission number. The first deny owns that admission. */
export function withRowDrop<T extends { row_drops?: readonly RowDrop[] }>(doc: T, drop: RowDrop | undefined): T {
  if (!drop) return doc;
  const prior = doc.row_drops?.find(item => item.row === drop.row);
  // the same admission is replaced only to mark its own reason journalled: a later act never rewrites why it was dropped
  if (prior && (prior.admit_no > drop.admit_no || (prior.admit_no === drop.admit_no &&
    (prior.how !== drop.how || prior.journalled !== undefined || drop.journalled === undefined)))) return doc;
  return { ...doc, row_drops: [...doc.row_drops?.filter(item => item.row !== drop.row) ?? [], drop] };
}
