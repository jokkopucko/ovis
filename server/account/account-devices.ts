/** Account-list admission lifecycle: durable holds, expiry, and guarded readmission. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId } from "../../shared/account-records.ts";
import { accountLabel } from "../../shared/account-asker.ts";
import type { SnapshotDevice, UsedReport } from "../../shared/account-snapshot.ts";
import { writePrivateState } from "../private-state.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";
import { rowDrop } from "./row-drop-evidence.ts";
import { expiresAt } from "./row-expiry.ts";
import type { Readmission } from "./readmission.ts";
import type { WitnessedRow } from "./witness.ts";
import { firstDevice, holdSecondsLeft, JOIN_HOLD_MS, mayEndHold, type Sayer } from "./join-hold.ts";
import { CLEARED, loadAccountDevices, type DevicesFile, type AccountRow, type AccountRowPorts, type AccountRowSource, type AccessAnswer, type DropReason, type JournalEntry, type ListCommit } from "./account-device-state.ts";
export type { AccountRow, AccountRowPorts, AccountRowSource, AccessAnswer, DropReason, JournalEntry, ListCommit } from "./account-device-state.ts";
export { accountRowsFor } from "./account-row-source.ts";

export const ACCOUNT_DEVICES_FILE = "account-devices.json";
/** The name a row of the list's devices has while this PC has not opened the name the list sealed for it (list-follow.ts LIST_DEVICE_LABEL). */
const PLACEHOLDER_LABEL = "Device";
export const ACCOUNT_DEVICES_MAX = 100;
/** Section 5: a row this PC saw no sign-in of for this many days expires here, whatever the service says. */
/** T56: with no whole read for this long, every account-joined row waits for one again. */
export const STALE_READ_MS = 60 * 60_000;
export { EXPIRY_DAYS } from "./row-expiry.ts";

const iso = (at: number): string => new Date(at).toISOString();
const dayOf = (at: number): string => iso(at).slice(0, 10);

export class AccountDeviceStore implements AccountRowSource {
  readonly error: string | null;
  private readonly path: string;
  private file: DevicesFile;
  private readonly pendingDrops: JournalEntry[] = [];
  /**
   * Rows waiting for a whole read (S22), in memory only: after a start every row waits, since a block may have been
   * signed while the PC was off (T41), and no time ends the wait. A whole read or `release` ends it.
   */
  private readonly waiting = new Set<string>();
  /** The rows the whole read under way admitted, told together once it ends (commitList); null outside one. */
  private admittedNow: AccountRow[] | null = null;

  constructor(stateDir: string, private readonly serverId: string, private readonly ports: AccountRowPorts,
    private readonly rowsChanged?: (rows: readonly AccountRow[]) => void) {
    this.path = join(stateDir, ACCOUNT_DEVICES_FILE);
    const { file, error, foreign } = loadAccountDevices(this.path, serverId);
    // restart: a promoted key's list row is finished (an interrupted promotion), and every hold waits for a fresh read (T42)
    this.file = foreign ? CLEARED : { ...file, devices: file.devices.filter((row) => !ports.heldByDevicesJson(row.key)).map((row) => row.state === "hold" ? { ...row, hold_until: null } : row) };
    this.error = error ?? (foreign ? ports.evidence?.strict ?? null : null);
    // Never serve a foreign row. Finish its old admission before replacing the only copy on disk.
    if (foreign && this.error === null) {
      for (const row of file.devices) {
        const reason = this.recoveryReason(row, file.account, ports.evidence);
        if (reason !== null) ports.journal(this.dropEntry(row, file.account, reason));
      }
      this.write(CLEARED);
    }
    // Finish a promotion interrupted between the member write and the list-row removal.
    for (const row of this.rows()) if (row.state !== "expired") this.waiting.add(row.id);
    if (!foreign && this.file.devices.length !== file.devices.length) this.write(this.file);
    else if (this.error === null && !this.missing()) ports.settleNotices?.(this.file.devices);
  }

  blocked(): string | null { return this.error; }

  missing(): boolean { return !existsSync(this.path); }

  rows(): readonly AccountRow[] { return this.error === null ? this.file.devices : []; }

  row(id: string): AccountRow | null {
    return this.rows().find((row) => row.id === id) ?? null;
  }

  rename(id: string, label: string): AccountRow | null {
    const row = this.row(id);
    if (!row) return null;
    const renamed = { ...row, label: accountLabel(label) || "Device" };
    this.write({ ...this.file, devices: this.file.devices.map(candidate => candidate === row ? renamed : candidate) });
    return renamed;
  }

  rowsByKey(key: string): readonly AccountRow[] {
    return this.rows().filter((row) => row.key === key);
  }

  standing(id: string): boolean {
    const row = this.row(id);
    const now = this.ports.now();
    if (!row || row.state === "expired" || expiresAt(row) <= now) return false;
    const seconds = row.state === "hold" ? holdSecondsLeft(row.hold_until === null ? null : Date.parse(row.hold_until), now) : null;
    return seconds !== 0 || this.admits(row.key);
  }

  /** Startup replay: finish the journal before the registry. There are no sessions to close yet. */
  pruneDenied(evidence: RemovalEvidence, legacyRevoke?: "revoke_all"): void {
    const { account, devices } = this.file;
    if (account === null) return;
    const kept = devices.filter(row => {
      const reason = this.recoveryReason(row, account, evidence, legacyRevoke);
      if (reason === null) return true;
      this.ports.journal(this.dropEntry(row, account, reason));
      return false;
    });
    if (kept.length !== devices.length) this.write({ ...this.file, devices: kept });
  }

  private recoveryReason(row: AccountRow, account: string | null, evidence?: RemovalEvidence, legacyRevoke?: "revoke_all") {
    const own = evidence?.dropFor(row.id, row.origin.admit_no);
    if (own) return own.how;
    const reason = account === null ? null : evidence?.accountRowDrop(row.key, account) ?? null;
    return reason === "revoke" ? legacyRevoke ?? reason : reason;
  }

  private dropEntry(row: AccountRow, account: string | null, reason: DropReason): JournalEntry {
    const drop = reason === "remove" || reason === "block" || reason === "revoke" || reason === "revoke_all" ? rowDrop(row, reason) : undefined;
    return { kind: "drop", row: row.id, key: row.key, account, no: row.origin.admit_no, reason, drop };
  }

  removeRows(ids: readonly string[], reason: Exclude<DropReason, "list">, close?: (id: string) => void): void {
    this.usable();
    this.drop(this.file.devices.filter(row => ids.includes(row.id)), reason, close);
  }

  live(id: string): boolean {
    return this.rows().some((row) => row.id === id && row.state === "live");
  }

  /** The admission guard for this file's account; a file with no account admits nothing. */
  private admits(key: string): boolean {
    return this.file.account !== null && this.ports.admits(key, this.file.account);
  }

  /** Whether row `id` may sign in now. A held row whose ten seconds are over passes the admission guard again first. */
  access(id: string): AccessAnswer {
    this.ports.checkFreshness?.();
    if (this.error === null) this.expire();
    const row = this.rows().find((candidate) => candidate.id === id);
    if (!row) return { refused: "not_listed" };
    if (row.state === "expired") return { refused: "expired" };
    if (this.ports.serviceStep2Off?.() || (this.waiting.has(id) && this.release(row) === null)) return { refused: "catching_up" };
    if (row.state === "live") return { ok: true };
    const seconds = holdSecondsLeft(row.hold_until === null ? null : Date.parse(row.hold_until), this.ports.now());
    if (seconds === null || seconds > 0) return { refused: "join_hold", seconds };
    if (!this.admits(row.key)) {
      // no longer listed (standing): what was said of its admission is settled
      this.ports.settleNotices?.(this.file.devices);
      return { refused: "admission" };
    }
    this.goLive(id);
    return { ok: true };
  }

  /** T53/T57: the timer can make the row live, but cannot decide its notice. */
  itsMe(id: string, sayer: Sayer): boolean {
    const row = this.row(id);
    if (!row || (row.state === "hold" && row.hold_until === null) || !mayEndHold(sayer, { key: row.key, no: row.no, admitNo: row.origin.admit_no }, this.ports.now())) return false;
    if (!this.admits(row.key)) return false;
    this.ports.journal({ kind: "its_me", key: row.key, row: row.id, account: this.file.account, no: row.origin.admit_no, by: sayer.key });
    if (row.state === "hold") this.goLive(id);
    return true;
  }

  /** Authenticated use of row `id` on this PC (a proved sign-in, or a request on its open session), at most once a day. */
  seen(id: string): void {
    const today = dayOf(this.ports.now());
    const row = this.rows().find((candidate) => candidate.id === id && candidate.state === "live");
    if (!row || row.last_signin_day === today) return;
    this.write({ ...this.file, devices: this.file.devices.map((candidate) => candidate.id === id ? { ...candidate, last_signin_day: today } : candidate) });
  }

  /**
   * Read only, for the record of how long each key has been let in (witness.ts): every row that is out of its hold and
   * stands, and whether it lets its key in right now, as `access` would. A row that waits for a whole read stands and
   * lets nobody in, unless a release a person at this PC gave lets that row in meanwhile; with Step 2 off here no row
   * does. null for a file that cannot be used, which is no word that its rows are gone.
   */
  witnessed(): readonly WitnessedRow[] | null {
    if (this.error !== null) return null;
    const now = this.ports.now();
    const off = this.ports.serviceStep2Off?.() === true;
    return this.file.devices.filter((row) => row.state === "live" && expiresAt(row) > now).map((row) => {
      const seen = row.last_signin_day === null ? NaN : Date.parse(row.last_signin_day);
      return { key: row.key, lets: !off && (!this.waiting.has(row.id) || this.release(row) !== null), seen: Number.isFinite(seen) ? Math.floor(seen / 1000) : null };
    });
  }

  /** P9: the days this PC saw each row used, for page 0 of the next read; an admission alone is no use. */
  usedReport(): UsedReport {
    return this.rows().flatMap((row) => row.state !== "expired" && row.last_signin_day !== null ? [{ key: row.key, day: row.last_signin_day }] : []);
  }

  /** T54: rows this PC saw no use of for EXPIRY_DAYS close and stay in the file as `expired`, so a list alone cannot bring them back. */
  expire(): string[] {
    this.usable();
    const now = this.ports.now();
    const idle = this.file.devices.filter(row => expiresAt(row) <= now);
    for (const row of idle) {
      this.ports.closeSessions(row.id, "expired");
      this.ports.journal(this.dropEntry(row, this.file.account, "expired"));
    }
    const ids = new Set(idle.map((row) => row.id));
    if (ids.size > 0) this.write({ ...this.file, devices: this.file.devices.map((row) => ids.has(row.id) ? { ...row, state: "expired", hold_until: null } : row) });
    // Expiry ends this admission. A later proved readmission reuses its id, not its catch-up wait.
    for (const id of ids) this.waiting.delete(id);
    return idle.map((row) => row.key);
  }

  /**
   * T55: the expired device itself tried to sign in here, and `list` is the whole read its refusal started. It comes
   * back only as a new admission: named eligible by that read, through every guard, with a new notice and hold.
   */
  readmit(key: string, list: ListCommit): boolean {
    this.usable();
    const expired = this.file.devices.find((row) => row.key === key && row.state === "expired");
    const entry = list.devices.find((candidate) => candidate.key === key && candidate.eligible);
    if (!expired || !entry || list.removed.some((gone) => gone.key === key) || list.account !== this.file.account) return false;
    if (!this.ports.hasNoticeSlot() || this.ports.heldByDevicesJson(key) || !this.ports.admits(key, list.account)) return false;
    return this.admit(entry, false);
  }

  readmission(id: string): Readmission | undefined {
    const proved = this.row(id);
    const account = this.file.account;
    if (proved?.state !== "expired" || account === null) return undefined;
    return (row, owner) => owner === account && row.id === proved.id
      && row.key === proved.key && row.origin.admit_no === proved.origin.admit_no;
  }

  /** T56: the last whole read is STALE_READ_MS old: every row waits for the next one, its sessions closed. */
  waitForRead(ids?: ReadonlySet<string>): void {
    for (const row of this.rows()) if (!ids || ids.has(row.id)) this.wait(row);
  }

  waitForService(): void {
    // A session may already be open under a named release, even though its row was waiting.
    for (const row of this.rows()) {
      if (row.state === "expired") continue;
      this.waiting.add(row.id);
      this.ports.closeSessions(row.id, "catching_up");
    }
  }

  /** A release excuses the wait only while it stands; undo must not need to reconstruct that wait. */
  private release(row: AccountRow): string | null {
    if (this.ports.serviceStep2Off?.()) return null;
    const release = this.ports.releaseOf?.(row.id) ?? null;
    return release !== null && row.state === "live" && this.admits(row.key) ? release : null;
  }

  waitingRows(): readonly AccountRow[] {
    this.ports.checkFreshness?.();
    if (this.error !== null || this.ports.serviceStep2Off?.()) return [];
    this.expire();
    return this.rows().filter(row => this.waiting.has(row.id));
  }

  /** Publishes again every notice that could not be published: until it is, its row stays held. */
  republish(): void {
    for (const row of this.rows()) {
      if (row.state !== "hold" || row.hold_until !== null || !this.admits(row.key)) continue;
      if (this.ports.admitListedRows(() => [row.id]).includes(row.id)) this.publish(row);
    }
  }

  /**
   * Applies a whole read's list: drops what it no longer names, then admits what it newly names and the guards let in.
   * `settled`: the keys whose coming in is no news to a person at this PC, who has just taken the list as the
   * account's (the PC pinned its signed list) or let that very device in here: they come in with no join hold.
   */
  commitList(list: ListCommit, readmission?: Readmission, settled: (key: string) => boolean = () => false): { admitted: string[]; dropped: string[] } {
    this.admittedNow = [];
    try { return this.commit(list, readmission, settled); } finally {
      const rows = this.admittedNow;
      this.admittedNow = null;
      this.tellAdmitted(rows);
    }
  }

  private commit(list: ListCommit, readmission: Readmission | undefined, settled: (key: string) => boolean): { admitted: string[]; dropped: string[] } {
    this.usable();
    const removed = new Set(list.removed.map((gone) => gone.key));
    const eligible = new Map(list.devices.filter((entry) => entry.eligible && !removed.has(entry.key)).map((entry) => [entry.key, entry]));
    const sameAccount = this.file.account === null || this.file.account === list.account;
    if (sameAccount) this.move(list.moved ?? [], eligible);
    const stillListed = new Set(list.devices.map(entry => entry.key));
    const leaving = this.file.devices.filter(row => !sameAccount || removed.has(row.key) ||
      (!eligible.has(row.key) && !(row.state === "expired" && stillListed.has(row.key))));
    // an expired row was dropped when it expired: it only leaves the file
    const forgotten = new Set(leaving.filter((row) => row.state === "expired").map((row) => row.id));
    if (forgotten.size > 0) this.write({ ...this.file, devices: this.file.devices.filter((row) => !forgotten.has(row.id)) });
    const dropped = this.drop(leaving.filter((row) => !forgotten.has(row.id)), "list", this.ports.closeSessions);

    // T42: every row the read still names is judged again; ending a wait is an admission and asks the guard
    for (const row of this.file.devices) {
      if (row.state === "expired") continue;
      if (!this.admits(row.key)) { dropped.push(...this.drop([row], "catching_up", this.ports.closeSessions)); continue; }
      if (!this.waiting.delete(row.id) || row.state !== "hold") continue;
      const until = iso(this.ports.now() + JOIN_HOLD_MS);
      this.write({ ...this.file, devices: this.file.devices.map((candidate) => candidate.id === row.id ? { ...candidate, hold_until: candidate.hold_until === null ? null : until } : candidate) });
    }

    // rows admitted from here on belong to this read's account and snapshot. A row still named by the list's placeholder
    // (its name was not open to this PC when it came in) takes the name the list gives it now; one a person named stays
    // (the list's commits alone: a PC that follows no list keeps the labels its rows came in with)
    const named = new Map(list.names === true ? list.devices.filter((entry) => entry.label !== PLACEHOLDER_LABEL).map((entry) => [entry.key, entry.label]) : []);
    const devices = this.file.devices.map((row) => row.label === PLACEHOLDER_LABEL && named.has(row.key) ? { ...row, label: named.get(row.key)! } : row);
    this.write({ ...this.file, devices, account: list.account, snapshot: list.snapshot, version: list.version });

    const admitted: string[] = [];
    this.republish();
    const listKeys = list.devices.map((entry) => entry.key);
    for (const entry of eligible.values()) {
      // whoever comes in new, or again, gets a notice; with none to give nobody does
      const slot = this.ports.hasNoticeSlot();
      const existing = this.file.devices.find((row) => row.key === entry.key);
      if (existing) {
        if (slot && sameAccount && readmission?.(existing, list.account) && this.readmit(entry.key, list)) admitted.push(entry.key);
        // a person has just let this very key in: a row a read made for it a moment before waits no longer either.
        // Its row is there already and takes no notice, so this holds while no notice can be made too
        else if (existing.state === "hold" && settled(entry.key)) this.goLive(existing.id);
        continue;
      }
      if (!slot) continue;
      // This new key needs a slot. A later proved replacement in the same list does not.
      if (this.file.devices.length >= ACCOUNT_DEVICES_MAX) continue;
      if (this.ports.heldByDevicesJson(entry.key) || !this.ports.admits(entry.key, list.account)) continue;
      const first = this.ports.firstDevice;
      const bypass = firstDevice({
        key: entry.key, listKeys, removedKeys: [...removed], othersEver: first.othersEver(), firstListKey: first.listKey(),
        otherRows: first.otherRows() || this.file.devices.some((row) => row.key !== entry.key),
      });
      if (this.admit(entry, bypass || settled(entry.key))) admitted.push(entry.key);
    }
    return { admitted, dropped };
  }

  /**
   * A device that handed its place on to another key of its own keeps its row here, under the key it is in by now: the
   * same name, age and admission, with no new hold and no notice, as it is the same device; a hold it is still in goes on. Its sessions under the key it
   * handed over end as a row that changed under them, and it signs in again with the other.
   */
  private move(moved: NonNullable<ListCommit["moved"]>, eligible: ReadonlyMap<string, SnapshotDevice>): void {
    for (const { from, to } of moved) {
      const row = this.file.devices.find((candidate) => candidate.key === from && candidate.state !== "expired");
      if (row === undefined || !eligible.has(to) || this.file.devices.some((candidate) => candidate.key === to)) continue;
      if (this.ports.heldByDevicesJson(to) || !this.admits(to)) continue;
      // while the row still stands under its old id, so each of its sessions ends as `auth_changed`
      this.ports.closeSessions(row.id, "list");
      const id = accountDeviceId(this.serverId, to);
      // the same device: a hold it is still in goes on, and so does a wait for a whole read, which this commit then ends
      this.write({ ...this.file, devices: this.file.devices.map((candidate) => candidate === row ? { ...row, id, key: to } : candidate) });
      if (this.waiting.delete(row.id)) this.waiting.add(id);
    }
  }

  /** The PC's account was cleared or its relay identity reset (T44): every account-joined row goes. */
  clear(reason: Exclude<DropReason, "list">): void {
    this.usable();
    this.drop(this.file.devices, reason, this.ports.closeSessions);
    this.write({ ...this.file, account: null, snapshot: null });
  }

  private wait(row: AccountRow): void {
    if (row.state === "expired" || this.waiting.has(row.id)) return;
    this.waiting.add(row.id);
    this.ports.closeSessions(row.id, "catching_up");
  }

  private admit(entry: SnapshotDevice, bypass: boolean): boolean {
    const first = this.ports.firstDevice;
    // taking the no-hold path is itself what sets the flag, so the path is used up by its first use
    if (!first.othersEver()) first.setOthersEver();
    const now = this.ports.now();
    const origin = this.ports.admitOrigin(now);
    const row: AccountRow = {
      id: accountDeviceId(this.serverId, entry.key), key: entry.key, no: entry.no, label: entry.label,
      origin,
      confirmed_at: origin.at, last_signin_day: null, state: bypass ? "live" : "hold", hold_until: null,
    };
    const standing = this.ports.admitListedRows(() => {
      this.ports.journal({ kind: "admit", key: row.key, row: row.id, account: this.file.account, no: row.origin.admit_no, label: row.label,
        two_step: entry.two_step ?? "unknown", ...(entry.provider === undefined ? {} : { provider: entry.provider }) });
      this.write({ ...this.file, devices: [...this.file.devices.filter(candidate => candidate.key !== entry.key), row] });
      return [row.id];
    });
    if (!standing.includes(row.id)) return false;
    // the row is on disk: it is told even when its notice's publication or the write of its hold fails next
    if (this.admittedNow !== null) this.admittedNow.push(row);
    else this.tellAdmitted([row]);
    this.publish(row);
    return true;
  }

  private tellAdmitted(rows: readonly AccountRow[]): void {
    if (rows.length === 0) return;
    try { this.ports.admitted?.(rows); } catch (error) {
      console.error(`[account] the admission of ${rows.map((row) => row.id).join(", ")} was not announced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private drop(rows: readonly AccountRow[], reason: DropReason, close?: AccountRowPorts["closeSessions"]): string[] {
    if (rows.length === 0) return [];
    const ids = new Set(rows.map((row) => row.id));
    this.file = { ...this.file, devices: this.file.devices.filter(row => !ids.has(row.id)) };
    // A durable deny can finish these drops at startup. Until journalled, not even
    // a later registry write in this process may erase the rows needed for replay.
    const replayable = reason === "revoke" || reason === "remove" || reason === "block" || reason === "revoke_all";
    const entries = rows.map(row => this.dropEntry(row, this.file.account, reason));
    if (replayable) this.pendingDrops.push(...entries);
    for (const row of rows) close?.(row.id, reason);
    let failure: Error | undefined;
    for (const entry of replayable ? [] : entries) {
      try { this.ports.journal(entry); }
      catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
    for (const id of ids) this.waiting.delete(id);
    this.write(this.file);
    if (failure) throw failure;
    return rows.map((row) => row.key);
  }

  private publish(row: AccountRow): void {
    try { this.ports.publish({ kind: "admit", key: row.key, row: row.id, account: this.file.account, no: row.origin.admit_no, accountNo: row.no, label: row.label }); } catch (error) {
      // the row stays held with no deadline: republish() starts its ten seconds once the notice is out
      console.error(`[account] the notice of ${row.id} was not published: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (row.state !== "hold") return;
    const until = iso(this.ports.now() + JOIN_HOLD_MS);
    this.write({ ...this.file, devices: this.file.devices.map((candidate) => candidate.id === row.id ? { ...candidate, hold_until: until } : candidate) });
  }

  private goLive(id: string): void {
    this.write({ ...this.file, devices: this.file.devices.map((row) => row.id === id && row.state === "hold" ? { ...row, state: "live", hold_until: null } : row) });
  }

  private usable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  private write(next: DevicesFile): void {
    for (let entry = this.pendingDrops[0]; entry; entry = this.pendingDrops[0]) {
      this.ports.journal(entry);
      this.pendingDrops.shift();
    }
    try {
      writePrivateState(this.path, { v: 1, server_id: this.serverId, ...next });
      this.file = next;
      this.rowsChanged?.(next.devices);
    } finally {
      // A failed admission save leaves the previous rows in memory, not the journalled candidate.
      this.ports.settleNotices?.(this.file.devices);
    }
  }
}
