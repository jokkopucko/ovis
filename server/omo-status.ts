/**
 * herdr reports nothing for an OmO pane: OmO runs its claude child without the user's settings, so
 * herdr's hook never runs in it, and the pane reads `claude/idle` through a whole turn with no
 * status event (#286: three panes watched for three minutes, no frame).
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
 * pane at RUN for good.
 *
 * A question OmO asks the user (omo-ask.ts) holds the pane at INPUT while it is open, whatever the
 * turn does: one that waits for its answer stopped the turn for a tool (RUN until now), and one
 * that does not wait lets the turn go on or end (RUN or DONE until now) with the question still
 * open over the input box.
 *
 * An OmO Ovis started tells, through its extension (approvals/omo.ts), when a run began and when it
 * ended for good, which is how a failure OmO retries is told from one it gave up on: while a run it
 * told began has not ended, the file's rest is not the turn's end. Only the rest is held, and for at
 * most a minute of it (RUN_HOLD_MS), so a run whose end is never told (the relay failed, OmO was
 * killed) is still over by the file's word: the file stays the status's source.
 *
 * The status replaces herdr's for the pane before CompletionTracker sees it, in status events and
 * in snapshots alike, under the one identity `omo`: herdr has named such a pane `pi` and `claude`
 * by turns, and a finish is matched by identity.
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

const TURN_STARTS = new Set([
  "goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification",
  "senpi-codemode:notification", "senpi.todo-owed", "omo-init-deep-advisor:run", "omo-onboarding:bootstrap", "ttsr-injection",
]);

/** what herdr has called an OmO pane: by its engine, or by the claude child it runs */
export const OMO_ALIASES: readonly string[] = ["claude", "pi"];

export interface OmoTurn {
  status: "working" | "idle" | null;
  failed?: boolean;
  at: number | null;
  asks: OmoAsks;
  detached?: readonly OmoDetachedCell[];
  jobs?: OmoJobs;
}

export const noTurn = (): OmoTurn => ({ status: null, at: null, asks: [] });

export type OmoPaneStatus = "working" | "idle" | "blocked";

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

export function omoTurnStatus(text: string): "working" | "idle" | null {
  let turn = noTurn();
  for (const line of text.split("\n")) turn = omoTurnAfter(turn, { text: line });
  return turn.status;
}

export function omoSessionId(path: string): string | null {
  return basename(path).match(/_([A-Za-z0-9-]{8,128})\.jsonl$/)?.[1] ?? null;
}

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

export interface OmoPane { path: string | null; startedAt: number | null }

export interface OmoFile {
  stat: (path: string) => { size: number; id: string } | null;
  lines: (path: string, from: number, size: number, each: (line: OmoLine) => void, current: () => boolean) => number | Promise<number>;
}

export interface OmoStatusDeps {
  discover: (panes: HerdrPane[]) => Promise<Map<string, OmoPane>>;
  snapshot: () => Promise<SessionSnapshot>;
  onChange: (paneId: string, status: AgentStatus, background: number, turn: boolean, rest?: OmoRest) => void;
  onFound?: (paneId: string, again: boolean) => void;
  agent?: string;
  aliases?: readonly string[];
  turnAfter?: (turn: OmoTurn, line: OmoLine) => OmoTurn;
  ready?: (tracked: { status: OmoPaneStatus; turn: OmoTurn; available: boolean; complete: boolean }) => boolean;
  staleIsFailure?: boolean;
  file?: OmoFile;
  background?: (cwd: string) => Map<string, number>;
  pollMs?: number;
  refreshKey?: (pane: HerdrPane) => string;
  refreshMs?: number;
  now?: () => number;
}

interface Tracked extends OmoPane { cwd: string; sessionCwd?: string; offset: number; size: number; id: string; retell: boolean; turn: OmoTurn; status: OmoPaneStatus; failed: boolean; failedAt: number | null; history: boolean; background: number; available: boolean; complete: boolean; polled: boolean; authoritative: boolean }

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

const STALE_TURN_MS = 2000;
/** The longest the file's rest is held after a run told began: OmO's retries came 2 to 9 s apart (approvals/omo.ts). */
const RUN_HOLD_MS = 60_000;

export class OmoStatus {
  private readonly panes = new Map<string, Tracked>();
  private readonly last = new Map<string, { status: OmoPaneStatus; failed: boolean; failedAt: number | null; background: number; path: string; startedAt: number | null }>();
  /**
   * Panes whose OmO's extension told a run began (approvals/omo.ts): the session file it was told for, whether that file
   * has read the turn running since, when it first read rest since the latest run began, and where the file was when the
   * run's end was told.
   */
  private readonly running = new Map<string, { path: string | null; ran: boolean; restSince: number | null; endedAt: { id: string; size: number } | null }>();
  private refreshedAt = -Infinity;
  private refreshedFor = "";
  private refreshing: Promise<void> | null = null;
  private readonly reading = new Map<Tracked, Promise<void>>();
  private generation = 0;
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

  private authoritative(tracked: Tracked): boolean {
    return tracked.path !== null && this.ready(tracked);
  }

  tracks(paneId: string): boolean {
    const tracked = this.panes.get(paneId);
    return tracked !== undefined && this.authoritative(tracked);
  }

  runs(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  backgroundOf(paneId: string): number {
    return this.panes.get(paneId)?.background ?? 0;
  }

  jobsOf(paneId: string): OmoTask[] {
    const tracked = this.panes.get(paneId);
    return tracked === undefined ? [] : omoJobTasks(tracked.turn.jobs, tracked.startedAt);
  }

  pathOf(paneId: string): string | null {
    return this.panes.get(paneId)?.path ?? null;
  }

  sessionOf(paneId: string): { cwd: string; sessionId: string } | null {
    const tracked = this.panes.get(paneId);
    const sessionId = tracked?.path == null ? null : omoSessionId(tracked.path);
    const cwd = tracked?.sessionCwd ?? tracked?.cwd;
    return cwd && sessionId !== null ? { cwd, sessionId } : null;
  }

  async refresh(panes: HerdrPane[]): Promise<void> {
    const generation = this.generation;
    const key = panes.map((pane) => `${pane.pane_id}\0${pane.agent ?? ""}\0${pane.cwd ?? ""}\0${this.deps.refreshKey?.(pane) ?? ""}`).join("\n");
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
        if (!before) this.deps.onFound?.(paneId, this.last.has(paneId));
        if (before && before.path === pane.path) before.startedAt = pane.startedAt ?? before.startedAt;
        else {
          if (before) this.remember(paneId, before);
          const prior = this.last.get(paneId);
          const startedAt = pane.startedAt ?? before?.startedAt ?? (prior?.path === pane.path ? prior.startedAt : null);
          const same = prior !== undefined && prior.path === pane.path;
          this.panes.set(paneId, { ...pane, startedAt, cwd: cwds.get(paneId) ?? "", offset: -1, size: -1, id: "", retell: prior !== undefined, turn: noTurn(), status: prior?.status ?? "idle", failed: same && prior.failed, failedAt: same ? prior.failedAt : null, history: false, background: prior?.background ?? 0, available: false, complete: false, polled: this.deps.ready !== undefined && (before?.polled === true || prior !== undefined), authoritative: false });
        }
        if (pane.path !== null) this.last.delete(paneId);
      }
      this.refreshedFor = key;
      this.refreshedAt = this.now();
    })().finally(() => { this.refreshing = null; });
    await this.refreshing;
    if (generation === this.generation) await this.poll();
  }

  private remember(paneId: string, tracked: Tracked): void {
    if (tracked.path !== null) this.last.set(paneId, { status: tracked.status, failed: tracked.failed, failedAt: tracked.failedAt, background: tracked.background, path: tracked.path, startedAt: tracked.startedAt });
  }

  named(paneId: string, agent: string | null): boolean {
    if (agent === null || agent === this.agent || this.aliases.includes(agent)) return false;
    this.running.delete(paneId);
    const held = this.panes.delete(paneId);
    const remembered = this.last.delete(paneId);
    if (!held && !remembered) return false;
    this.generation += 1;
    this.refreshedFor = "";
    return true;
  }

  /** What the extension of an OmO Ovis started in `paneId` told of its run. */
  told(paneId: string, turn: "began" | "ended"): void {
    const run = this.running.get(paneId);
    const tracked = this.panes.get(paneId);
    if (turn === "began") {
      // a retry's run goes on with the turn as it is, its minute of rest counted from its start. One told after the
      // file published the turn's rest, the file not written since (its relay was late), holds nothing until the file
      // reads a turn running
      if (run !== undefined && run.endedAt === null && run.path === (tracked?.path ?? null)) { run.restSince = null; return; }
      const file = tracked?.path == null ? null : this.file.stat(tracked.path);
      const written = file !== null && (file.id !== tracked!.id || file.size > tracked!.offset);
      this.running.set(paneId, { path: tracked?.path ?? null, ran: tracked !== undefined && (tracked.status !== "idle" || written), restSince: null, endedAt: null });
      return;
    }
    // held until a read of the file covers what it held when the end was told: a read begun before has not seen it
    const file = tracked?.path == null ? null : this.file.stat(tracked.path);
    if (run === undefined || file === null) this.running.delete(paneId);
    else run.endedAt = file;
  }

  /**
   * Whether the file's rest is held for a run told began, which the file read running: until a read covers the file
   * as it was when its end was told, and for RUN_HOLD_MS of rest since the latest run began at most. A run told for
   * another session file (OmO started anew in the pane) holds nothing.
   */
  private holds(paneId: string, tracked: Tracked): boolean {
    const run = this.running.get(paneId);
    if (run === undefined) return false;
    if (run.path !== null && run.path !== tracked.path) { this.running.delete(paneId); return false; }
    run.path ??= tracked.path;
    const read = run.endedAt !== null && (tracked.id !== run.endedAt.id || tracked.offset >= run.endedAt.size);
    run.restSince ??= this.now();
    if (read || this.now() - run.restSince >= RUN_HOLD_MS) { this.running.delete(paneId); return false; }
    return run.ran;
  }

  ended(paneId: string): void {
    this.running.delete(paneId);
    this.panes.delete(paneId);
    this.last.delete(paneId);
    this.generation += 1;
    this.refreshedFor = "";
  }

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
        if (tracked.polled) this.noteAuthority(tracked);
        const reading = offset.then((offset) => {
          if (!current()) return;
          const latest = this.file.stat(path);
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

  private publish(paneId: string, tracked: Tracked, counts: Map<string, Map<string, number>>): void {
    if (tracked.turn.status === null && tracked.offset < tracked.size) { this.noteAuthority(tracked); return; }
    const stale = tracked.turn.status === "working" && tracked.turn.at !== null && tracked.startedAt !== null && tracked.turn.at < tracked.startedAt - STALE_TURN_MS;
    if (this.staleIsFailure && stale && tracked.turn.asks.length > 0) tracked.turn = { ...tracked.turn, asks: [] };
    const read: OmoPaneStatus = tracked.turn.asks.length > 0 ? "blocked" : tracked.turn.status === "working" && !stale ? "working" : "idle";
    const run = this.running.get(paneId);
    if (read !== "idle" && run !== undefined) { run.ran = true; run.restSince = null; }
    const status: OmoPaneStatus = read === "idle" && this.holds(paneId, tracked) ? "working" : read;
    const sessionId = tracked.path === null ? null : omoSessionId(tracked.path);
    const cwd = tracked.sessionCwd ?? tracked.cwd;
    if (!counts.has(cwd)) counts.set(cwd, cwd ? this.background(cwd) : new Map());
    const detached = tracked.turn.detached?.filter((cell) => tracked.startedAt === null || cell.at >= tracked.startedAt).length ?? 0;
    const background = (sessionId ? counts.get(cwd)!.get(sessionId) ?? 0 : 0) + detached + omoJobCount(tracked.turn.jobs, tracked.startedAt);
    const failed = status === "idle" && (tracked.turn.failed === true || (this.staleIsFailure && stale));
    const answered = tracked.failed && tracked.failedAt !== null && status === "idle" && !failed && tracked.turn.status === "idle"
      && tracked.turn.at !== null && tracked.turn.at > tracked.failedAt;
    const rest: OmoRest | undefined = failed ? (tracked.history ? "failed-before" : "failed") : answered ? "answered" : undefined;
    const turn = status !== tracked.status || failed !== tracked.failed || (tracked.retell && status !== "idle");
    tracked.retell = false;
    const changed = turn || background !== tracked.background;
    tracked.status = status;
    tracked.failed = failed;
    tracked.failedAt = failed ? tracked.turn.at : null;
    tracked.history = false;
    tracked.background = background;
    const regained = this.noteAuthority(tracked);
    if ((changed || regained) && this.ready(tracked)) this.deps.onChange(paneId, status, background, turn || regained, rest);
  }

  private noteAuthority(tracked: Tracked): boolean {
    const authoritative = this.authoritative(tracked);
    const regained = tracked.polled && authoritative && !tracked.authoritative;
    tracked.authoritative = authoritative;
    tracked.polled = true;
    return regained;
  }

  private readFrom(tracked: Tracked, path: string, size: number, current: () => boolean): number | Promise<number> {
    tracked.turn = noTurn();
    tracked.history = true;
    delete tracked.sessionCwd;
    let first = true;
    return this.file.lines(path, 0, size, (line) => {
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
