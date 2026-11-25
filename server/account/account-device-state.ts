import { readFileSync } from "node:fs";
import { AccountSnapshotError, parseAccountDevicesFile, type AccountJoinedRow, type AccountSnapshot, type AdmissionOrigin, type SnapshotDevice } from "../../shared/account-snapshot.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";
import type { RowDrop } from "./row-drop-evidence.ts";
import type { Sayer } from "./join-hold.ts";
import type { Readmission } from "./readmission.ts";

export type DropReason = "list" | "revoke_all" | "identity_reset" | "remove" | "block" | "revoke" | "expired" | "catching_up" | "promoted";

/**
 * What Track A's deny path (DeviceStore.attachAccountRows, set only while Step 2 is on) asks of the
 * account-joined rows: they are target and signer candidates of blocks, removes and Revokes like devices.json rows.
 * Removal detaches the whole batch before notifying session owners or writing the journal (P8 step 3).
 */
export interface AccountRowSource {
  /** Why `account-devices.json` cannot be used. A file that will not read is never empty (S19, T41). */
  blocked(): string | null;
  /** No `account-devices.json` on disk: no listed row is known here, which is not proof that none was. */
  missing(): boolean;
  rows(): readonly AccountRow[];
  row(id: string): AccountRow | null;
  rename(id: string, label: string): AccountRow | null;
  rowsByKey(key: string): readonly AccountRow[];
  /** Whether row `id` stands as admitted here, read only: not expired, and out of its hold only through the admission guard. */
  standing(id: string): boolean;
  access(id: string): AccessAnswer;
  pruneDenied(evidence: RemovalEvidence, legacyRevoke?: "revoke_all"): void;
  removeRows(ids: readonly string[], reason: Exclude<DropReason, "list">, close?: (id: string) => void): void;
  /** An eligible "It's me" answers the notice, ending the hold if one remains. */
  itsMe(id: string, sayer: Sayer): boolean;
  /** Authenticated use of the row on this PC (P9): a proved sign-in, or a request of its session. */
  seen(id: string): void;
  /** Called only after relay proof: scopes readmission to the refused sign-in's read. */
  readmission(id: string): Readmission | undefined;
}

export type AccountRow = AccountJoinedRow;

/**
 * A whole read's list, as S2-24's commit hands it over. `moved`: a device of a signed list that handed its place on to
 * another key of its own (`from` the key a row may hold, `to` the key it is in by now); never a snapshot's.
 */
export type ListCommit = Pick<AccountSnapshot, "account" | "snapshot" | "version" | "devices" | "removed"> & { readonly moved?: readonly { readonly from: string; readonly to: string }[] };

export interface JournalEntry extends Pick<SnapshotDevice, "provider" | "two_step"> {
  readonly kind: "admit" | "drop" | "its_me";
  readonly key: string;
  readonly row: string;
  readonly account: string | null;
  readonly drop?: RowDrop | undefined;
  readonly no?: number;
  readonly label?: string;
  readonly reason?: DropReason;
  readonly by?: string;
}

export type AccessAnswer = { readonly ok: true } | { readonly refused: "join_hold"; readonly seconds: number | null } | { readonly refused: "admission" | "not_listed" | "expired" | "catching_up" };

export interface AccountRowPorts {
  admitListedRows(write: () => readonly string[]): string[];
  checkFreshness?(): void;
  releaseOf?(id: string): string | null;
  serviceStep2Off?(): boolean;
  readonly evidence?: RemovalEvidence;
  /** On disk when it returns; a drop already recorded for this admission is not repeated. */
  journal(entry: JournalEntry): void;
  closeSessions(rowId: string, reason: DropReason): void;
  /** P2: a key a devices.json row holds stays there. */
  heldByDevicesJson(key: string): boolean;
  hasNoticeSlot(): boolean;
  settleNotices?(rows: readonly AccountRow[]): void;
  /** Standing guards apply both to a new row and to release of an existing hold. */
  admits(key: string, account: string): boolean;
  /** Puts the admission's notice in the unseen set of every older row, on disk; throws when it could not. */
  publish(entry: JournalEntry & { readonly accountNo: number }): void;
  /**
   * The rows one whole read newly admitted, on disk: told once per read that admits any, never for a row read at a
   * start, a republish or a sign-in.
   */
  admitted?(rows: readonly AccountRow[]): void;
  /** The rows changed and are on disk: a row was let in, left its hold, was used or went. */
  rowsWritten?(): void;
  now(): number;
  /**
   * Numbers one admission on this PC and returns its origin (PcAccountState.admit in pc-binding.ts, P12, P22): its
   * `admit_no` is the age every PC decision compares.
   */
  admitOrigin(at: number): AdmissionOrigin;
  /** The first-device facts this PC keeps with its binding (account-pc.json, T67). */
  firstDevice: {
    othersEver(): boolean;
    /** Set before the first row of the account that is not the binding row is written; nothing unsets it. */
    setOthersEver(): void;
    listKey(): string | null;
    /** A row in devices.json other than the one that bound the PC. */
    otherRows(): boolean;
  };
}

/** The file in memory: `account` and `snapshot` are null only in the cleared state, which holds no rows. */
export interface DevicesFile {
  account: string | null;
  snapshot: string | null;
  version: number;
  devices: AccountRow[];
}

export const CLEARED: DevicesFile = { account: null, snapshot: null, version: 1, devices: [] };

export function loadAccountDevices(path: string, serverId: string): { file: DevicesFile; error: string | null; foreign?: true } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ("code" in error && error.code === "ENOENT") return { file: CLEARED, error: null };
    return { file: CLEARED, error: `Cannot read ${path}: account-joined devices are refused until it is restored or fixed.` };
  }
  try {
    const file = parseAccountDevicesFile(value);
    // rows admitted under another relay identity name another PC: none of them is a row here
    return { file: { account: file.account, snapshot: file.snapshot, version: file.version, devices: [...file.devices] }, error: null,
      ...(file.server_id !== serverId ? { foreign: true } : {}) };
  } catch (error) {
    if (!(error instanceof AccountSnapshotError)) throw error;
    return { file: CLEARED, error: `${path} is not an account devices file (${error.message}): account-joined devices are refused until it is fixed.` };
  }
}
