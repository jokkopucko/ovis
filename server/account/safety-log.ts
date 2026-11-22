/**
 * The PC's safety log (rule R2, row P24 of the account-opens-all design): blocks, freezes, lifts, locks, unlocks and
 * forgettings in one append-only, numbered file of this PC's own state, `account-log.json`. Entries are only ever
 * appended: none is edited or deleted, and an ending is a record of the same log that names what it ends. What is in
 * force (locked, the blocks, the freezes, the markers of blocks) is worked out from the log alone, at every open, and
 * is never kept anywhere as a second truth.
 *
 * Fails closed (S19 in its strict form): a log that cannot be read, that is missing from a state folder that keeps a
 * device journal, or that holds one id with two records, makes `strict` say why; a strict log appends nothing, so the
 * file it could not read is never written over. Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 *
 * One writer: the server process, through the one handle open() gives per folder. `ovis recover` and every other tool
 * change the log through the server's recovery socket (S2-15), never by writing this file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccountRecordError, parseSafetyRecord, type BlockRecord, type DeviceLiftRecord, type PcLiftRecord, type SafetyRecord, type SafetyRecordKind } from "../../shared/account-records.ts";
import { privateStateRefusal, writePrivateState } from "../private-state.ts";

export const SAFETY_LOG_FILE = "account-log.json";
/** The device journal (P15, S2-07). A state folder that has one has had a log since, so a missing log there is damage. */
export const DEVICE_JOURNAL_FILE = "device-journal.json";
/**
 * Beside the log: a block was dropped by a full waiting queue and the log could not take that mark (S10-2). The PC
 * then fails closed at every open, as the log's own `overflowed` would make it, until the queue's repair (S10-1).
 */
export const SAFETY_OVERFLOW_FILE = "account-log-overflowed.json";

/** How the record reached this PC; noted once and never compared (P24). */
export type SafetyGot = "handed" | "mailbox" | "snapshot" | "pc" | "session" | "merge";

/** What this PC's own table said when a block arrived (P21), kept with the entry and never changed. */
export interface BlockAsOf {
  readonly signer_no: number | null;
  readonly target_no: number | null;
  readonly after: number | null;
  readonly joined: number | null;
  readonly signer_removed: boolean;
  readonly legacy_created_at?: number;
  /** Account order proved the removal, not the target's place in this folder's admission order. */
  readonly target_only?: true;
}

/**
 * An entry: the record whole as shared/account-records.ts parses it (a device-signed one with its signature, so its
 * signed bytes are those of the record and its id is their hash), and what this PC added once and never changes.
 */
export interface SafetyEntry {
  readonly n: number;
  readonly got: SafetyGot;
  readonly record: SafetyRecord;
  readonly asof?: BlockAsOf;
}

export type SafetyReceipt =
  | { outcome: "applied"; id: string; n: number }
  | { outcome: "already_applied"; id: string }
  | { outcome: "refused"; id: string; code: "record_invalid" | "conflict" | "log_unavailable" };

/** A block whose target this PC cannot place yet (P19): it ends nobody and waits for a read that names its target. */
/**
 * Why a lift was appended (seam for S2-27): a whole read's snapshot, a confirm on this PC's screen, a block whose
 * signer left (orphan), `ovis recover --lift`, or a device-signed lift applied outside a snapshot (record). Closed: a
 * new producer does not compile without choosing one.
 */
export type LiftCause = "snapshot" | "screen" | "orphan" | "recover" | "record";
const LIFT_CAUSES: ReadonlySet<LiftCause> = new Set<LiftCause>(["snapshot", "screen", "orphan", "recover", "record"]);

/** What is appended; a lift must name its cause, and one that does not is refused (seam for S2-27). */
export interface SafetyAppend { readonly record: SafetyRecord; readonly got: SafetyGot; readonly asof?: BlockAsOf; readonly cause?: LiftCause }

export interface WaitingBlock { readonly record: BlockRecord; readonly got: SafetyGot; readonly signer_removed: boolean }
export const WAITING_MAX = 64;

export interface SafetyState {
  readonly locked: boolean;
  readonly locks: readonly SafetyEntry[];
  readonly blocks: readonly SafetyEntry[];
  /** service freezes and blocks in force: each closes this PC to the keys newer than its target (P23) */
  readonly freezes: readonly (SafetyEntry & { readonly targetOnlyCompanion?: true })[];
  /** blocks whose marker stands: no lift that says `forget` names them, whether or not they are in force */
  readonly markers: readonly SafetyEntry[];
}

/** A folded record: known and ended, its signed bytes dropped, its id never forgotten (P24). */
export interface FoldedRecord {
  readonly id: string;
  readonly kind: SafetyRecordKind;
  readonly account: string | null;
  readonly target: string | null;
  readonly ended_by: readonly string[];
}

interface LogFile {
  v: 1;
  next: number;
  /** folded records, one line each with no number: an id in it is known and ended (P24) */
  base: FoldedRecord[];
  entries: SafetyEntry[];
  /** P19's waiting blocks, at most WAITING_MAX: each with what this PC knew of its signer when it arrived */
  waiting: WaitingBlock[];
  /** A dropped waiting block keeps the log strict until repair; never cleared automatically (S19, P19). */
  readonly overflowed?: true;
}

const GOTS: ReadonlySet<string> = new Set(["handed", "mailbox", "snapshot", "pc", "session", "merge"]);

/** The id of a record this PC writes: random, made then, in the form shared/account-records.ts accepts. */
export function pcRecordId(): string {
  return randomBytes(16).toString("hex");
}

const isNo = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Why `record` is no record of the log, or null: the shared parser decides, and a block keeps what this PC knew. */
function recordProblem(record: unknown, asof: BlockAsOf | undefined): string | null {
  let parsed: SafetyRecord;
  try { parsed = parseSafetyRecord(record); } catch (error) {
    if (error instanceof AccountRecordError) return error.message;
    throw error;
  }
  if (parsed.kind === "block") {
    if (asof === undefined) return "a block keeps what this PC knew when it arrived";
    const a = asof as unknown as Record<string, unknown>;
    if (typeof a !== "object" || a === null || !isNo(a.signer_no) || !isNo(a.target_no) || !isNo(a.after) || !isNo(a.joined) || typeof a.signer_removed !== "boolean") return "invalid asof";
    const hasLegacyDate = Object.hasOwn(a, "legacy_created_at");
    const targetOnly = Object.hasOwn(a, "target_only");
    if (Object.keys(a).length !== 5 + Number(hasLegacyDate) + Number(targetOnly)
      || (targetOnly && (a.target_only !== true || a.joined !== null || hasLegacyDate))
      || (hasLegacyDate && (a.joined !== 0 || !Number.isSafeInteger(a.legacy_created_at)))) return "invalid asof";
  } else if (asof !== undefined) return "only a block keeps asof";
  return null;
}

/** Two copies of one record: the same fields with the same values, whatever order JSON kept them in. */
function sameRecord(a: SafetyRecord, b: SafetyRecord): boolean {
  const canonical = (record: SafetyRecord) => JSON.stringify(Object.entries(record).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
  return canonical(a) === canonical(b);
}

function parseLog(value: unknown): LogFile | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not a log";
  const file = value as Partial<LogFile>;
  if (file.v !== 1) return "unknown version";
  if (file.overflowed !== undefined && file.overflowed !== true) return "invalid overflow marker";
  if (!Number.isSafeInteger(file.next) || file.next! < 1) return "invalid next";
  if (!Array.isArray(file.base) || !file.base.every((line) => typeof line === "object" && line !== null && typeof line.id === "string")) return "invalid base";
  if (!Array.isArray(file.entries) || !Array.isArray(file.waiting)) return "invalid entries";
  if (file.waiting.length > WAITING_MAX || !file.waiting.every((item) => typeof item === "object" && item !== null && GOTS.has(item.got) && typeof item.signer_removed === "boolean"
    && recordProblem(item.record, { signer_no: null, target_no: null, after: null, joined: null, signer_removed: false }) === null && item.record.kind === "block")) return "invalid waiting blocks";
  const seen = new Map<string, SafetyRecord>();
  const numbers = new Set<number>();
  for (const id of file.base.map((line) => line.id)) {
    if (seen.has(id)) return `the folded id ${id} is held twice`;
    seen.set(id, { id } as SafetyRecord);
  }
  // every number this log gave is a whole entry or a folded line: a history with numbers that account for nothing
  // is none this writer made (P24)
  if (file.next! - 1 > file.entries.length + file.base.length) return `next ${String(file.next)} accounts for more records than the log holds`;
  for (const entry of file.entries as SafetyEntry[]) {
    if (typeof entry !== "object" || entry === null) return "an entry is an object";
    if (!Number.isSafeInteger(entry.n) || entry.n < 1 || entry.n >= file.next! || numbers.has(entry.n)) return `entry number ${String(entry.n)} is taken twice or past next`;
    numbers.add(entry.n);
    if (!GOTS.has(entry.got)) return "invalid got";
    const problem = recordProblem(entry.record, entry.asof);
    if (problem !== null) return `entry ${entry.n}: ${problem}`;
    const known = seen.get(entry.record.id);
    // one id with two records is a damaged log; the same record twice is one record that was written twice
    if (known !== undefined) return `the id ${entry.record.id} is held ${sameRecord(known, entry.record) ? "twice" : "by two different records"}`;
    seen.set(entry.record.id, entry.record);
  }
  return file as LogFile;
}

/**
 * Why another account may have written the log, or null: owned by another uid, or group- or other-writable. Such a
 * file is refused as it is, never repaired, since what it holds may already be someone else's (S19).
 */
function writableByOthers(path: string): string | null {
  if (process.platform === "win32") return null;
  let stats: Stats;
  try { stats = statSync(path); } catch { return null; }
  if (stats.uid !== process.getuid?.()) return `it is owned by uid ${stats.uid}`;
  return (stats.mode & 0o022) !== 0 ? `another account can write it (chmod 600 ${path} once it is known to be this PC's own)` : null;
}

/** What a strict log reads as: locked, so nothing that reads it before checking `strict` takes it as open. */
const STRICT_STATE: SafetyState = { locked: true, locks: [], blocks: [], freezes: [], markers: [] };

/** The one handle of each folder's log in this process (P24: one writer, one numbering). */
const HANDLES = new Map<string, SafetyLog>();

export class SafetyLog {
  private file: LogFile = { v: 1, next: 1, base: [], entries: [], waiting: [] };
  private readError: string | null = null;
  private writeError: string | null = null;

  /** What is in force, worked out at open and after every append: the replay runs before anything is served (T41). */
  inForce: SafetyState = { locked: false, locks: [], blocks: [], freezes: [], markers: [] };

  private constructor(private readonly path: string, private readonly stateDir: string) {}

  /**
   * The one handle of `stateDir`'s log in this process, read and replayed again from disk: a second open is the same
   * handle, so no two handles of one folder ever give numbers. Never throws: a log that cannot be trusted makes
   * `strict` say why, and so does `mergeProblem`, a merge with a sibling folder that could not be made (mergeSafetyLogs).
   */
  static open(stateDir: string, mergeProblem: string | null = null): SafetyLog {
    const path = resolve(stateDir, SAFETY_LOG_FILE);
    const log = HANDLES.get(path) ?? new SafetyLog(path, stateDir);
    HANDLES.set(path, log);
    log.readError = mergeProblem;
    log.writeError = null;
    if (mergeProblem === null) log.load();
    else log.inForce = STRICT_STATE;
    return log;
  }

  /**
   * The server that held this folder's handle stopped: the next open starts a fresh one. One server per state folder
   * runs in a process (createServer), so the handle is not counted; two servers on one folder are not supported.
   */
  close(): void {
    if (HANDLES.get(this.path) === this) HANDLES.delete(this.path);
  }

  /** Reads the file as open() does; false when the log is strict and must not be changed. */
  private load(): boolean {
    this.inForce = STRICT_STATE;
    // PC-written endings carry no signature: a log another account could write ends blocks and locks with one line
    const refused = writableByOthers(this.path) ?? privateStateRefusal(this.path);
    if (refused !== null) { this.readError = `${this.path} cannot be trusted: ${refused}`; return false; }
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.readError = `Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(this.stateDir, DEVICE_JOURNAL_FILE))) this.readError = `${this.path} is missing beside the device journal`;
      else if (this.file.next !== 1 || this.file.waiting.length !== 0) this.readError = `${this.path} is missing after this PC wrote it`;
      else if (this.overflowMarked()) this.file = { ...this.file, overflowed: true };
      else { this.inForce = this.state(); return true; }
      return false;
    }
    let parsed: LogFile | string;
    try { parsed = parseLog(JSON.parse(text)); } catch { parsed = "it is not JSON"; }
    if (typeof parsed === "string") { this.readError = `${this.path} cannot be trusted: ${parsed}`; return false; }
    this.file = this.overflowMarked() ? { ...parsed, overflowed: true } : parsed;
    if (this.file.overflowed) return false;
    this.inForce = this.state();
    return true;
  }

  /** Whether the overflow marker stands beside the log: anything but a clean "no such file" counts (S10-2). */
  private overflowMarked(): boolean {
    try { lstatSync(join(this.stateDir, SAFETY_OVERFLOW_FILE)); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  }

  /**
   * Why this PC fails closed, or null: nothing but this PC itself signs in until the log is put right. A failed append
   * counts until a reload finds the log whole (S19): nothing else is appended on this handle meanwhile.
   */
  get strict(): string | null {
    const why = this.reason;
    return why === null ? null : `${why}: only this PC itself gets in until the account safety log is restored.`;
  }

  entries(): readonly SafetyEntry[] { return this.file.entries; }

  /** Writes the log as it stands when there is no file yet: a folder with a journal always has one (P24). */
  ensureFile(): void {
    if (this.readError === null && !existsSync(this.path)) writePrivateState(this.path, this.file);
  }

  /** The ids of the `forget` records of `key` under `account`, folded ones included: what P13 asks of each removal. */
  forgets(key: string, account: string): string[] {
    return [...this.file.entries.map((entry) => entry.record), ...this.file.base]
      .filter((record) => record.kind === "forget" && record.target === key && record.account === account).map((record) => record.id);
  }

  /** The receipts of every block of `key` this log knows (T60): applied with its number while whole, already_applied once folded. */
  receipts(key: string): SafetyReceipt[] {
    const whole = this.file.entries.filter((entry) => entry.record.kind === "block" && entry.record.target === key).map((entry): SafetyReceipt => ({ outcome: "applied", id: entry.record.id, n: entry.n }));
    const folded = this.file.base.filter((line) => line.kind === "block" && line.target === key).map((line): SafetyReceipt => ({ outcome: "already_applied", id: line.id }));
    return [...whole, ...folded];
  }

  /**
   * The receipts of every block `key` signed that this log holds whole (T60 (2)): a refused sign-in of that key carries
   * them. A folded line keeps no signer, so a block folded here is no longer named this way. Only blocks signed under
   * `account`, the PC's binding: one signed under an earlier binding is no receipt of this account (seam for S2-24).
   */
  receiptsBySigner(key: string, account: string): SafetyReceipt[] {
    return this.file.entries.filter((entry) => entry.record.kind === "block" && entry.record.signer === key && entry.record.account === account).map((entry) => ({ outcome: "applied", id: entry.record.id, n: entry.n }));
  }

  /** Every block id this log knows, whole or folded: a snapshot's blocks this PC already holds. */
  blockIds(): string[] {
    return [...this.file.entries.filter((entry) => entry.record.kind === "block").map((entry) => entry.record.id), ...this.file.base.filter((line) => line.kind === "block").map((line) => line.id)];
  }

  /**
   * The lock (P11): written by the log itself, signed `pc`, under the account this PC is bound to; refused with no
   * binding, since a PC in no account has no strict mode in this release.
   */
  appendLock(binding: { readonly account: string } | null): SafetyReceipt {
    if (binding === null) return { outcome: "refused", id: "", code: "record_invalid" };
    return this.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: binding.account, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
  }

  /** Ends the lock `lockId` (P11, T47), written by the log itself like the lock. */
  appendUnlock(lockId: string, binding: { readonly account: string } | null): SafetyReceipt {
    if (binding === null) return { outcome: "refused", id: "", code: "record_invalid" };
    return this.append({ record: { v: 1, id: pcRecordId(), kind: "unlock", account: binding.account, target: lockId, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
  }

  /**
   * A lift at the PC (`ovis recover --lift`, T69): signed `pc` under this PC's account, of a block this log holds. It
   * ends that block and its freeze only; `forget` also ends its marker. Refused with no binding, as a lock is.
   */
  appendLift(blockId: string, binding: { readonly account: string } | null, options: { readonly cause: LiftCause; readonly forget?: boolean }): SafetyReceipt {
    // a service freeze this PC holds without its block is lifted by its own id, `f:` and that block's id (P23 way 2)
    const freeze = this.inForce.freezes.find((entry) => entry.record.kind === "freeze" && entry.record.id === blockId && entry.record.account === binding?.account);
    const target = freeze !== undefined ? blockId.slice(2) : blockId;
    if (binding === null || (freeze === undefined && !this.blockIds().includes(blockId))) return { outcome: "refused", id: "", code: "record_invalid" };
    return this.append({ record: { v: 1, id: pcRecordId(), kind: "lift", account: binding.account, target, signer: "pc", signed_at: new Date().toISOString(), forget: options.forget === true, signature: "" }, got: "pc", cause: options.cause });
  }

  /** The receipt of a record this log holds (T51): the same `applied` as often as it is asked, until it is folded. */
  receipt(id: string): SafetyReceipt | null {
    const entry = this.file.entries.find((candidate) => candidate.record.id === id);
    if (entry !== undefined) return { outcome: "applied", id, n: entry.n };
    return this.file.base.some((line) => line.id === id) ? { outcome: "already_applied", id } : null;
  }

  /**
   * Appends one record with the next number, on disk before it counts. A record this log already holds answers its
   * receipt and appends nothing; another record under a known id is refused, and the log keeps what it holds.
   */
  /** Hears a durable lift with its block or freeze target and cause (seam for S2-27). */
  onLifted(listener: (target: string, cause: LiftCause) => void): () => void {
    this.liftListeners.add(listener);
    return () => { this.liftListeners.delete(listener); };
  }
  private readonly liftListeners = new Set<(target: string, cause: LiftCause) => void>();

  append(input: SafetyAppend): SafetyReceipt {
    const { record, got, asof, cause } = input;
    const id = typeof record?.id === "string" ? record.id : "";
    if (this.strict !== null) return { outcome: "refused", id, code: "log_unavailable" };
    if (!GOTS.has(got) || recordProblem(record, asof) !== null) return { outcome: "refused", id, code: "record_invalid" };
    if (record.kind === "lift" && !LIFT_CAUSES.has(cause as LiftCause)) return { outcome: "refused", id, code: "record_invalid" };
    // what another handle of this folder appended is read first, so no number is given twice and none is lost (P24)
    if (!this.load()) return { outcome: "refused", id, code: "log_unavailable" };
    const held = this.file.entries.find((entry) => entry.record.id === id);
    if (held !== undefined) return sameRecord(held.record, record) ? { outcome: "applied", id, n: held.n } : { outcome: "refused", id, code: "conflict" };
    if (this.file.base.some((line) => line.id === id)) return { outcome: "already_applied", id };
    const entry: SafetyEntry = { n: this.file.next, got, record: { ...record }, ...(asof === undefined ? {} : { asof: { ...asof } }) };
    const next: LogFile = { ...this.file, next: this.file.next + 1, entries: [...this.file.entries, entry] };
    if (!this.writeFile(next)) return { outcome: "refused", id, code: "log_unavailable" };
    if (record.kind === "lift" && cause !== undefined) {
      const held = this.file.entries.filter(({ record: candidate }) => candidate.account === record.account);
      const block = held.find(({ record: candidate }) => candidate.kind === "block" && candidate.id === record.target);
      const freeze = held.find(({ record: candidate }) => candidate.kind === "freeze" && candidate.id === `f:${record.target}`);
      const target = block?.record.target ?? freeze?.record.target ?? null;
      if (target !== null) for (const listener of [...this.liftListeners]) {
        try { listener(target, cause); } catch (error) { console.warn(`[account] a lift listener failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return { outcome: "applied", id, n: entry.n };
  }

  /** Number a whole read's lifts together; no new receipt counts until the single replacement succeeds. */
  commitLifts(lifts: readonly DeviceLiftRecord[], cause: Extract<LiftCause, "snapshot">): { added: number; receipts: SafetyReceipt[] } {
    if (lifts.length === 0) return { added: 0, receipts: [] };
    const unavailable = () => ({ added: 0, receipts: lifts.map((record): SafetyReceipt => ({ outcome: "refused", id: record?.id ?? "", code: "log_unavailable" })) });
    if (this.strict !== null || !this.load()) return unavailable();
    const next = { ...this.file, entries: [...this.file.entries] };
    const receipts = lifts.map((record): SafetyReceipt => {
      const id = typeof record?.id === "string" ? record.id : "";
      if (recordProblem(record, undefined) !== null || record.kind !== "lift" || record.signer === "pc") return { outcome: "refused", id, code: "record_invalid" };
      const held = next.entries.find((entry) => entry.record.id === id);
      if (held) return sameRecord(held.record, record) ? { outcome: "applied", id, n: held.n } : { outcome: "refused", id, code: "conflict" };
      if (next.base.some((line) => line.id === id)) return { outcome: "already_applied", id };
      const n = next.next++;
      next.entries.push({ n, record: { ...record }, got: "snapshot" });
      return { outcome: "applied", id, n };
    });
    const refused = receipts.filter((receipt) => receipt.outcome === "refused");
    if (refused.length) return { added: 0, receipts: refused };
    const added = next.next - this.file.next;
    if (added) {
      if (!this.writeFile(next)) return unavailable();
      for (const { record } of next.entries.slice(-added)) {
        const ended = next.entries.find(({ record: parent }) => parent.account === record.account &&
          ((parent.kind === "block" && parent.id === record.target) || (parent.kind === "freeze" && parent.id === `f:${record.target}`)));
        const target = ended?.record.target;
        if (target == null) continue;
        for (const listener of [...this.liftListeners]) {
          try { listener(target, cause); } catch (error) { console.warn(`[account] a lift listener failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
    }
    return { added, receipts };
  }


  /** What is in force, worked out from the log alone. Each ending ends only the record it names, and only of its kind. */
  state(): SafetyState {
    // an ending names the record it ends under that record's own account, and ends nothing of another
    const at = (account: string, id: string) => `${account}\u0000${id}`;
    const lifted = new Set<string>();
    const forgotten = new Set<string>();
    const unlocked = new Set<string>();
    // a lift or an unlock already folded still ends what it names (P24)
    for (const line of this.file.base) {
      if (line.kind === "lift" && line.target !== null) lifted.add(at(line.account ?? "", line.target));
      else if (line.kind === "unlock" && line.target !== null) unlocked.add(at(line.account ?? "", line.target));
    }
    for (const { record } of this.file.entries) {
      if (record.kind === "lift") {
        lifted.add(at(record.account, record.target));
        if (record.signer === "pc" && (record as PcLiftRecord).forget) forgotten.add(at(record.account, record.target));
      } else if (record.kind === "unlock") unlocked.add(at(record.account, record.target));
    }
    const byN = [...this.file.entries].sort((a, b) => a.n - b.n);
    const of = (kind: SafetyRecordKind) => byN.filter((entry) => entry.record.kind === kind);
    const locks = of("lock").filter((entry) => !unlocked.has(at(entry.record.account, entry.record.id)));
    const blocks = of("block").filter((entry) => !lifted.has(at(entry.record.account, entry.record.id)));
    const exactKeys = new Set(blocks.filter(entry => entry.asof?.target_only === true).map(entry => at(entry.record.account, entry.record.id)));
    const serviceFreezes = of("freeze").filter(entry => !lifted.has(at(entry.record.account, entry.record.id.slice(2))))
      .map(entry => exactKeys.has(at(entry.record.account, entry.record.id.slice(2))) ? { ...entry, targetOnlyCompanion: true as const } : entry);
    return {
      locked: locks.length > 0,
      locks,
      blocks,
      freezes: [...blocks.filter(entry => entry.asof?.target_only !== true), ...serviceFreezes].sort((a, b) => a.n - b.n),
      markers: of("block").filter((entry) => !forgotten.has(at(entry.record.account, entry.record.id))),
    };
  }

  /**
   * Folds what nothing rests on into `base` (P24): only while no block, freeze or lock is in force. A block folds only
   * once a lift and a forgetting lift name it, so its marker can always be worked out from the log; a lock once an
   * unlock names it; a freeze once a lift names its block; a lift or an unlock with the record it names. Every ending
   * counts only under the account of the record it names. Returns how many entries folded.
   */
  fold(): number {
    if (this.strict !== null) return 0;
    const state = this.state();
    if (state.locked || state.blocks.length > 0 || state.freezes.length > 0) return 0;
    // an ending ends only the record it names under the same account, as state() reads it (P24)
    const at = (account: string, id: string) => `${account}\u0000${id}`;
    const enders = new Map<string, string[]>();
    const forgetting = new Set<string>();
    for (const { record } of this.file.entries) {
      if (record.kind === "lift" || record.kind === "unlock") enders.set(at(record.account, record.target), [...enders.get(at(record.account, record.target)) ?? [], record.id]);
      if (record.kind === "lift" && record.signer === "pc" && (record as PcLiftRecord).forget) forgetting.add(at(record.account, record.target));
    }
    const folds = new Set<string>();
    for (const { record } of this.file.entries) {
      const key = at(record.account, record.id);
      if (record.kind === "block" && enders.has(key) && forgetting.has(key)) folds.add(key);
      else if (record.kind === "lock" && enders.has(key)) folds.add(key);
      else if (record.kind === "freeze" && enders.has(at(record.account, record.id.slice(2)))) folds.add(key);
      else if (record.kind === "forget") folds.add(key);
    }
    for (const { record } of this.file.entries) {
      if ((record.kind !== "lift" && record.kind !== "unlock")) continue;
      const named = at(record.account, record.target);
      // a lift or an unlock folds only in the pass that folds the record it ends, whose body is here: a lift kept whole
      // still ends that block when a sibling folder brings it whole (P24, T48)
      if (folds.has(named)) folds.add(at(record.account, record.id));
    }
    if (folds.size === 0) return 0;
    const folded = (record: SafetyRecord) => folds.has(at(record.account, record.id));
    const base = [...this.file.base, ...this.file.entries.filter((entry) => folded(entry.record)).map(({ record }) => ({ id: record.id, kind: record.kind, account: record.account, target: record.target, ended_by: enders.get(at(record.account, record.id)) ?? enders.get(at(record.account, record.id.slice(2))) ?? [] }))];
    const next: LogFile = { ...this.file, base, entries: this.file.entries.filter((entry) => !folded(entry.record)) };
    writePrivateState(this.path, next);
    this.file = next;
    return folds.size;
  }

  waitingBlocks(): readonly WaitingBlock[] { return this.file.waiting; }

  /** Queues a block whose target this PC cannot place yet; false if the log cannot hold it, without evicting another (P19). */
  wait(item: WaitingBlock): boolean {
    if (this.strict !== null || !this.load()) return false;
    if (this.file.waiting.some((kept) => kept.record.id === item.record.id)) return true;
    if (this.file.waiting.length >= WAITING_MAX) {
      // the mark is durable before the block is dropped, or a restart forgets that one was (S10-2): the log, else the side file
      if (this.writeFile({ ...this.file, overflowed: true })) return false;
      try { writePrivateState(join(this.stateDir, SAFETY_OVERFLOW_FILE), { v: 1, at: new Date().toISOString() }); }
      catch (error) {
        // no mark could be written: nothing is dropped. The block stays, over capacity and in memory only, and the PC is
        // closed for this run (the failed log write above made it strict)
        console.error(`The waiting queue's overflow could not be marked, so the block is kept: ${error instanceof Error ? error.message : String(error)}`);
        this.file = { ...this.file, waiting: [...this.file.waiting, item] };
      }
      return false;
    }
    return this.writeFile({ ...this.file, waiting: [...this.file.waiting, item] });
  }

  /** A waiting block was judged: applied, or refused for good. */
  unwait(id: string): void {
    if (!this.file.waiting.some((kept) => kept.record.id === id)) return;
    if (this.strict !== null || !this.load()) return;
    const waiting = this.file.waiting.filter((kept) => kept.record.id !== id);
    if (waiting.length !== this.file.waiting.length) this.writeFile({ ...this.file, waiting });
  }

  private writeFile(next: LogFile): boolean {
    try { writePrivateState(this.path, next); } catch (error) {
      this.writeError = `Cannot write ${this.path} (${error instanceof Error ? error.message : String(error)})`;
      this.inForce = STRICT_STATE;
      return false;
    }
    this.file = next;
    this.inForce = next.overflowed ? STRICT_STATE : this.state();
    return true;
  }

  /** The file as it stands, for a merge. */
  snapshot(): { readonly next: number; readonly base: readonly FoldedRecord[]; readonly entries: readonly SafetyEntry[]; readonly waiting: readonly WaitingBlock[]; readonly overflowed?: true } { return this.file; }

  /** Why the log is strict, without the strict tail, or null. */
  get reason(): string | null {
    return this.readError ?? this.writeError ?? (this.file.overflowed ? "A block could not be queued because the waiting queue is full" : null);
  }

  /** Whether the log could be read: a merge never writes over one it could not. */
  get readable(): boolean { return this.readError === null; }

}

/**
 * Merges the safety logs of two state folders at start, before anything is served (T48, P24): the union by id. Each
 * folder keeps the numbers of the records it holds and takes the other's after its last one, in the other's order,
 * with `got: merge` and the `asof` the other noted. What the PC added (`n`, `got`, `asof`) is never compared. A record
 * either folder folded is known and ended in both. One id with two different records is a damaged log: nothing is
 * written to either folder, and the returned reason makes the PC fail closed. Null when merged.
 */
export function mergeSafetyLogs(active: string, sibling: string): string | null {
  const [own, other] = [SafetyLog.open(active), SafetyLog.open(sibling)];
  // the sibling folder is no server's: its handle goes once the merge is made
  try {
    for (const [log, dir] of [[own, active], [other, sibling]] as const) {
      if (!log.readable) return `Cannot merge the account safety log of ${dir}: ${log.reason}`;
    }
    const [a, b] = [own.snapshot(), other.snapshot()];
    const records = new Map<string, SafetyRecord>();
    for (const entry of [...a.entries, ...b.entries]) {
      const known = records.get(entry.record.id);
      if (known !== undefined && !sameRecord(known, entry.record)) return `The account safety logs of ${active} and ${sibling} hold two different records under the id ${entry.record.id}`;
      records.set(entry.record.id, entry.record);
    }
    // folded lines under one id, in either folder, are one record only when they agree on what it was (T48)
    for (const line of a.base) {
      const theirs = b.base.find((other) => other.id === line.id);
      if (theirs !== undefined && (theirs.kind !== line.kind || theirs.account !== line.account || theirs.target !== line.target)) return `The account safety logs of ${active} and ${sibling} hold two different records under the id ${line.id}`;
    }
    // a folded line and a whole record under one id are one record only when they agree on what it was (T48)
    for (const line of [...a.base, ...b.base]) {
      const whole = records.get(line.id);
      if (whole !== undefined && (whole.kind !== line.kind || whole.account !== line.account || whole.target !== line.target)) return `The account safety logs of ${active} and ${sibling} hold two different records under the id ${line.id}`;
    }
    const base = [...a.base, ...b.base.filter((line) => !a.base.some((own) => own.id === line.id))];
    // one block noted in both folders (P21): the lower freeze line in both, and the signer not removed if either folder
    // saw it a member when the block arrived; `joined` and the numbers stay each folder's own, as admit_no is
    const lower = (x: number | null, y: number | null) => x === null ? y : y === null ? x : Math.min(x, y);
    const shared = new Map<string, { after: number | null; signer_removed: boolean }>();
    for (const entry of [...a.entries, ...b.entries]) {
      if (entry.asof === undefined) continue;
      const known = shared.get(entry.record.id);
      shared.set(entry.record.id, known === undefined ? { after: entry.asof.after, signer_removed: entry.asof.signer_removed }
        : { after: lower(known.after, entry.asof.after), signer_removed: known.signer_removed && entry.asof.signer_removed });
    }
    const strictest = (entry: SafetyEntry): SafetyEntry => entry.asof === undefined ? entry : { ...entry, asof: { ...entry.asof, ...shared.get(entry.record.id)! } };
    const folded = new Set(base.map((line) => line.id));
    const merged = (mine: typeof a, theirs: typeof a): LogFile => {
      const held = new Set(mine.entries.map((entry) => entry.record.id));
      let next = mine.next;
      const taken = [...theirs.entries].sort((x, y) => x.n - y.n)
        .filter((entry) => !held.has(entry.record.id) && !folded.has(entry.record.id))
        .map((entry) => ({ ...entry, n: next++, got: "merge" as const }));
      const waiting = [...mine.waiting, ...theirs.waiting.filter((item) => !mine.waiting.some((own) => JSON.stringify(own) === JSON.stringify(item)))];
      return { v: 1, next, base, entries: [...mine.entries.filter((entry) => !folded.has(entry.record.id)), ...taken].map(strictest), waiting,
        ...(mine.overflowed || theirs.overflowed ? { overflowed: true } : {}) };
    };
    const [forOwn, forOther] = [merged(a, b), merged(b, a)];
    const written: string[] = [];
    for (const [dir, file, before] of [[active, forOwn, a], [sibling, forOther, b]] as const) {
      if (JSON.stringify(file) === JSON.stringify({ v: 1, ...before })) continue;
      try { writePrivateState(join(dir, SAFETY_LOG_FILE), file); written.push(dir); } catch (error) {
        // a merge half written fails this PC closed rather than its start: what each dir holds stays a whole log
        return `Cannot write the merged account safety log into ${dir}${written.length ? ` (already written into ${written.join(", ")})` : ""}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  } finally { other.close(); }
}
