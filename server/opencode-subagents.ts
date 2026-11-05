/**
 * An OpenCode pane's subagents and background commands, counted and listed as a Claude Code
 * pane's are (server/claude-subagents.ts), from the store the chat reads (server/opencode.ts).
 *
 * OpenCode 2 runs a subagent in a child session of the session that started it: a `session_v2`
 * row whose `parent_id` names that session, with `session_message` rows of its own (the
 * `subagent` tool, packages/core/src/tool/plugin/subagent.ts in 2.0.32; a plugin that starts
 * subagents makes the same child sessions). Whether one still runs is told by its own rows: when
 * a run of a session ends, OpenCode appends an `idle` row with its outcome (`succeeded`,
 * `failed`, `interrupted`; session/projector.ts), and a later prompt to the same child (the tool
 * called again with its sessionID) starts another run, with rows after that one. A store
 * OpenCode 1.x wrote and 2.0 migrated has no idle rows: there a step that finished for anything
 * but its tool calls, or with an error, ended the run.
 *
 * A background command is not a child session: the session's own `shell` row carries it
 * (`metadata.background`, its `shellID`, `command`, `status` and `exit`), the same rows the chat
 * reads, so the list and the chat agree on it. It never counts for the turn: the parent is woken
 * by its result, and does not wait on it.
 *
 * The runs belong to OpenCode's background service, not to the TUI in the pane: a service that
 * stopped without an idle row (a crash, a kill) took its runs with it, so a run last written
 * before the service now running started is lost, as a Claude Code subagent from before its
 * process is.
 *
 * The parent records only the call (and, for a background call, the `synthetic` row that wakes
 * it with the result, which the chat draws as the ended subagent's card: server/opencode.ts).
 */
import type { Database } from "bun:sqlite";

import type { HerdrPane } from "../shared/protocol.ts";
import type { OmoTask } from "../shared/tasks.ts";
import { opencodeSessionId, withStore } from "./opencode.ts";

/** As for Claude Code and OmO: the newest ten that ended in the last day are listed. */
const RECENT_MS = 24 * 60 * 60_000;
const RECENT_LIMIT = 10;
/**
 * How many children one step of a read visits. Telling whether a child's run ended takes a lookup of its newest row, so
 * a session with more children than this is read a page at a time, the event loop let go between pages (pagedState,
 * OpencodeSubagentStatus.poll): no step holds it longer than a page takes, however many children a session started.
 */
export const SUBAGENT_PAGE = 1000;
/** A run written this long before the service's start may still be the service's own (its start is read in whole ticks). */
const START_SLACK_MS = 5_000;
/** The rows a run is made of: what an end or a new run is read from (instructions, agent switches are not). */
const RUN_ROWS = "('user', 'synthetic', 'assistant', 'idle', 'shell', 'compaction')";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const parse = (data: unknown): Row => { try { return record(JSON.parse(String(data))); } catch { return {}; } };
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const stamp = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

export interface OpencodeSubagentState {
  /** running ones first (oldest first), then up to ten that ended in the last day (newest first) */
  tasks: OmoTask[];
  running: number;
  /** of those running, how many the turn going on (or last ended) started: server/background-wait.ts */
  turnRunning: number;
  /** when the person last gave the parent session a prompt: that turn began there */
  promptAt: number | null;
  /** of those running, how many are not listed (the newest RUNNING_LIMIT are) */
  unlisted: number;
}

const NOTHING: OpencodeSubagentState = { tasks: [], running: 0, turnRunning: 0, promptAt: null, unlisted: 0 };

/** A child's newest run row, as much of it as tells how the run went. */
interface ChildRun {
  id: string; created: number; type: string; at: number;
  outcome: unknown; created_at: unknown; completed: unknown; finish: unknown; error: string | null; error_type: unknown;
}

/** How a run ended, or null while it runs. */
function runEnd(run: ChildRun): { status: Exclude<OmoTask["status"], "running" | "lost">; at: number } | null {
  if (run.type === "idle") {
    const status = run.outcome === "failed" ? "failed" : run.outcome === "interrupted" ? "cancelled" : "completed";
    return { status, at: stamp(run.created_at) ?? run.at };
  }
  // 1.x wrote no idle row: an answered step ended the run, or one that failed or was stopped
  const completed = stamp(run.completed);
  if (run.type === "assistant" && completed !== null) {
    if (run.error !== null && run.error !== "null") return { status: run.error_type === "aborted" ? "cancelled" : "failed", at: completed };
    if (typeof run.finish === "string" && run.finish !== "tool-calls") return { status: "completed", at: completed };
  }
  return null;
}

/** What a child did, for the list: its steps, tool calls, the model it last ran at and the context its last step held. */
function childWork(db: Database, id: string): { turns: number; toolCalls: number; tokens: number | null; model: string | null } {
  const steps = db.query<{ steps: number }, [string]>("SELECT count(*) AS steps FROM session_message WHERE session_id = ? AND type = 'assistant'").get(id)?.steps ?? 0;
  const tools = db.query<{ tools: number }, [string]>(
    "SELECT count(*) AS tools FROM session_message AS m, json_each(m.data, '$.content') AS c WHERE m.session_id = ? AND m.type = 'assistant' AND json_valid(m.data) AND json_extract(c.value, '$.type') = 'tool'",
  ).get(id)?.tools ?? 0;
  const last = db.query<{ data: string }, [string]>("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1").get(id);
  const data = last === null ? {} : parse(last.data);
  const usage = record(data.tokens);
  const cache = record(usage.cache);
  // the figure OpenCode's own footer shows, as the chat's ring reads it (server/opencode.ts)
  const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write);
  return { turns: steps, toolCalls: tools, tokens: used > 0 ? used : null, model: label(record(data.model).id) };
}

/** A child's newest run row: a lookup of it in the session's own rows */
const NEWEST = `SELECT id FROM session_message WHERE session_id = s.id AND type IN ${RUN_ROWS} ORDER BY seq DESC LIMIT 1`;
/** Whether the newest row `m` ended its run: an idle row, or a step OpenCode 1.x answered, failed or stopped (as runEnd). */
const ENDED = `CASE WHEN m.type = 'idle' THEN 1 WHEN m.type != 'assistant' OR NOT json_valid(m.data) THEN 0
  ELSE json_type(m.data, '$.time.completed') IN ('integer', 'real') AND json_extract(m.data, '$.time.completed') > 0
    AND (coalesce(json_type(m.data, '$.error'), 'null') != 'null'
      OR (json_type(m.data, '$.finish') = 'text' AND json_extract(m.data, '$.finish') != 'tool-calls')) END`;

/** A child a read keeps: its newest run row in full, the time its last run was dispatched, and what the list shows of it. */
interface KeptRun extends ChildRun { dispatched: number | null; title: string | null; agent: string | null; model: string | null }

/**
 * A read of a session's subagents in steps, none of them longer than a page takes (a page of children, a page of the
 * rows kept, or a few children's work), so that the event loop can be let go between them (pagedState,
 * OpencodeSubagentStatus.poll) however many children a session started:
 * 1. the children, a page at a time in the order they were stored: those whose run has not ended (each counts) and,
 *    of those that ended, the ten that ended last within the last day (no more are listed);
 * 2. the newest run rows of those kept, read in full and told what they are a page of them a step: each counts, and of
 *    those that run only the newest thousand are listed (RUNNING_LIMIT), of the others the ten that ended last;
 * 3. with `detail`, what each listed one did, a few of them a step.
 */
interface Scan {
  sessionId: string; now: number; live: boolean; serviceStart: number | null; detail: boolean;
  /** session_v2's columns, once read; a store with no child sessions has nothing to read */
  columns: Set<string> | null; after: number; paged: boolean;
  /** the session's background commands, once read: `shell` rows with `background` metadata, as tasks */
  shells: OmoTask[] | null; shellRunning: number;
  open: string[]; ended: { id: string; at: number }[];
  /** phase 2: the ids to read again, and how far (a page is taken only once all of it is read: one that failed is read again whole) */
  ids: string[] | null; reread: number; promptAt: number | null;
  running: number; turnRunning: number; going: KeptRun[]; stopped: { run: KeptRun; at: number; end: ReturnType<typeof runEnd> }[];
  state: OpencodeSubagentState | null; shown: { run: KeptRun; at: number | null; end: ReturnType<typeof runEnd> }[];
  work: Map<string, ReturnType<typeof childWork>>; worked: number;
  finished: boolean;
}

/** How many children's work one step reads (each is three reads of its rows) */
const WORK_STEP = 50;
/** How many running children are listed, the newest: each counts, however many run */
export const RUNNING_LIMIT = 1000;

function newScan(sessionId: string, now: number, live: boolean, serviceStart: number | null, detail: boolean): Scan {
  return { sessionId, now, live, serviceStart, detail, columns: null, after: 0, paged: false, shells: null, shellRunning: 0, open: [], ended: [], ids: null, reread: 0, promptAt: null, running: 0, turnRunning: 0, going: [], stopped: [], state: null, shown: [], work: new Map(), worked: 0, finished: false };
}

/** What one of a session's `shell` rows says of a command it ran in the background. */
type ShellRow = {
  id: string; shell: string | null; command: string | null; status: string | null; exit: number | null;
  started: number | null; created: number; updated: number;
};

/**
 * A session's background commands, listed as its subagents are: those that run, and the newest that ended within
 * the last day. The chat reads the same rows (server/opencode.ts), so the list and the chat agree on them. A
 * command the session's OpenCode no longer runs is left lost, ended when it was last heard of; one written before
 * its service started is lost the same way, that service having taken its process along.
 */
function shellStep(db: Database, scan: Scan): void {
  const from = `
    FROM session_message AS m
    WHERE m.session_id = ? AND m.type = 'shell' AND json_valid(m.data)
      AND json_type(m.data, '$.metadata.background') = 'true'`;
  const running = `CASE WHEN json_extract(m.data, '$.status') = 'running' AND ?
    AND (? IS NULL OR m.time_updated >= ?) THEN 1 ELSE 0 END`;
  const bindings: [string, number, number | null, number] = [
    scan.sessionId, scan.live ? 1 : 0, scan.serviceStart, (scan.serviceStart ?? 0) - START_SLACK_MS,
  ];
  const select = `
    SELECT m.id,
      CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.shellID') END AS shell,
      CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.command') END AS command,
      CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.status') END AS status,
      CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.exit') END AS exit,
      CASE WHEN json_valid(m.data) AND json_type(m.data, '$.time.created') IN ('integer', 'real') AND json_extract(m.data, '$.time.created') > 0
        THEN json_extract(m.data, '$.time.created') END AS started,
      m.time_created AS created, m.time_updated AS updated ${from}`;
  // Count and list from the same snapshot, retaining only the newest commands that can be displayed.
  const { runningCount, rows } = db.transaction(() => {
    const runningCount = db.query<{ running: number }, typeof bindings>(`
      SELECT count(*) AS running ${from} AND (${running})`).get(...bindings)?.running ?? 0;
    const rows = [
      ...db.query<ShellRow, typeof bindings>(`${select}
        AND (${running}) ORDER BY coalesce(started, created) DESC LIMIT ${RUNNING_LIMIT}`).all(...bindings),
      ...db.query<ShellRow, [...typeof bindings, number]>(`${select}
        AND NOT (${running}) AND m.time_updated >= ?
        ORDER BY m.time_updated DESC LIMIT ${RECENT_LIMIT}`).all(...bindings, scan.now - RECENT_MS),
    ];
    return { runningCount, rows };
  })();
  scan.shells = [];
  scan.shellRunning = runningCount;
  for (const row of rows) {
    const id = label(row.shell) ?? row.id;
    const ended = row.status === "running" ? null
      : { status: row.exit === 0 ? "completed" as const : "failed" as const, at: row.updated };
    const orphan = scan.serviceStart !== null && row.updated < scan.serviceStart - START_SLACK_MS;
    if (ended === null && scan.live && !orphan) {
      scan.shells.push({
        id, title: label(row.command) ?? id, category: "shell", model: null, status: "running",
        started_at: iso(row.started ?? row.created), ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: null,
      });
      continue;
    }
    const at = ended?.at ?? row.updated;
    if (scan.now - at > RECENT_MS) continue;
    scan.shells.push({
      id, title: label(row.command) ?? id, category: "shell", model: null,
      status: ended !== null ? ended.status : "lost",
      started_at: iso(row.started ?? row.created), ended_at: iso(at), turns: null, tool_calls: null, tokens: null, detail_kind: null,
    });
  }
}

/** One step of a scan. */
function scanStep(db: Database, scan: Scan): void {
  if (scan.columns === null) {
    const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('session_v2')").all().map((column) => column.name));
    // 1.x tables, or a 2.0 store from before child sessions: no subagents to tell of, and no `session_message` rows either
    if (!columns.has("parent_id")) { scan.shells = []; scan.state = NOTHING; scan.finished = true; return; }
    scan.columns = columns;
  }
  if (scan.shells === null) shellStep(db, scan);
  if (!scan.paged) scanPage(db, scan, scan.columns);
  else if (scan.state === null) rereadPage(db, scan, scan.columns);
  else workStep(db, scan);
}

/** Phase 1: the next page of children (one more is asked for, to tell whether this page is the last). */
function scanPage(db: Database, scan: Scan, columns: Set<string>): void {
  // every child, one with no run row yet or archived too, so that a page holds as many children as it says
  const rows = db.query<{ rid: number; id: string; type: string | null; ended: number | null; ended_at: number | null; archived: number }, [string, number]>(`
    SELECT s.rowid AS rid, s.id, m.type, ${ENDED} AS ended,
      CASE WHEN m.type = 'idle' THEN coalesce(CASE WHEN json_valid(m.data) AND json_type(m.data, '$.time.created') IN ('integer', 'real')
        AND json_extract(m.data, '$.time.created') > 0 THEN json_extract(m.data, '$.time.created') END, m.time_created)
        WHEN m.type = 'assistant' AND json_valid(m.data) THEN json_extract(m.data, '$.time.completed') END AS ended_at,
      ${columns.has("time_archived") ? "s.time_archived IS NOT NULL" : "0"} AS archived
    FROM session_v2 AS s LEFT JOIN session_message AS m ON m.id = (${NEWEST})
    WHERE s.parent_id = ? AND s.rowid > ? ORDER BY s.rowid LIMIT ${SUBAGENT_PAGE + 1}`).all(scan.sessionId, scan.after);
  const page = rows.slice(0, SUBAGENT_PAGE);
  for (const row of page) {
    if (row.type === null || row.archived) continue;
    if (!row.ended) { scan.open.push(row.id); continue; }
    // ended as runEnd says it did, and listed by that same time
    const at = row.ended_at ?? 0;
    if (scan.now - at > RECENT_MS || (scan.ended.length === RECENT_LIMIT && at <= scan.ended.at(-1)!.at)) continue;
    scan.ended.push({ id: row.id, at });
    scan.ended.sort((a, b) => b.at - a.at);
    scan.ended.length = Math.min(scan.ended.length, RECENT_LIMIT);
  }
  scan.after = page.at(-1)?.rid ?? scan.after;
  scan.paged = rows.length <= SUBAGENT_PAGE;
}

/** Phase 2: the next page of the kept children's rows in full, each told what it is; once all are in, what was found. */
function rereadPage(db: Database, scan: Scan, columns: Set<string>): void {
  if (scan.ids === null) {
    const prompt = db.query<{ data: string; time_created: number }, [string]>(
      "SELECT data, time_created FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1",
    ).get(scan.sessionId);
    scan.promptAt = prompt === null ? null : stamp(record(parse(prompt.data).time).created) ?? prompt.time_created;
    scan.ids = [...scan.open, ...scan.ended.map((entry) => entry.id)];
  }
  const full = db.query<KeptRun, [string]>(`
    SELECT s.id, s.time_created AS created, m.type, m.time_created AS at,
      ${["outcome:$.outcome", "created_at:$.time.created", "completed:$.time.completed", "finish:$.finish", "error_type:$.error.type"]
    .map((field) => field.split(":")).map(([name, path]) => `CASE WHEN json_valid(m.data) THEN json_extract(m.data, '${path}') END AS ${name}`).join(", ")},
      CASE WHEN json_valid(m.data) THEN json_type(m.data, '$.error') END AS error,
      (SELECT time_created FROM session_message WHERE session_id = s.id AND type IN ('user', 'synthetic') ORDER BY seq DESC LIMIT 1) AS dispatched,
      ${["title", "agent", "model"].map((name) => columns.has(name) ? `s.${name}` : `NULL AS ${name}`).join(", ")}
    FROM session_v2 AS s JOIN session_message AS m ON m.id = (${NEWEST}) WHERE s.id = ?`);
  // the whole page is read before any of it is taken: a page that fails part way is read again whole
  const page = scan.ids.slice(scan.reread, scan.reread + SUBAGENT_PAGE).flatMap((id) => full.get(id) ?? []);
  const lastAt = (run: ChildRun): number => stamp(run.completed) ?? stamp(run.created_at) ?? run.at;
  const orphan = (run: ChildRun): boolean => scan.serviceStart !== null && lastAt(run) < scan.serviceStart - START_SLACK_MS;
  for (const run of page) {
    const end = runEnd(run);
    if (end === null && scan.live && !orphan(run)) {
      scan.running++;
      // one continued by its sessionID belongs to the turn that sent it its prompt
      if (scan.promptAt === null || (run.dispatched ?? run.created) >= scan.promptAt) scan.turnRunning++;
      scan.going.push(run);
      continue;
    }
    const at = end?.at ?? lastAt(run);
    if (scan.now - at <= RECENT_MS) scan.stopped.push({ run, at, end });
  }
  // only what is listed is kept: the newest that run, the ten that ended (or were lost) last
  scan.going = scan.going.sort((a, b) => b.created - a.created).slice(0, RUNNING_LIMIT);
  scan.stopped = scan.stopped.sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
  scan.reread += SUBAGENT_PAGE;
  if (scan.reread < scan.ids.length) return;
  scan.shown = [...[...scan.going].sort((a, b) => a.created - b.created).map((run) => ({ run, at: null as number | null, end: null })), ...scan.stopped];
  scan.state = { tasks: [], running: scan.running, turnRunning: scan.turnRunning, promptAt: scan.promptAt, unlisted: scan.running - scan.going.length };
  scan.finished = !scan.detail;
}

/** Phase 3: a few listed children's work. */
function workStep(db: Database, scan: Scan): void {
  for (const { run } of scan.shown.slice(scan.worked, scan.worked + WORK_STEP)) scan.work.set(run.id, childWork(db, run.id));
  scan.worked += WORK_STEP;
  scan.finished = scan.worked >= scan.shown.length;
}

/** What a finished scan found. */
function scanResult(scan: Scan): OpencodeSubagentState {
  const state = scan.state ?? NOTHING;
  const tasks = scan.shown.map(({ run, at, end }): OmoTask => {
    const work = scan.work.get(run.id) ?? null;
    return {
      id: run.id,
      title: label(run.title) ?? label(run.agent) ?? run.id,
      category: label(run.agent),
      model: work?.model ?? label(record(parse(run.model)).id),
      status: end !== null ? end.status : at === null ? "running" : "lost",
      started_at: iso(run.created),
      ended_at: iso(at),
      turns: work?.turns ?? null,
      tool_calls: work?.toolCalls ?? null,
      tokens: work?.tokens ?? null,
      // a child's work has no detail sheet (that reads a Claude Code subagent's transcript): this bridge knows the field
      detail_kind: null,
    };
  });
  if (scan.shells === null || (scan.shells.length === 0 && scan.shellRunning === 0)) return { ...state, tasks };
  // commands join the subagents' list: running first, oldest first; ended newest first, the ten that ended last
  const started = (task: OmoTask): number => task.started_at === null ? 0 : Date.parse(task.started_at) || 0;
  const ended = (task: OmoTask): number => task.ended_at === null ? 0 : Date.parse(task.ended_at) || 0;
  const running = [...tasks.filter((task) => task.status === "running"), ...scan.shells.filter((task) => task.status === "running")]
    .sort((a, b) => started(a) - started(b)).slice(-RUNNING_LIMIT);
  const settled = [...tasks.filter((task) => task.status !== "running"), ...scan.shells.filter((task) => task.status !== "running")]
    .sort((a, b) => ended(b) - ended(a)).slice(0, RECENT_LIMIT);
  return { ...state, running: state.running + scan.shellRunning, unlisted: state.running + scan.shellRunning - running.length, tasks: [...running, ...settled] };
}

/** The event loop let go between two steps of a read. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** A step that failed (the store busy for a moment) is tried again on the next turn, up to this many times in a row. */
const STEP_TRIES = 50;

/**
 * A session's subagents, read from an open store, every step at once (pagedState lets the event loop go between
 * them). `live`: the pane still runs OpenCode on this session; one that does not leaves what was running as lost,
 * ended when it was last heard of. `serviceStart`: when OpenCode's service started, when known (see above). `detail`:
 * read what each listed one did (its steps, tool calls, tokens), which a count does not need.
 */
export function readSubagents(db: Database, sessionId: string, live: boolean, now: number, serviceStart: number | null, detail: boolean): OpencodeSubagentState {
  const scan = newScan(sessionId, now, live, serviceStart, detail);
  while (!scan.finished) scanStep(db, scan);
  return scanResult(scan);
}

/** readSubagents on the store at `path`; null when it cannot be read now. */
export function opencodeSubagentState(path: string, sessionId: string, live: boolean, now = Date.now(), serviceStart: number | null = null, detail = true): OpencodeSubagentState | null {
  try { return withStore(path, (db) => readSubagents(db, sessionId, live, now, serviceStart, detail)); }
  catch { return null; }
}

/**
 * opencodeSubagentState a step at a time, the event loop let go between steps; null when it cannot be read now. Only
 * the first step waits on a store its writer holds; a later one that finds it so is tried again on the next turn.
 */
export async function pagedState(path: string, sessionId: string, live: boolean, now = Date.now(), serviceStart: number | null = null, detail = true, open: typeof withStore = withStore): Promise<OpencodeSubagentState | null> {
  const scan = newScan(sessionId, now, live, serviceStart, detail);
  try {
    if (open(path, (db) => { scanStep(db, scan); return true; }) === null) return null;
  } catch { return null; }
  for (let failed = 0; !scan.finished;) {
    await nextTurn();
    try {
      if (open(path, (db) => { scanStep(db, scan); return true; }, 0) === null) return null;
      failed = 0;
    } catch { if (++failed >= STEP_TRIES) return null; }
  }
  return scanResult(scan);
}

export interface OpencodeSubagentDeps {
  /** OpenCode's store: the one this server is configured with, else where OpenCode keeps it */
  store: () => string | null;
  /** when OpenCode's background service started, when it can be told now: read on every poll, so never waited for */
  serviceStart?: () => number | null;
  /**
   * The pane runs a session from now: another one, or one it came back to (`first` false: no earlier turn's wait is its
   * own), or its first after another agent (`first`: what the other agent's turns left is not its own; what OpenCode was
   * seen do there since, before its session was found, is).
   */
  onReset?: (paneId: string, first: boolean) => void;
  /** A pane's running subagents changed, or how many of them its turn started: no turn started or ended. */
  onChange: (paneId: string, running: number, turnRunning: number, promptAt: number | null) => void;
  pollMs?: number;
  now?: () => number;
}

interface Tracked { session: string; live: boolean; running: number; turnRunning: number; promptAt: number | null; reset: boolean }

/**
 * The running subagents of every OpenCode pane, for the pane's count. The session is the one
 * herdr's OpenCode integration reports (opencodeSessionId), never a guess. A pane that no longer
 * runs that session (at OpenCode's home screen, which reports none, or running another program)
 * keeps it, so that its list can say what was left running there is lost; its count is 0.
 */
export class OpencodeSubagentStatus {
  private readonly panes = new Map<string, Tracked>();
  /** each pane's agent as last seen: whether the first session it runs follows another agent's */
  private readonly agents = new Map<string, string | null>();
  /** reads of herdr's panes, numbered as they begin, and the newest taken for each pane: an older one never undoes it */
  private reads = 0;
  private readonly lastRead = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: OpencodeSubagentDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  /** The store and session the pane holds, or last held, and whether it still runs OpenCode on it. */
  sessionOf(paneId: string): { path: string; session: string; live: boolean } | null {
    const tracked = this.panes.get(paneId);
    const path = this.deps.store();
    return tracked && path !== null ? { path, session: tracked.session, live: tracked.live } : null;
  }

  /**
   * A pane's list, as the background tasks route answers it; null when the store cannot be read now. The read lets the
   * event loop go: a pane that comes to run another session (or stops running it) meanwhile is read again for that, so
   * that the answer is the pane's own as it stands when it is given. `read`: the session the list is of. Null when the
   * pane has none, the store cannot be read now, or the pane kept moving.
   */
  async tasksOf(paneId: string): Promise<(Pick<OpencodeSubagentState, "tasks" | "unlisted"> & { read: { path: string; session: string; live: boolean } }) | null> {
    for (let tries = 0; tries < 3; tries++) {
      const known = this.sessionOf(paneId);
      if (known === null) return null;
      const state = await pagedState(known.path, known.session, known.live, this.now(), this.deps.serviceStart?.() ?? null);
      const current = this.sessionOf(paneId);
      if (current?.path === known.path && current.session === known.session && current.live === known.live) return state === null ? null : { tasks: state.tasks, unlisted: state.unlisted, read: known };
    }
    return null;
  }

  /** Numbers a read of herdr's panes as it begins, before it is awaited: what refresh and ensure are given. */
  beginRead(): number {
    return ++this.reads;
  }

  /** The OpenCode panes of a snapshot (`read`: when its read began) and their sessions; a pane whose binding moved is read now. */
  refresh(panes: HerdrPane[], read = this.beginRead()): Promise<void> {
    const ids = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.lastRead.keys()]) {
      if (ids.has(paneId) || this.newer(paneId, read)) continue;
      this.panes.delete(paneId);
      this.agents.delete(paneId);
      this.lastRead.delete(paneId);
    }
    const moved = panes.filter((pane) => this.ensure(pane, read));
    return moved.length > 0 ? this.poll(new Set(moved.map((pane) => pane.pane_id))) : Promise.resolve();
  }

  /** Whether a read of the pane begun after `read` was taken already. */
  private newer(paneId: string, read: number): boolean {
    return (this.lastRead.get(paneId) ?? 0) > read;
  }

  /** One pane's session, as herdr reports it (`read`: when that read began); true when its binding changed. */
  ensure(pane: HerdrPane, read = this.beginRead()): boolean {
    if (this.newer(pane.pane_id, read)) return false;
    this.lastRead.set(pane.pane_id, read);
    const tracked = this.panes.get(pane.pane_id);
    const before = this.agents.get(pane.pane_id);
    this.agents.set(pane.pane_id, pane.agent ?? null);
    const session = pane.agent === "opencode" ? opencodeSessionId(pane) : null;
    if (session === null) {
      if (!tracked?.live) return false;
      tracked.live = false;
      return true;
    }
    // the pane runs this session from here: a wait the agent before it held is not this one's
    if (tracked?.session === session) {
      if (tracked.live) return false;
      tracked.live = true;
      this.deps.onReset?.(pane.pane_id, false);
      return true;
    }
    // another session than the one it ran, or the first after another agent's: a new lifetime. The first
    // session of a pane seen new, at a shell or at OpenCode's home screen is found after its turn began,
    // maybe after it ended: what that turn was seen do is this session's
    if (tracked !== undefined) this.deps.onReset?.(pane.pane_id, false);
    else if (before != null && before !== "opencode") this.deps.onReset?.(pane.pane_id, true);
    this.panes.set(pane.pane_id, { session, live: true, running: tracked?.running ?? 0, turnRunning: tracked?.turnRunning ?? 0, promptAt: tracked?.promptAt ?? null, reset: tracked !== undefined });
    return true;
  }

  /**
   * Reads the store for every pane, or for some (a turn just ended there); a pane whose counts changed is told. Each
   * pane's read takes its first two steps now (a page of children, then the rows of those kept): a session of up to a
   * page is read whole at once, so the frame that ends a turn has its subagents. A larger one is read on a step a turn
   * of the event loop, and its pane told once the read is whole (the promise settles then). A pane that no longer runs
   * a session is told it runs none at once; one whose session is being read so is left to that read.
   */
  poll(only?: string | ReadonlySet<string>): Promise<void> {
    const path = this.deps.store();
    const wanted = (paneId: string): boolean => only === undefined || (typeof only === "string" ? only === paneId : only.has(paneId));
    const states = new Map<string, OpencodeSubagentState>();
    const scans = new Map<string, Scan>();
    const live = [...this.panes].filter(([paneId, tracked]) => wanted(paneId) && tracked.live && this.reading.get(paneId)?.session !== tracked.session);
    const serviceStart = path !== null && live.length > 0 ? this.deps.serviceStart?.() ?? null : null;
    if (path !== null && live.length > 0) {
      // one read for all: a store held by its writer is waited on once, not once per pane, and on the event loop not at all
      try {
        withStore(path, (db) => {
          for (const [paneId, tracked] of live) {
            const scan = newScan(tracked.session, this.now(), true, serviceStart, false);
            for (let step = 0; step < 2 && !scan.finished; step++) scanStep(db, scan);
            if (scan.finished) states.set(paneId, scanResult(scan));
            else scans.set(paneId, scan);
          }
        }, 0);
      } catch { /* a store busy for a moment says nothing: the counts stand */ }
    }
    for (const [paneId, tracked] of this.panes) {
      if (!wanted(paneId)) continue;
      const state = tracked.live ? states.get(paneId) : NOTHING;
      if (state !== undefined) this.tell(paneId, tracked, state);
    }
    return path === null || scans.size === 0 ? Promise.resolve() : this.readOn(path, scans);
  }

  /** each pane whose session is being read a step a turn (poll), with the read's own token */
  private readonly reading = new Map<string, { session: string }>();

  /** The rest of the reads a poll began, a step a turn; each pane is told once its read is whole, if it still runs that session. */
  private async readOn(path: string, scans: Map<string, Scan>): Promise<void> {
    const tokens = new Map([...scans].map(([paneId, scan]) => [paneId, { session: scan.sessionId }]));
    for (const [paneId, token] of tokens) this.reading.set(paneId, token);
    try {
      for (let failed = 0; [...scans.values()].some((scan) => !scan.finished);) {
        await nextTurn();
        try {
          const read = withStore(path, (db) => {
            for (const scan of scans.values()) if (!scan.finished) scanStep(db, scan);
            return true;
          }, 0);
          if (read === null) return;
          failed = 0;
        } catch { if (++failed >= STEP_TRIES) return; }
      }
      for (const [paneId, scan] of scans) {
        // a pane that moved on since its read began: what was read is not its own now
        const tracked = this.panes.get(paneId);
        if (tracked?.live && tracked.session === scan.sessionId) this.tell(paneId, tracked, scanResult(scan));
      }
    } finally {
      for (const [paneId, token] of tokens) if (this.reading.get(paneId) === token) this.reading.delete(paneId);
    }
  }

  /** A pane's counts as read: told when they changed, or when its binding was reset since. */
  private tell(paneId: string, tracked: Tracked, state: OpencodeSubagentState): void {
    const { running, turnRunning, promptAt } = state;
    if (!tracked.reset && running === tracked.running && turnRunning === tracked.turnRunning && promptAt === tracked.promptAt) return;
    tracked.reset = false;
    tracked.running = running;
    tracked.turnRunning = turnRunning;
    tracked.promptAt = promptAt;
    this.deps.onChange(paneId, running, turnRunning, promptAt);
  }
}
