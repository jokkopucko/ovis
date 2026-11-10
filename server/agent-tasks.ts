import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { HerdrPane } from "../shared/protocol.ts";

/**
 * The background tasks an agy or grok session runs, for the pane's count and its turn's hold
 * (server/background-wait.ts), as Claude Code's are read from its transcript
 * (server/claude-subagents.ts). Both start a turn by themselves when a task ends, with no prompt,
 * and herdr reads the pane at rest meanwhile: it read DONE and alerted while a deploy, a CI watch
 * or a timer the turn started still ran.
 *
 * - agy (`brain/<session>/.system_generated/logs/transcript_full.jsonl`): a `GENERIC` step at
 *   `RUNNING` saying "Tool is running as a background task with task id: <id>" starts one (a
 *   command past its `WaitMsBeforeAsync`, or a `schedule` timer: "Task Description: Timer: 1h 30m").
 *   A `SYSTEM_MESSAGE` from `sender=<id>` (its result, or the timer's prompt) ends it, as does a
 *   status check answering "Task: <id>" with a `Status:` other than RUNNING. A `USER_INPUT` step is
 *   the person's prompt.
 * - grok (`updates.jsonl`): each `background_tasks` update lists every task with its status, so the
 *   newest one is the truth; a `user_message_chunk` that is no `<system-reminder>` notice is the
 *   person's prompt.
 *
 * What the turn started is what started since the prompt. A task started before the pane's process
 * is a gone process's (START_SLACK_MS as in claude-subagents.ts). A timer due within TIMER_LIMIT_MS
 * is held until it is due, past the hold's limit: it surely resumes the turn, and a command may be a
 * server. Only its process fires it, so while one is held its pane is looked up again each RESOLVE_MS,
 * and a pane whose session can no longer be looked up holds nothing: not on one lookup that failed,
 * which herdr being busy or a process read timing out gives too, but on the next, which the poll asks
 * RETRY_MS later whatever the pane holds. Each file is read on from where the last read stopped.
 */
const POLL_MS = 2000;
/** how long a pane's session is trusted before it is looked up again: the agent may have restarted there */
const RESOLVE_MS = 30_000;
/** how long after a lookup that failed the pane is asked again: every snapshot would ask, and two failures in one moment say no more than one */
const RETRY_MS = 10_000;
const START_SLACK_MS = 60_000;
/** a timer past due by this much fired in a process that is gone */
const DUE_GRACE_MS = 120_000;
/** a timer due further out than this is held as a command is, to the hold's limit */
const TIMER_LIMIT_MS = 24 * 3_600_000;
const READ_CHUNK = 1024 * 1024;
/** O_NONBLOCK: a FIFO put there is opened without waiting for a writer, and refused as no plain file */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

export type TaskAgent = "agy" | "grok";
export const isTaskAgent = (agent: string | null | undefined): agent is TaskAgent => agent === "agy" || agent === "grok";

interface Task { at: number; due: number | null }
export interface SessionTasks { tasks: Map<string, Task>; promptAt: number | null }
export interface TaskCount { running: number; turnRunning: number; promptAt: number | null; capped: boolean }

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;

const AGY_START = /background task with task id: ([\w-]+\/task-\d+)/;
const AGY_SENDER = /sender=([\w-]+\/task-\d+)/g;
const AGY_STATUS = /Task: ([\w-]+\/task-\d+)\s+Status: (\w+)/g;
const AGY_TIMER = /Task Description: Timer: ((?:\d+[hms]\s?)+)/;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };

function timerDue(content: string, at: number): number | null {
  const timer = content.match(AGY_TIMER)?.[1];
  if (timer === undefined) return null;
  const due = at + [...timer.matchAll(/(\d+)([hms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit!]!, 0);
  // a time that cannot be told, or is too far out, is held as a command is, to the hold's limit
  return Number.isFinite(due) && due - at <= TIMER_LIMIT_MS ? due : null;
}

/** One line of a session file, read into what it says runs. Lines that cannot matter are not parsed. */
export function readTaskLine(agent: TaskAgent, state: SessionTasks, line: string): void {
  if (agent === "agy" ? !/USER_INPUT|SYSTEM_MESSAGE|\/task-\d/.test(line) : !line.includes('"background_tasks"') && !line.includes('"user_message_chunk"')) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  if (entry === null) return;
  if (agent === "agy") {
    const at = Date.parse(String(entry["created_at"]));
    const content = typeof entry["content"] === "string" ? entry["content"] : "";
    if (!Number.isFinite(at)) return;
    if (entry["type"] === "USER_INPUT") state.promptAt = at;
    else if (entry["type"] === "SYSTEM_MESSAGE") for (const [, id] of content.matchAll(AGY_SENDER)) state.tasks.delete(id!);
    else if (entry["type"] === "GENERIC" && entry["status"] === "RUNNING") {
      const id = content.match(AGY_START)?.[1];
      if (id !== undefined) state.tasks.set(id, { at, due: timerDue(content, at) });
    } else if (entry["type"] === "GENERIC") for (const [, id, status] of content.matchAll(AGY_STATUS)) if (status !== "RUNNING") state.tasks.delete(id!);
    return;
  }
  const update = row(row(entry["params"])?.["update"]);
  if (update?.["sessionUpdate"] === "background_tasks" && Array.isArray(update["tasks"])) {
    state.tasks.clear();
    for (const value of update["tasks"]) {
      const task = row(value);
      const at = Date.parse(String(task?.["started_at"]));
      if (task?.["status"] === "running" && typeof task["task_id"] === "string" && Number.isFinite(at)) state.tasks.set(task["task_id"], { at, due: null });
    }
  } else if (update?.["sessionUpdate"] === "user_message_chunk") {
    const text = row(update["content"])?.["text"];
    if (typeof text === "string" && !text.trimStart().startsWith("<system-reminder>") && typeof entry["timestamp"] === "number") state.promptAt = entry["timestamp"] * 1000;
  }
}

/** What runs now of what the session's file said: `started`, when the pane's process started. */
export function taskCount(state: SessionTasks, started: number | null, now: number): TaskCount {
  const live = [...state.tasks.values()].filter((task) => (started === null || task.at >= started - START_SLACK_MS) && (task.due === null || now < task.due + DUE_GRACE_MS));
  const turn = live.filter((task) => state.promptAt === null || task.at >= state.promptAt);
  return { running: live.length, turnRunning: turn.length, promptAt: state.promptAt, capped: turn.length === 0 || turn.some((task) => task.due === null) };
}

interface Tracked extends SessionTasks {
  pane: HerdrPane & { agent: TaskAgent }; agent: TaskAgent; path: string; started: number | null; owner: string | null; resolvedAt: number;
  ino: number; offset: number; decoder: StringDecoder; partial: string; told: string | null; running: number;
}

function readOn(tracked: Tracked): void {
  let fd: number;
  try { fd = openSync(tracked.path, READ_FLAGS); } catch { return; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    const { ino, size } = stat;
    // replaced or cut short: read afresh
    if (ino !== tracked.ino || size < tracked.offset) Object.assign(tracked, { ino, offset: 0, decoder: new StringDecoder("utf8"), partial: "", promptAt: null, tasks: new Map() });
    const buffer = Buffer.alloc(Math.min(READ_CHUNK, Math.max(0, size - tracked.offset)));
    while (tracked.offset < size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - tracked.offset), tracked.offset);
      if (read <= 0) break;
      tracked.offset += read;
      const lines = (tracked.partial + tracked.decoder.write(buffer.subarray(0, read))).split("\n");
      tracked.partial = lines.pop()!;
      for (const line of lines) readTaskLine(tracked.agent, tracked, line);
    }
  } catch { /* read again at the next poll */ } finally { closeSync(fd); }
}

export interface AgentTaskDeps {
  /**
   * the pane's session file, when its process started (an upper bound, which differs a little
   * between reads of one process) and which process that is, or null when it cannot be told
   */
  resolve: (pane: HerdrPane & { agent: TaskAgent }) => Promise<{ path: string; started: number | null; owner: string | null } | null>;
  onChange: (paneId: string, count: TaskCount) => void;
  /** the pane runs another session or process than before: its waits are not this one's */
  onReset: (paneId: string) => void;
  now?: () => number;
}

/**
 * Whether herdr reports for `pane` the session `known` was looked up by. A grok session is found by
 * the id herdr reports, so another id is another session's file; an agy one is found by the pane's
 * process, whatever the pane says of a session.
 */
function sameSession(known: HerdrPane, pane: HerdrPane): boolean {
  return pane.agent !== "grok" || known.agent_session?.value === pane.agent_session?.value;
}

export class AgentTaskStatus {
  private readonly panes = new Map<string, Tracked>();
  private readonly resolving = new Set<string>();
  /** the panes a status asked for while a lookup of theirs was under way: should that one fail, the status gets its own */
  private readonly asked = new Map<string, HerdrPane>();
  /** bumped each time a pane is let go, so a lookup that was under way then is dropped */
  private readonly lifetimes = new Map<string, number>();
  /**
   * the panes whose last lookup failed, for which agent and when: kept until one finds the session or
   * the pane leaves. Not a status's lookup of a pane with no session: that one holds no snapshot off
   */
  private readonly failed = new Map<string, { agent: TaskAgent; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: AgentTaskDeps) { this.now = deps.now ?? Date.now; }

  start(): void {
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  /** Whether the pane's session is not known, or was looked up, found or not, long enough ago to look again. */
  stale(paneId: string): boolean {
    const tracked = this.panes.get(paneId);
    return tracked === undefined || (this.now() - tracked.resolvedAt >= RESOLVE_MS && !this.failedLately(paneId, tracked.agent));
  }

  forget(paneId: string): void {
    this.endLifetime(paneId);
    this.panes.delete(paneId);
    this.failed.delete(paneId);
    this.asked.delete(paneId);
  }

  /** A snapshot's panes: an agy or grok one is looked up, any other is let go. */
  async refresh(panes: readonly HerdrPane[]): Promise<void> {
    const ids = new Set(panes.filter((pane) => isTaskAgent(pane.agent)).map((pane) => pane.pane_id));
    for (const paneId of [...this.panes.keys()]) if (!ids.has(paneId)) this.letGo(paneId);
    for (const kept of [this.failed, this.asked]) for (const paneId of [...kept.keys()]) if (!ids.has(paneId)) kept.delete(paneId);
    await Promise.all(panes.map((pane) => this.track(pane, true)));
  }

  /**
   * Look the pane's session up, unless it was a moment ago. `spaced`, as a snapshot's lookup is: nor
   * a session that was not found less than RETRY_MS ago. A status of the pane does ask for that one
   * at once: a turn that ends on a task is held only once its session is known. So one that asks
   * while a lookup is under way is asked for again should that lookup fail: it began before the status.
   */
  async track(pane: HerdrPane, spaced = false): Promise<void> {
    const agent = pane.agent;
    if (!isTaskAgent(agent)) return;
    const known = this.panes.get(pane.pane_id);
    // a session that is known stands for RESOLVE_MS, and for RETRY_MS after a lookup that failed, whoever
    // asks; another agent there is looked up now, and so is another session herdr reports for it
    const recent = known === undefined ? spaced && this.failedLately(pane.pane_id, agent) : known.agent === agent && sameSession(known.pane, pane) && !this.stale(pane.pane_id);
    if (recent) return;
    if (this.resolving.has(pane.pane_id)) {
      if (!spaced) this.asked.set(pane.pane_id, pane);
      return;
    }
    this.resolving.add(pane.pane_id);
    const lifetime = this.lifetimes.get(pane.pane_id);
    let found: { path: string; started: number | null; owner: string | null } | null;
    try { found = await this.deps.resolve({ ...pane, agent }); } catch { found = null; } finally { this.resolving.delete(pane.pane_id); }
    const asked = this.asked.get(pane.pane_id);
    this.asked.delete(pane.pane_id);
    if (this.lifetimes.get(pane.pane_id) !== lifetime) return;
    const current = this.panes.get(pane.pane_id);
    if (found === null) {
      // the process is gone or its session cannot be read: what it ran, a timer too, holds nothing. One
      // failure does not tell that (herdr was busy, a process read timed out), so what the pane holds is
      // dropped on the second in a row, and at once when it is another agent's or another session's:
      // what the pane holds was never that one's
      const again = this.failed.get(pane.pane_id)?.agent === agent;
      if (current !== undefined && (again || current.agent !== agent || !sameSession(current.pane, pane))) this.letGo(pane.pane_id);
      // kept, the pane is asked for again by the poll, as herdr reports it now
      else if (current !== undefined) current.pane = { ...pane, agent };
      // a status's lookup of a pane with no session is not remembered: the snapshot after a turn's end
      // asks too, as its finish alert may be due before RETRY_MS is over
      if (spaced || current !== undefined) this.failed.set(pane.pane_id, { agent, at: this.now() });
      // the same gates stand for it: a pane kept through this failure is not asked for twice in one moment
      if (asked !== undefined) await this.track(asked);
      return;
    }
    this.failed.delete(pane.pane_id);
    if (current !== undefined && current.agent === agent && current.path === found.path && current.owner === found.owner) {
      current.resolvedAt = this.now();
      current.pane = { ...pane, agent };
      // a start that could not be read before may be now: the gone process's tasks are dropped then
      current.started ??= found.started;
      return;
    }
    if (current !== undefined) this.deps.onReset(pane.pane_id);
    this.panes.set(pane.pane_id, { pane: { ...pane, agent }, agent, ...found, resolvedAt: this.now(), ino: -1, offset: 0, decoder: new StringDecoder("utf8"), partial: "", tasks: new Map(), promptAt: null, told: null, running: 0 });
    this.poll(pane.pane_id);
  }

  /** Read on in each pane's file (or `only` the one), and tell a count that changed. */
  poll(only?: string): void {
    for (const [paneId, tracked] of this.panes) {
      if (only !== undefined && paneId !== only) continue;
      readOn(tracked);
      const count = taskCount(tracked, tracked.started, this.now());
      // a timer is held past the hold's limit only while its process lasts: no event tells that of a pane at rest.
      // Nor does any bring the lookup after one that failed, which keeps what the pane holds or lets it go
      if ((!count.capped || this.failed.has(paneId)) && this.now() - tracked.resolvedAt >= RESOLVE_MS) void this.track(tracked.pane).catch(() => undefined);
      const told = `${count.running}:${count.turnRunning}:${count.promptAt}:${count.capped}`;
      if (told === tracked.told) continue;
      tracked.told = told;
      tracked.running = count.running;
      this.deps.onChange(paneId, count);
    }
  }

  private endLifetime(paneId: string): void {
    // only a lookup under way needs to see the change; with none, the pane leaves no entry behind
    if (this.resolving.has(paneId)) this.lifetimes.set(paneId, (this.lifetimes.get(paneId) ?? 0) + 1);
    else this.lifetimes.delete(paneId);
  }

  /** Whether the pane's last lookup, for this agent, failed less than RETRY_MS ago. */
  private failedLately(paneId: string, agent: TaskAgent): boolean {
    const failure = this.failed.get(paneId);
    return failure !== undefined && failure.agent === agent && this.now() - failure.at < RETRY_MS;
  }

  private letGo(paneId: string): void {
    this.endLifetime(paneId);
    const tracked = this.panes.get(paneId);
    this.panes.delete(paneId);
    if (tracked !== undefined && tracked.told !== null) this.deps.onChange(paneId, { running: 0, turnRunning: 0, promptAt: null, capped: true });
  }
}
