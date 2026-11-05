/**
 * The status of an OmO pane, read from OmO's own records.
 *
 * herdr reports nothing for one: OmO runs its claude child without the user's settings, so
 * herdr's hook never runs in it, and the pane reads `claude/idle` through a whole turn with no
 * status event (#286: three panes watched for three minutes, no frame). The sidebar never said
 * RUN, a message sent meanwhile was not held, and no done alert came.
 *
 * OmO appends to the session file of the session the pane holds (omo.ts finds it) as a turn
 * goes: a turn is running after a user message, a tool result, an assistant message that
 * stopped for a tool, or one of the runtime's own messages that start a turn (a finished
 * background task, a monitor, a goal continuation); it is over after an assistant message that
 * stopped for good. Measured over 40 session files: each of 492 such runtime messages written at
 * rest was followed by an assistant message, a median of 5 s later, so the message itself is the
 * start. An answer that ended in an error ends the turn too: OmO may retry (the next
 * answer followed 2, 4, 8 and 16 s later), but nothing it writes tells a retry from giving up.
 * Its `senpi.hooks.stop-state` record follows 2 ms after an error either way (350 of them were
 * followed by a retry), and is held back while a background task runs, so waiting for it kept a
 * pane at RUN for good. Such a turn did not finish, though: the pane reads READY, not DONE, and
 * no finish is alerted (#687: a model that gave up after its retries read DONE, with the agent
 * still there). A retry that gets an answer shows as RUN again from that answer, and one that
 * ends the turn is the finish after all. Nothing of OmO's or Claude's is installed or changed
 * for this: files are read.
 *
 * A question OmO asks the user (omo-ask.ts) holds the pane at INPUT while it is open, whatever the
 * turn does: one that waits for its answer stopped the turn for a tool (RUN until now), and one
 * that does not wait lets the turn go on or end (RUN or DONE until now) with the question still
 * open over the input box.
 *
 * The status replaces herdr's for the pane before CompletionTracker sees it, in status events and
 * in snapshots alike, under the one identity `omo`: herdr has named such a pane `pi` and `claude`
 * by turns, and a finish is matched by identity. A pane whose session cannot be told keeps
 * herdr's status, under the same identity.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { readOmoLinesCooperatively, type OmoLine } from "./omo-records.ts";
export { readOmoLines as readLines, type OmoLine } from "./omo-records.ts";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { omoAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { omoDetachedAfter, type OmoDetachedCell } from "./omo-detached.ts";
import { omoJobCount, omoJobsAfter, omoJobTasks, type OmoJobs } from "./omo-jobs.ts";
import type { OmoTask } from "../shared/protocol.ts";
import type { OmoRest } from "./completion.ts";
import { OMO_RUNNING, omoStateDir, type OmoStateOptions } from "./omo-state-dir.ts";

/** runtime messages that start a turn nobody typed; one not named here shows as RUN from its first answer on */
const TURN_STARTS = new Set([
  "goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification",
  "senpi-codemode:notification", "senpi.todo-owed", "omo-init-deep-advisor:run", "omo-onboarding:bootstrap", "ttsr-injection",
]);

/** what herdr has called an OmO pane: by its engine, or by the claude child it runs */
export const OMO_ALIASES: readonly string[] = ["claude", "pi"];

export interface OmoTurn {
  status: "working" | "idle" | null;
  /** at rest after an answer that ended in an error: no finish */
  failed?: boolean;
  /** when the entry that decided the status was written */
  at: number | null;
  /** the questions open for the user */
  asks: OmoAsks;
  /** eval cells whose terminal notification has not arrived */
  detached?: readonly OmoDetachedCell[];
  /** background commands, monitors and detached cells, for the list (omo-jobs.ts) */
  jobs?: OmoJobs;
}

export const noTurn = (): OmoTurn => ({ status: null, at: null, asks: [] });

/** A pane's status: INPUT while a question is open, else its turn's. */
export type OmoPaneStatus = "working" | "idle" | "blocked";

/** One session record, applied to the turn so far. */
export function omoTurnAfter(turn: OmoTurn, line: OmoLine): OmoTurn {
  if (!("text" in line) && line.record !== undefined) return omoTurnAfter(turn, { text: line.record });
  const head = "text" in line ? line.text : line.head;
  if ("text" in line && head.startsWith('{"type":"custom"') && head.includes('"customType":"ask-user:settlement"')) {
    try { return { ...turn, asks: omoAsksAfter(turn.asks, JSON.parse(line.text)) }; } catch { return turn; }
  }
  const custom = head.startsWith('{"type":"custom_message"');
  if (!custom && !head.startsWith('{"type":"message"')) return turn;
  let role: unknown, stopReason: unknown, customType: unknown, timestamp: unknown;
  let asks = turn.asks;
  let detached = turn.detached;
  let jobs = turn.jobs;
  if ("text" in line) {
    try {
      const entry = JSON.parse(line.text) as { customType?: unknown; timestamp?: unknown; message?: { role?: unknown; stopReason?: unknown } };
      ({ customType, timestamp } = entry);
      role = entry.message?.role;
      stopReason = entry.message?.stopReason;
      asks = omoAsksAfter(asks, entry);
      detached = omoDetachedAfter(detached ?? [], entry);
      jobs = omoJobsAfter(jobs ?? { running: [], ended: [] }, entry);
    } catch { return turn; }
  } else {
    // Legacy end-only records cannot establish or close a question safely.
    role = line.head.match(/"role":"(\w+)"/)?.[1];
    stopReason = (line.tail.match(/"stopReason":"(\w+)"/g)?.at(-1) ?? line.head.match(/"stopReason":"(\w+)"/)?.[0])?.match(/:"(\w+)"/)?.[1];
    customType = line.head.match(/"customType":"([^"]+)"/)?.[1];
    timestamp = line.head.match(/"timestamp":"([^"]+)"/)?.[1];
  }
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : turn.at;
  if (custom) return typeof customType === "string" && TURN_STARTS.has(customType) ? { status: "working", at, asks, detached, jobs } : { ...turn, jobs };
  if (role === "assistant") return stopReason === "toolUse" ? { status: "working", at, asks, detached, jobs } : { status: "idle", ...(stopReason === "error" ? { failed: true } : {}), at, asks, detached, jobs };
  return role === "user" || role === "toolResult" ? { status: "working", at, asks, detached, jobs } : { ...turn, asks, detached, jobs };
}

/** The turn at the end of a session text. */
export function omoTurnStatus(text: string): "working" | "idle" | null {
  let turn = noTurn();
  for (const line of text.split("\n")) turn = omoTurnAfter(turn, { text: line });
  return turn.status;
}

/** `<timestamp>_<session id>.jsonl` */
export function omoSessionId(path: string): string | null {
  return basename(path).match(/_([A-Za-z0-9-]{8,128})\.jsonl$/)?.[1] ?? null;
}

/**
 * How many background tasks each session of a folder has running: OmO keeps one record per
 * `task` child in the resolved senpi-task state's `tasks/`, with the session that started it.
 * Populated legacy project stores still win over the agent directory's `projects/<key>` store.
 * Pending and running records whose host process is gone are not counted.
 */
export function omoBackgroundTasks(cwd: string, alive: (pid: number) => boolean = processAlive, options: OmoStateOptions = {}): Map<string, number> {
  const running = new Map<string, number>();
  let dir: string;
  let names: string[];
  // a folder that cannot be resolved (permissions) counts nothing, and picks no other store
  try { dir = join(omoStateDir(cwd, options), "tasks"); names = readdirSync(dir); } catch { return running; }
  for (const name of names.slice(0, 2048)) {
    if (!name.startsWith("st_") || !name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status?: unknown; parent_session_id?: unknown; host_pid?: unknown };
      if (typeof record.status !== "string" || !OMO_RUNNING.has(record.status) || typeof record.parent_session_id !== "string") continue;
      if (typeof record.host_pid === "number" && !alive(record.host_pid)) continue;
      running.set(record.parent_session_id, (running.get(record.parent_session_id) ?? 0) + 1);
    } catch { /* being written, or not a record */ }
  }
  return running;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** An OmO pane: the session file it holds (null when it cannot be told) and when its OmO process started. */
export interface OmoPane { path: string | null; startedAt: number | null }

export interface OmoFile {
  /** its size, and what tells the file from one put in its place (a session file can be rewritten whole) */
  stat: (path: string) => { size: number; id: string } | null;
  /** the lines from `from` to `size`, and the offset read to; stop between chunks when no longer current */
  lines: (path: string, from: number, size: number, each: (line: OmoLine) => void, current: () => boolean) => number | Promise<number>;
}

export interface OmoStatusDeps {
  /** the panes of a snapshot that run OmO, whatever herdr calls them: one process lookup per pane */
  discover: (panes: HerdrPane[]) => Promise<Map<string, OmoPane>>;
  snapshot: () => Promise<SessionSnapshot>;
  /**
   * `turn`: the pane's turn started or ended; otherwise only its background tasks changed.
   * `rest`: why a pane at rest is (completion.ts `OmoRest`), where an error had a part in it
   */
  onChange: (paneId: string, status: AgentStatus, background: number, turn: boolean, rest?: OmoRest) => void;
  /** a pane was found to run OmO: what herdr called it until now is the same agent */
  onFound?: (paneId: string, again: boolean) => void;
  /** the identity the panes' status is reported under (`omo`), and the names herdr gave the agent before */
  agent?: string;
  aliases?: readonly string[];
  /** a session record applied to the turn so far (`omoTurnAfter`): another agent's records have their own */
  turnAfter?: (turn: OmoTurn, line: OmoLine) => OmoTurn;
  /**
   * Whether the pane's own status may replace herdr's (default: always, once the session file
   * is known). GJC withholds it until a turn record was read and the read is current:
   * `available` says the file could be opened at the last poll, `complete` that everything it
   * held was read to a record's end. An empty, gone or half-written transcript is nobody's
   * rest, and an idle that cannot be shown is not the pane's.
   */
  ready?: (tracked: { status: OmoPaneStatus; turn: OmoTurn; available: boolean; complete: boolean }) => boolean;
  /** a turn the process holding the file now could not have run is an interruption told as a failed rest (GJC); default: a plain rest (OmO) */
  staleIsFailure?: boolean;
  file?: OmoFile;
  background?: (cwd: string) => Map<string, number>;
  /** how often the session files are looked at, and the panes found anew */
  pollMs?: number;
  refreshMs?: number;
  now?: () => number;
}

interface Tracked extends OmoPane { cwd: string; sessionCwd?: string; offset: number; size: number; id: string; /** found again after a while herdr's status stood for it: a turn still running is told anew */ retell: boolean; turn: OmoTurn; status: OmoPaneStatus; /** at rest after an error, and when that error was written */ failed: boolean; failedAt: number | null; /** what is read now is the file's history, found anew: not written since it was being read */ history: boolean; background: number; /** the file could be opened at the last poll, and all it held was read to a record's end */ available: boolean; complete: boolean; /** a poll has considered this pane: a baseline it then read is nobody's news */ polled: boolean; /** the pane's own status stood for it at the last poll */ authoritative: boolean }

const FILES: OmoFile = {
  stat: (path) => { try { const fd = openSync(path, "r"); try { const stat = fstatSync(fd); return { size: stat.size, id: `${stat.dev}:${stat.ino}` }; } finally { closeSync(fd); } } catch { return null; } },
  lines: (path, from, size, each, current) => {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return from; }
    try {
      const read = readOmoLinesCooperatively(fd, from, size, each, current);
      if (read instanceof Promise) return read.catch(() => from).finally(() => closeSync(fd));
      closeSync(fd);
      return read;
    } catch { closeSync(fd); return from; }
  },
};

/** A turn older than the process that holds the session now was another process's: it did not finish, and is not running. */
const STALE_TURN_MS = 2000;

export class OmoStatus {
  /** every pane that runs OmO; those whose session is known carry a status */
  private readonly panes = new Map<string, Tracked>();
  /** what a pane read when its OmO was last told from it, while the pane itself is still there: found again, it goes on from that */
  private readonly last = new Map<string, { status: OmoPaneStatus; failed: boolean; failedAt: number | null; background: number; path: string; startedAt: number | null }>();
  private refreshedAt = -Infinity;
  private refreshedFor = "";
  private refreshing: Promise<void> | null = null;
  /** A pane has at most one read in flight; its unpublished replay is private to that read. */
  private readonly reading = new Map<Tracked, Promise<void>>();
  /** counts the panes taken from OmO by an event: a lookup started before one says nothing of them */
  private generation = 0;
  /** stop invalidates every read; a renamed pane invalidates only its own tracked object. */
  private readGeneration = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private readonly file: OmoFile;
  private readonly background: NonNullable<OmoStatusDeps["background"]>;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly agent: string;
  private readonly aliases: readonly string[];
  private readonly turnAfter: NonNullable<OmoStatusDeps["turnAfter"]>;
  private readonly ready: NonNullable<OmoStatusDeps["ready"]>;
  private readonly staleIsFailure: boolean;

  constructor(private readonly deps: OmoStatusDeps) {
    this.file = deps.file ?? FILES;
    this.background = deps.background ?? omoBackgroundTasks;
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? 5000;
    this.agent = deps.agent ?? "omo";
    this.aliases = deps.aliases ?? OMO_ALIASES;
    this.turnAfter = deps.turnAfter ?? omoTurnAfter;
    this.ready = deps.ready ?? (() => true);
    this.staleIsFailure = deps.staleIsFailure ?? false;
  }

  /** Watches with no browser connected too: web push depends on it. */
  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.deps.pollMs ?? 1000;
    const every = Math.max(1, Math.round(this.refreshMs / pollMs));
    this.timer = setInterval(() => {
      void this.poll();
      const generation = this.generation;
      if (++this.ticks % every === 0) void this.deps.snapshot().then((snapshot) => {
        if (generation === this.generation) return this.refresh(snapshot.panes);
      }).catch(() => undefined);
    }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
    this.readGeneration += 1;
  }

  /** the pane's own status may replace herdr's only while it is allowed to (omo: once the session is known) */
  private authoritative(tracked: Tracked): boolean {
    return tracked.path !== null && this.ready(tracked);
  }

  /** herdr's status for this pane is replaced: its events say nothing true. */
  tracks(paneId: string): boolean {
    const tracked = this.panes.get(paneId);
    return tracked !== undefined && this.authoritative(tracked);
  }

  /** The pane runs OmO, its session known or not: its identity is `omo` whatever herdr calls it. */
  runs(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  backgroundOf(paneId: string): number {
    return this.panes.get(paneId)?.background ?? 0;
  }

  /** The pane's background commands, monitors and detached cells, as the list shows them. */
  jobsOf(paneId: string): OmoTask[] {
    const tracked = this.panes.get(paneId);
    return tracked === undefined ? [] : omoJobTasks(tracked.turn.jobs, tracked.startedAt);
  }

  /** The native session already resolved for this pane; no new process or file lookup. */
  pathOf(paneId: string): string | null {
    return this.panes.get(paneId)?.path ?? null;
  }

  /** The folder and session id of the OmO session the pane holds, once its file is known. */
  sessionOf(paneId: string): { cwd: string; sessionId: string } | null {
    const tracked = this.panes.get(paneId);
    const sessionId = tracked?.path == null ? null : omoSessionId(tracked.path);
    const cwd = tracked?.sessionCwd ?? tracked?.cwd;
    return cwd && sessionId !== null ? { cwd, sessionId } : null;
  }

  /**
   * Finds the OmO panes of a snapshot and their session files. Asked of herdr at most once per
   * `refreshMs` while the panes stay the same: each pane costs a process lookup.
   */
  async refresh(panes: HerdrPane[]): Promise<void> {
    const generation = this.generation;
    const key = panes.map((pane) => `${pane.pane_id}\0${pane.agent ?? ""}\0${pane.cwd ?? ""}`).join("\n");
    if (key === this.refreshedFor && this.now() - this.refreshedAt < this.refreshMs) {
      await Promise.all(this.reading.values());
      return;
    }
    if (this.refreshing) {
      await this.refreshing;
      if (generation === this.generation) await this.poll();
      return;
    }
    this.refreshing = (async () => {
      const found = await this.deps.discover(panes);
      if (generation !== this.generation) return;
      const cwds = new Map(panes.map((pane) => [pane.pane_id, pane.cwd ?? ""]));
      for (const [paneId, gone] of this.panes) {
        if (found.has(paneId)) continue;
        this.remember(paneId, gone);
        this.panes.delete(paneId);
      }
      for (const paneId of [...this.last.keys()]) if (!cwds.has(paneId)) this.last.delete(paneId);
      for (const [paneId, pane] of found) {
        const before = this.panes.get(paneId);
        // `again`: OmO held it when last looked at, and goes on from what it read then
        if (!before) this.deps.onFound?.(paneId, this.last.has(paneId));
        // the same session goes on being read from where it was: what happened meanwhile is told.
        // A start that cannot be read this time is the one read before
        if (before && before.path === pane.path) before.startedAt = pane.startedAt ?? before.startedAt;
        else {
          // another session, or the pane's OmO or its session found again: a turn that ended
          // meanwhile is told against what the pane read before, and the same session's process
          // started when it was last known to
          if (before) this.remember(paneId, before);
          const prior = this.last.get(paneId);
          const startedAt = pane.startedAt ?? before?.startedAt ?? (prior?.path === pane.path ? prior.startedAt : null);
          // an error the pane rested on is the same session's alone: another one's answers finish nothing of it
          const same = prior !== undefined && prior.path === pane.path;
          this.panes.set(paneId, { ...pane, startedAt, cwd: cwds.get(paneId) ?? "", offset: -1, size: -1, id: "", retell: prior !== undefined, turn: noTurn(), status: prior?.status ?? "idle", failed: same && prior.failed, failedAt: same ? prior.failedAt : null, history: false, background: prior?.background ?? 0, available: false, complete: false, polled: this.deps.ready !== undefined && (before?.polled === true || prior !== undefined), authoritative: false });
        }
        if (pane.path !== null) this.last.delete(paneId);
      }
      this.refreshedFor = key;
      this.refreshedAt = this.now();
    })().finally(() => { this.refreshing = null; });
    // Discovery must not be held behind replay: a later lookup can replace a session mid-read.
    await this.refreshing;
    if (generation === this.generation) await this.poll();
  }

  private remember(paneId: string, tracked: Tracked): void {
    if (tracked.path !== null) this.last.set(paneId, { status: tracked.status, failed: tracked.failed, failedAt: tracked.failedAt, background: tracked.background, path: tracked.path, startedAt: tracked.startedAt });
  }

  /**
   * herdr named the pane's agent in a status event. Another agent than the names it gives OmO
   * (Codex started where OmO ran) ends OmO's hold on the pane at once, not at the next lookup:
   * that agent's events are its own, a question it asks among them. True when the pane was
   * OmO's until now: what OmO did there is then no part of the other agent's status.
   */
  named(paneId: string, agent: string | null): boolean {
    if (agent === null || agent === this.agent || this.aliases.includes(agent)) return false;
    const held = this.panes.delete(paneId);
    const remembered = this.last.delete(paneId);
    if (!held && !remembered) return false;
    this.generation += 1;
    this.refreshedFor = "";
    return true;
  }

  /** Pane end cancels its replay and any discovery begun before the lifecycle event. */
  ended(paneId: string): void {
    this.panes.delete(paneId);
    this.last.delete(paneId);
    this.generation += 1;
    this.refreshedFor = "";
  }

  /**
   * Reads what the session files gained; a turn that started or ended is told. A pane found at
   * rest tells nobody; one found in a turn tells it, so that its end is a finish.
   */
  poll(): Promise<void> {
    const counts = new Map<string, Map<string, number>>();
    const pending: Promise<void>[] = [];
    for (const [paneId, tracked] of this.panes) {
      const reading = this.reading.get(tracked);
      if (reading) { pending.push(reading); continue; }
      if (tracked.path === null) { this.noteAuthority(tracked); continue; }
      const path = tracked.path;
      const stat = this.file.stat(path);
      tracked.available = stat !== null;
      if (stat === null) { tracked.complete = false; this.noteAuthority(tracked); continue; }
      const { size } = stat;
      const generation = this.readGeneration;
      const current = () => generation === this.readGeneration && this.panes.get(paneId) === tracked;
      let invalidated = false;
      const readable = () => {
        if (!current() || invalidated) return false;
        const latest = this.file.stat(path);
        invalidated = latest === null || latest.id !== stat.id || latest.size < size;
        return !invalidated;
      };
      // Reducing historical records must not expose intermediate RUN, INPUT or DONE states.
      const next = { ...tracked };
      let offset: number | Promise<number> = tracked.offset;
      if (tracked.offset <= 0 || size < tracked.offset || stat.id !== tracked.id) offset = this.readFrom(next, path, size, readable);
      // also what a read that failed left unread
      else if (size !== tracked.size || tracked.offset < size) offset = this.file.lines(path, tracked.offset, size, (line) => { next.turn = this.turnAfter(next.turn, line); }, readable);
      const publish = (offset: number, latest = stat) => {
        if (!current()) return;
        tracked.turn = next.turn;
        tracked.history = next.history;
        if (next.sessionCwd === undefined) delete tracked.sessionCwd;
        else tracked.sessionCwd = next.sessionCwd;
        tracked.offset = offset;
        tracked.size = size;
        tracked.id = stat.id;
        tracked.complete = offset >= latest.size;
        this.publish(paneId, tracked, counts);
      };
      if (offset instanceof Promise) {
        tracked.complete = false;
        // GJC yields authority while behind, but a first replay is still a silent baseline.
        if (tracked.polled) this.noteAuthority(tracked);
        const reading = offset.then((offset) => {
          if (!current()) return;
          const latest = this.file.stat(path);
          // A replaced or truncated file is another history, not the rest of this replay.
          if (invalidated || latest === null || latest.id !== stat.id || latest.size < size) {
            tracked.offset = -1;
            tracked.available = false;
            tracked.complete = false;
            this.noteAuthority(tracked);
            return;
          }
          publish(offset, latest);
        }).finally(() => { this.reading.delete(tracked); });
        this.reading.set(tracked, reading);
        pending.push(reading);
      } else publish(offset);
    }
    return Promise.all(pending).then(() => undefined);
  }

  /** Publish only the final state of a read range, with the existing history and readiness rules. */
  private publish(paneId: string, tracked: Tracked, counts: Map<string, Map<string, number>>): void {
    // nothing could be read of it (a read that failed): what the pane read before stands until one succeeds
    if (tracked.turn.status === null && tracked.offset < tracked.size) { this.noteAuthority(tracked); return; }
    const stale = tracked.turn.status === "working" && tracked.turn.at !== null && tracked.startedAt !== null && tracked.turn.at < tracked.startedAt - STALE_TURN_MS;
    if (this.staleIsFailure && stale && tracked.turn.asks.length > 0) tracked.turn = { ...tracked.turn, asks: [] };
    const status: OmoPaneStatus = tracked.turn.asks.length > 0 ? "blocked" : tracked.turn.status === "working" && !stale ? "working" : "idle";
    const sessionId = tracked.path === null ? null : omoSessionId(tracked.path);
    const cwd = tracked.sessionCwd ?? tracked.cwd;
    if (!counts.has(cwd)) counts.set(cwd, cwd ? this.background(cwd) : new Map());
    // A resumed file can hold cells from a kernel that died with its previous process.
    const detached = tracked.turn.detached?.filter((cell) => tracked.startedAt === null || cell.at >= tracked.startedAt).length ?? 0;
    const background = (sessionId ? counts.get(cwd)!.get(sessionId) ?? 0 : 0) + detached + omoJobCount(tracked.turn.jobs, tracked.startedAt);
    const failed = status === "idle" && (tracked.turn.failed === true || (this.staleIsFailure && stale));
    // an answer written after the error that ended the turn (a retry's, or one to a new prompt):
    // the pane worked meanwhile, though it read READY, and this rest is the finish of that work.
    // Without the times to tell it newer, it is not taken for one: a finish missed, never made up
    const answered = tracked.failed && tracked.failedAt !== null && status === "idle" && !failed && tracked.turn.status === "idle"
      && tracked.turn.at !== null && tracked.turn.at > tracked.failedAt;
    // an error read from a file found anew is history: it says nothing of a DONE told since
    const rest: OmoRest | undefined = failed ? (tracked.history ? "failed-before" : "failed") : answered ? "answered" : undefined;
    const turn = status !== tracked.status || failed !== tracked.failed || (tracked.retell && status !== "idle");
    tracked.retell = false;
    const changed = turn || background !== tracked.background;
    tracked.status = status;
    tracked.failed = failed;
    tracked.failedAt = failed ? tracked.turn.at : null;
    tracked.history = false;
    tracked.background = background;
    // a pane whose file said nothing while it was polled had herdr's word stand for it:
    // its own status, once it holds again, is told so that last word does not keep standing
    const regained = this.noteAuthority(tracked);
    if ((changed || regained) && this.ready(tracked)) this.deps.onChange(paneId, status, background, turn || regained, rest);
  }

  /**
   * What this poll found the pane's authority to be. True when it returns to a pane that was
   * polled without it: its own status must then be told, though it did not change — the raw
   * word that stood for the pane in between is the one a listener holds.
   */
  private noteAuthority(tracked: Tracked): boolean {
    const authoritative = this.authoritative(tracked);
    const regained = tracked.polled && authoritative && !tracked.authoritative;
    tracked.authoritative = authoritative;
    tracked.polled = true;
    return regained;
  }

  /** Replay from the start once, then consume only appended complete records. */
  private readFrom(tracked: Tracked, path: string, size: number, current: () => boolean): number | Promise<number> {
    tracked.turn = noTurn();
    tracked.history = true;
    delete tracked.sessionCwd;
    let first = true;
    return this.file.lines(path, 0, size, (line) => {
      // The existing replay already reads the session header: no extra file read per poll.
      if (first && "text" in line) {
        try {
          const header = JSON.parse(line.text) as { type?: unknown; cwd?: unknown };
          if (header?.type === "session" && typeof header.cwd === "string" && header.cwd.trim()) tracked.sessionCwd = header.cwd;
        } catch { /* a torn header leaves the pane cwd as the fallback */ }
      }
      first = false;
      tracked.turn = this.turnAfter(tracked.turn, line);
    }, current);
  }

  /**
   * A snapshot with OmO's own status in place of herdr's for the panes whose session is known,
   * and every OmO pane under the identity `omo`. This is what CompletionTracker settles.
   */
  apply<T extends { panes: HerdrPane[]; agents?: SessionSnapshot["agents"] }>(snapshot: T): T {
    if (!snapshot.panes.some((pane) => this.panes.has(pane.pane_id))) return snapshot;
    const own = <P extends { pane_id: string; agent_status: AgentStatus }>(entry: P): P => {
      const tracked = this.panes.get(entry.pane_id);
      if (!tracked) return entry;
      return { ...entry, agent: this.agent, ...(this.authoritative(tracked) ? { agent_status: tracked.status } : {}) };
    };
    return { ...snapshot, panes: snapshot.panes.map(own), ...(snapshot.agents ? { agents: snapshot.agents.map(own) } : {}) };
  }
}
