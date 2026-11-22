/**
 * OpenCode 2 runs a subagent in a child session of the session that started it: a `session_v2`
 * row whose `parent_id` names that session, with `session_message` rows of its own (the
 * `subagent` tool, packages/core/src/tool/plugin/subagent.ts in 2.0.32; a plugin that starts
 * subagents makes the same child sessions). With Settings -> Read OpenCode subagent ends from their
 * session (experimental, off by default; `parentEnds`), whether one still runs is told first by the parent's
 * own record, as a Claude Code subagent's end is taken from its parent's transcript: the newest
 * `subagent` call naming the child (`state.metadata.sessionID`) runs it until it is answered
 * (`completed`, or `error`), and a background call, answered at once with `metadata.status:
 * "running"`, runs it until the parent's `synthetic` notice (`metadata.childID`, `metadata.state`).
 * A child can go idle while background work of its own still runs, its parent's call answered only
 * once that ends (anomalyco/opencode#57418), so its idle row alone does not end it.
 * The child's own rows tell for a child no call names (a plugin's, a migrated 1.x store, a call
 * that failed before it reached the child) and for one woken after its parent was told it ended: when a
 * run of a session ends, OpenCode appends an `idle` row with its outcome (`succeeded`, `failed`,
 * `interrupted`; session/projector.ts), and a later prompt starts another run. A store OpenCode
 * 1.x wrote and 2.0 migrated has no idle rows: there a step that finished for anything but its
 * tool calls, or with an error, ended the run.
 *
 * A background command is not a child session: the session's own `shell` row carries it
 * (`metadata.background`, its `shellID`, `command`, `status` and `exit`), the same rows the chat
 * reads, so the list and the chat agree on it. It never counts for the turn: the parent is woken
 * by its result, and does not wait on it.
 *
 * The runs belong to OpenCode's background service, not to the TUI in the pane: a service that
 * stopped without an idle row (a crash, a kill) took its runs with it.
 */
import type { Database } from "bun:sqlite";

import type { HerdrPane, PaneBackgroundAgentDetail } from "../shared/protocol.ts";
import type { OmoTask } from "../shared/tasks.ts";
import { DETAIL_LIMITS, fitDetail, type DetailRefusal } from "./claude-subagents.ts";
import { opencodeSessionId, sessionView, supportedRowSize, withStore } from "./opencode.ts";

const RECENT_MS = 24 * 60 * 60_000;
const RECENT_LIMIT = 10;
export const SUBAGENT_PAGE = 1000;
const START_SLACK_MS = 5_000;
const RUN_ROWS = "('user', 'synthetic', 'assistant', 'idle', 'shell', 'compaction')";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const parse = (data: unknown): Row => { try { return record(JSON.parse(String(data))); } catch { return {}; } };
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const stamp = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

export interface OpencodeSubagentState {
  tasks: OmoTask[];
  running: number;
  turnRunning: number;
  promptAt: number | null;
  unlisted: number;
}

const NOTHING: OpencodeSubagentState = { tasks: [], running: 0, turnRunning: 0, promptAt: null, unlisted: 0 };

interface ChildRun {
  id: string; created: number; type: string; at: number;
  outcome: unknown; created_at: unknown; completed: unknown; finish: unknown; error: string | null; error_type: unknown;
}

type End = { status: Exclude<OmoTask["status"], "running" | "lost">; at: number };

function runEnd(run: ChildRun): End | null {
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

interface Told {
  id: string; seq: number; end: End | null; waiting: boolean; updated: number; named: number | null; notice: boolean;
  setAside?: boolean;
}

/**
 * When OpenCode named a row, read from its id (Identifier.ascending in @opencode/schema: "msg_", then the low 48 bits of
 * the ms times 4096 plus a counter, in 12 hex digits, then 14 random characters); null for an id of another form. A
 * `subagent` call's row is named as its step began, before the call ran. A background notice's row is the job's
 * notificationID, named when the job went to the background (Job.markBackground, SubagentCompletion.deliver in
 * OpenCode 2.2.2 and 2.2.5), so before any later call to that child, however late the notice is written.
 */
function named(id: string): number | null {
  return /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id) ? Number.parseInt(id.slice(4, 16), 16) : null;
}
const NAMED_SPAN = 2 ** 48;

/** Whether row `a` was named after row `b`: the 48 bits wrap about every 2.2 years, so the nearer way round is taken. */
const namedAfter = (a: number, b: number): boolean => a !== b && (a - b + NAMED_SPAN) % NAMED_SPAN < NAMED_SPAN / 2;

/**
 * A waited call started a job of its own (a call to a child whose job is in the
 * background joins that job and is answered at once, subagent.ts), which ends with the call's answer: a notice named
 * before the call's step began answers an older job, however late it was written. Other calls keep the order the rows
 * were written in: one answered as gone to the background may have joined the job an older-named notice ends.
 */
function newer(said: Told, was: Told | undefined): boolean {
  if (was === undefined) return true;
  if (said.named !== null && was.named !== null) {
    if (said.notice && was.waiting && namedAfter(was.named, said.named)) return false;
    if (was.notice && said.waiting && namedAfter(said.named, was.named)) return true;
  }
  return said.seq >= was.seq;
}

export interface ParentLog { after: number; rows: number; since: number; told: ReadonlyMap<string, Told> }
const NO_LOG: ParentLog = { after: -1, rows: 0, since: 0, told: new Map() };

/**
 * A call names its child once it reached it (`state.metadata.sessionID`, set just before the child is prompted),
 * not by the sessionID its input asks for: one refused before that (a permission denied, an unknown agent) ran nothing.
 */
const PARENT_ROW = `SELECT m.id, m.seq, m.type, m.time_created AS created, m.time_updated AS updated,
  CASE WHEN m.type = 'assistant' AND json_valid(m.data) THEN (SELECT json_group_array(json_object(
      'status', json_extract(c.value, '$.state.status'),
      'child', json_extract(c.value, '$.state.metadata.sessionID'),
      'answer', json_extract(c.value, '$.state.metadata.status'), 'error', json_extract(c.value, '$.state.error.type'),
      'message', substr(json_extract(c.value, '$.state.error.message'), 1, 40),
      'at', json_extract(c.value, '$.time.completed')))
    FROM json_each(m.data, '$.content') AS c
    WHERE json_extract(c.value, '$.type') = 'tool' AND json_extract(c.value, '$.name') = 'subagent') END AS calls,
  CASE WHEN m.type = 'synthetic' AND json_valid(m.data) AND json_extract(m.data, '$.metadata.source') = 'subagent'
    THEN json_extract(m.data, '$.metadata.childID') END AS notified,
  CASE WHEN m.type = 'synthetic' AND json_valid(m.data) THEN json_extract(m.data, '$.metadata.state') END AS state,
  CASE WHEN m.type = 'synthetic' AND json_valid(m.data) THEN json_extract(m.data, '$.time.created') END AS at
FROM session_message AS m`;
const NAMES_SUBAGENT = `((m.type = 'assistant' AND instr(m.data, '"name":"subagent"') > 0) OR (m.type = 'synthetic' AND instr(m.data, '"source":"subagent"') > 0))`;
type ParentRow = { id: string; seq: number; type: string; created: number; updated: number; calls: string | null; notified: unknown; state: unknown; at: unknown };

function parentRow(row: ParentRow): (Told & { child: string })[] {
  const told: (Told & { child: string })[] = [];
  const said = (child: string, end: End | null, waiting = false, notice = false) => told.push({ child, id: row.id, seq: row.seq, end, waiting, updated: row.updated, named: named(row.id), notice });
  const child = label(row.notified);
  if (row.type === "synthetic" && child !== null) {
    said(child, { status: row.state === "error" ? "failed" : row.state === "cancelled" ? "cancelled" : "completed", at: stamp(row.at) ?? row.created }, false, true);
  }
  let calls: unknown = [];
  try { calls = JSON.parse(row.calls ?? "[]"); } catch {}
  for (const call of (Array.isArray(calls) ? calls : []).map(record)) {
    const child = label(call.child);
    if (child === null) continue;
    const at = stamp(call.at) ?? row.updated;
    if (call.status === "running") said(child, null, true);
    // stopped with the parent (`aborted`), or the child's job cancelled: the tool's own words for it (subagent.ts)
    else if (call.status === "error") said(child, { status: call.error === "aborted" || String(call.message).startsWith("Subagent cancelled") ? "cancelled" : "failed", at });
    // a background call is answered at once, still running: its notice ends it
    else if (call.status === "completed") said(child, call.answer === "running" ? null : { status: "completed", at });
  }
  return told;
}

function parentStep(db: Database, scan: Scan): void {
  const sid = scan.sessionId;
  if (scan.since === null) {
    let log = scan.log;
    // a staged /undo hides the rows from its message on
    if (scan.columns?.has("revert")) {
      const boundary = record(parse(db.query<{ revert: string | null }, [string]>("SELECT revert FROM session_v2 WHERE id = ?").get(sid)?.revert ?? "null")).messageID;
      if (typeof boundary === "string") scan.end = db.query<{ seq: number }, [string, string]>("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(sid, boundary)?.seq ?? scan.end;
    }
    if (log.after >= scan.end) log = NO_LOG;
    const head = db.query<{ newest: number | null; since: number | null; idle: number | null; changed: string | null }, [string, number, number, number]>(`
      SELECT max(CASE WHEN seq < ?4 THEN seq END) AS newest, max(time_updated) AS since, max(CASE WHEN type = 'idle' AND seq < ?4 THEN seq END) AS idle,
        json_group_array(CASE WHEN seq <= ?2 AND time_updated >= ?3 THEN id END) AS changed
      FROM session_message WHERE session_id = ?1`).get(sid, log.after, log.since, scan.end);
    scan.since = head?.since ?? 0;
    scan.idle = head?.idle ?? -1;
    const changed = JSON.stringify((JSON.parse(head?.changed ?? "[]") as unknown[]).filter((id) => typeof id === "string"));
    if (log.after >= 0 && scan.since < log.since) log = NO_LOG;
    if (log.after >= 0) {
      const rows = db.query<{ rows: number }, [string, number]>("SELECT count(*) AS rows FROM session_message WHERE session_id = ? AND seq <= ?").get(sid, log.after)?.rows ?? 0;
      const ids = JSON.stringify([...new Set([...log.told.values()].map((said) => said.id))]);
      const kept = db.query<{ kept: number }, [string, string]>("SELECT count(*) AS kept FROM session_message WHERE +session_id = ? AND id IN (SELECT value FROM json_each(?))").get(sid, ids)?.kept ?? 0;
      const told = new Map(log.told);
      let whole = rows === log.rows && kept === new Set([...log.told.values()].map((said) => said.id)).size;
      if (whole) {
        const stamps = JSON.stringify([...new Map([...log.told.values()].map((said) => [said.id, said.updated]))]);
        // CROSS JOIN keeps json_each outside, so each is a lookup by primary key, not a pass over the session's rows
        const rewritten = db.query<{ id: string }, [string, string]>(`SELECT m.id FROM json_each(?2) AS k
          CROSS JOIN session_message AS m ON m.id = json_extract(k.value, '$[0]') WHERE +m.session_id = ?1 AND m.time_updated IS NOT json_extract(k.value, '$[1]')`,
        ).all(sid, stamps).map((row) => row.id);
        const reread = JSON.stringify([...new Set([...(JSON.parse(changed) as string[]), ...rewritten])]);
        for (const row of db.query<ParentRow, [string, string, string]>(`${PARENT_ROW}
          WHERE +m.session_id = ? AND m.id IN (SELECT value FROM json_each(?)) AND (${NAMES_SUBAGENT} OR m.id IN (SELECT value FROM json_each(?)))`,
        ).all(sid, reread, ids)) {
          const now = parentRow(row);
          if ([...told].some(([child, said]) => said.id === row.id && !now.some((entry) => entry.child === child))) { whole = false; break; }
          if (now.some((said) => !said.waiting && told.get(said.child)?.id === said.id && told.get(said.child)?.setAside)) { whole = false; break; }
          for (const { child, ...said } of now) if (told.get(child)?.id === said.id || newer(said, told.get(child))) told.set(child, { ...said, setAside: told.get(child)?.id === said.id && told.get(child)?.setAside });
        }
      }
      log = whole ? { ...log, told } : NO_LOG;
    }
    scan.log = { ...log, told: new Map(log.told) };
    scan.newest = head?.newest ?? 0;
  }
  const log = scan.log;
  const told = log.told as Map<string, Told>;
  const upto = db.query<{ seq: number | null }, [string, number, number]>(
    `SELECT max(seq) AS seq FROM (SELECT seq FROM session_message WHERE session_id = ? AND seq > ? AND seq < ? ORDER BY seq LIMIT ${SUBAGENT_PAGE})`,
  ).get(sid, log.after, scan.end)?.seq ?? null;
  if (upto !== null && log.after < scan.newest) {
    for (const row of db.query<ParentRow, [string, number, number]>(`${PARENT_ROW} WHERE m.session_id = ? AND m.seq > ? AND m.seq <= ? AND ${NAMES_SUBAGENT}`).all(sid, log.after, upto)) {
      for (const { child, ...said } of parentRow(row)) {
        const was = told.get(child);
        if (newer(said, was)) told.set(child, said);
        else if (said.notice && was !== undefined && was.waiting && said.seq > was.seq) told.set(child, { ...was, setAside: true });
      }
    }
    scan.log = { ...log, after: Math.min(upto, scan.newest) };
    if (scan.log.after < scan.newest) return;
  }
  const rows = db.query<{ rows: number }, [string, number]>("SELECT count(*) AS rows FROM session_message WHERE session_id = ? AND seq <= ?").get(sid, scan.log.after)?.rows ?? 0;
  scan.log = { ...scan.log, rows, since: scan.since };
  const orphan = (said: Told) => said.end === null && scan.serviceStart !== null && said.updated < scan.serviceStart - START_SLACK_MS;
  scan.told = new Map([...told].filter(([, said]) => !(said.waiting && said.seq < scan.idle) && !orphan(said)));
}

function childEnd(own: End | null, told: Told | undefined, dispatched: number | null): End | null {
  if (told === undefined) return own;
  if (told.end !== null && dispatched !== null && dispatched >= told.end.at) return own;
  return told.end;
}

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

const NEWEST = `SELECT id FROM session_message WHERE session_id = s.id AND type IN ${RUN_ROWS} ORDER BY seq DESC LIMIT 1`;
const ENDED = `CASE WHEN m.type = 'idle' THEN 1 WHEN m.type != 'assistant' OR NOT json_valid(m.data) THEN 0
  ELSE json_type(m.data, '$.time.completed') IN ('integer', 'real') AND json_extract(m.data, '$.time.completed') > 0
    AND (coalesce(json_type(m.data, '$.error'), 'null') != 'null'
      OR (json_type(m.data, '$.finish') = 'text' AND json_extract(m.data, '$.finish') != 'tool-calls')) END`;

interface KeptRun extends ChildRun { dispatched: number | null; title: string | null; agent: string | null; model: string | null }

interface Scan {
  sessionId: string; now: number; live: boolean; serviceStart: number | null; detail: boolean;
  columns: Set<string> | null; after: number; paged: boolean;
  shells: OmoTask[] | null; shellRunning: number;
  told: Map<string, Told> | null; log: ParentLog; since: number | null; newest: number; idle: number;
  end: number;
  parentEnds: boolean;
  open: string[]; ended: { id: string; at: number }[];
  ids: string[] | null; reread: number; promptAt: number | null;
  running: number; turnRunning: number; going: KeptRun[]; stopped: { run: KeptRun; at: number; end: End | null }[];
  state: OpencodeSubagentState | null; shown: { run: KeptRun; at: number | null; end: End | null }[];
  work: Map<string, ReturnType<typeof childWork>>; worked: number;
  finished: boolean;
}

const WORK_STEP = 50;
export const RUNNING_LIMIT = 1000;

function newScan(sessionId: string, now: number, live: boolean, serviceStart: number | null, detail: boolean, log: ParentLog = NO_LOG, parentEnds = false): Scan {
  return { sessionId, now, live, serviceStart, detail, columns: null, after: 0, paged: false, shells: null, shellRunning: 0, told: parentEnds ? null : new Map(), log, since: null, newest: 0, idle: -1, end: Number.MAX_SAFE_INTEGER, parentEnds, open: [], ended: [], ids: null, reread: 0, promptAt: null, running: 0, turnRunning: 0, going: [], stopped: [], state: null, shown: [], work: new Map(), worked: 0, finished: false };
}

type ShellRow = {
  id: string; shell: string | null; command: string | null; status: string | null; exit: number | null;
  started: number | null; created: number; updated: number;
};

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

function scanStep(db: Database, scan: Scan): void {
  if (scan.columns === null) {
    const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('session_v2')").all().map((column) => column.name));
    // 1.x tables, or a 2.0 store from before child sessions: no subagents to tell of, and no `session_message` rows either
    if (!columns.has("parent_id")) { scan.shells = []; scan.state = NOTHING; scan.finished = true; return; }
    scan.columns = columns;
  }
  if (scan.shells === null) shellStep(db, scan);
  if (scan.told === null) {
    parentStep(db, scan);
    if (scan.told === null) return;
  }
  if (!scan.paged) scanPage(db, scan, scan.columns);
  else if (scan.state === null) rereadPage(db, scan, scan.columns);
  else workStep(db, scan);
}

function scanPage(db: Database, scan: Scan, columns: Set<string>): void {
  const rows = db.query<{ rid: number; id: string; type: string | null; ended: number | null; ended_at: number | null; archived: number }, [string, number]>(`
    SELECT s.rowid AS rid, s.id, m.type, ${ENDED} AS ended,
      CASE WHEN m.type = 'idle' THEN coalesce(CASE WHEN json_valid(m.data) AND json_type(m.data, '$.time.created') IN ('integer', 'real')
        AND json_extract(m.data, '$.time.created') > 0 THEN json_extract(m.data, '$.time.created') END, m.time_created)
        WHEN m.type = 'assistant' AND json_valid(m.data) THEN json_extract(m.data, '$.time.completed') END AS ended_at,
      ${columns.has("time_archived") ? "s.time_archived IS NOT NULL" : "0"} AS archived
    FROM session_v2 AS s LEFT JOIN session_message AS m ON m.id = (${NEWEST})
    WHERE s.parent_id = ? AND s.rowid > ? ORDER BY s.rowid LIMIT ${SUBAGENT_PAGE + 1}`).all(scan.sessionId, scan.after);
  const page = rows.slice(0, SUBAGENT_PAGE);
  const dispatched = db.query<{ at: number }, [string]>("SELECT time_created AS at FROM session_message WHERE session_id = ? AND type IN ('user', 'synthetic') ORDER BY seq DESC LIMIT 1");
  for (const row of page) {
    if (row.type === null || row.archived) continue;
    const told = scan.told?.get(row.id);
    const own = row.ended ? { status: "completed" as const, at: row.ended_at ?? 0 } : null;
    const end = childEnd(own, told, told?.end ? dispatched.get(row.id)?.at ?? null : null);
    if (end === null) { scan.open.push(row.id); continue; }
    const at = end.at;
    if (scan.now - at > RECENT_MS || (scan.ended.length === RECENT_LIMIT && at <= scan.ended.at(-1)!.at)) continue;
    scan.ended.push({ id: row.id, at });
    scan.ended.sort((a, b) => b.at - a.at);
    scan.ended.length = Math.min(scan.ended.length, RECENT_LIMIT);
  }
  scan.after = page.at(-1)?.rid ?? scan.after;
  scan.paged = rows.length <= SUBAGENT_PAGE;
}

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
  const page = scan.ids.slice(scan.reread, scan.reread + SUBAGENT_PAGE).flatMap((id) => full.get(id) ?? []);
  const lastAt = (run: ChildRun): number => stamp(run.completed) ?? stamp(run.created_at) ?? run.at;
  const orphan = (run: ChildRun): boolean => scan.serviceStart !== null && lastAt(run) < scan.serviceStart - START_SLACK_MS;
  for (const run of page) {
    const end = childEnd(runEnd(run), scan.told?.get(run.id), run.dispatched);
    if (end === null && scan.live && !orphan(run)) {
      scan.running++;
      if (scan.promptAt === null || (run.dispatched ?? run.created) >= scan.promptAt) scan.turnRunning++;
      scan.going.push(run);
      continue;
    }
    const at = end?.at ?? lastAt(run);
    if (scan.now - at <= RECENT_MS) scan.stopped.push({ run, at, end });
  }
  scan.going = scan.going.sort((a, b) => b.created - a.created).slice(0, RUNNING_LIMIT);
  scan.stopped = scan.stopped.sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
  scan.reread += SUBAGENT_PAGE;
  if (scan.reread < scan.ids.length) return;
  scan.shown = [...[...scan.going].sort((a, b) => a.created - b.created).map((run) => ({ run, at: null as number | null, end: null })), ...scan.stopped];
  scan.state = { tasks: [], running: scan.running, turnRunning: scan.turnRunning, promptAt: scan.promptAt, unlisted: scan.running - scan.going.length };
  scan.finished = !scan.detail;
}

function workStep(db: Database, scan: Scan): void {
  for (const { run } of scan.shown.slice(scan.worked, scan.worked + WORK_STEP)) scan.work.set(run.id, childWork(db, run.id));
  scan.worked += WORK_STEP;
  scan.finished = scan.worked >= scan.shown.length;
}

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
      detail_kind: "opencode-subagent",
    };
  });
  if (scan.shells === null || (scan.shells.length === 0 && scan.shellRunning === 0)) return { ...state, tasks };
  const started = (task: OmoTask): number => task.started_at === null ? 0 : Date.parse(task.started_at) || 0;
  const ended = (task: OmoTask): number => task.ended_at === null ? 0 : Date.parse(task.ended_at) || 0;
  const running = [...tasks.filter((task) => task.status === "running"), ...scan.shells.filter((task) => task.status === "running")]
    .sort((a, b) => started(a) - started(b)).slice(-RUNNING_LIMIT);
  const settled = [...tasks.filter((task) => task.status !== "running"), ...scan.shells.filter((task) => task.status !== "running")]
    .sort((a, b) => ended(b) - ended(a)).slice(0, RECENT_LIMIT);
  return { ...state, running: state.running + scan.shellRunning, unlisted: state.running + scan.shellRunning - running.length, tasks: [...running, ...settled] };
}

const DETAIL_RECORD_BYTES = 64 * 1024;
const DETAIL_ROW_BYTES = 4 * 1024 * 1024;

/**
 * GET /api/pane/background-agent for an OpenCode pane: what the child session `childId` of the session `sessionId` did,
 * read-only and bounded as a Claude Code subagent's detail is (claude-subagents.ts backgroundAgentDetail), from one
 * snapshot of the store. Its work is the text and tool parts of
 * the `assistant` rows since that prompt, the newest as many as max_events and max_read_bytes allow (no reasoning, no
 * tool output), taken out in the store so that only they come out of it; a staged `/undo` hides the rows from its
 * message on, as the chat does (server/opencode.ts sessionView). Only a child of `sessionId` is answered: another
 * session's is not found.
 */
export function opencodeAgentDetail(path: string, sessionId: string, childId: string): { detail: Omit<PaneBackgroundAgentDetail, "server_time"> } | { refusal: DetailRefusal | "command" } {
  try {
    return withStore(path, (db) => db.transaction(() => childDetail(db, sessionId, childId))()) ?? { refusal: "unavailable" };
  } catch { return { refusal: "unavailable" }; }
}

function childDetail(db: Database, sessionId: string, childId: string): ReturnType<typeof opencodeAgentDetail> {
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('session_v2')").all().map((column) => column.name));
  // 1.x tables, or a 2.0 store from before child sessions: no subagent to read
  if (!columns.has("parent_id")) return { refusal: "not_found" };
  const child = db.query<{ title: unknown; agent: unknown }, [string, string]>(
    `SELECT ${["title", "agent"].map((name) => columns.has(name) ? `substr(${name}, 1, 300) AS ${name}` : `NULL AS ${name}`).join(", ")} FROM session_v2 WHERE id = ? AND parent_id = ?`,
  ).get(childId, sessionId);
  if (child === null) {
    const command = db.query<{ found: number }, [string, string, string]>(`
      SELECT 1 AS found FROM session_message WHERE session_id = ? AND type = 'shell' AND json_valid(data)
        AND json_type(data, '$.metadata.background') = 'true' AND (json_extract(data, '$.shellID') = ? OR id = ?) LIMIT 1`).get(sessionId, childId, childId);
    return { refusal: command === null ? "not_found" : "command" };
  }
  let incomplete = false;
  const end = sessionView(db, childId)?.end ?? Number.MAX_SAFE_INTEGER;
  const size = supportedRowSize(db);
  type Taken = { seq: number; time_created: number; created: unknown; shown: string | null; bytes: number | null };
  const take = (shown: string) => `
    SELECT seq, time_created, created, CASE WHEN length(CAST(shown AS BLOB)) <= ${DETAIL_RECORD_BYTES} THEN shown END AS shown,
      length(CAST(shown AS BLOB)) AS bytes
    FROM (SELECT seq, time_created, CASE WHEN ${size} <= ${DETAIL_ROW_BYTES} AND json_valid(data) THEN json_extract(data, '$.time.created') END AS created,
      CASE WHEN ${size} <= ${DETAIL_ROW_BYTES} AND json_valid(data) THEN ${shown} END AS shown
      FROM session_message AS m WHERE session_id = ? AND seq = ?)`;
  const kept = (row: Taken | null): Taken & { shown: string; bytes: number } | null => {
    if (row === null) return null;
    if (row.shown === null || row.bytes === null) { incomplete = true; return null; }
    return row as Taken & { shown: string; bytes: number };
  };
  const promptRow = db.query<{ seq: number }, [string, number]>("SELECT seq FROM session_message WHERE session_id = ? AND type = 'user' AND seq < ? ORDER BY seq DESC LIMIT 1").get(childId, end);
  // the prompt's text alone: a prompt's row also carries the files sent with it
  const dispatch = promptRow === null ? null : kept(db.query<Taken, [string, number]>(take("coalesce(json_extract(data, '$.text'), '')")).get(childId, promptRow.seq));
  const prompt = dispatch !== null && dispatch.shown.trim().length > 0 ? dispatch.shown : null;
  // the newest steps since, one more than can be shown to tell whether older ones were left; each step's text and tool
  // calls (name and input) are taken out in the store, its tools' output left there
  const steps = db.query<{ seq: number }, [string, number, number]>(
    `SELECT seq FROM session_message WHERE session_id = ? AND type = 'assistant' AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ${DETAIL_LIMITS.max_events + 1}`,
  ).all(childId, promptRow?.seq ?? -1, end);
  let truncated = steps.length > DETAIL_LIMITS.max_events;
  let left = DETAIL_LIMITS.max_read_bytes - (dispatch?.bytes ?? 0);
  const stepAt = db.query<Taken, [string, number]>(take(`(SELECT json_group_array(json_object('type', json_extract(c.value, '$.type'),
    'text', json_extract(c.value, '$.text'), 'name', json_extract(c.value, '$.name'), 'input', json_extract(c.value, '$.state.input')))
    FROM json_each(m.data, '$.content') AS c WHERE json_extract(c.value, '$.type') IN ('text', 'tool'))`));
  const taken: PaneBackgroundAgentDetail["events"][] = [];
  for (const { seq } of steps.slice(0, DETAIL_LIMITS.max_events)) {
    const step = kept(stepAt.get(childId, seq));
    if (step === null) continue;
    if (step.bytes > left) { truncated = true; break; }
    left -= step.bytes;
    const at = iso(stamp(step.created) ?? step.time_created);
    let parts: unknown;
    try { parts = JSON.parse(step.shown); } catch { incomplete = true; continue; }
    taken.push((Array.isArray(parts) ? parts : []).flatMap((value): PaneBackgroundAgentDetail["events"] => {
      const part = record(value);
      if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) return [{ kind: "text", text: part.text, at }];
      if (part.type === "tool" && typeof part.name === "string" && part.name.trim().length > 0) {
        return [{ kind: "tool", text: `${part.name.trim()} ${part.input === undefined || part.input === null ? "{}" : JSON.stringify(part.input)}`, at }];
      }
      return [];
    }));
  }
  const fitted = fitDetail(prompt, taken.reverse().flat(), truncated);
  return {
    detail: {
      agent_id: childId,
      session_id: sessionId,
      title: label(child.title),
      agent: label(child.agent),
      prompt: fitted.prompt,
      events: fitted.events,
      truncated: fitted.truncated,
      incomplete,
      limits: DETAIL_LIMITS,
    },
  };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const STEP_TRIES = 50;

export function readSubagents(db: Database, sessionId: string, live: boolean, now: number, serviceStart: number | null, detail: boolean, parentEnds = false): OpencodeSubagentState {
  const scan = newScan(sessionId, now, live, serviceStart, detail, NO_LOG, parentEnds);
  while (!scan.finished) scanStep(db, scan);
  return scanResult(scan);
}

export function opencodeSubagentState(path: string, sessionId: string, live: boolean, now = Date.now(), serviceStart: number | null = null, detail = true, parentEnds = false): OpencodeSubagentState | null {
  try { return withStore(path, (db) => readSubagents(db, sessionId, live, now, serviceStart, detail, parentEnds)); }
  catch { return null; }
}

export async function pagedState(path: string, sessionId: string, live: boolean, now = Date.now(), serviceStart: number | null = null, detail = true, open: typeof withStore = withStore, log: ParentLog | null = null): Promise<OpencodeSubagentState | null> {
  const scan = newScan(sessionId, now, live, serviceStart, detail, log ?? NO_LOG, log !== null);
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
  store: () => string | null;
  parentEnds?: () => boolean;
  serviceStart?: () => number | null;
  onReset?: (paneId: string, first: boolean) => void;
  onChange: (paneId: string, running: number, turnRunning: number, promptAt: number | null, toggled: boolean) => void;
  pollMs?: number;
  now?: () => number;
}

interface Tracked { session: string; live: boolean; running: number; turnRunning: number; promptAt: number | null; reset: boolean; log: ParentLog; parentEnds: boolean | null }

/**
 * The session is the one
 * herdr's OpenCode integration reports (opencodeSessionId), never a guess.
 */
export class OpencodeSubagentStatus {
  private readonly panes = new Map<string, Tracked>();
  private readonly agents = new Map<string, string | null>();
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

  sessionOf(paneId: string): { path: string; session: string; live: boolean } | null {
    const tracked = this.panes.get(paneId);
    const path = this.deps.store();
    return tracked && path !== null ? { path, session: tracked.session, live: tracked.live } : null;
  }

  async tasksOf(paneId: string): Promise<(Pick<OpencodeSubagentState, "tasks" | "unlisted"> & { read: { path: string; session: string; live: boolean } }) | null> {
    for (let tries = 0; tries < 3; tries++) {
      const known = this.sessionOf(paneId);
      if (known === null) return null;
      const parentEnds = this.deps.parentEnds?.() === true;
      const log = parentEnds ? this.panes.get(paneId)?.log ?? NO_LOG : null;
      const state = await pagedState(known.path, known.session, known.live, this.now(), this.deps.serviceStart?.() ?? null, true, withStore, log);
      const current = this.sessionOf(paneId);
      if (current?.path === known.path && current.session === known.session && current.live === known.live && parentEnds === (this.deps.parentEnds?.() === true)) return state === null ? null : { tasks: state.tasks, unlisted: state.unlisted, read: known };
    }
    return null;
  }

  beginRead(): number {
    return ++this.reads;
  }

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

  private newer(paneId: string, read: number): boolean {
    return (this.lastRead.get(paneId) ?? 0) > read;
  }

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
    if (tracked?.session === session) {
      if (tracked.live) return false;
      tracked.live = true;
      this.deps.onReset?.(pane.pane_id, false);
      return true;
    }
    if (tracked !== undefined) this.deps.onReset?.(pane.pane_id, false);
    else if (before != null && before !== "opencode") this.deps.onReset?.(pane.pane_id, true);
    this.panes.set(pane.pane_id, { session, live: true, running: tracked?.running ?? 0, turnRunning: tracked?.turnRunning ?? 0, promptAt: tracked?.promptAt ?? null, reset: tracked !== undefined, log: NO_LOG, parentEnds: tracked?.parentEnds ?? null });
    return true;
  }

  poll(only?: string | ReadonlySet<string>): Promise<void> {
    const path = this.deps.store();
    const wanted = (paneId: string): boolean => only === undefined || (typeof only === "string" ? only === paneId : only.has(paneId));
    const states = new Map<string, OpencodeSubagentState>();
    const scans = new Map<string, Scan>();
    const live = [...this.panes].filter(([paneId, tracked]) => wanted(paneId) && tracked.live && this.reading.get(paneId)?.session !== tracked.session);
    const serviceStart = path !== null && live.length > 0 ? this.deps.serviceStart?.() ?? null : null;
    const parentEnds = this.deps.parentEnds?.() === true;
    if (path !== null && live.length > 0) {
      try {
        withStore(path, (db) => {
          for (const [paneId, tracked] of live) {
            const scan = newScan(tracked.session, this.now(), true, serviceStart, false, tracked.log, parentEnds);
            for (let step = 0; step < 2 && !scan.finished; step++) scanStep(db, scan);
            if (scan.finished) { tracked.log = scan.log; states.set(paneId, scanResult(scan)); continue; }
            scans.set(paneId, scan);
            if (scan.told !== null) continue;
            const own = newScan(tracked.session, this.now(), true, serviceStart, false);
            for (let step = 0; step < 2 && !own.finished; step++) scanStep(db, own);
            const state = own.finished ? scanResult(own) : null;
            if (state !== null && state.running >= tracked.running && state.turnRunning >= tracked.turnRunning) states.set(paneId, state);
          }
        }, 0);
      } catch {}
    }
    for (const [paneId, tracked] of this.panes) {
      if (!wanted(paneId)) continue;
      const state = tracked.live ? states.get(paneId) : NOTHING;
      if (state !== undefined) this.tell(paneId, tracked, state, parentEnds);
    }
    return path === null || scans.size === 0 ? Promise.resolve() : this.readOn(path, scans);
  }

  private readonly reading = new Map<string, { session: string }>();

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
        const tracked = this.panes.get(paneId);
        if (tracked?.live && tracked.session === scan.sessionId && scan.parentEnds === (this.deps.parentEnds?.() === true)) { tracked.log = scan.log; this.tell(paneId, tracked, scanResult(scan), scan.parentEnds); }
      }
    } finally {
      for (const [paneId, token] of tokens) if (this.reading.get(paneId) === token) this.reading.delete(paneId);
    }
  }

  private tell(paneId: string, tracked: Tracked, state: OpencodeSubagentState, parentEnds: boolean): void {
    const { running, turnRunning, promptAt } = state;
    const toggled = tracked.parentEnds !== null && tracked.parentEnds !== parentEnds;
    tracked.parentEnds = parentEnds;
    if (!tracked.reset && running === tracked.running && turnRunning === tracked.turnRunning && promptAt === tracked.promptAt) return;
    tracked.reset = false;
    tracked.running = running;
    tracked.turnRunning = turnRunning;
    tracked.promptAt = promptAt;
    this.deps.onChange(paneId, running, turnRunning, promptAt, toggled);
  }
}
