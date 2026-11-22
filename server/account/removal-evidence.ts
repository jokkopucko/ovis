/**
 * Account removals and local Revokes, kept apart (P13): `account-removed.json` `{v, markers, revokes, unrevokes}`.
 *
 * A marker is one per (key, account) and lists what the account did to the key, each removal with the forgettings
 * (`forget` records of the safety log) this folder held when it was added, as `over`. A removal stands while its own
 * `over` lists every forgetting of that key and account the log holds; the marker stands while one of its removals
 * does. A Revoke this PC made is its own entry of `revokes`, never coalesced into a marker or another Revoke, and stands
 * until an `unrevoke` names it: only a pairing of that key on this PC writes one here.
 *
 * The tombstone file (`account-tombstones.json`) is compatibility data for v0.5.5 and the guards that read it, written
 * from this evidence and never a second truth: the account's tombstone while a standing removal names the key, else a
 * `local` one while a Revoke of it stands, else none. Old local tombstones are taken in as Revokes first (T26).
 * Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isIsoTime } from "../../shared/account-records.ts";
import { writePrivateState } from "../private-state.ts";
import { DEVICE_JOURNAL_FILE } from "./safety-log.ts";
import { isRowDrop, withRowDrop, type RowDrop } from "./row-drop-evidence.ts";

export const REMOVAL_FILE = "account-removed.json";
/** Removals kept per marker; past it one that no longer stands goes first, the oldest first. */
export const MARKER_REMOVALS_MAX = 8;
const DAY_MS = 86_400_000;

export interface Removal {
  readonly id: string;
  readonly over: readonly string[];
  /** the record id of the tombstone this removal writes */
  readonly tomb: string;
  readonly at: string;
  readonly records?: readonly unknown[];
}
export interface Marker { readonly key: string; readonly account: string; readonly removals: readonly Removal[] }
export interface Revoke { readonly id: string; readonly key: string; readonly account: string | null; readonly at: string; readonly untrusted_time?: true; readonly legacy_time?: true }
export interface Unrevoke { readonly id: string; readonly revoke: string; readonly at: string; readonly by: string }

/** The tombstone shape of server/devices.ts, written from the evidence. */
export interface EvidenceTombstone { key: string; account: string; record_id: string; removed_at: string; records?: unknown[] }

interface Doc { v: 1; markers: Marker[]; revokes: Revoke[]; unrevokes: Unrevoke[]; row_drops?: readonly RowDrop[] }

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The removal evidence `value` holds, or null when it is not this PC's form of it. */
export function parseEvidence(value: unknown): Doc | null { return parseDoc(value); }

function parseDoc(value: unknown): Doc | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Partial<Doc>;
  if (doc.v !== 1 || !Array.isArray(doc.markers) || !Array.isArray(doc.revokes) || !Array.isArray(doc.unrevokes)) return null;
  if (doc.row_drops !== undefined && !(Array.isArray(doc.row_drops) && doc.row_drops.every(isRowDrop))) return null;
  const removalOk = (r: Removal) => typeof r === "object" && r !== null && typeof r.id === "string" && isStrings(r.over) && typeof r.tomb === "string" && typeof r.at === "string" && (r.records === undefined || Array.isArray(r.records));
  if (!doc.markers.every((m) => typeof m === "object" && m !== null && typeof m.key === "string" && typeof m.account === "string" && Array.isArray(m.removals) && m.removals.every(removalOk))) return null;
  if (!doc.revokes.every((r) => typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.key === "string" && (r.account === null || typeof r.account === "string") && typeof r.at === "string" && (r.untrusted_time === undefined || (r.untrusted_time === true && isIsoTime(r.at))) && (r.legacy_time === undefined || r.legacy_time === true))) return null;
  if (!doc.unrevokes.every((u) => typeof u === "object" && u !== null && typeof u.id === "string" && typeof u.revoke === "string" && typeof u.at === "string" && typeof u.by === "string")) return null;
  return doc as Doc;
}

/** The forgettings the safety log holds for a key and account (server/account/safety-log.ts). */
export interface Forgettings { forgets(key: string, account: string): readonly string[] }

/** The id of a local Revoke, the same whether it is made here or read back from a tombstone (P13). */
function localRevokeId(key: string, account: string, at: string): string {
  return createHash("sha256").update(`${key}\n${account}\n${at}`).digest("hex").slice(0, 32);
}

export class RemovalEvidence {
  private doc: Doc = { v: 1, markers: [], revokes: [], unrevokes: [] };
  private problem: string | null = null;
  private written = false;

  private constructor(private readonly path: string, private readonly log: Forgettings | null) {}

  static open(stateDir: string, log: Forgettings | null): RemovalEvidence {
    const evidence = new RemovalEvidence(join(stateDir, REMOVAL_FILE), log);
    let text: string;
    try { text = readFileSync(evidence.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") evidence.problem = `Cannot read ${evidence.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(stateDir, DEVICE_JOURNAL_FILE))) evidence.problem = `${evidence.path} is missing beside the device journal`;
      return evidence;
    }
    // evidence anyone else can write is no evidence this PC keeps (S19)
    if (process.platform !== "win32" && (statSync(evidence.path).mode & 0o022) !== 0) { evidence.problem = `${evidence.path} can be written by others`; return evidence; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { evidence.problem = `${evidence.path} is not JSON`; return evidence; }
    const doc = parseDoc(value);
    if (doc === null) evidence.problem = `${evidence.path} is not this PC's removal evidence`;
    else evidence.doc = doc;
    return evidence;
  }

  /** Whether the file is on disk. */
  get onDisk(): boolean { return existsSync(this.path); }

  /** A missing file this PC once wrote is damage, not a fresh start (S19). */
  missingAfterWritten(): void {
    if (this.problem === null && !this.onDisk) this.problem = `${this.path} is missing, though this PC wrote it before`;
  }

  /** Why this PC fails closed, or null: a key may be out that this PC cannot tell any more. */
  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the removal evidence is restored.`;
  }

  /** Before serving: a replay that cannot finish stays strict until a fresh start can retry it. */
  recover(replay: () => void): void {
    try { replay(); } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.problem = `Cannot finish removal recovery for ${this.path} (${error.message})`;
    }
  }

  private forgets(key: string, account: string): readonly string[] { return this.log?.forgets(key, account) ?? []; }

  private removalStands(marker: Marker, removal: Removal): boolean {
    return this.forgets(marker.key, marker.account).every((forget) => removal.over.includes(forget));
  }

  private revokeStands(revoke: Revoke): boolean { return !this.doc.unrevokes.some((u) => u.revoke === revoke.id); }

  /** The markers of `key` that stand, each with the removals of it that stand. */
  standingMarkers(key: string): { marker: Marker; standing: Removal[] }[] {
    return this.doc.markers.filter((m) => m.key === key)
      .map((marker) => ({ marker, standing: marker.removals.filter((removal) => this.removalStands(marker, removal)) }))
      .filter(({ standing }) => standing.length > 0);
  }

  standingRevokes(key: string): Revoke[] { return this.doc.revokes.filter((r) => r.key === key && this.revokeStands(r)); }

  get rowDrops(): readonly RowDrop[] { return this.doc.row_drops ?? []; }

  dropFor(row: string, admission: number): RowDrop | undefined {
    return this.doc.row_drops?.find(drop => drop.row === row && drop.admit_no === admission);
  }

  markJournalled(drop: RowDrop, seq: number): void {
    const next = withRowDrop(this.doc, { ...drop, journalled: seq });
    if (next !== this.doc) this.write(next);
  }

  /** What first denied this listed row. Later records for an already absent key don't drop it again. */
  accountRowDrop(key: string, account: string): "revoke" | "remove" | "block" | null {
    if (this.standingRevokes(key).length) return "revoke";
    const removal = this.standingMarkers(key).find(({ marker }) => marker.account === account)?.standing[0];
    if (!removal) return null;
    // Imported tombstones can carry several records; only this removal's record identifies its act.
    const blocked = removal.records?.some(record => typeof record === "object" && record !== null &&
      "id" in record && record.id === removal.id && "kind" in record && record.kind === "block");
    return blocked ? "block" : "remove";
  }

  /** The removal ids a pairing of `key` on this PC knew: it stands over every one of them (`paired_over`). */
  pairedOver(key: string): string[] { return this.standingMarkers(key).flatMap(({ standing }) => standing.map((r) => r.id)); }

  /** A signed `remove` (or, later, a block) of `key` under `account`. False when this marker already holds that removal. */
  addRemoval(key: string, account: string, removal: { id: string; at: string; records?: readonly unknown[]; drop?: RowDrop | undefined }): boolean {
    const marker = this.doc.markers.find((m) => m.key === key && m.account === account);
    if (marker?.removals.some((r) => r.id === removal.id)) return false;
    const entry: Removal = { id: removal.id, over: [...this.forgets(key, account)], tomb: removal.id, at: removal.at, ...(removal.records ? { records: [...removal.records] } : {}) };
    let removals = [...marker?.removals ?? [], entry];
    // only a removal a forget already ended makes room: one that stands is never dropped, however many there are (T61)
    while (removals.length > MARKER_REMOVALS_MAX) {
      const drop = removals.findIndex((r) => r !== entry && !this.removalStands({ key, account, removals }, r));
      if (drop < 0) break;
      removals.splice(drop, 1);
    }
    const next = { key, account, removals };
    this.write({ ...withRowDrop(this.doc, removal.drop), markers: marker ? this.doc.markers.map((m) => m === marker ? next : m) : [...this.doc.markers, next] });
    return true;
  }

  /** A Revoke on this PC of a row holding `key`: its own entry, the deny that goes to disk before anything else. */
  /** The times this PC wrote here, its Revokes and unrevokes, for the store's one sequence (DeviceStore.nextStamp); a removal's time is the record's. */
  times(): string[] {
    return [...this.doc.revokes.filter(r => !r.untrusted_time && !r.legacy_time).map((r) => r.at), ...this.doc.unrevokes.map((u) => u.at)];
  }

  addRevoke(key: string, account: string | null, now: number, drop?: RowDrop): void {
    const at = new Date(now).toISOString();
    // the id a later start reads this Revoke back under from the tombstone file, so it is taken in once (P13)
    this.write({ ...withRowDrop(this.doc, drop), revokes: [...this.doc.revokes, { id: localRevokeId(key, account ?? "", at), key, account, at }] });
  }

  /** A pairing of `key` on this PC: it ends each Revoke of that key by name, and never touches a marker (T21, T23). */
  unrevoke(key: string, by: string, now: number): number {
    const ended = this.standingRevokes(key);
    if (ended.length === 0) return 0;
    const at = new Date(now).toISOString();
    this.write({ ...this.doc, unrevokes: [...this.doc.unrevokes, ...ended.map((revoke) => ({ id: randomBytes(16).toString("hex"), revoke: revoke.id, at, by }))] });
    return ended.length;
  }

  /**
   * Takes in what the tombstone files hold that this evidence does not yet (T26): every `local` tombstone becomes a
   * Revoke, with an id made from its key, account and time, so one tombstone is taken in once; one older than a row
   * of its key that was paired here is taken in already ended. An account tombstone with no removal of that id
   * becomes one.
   */
  takeIn(tombstones: readonly EvidenceTombstone[], rows: readonly { relay_public_key?: string | undefined; created_at: string; pairedHere: boolean }[], now: number): void {
    let doc = this.doc;
    const at = new Date(now).toISOString();
    for (const tombstone of tombstones) {
      if (tombstone.record_id === "local") {
        // The compatibility projection of a standing Revoke is not a second Revoke to import.
        if (this.standingRevokes(tombstone.key).some(r => (r.account ?? "") === tombstone.account && r.at === tombstone.removed_at)) continue;
        const id = localRevokeId(tombstone.key, tombstone.account, tombstone.removed_at);
        if (doc.revokes.some((r) => r.id === id)) continue;
        const untrusted = isIsoTime(tombstone.removed_at) && Date.parse(tombstone.removed_at) > now + DAY_MS;
        const ended = !untrusted && rows.some((row) => row.relay_public_key === tombstone.key && row.pairedHere && Date.parse(row.created_at) > Date.parse(tombstone.removed_at));
        // A rollback tombstone proves a Revoke, not this PC's clock. It may have been written while the clock was ahead.
        doc = { ...doc, revokes: [...doc.revokes, { id, key: tombstone.key, account: tombstone.account === "" ? null : tombstone.account, at: tombstone.removed_at, legacy_time: true,
          ...(untrusted ? { untrusted_time: true as const } : {}) }],
          unrevokes: ended ? [...doc.unrevokes, { id: randomBytes(16).toString("hex"), revoke: id, at, by: "pc" }] : doc.unrevokes };
        continue;
      }
      if (doc.markers.some((m) => m.key === tombstone.key && m.removals.some((r) => r.id === tombstone.record_id))) continue;
      const removal: Removal = { id: tombstone.record_id, over: [...this.forgets(tombstone.key, tombstone.account)], tomb: tombstone.record_id, at: tombstone.removed_at, ...(tombstone.records ? { records: tombstone.records } : {}) };
      const marker = doc.markers.find((m) => m.key === tombstone.key && m.account === tombstone.account);
      doc = { ...doc, markers: marker ? doc.markers.map((m) => m === marker ? { ...m, removals: [...m.removals, removal] } : m) : [...doc.markers, { key: tombstone.key, account: tombstone.account, removals: [removal] }] };
    }
    // a re-pair whose row reached the disk before its unrevoke did ends the Revoke it outlived (T26)
    for (const revoke of doc.revokes) {
      if (revoke.untrusted_time || doc.unrevokes.some((u) => u.revoke === revoke.id)) continue;
      if (rows.some((row) => row.relay_public_key === revoke.key && row.pairedHere && Date.parse(row.created_at) > Date.parse(revoke.at))) doc = { ...doc, unrevokes: [...doc.unrevokes, { id: randomBytes(16).toString("hex"), revoke: revoke.id, at, by: "pc" }] };
    }
    if (doc !== this.doc || !this.written) this.write(doc);
  }

  /** The tombstone file, as the evidence writes it: one per key, the account's over a Revoke's. */
  tombstones(): EvidenceTombstone[] {
    const keys = new Set([...this.doc.markers.map((m) => m.key), ...this.doc.revokes.map((r) => r.key)]);
    const out: EvidenceTombstone[] = [];
    for (const key of keys) {
      const [first] = this.standingMarkers(key);
      if (first !== undefined) {
        const latest = first.standing.at(-1)!;
        const records = first.standing.flatMap((r) => r.records ?? []).slice(0, MARKER_REMOVALS_MAX);
        out.push({ key, account: first.marker.account, record_id: latest.tomb, removed_at: latest.at, ...(records.length ? { records } : {}) });
        continue;
      }
      const revoke = this.standingRevokes(key).at(-1);
      if (revoke !== undefined) out.push({ key, account: revoke.account ?? "", record_id: "local", removed_at: revoke.at });
    }
    return out;
  }

  private write(doc: Doc): void {
    if (this.problem !== null) throw new Error(this.strict!);
    writePrivateState(this.path, doc);
    this.doc = doc;
    this.written = true;
  }
}
