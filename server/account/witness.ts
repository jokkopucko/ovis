/**
 * For how long this PC has let each key in through its account (docs/account.md, "How long a key has been let
 * in"): `account-witness.json` in the state folder (0600, written through private-state.ts). It only records. Moving
 * an account onto its signed list will count a key only where a PC has let it in for a day, and a record has to have
 * run for that day before anything can ask it, which is why it is kept from now on.
 *
 * Per key it keeps two counters of time, never a moment: `ran`, the time this PC itself ran with the key let in, and
 * `wall`, the time by the wall clock, which also counts while the PC is off. Neither is a difference of two clock
 * readings that a clock set forward could stretch: within a run `wall` grows by no more than the time the process ran
 * and a minute, and across a restart by the gap since the last write, a day at most. What was not written at a crash
 * is lost, which only delays.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LetIn } from "../../shared/account-list-migrate.ts";
import { privateStateFs, writePrivateState } from "../private-state.ts";

export const ACCOUNT_WITNESS_FILE = "account-witness.json";
/** How often the time that passed is taken and written: what a crash loses is less than five minutes. */
export const WITNESS_INTERVAL_MS = 4 * 60_000;
/** How much more than the process's own running time one interval may count by the wall clock. */
const WALL_SLACK_MS = 60_000;
/** The most a restart counts for the time the PC was off, however far the wall clock moved. */
const RESTART_GAP_MAX_MS = 86_400_000;

/** A row of the account that is out of its hold and stands: `lets` is false while it waits (for a whole read, say). */
export interface WitnessedRow {
  readonly key: string;
  readonly lets: boolean;
  /** When the row was last used with proof of its key, in seconds, or null. */
  readonly seen: number | null;
}

export interface WitnessRecord {
  readonly v: 1;
  readonly account: string;
  readonly server_id: string;
  /** The wall clock at the last write, in seconds. */
  readonly saved: number;
  readonly keys: Readonly<Record<string, { readonly wall: number; readonly ran: number; readonly seen: number | null }>>;
}

export interface WitnessDeps {
  readonly stateDir: string;
  /**
   * The account this PC is in (null: none) and its relay identity; null while the relay identity is not known, which
   * is no word that anything changed.
   */
  scope(): { readonly account: string | null; readonly serverId: string } | null;
  /** The account's rows that are out of their hold; null when they cannot be read, which is no word that they are gone. */
  rows(): readonly WitnessedRow[] | null;
  /** The wall clock and the process's own running time, in milliseconds. */
  wall?(): number;
  mono?(): number;
  /** What the durations this PC hands over are multiplied by: 1 but on a staging run (migrate-time.ts). */
  readonly scale?: number;
}

interface Held {
  readonly account: string;
  readonly serverId: string;
  readonly keys: Map<string, { wall: number; ran: number; seen: number | null }>;
}

const isSpan = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parse(text: string): WitnessRecord | null {
  let file: unknown;
  try { file = JSON.parse(text); } catch { return null; }
  if (typeof file !== "object" || file === null) return null;
  const { v, account, server_id, saved, keys } = file as Record<string, unknown>;
  if (v !== 1 || typeof account !== "string" || typeof server_id !== "string" || !isSpan(saved) || typeof keys !== "object" || keys === null || Array.isArray(keys)) return null;
  for (const row of Object.values(keys)) {
    if (typeof row !== "object" || row === null) return null;
    const { wall, ran, seen } = row as Record<string, unknown>;
    if (!isSpan(wall) || !isSpan(ran) || !(seen === null || isSpan(seen))) return null;
  }
  return file as WitnessRecord;
}

export class AccountWitness {
  private readonly path: string;
  private held: Held | null = null;
  private loaded = false;
  /** The clocks at the last step, and the keys whose rows let them in then: only a key let in at both ends of an interval counts it. */
  private last: { readonly wall: number; readonly mono: number; readonly letting: ReadonlySet<string> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failed = false;
  /** The file of an account this PC left is still on disk: its deletion failed, and is tried again at each step. */
  private leftOver = false;

  constructor(private readonly deps: WitnessDeps) {
    this.path = join(deps.stateDir, ACCOUNT_WITNESS_FILE);
  }

  /** What the durations this PC hands over are multiplied by: 1 but on a staging run. */
  get scale(): number { return this.deps.scale ?? 1; }

  start(): void {
    if (this.timer !== null) return;
    this.step();
    this.timer = setInterval(() => this.step(), WITNESS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.step();
  }

  /** What the file holds, or would after the next write; null on a PC in no account. */
  record(): WitnessRecord | null {
    const held = this.held;
    if (held === null) return null;
    const seconds = (ms: number) => Math.floor(ms / 1000);
    return {
      v: 1, account: held.account, server_id: held.serverId, saved: seconds(this.last?.wall ?? this.wall()),
      keys: Object.fromEntries([...held.keys].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, row]) => [key, { wall: seconds(row.wall), ran: seconds(row.ran), seen: row.seen }])),
    };
  }

  /**
   * What this PC tells a device of its account that asks (GET /api/account/list/witness): the account, and the keys its
   * account rows let in to drive right now, each with how long it has, by both counters, in seconds, and how long ago
   * it was last used here (null: not since it was let in). A row that waits, for a whole read say, lets nobody in and
   * is none of them; a pairing made at this PC never is. Null on a PC in no account, or whose rows cannot be read.
   */
  admits(): { readonly account: string; readonly admits: readonly LetIn[] } | null {
    // The counts as of the last step, which runs on its own timer: an answer takes one only when that is due, so no
    // caller makes this PC write the file, or counts the minute of slack per step, more often than the timer does
    if (this.last === null || this.mono() - this.last.mono >= WITNESS_INTERVAL_MS) this.step();
    const held = this.held;
    const last = this.last;
    if (held === null || last === null) return null;
    // whom the rows let in right now, read only: a row that began to wait since the last step lets nobody in. Rows that
    // cannot be read are no answer, not an answer that nobody is let in
    const rows = this.deps.rows();
    if (rows === null) return null;
    const letting = new Map<string, number | null>();
    for (const row of rows) if (row.lets) letting.set(row.key, Math.max(letting.get(row.key) ?? -1, row.seen ?? -1));
    const scale = this.deps.scale ?? 1;
    // how long ago a key was last used is read now, from the newest use the rows or the record know
    const now = Math.floor(this.wall() / 1000);
    const admits = [...held.keys].filter(([key]) => letting.has(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, row]) => {
      const seen = Math.max(row.seen ?? -1, letting.get(key) ?? -1);
      return { key, wall: Math.floor(row.wall / 1000) * scale, ran: Math.floor(row.ran / 1000) * scale, idle: seen < 0 ? null : Math.max(0, now - seen) };
    });
    return { account: held.account, admits };
  }

  /**
   * Takes the time since the last step for every key let in at both of its ends, lets in what newly stands at nothing,
   * drops what no longer stands, and writes. Called on a timer, at the stop, and when rows are dropped, so a row that
   * goes and comes back between two timer steps is not taken for one that stayed.
   */
  step(): void {
    // it only records: a failure of its own never reaches the write of the rows or the timer that called it
    try { this.take(); } catch (error) { this.say(error); }
  }

  private take(): void {
    const wall = this.wall();
    const mono = this.mono();
    const before = this.last;
    // set before anything is read: an interval whose rows could not be read is one in which no key counts, at both of its ends
    this.last = { wall, mono, letting: new Set() };
    const scope = this.deps.scope();
    const rows = scope === null || scope.account === null ? null : this.deps.rows();
    const letting = new Set((rows ?? []).filter((row) => row.lets).map((row) => row.key));
    this.last = { wall, mono, letting };
    if (scope === null) return;
    if (scope.account === null) { this.end(); return; }
    if (this.held === null || this.held.account !== scope.account || this.held.serverId !== scope.serverId) {
      this.held = { account: scope.account, serverId: scope.serverId, keys: this.loaded ? new Map() : this.load(scope.account, scope.serverId, wall) };
      this.loaded = true;
    }
    // Rows that cannot be read count for no key, and the file still says when it was last written: the time since
    // then is no time the PC was off, so a restart gives none of it back
    if (rows === null) { this.write(); return; }
    const { keys } = this.held;
    const standing = new Map<string, number | null>();
    for (const row of rows) {
      const seen = standing.get(row.key);
      standing.set(row.key, seen == null ? row.seen : row.seen === null ? seen : Math.max(seen, row.seen));
    }
    for (const key of [...keys.keys()]) if (!standing.has(key)) keys.delete(key);
    if (before !== null) {
      const ran = Math.max(0, mono - before.mono);
      const passed = Math.max(0, Math.min(wall - before.wall, ran + WALL_SLACK_MS));
      for (const [key, row] of keys) {
        if (!letting.has(key) || !before.letting.has(key)) continue;
        row.ran += ran;
        row.wall += passed;
      }
    }
    for (const [key, seen] of standing) {
      const row = keys.get(key);
      if (row === undefined) keys.set(key, { wall: 0, ran: 0, seen });
      else row.seen = seen;
    }
    this.write();
  }

  /** The file's keys for this account and relay identity, each with the time the PC was off; none from any other file. */
  private load(account: string, serverId: string, wall: number): Held["keys"] {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch { return new Map(); }
    const file = parse(text);
    if (file === null || file.account !== account || file.server_id !== serverId) return new Map();
    const off = Math.max(0, Math.min(wall - file.saved * 1000, RESTART_GAP_MAX_MS));
    return new Map(Object.entries(file.keys).map(([key, row]) => [key, { wall: row.wall * 1000 + off, ran: row.ran * 1000, seen: row.seen }]));
  }

  /** The PC is in no account: the record goes with the binding. */
  private end(): void {
    if (this.held === null && this.loaded && !this.leftOver) return;
    this.held = null;
    this.loaded = true;
    try {
      privateStateFs.unlinkSync(this.path);
      this.leftOver = this.failed = false;
    } catch (error) {
      // a file that is not there is deleted; any other failure is tried again at the next step
      this.leftOver = (error as NodeJS.ErrnoException).code !== "ENOENT";
      if (this.leftOver) this.say(error); else this.failed = false;
    }
  }

  private write(): void {
    try {
      writePrivateState(this.path, this.record());
      this.failed = false;
    } catch (error) { this.say(error); }
  }

  /** Once per failure that lasts: the counters go on in memory, and the next write that works holds them. */
  private say(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    console.error(`[account] ${ACCOUNT_WITNESS_FILE} could not be kept: ${error instanceof Error ? error.message : String(error)}`);
  }

  private wall(): number { return this.deps.wall?.() ?? Date.now(); }
  private mono(): number { return this.deps.mono?.() ?? performance.now(); }
}
