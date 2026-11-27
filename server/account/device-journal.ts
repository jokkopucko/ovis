/**
 * The device journal (P10, P15): every admission, drop, removal and promotion on this PC, numbered by `seq`, which
 * orders the journal and nothing else (a row's age is its admission order, P21/P22). An admission is on disk before
 * its row is (G14); each row is told what it has not seen at its next connect, before anything else on its stream
 * (T57). An acknowledgement only moves that row's `seen`. An `admit` nobody decided stays in `open`, which is never
 * trimmed, until "It's me", "Not me", PC-local or a marker decides it; at OPEN_NOTICES_MAX the list admits nobody
 * new (G15). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceNotice, NoticeKind, NoticeReplay } from "../../shared/account-devices-api.ts";
import { writePrivateState } from "../private-state.ts";
import { DEVICE_JOURNAL_FILE, type SafetyLog } from "./safety-log.ts";
import type { JournalEntry as AccountRowEntry } from "./account-devices.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";
import { isRowDrop, type RowDrop } from "./row-drop-evidence.ts";

export const JOURNAL_FILE = DEVICE_JOURNAL_FILE;
// Replay-only closes count toward this cap alongside the journal events.
export const JOURNAL_MAX = 1_000;
export const OPEN_NOTICES_MAX = 64;

export interface JournalEntry extends Pick<AccountRowEntry, "provider" | "two_step"> {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly kind: NoticeKind;
  readonly how: string;
  readonly key: string | null;
  /** the subject row's admission number on this PC, which places it against the row told */
  readonly no: number | null;
  readonly row: string | null;
  readonly label: string;
  readonly by: string | null;
  readonly account: string | null;
  /** a recovery's undo names the release it ends (kind `release`) */
  readonly undo?: string;
  /** A list admission recorded before its row passed waiting blocks; history, not yet a notice. */
  readonly awaitingListCheck?: true;
}
export type JournalInput = Omit<JournalEntry, "seq" | "id" | "at">;

interface Doc {
  v: 1;
  next_seq: number;
  entries: JournalEntry[];
  /** Replay-only closes have their own sequence, but are not events in a row's admission/removal history. */
  closed?: JournalEntry[];
  seen: Record<string, number>;
  open: JournalEntry[];
  /** the highest seq trimmed so far: a row that had not seen up to it is told how many it missed */
  trimmed: number;
  /** Safety-log number of the last snapshot lift journalled, even after its notice is trimmed. */
  snapshot_lift_n?: number;
  /** Transfer slot: written with the notice, retained until its evidence receipt is durable. */
  last_row_drop?: RowDrop & { readonly journalled: number };
  /** Transaction approval and refusal receipts are pending work, not bounded history. */
  restamp?: { readonly digest: string; readonly audits: readonly string[] };
  restamp_reconcile?: string;
}

const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function isEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return isCount(e.seq) && (e.seq as number) >= 1 && typeof e.id === "string" && typeof e.at === "string" && typeof e.kind === "string"
    && typeof e.how === "string" && isTextOrNull(e.key) && (e.no === null || isCount(e.no)) && isTextOrNull(e.row)
    && typeof e.label === "string" && isTextOrNull(e.by) && isTextOrNull(e.account) && (e.undo === undefined || typeof e.undo === "string");
}

/** The journal as this PC writes it, whole: every entry, open notice and seen value, below the next number (S19). */
export function isJournalDoc(value: unknown): value is Doc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Partial<Doc>;
  if (doc.v !== 1 || !isCount(doc.next_seq) || doc.next_seq < 1 || !isCount(doc.trimmed) || doc.trimmed >= doc.next_seq) return false;
  if (!Array.isArray(doc.entries) || !Array.isArray(doc.open) || typeof doc.seen !== "object" || doc.seen === null || Array.isArray(doc.seen)) return false;
  const below = (entry: JournalEntry) => entry.seq < doc.next_seq!;
  if (!doc.entries.every((entry) => isEntry(entry) && below(entry)) || !doc.open.every((entry) => isEntry(entry) && below(entry))) return false;
  if (doc.closed !== undefined && (!Array.isArray(doc.closed) || !doc.closed.every((entry) => isEntry(entry) && entry.kind === "admit" && below(entry)))) return false;
  return Object.values(doc.seen).every((seq) => isCount(seq) && seq < doc.next_seq!);
}

function receiptProblem(doc: Doc, drops: readonly RowDrop[]): string | null {
  if (drops.length === 0) return null;
  const known = new Map([...doc.open, ...doc.entries].map(entry => [entry.seq, entry]));
  for (const { row, how, journalled: seq } of drops) {
    if (seq === undefined) continue;
    const entry = known.get(seq);
    if (seq >= doc.next_seq || (entry ? entry.kind !== "drop" || entry.row !== row || entry.how !== how : seq > doc.trimmed)) {
      return `contradicts the account row receipt for ${row} at sequence ${seq}`;
    }
  }
  return null;
}

function documentProblem(doc: Doc, drops: readonly RowDrop[] = []): string | null {
  if ((doc.restamp !== undefined && (!doc.restamp || !isDigest(doc.restamp.digest) ||
      !Array.isArray(doc.restamp.audits) || !doc.restamp.audits.every(audit => typeof audit === "string"))) ||
    (doc.restamp_reconcile !== undefined && !isDigest(doc.restamp_reconcile))) return "has invalid restamp receipts";
  if (doc.last_row_drop !== undefined && (!isRowDrop(doc.last_row_drop) || doc.last_row_drop.journalled === undefined)) {
    return "has an invalid account row receipt";
  }
  if (doc.snapshot_lift_n !== undefined && (!Number.isSafeInteger(doc.snapshot_lift_n) || doc.snapshot_lift_n < 1)) {
    return "has an invalid snapshot lift number";
  }
  return receiptProblem(doc, [...(doc.last_row_drop ? [doc.last_row_drop] : []), ...drops]);
}

/** Validate on-disk journal bytes without opening a writer or changing the server's live copy. */
export function restampJournalProblem(value: unknown, drops: readonly RowDrop[]): string | null {
  if (value === undefined) return drops.some(drop => drop.journalled !== undefined) ? "is missing beside a durable row receipt" : null;
  return isJournalDoc(value) ? documentProblem(value, drops) : "is not this PC's device journal";
}

export function endedJournalRows(entries: readonly JournalEntry[]): Set<string> {
  const last = new Map<string, string>();
  for (const entry of entries) if (entry.row !== null) last.set(entry.row, entry.kind);
  return new Set([...last].flatMap(([row, kind]) => kind === "drop" || kind === "remove" ? [row] : []));
}

export class DeviceJournal {
  private doc: Doc = { v: 1, next_seq: 1, entries: [], seen: {}, open: [], trimmed: 0 };
  private problem: string | null = null;
  private exists = false;

  /** `companions`: called once before the journal's first write, to make the files a journal implies (P13, P24). */
  private constructor(private readonly path: string, private readonly companions: () => void) {}

  static open(stateDir: string, companions: () => void = () => {}): DeviceJournal {
    const journal = new DeviceJournal(join(stateDir, JOURNAL_FILE), companions);
    let text: string;
    try { text = readFileSync(journal.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") journal.problem = `Cannot read ${journal.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      return journal;
    }
    try {
      const doc = JSON.parse(text) as Partial<Doc>;
      if (!isJournalDoc(doc)) journal.problem = `${journal.path} is not this PC's device journal`;
      else {
        const problem = documentProblem(doc);
        if (problem !== null) journal.problem = `${journal.path} ${problem}`;
        else {
          journal.doc = doc;
          journal.exists = true;
        }
      }
    } catch { journal.problem = `${journal.path} is not JSON`; }
    return journal;
  }

  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the device journal is restored.`;
  }

  entries(): readonly JournalEntry[] { return this.doc.entries; }

  /** Refuse to replace a journal that was changed outside this server, without opening a second writer. */
  restampRefusal(onDisk: unknown): string | null {
    if (this.strict !== null) return this.strict;
    return Bun.deepEquals(onDisk, this.exists ? this.doc : undefined) ? null : `${this.path} changed since it was opened; restart Ovis before restamping.`;
  }

  approveRestamp(digest: string, input: JournalInput): void {
    this.appendEntry(input, undefined, undefined, undefined, { restamp: { digest, audits: [] } });
  }

  approvesRestamp(digest: string): boolean { return this.doc.restamp?.digest === digest; }

  auditRestamp(digest: string, input: JournalInput): void {
    const approved = this.doc.restamp;
    if (approved?.digest !== digest) throw new Error("restamp.json does not match the approved plan in the device journal");
    const receipt = JSON.stringify([input.how, input.label]);
    if (approved.audits.includes(receipt)) return;
    this.appendEntry(input, undefined, undefined, undefined, { restamp: { digest, audits: [...approved.audits, receipt] } });
  }

  approveRestampReconciliation(digest: string, input: JournalInput): void {
    this.appendEntry(input, undefined, undefined, undefined, { restamp_reconcile: digest });
  }

  approvesRestampReconciliation(digest: string): boolean { return this.doc.restamp_reconcile === digest; }

  /** A trimmed notice need not survive its receipt, but an unallocated or contradictory sequence proves nothing. */
  checkRowReceipts(drops: readonly RowDrop[]): void {
    if (this.problem !== null) return;
    const problem = receiptProblem(this.doc, drops);
    if (problem !== null) this.problem = `${this.path} ${problem}`;
  }

  openNotices(): readonly JournalEntry[] { return this.doc.open; }

  /** Only outstanding list admissions with a registry owner take a slot. This never changes access. */
  settleList(owns: (notice: JournalEntry) => boolean): void {
    const open = this.doc.open.filter(n => n.how !== "list" || owns(n));
    const entries = this.doc.entries.filter(n => n.seq > this.doc.trimmed || owns(n));
    if (open.length !== this.doc.open.length || entries.length !== this.doc.entries.length) this.write({ ...this.doc, open, entries });
  }

  /** Whether the list may admit anybody new: fewer than OPEN_NOTICES_MAX join notices wait for an answer (G15). */
  admitsFromList(): boolean { return this.problem === null && this.doc.open.length < OPEN_NOTICES_MAX; }

  /** Appends one entry, on disk when this returns; throws when it cannot be written, so what it records does not happen. */
  append(input: JournalInput, decides?: string, drop?: RowDrop): JournalEntry {
    return this.appendEntry(input, undefined, decides, drop);
  }

  /** A registry write may be replayed. Row IDs are reused, so a new admission reopens the row's history. */
  /** The entry written, or null when the row's drop is already journalled. */
  recordAccountRow(entry: AccountRowEntry, evidence: RemovalEvidence): JournalEntry | null {
    if (this.strict !== null) throw new Error(this.strict);
    // If the process stopped between the two replacements, finish the earlier receipt before reusing its slot.
    const prior = this.doc.last_row_drop;
    if (prior) evidence.markJournalled(prior, prior.journalled);
    const drop = entry.drop && (evidence.dropFor(entry.row, entry.drop.admit_no) ?? entry.drop);
    if (drop?.journalled !== undefined) return null;
    if (entry.kind === "drop") {
      // Older journals and interrupted upgrades have no receipt; migrate a still-retained drop once.
      const last = this.doc.entries.filter(event => event.row === entry.row && (event.kind === "admit" || event.kind === "drop")).at(-1);
      if (last?.kind === "drop") {
        if (drop) evidence.markJournalled(drop, last.seq);
        return null;
      }
    }
    // Receipt-less drops still name a specific admission, without widening the drop event's audience.
    const decides = entry.kind === "drop" && entry.no !== undefined && drop === undefined
      ? this.doc.open.find(notice => notice.how === "list" && notice.key === entry.key && notice.row === entry.row &&
        notice.no === entry.no && notice.account === entry.account)?.id : undefined;
    const written = this.append({ kind: entry.kind === "drop" ? "drop" : "admit", how: drop?.how ?? entry.reason ?? "list", key: entry.key, no: entry.kind === "drop" ? null : entry.no ?? null,
      row: entry.row, label: entry.label ?? "", by: null, account: entry.account,
      ...(entry.kind === "admit" ? { awaitingListCheck: true, two_step: entry.two_step ?? "unknown", ...(entry.provider === undefined ? {} : { provider: entry.provider }) } : {}) }, decides, drop);
    if (drop) evidence.markJournalled(drop, written.seq);
    return written;
  }

  /** Make only the surviving admissions visible to notice replay and the open set. */
  openListedRows(ids: readonly string[]): void {
    if (!ids.length) return;
    const open = [...this.doc.open];
    const latest = new Map(this.doc.entries.filter(entry => entry.kind === "admit" || entry.kind === "promote" || entry.kind === "drop").map(entry => [entry.row, entry.seq]));
    const entries = this.doc.entries.map((entry): JournalEntry => {
      if (!entry.awaitingListCheck || !entry.row || !ids.includes(entry.row) || latest.get(entry.row) !== entry.seq) return entry;
      const { awaitingListCheck: _, ...notice } = entry;
      if (notice.kind === "admit") open.push(notice);
      return notice;
    });
    if (entries.some((entry, i) => entry !== this.doc.entries[i])) {
      this.write({ ...this.doc, entries: entries.filter(n => n.seq > this.doc.trimmed || n.awaitingListCheck), open });
    }
  }

  /** Catch up after a committed batch or interrupted journal write. Each notice and its cursor share one write. */
  recordSnapshotLifts(log: SafetyLog): void {
    const after = this.doc.snapshot_lift_n ?? 0;
    const lifts = log.entries().flatMap(({ n, got, record }) => n > after && got === "snapshot" && record.kind === "lift" ? [{ n, record }] : []);
    if (lifts.length === 0) return;
    const entries = new Map(log.entries().map((entry) => [entry.record.id, entry]));
    for (const { n, record } of lifts.sort((a, b) => a.n - b.n)) {
      const ended = entries.get(record.target) ?? entries.get(`f:${record.target}`);
      this.appendEntry({ kind: "lift", how: "snapshot", key: ended?.record.target ?? null, no: ended?.asof?.joined ?? null,
        row: null, label: "Account block lifted", by: record.signer, account: record.account }, n);
    }
  }

  private appendEntry(input: JournalInput, liftNumber?: number, decides?: string, drop?: RowDrop, restamp?: Pick<Doc, "restamp" | "restamp_reconcile">): JournalEntry {
    if (this.problem !== null) throw new Error(this.strict!);
    const entry: JournalEntry = { ...input, seq: this.doc.next_seq, id: randomBytes(16).toString("hex"), at: new Date().toISOString() };
    const remaining = this.doc.open.filter(notice => {
      if (notice.id === decides) return false;
      if (notice.how !== "list" || notice.key === null || notice.key !== entry.key) return true;
      // Local recovery revokes the key on this PC. A row receipt ends only its numbered admission.
      if (entry.kind === "remove" && entry.how === "recover") return false;
      return !drop || notice.row !== drop.row || notice.no !== drop.admit_no || notice.account !== entry.account;
    });
    const open = entry.kind === "admit" && !entry.awaitingListCheck ? [...remaining, entry] : remaining;
    if (!this.exists) this.companions();
    this.write({ ...this.doc, ...restamp, next_seq: entry.seq + 1, entries: [...this.doc.entries, entry], open,
      ...(drop && { last_row_drop: { ...drop, journalled: entry.seq } }),
      ...(liftNumber === undefined ? {} : { snapshot_lift_n: liftNumber }) }, restamp !== undefined);
    this.exists = true;
    return entry;
  }

  /**
   * What `row` is told at its connect: every entry it has not seen and every undecided admission, of the ones `tells`
   * lets it hear (the entries about rows newer than it), with how many trimmed entries it missed.
   */
  replay(row: string, tells: (entry: JournalEntry) => boolean): NoticeReplay {
    const seen = this.doc.seen[row] ?? 0;
    const unseen = [...this.doc.entries, ...(this.doc.closed ?? [])].filter((entry) => !entry.awaitingListCheck && entry.seq > seen && tells(entry));
    const notices = new Map([...this.doc.open.filter(tells), ...unseen].map(entry => [entry.id, entry]));
    const missedOpen = this.doc.open.filter((entry) => entry.seq > seen && entry.seq <= this.doc.trimmed).length;
    return {
      notices: [...notices.values()].sort((a, b) => a.seq - b.seq).map((entry) => this.notice(entry)),
      cut: Math.max(0, this.doc.trimmed - seen - missedOpen),
    };
  }

  notice(entry: JournalEntry): DeviceNotice {
    const { undo: _undo, provider, two_step, ...fields } = entry;
    const listAdmission = entry.kind === "admit" && entry.how === "list";
    return { ...fields, open: this.doc.open.some((open) => open.id === entry.id),
      method: listAdmission ? provider ?? null : null, two_step: listAdmission ? two_step ?? "unknown" : null };
  }

  /** `row` saw everything up to `seq` (T57). Decides nothing. */
  ack(row: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= (this.doc.seen[row] ?? 0) || seq >= this.doc.next_seq) return;
    this.write({ ...this.doc, seen: { ...this.doc.seen, [row]: seq } });
  }

  /** Close an admission atomically with a replay entry, even for rows that already acknowledged it. */
  decide(id: string): boolean {
    const strict = this.strict;
    if (strict !== null) throw new Error(strict);
    const open = this.doc.open.filter((entry) => entry.id !== id);
    if (open.length === this.doc.open.length) return false;
    try {
      this.write({ ...this.doc, open });
    } catch (error) {
      this.problem = `Cannot record a notice decision in ${this.path} (${error instanceof Error ? error.message : String(error)})`;
      throw error;
    }
    return true;
  }

  private write(doc: Doc, preservePermissions = false): void {
    let next = doc;
    if (doc.open !== this.doc.open) {
      const kept = new Set(doc.open.map(entry => entry.id));
      const closes = this.doc.open.filter(entry => !kept.has(entry.id))
        .map((entry, index) => ({ ...entry, seq: doc.next_seq + index }));
      if (closes.length) next = { ...doc, next_seq: doc.next_seq + closes.length, closed: [...(doc.closed ?? []), ...closes] };
    }
    if (next.next_seq > this.doc.next_seq && next.entries.length + (next.closed?.length ?? 0) > JOURNAL_MAX) {
      const trimmed = Math.max(next.trimmed, next.next_seq - 1 - JOURNAL_MAX);
      // An unpublished admission is pending work, not replay history. Keep only the current one for each row.
      const latest = new Map(next.entries.filter(n => n.kind === "admit" || n.kind === "promote" || n.kind === "drop").map(n => [n.row, n.seq]));
      const entries = next.entries.filter(n => n.seq > trimmed || (n.awaitingListCheck && n.kind === "admit" && latest.get(n.row) === n.seq));
      const closed = next.closed?.filter(n => n.seq > trimmed);
      next = { ...next, entries, trimmed, ...(closed && { closed }) };
    }
    writePrivateState(this.path, next, undefined, preservePermissions);
    this.doc = next;
  }
}
