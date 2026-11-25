/**
 * The PC's own account state (P12, OD1): `account-pc.json` `{v, next_admit, binding, clears, first, others_ever}`.
 * The PC's account is this file's binding, not "some row names an account": the first link binds it in the turn that
 * writes its row (T13, T59), the last member leaving changes nothing (T30), and only Revoke all, a relay identity
 * reset or a person at the PC clears it. A clear is kept in `clears`, which is never cut, and the file is never deleted.
 * `next_admit` numbers the admissions on this PC (P22, server/account/admission-order.ts).
 *
 * Fails closed (S19): a file that cannot be read, that is missing beside a device journal, or rows of two accounts at
 * the one-time migration (T50). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { logAccess } from "../connection-diagnostics.ts";
import { ADMISSION_FILE, type OriginFrom, type OriginHow, type RowOrigin } from "./admission-order.ts";
import { DEVICE_JOURNAL_FILE } from "./safety-log.ts";

/**
 * Whether the account file of `stateDir` holds a binding that is pinned to a signed list. Read before anything else at
 * a start, with no handle taken: a pin is one-way, so a PC that holds one follows its list whatever this start was
 * told of Step 2. A file that is not there, or does not read, says no; what is wrong with it is said where it is opened.
 */
export function listPinOnDisk(stateDir: string): boolean {
  try {
    const doc = parseDoc(JSON.parse(readFileSync(join(realFolder(stateDir), ADMISSION_FILE), "utf8")));
    if (typeof doc === "string") return false;
    const { binding } = doc;
    return binding !== null && binding.pending !== true && binding.list !== undefined && !doc.clears.some((clear) => clear.bind_id === binding.bind_id);
  } catch { return false; }
}

/**
 * Whether the folder's account state keeps that an account's signed list removed this PC while it had the relay
 * identity `serverId`: read at a start, where that word must stand whatever the start is told (a PC that is no
 * longer pinned, with Step 2 off, would otherwise know nothing of it and be linked back).
 */
export function listRemovalOnDisk(stateDir: string, serverId: string | undefined): boolean {
  if (serverId === undefined) return false;
  try {
    const doc = parseDoc(JSON.parse(readFileSync(join(realFolder(stateDir), ADMISSION_FILE), "utf8")));
    return typeof doc !== "string" && doc.clears.some((clear) => clear.removed_as?.server_id === serverId);
  } catch { return false; }
}

/** `unlisted`: a PC bound on the account service's word that the account stopped listing (one press, docs/account.md) */
export type ClearReason = "revoke_all" | "identity_reset" | "unlisted";
/** How long a PC a device's link just brought into an account waits for that device to list it, before a missing listing counts as a removal. */
export const FIRST_LISTING_MS = 10 * 60_000;
/** Who made an `unlisted` clear when the PC did it itself: its older one-press binding named no listing the account service still confirms. */
export const UNPINNED_CLEAR = "unpinned";
/** Who made an `unlisted` clear when the account's signed list removed this PC: an entry a member signed, never the account service's word. */
export const LIST_REMOVED = "list";
// A receipt written by an older version still invalidates its bind_id; new clears cannot emit that reason.
/** `admits`: this PC's next admission number when it cleared, so what it admitted since can be told from what it kept. */
/**
 * `removed_as`: the account's signed list removed this PC (`by` LIST_REMOVED): the account it was removed from and the
 * relay identity it had. That identity joins that account again on no path.
 */
export interface AccountClear { readonly bind_id: string; readonly reason: ClearReason | "left_on_pc"; readonly by: string; readonly admits?: number; readonly removed_as?: { readonly account: string; readonly server_id: string } }
export interface AccountBinding {
  readonly account: string;
  readonly bind_id: string;
  /** a first link's binding, on disk before its row: it stands only once the row is (T13) */
  readonly pending?: true;
  /** bound in one press, on the account service's word for the account this PC's owner named; no row made it */
  readonly service?: true;
  /**
   * The account's listing this PC stands on. Bound in one press: the listing it was admitted in, asked about by its
   * scoped receipt. Bound by a device's link: the listing its account rows were first let in under, compared with the
   * one the account names at each pull.
   */
  readonly listing_id?: string;
  /**
   * A device's link made this binding a moment ago, and that device lists the PC only after its link: until this time,
   * or the first listing named, a read that finds the PC not listed is no removal.
   */
  readonly listing_due?: string;
  /**
   * The account's signed list this PC is pinned to (server/account/list-follow.ts): from then on it lets the account's
   * devices in by that list alone. Set once, by a person's act at this PC and an entry of that list for this PC's own
   * key; it ends only with the binding.
   */
  readonly list?: string;
  /**
   * The PC was shown two histories of that list that members signed. Kept with the pin, not with the copy of the list:
   * a copy that is lost and read again shows one history only, and must not lift what the alarm held back. It ends
   * only with the binding.
   */
  readonly list_alarm?: true;
}

interface ServiceStep2 {
  readonly bind_id: string;
  readonly revision: number;
  readonly off: boolean;
}

interface PcDoc {
  /**
   * 2 on disk while the file holds a pin or a list's removal of the PC, 1 otherwise (onDisk). An Ovis from before the
   * list reads version 1 alone and takes any other for a file it cannot trust: it then lets nobody of the account in,
   * where it would otherwise hold the binding with no pin and go by the account service's word again.
   */
  v: 1 | 2;
  next_admit: number;
  binding: AccountBinding | null;
  clears: AccountClear[];
  /** the first-device fact (T67): the key of the row whose link bound the PC; `list_key` only when a link proved it */
  first: { key: string; list_key: string | null } | null;
  /** set by the first admission of another account row and never unset (H2) */
  others_ever: boolean;
  /** P14: raised by every denial and policy change; a decision that widens commits only at the gen it noted */
  gen: number;
  /** the removal evidence was on disk once: its file missing since is damage, never a fresh start (S19) */
  evidence_written?: true;
  /** A listed PC's explicit service opt-out cannot be undone by a named recovery release. */
  service_step2?: ServiceStep2;
}

const REASONS: ReadonlySet<string> = new Set(["revoke_all", "identity_reset", "left_on_pc", "unlisted"]);
const ID = /^[0-9a-f]{32}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const LIST = /^[0-9a-f]{64}$/;

function parseDoc(value: unknown): (PcDoc & { counterOnly?: true }) | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not this PC's account state";
  const doc = value as Partial<PcDoc>;
  if (doc.v !== 1 && doc.v !== 2) return "unknown version";
  if (!Number.isSafeInteger(doc.next_admit) || doc.next_admit! < 1) return "invalid next_admit";
  // S2-03 wrote the counter alone: the binding is not migrated yet, and the upgrade takes it from the rows (T50)
  if (doc.binding === undefined && doc.clears === undefined && doc.first === undefined && doc.others_ever === undefined) {
    return { v: 1, next_admit: doc.next_admit!, binding: null, clears: [], first: null, others_ever: false, gen: 0, counterOnly: true };
  }
  const binding = doc.binding;
  if (binding !== null && !(typeof binding === "object" && binding !== undefined && typeof binding.account === "string" && ACCOUNT.test(binding.account) && typeof binding.bind_id === "string" && ID.test(binding.bind_id) && (binding.pending === undefined || binding.pending === true) && (binding.service === undefined || (binding.service === true && binding.pending === undefined)))) return "invalid binding";
  if (binding?.listing_id !== undefined && (binding.pending === true || typeof binding.listing_id !== "string" || !ID.test(binding.listing_id))) return "invalid listing";
  if (binding?.listing_due !== undefined && (binding.service === true || typeof binding.listing_due !== "string" || Number.isNaN(Date.parse(binding.listing_due)))) return "invalid listing wait";
  if (binding?.list !== undefined && (binding.pending === true || typeof binding.list !== "string" || !LIST.test(binding.list))) return "invalid list";
  if (binding?.list_alarm !== undefined && (binding.list_alarm !== true || binding.list === undefined)) return "invalid list alarm";
  if (!Array.isArray(doc.clears) || !doc.clears.every((clear) => typeof clear === "object" && clear !== null && typeof clear.bind_id === "string" && ID.test(clear.bind_id) && REASONS.has(clear.reason) && typeof clear.by === "string"
    && (clear.admits === undefined || (Number.isSafeInteger(clear.admits) && clear.admits >= 0))
    && (clear.removed_as === undefined || (typeof clear.removed_as === "object" && clear.removed_as !== null && typeof clear.removed_as.account === "string" && ACCOUNT.test(clear.removed_as.account)
      && typeof clear.removed_as.server_id === "string" && ID.test(clear.removed_as.server_id))))) return "invalid clears";
  if (binding !== null && doc.clears.some((clear) => clear.bind_id === binding.bind_id)) return "a cleared binding stands";
  const first = doc.first;
  if (first !== null && !(typeof first === "object" && first !== undefined && typeof first.key === "string" && (first.list_key === null || typeof first.list_key === "string"))) return "invalid first";
  if (typeof doc.others_ever !== "boolean") return "invalid others_ever";
  if (doc.evidence_written !== undefined && doc.evidence_written !== true) return "invalid evidence_written";
  const step2 = doc.service_step2;
  if (step2 !== undefined && (step2 === null || typeof step2 !== "object" || typeof step2.bind_id !== "string"
    || !ID.test(step2.bind_id) || !Number.isSafeInteger(step2.revision) || step2.revision < 0 || typeof step2.off !== "boolean")) return "invalid service_step2";
  if (doc.gen === undefined) return { ...doc, gen: 0 } as PcDoc;
  if (!Number.isSafeInteger(doc.gen) || doc.gen < 0) return "invalid gen";
  return doc as PcDoc;
}

/** A lock file nobody removed for this long was left by a server that ended while it wrote. */
const LOCK_STALE_MS = 10_000;
/** How long one write waits for another server's write of the same file. */
const LOCK_WAIT_MS = 500;
/** The wall clock, whatever a test set `Date.now` to: a lock's age is real time. */
const wallNow = (): number => performance.timeOrigin + performance.now();

/**
 * One writer of `path` at a time, among every Ovis server that shares the folder (two can run on one state folder):
 * what `work` reads of the file it then writes is what is there. A lock another server holds is waited for, briefly;
 * a write that cannot have it fails, with nothing written.
 */
export function withFileLock<T>(path: string, work: () => T): T {
  const lock = `${path}.lock`;
  const deadline = performance.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try { closeSync(bindingFs.openSync(lock, "wx", 0o600)); held = true; break; } catch (error) {
      // nothing is written without the lock: a folder that takes no lock file ends the write with an error
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`${path} cannot be locked (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
      let age = Number.POSITIVE_INFINITY;
      try { age = wallNow() - statSync(lock).mtimeMs; } catch { /* gone meanwhile: taken at the next turn */ }
      // a lock left by a server that ended while it wrote is taken over. One that cannot be deleted is waited for
      // like any other, and no longer: the wait ends in an error, never in a loop
      if (age > LOCK_STALE_MS) { try { bindingFs.unlinkSync(lock); continue; } catch (gone) { if ((gone as NodeJS.ErrnoException).code === "ENOENT") continue; } }
      if (performance.now() >= deadline) throw new Error(`${path} is being written by another Ovis on this PC`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return work(); } finally { if (held) { try { bindingFs.unlinkSync(lock); } catch { /* already gone */ } } }
}

/** What the lock is made and deleted with and the file read with: one place, so a test can make a lock that will not go and a read that fails. */
export const bindingFs = { openSync, unlinkSync, readFileSync };

/**
 * The document a file holds now; null only when there is no file. A file that is there and cannot be read, or does
 * not read as this PC's account state, throws: it is never taken for no document, since a write made on that word
 * would replace whatever the file holds (a pin another server wrote) with what this server remembers.
 */
function docOnDisk(path: string): PcDoc | null {
  let text: string;
  try { text = bindingFs.readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }
  let parsed: ReturnType<typeof parseDoc>;
  try { parsed = parseDoc(JSON.parse(text)); } catch { throw new Error(`${path} is not JSON`); }
  if (typeof parsed === "string") throw new Error(`${path} cannot be trusted: ${parsed}`);
  const { counterOnly: _counterOnly, ...doc } = parsed;
  return doc;
}

/** What tells one state of a file from the next without reading it. */
const stamp = (path: string): string | null => {
  try { const { mtimeMs, size, ino } = statSync(path); return `${mtimeMs} ${size} ${ino}`; } catch { return null; }
};

const standingIn = (doc: PcDoc): AccountBinding | null => {
  const { binding } = doc;
  return binding !== null && binding.pending !== true && !doc.clears.some((clear) => clear.bind_id === binding.bind_id) ? binding : null;
};

/**
 * What a server may write over the file as it is on disk (`disk`), when it held `base` and meant to write `next`.
 * Two Ovis servers can run on one state folder, so what one holds in memory may be older than the file:
 * - a clear the file holds is never lost, and a binding it holds cleared never comes back from memory;
 * - a pin the file holds, and an alarm beside it, are never lost;
 * - a write that touches no binding leaves the file's binding as it is;
 * - a write that would end, on the account service's word, a binding the file holds pinned is refused
 *   (PinnedOnDiskError): only an act at the PC, or the list's own removal of the PC, ends a pinned binding;
 * - the counters never go back, and a number given is one the file had not given.
 */
function reconciled(base: PcDoc, next: PcDoc, disk: PcDoc | null, path: string): PcDoc {
  if (disk === null) return next;
  const clears = mergeClears(disk.clears, next.clears);
  const cleared = (binding: AccountBinding | null) => binding !== null && clears.some((clear) => clear.bind_id === binding.bind_id);
  const pinOf = (binding: AccountBinding | null) => binding !== null && binding.pending !== true && binding.list !== undefined ? binding : null;
  const diskPin = cleared(disk.binding) ? null : pinOf(standingIn(disk));
  const same = (a: AccountBinding | null, b: AccountBinding | null) => JSON.stringify(a) === JSON.stringify(b);
  let binding: AccountBinding | null;
  if (same(base.binding, next.binding)) {
    // this write is about something else: the binding is the file's when the file holds a standing one, else the one
    // this server holds, unless a clear ends it
    binding = disk.binding !== null && !cleared(disk.binding) ? disk.binding : cleared(next.binding) ? null : next.binding;
  } else if (next.binding === null) {
    // this server ends the binding it held. One the file holds pinned is ended only by an act at the PC or by its list
    const ended = base.binding === null ? undefined : next.clears.find((clear) => clear.bind_id === base.binding!.bind_id);
    const pin = pinOf(standingIn(disk));
    if (pin !== null && base.binding?.bind_id === pin.bind_id && ended !== undefined && ended.reason === "unlisted" && ended.removed_as === undefined) {
      throw new PinnedOnDiskError(`${path} holds this PC pinned to its account's list: nothing but an act at this PC, or the list itself, ends that`);
    }
    // another binding the file holds meanwhile is not this server's to end
    binding = disk.binding !== null && disk.binding.bind_id !== base.binding?.bind_id && !cleared(disk.binding) ? disk.binding : null;
  } else if (cleared(next.binding)) {
    binding = cleared(disk.binding) ? null : disk.binding;
  } else if (disk.binding !== null && !cleared(disk.binding) && disk.binding.bind_id !== next.binding.bind_id) {
    // the file holds another standing binding than the one this server means to write: the file's stands
    binding = disk.binding;
  } else {
    binding = next.binding;
    if (diskPin !== null && diskPin.bind_id === binding.bind_id) {
      if (binding.list !== undefined && binding.list !== diskPin.list) throw new PinnedOnDiskError(`${path} holds this PC pinned to another list`);
      binding = { ...binding, list: diskPin.list, ...(diskPin.list_alarm === true || binding.list_alarm === true ? { list_alarm: true as const } : {}) };
    }
  }
  const step = (now: number, was: number, held: number) => Math.max(now, held + Math.max(0, now - was));
  const doc: PcDoc = {
    ...next, binding, clears,
    next_admit: step(next.next_admit, base.next_admit, disk.next_admit),
    gen: step(next.gen, base.gen, disk.gen),
    others_ever: next.others_ever || disk.others_ever,
    first: next.first ?? disk.first,
  };
  if (disk.evidence_written === true) doc.evidence_written = true;
  if (JSON.stringify(next.service_step2) === JSON.stringify(base.service_step2) && disk.service_step2 !== undefined) doc.service_step2 = disk.service_step2;
  return doc;
}

/** The binding the file holds after a PC bound itself by its list (PcAccountState.bindByList). `won`: it is the one this write made. */
export interface ListBound { readonly id: string; readonly account: string; readonly list: string | null; readonly won: boolean }

/** A bind of a PC that the account's list removed under this relay identity, found in the file under its lock: nothing is written. */
export class RemovedOnDiskError extends Error {}

/** A write that would end, on the account service's word, a binding the file on disk holds pinned: refused, whoever holds an older document. */
export class PinnedOnDiskError extends Error {}

/** The file as it is written: its version says whether an Ovis that knows no list may read it (PcDoc.v). */
function onDisk(doc: PcDoc): PcDoc {
  return { ...doc, v: doc.binding?.list !== undefined || doc.clears.some((clear) => clear.removed_as !== undefined) ? 2 : 1 };
}

/**
 * The clears of two folders of one PC, one per binding. Where both cleared the same binding, the one that says the
 * account's list removed the PC stands, whichever folder holds it and whichever of them reads the other: a removal
 * by the list is never lost to an owner's clear of the same binding. Otherwise the other folder's, as before.
 */
function mergeClears(mine: readonly AccountClear[], theirs: readonly AccountClear[]): AccountClear[] {
  const merged = new Map<string, AccountClear>();
  for (const clear of [...mine, ...theirs]) {
    const held = merged.get(clear.bind_id);
    if (held === undefined || held.removed_as === undefined || clear.removed_as !== undefined) merged.set(clear.bind_id, clear);
  }
  return [...merged.values()];
}

function serviceStep2(doc: PcDoc, binding: AccountBinding | null): ServiceStep2 | undefined {
  return binding !== null && doc.service_step2?.bind_id === binding.bind_id ? doc.service_step2 : undefined;
}

/** A folder by what it is on disk, so a link to it and its real path are one folder (P21). */
function realFolder(stateDir: string): string {
  try { return realpathSync(stateDir); } catch { return resolve(stateDir); }
}

/** The one handle of each folder's account state in this process (P21). */
const HANDLES = new Map<string, PcAccountState>();

export class PcAccountState {
  private readonly bindingListeners = new Set<() => void>();

  onBindingChange(listener: () => void): () => void {
    this.bindingListeners.add(listener);
    return () => { this.bindingListeners.delete(listener); };
  }
  private doc: PcDoc = { v: 1, next_admit: 1, binding: null, clears: [], first: null, others_ever: false, gen: 0 };
  private problem: string | null = null;
  /** no file and no journal: this folder's rows predate the release, and are migrated once (T50) */
  private fresh = false;

  private constructor(private readonly path: string) {}

  /**
   * The one handle of `stateDir`'s account state in this process, read again from disk: no two handles of one folder
   * give numbers (P21), whatever path names it.
   */
  static open(stateDir: string): PcAccountState {
    const path = join(realFolder(stateDir), ADMISSION_FILE);
    const state = HANDLES.get(path) ?? new PcAccountState(path);
    HANDLES.set(path, state);
    state.doc = { v: 1, next_admit: 1, binding: null, clears: [], first: null, others_ever: false, gen: 0 };
    state.problem = null;
    state.fresh = false;
    state.upgradingFrom = false;
    state.siblingBinding = null;
    // what the file is as this handle reads it: looking again costs nothing until it changes (refresh)
    state.seen = stamp(state.path);
    let text: string;
    try { text = readFileSync(state.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") state.problem = `Cannot read ${state.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(stateDir, DEVICE_JOURNAL_FILE))) state.problem = `${state.path} is missing beside the device journal`;
      else state.fresh = true;
      return state;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { state.problem = `${state.path} is not JSON`; return state; }
    const parsed = parseDoc(value);
    if (typeof parsed === "string") state.problem = `${state.path} cannot be trusted: ${parsed}`;
    else {
      const { counterOnly, ...doc } = parsed;
      state.upgradingFrom = counterOnly === true;
      state.doc = doc;
    }
    return state;
  }

  /**
   * This folder's own rows as they are on disk before a sibling merge can remove any (P21, S29): a missing file beside
   * a row it numbered, or one at or behind such a number, is damage. Run before the merge.
   */
  checkRows(rows: readonly { readonly origin?: RowOrigin | undefined }[]): void {
    const numbers = rows.flatMap((row) => row.origin === undefined || row.origin.from === "legacy" ? [] : [row.origin.admit_no]);
    if (numbers.length === 0) return;
    if (this.fresh) this.missingBeside();
    else this.checkAbove(numbers);
  }

  /**
   * A first link's binding left pending by a stop (T13): it stands when its row reached the disk, and bound nothing
   * when it did not.
   */
  settlePending(rowOnDisk: (binding: AccountBinding, firstKey: string | null) => boolean): void {
    const binding = this.doc.binding;
    if (binding?.pending !== true || this.problem !== null) return;
    const { pending: _left, ...standing } = binding;
    this.write(rowOnDisk(standing, this.doc.first?.key ?? null) ? { ...this.doc, binding: standing } : { ...this.doc, binding: null, first: null });
  }

  /** Member rows of an account this PC is not in: the binding and the rows disagree, which is damage (P12, S19). */
  checkMembers(accounts: readonly string[]): void {
    const bound = this.doc.binding?.account ?? null;
    const other = accounts.find((account) => account !== bound);
    if (this.problem === null && other !== undefined) this.problem = `this PC's devices name ${other}, and ${this.path} binds it to ${bound ?? "no account"}`;
  }

  /** A row numbered at or past the next number: the file is behind its rows, which is damage (P21). */
  checkAbove(numbers: readonly number[]): void {
    const highest = Math.max(0, ...numbers);
    if (this.problem === null && highest >= this.doc.next_admit) this.problem = `${this.path} is behind the number ${highest} a row here carries`;
  }

  /** The one-time migration could not be written: this PC's account state is unknown, so it fails closed (S19). */
  /** `what` could not be written to this file: the PC's account state is unknown until it is (S19). */
  unwritten(error: unknown, what = "The rows from before the upgrade could not be migrated"): void {
    if (this.problem !== null) return;
    this.fresh = false;
    this.problem = `${what} in ${this.path} (${error instanceof Error ? error.message : String(error)})`;
  }

  /** A folder whose rows already carry numbers lost this file: damage, not a migration (P21, S19). */
  missingBeside(): void {
    this.fresh = false;
    this.problem = `${this.path} is missing beside rows this PC numbered`;
  }

  /** Why this PC fails closed, or null: no device gets in while its account state cannot be known. */
  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the account state is restored.`;
  }

  get migrating(): boolean { return (this.fresh || this.upgrading) && this.problem === null; }

  /** S2-03's counter file, read: the rows are numbered already, and only the binding is migrated (T50). */
  get upgrading(): boolean { return this.upgradingFrom && this.problem === null; }
  private upgradingFrom = false;

  /** A standing binding of the sibling folder, taken by this folder's migration (P12). */
  private siblingBinding: AccountBinding | null = null;

  /**
   * The sibling folder's account file, read before this folder's binding is trusted (P12, T59): a bind_id either folder
   * lists among its clears never stands, and two standing bindings to different accounts fail closed. The clears of
   * both are kept here; the count stays this folder's own. A file that cannot be read fails closed (S19).
   *
   * A pin is never taken from the other folder: the list knows this PC by the keys in the folder that pinned, and that
   * folder holds the copy and what it owes. A folder whose other folder holds a pin it does not hold itself is closed
   * (it lets only this PC itself in and writes nothing of its own), and says which folder holds the pin.
   */
  takeSibling(siblingDir: string): void {
    if (this.problem !== null) return;
    const path = join(realFolder(siblingDir), ADMISSION_FILE);
    let parsed: ReturnType<typeof parseDoc>;
    try { parsed = parseDoc(JSON.parse(readFileSync(path, "utf8"))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.problem = `${path} cannot be read (${error instanceof Error ? error.message : String(error)})`;
      return;
    }
    if (typeof parsed === "string") { this.problem = `${path} cannot be trusted: ${parsed}`; return; }
    const clears = mergeClears(this.doc.clears, parsed.clears);
    const standing = (binding: AccountBinding | null) => binding !== null && binding.pending !== true && !clears.some((clear) => clear.bind_id === binding.bind_id) ? binding : null;
    const mine = standing(this.doc.binding);
    const theirs = standing(parsed.binding);
    if (mine !== null && theirs !== null && mine.account !== theirs.account) { this.problem = `${this.path} and ${path} bind this PC to two accounts`; return; }
    if (mine !== null && theirs !== null && mine.bind_id === theirs.bind_id && mine.list !== undefined && theirs.list !== undefined && mine.list !== theirs.list) { this.problem = `${this.path} and ${path} pin this PC to two lists`; return; }
    const shared = mine !== null && theirs !== null && mine.bind_id === theirs.bind_id;
    // an alarm either folder kept for a pin both hold is the binding's
    const own = shared && mine.list !== undefined && theirs.list === mine.list && theirs.list_alarm === true && mine.list_alarm !== true ? { ...mine, list_alarm: true as const } : mine;
    this.siblingBinding = theirs;
    const doc = { ...this.doc, binding: own, clears, others_ever: this.doc.others_ever || parsed.others_ever };
    const sharedStep2 = (binding: AccountBinding | null) => {
      const mine = serviceStep2(this.doc, binding);
      const other = serviceStep2(parsed, binding);
      // A reconciliation supersedes the off decision it observed. An independent concurrent off wins a tie.
      if (mine === undefined || (other !== undefined && (other.revision > mine.revision
        || (other.revision === mine.revision && other.off)))) return other;
      return mine;
    };
    const activeBinding = own ?? theirs;
    const activeStep2 = sharedStep2(activeBinding);
    if (activeStep2) doc.service_step2 = activeStep2;
    // A pin the other folder holds and this one does not: this folder takes no part in the account. The list knows
    // this PC by the keys of the folder that pinned, which also holds the copy and what it owes; a second copy of
    // them here could disagree with it. It is decided here, before anything is written: a closed folder writes nothing, to itself or to the other
    if (theirs !== null && theirs.list !== undefined && !(mine !== null && mine.bind_id === theirs.bind_id && mine.list === theirs.list)) {
      this.problem = `This PC is pinned to its account's signed list in ${realFolder(siblingDir)}, and this copy of Ovis (${realFolder(join(this.path, ".."))}) does not hold that pin. Use Ovis from ${realFolder(siblingDir)}`;
      return;
    }
    // Both folders keep the clears and the service opt-out for the binding they hold.
    const siblingStep2 = sharedStep2(theirs);
    // the other folder learns a clear it does not hold, and a list's removal where it holds the same binding's clear without it
    const siblingLacks = parsed.clears.length !== clears.length
      || clears.some((clear) => clear.removed_as !== undefined && !parsed.clears.some((held) => held.bind_id === clear.bind_id && held.removed_as !== undefined));
    if (siblingLacks || (siblingStep2 && JSON.stringify(siblingStep2) !== JSON.stringify(parsed.service_step2))) {
      try {
        // under that file's own lock, onto what it holds at that moment: a pin, a binding or a clear a server in that
        // folder wrote since this one read it is kept
        withFileLock(path, () => {
          const current = docOnDisk(path) ?? parsed;
          const merged = mergeClears(current.clears, clears);
          const kept = current.binding !== null && !merged.some((clear) => clear.bind_id === current.binding!.bind_id) ? current.binding : null;
          const written: PcDoc = { ...current, clears: merged, binding: kept };
          if (siblingStep2) written.service_step2 = siblingStep2;
          writePrivateState(path, onDisk(written));
        });
      } catch (error) {
        this.problem = `${path} cannot learn this PC's account denials (${error instanceof Error ? error.message : String(error)})`;
        return;
      }
    }
    if (this.fresh) { this.doc = doc; return; }
    if (own === null && theirs !== null) { doc.binding = theirs; doc.first = this.doc.first ?? parsed.first; }
    if (JSON.stringify(doc) !== JSON.stringify(this.doc)) this.write(doc);
  }

  /**
   * The migration's check, before any row is touched: the rows' accounts. Rows of two accounts name no binding to
   * take, so the PC fails closed and nothing is written (T50).
   */
  migrationAccount(rows: readonly { account?: string | undefined }[]): string | null {
    const accounts = new Set(rows.flatMap((row) => row.account === undefined ? [] : [row.account]));
    if (accounts.size > 1) this.problem = `${this.path} is missing and this PC's devices name ${accounts.size} accounts`;
    return accounts.size === 1 ? [...accounts][0]! : null;
  }

  /** Ends the migration, once: a PC with rows has had other devices, so it never takes the first-device path (T67). */
  migrate(account: string | null, hadRows: boolean): void {
    if (!this.migrating) return;
    const sibling = this.siblingBinding;
    if (sibling !== null && account !== null && sibling.account !== account) { this.problem = `${this.path}: this PC's devices name ${account}, its other folder ${sibling.account}`; return; }
    const binding = sibling ?? (account === null ? null : { account, bind_id: randomBytes(16).toString("hex") });
    this.write({ ...this.doc, binding, others_ever: this.doc.others_ever || hadRows });
    this.fresh = false;
    this.upgradingFrom = false;
  }

  account(): string | null { return this.doc.binding?.account ?? null; }

  binding(): AccountBinding | null { return this.doc.binding; }

  clears(): readonly AccountClear[] { return this.doc.clears; }

  /**
   * The account stopped listing this PC (or its listing was replaced), and it is in none since: only an add a person
   * makes at this PC brings it into one again. It stands on the kept clear, so a restart keeps it, and ends with the
   * next binding. The number: the first admission made since that clear; for a clear from before they were kept, since
   * this version first read it.
   */
  addAtPcSince(): number | null {
    const last = this.doc.clears.at(-1);
    if (this.doc.binding !== null || last?.reason !== "unlisted") return null;
    if (last.admits !== undefined) return last.admits;
    // a clear from before admissions were kept with it: what this PC admitted before it first reads the clear is from before
    if (this.problem !== null) return Number.MAX_SAFE_INTEGER;
    const admits = this.doc.next_admit;
    // a folder that takes no write dates nothing: no approval counts until it does, and the PC starts all the same
    try { this.write({ ...this.doc, clears: [...this.doc.clears.slice(0, -1), { ...last, admits }] }); }
    catch { return Number.MAX_SAFE_INTEGER; }
    return admits;
  }

  gen(): number { return this.doc.gen; }

  /** All admissions already numbered here are strictly below this boundary, even with the PC clock set back. */
  nextAdmission(): number { return this.doc.next_admit; }

  /** A denial or a policy change reached the disk (P14): a decision that noted the old gen does not commit. */
  /** Whether this PC's removal evidence was on disk once (S19). */
  evidenceWritten(): boolean { return this.doc.evidence_written === true; }

  /** The removal evidence is on disk: from now on its file missing is damage (S19). Written once. */
  noteEvidenceWritten(): void {
    if (this.doc.evidence_written === true || this.problem !== null || this.fresh) return;
    this.write({ ...this.doc, evidence_written: true });
  }

  raiseGen(): void { this.write({ ...this.doc, gen: this.doc.gen + 1 }); }

  /** The first-device fact (T67): the key that bound the PC, and its proved sign-in key or null. */
  first(): { readonly key: string; readonly list_key: string | null } | null { return this.doc.first; }

  othersEver(): boolean { return this.doc.others_ever; }

  /** The first admission of another account row sets it; nothing unsets it (H2). */
  setOthersEver(): void {
    if (!this.doc.others_ever) this.write({ ...this.doc, others_ever: true });
  }

  /** The first link binds the PC; returns what takes this write back, should the row it belongs to not be written. */
  bind(account: string, key: string): { commit: () => void; takeBack: () => void } {
    if (this.doc.binding !== null) throw new Error("This PC is already in an account");
    const { first, others_ever } = this.doc;
    const binding = { account, bind_id: randomBytes(16).toString("hex") };
    this.write({ ...this.doc, binding: { ...binding, pending: true }, first: { key, list_key: null }, others_ever: others_ever || this.doc.clears.length > 0 });
    return {
      // the row is on disk: the binding stands from here, whatever fails after (T13)
      commit: () => this.write({ ...this.doc, binding: { ...binding, listing_due: new Date(Date.now() + FIRST_LISTING_MS).toISOString() } }),
      // only the binding goes back; the count this turn took stays taken (P21)
      takeBack: () => this.write({ ...this.doc, binding: null, first, others_ever }),
    };
  }


  /**
   * One press binds a PC in no account on the account service's word for `account`, the one its owner named here: no row
   * is written with it, so it stands at once, and no device is its first (T67).
   */
  bindByService(account: string, listingId?: string): void {
    if (this.doc.binding !== null) throw new Error("This PC is already in an account");
    this.write({ ...this.doc, binding: { account, bind_id: randomBytes(16).toString("hex"), service: true, listing_id: listingId }, first: null, others_ever: this.doc.others_ever || this.doc.clears.length > 0 });
  }

  /**
   * Binds a PC in no account to `account` by the account's signed list `list`: the PC has read that list itself and
   * found the entry that adds its own key, on a list a person at this PC confirmed. The binding is pinned to the list
   * from its first moment, so nothing the account service says ever let a device in under it. No row is written with it
   * and no device is its first (T67). Answers the binding the file holds once the write is done: another Ovis on this
   * folder that bound the PC meanwhile keeps its binding (reconciled), and `won` is false then.
   */
  bindByList(account: string, list: string, serverId: string): ListBound {
    if (this.doc.binding !== null) throw new Error("This PC is already in an account");
    if (!ACCOUNT.test(account) || !LIST.test(list)) throw new Error("A PC joins an account's list by the account's id and the list's id");
    const bind_id = randomBytes(16).toString("hex");
    // a PC that account's list removed under this relay identity joins it again on no path: asked of the file under its
    // lock, so a removal another Ovis on this folder wrote a moment ago counts
    this.write({ ...this.doc, binding: { account, bind_id, list }, first: null, others_ever: this.doc.others_ever || this.doc.clears.length > 0, gen: this.doc.gen + 1 }, (doc) => {
      if (doc.clears.some((clear) => clear.removed_as?.account === account && clear.removed_as.server_id === serverId)) throw new RemovedOnDiskError("This PC was removed from that account");
    });
    const held = standingIn(this.doc);
    if (held === null) throw new Error("This PC's binding was not written");
    return { id: held.bind_id, account: held.account, list: held.list ?? null, won: held.bind_id === bind_id };
  }

  pinListing(bindId: string, listingId: string): void {
    const binding = this.doc.binding;
    if (binding !== null && binding.pending !== true && binding.bind_id === bindId && binding.listing_id === undefined) {
      const { listing_due: _named, ...standing } = binding;
      this.write({ ...this.doc, binding: { ...standing, listing_id: listingId } });
    }
  }

  /**
   * Pins the binding `bindId` to the account's signed list `list`. One-way: a binding pinned to a list is pinned to no
   * other, and nothing here unpins. It raises `gen`, so no decision that widens on the account service's word and noted
   * the gen before commits after it (P14). False when that binding does not stand or is pinned to another list.
   */
  pinToList(bindId: string, list: string): boolean {
    const binding = this.doc.binding;
    if (binding === null || binding.pending === true || binding.bind_id !== bindId || !LIST.test(list)) return false;
    if (binding.list !== undefined) return binding.list === list;
    try { this.write({ ...this.doc, binding: { ...binding, list }, gen: this.doc.gen + 1 }); } catch (error) {
      // another server of this folder pinned it to another list meanwhile
      if (error instanceof PinnedOnDiskError) return false;
      throw error;
    }
    return this.doc.binding?.list === list;
  }

  /** Keeps with the binding `bindId` that its list raised an alarm. One-way, as the pin is. False when that binding is not pinned, or the write failed. */
  alarmList(bindId: string): boolean {
    const binding = this.doc.binding;
    if (binding === null || binding.pending === true || binding.bind_id !== bindId || binding.list === undefined) return false;
    if (binding.list_alarm === true) return true;
    try { this.write({ ...this.doc, binding: { ...binding, list_alarm: true } }); } catch { return false; }
    return this.doc.binding?.list_alarm === true;
  }

  /** Whether the account's signed list removed this PC from `account` while it had the relay identity `serverId` (AccountClear.removed_as). */
  removedByList(account: string, serverId: string): boolean {
    return this.doc.clears.some((clear) => clear.removed_as?.account === account && clear.removed_as.server_id === serverId);
  }

  /**
   * Whether the PC may be reset as the new PC that the account's list removed it from `account` under the relay
   * identity `serverId` (`removed`), read from the file under its lock, so what another Ovis on this folder wrote
   * counts: `in_account` while the PC is in an account (one it joined since included, or one it is joining), and
   * `not_removed` where that list did not remove that identity. The reset asks it in the turn that resets.
   */
  readdReset(account: string, serverId: string): "removed" | "in_account" | "not_removed" {
    if (this.problem !== null) return "not_removed";
    let doc: PcDoc;
    try {
      doc = withFileLock(this.path, () => {
        const disk = docOnDisk(this.path);
        return disk === null ? this.doc : reconciled(this.doc, this.doc, disk, this.path);
      });
    } catch { return "not_removed"; }
    const binding = doc.binding;
    if (binding !== null && !doc.clears.some((clear) => clear.bind_id === binding.bind_id)) return "in_account";
    return doc.clears.some((clear) => clear.removed_as?.account === account && clear.removed_as.server_id === serverId) ? "removed" : "not_removed";
  }

  /** Whether this binding still waits for the device that made it to list the PC (AccountBinding.listing_due). */
  awaitsFirstListing(now = Date.now()): boolean {
    const due = this.doc.binding?.listing_due;
    // a wall clock set back far enough to make the wait longer than it ever is ends it
    return due !== undefined && now < Date.parse(due) && Date.parse(due) - now <= FIRST_LISTING_MS;
  }

  /** The PC leaves its account: only for one of the named reasons. The clear is kept, and the file stays. */
  /** `removedAs`: the relay identity this PC has, when the account's signed list removed it (`by` LIST_REMOVED). */
  clear(reason: ClearReason, by: string, removedAs?: string): boolean {
    const binding = this.doc.binding;
    // a PC already strict writes nothing: what it was told to clear waits for its repair, and it serves nobody meanwhile
    if (binding === null || this.problem !== null) return false;
    const removed = removedAs === undefined ? {} : { removed_as: { account: binding.account, server_id: removedAs } };
    try { this.write({ ...this.doc, binding: null, clears: [...this.doc.clears, { bind_id: binding.bind_id, reason, by, admits: this.doc.next_admit, ...removed }], gen: this.doc.gen + 1 }); } catch (error) {
      // pinned on disk by another server of this folder: the account service's word clears nothing
      if (error instanceof PinnedOnDiskError) return false;
      throw error;
    }
    logAccess({ event: "account.binding.cleared", reason });
    return true;
  }

  /** The origin of a row being admitted now; its number is on disk before the row is, so none is ever used twice. */
  admit(from: OriginFrom, how: OriginHow, by: string | null, now: number): RowOrigin {
    // nothing is numbered before the one-time migration has run (T50): it decides where the count starts
    if (this.fresh) throw new Error(`${this.path}: the rows from before the upgrade are not migrated yet`);
    this.write({ ...this.doc, next_admit: this.doc.next_admit + 1 });
    // the number the file had not given: another server of this folder may have given numbers since this one read it
    return { from, how, by, admit_no: this.doc.next_admit - 1, at: new Date(now).toISOString() };
  }

  serviceStep2Off(): boolean {
    return serviceStep2(this.doc, this.binding())?.off === true;
  }

  setServiceStep2Off(off: boolean): boolean {
    const binding = this.binding();
    if (binding === null) return false;
    const prior = serviceStep2(this.doc, binding);
    if ((prior?.off ?? false) === off) return false;
    const revision = (prior?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("The service's Step 2 revision is exhausted");
    try { this.write({ ...this.doc, service_step2: { bind_id: binding.bind_id, revision, off } }); }
    catch (error) {
      this.unwritten(error, "The service's Step 2 status could not be saved");
      throw error;
    }
    return true;
  }

  /** `check`: asked of what would be written, under the lock; a throw writes nothing. */
  private write(next: PcDoc, check?: (doc: PcDoc) => void): void {
    if (this.problem !== null) throw new Error(this.strict!);
    // The provisional first-link write and its rollback both represent no committed binding.
    const committedId = (binding: AccountBinding | null) => binding?.pending ? undefined : binding?.bind_id;
    const before = committedId(this.doc.binding);
    const pinned = this.doc.binding?.list;
    withFileLock(this.path, () => {
      // read, reconcile, write, as one turn: what another server of this folder wrote meanwhile is never written over
      const doc = reconciled(this.doc, next, docOnDisk(this.path), this.path);
      check?.(doc);
      writePrivateState(this.path, onDisk(doc));
      this.doc = doc;
      this.seen = stamp(this.path);
    });
    if (before !== committedId(this.doc.binding) || pinned !== this.doc.binding?.list) for (const listener of this.bindingListeners) listener();
  }

  /**
   * Takes into memory what another Ovis server on this folder wrote since this one read the file: a pin and its
   * alarm, and a clear of the binding this one still holds. Called at the moments that matter (before an unlisting,
   * before a read of the account's snapshot admits anybody) and every few seconds, so a second server decides as a
   * pinned PC, or as one that left its account, without waiting for a write of its own. It writes nothing; a file that
   * does not read changes nothing.
   */
  refresh(): void {
    if (this.problem !== null || this.fresh) return;
    // nothing is read while the file is the one this server last read or wrote
    const now = stamp(this.path);
    if (now === null || now === this.seen) return;
    let disk: PcDoc | null;
    try { disk = docOnDisk(this.path); } catch { return; }
    this.seen = now;
    if (disk === null) return;
    let doc: PcDoc;
    try { doc = reconciled(this.doc, this.doc, disk, this.path); } catch { return; }
    // told as a write of this server's own is: for another binding, or a pin, and for nothing else the file holds
    const committedId = (binding: AccountBinding | null) => binding?.pending ? undefined : binding?.bind_id;
    const changed = committedId(doc.binding) !== committedId(this.doc.binding) || doc.binding?.list !== this.doc.binding?.list;
    this.doc = doc;
    if (changed) for (const listener of this.bindingListeners) listener();
  }
  /** The file as this server last read or wrote it (stamp); null before either. */
  private seen: string | null = null;
}
