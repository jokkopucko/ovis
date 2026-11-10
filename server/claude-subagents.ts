import { closeSync, constants, type Dir, fstatSync, lstatSync, opendirSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { commandHistory, resetCommandHistory, sameHistory, vouchedEnds, watchCommandHistory, type CommandEnd, type HistoryEvidence, type HistoryVersion } from "./claude-command-history.ts";
import type { HerdrPane, OmoTask, PaneBackgroundAgentDetail } from "../shared/protocol.ts";

/**
 * The subagents one Claude Code session started (the `Agent` tool), for the status line's list,
 * the pane's running count and the chat's result cards. Claude keeps, beside the session's
 * transcript `<project>/<session>.jsonl`, a folder `<session>/subagents/` with one pair per
 * subagent: `agent-<id>.meta.json` (description, agent type, the tool call that started it) and
 * `agent-<id>.jsonl`, its own transcript. Whether it ended is told only by the parent
 * transcript: a background subagent by the `<task-notification>` Claude queues when it stops (a
 * teammate of an agent team gets none, and one's notice may not be written yet: its own file
 * ending in an `end_turn` answer or in the answer approving its lead's shutdown request, with
 * no message to it after, says it stopped), a synchronous one by the tool_result of its call
 * (the "Async agent launched" acknowledgement of a background call is no answer).
 *
 * A notification is carried up to three times (a user entry, a queue-operation, a queued_command
 * attachment) and the same agent notifies again each time it is resumed, so notices are kept per
 * agent, the newest of notice and answer wins, and an agent whose own file has entries newer than
 * that was resumed and is running again. A running agent lives inside the Claude process that
 * started it: one last written before the process now in the pane started is lost.
 *
 * Reading is cheap enough to run every few seconds per Claude pane: the parent transcript and
 * each subagent file are read only from where the last read stopped, at most READ_BUDGET bytes
 * per file per call (the first read of a parent covers its last PARENT_WINDOW bytes); a file whose
 * size did not change is not opened; the folder listing is kept until the folder changes; only
 * files touched in the last day are looked at, at most MAX_AGENTS of them, and one found older is
 * checked again only every STALE_RECHECK_MS (a long-lived session keeps thousands, #2510); only
 * plain files are read; ids that become paths are plain words. Prompts and answers stay here.
 *
 * `tokens` is the total Claude's own footer shows for a subagent: what its last request held,
 * input + cache read + cache creation + output tokens of the last assistant entry (checked
 * against `totalTokens` in the tool result of a finished agent). Summing every entry instead
 * would count the cached context again on each turn.
 *
 * Background commands are listed with them, as Claude Code's footer counts both: a `Bash` call
 * whose answer carries a `backgroundTaskId` (`run_in_background`, Ctrl+B, or a call moved there
 * when it ran past its timeout), by the session or by a subagent. One ends with the
 * `<task-notification>` of its task id, in any transcript of the session, or with the answer
 * of the `TaskStop` (`KillShell` in older Claude Code) that stopped it, which no notice follows.
 * It lives in the Claude process that started it, as a running agent does. A `Workflow` run or a
 * `Monitor` counts as one such command: its call answers at once with a task id, and the same
 * notice ends it, so a turn waits on it as on a suite.
 */
const READ_BUDGET = 8 * 1024 * 1024;
/** how much of a parent transcript is read the first time: older notices are not found */
export const PARENT_WINDOW = 16 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const MAX_AGENTS = 200;
const MAX_NAMES = 5000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
/** how often an agent file last written more than RECENT_MS ago is checked again: only a write to it can bring it back */
const STALE_RECHECK_MS = 60_000;
/** how much of the end of an agent's file tells its status, whatever else has been read of it */
const TAIL_BYTES = 64 * 1024;
/** a process's start is known to the second, and the clock can step: only an agent quiet this long before the start is taken for another process's */
const START_SLACK_MS = 60_000;
/** an agent id is a file name's part: nothing that could leave the folder */
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const stamp = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

/** Set `key` as the newest entry; the oldest one goes when the map is over `cap`, never all of them. */
export function remember<T>(map: Map<string, T>, key: string, value: T, cap: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value!);
}

/** One `<task-notification>` block, the part of it the chat and the list read. */
export interface TaskNotification {
  taskId: string;
  toolUseId: string | null;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  result: string;
  /** whether it is a subagent's: a background command and a monitor use the same block */
  agent: boolean;
}

export function taskNotification(content: string): TaskNotification | null {
  const block = content.trim();
  if (!block.startsWith("<task-notification>") || !block.endsWith("</task-notification>")) return null;
  const tag = (name: string): string | null => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
  const taskId = tag("task-id");
  const raw = tag("status");
  const summary = tag("summary");
  if (taskId === null || !AGENT_ID.test(taskId) || raw === null || summary === null) return null;
  // the answer may quote the closing tag itself: it runs to the last one
  const from = block.indexOf("<result>");
  const to = block.lastIndexOf("</result>");
  return {
    taskId,
    toolUseId: tag("tool-use-id"),
    status: raw === "completed" ? "completed" : raw === "failed" || raw === "error" ? "failed" : "cancelled",
    summary,
    result: from !== -1 && to > from ? block.slice(from + "<result>".length, to).trim() : "",
    agent: summary.startsWith('Agent "'),
  };
}

/** The blocks a transcript entry carries as a notification, in whichever of the three records holds them. */
function blocksIn(entry: Row): string[] {
  if (entry["type"] === "queue-operation") return entry["operation"] === "enqueue" && typeof entry["content"] === "string" ? [entry["content"]] : [];
  if (entry["type"] === "attachment") {
    const attachment = row(entry["attachment"]);
    return attachment?.["commandMode"] === "task-notification" && typeof attachment["prompt"] === "string" ? [attachment["prompt"]] : [];
  }
  if (entry["type"] !== "user") return [];
  const content = row(entry["message"])?.["content"];
  if (typeof content === "string") return [content];
  // only what the person's side wrote as text: a tool result that quotes a block is not one
  return (Array.isArray(content) ? content : []).flatMap((value) => { const block = row(value); return block?.["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []; });
}

/** The notifications one transcript line carries, none for a line that only mentions the tag. */
export function lineNotifications(line: string): TaskNotification[] {
  if (!line.includes("<task-notification>")) return [];
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return []; }
  return entry === null ? [] : blocksIn(entry).flatMap((block) => taskNotification(block) ?? []);
}

/**
 * The complete lines of `path` from `from`, at most `limit` bytes of them. `skipping`: the read
 * begins inside a line that is not wanted (a window's start, or a line too long to take), which
 * is passed over to its end. A line that does not fit `limit` waits for a call with more, and
 * one that does not fit READ_BUDGET is skipped, not waited for. `more`: the file goes on past
 * what this read looked at. `file`: the plain file `plain` looked at, which the open must still be.
 */
export function readLines(path: string, from: number, file: { size: number; exact: string }, limit: number, each: (line: string, end: number) => void, skipping: boolean): { offset: number; skipping: boolean; more: boolean; failed?: true } {
  const size = file.size;
  const fd = openPlain(path, file.exact)?.fd;
  if (fd === undefined) return { offset: from, skipping, more: true, failed: true };
  try {
    const length = Math.min(size - from, limit);
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    const more = from + got < size;
    let start = 0;
    if (skipping) {
      const newline = buffer.subarray(0, got).indexOf(0x0a);
      if (newline === -1) return { offset: from + got, skipping: true, more };
      start = newline + 1;
    }
    const end = buffer.subarray(0, got).lastIndexOf(0x0a) + 1;
    if (end <= start) {
      // the skipped line ended in this read and nothing complete follows: the next line is read from its start
      if (skipping) return { offset: from + start, skipping: false, more };
      // a line larger than the whole budget is given up; a shorter one waits for a larger share
      return more && limit >= READ_BUDGET ? { offset: from + got, skipping: true, more } : { offset: from + start, skipping: false, more };
    }
    let offset = from + start;
    for (const line of buffer.subarray(start, end).toString("utf8").split("\n")) {
      offset += Buffer.byteLength(line) + 1;
      if (line.length > 0) each(line, offset);
    }
    return { offset: from + end, skipping: false, more };
  } catch { return { offset: from, skipping, more: true, failed: true }; } finally { closeSync(fd); }
}

/**
 * A plain file at `path` as one look sees it: `id`, `size` and `mtimeMs` in the number form the versions share
 * (historyVersion), and `exact`, its identity as BigInt, which a read's open must find (openPlain): two NTFS file IDs
 * can round to one number.
 */
export function plain(path: string, max = Infinity): { size: number; mtimeMs: number; id: string; exact: string } | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    const size = Number(stat.size);
    if (!stat.isFile() || size > max) return null;
    // as a number Stats gives it: seconds in milliseconds, then the nanoseconds
    const mtimeMs = Number(stat.mtimeNs / 1_000_000_000n) * 1000 + Number(stat.mtimeNs % 1_000_000_000n) / 1e6;
    return { size, mtimeMs, id: `${Number(stat.dev)}:${Number(stat.ino)}`, exact: identity(stat) };
  } catch { return null; }
}

/**
 * `path` opened as the plain file whose identity `plain` looked at (`exact`), of at most `max` bytes: its descriptor
 * and size, or null. Not waited on, not followed: a FIFO or a link put in the file's place after the look neither hangs
 * the read nor leads elsewhere, and another file put there is not the one looked at.
 */
function openPlain(path: string, exact: string, max = Infinity): { fd: number; size: number } | null {
  let fd: number;
  try { fd = detailIo.openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const size = Number(opened.size);
    if (opened.isFile() && size <= max && identity(opened) === exact) return { fd, size };
  } catch { /* refused below */ }
  closeSync(fd);
  return null;
}

/** What one transcript says of background commands: those it started, by task id, and how those it heard of ended. */
interface Commands {
  /** the title of each `Bash` call not answered yet: its description, else its command */
  calls: Map<string, string>;
  /** `call`: the `Bash` call that started it, when its answer names one */
  launches: Map<string, { at: number; title: string; call: string | null; seq: number }>;
  /** rows read so far: where in the transcript a launch or an end was written (`seq`) */
  seq: number;
  /** the last few ends of each id, oldest first: an id used again ends once in each lifetime (claudeSubagentState) */
  ends: Map<string, CommandTold[]>;
  /** the `/loop` wakeup set and not fired yet, by its `ScheduleWakeup` call: a session has one at a time */
  wakeup?: string;
}
/** An end a transcript told of: `call`, the `Bash` call its notice names (none for a stop) */
type CommandTold = { at: number; status: OmoTask["status"]; call: string | null; seq?: number; source?: Commands };
const ENDS_PER_ID = 4;
const noCommands = (): Commands => ({ calls: new Map(), launches: new Map(), ends: new Map(), seq: 0 });
const TITLE_LENGTH = 120;

const BACKGROUND_TOOLS = ["Bash", "Monitor", "ScheduleWakeup"];
/** Whether a line may say something of a background command, before it is parsed: the answers of every other call are passed over. */
const commandLine = (line: string): boolean => BACKGROUND_TOOLS.some((name) => line.includes(`"name":"${name}"`)) || line.includes('"backgroundTaskId"') || line.includes('"local_workflow"') || line.includes('"timeoutMs"') || line.includes('"scheduledFor"') || line.includes('"scheduled_task_fire"') || line.includes('"task_id"') || line.includes('"shell_id"');

function commandEnds(result: Row | null, at: number, notices: readonly TaskNotification[]): CommandEnd[] {
  const ends: CommandEnd[] = [];
  const ids = new Set<string>();
  // TaskStop answers with the task it stopped, KillShell with the shell.
  const stopped = typeof result?.["task_type"] === "string" ? result["task_id"] : result?.["shell_id"];
  if (typeof stopped === "string") { ids.add(stopped); ends.push({ id: stopped, at, status: "cancelled", call: null }); }
  for (const notice of notices) if (!notice.agent && !ids.has(notice.taskId)) { ids.add(notice.taskId); ends.push({ id: notice.taskId, at, status: notice.status, call: notice.toolUseId }); }
  return ends;
}

function scanCommands(commands: Commands, entry: Row, at: number | null, notices: readonly TaskNotification[]): void {
  if (at === null) return;
  const seq = ++commands.seq;
  const content = row(entry["message"])?.["content"];
  const blocks = (Array.isArray(content) ? content : []).flatMap((value): Row[] => { const block = row(value); return block === null ? [] : [block]; });
  for (const block of blocks) {
    if (block["type"] !== "tool_use" || !BACKGROUND_TOOLS.includes(block["name"] as string) || typeof block["id"] !== "string") continue;
    const input = row(block["input"]);
    const title = text(input?.["description"]) ?? text(input?.["command"]) ?? text(input?.["reason"]);
    if (title !== null) remember(commands.calls, block["id"], title.slice(0, TITLE_LENGTH), 512);
  }
  const failed = blocks.some((block) => block["type"] === "tool_result" && block["is_error"] === true);
  const result = failed ? null : row(entry["toolUseResult"]);
  const workflow = result?.["taskType"] === "local_workflow" && result["status"] === "async_launched";
  // a Monitor's answer names its task and carries its `timeoutMs`
  const monitor = typeof result?.["timeoutMs"] === "number";
  const launched = workflow || monitor ? result?.["taskId"] : result?.["backgroundTaskId"];
  if (typeof launched === "string" && AGENT_ID.test(launched)) {
    const call = blocks.find((block) => block["type"] === "tool_result" && typeof block["tool_use_id"] === "string")?.["tool_use_id"] as string | undefined;
    const title = workflow ? text(result["workflowName"]) : call === undefined ? undefined : commands.calls.get(call);
    remember(commands.launches, launched, { at, title: title ?? "Background command", call: call ?? null, seq }, MAX_NAMES);
    if (call !== undefined) commands.calls.delete(call);
  }
  // a /loop wakeup starts the next turn by itself when due: its fire, a newer one and a stop end the one set before
  const scheduled = result?.["scheduledFor"];
  const fired = entry["type"] === "system" && entry["subtype"] === "scheduled_task_fire" && entry["taskKind"] === "loop";
  const ends = commandEnds(result, at, notices);
  if ((fired || typeof scheduled === "number") && commands.wakeup !== undefined) {
    ends.push({ id: commands.wakeup, at, status: "completed", call: null });
    commands.wakeup = undefined;
  }
  const wakeupCall = blocks.find((block) => block["type"] === "tool_result")?.["tool_use_id"];
  if (typeof scheduled === "number" && scheduled > 0 && typeof wakeupCall === "string" && AGENT_ID.test(wakeupCall)) {
    remember(commands.launches, wakeupCall, { at, title: commands.calls.get(wakeupCall) ?? "Wakeup", call: wakeupCall, seq }, MAX_NAMES);
    commands.calls.delete(wakeupCall);
    commands.wakeup = wakeupCall;
  }
  for (const end of ends) {
    const told = commands.ends.get(end.id) ?? [];
    // the same notice comes in more than one carrier: once is enough
    if (told.some((known) => known.at === end.at && known.status === end.status && known.call === end.call)) continue;
    remember(commands.ends, end.id, [...told, { at: end.at, status: end.status, call: end.call, seq }].slice(-ENDS_PER_ID), MAX_NAMES);
  }
}

/**
 * Historical reconciliation shares the ordinary parser's accepted carriers and stop answers. A row
 * naming another session (`session`: the transcript's name) ends none of this one's commands; Claude
 * Code writes `sessionId` on its rows, and a row without one is taken as this session's.
 */
export function commandTerminals(line: string, session: string): CommandEnd[] {
  if (!line.includes("<task-notification>") && !line.includes('"task_id"') && !line.includes('"shell_id"')) return [];
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return []; }
  if (entry === null || ("sessionId" in entry && entry["sessionId"] !== session)) return [];
  const at = stamp(entry["timestamp"]);
  if (at === null) return [];
  const content = row(entry["message"])?.["content"];
  const failed = Array.isArray(content) && content.some((value) => { const block = row(value); return block?.["type"] === "tool_result" && block["is_error"] === true; });
  return commandEnds(failed ? null : row(entry["toolUseResult"]), at, blocksIn(entry).flatMap((block) => taskNotification(block) ?? [])).filter((end) => end.id.length <= 300);
}

/**
 * A prompt the person gave, which starts a turn. A notice's turn, a tool's answer, a message from
 * another session, an interruption and Claude Code's own records are not: Claude Code 2.1.2xx
 * marks the person's prompts with `origin` `human`, and older versions with a permission mode,
 * which the others lack. A prompt typed while a turn works is handed to that turn on the way
 * (a `queued_command` attachment): the same turn.
 */
function prompted(entry: Row): boolean {
  if (entry["type"] !== "user" || entry["isMeta"] === true || entry["isCompactSummary"] === true || entry["isSidechain"] === true) return false;
  const content = row(entry["message"])?.["content"];
  if (Array.isArray(content) && content.some((block) => row(block)?.["type"] === "tool_result")) return false;
  const origin = entry["origin"];
  const kind = typeof origin === "string" ? origin : row(origin)?.["kind"];
  if (kind !== undefined) return kind === "human";
  return typeof entry["permissionMode"] === "string" && !blocksIn(entry).join("").trimStart().startsWith("<task-notification>");
}

interface Parent {
  version: HistoryVersion;
  historyLimit: number;
  id: string;
  offset: number;
  skipping: boolean;
  /** read from the middle of the file: what happened before the first entry read is not known */
  windowed: boolean;
  firstAt: number | null;
  /** the read stopped for its budget, not for the end of what was written: what it has not seen says nothing */
  behind: boolean;
  /** per agent, its newest notification */
  notes: Map<string, { at: number; status: TaskNotification["status"] }>;
  /** the ids of `Agent` calls, and how those that were answered ended */
  calls: Set<string>;
  results: Map<string, { at: number; error: boolean }>;
  commands: Commands;
  /**
   * `TaskStop` calls not answered yet, by call id: the task they name. A teammate is named by
   * the name it was spawned with, and the answer then carries a task id of its own that no file
   * of it holds, so the stop is kept under the name asked for as well as under that id.
   */
  stopCalls: Map<string, string>;
  /** when each task named in an answered `TaskStop` was stopped */
  stops: Map<string, number>;
  /** when the person last gave a prompt: the turn going on, or last ended, began there */
  promptAt: number | null;
  /** byte boundary of the session's last trustworthy turn_duration, cleared by later activity or skipped records */
  restAt: number | null;
  /** every byte written was read and parsed: no half-written line or skipped record is left, which may be a next turn's */
  whole: boolean;
  /**
   * Where the session's recent turns began (the byte boundary of the entry that began each: a prompt,
   * or the first entry after a rest), and where the chat's messages were taken into a turn already
   * at work (`queued_command`), with the time each was written: what a busy signal is matched to
   * (ClaudeSubagentStatus.busy).
   */
  starts: Start[];
  /** whether the latest turn goes on: no rest came after it yet */
  turnOpen: boolean;
  /**
   * Where the latest turn Claude resumed by itself was told, while no rest was written after it: that turn
   * may still run (ClaudeSubagentStatus.loopHolds). The byte boundary of a scheduled task's fire (a `/loop`
   * wakeup's is one) or of the turn's own prompt (selfResumed), whichever was written last.
   */
  loopAt: number | null;
  /** when the entry `loopAt` is the boundary of was written, by its own timestamp: how old one found at the transcript's first read is */
  loopTime: number | null;
  /** what a slash command's echo found, until the next entry says whether it began a turn (scanParentLine) */
  echo: { command: string | null; restAt: number | null; promptAt: number | null; turnOpen: boolean; starts: Start[] } | null;
}
interface Start { end: number; at: number | null; turn: boolean }

/** The byte boundary of the entry that began the latest turn. */
const turnAt = (parent: Parent): number | null => lastStart(parent.starts, (start) => start.turn)?.end ?? null;

function lastStart(starts: readonly Start[], test: (start: Start) => boolean): Start | undefined {
  for (let index = starts.length - 1; index >= 0; index--) if (test(starts[index]!)) return starts[index];
  return undefined;
}
const parents = new Map<string, Parent>();

function scanParent(path: string): Parent | null {
  const stat = plain(path);
  if (stat === null) return null;
  let parent = parents.get(path);
  if (!parent || parent.id !== stat.id || parent.offset > stat.size || !sameHistory(parent.version, stat)) {
    const from = Math.max(0, stat.size - PARENT_WINDOW);
    parent = { version: stat, historyLimit: from > 0 ? stat.size : 0, id: stat.id, offset: from, skipping: from > 0, windowed: from > 0, firstAt: null, behind: false, notes: new Map(), calls: new Set(), results: new Map(), commands: noCommands(), stopCalls: new Map(), stops: new Map(), promptAt: null, restAt: null, whole: false, starts: [], turnOpen: false, loopAt: null, loopTime: null, echo: null };
  }
  parent.version = stat;
  remember(parents, path, parent, 256);
  const state = parent;
  if (state.offset >= stat.size) state.behind = false;
  // the first read takes the whole window, a chunk at a time; after that a call reads what was appended
  for (let left = PARENT_WINDOW; state.offset < stat.size && left > 0;) {
    if (state.skipping) state.restAt = null;
    const read = readLines(path, state.offset, stat, READ_BUDGET, (line, end) => {
      if (state.firstAt === null) state.firstAt = stamp(line.match(/"timestamp":"([^"]+)"/)?.[1]);
      scanParentLine(state, line, end);
    }, state.skipping);
    const consumed = read.offset - state.offset;
    state.offset = read.offset;
    state.skipping = read.skipping;
    state.behind = read.more;
    state.whole = read.offset >= stat.size && !read.skipping;
    // a record skipped for its size may be a next turn's prompt
    if (read.skipping) { state.restAt = null; state.echo = null; openTurn(state, read.offset, null); }
    left -= consumed;
    if (consumed === 0) break;
  }
  return state;
}

/** What the transcript has after a rest begins the next turn, which a busy signal can be matched to (ClaudeSubagentStatus.busy). */
function openTurn(parent: Parent, end: number, at: number | null): void {
  if (parent.turnOpen) return;
  parent.turnOpen = true;
  addStart(parent, { end, at, turn: true });
}

function addStart(parent: Parent, start: Start): void {
  const last = parent.starts.at(-1);
  if (last?.end === start.end) { last.turn ||= start.turn; return; }
  parent.starts.push(start);
  if (parent.starts.length > 64) parent.starts.shift();
}

/**
 * A slash command's echo, which Claude Code writes as a user entry, begins a turn as a prompt does:
 * a skill or a custom command runs one. A local command (`/model`) runs none, and writes its output
 * right after the echo (`<local-command-stdout>`, as a user entry or a `local_command` one), with
 * its caveat before it: that output takes back what the echo began.
 */
const COMMAND_ECHO_RE = /"content":"<(?:command-name|command-message|command-args)>/;
/** A slash command as typed (\`/compact\`), which Claude Code writes before running it, with no \`origin\`. */
const SLASH_RE = /"role":"user","content":"\/[^"\s]/;

/** The command a slash command's echo, or its line as typed, names. */
const commandOf = (line: string): string | null =>
  line.match(/"role":"user","content":"\/([^"\s\\]+)/)?.[1]
  ?? line.match(/"content":"(?:<command-message>[^<]*<\/command-message>(?:\\n|\s)*)?<command-name>\/?([^<\s]+)<\/command-name>/)?.[1] ?? null;
const LOCAL_OUTPUT_RE = /"content":"<local-command-(?:stdout|stderr)>/;
/**
 * Bash mode (\`!ls\`): its command and output, which Claude Code writes as user entries. They begin no
 * turn of their own; one that follows (2.1.311 answers the output) writes its request first.
 */
const BASH_RE = /"content":"<bash-(?:input|stdout|stderr)>/;
const LOCAL_CAVEAT_RE = /"content":"<local-command-caveat>/;

/**
 * A slash command's echo is the person's prompt too, though Claude Code writes it with neither
 * `origin` nor a permission mode (server/fixtures/skill-invocations/claude.jsonl). One marked as
 * another's (a notice's `origin`) is not.
 */
function echoed(entry: Row, line: string): boolean {
  if (entry["isMeta"] === true || entry["isSidechain"] === true || !COMMAND_ECHO_RE.test(line)) return false;
  const origin = entry["origin"];
  const kind = typeof origin === "string" ? origin : row(origin)?.["kind"];
  return kind === undefined || kind === "human";
}

/** An `Agent` call's launch is answered at once, with an acknowledgement that is no answer. */
function acknowledgement(entry: Row, block: Row): boolean {
  if (row(entry["toolUseResult"])?.["status"] === "async_launched") return true;
  const content = block["content"];
  const words = typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((part) => row(part)?.["text"]).filter((part) => typeof part === "string").join("");
  return words.startsWith("Async agent launched");
}

/**
 * The keys of the prompt of a turn Claude resumed by itself: Claude Code 2.1.318 writes it as a meta
 * user entry right after a `/loop` wakeup's fire, with `turnOrigin` `scheduled` and `wakeupSource`
 * `loop_wakeup`; a scheduled task that is no loop has `schedule_wakeup` there (2.1.321 gives every
 * prompt with a `wakeupSource` that `turnOrigin`). Its own keys only: words that quote them are
 * escaped inside a JSON string.
 */
const SELF_RESUMED_RE = /"turnOrigin":"scheduled"|"wakeupSource":"/;

/**
 * A self-resumed turn's prompt (SELF_RESUMED_RE), which no person typed and no chat sent: it holds
 * the queue as a scheduled task's fire does (Parent.loopAt). After a fire of its own it only holds
 * on; with no fire between the rest before it and itself, it is what tells of the turn. So for the
 * second of two loops due in one tick, whose prompt runs right after the first loop turn's rest. And
 * for a task that came due while another turn worked, where Claude wrote its fire during that turn:
 * that turn's rest ended the fire's hold, as a rest ends whatever was told before it (scanParentLine),
 * and the task's own turn begins at once. Either turn is told by this line and not by its fire, so it
 * holds nothing from that rest until Claude has written this line, some tens of milliseconds into it.
 */
function selfResumed(parent: Parent, line: string, end: number): void {
  try {
    const entry = row(JSON.parse(line));
    if (entry?.["type"] !== "user" || entry["isSidechain"] === true || (entry["turnOrigin"] !== "scheduled" && typeof entry["wakeupSource"] !== "string")) return;
    parent.loopAt = end;
    parent.loopTime = stamp(entry["timestamp"]);
  } catch { /* a line caught half written is read again */ }
}

function scanParentLine(parent: Parent, line: string, end: number): void {
  const user = line.includes('"type":"user"');
  // Claude writes a local command's caveat and output with neither `origin` nor a permission mode, as a
  // person's prompt never is: a prompt that quotes these tags is the person's, and begins a turn
  const own = !line.includes('"origin":') && !line.includes('"permissionMode":');
  const local = !line.includes('"isSidechain":true') && ((user && own && (LOCAL_OUTPUT_RE.test(line) || BASH_RE.test(line) || (LOCAL_CAVEAT_RE.test(line) && line.includes('"isMeta":true')))) || line.includes('"subtype":"local_command"'));
  // Claude closes the session's turn with a `turn_duration` entry; a next turn writes its request, prompt or answer first.
  // A `progress` entry carries a subagent's message inside it: the subagent's, not the session's
  if (local) {
    // a bash-mode line the chat sent is taken in here, whether or not a turn follows it
    if (line.includes('"content":"<bash-input>')) addStart(parent, { end, at: stamp(line.match(/"timestamp":"([^"]+)"/)?.[1]), turn: false });
    const echo = parent.echo;
    if (echo !== null && LOCAL_OUTPUT_RE.test(line)) {
      parent.restAt = echo.restAt;
      parent.promptAt = echo.promptAt;
      parent.turnOpen = echo.turnOpen;
      parent.starts = echo.starts;
      parent.echo = null;
    }
  } else if (line.includes('"subtype":"turn_duration"')) {
    parent.echo = null;
    try {
      const entry = row(JSON.parse(line));
      if (entry?.["type"] === "system" && entry["isSidechain"] !== true) {
        parent.restAt = stamp(entry["timestamp"]) === null ? null : end;
        // the rest of whatever turn went on, one Claude resumed by itself too: it ends what every fire and
        // self-resumed prompt before it told, which of them began the turn at rest is not kept (selfResumed).
        // A rest that tells no time is none here either: what it follows holds on, for its time at most
        if (parent.restAt !== null) { parent.turnOpen = false; parent.loopAt = null; }
      }
    } catch { /* a line caught half written is read again */ }
  } else if (line.includes('"subtype":"scheduled_task_fire"') && !line.includes('"isSidechain":true')) {
    // a /loop wakeup's fire begins the turn it resumes, before that turn writes its prompt: the rest before it is gone
    try {
      const entry = row(JSON.parse(line));
      if (entry?.["type"] === "system") {
        const written = stamp(entry["timestamp"]);
        // Claude resumes a turn by itself here, with no prompt of the person's nor a send of the chat's to tell of it:
        // any scheduled task's fire holds the queue (ClaudeSubagentStatus.loopHolds), a loop's or not
        if (entry["isSidechain"] !== true) { parent.loopAt = end; parent.loopTime = written; }
        if (entry["taskKind"] === "loop") {
          parent.echo = null;
          parent.restAt = null;
          openTurn(parent, end, written);
        }
      }
    } catch { /* a line caught half written is read again */ }
  } else if (user && line.includes('"isCompactSummary":true')) {
    // a compaction's summary is Claude Code's own: \`/compact\` is told by its command, an idle compaction runs no turn
  } else if (/"type":"(?:user|assistant|api-request)"/.test(line) && !line.includes('"isSidechain":true') && !line.includes('"type":"progress"')) {
    // a command's echo, and its line as typed before it (\`/compact\`): its output takes back what the
    // first of them began. Only the same command's: another's echo between them begins a turn of its own
    // Claude Code writes both with neither \`origin\` nor a permission mode: a prompt quoting them is the person's
    const echo = user && own && (COMMAND_ECHO_RE.test(line) || SLASH_RE.test(line));
    const command = echo ? commandOf(line) : null;
    parent.echo = !echo ? null : parent.echo !== null && parent.echo.command === command ? parent.echo
      : { command, restAt: parent.restAt, promptAt: parent.promptAt, turnOpen: parent.turnOpen, starts: parent.starts.map((start) => ({ ...start })) };
    parent.restAt = null;
    openTurn(parent, end, stamp(line.match(/"timestamp":"([^"]+)"/)?.[1]));
    if (user && SELF_RESUMED_RE.test(line)) selfResumed(parent, line, end);
  } else if (line.includes('"queued_command"') && !line.includes('"isSidechain":true')) {
    try {
      const entry = row(JSON.parse(line));
      if (entry?.["type"] === "attachment" && row(entry["attachment"])?.["type"] === "queued_command") {
        addStart(parent, { end, at: stamp(entry["timestamp"]), turn: false });
        // a message taken in while a command runs: no command's output takes back the work it brings
        parent.echo = null;
      }
    } catch { /* a line caught half written is read again */ }
  }
  const mentioned = line.includes("<task-notification>");
  const calling = line.includes('"name":"Agent"') || line.includes('"name":"Task"');
  const answering = parent.calls.size > 0 && line.includes('"tool_result"');
  const commanding = commandLine(line);
  // a tool's answer always names its call: a prompt is a user entry that does not
  const prompting = line.includes('"type":"user"') && !line.includes('"tool_use_id"');
  if (!mentioned && !calling && !answering && !commanding && !prompting) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  if (entry === null) return;
  const at = stamp(entry["timestamp"]);
  if (prompting && !local && (prompted(entry) || echoed(entry, line))) {
    if (at !== null) parent.promptAt = at;
    // a prompt begins a turn also where no rest ended the one before (an interrupted turn writes none)
    addStart(parent, { end, at, turn: true });
    parent.turnOpen = true;
  }
  // one line can hold all three: a batched entry, or an answer that quotes the tag
  const notices = mentioned ? blocksIn(entry).flatMap((block) => taskNotification(block) ?? []) : [];
  if (at !== null) {
    for (const notice of notices) {
      const known = parent.notes.get(notice.taskId);
      if (notice.agent && (!known || at >= known.at)) parent.notes.set(notice.taskId, { at, status: notice.status });
    }
  }
  if (commanding || notices.length > 0) scanCommands(parent.commands, entry, at, notices);
  const content = row(entry["message"])?.["content"];
  for (const value of Array.isArray(content) ? content : []) {
    const block = row(value);
    if (block === null) continue;
    if (commanding) scanStop(parent, entry, block, at);
    if (calling && block["type"] === "tool_use" && (block["name"] === "Agent" || block["name"] === "Task") && typeof block["id"] === "string") parent.calls.add(block["id"]);
    else if (answering && block["type"] === "tool_result" && at !== null && typeof block["tool_use_id"] === "string" && parent.calls.has(block["tool_use_id"]) && !acknowledgement(entry, block)) {
      parent.results.set(block["tool_use_id"], { at, error: block["is_error"] === true });
    }
  }
  if (parent.calls.size > MAX_NAMES) parent.calls.clear();
  if (parent.stopCalls.size > MAX_NAMES) parent.stopCalls.clear();
  if (parent.results.size > MAX_NAMES) parent.results.clear();
}

/** A `TaskStop` call and its answer: the task named, by the selector asked for and by the id answered. */
function scanStop(parent: Parent, entry: Row, block: Row, at: number | null): void {
  if (block["type"] === "tool_use" && block["name"] === "TaskStop" && typeof block["id"] === "string") {
    const asked = text(row(block["input"])?.["task_id"]);
    if (asked !== null) remember(parent.stopCalls, block["id"], asked, MAX_NAMES);
    return;
  }
  if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") return;
  const asked = parent.stopCalls.get(block["tool_use_id"]);
  if (asked === undefined) return;
  parent.stopCalls.delete(block["tool_use_id"]);
  if (at === null || block["is_error"] === true) return;
  const answered = row(entry["toolUseResult"])?.["task_id"];
  for (const id of new Set([asked, ...(typeof answered === "string" ? [answered] : [])])) remember(parent.stops, id, at, MAX_NAMES);
}

/** `title`: what it was called (description, else a teammate's name); a session resumed in a new file keeps neither toolUseId nor description */
interface Meta { title: string | null; name: string | null; agent: string | null; toolUseId: string | null }
const metas = new Map<string, { key: string; meta: Meta | null }>();

/** `where`: the file in the folder held open (claudeSubagentState); `path` names it in the cache. */
function readMeta(path: string, where: string): Meta | null {
  const stat = plain(where, MAX_META_BYTES);
  if (stat === null) return null;
  const key = `${stat.id}:${stat.mtimeMs}:${stat.size}`;
  const known = metas.get(path);
  if (known?.key === key) return known.meta;
  let meta: Meta | null = null;
  const opened = openPlain(where, stat.exact, MAX_META_BYTES);
  if (opened === null) return null;
  const fd = opened.fd;
  try {
    const record = row(JSON.parse(readAt(fd, 0, opened.size).toString("utf8")));
    if (record !== null) meta = { title: text(record["description"]) ?? text(record["name"]), name: text(record["name"]), agent: text(record["agentType"]), toolUseId: text(record["toolUseId"]) };
  } catch { return null; } finally { closeSync(fd); } // being written
  remember(metas, path, { key, meta }, 4096);
  return meta;
}

/** What a subagent's own transcript says of it so far. */
interface Work {
  id: string;
  offset: number;
  skipping: boolean;
  behind: boolean;
  /** it waits for a larger share of the budget than it was given: it is read first next time */
  hungry: boolean;
  firstAt: number | null;
  lastAt: number | null;
  /** latest instruction to this agent, not a result of a tool it called */
  dispatchAt: number | null;
  model: string | null;
  turns: number;
  toolCalls: number;
  tokens: number | null;
  lastMessage: string | null;
  /** when its last request ended its turn, while nothing has been said to it or by it since */
  turnEndedAt: number | null;
  commands: Commands;
}
const works = new Map<string, Work>();

function scanWork(path: string, where: string, budget: { left: number }): Work | null {
  const stat = plain(where);
  if (stat === null) return null;
  let work = works.get(path);
  if (!work || work.id !== stat.id || work.offset > stat.size) {
    work = { id: stat.id, offset: 0, skipping: false, behind: false, hungry: false, firstAt: null, lastAt: null, dispatchAt: null, model: null, turns: 0, toolCalls: 0, tokens: null, lastMessage: null, turnEndedAt: null, commands: noCommands() };
  }
  remember(works, path, work, 4096);
  if (work.offset >= stat.size) { work.behind = false; work.hungry = false; return work; }
  // a file whose turn has not come reads nothing now, and is behind
  if (budget.left <= 0) { work.behind = true; work.hungry = true; return work; }
  const state = work;
  const limit = Math.min(budget.left, READ_BUDGET);
  const read = readLines(where, state.offset, stat, limit, (line) => {
    let entry: Row | null;
    try { entry = row(JSON.parse(line)); } catch { return; }
    if (entry === null) return;
    const at = stamp(entry["timestamp"]);
    if (at !== null) { state.firstAt ??= at; state.lastAt = at; }
    if (at !== null && isDispatch(entry)) state.dispatchAt = at;
    // attachments and bookkeeping say nothing of its turn
    state.turnEndedAt = turnAfter(entry, at, state.turnEndedAt);
    const notices = line.includes("<task-notification>") ? blocksIn(entry).flatMap((block) => taskNotification(block) ?? []) : [];
    if (notices.length > 0 || commandLine(line)) scanCommands(state.commands, entry, at, notices);
    if (entry["type"] !== "assistant") return;
    const message = row(entry["message"]);
    // one request is written as one entry per content block, all with the same message id
    const id = text(message?.["id"]);
    if (id === null || id !== state.lastMessage) state.turns += 1;
    state.lastMessage = id;
    for (const block of Array.isArray(message?.["content"]) ? message["content"] : []) if (row(block)?.["type"] === "tool_use") state.toolCalls += 1;
    const model = text(message?.["model"]);
    if (model !== null && !model.startsWith("<")) state.model = model;
    const usage = row(message?.["usage"]);
    if (usage !== null) {
      const parts = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].map((name) => typeof usage[name] === "number" ? usage[name] : 0);
      state.tokens = parts.reduce((sum, part) => sum + part, 0);
    }
  }, state.skipping);
  budget.left -= read.offset - state.offset;
  state.hungry = read.offset === state.offset && read.more && limit < READ_BUDGET;
  state.offset = read.offset;
  state.skipping = read.skipping;
  state.behind = read.more;
  return state;
}

/** A new instruction resumes an agent; a tool result only continues its existing dispatch. */
function isDispatch(entry: Row): boolean {
  if (entry["type"] !== "user" || entry["isMeta"] === true || entry["isCompactSummary"] === true) return false;
  if (blocksIn(entry).some((block) => block.trimStart().startsWith("<task-notification>"))) return false;
  const content = row(entry["message"])?.["content"];
  return typeof content === "string" ? content.trim().length > 0
    : Array.isArray(content) && content.some((block) => row(block)?.["type"] === "text")
      && !content.some((block) => row(block)?.["type"] === "tool_result");
}

/** a teammate that approves its lead's shutdown request exits right after this answer, with no end_turn after the request */
function approvedShutdown(entry: Row): boolean {
  const result = row(entry["toolUseResult"]);
  const requestId = result?.["request_id"];
  const message = result?.["message"];
  return result?.["success"] === true && typeof requestId === "string" && requestId.startsWith("shutdown-") && typeof message === "string" && message.startsWith("Shutdown approved");
}

/** A message to an agent or a result for it starts its turn again; its own answer ends it, unless it goes on (streamed blocks, a tool call). */
function turnAfter(entry: Row, at: number | null, turnEndedAt: number | null): number | null {
  if (entry["type"] === "user" && approvedShutdown(entry)) return at;
  if (entry["type"] === "user") return null;
  if (entry["type"] !== "assistant") return turnEndedAt;
  return row(row(entry["message"]))?.["stop_reason"] === "end_turn" ? at : null;
}

function readBytes(path: string, exact: string, from: number, length: number): Buffer | null {
  const fd = openPlain(path, exact)?.fd;
  if (fd === undefined) return null;
  try {
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return buffer.subarray(0, got);
  } catch { return null; } finally { closeSync(fd); }
}

/** What the end of an agent's file says of it: when it was last written, and whether its turn ended. */
interface Tail { known: boolean; firstAt: number | null; lastAt: number | null; dispatchAt: number | null; turnEndedAt: number | null }
const tails = new Map<string, { id: string; key: string; tail: Tail }>();

/**
 * The status of an agent must not wait for the whole of its file to be read, which takes calls:
 * its last TAIL_BYTES (back to a line start) hold the last entries, whatever they are, and the
 * first line its start. Read again only when the file changed; not counted against any budget.
 * `known` false: the tail holds no whole line of it (one very long entry, or a file being written).
 */
function readTail(path: string, where: string, stat: { size: number; mtimeMs: number; id: string; exact: string }): Tail {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const kept = tails.get(path);
  if (kept?.id === stat.id && kept.key === key) return kept.tail;
  const tail: Tail = { known: false, firstAt: kept?.id === stat.id ? kept.tail.firstAt : null, lastAt: null, dispatchAt: null, turnEndedAt: null };
  if (stat.size === 0) { tail.known = true; return tail; }
  const from = Math.max(0, stat.size - TAIL_BYTES);
  const chunk = readBytes(where, stat.exact, from, stat.size - from);
  if (chunk === null) return tail;
  const end = chunk.lastIndexOf(0x0a) + 1;
  const start = from === 0 ? 0 : chunk.indexOf(0x0a) + 1;
  let decisive = false;
  let lines = 0;
  if (end > start) {
    for (const line of chunk.subarray(start, end).toString("utf8").split("\n")) {
      let entry: Row | null;
      try { entry = row(JSON.parse(line)); } catch { continue; }
      if (entry === null) continue;
      lines += 1;
      const at = stamp(entry["timestamp"]);
      if (at !== null) { if (from === 0) tail.firstAt ??= at; tail.lastAt = at; }
      if (at !== null && isDispatch(entry)) tail.dispatchAt = at;
      if (entry["type"] === "user" || entry["type"] === "assistant") decisive = true;
      tail.turnEndedAt = turnAfter(entry, at, tail.turnEndedAt);
    }
  }
  tail.known = (from === 0 && end > 0) || decisive;
  if (tail.firstAt === null && from > 0) {
    const head = readBytes(where, stat.exact, 0, TAIL_BYTES);
    const newline = head?.indexOf(0x0a) ?? -1;
    if (head !== null && newline !== -1) { try { tail.firstAt = stamp(row(JSON.parse(head.subarray(0, newline).toString("utf8")))?.["timestamp"]); } catch { /* a long first line: no start yet */ } }
  }
  remember(tails, path, { id: stat.id, key, tail }, 4096);
  return tail;
}

const subagentsDir = (parentPath: string): string => join(parentPath.replace(/\.jsonl$/, ""), "subagents");

function folderVersion(dir: string): { sig: string; latestMs: number } {
  try {
    const stat = lstatSync(dir);
    // a link leads to another session's folder, whose agents are none of this one's
    if (!stat.isDirectory()) return { sig: "-", latestMs: 0 };
    return { sig: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`, latestMs: Math.max(stat.mtimeMs, stat.ctimeMs) };
  } catch { return { sig: "-", latestMs: 0 }; }
}

/**
 * The folder's listing, read again only when the folder changed. A folder's time is coarse: one
 * that changed within a second of the read may have changed again with the same time, so only a
 * listing read after the folder had been quiet for a second is kept.
 */
const listings = new Map<string, { sig: string; readAt: number; ids: string[]; chain: Folder["chain"] }>();
function agentIds(parentPath: string, folder: Folder | null): string[] {
  const dir = subagentsDir(parentPath);
  const { sig, latestMs } = folderVersion(dir);
  // the session's own folder only, as the detail read opens it: a link on the way, or one swapped in, lists nothing
  if (sig === "-" || folder === null) { listings.delete(dir); return []; }
  const known = listings.get(dir);
  // and only while each folder on the way is still the one listed: a session folder moved and replaced with a link to it
  // leaves the subagents folder as it was, and lists nothing as the detail read opens nothing
  if (known?.sig === sig && known.readAt - latestMs >= 1000 && known.chain.every((step) => folderId(step.path) === step.id)) return known.ids;
  const ids: string[] = [];
  let listing: Dir | undefined;
  // read entry by entry, inside the folder opened where the kernel allows: a folder of any size costs at most MAX_NAMES names
  try {
    listing = opendirSync(folder.fd === null ? folder.path : `${FD_DIR}/${folder.fd}`);
    for (let read = 0; read < MAX_NAMES; read += 1) {
      const entry = listing.readSync();
      if (entry === null) break;
      const id = /^agent-(.+)\.meta\.json$/.exec(entry.name)?.[1];
      if (id !== undefined && AGENT_ID.test(id)) ids.push(id);
    }
    // a folder on the way swapped while it was listed: what was listed may be another folder's
    if (!intact(folder)) return [];
  } catch { return []; } finally { listing?.closeSync(); }
  remember(listings, dir, { sig, readAt: Date.now(), ids, chain: folder.chain }, 256);
  return ids;
}

/**
 * Per subagents folder, the agents whose file was last written more than RECENT_MS ago when
 * checked `at`: they are not checked again until STALE_RECHECK_MS later, so a poll does not
 * stat thousands of old files. A file not there (yet) or not plain is never one of them.
 */
const staleAgents = new Map<string, { at: number; ids: Set<string> }>();
const staleFresh = (known: { at: number } | undefined, now: number): boolean => known !== undefined && now >= known.at && now - known.at < STALE_RECHECK_MS;

/** What changes when a session's subagents may have: the folder, parent transcript and every watched agent's own file. */
export function subagentsSignature(parentPath: string, watch: readonly string[] = [], now = Date.now()): { sig: string; latestMs: number } {
  const dir = subagentsDir(parentPath);
  const folder = folderVersion(dir);
  // A file may grow in the same coarse mtime tick, or be replaced with one of the same size.
  const watched = [plain(parentPath), ...watch.map((id) => plain(join(dir, `agent-${id}.jsonl`)))];
  // which check of the old agents a read relied on: another pane's recheck, an evicted entry or one
  // due again (an old agent may have been resumed) is a change for every pane of the session
  const stale = staleAgents.get(dir);
  const old = stale === undefined ? "-" : stale.ids.size === 0 ? "0" : staleFresh(stale, now) ? `${stale.at}` : "due";
  return {
    sig: `${folder.sig}:${old}:${watch.join(",")}:${watched.map((stat, index) => stat ? `${stat.id}:${stat.size}:${stat.mtimeMs}:${index > 0 && now - stat.mtimeMs > RECENT_MS}` : "-").join(",")}`,
    latestMs: Math.max(folder.latestMs, ...watched.map((stat) => stat?.mtimeMs ?? 0)),
  };
}

/** What a subagent's chat card takes from its files: what it was started with, which never changes. */
export interface SubagentDetail {
  title: string | null;
  agent: string | null;
}

/** The subagents named, by agent id, as their meta files say. An id that is not a plain word is none. */
export function subagentDetails(parentPath: string, ids: Iterable<string>): Map<string, SubagentDetail> {
  const found = new Map<string, SubagentDetail>();
  const wanted = [...new Set(ids)].filter((id) => AGENT_ID.test(id));
  if (wanted.length === 0) return found;
  // opened as the detail read opens them: another session's folder, linked or swapped in, titles nothing
  const folder = sessionFolder(parentPath);
  if (typeof folder === "string") return found;
  try {
    for (const id of wanted) {
      const meta = openIn(folder, `agent-${id}.meta.json`, MAX_META_BYTES);
      if (typeof meta === "string") continue;
      let record: Row | null;
      try { record = stillThere(meta) ? row(JSON.parse(readAt(meta.fd, 0, meta.size).toString("utf8"))) : null; } catch { record = null; } finally { closeSync(meta.fd); }
      if (record !== null) found.set(id, { title: text(record["description"]) ?? text(record["name"]), agent: text(record["agentType"]) });
    }
    return intact(folder) ? found : new Map();
  } finally { if (folder.fd !== null) closeSync(folder.fd); }
}

/**
 * GET /api/pane/background-agent: what one subagent's own transcript holds, for a reader who opens
 * it while it runs (shared/protocol.ts PaneBackgroundAgentDetail). A read of its own, apart from
 * the scanner above: the scanner keeps counts and status for every agent of every Claude pane and
 * carries no prompt or tool argument; this reads one agent's two files once, on request, and
 * keeps nothing. Bounded: the meta file at MAX_META_BYTES, the transcript at
 * DETAIL_LIMITS.max_read_bytes in all, in two reads that never overlap (its first
 * DETAIL_HEAD_BYTES, where the dispatch prompt is, and its last DETAIL_TAIL_BYTES, the recent
 * activity, the byte before which says whether the window starts a record), a record at
 * DETAIL_RECORD_BYTES, the answer at DETAIL_LIMITS.max_events events and max_output_bytes of text.
 * A record a window cuts, one over its size and a line that is no record are skipped and said
 * (`incomplete`), never guessed at: a dispatch that cannot be read is no prompt, and a later
 * instruction is not taken for it. What the windows left out, the events dropped for the cap and
 * the text left out for its budget are said (`truncated`). Only the prompt the agent was
 * dispatched with, its prose and its tool calls (name and arguments) are read: no tool result,
 * no thinking, no image, nothing from a screen.
 *
 * The files are `<store>/<session>/subagents/agent-<id>.meta.json` and `agent-<id>.jsonl`, the
 * store being the real folder of the session's own transcript. The id is a plain word of at most
 * DETAIL_ID_LENGTH, so it names nothing outside that folder. Each folder on the way is a folder
 * and no link, looked at before the files are opened and again after they are read, and must be
 * the same folder both times. Where the kernel names an open descriptor's file (Linux's
 * /proc/self/fd), the subagents folder is opened itself and the files are opened inside that open
 * folder, and each descriptor's own path must be the one expected: a folder on the way swapped for
 * a link, or moved away, between the look and the read, is refused, whatever was opened. Elsewhere
 * the looks before and after stand for it. A file is opened only as a plain file that is no link,
 * and the descriptor read is checked to be the file that was looked at.
 *
 * A file there is the agent's only when it says so: its meta file names an agent type, and every
 * record of its transcript is a sidechain's of this session and of this agent (Claude Code writes
 * `isSidechain`, `sessionId` and `agentId` on each). A file that says otherwise is no agent of the
 * session's; nothing of it is answered.
 */
export const DETAIL_LIMITS: PaneBackgroundAgentDetail["limits"] = Object.freeze({ max_read_bytes: 256 * 1024, max_output_bytes: 128 * 1024, max_events: 128 });
const DETAIL_HEAD_BYTES = 64 * 1024;
const DETAIL_TAIL_BYTES = DETAIL_LIMITS.max_read_bytes - DETAIL_HEAD_BYTES;
const DETAIL_RECORD_BYTES = 64 * 1024;
const DETAIL_ID_LENGTH = 128;
/** where the kernel names each open descriptor's file; absent off Linux */
const FD_DIR = "/proc/self/fd";
const fdPaths = ((): boolean => { try { return process.platform === "linux" && lstatSync(FD_DIR).isDirectory(); } catch { return false; } })();

/** The calls the detail read makes to the file system: a test counts its bytes, or changes the store between a look and an open. */
export const detailIo = { openSync, readSync };

/** Why the detail was not read: no such agent in the session, or a store that cannot be read as it should be. */
export type DetailRefusal = "not_found" | "unavailable";

/** Whether `id` can name a subagent's files: the scanner's word, and no longer than DETAIL_ID_LENGTH. */
export const validDetailId = (id: string): boolean => id.length > 0 && id.length <= DETAIL_ID_LENGTH && AGENT_ID.test(id);

type DetailEvent = PaneBackgroundAgentDetail["events"][number];

/**
 * A file's identity as the swap checks compare it, read as BigInt: an NTFS file ID can pass Number.MAX_SAFE_INTEGER, and
 * as a plain number two files made close together in one folder could read as the same file.
 */
const identity = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;

/** A folder's identity: a folder that is no link, or null (a link, a file, nothing). */
function folderId(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() ? identity(stat) : null;
  } catch { return null; }
}

/** Whether an error says only that nothing is there (a missing entry, or a missing folder on its way), not that it cannot be read. */
const absent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** What is at `path`, not followed: a plain folder or file with its identity, nothing, something else, or an error that is no answer. */
function look(path: string): { kind: "folder" | "file"; id: string; size: number } | "missing" | "other" | "error" {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) return "other";
    if (stat.isDirectory()) return { kind: "folder", id: identity(stat), size: Number(stat.size) };
    return stat.isFile() ? { kind: "file", id: identity(stat), size: Number(stat.size) } : "other";
  } catch (error) { return absent(error) ? "missing" : "error"; }
}

/** The path the kernel has for an open descriptor, or null where it has none. */
function fdPath(fd: number): string | null {
  try { return readlinkSync(`${FD_DIR}/${fd}`); } catch { return null; }
}

/** The subagents folder of a session, as looked at: each folder on the way and its identity; open where descriptors name their files. */
interface Folder { path: string; fd: number | null; chain: Array<{ path: string; id: string }> }

function openFolder(store: string, sessionId: string): Folder | DetailRefusal {
  const path = join(store, sessionId, "subagents");
  const chain: Folder["chain"] = [];
  for (const step of [store, join(store, sessionId), path]) {
    const seen = look(step);
    // a folder that is not there has no agent; one that is a link or no folder leads out of the store, and one that
    // cannot be looked at (no permission, an I/O error) is a store not readable now, never an agent gone
    if (seen === "missing") return "not_found";
    if (typeof seen === "string" || seen.kind !== "folder") return "unavailable";
    chain.push({ path: step, id: seen.id });
  }
  if (!fdPaths) return { path, fd: null, chain };
  let fd: number;
  try { fd = detailIo.openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); } catch { return "unavailable"; }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.isDirectory() && identity(opened) === chain.at(-1)!.id && fdPath(fd) === path) return { path, fd, chain };
  } catch { /* refused below */ }
  closeSync(fd);
  return "unavailable";
}

/** The subagents folder of the session whose transcript is `parentPath`, opened by openFolder in the store's real place. */
function sessionFolder(parentPath: string): Folder | DetailRefusal {
  let store: string;
  try { store = realpathSync(dirname(parentPath)); } catch { return "unavailable"; }
  return openFolder(store, basename(parentPath, ".jsonl"));
}

/** The session's subagents folder opened by sessionFolder for one read, closed with it; null when it cannot be. */
function heldFolder(parentPath: string): { folder: Folder | null; [Symbol.dispose](): void } {
  const opened = sessionFolder(parentPath);
  const folder = typeof opened === "string" ? null : opened;
  return { folder, [Symbol.dispose]: () => { if (folder !== null && folder.fd !== null) closeSync(folder.fd); } };
}

/** Whether the folder is still the one looked at: every folder on the way the same, and the open one where it was. */
function intact(folder: Folder): boolean {
  return folder.chain.every((step) => folderId(step.path) === step.id) && (folder.fd === null || fdPath(folder.fd) === folder.path);
}

/**
 * `name` in `folder`, opened as the plain file it was looked at as: no link, not replaced since the look, at most `max` bytes.
 * `not_found` when there is no such plain file; `unavailable` when one is there but cannot be opened as looked at (no
 * permission, or replaced meanwhile), so a read that fails is never taken for an agent gone from the session.
 */
function openIn(folder: Folder, name: string, max = Infinity): Opened | DetailRefusal {
  const path = join(folder.path, name);
  // inside the open folder itself where the kernel allows: a folder put in its place leads nowhere else
  const where = folder.fd === null ? path : `${FD_DIR}/${folder.fd}/${name}`;
  const looked = look(where);
  if (looked === "missing") return "not_found";
  // a link, no plain file, or one over its size is none of this agent's; one that cannot be looked at is a store not readable now
  if (looked === "error") return "unavailable";
  if (looked === "other" || looked.kind !== "file" || looked.size > max) return "not_found";
  let fd: number;
  // O_NOFOLLOW: a link put in the file's place after the look is refused by the open itself where the platform has it;
  // O_NONBLOCK: a FIFO put there is opened without waiting for a writer, and refused as no plain file
  try { fd = detailIo.openSync(where, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return "unavailable"; }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const size = Number(opened.size);
    if (opened.isFile() && identity(opened) === looked.id && size <= max && (folder.fd === null || fdPath(fd) === path)) return { fd, size, id: looked.id, path, where };
  } catch { /* refused below */ }
  closeSync(fd);
  return "unavailable";
}

/** A file `openIn` opened: its descriptor, its size and identity then, and where it was. */
interface Opened { fd: number; size: number; id: string; path: string; where: string }

/**
 * Whether an opened file is still the one looked at, where it was looked at, after its read: the same identity at its
 * path, and its descriptor still there (where the kernel names a descriptor's file). A file moved out of the session
 * or its path replaced while it was read may have been read as another file.
 */
function stillThere(file: Opened): boolean {
  const seen = look(file.where);
  if (typeof seen === "string" || seen.kind !== "file" || seen.id !== file.id) return false;
  try { if (identity(fstatSync(file.fd, { bigint: true })) !== file.id) return false; } catch { return false; }
  return !fdPaths || fdPath(file.fd) === file.path;
}

function readAt(fd: number, from: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = detailIo.readSync(fd, buffer, got, length - got, from + got);
    if (n === 0) break;
    got += n;
  }
  return buffer.subarray(0, got);
}

/** The text the person's side of an entry carries: a string, or its text blocks; null for a tool's answer. */
function userText(entry: Row): string | null {
  const content = row(entry["message"])?.["content"];
  if (typeof content === "string") return content.trim().length > 0 ? content : null;
  if (!Array.isArray(content) || content.some((block) => row(block)?.["type"] === "tool_result")) return null;
  const parts = content.flatMap((block) => { const part = row(block); return part?.["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []; });
  const joined = parts.join("\n");
  return joined.trim().length > 0 ? joined : null;
}

/** `text` cut to at most `max` UTF-8 bytes, a character cut in two left out with its remains. */
function cut(text: string, max: number): string {
  return Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
}

/**
 * One agent's transcript records, read from `fd` as the windows above: what they say, and what
 * could not be read of them. `foreign`: a record says it is another session's or another agent's,
 * or no sidechain's; then the file is not this agent's, and nothing of it may be answered.
 */
function readDetailRecords(fd: number, size: number, sessionId: string, agentId: string): { prompt: string | null; events: DetailEvent[]; truncated: boolean; incomplete: boolean; foreign: boolean } {
  // the whole file when it fits the budget; else its head and its tail, the tail's look-behind byte inside the budget
  const gap = size > DETAIL_LIMITS.max_read_bytes;
  let incomplete = false;
  let foreign = false;
  let prompt: string | null = null;
  /** the dispatch is the file's first record that is an instruction: until it is read, or a record before it could not be, it may still be */
  let dispatchOpen = true;
  const events: DetailEvent[] = [];
  const skipped = (promptable: boolean): void => {
    incomplete = true;
    // a record that could not be read may have been the dispatch: a later instruction is not taken for it
    if (promptable) dispatchOpen = false;
  };
  /** `promptable`: the window holds the file's start, where the dispatch is; a later instruction in the tail is not it */
  const take = (chunk: Buffer, from: number, to: number, promptable: boolean): void => {
    for (const line of chunk.subarray(from, to).toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > DETAIL_RECORD_BYTES) { skipped(promptable); continue; }
      let entry: Row | null;
      try { entry = row(JSON.parse(line)); } catch { skipped(promptable); continue; }
      if (entry === null) { skipped(promptable); continue; }
      const content = entry["type"] === "user" || entry["type"] === "assistant";
      // Claude Code marks every record of a subagent's file as the sidechain of its session and agent
      const declared = entry["isSidechain"] === false || ("sessionId" in entry && entry["sessionId"] !== sessionId) || ("agentId" in entry && entry["agentId"] !== agentId);
      if (declared || (content && (entry["isSidechain"] !== true || entry["sessionId"] !== sessionId || entry["agentId"] !== agentId))) { foreign = true; return; }
      const at = iso(stamp(entry["timestamp"]));
      if (entry["type"] === "user") {
        // the first instruction is the dispatch; a later one, and every tool's answer, is not the agent's own activity
        if (promptable && dispatchOpen && entry["isMeta"] !== true && entry["isCompactSummary"] !== true) { prompt = userText(entry); dispatchOpen = false; }
        continue;
      }
      if (entry["type"] !== "assistant") continue;
      const blocks = row(entry["message"])?.["content"];
      for (const value of Array.isArray(blocks) ? blocks : []) {
        const block = row(value);
        if (block === null) continue;
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim().length > 0) events.push({ kind: "text", text: block["text"], at });
        else if (block["type"] === "tool_use" && typeof block["name"] === "string" && block["name"].length > 0) {
          const input = block["input"];
          events.push({ kind: "tool", text: `${block["name"].trim()} ${input === undefined ? "{}" : JSON.stringify(input)}`, at });
        }
      }
    }
  };
  /** the complete lines of a window: from `start` to its last newline; what follows is cut by the window, or still being written */
  const complete = (chunk: Buffer, start: number, promptable: boolean): void => {
    const end = chunk.lastIndexOf(0x0a) + 1;
    if (end > start && !foreign) take(chunk, start, end, promptable);
    if (end < chunk.length) skipped(promptable);
  };
  if (!gap) complete(readAt(fd, 0, size), 0, true);
  else {
    complete(readAt(fd, 0, DETAIL_HEAD_BYTES), 0, true);
    // the tail window and the byte before it, which says whether the window starts a record: DETAIL_TAIL_BYTES in all, after the head's
    const from = size - DETAIL_TAIL_BYTES;
    const tail = readAt(fd, from, DETAIL_TAIL_BYTES);
    let start = 1;
    if (tail[0] !== 0x0a) {
      const newline = tail.indexOf(0x0a);
      incomplete = true;
      start = newline === -1 ? tail.length : newline + 1;
    }
    if (!foreign) complete(tail, start, false);
  }
  return { prompt, events, truncated: gap, incomplete, foreign };
}

/**
 * The detail of the subagent `agentId` of the session whose transcript is `parentPath`, without
 * `server_time`; or why it was not read. `validDetailId` holds for `agentId` (the route checks it).
 */
export function backgroundAgentDetail(parentPath: string, agentId: string): { detail: Omit<PaneBackgroundAgentDetail, "server_time"> } | { refusal: DetailRefusal } {
  if (!validDetailId(agentId) || plain(parentPath) === null) return { refusal: "unavailable" };
  const sessionId = basename(parentPath, ".jsonl");
  const folder = sessionFolder(parentPath);
  if (typeof folder === "string") return { refusal: folder };
  try {
    const meta = openIn(folder, `agent-${agentId}.meta.json`, MAX_META_BYTES);
    if (typeof meta === "string") return { refusal: meta };
    // a read that fails, or a file moved or replaced while it was read, is a store not readable now; a meta file
    // being written says nothing of the agent yet, and one that names no agent type is no subagent's
    let bytes: Buffer;
    try { bytes = readAt(meta.fd, 0, meta.size); if (!stillThere(meta)) return { refusal: "unavailable" }; } catch { return { refusal: "unavailable" }; } finally { closeSync(meta.fd); }
    let record: Row | null;
    try { record = row(JSON.parse(bytes.toString("utf8"))); } catch { record = null; }
    if (record === null || text(record["agentType"]) === null) return { refusal: "not_found" };
    const file = openIn(folder, `agent-${agentId}.jsonl`);
    if (typeof file === "string") return { refusal: file };
    let read: ReturnType<typeof readDetailRecords>;
    try {
      read = readDetailRecords(file.fd, file.size, sessionId, agentId);
      if (!stillThere(file)) return { refusal: "unavailable" };
    } catch { return { refusal: "unavailable" }; } finally { closeSync(file.fd); }
    // a folder on the way replaced while it was read: what was read may be another folder's
    if (!intact(folder)) return { refusal: "unavailable" };
    if (read.foreign) return { refusal: "not_found" };
    const { prompt, events, truncated } = fitDetail(read.prompt, read.events, read.truncated);
    return {
      detail: {
        agent_id: agentId,
        session_id: sessionId,
        title: text(record["description"]) ?? text(record["name"]),
        agent: text(record["agentType"]),
        prompt,
        events,
        truncated,
        incomplete: read.incomplete,
        limits: DETAIL_LIMITS,
      },
    };
  } finally { if (folder.fd !== null) closeSync(folder.fd); }
}

/**
 * What a detail answers of what was read, within DETAIL_LIMITS: the newest max_events events, then the text budget, the
 * prompt first and the events newest first (an event that does not fit goes with every older one). `truncated` when
 * anything was left out here or before.
 */
export function fitDetail(prompt: string | null, events: DetailEvent[], truncated: boolean): { prompt: string | null; events: DetailEvent[]; truncated: boolean } {
  if (events.length > DETAIL_LIMITS.max_events) { events = events.slice(-DETAIL_LIMITS.max_events); truncated = true; }
  let left = DETAIL_LIMITS.max_output_bytes;
  if (prompt !== null && Buffer.byteLength(prompt, "utf8") > left) { prompt = cut(prompt, left); truncated = true; }
  if (prompt !== null) left -= Buffer.byteLength(prompt, "utf8");
  let first = events.length;
  while (first > 0) {
    const bytes = Buffer.byteLength(events[first - 1]!.text, "utf8");
    if (bytes > left) break;
    left -= bytes;
    first -= 1;
  }
  if (first > 0) { events = events.slice(first); truncated = true; }
  return { prompt, events, truncated };
}

/**
 * Whether the session's transcripts started `id` as a background command (a `Bash` call's
 * `backgroundTaskId`): the parent's, and those of its agents the scanner has read. A command has
 * no transcript of its own, whatever files bear its id.
 */
export function backgroundCommand(parentPath: string, id: string): boolean {
  if (scanParent(parentPath)?.commands.launches.has(id)) return true;
  const dir = `${subagentsDir(parentPath)}${sep}`;
  for (const [path, work] of works) if (path.startsWith(dir) && work.commands.launches.has(id)) return true;
  return false;
}

const time = (value: string | null): number => value === null ? 0 : Date.parse(value) || 0;

/**
 * A session's subagents: running ones first (oldest first), then up to ten that ended in the last
 * day (newest first), as OmO's list is. `live`: the pane still runs Claude on this session; one
 * that does not leaves what was running as lost, ended when last heard of. `since`: when the
 * Claude process there started, when known; an agent last written before it died with the
 * process before (a resumed session appends to the same files). `settled`: nothing was left
 * unread, so the same answer stands until a file changes. `behind`: an agent file was left unread
 * for the read budget while this call read on, so another call reads further.
 */
/** what each session's last read said of each agent: kept while the transcript is read in parts */
const previous = new Map<string, Map<string, OmoTask>>();

export function claudeSubagentState(parentPath: string, live: boolean, now = Date.now(), since: number | null = null, history?: HistoryEvidence | null): { tasks: OmoTask[]; historyNeeded: boolean; historyPending: boolean; settled: boolean; behind: boolean; watch: string[]; running: number; turnRunning: number; promptAt: number | null; resting: boolean } {
  const dir = subagentsDir(parentPath);
  // every file is read inside the folder listed, held open for the whole read (where the kernel names a descriptor's
  // file): a folder on the way swapped after the listing leads nowhere else. Elsewhere the look after the read stands for it
  using held = heldFolder(parentPath);
  const folder = held.folder;
  const inFolder = (name: string): string => folder === null ? join(dir, name) : folder.fd === null ? join(folder.path, name) : `${FD_DIR}/${folder.fd}/${name}`;
  const known = staleAgents.get(dir);
  const skip = staleFresh(known, now) ? known!.ids : null;
  const stale = new Set<string>();
  const files = agentIds(parentPath, folder).flatMap((id) => {
    if (skip?.has(id)) { stale.add(id); return []; }
    const stat = plain(inFolder(`agent-${id}.jsonl`));
    if (stat !== null && now - stat.mtimeMs > RECENT_MS) stale.add(id);
    return stat !== null && now - stat.mtimeMs <= RECENT_MS ? [{ id, mtimeMs: stat.mtimeMs, stat }] : [];
  }).sort((a, b) => Number(works.get(join(dir, `agent-${b.id}.jsonl`))?.hungry ?? false) - Number(works.get(join(dir, `agent-${a.id}.jsonl`))?.hungry ?? false) || b.mtimeMs - a.mtimeMs).slice(0, MAX_AGENTS);
  remember(staleAgents, dir, { at: skip !== null ? known!.at : now, ids: stale }, 256);
  // each has a budget of its own: a long transcript must not keep the agents from being read.
  // Read with no subagent too: the session's own background commands are in it
  const parent = scanParent(parentPath);
  if (parent === null && files.length === 0) return { tasks: [], historyNeeded: false, historyPending: false, settled: true, behind: false, watch: [], running: 0, turnRunning: 0, promptAt: null, resting: false };
  const budget = { left: READ_BUDGET };
  let behind = false;
  const running: OmoTask[] = [];
  const ended: OmoTask[] = [];
  const promptAt = parent?.promptAt ?? null;
  let turnRunning = 0;
  const all = new Map<string, OmoTask>();
  const sources: Commands[] = parent === null ? [] : [parent.commands];
  /** when each stopped agent's commands were stopped with it */
  const halts = new Map<Commands, number>();
  let settled = parent !== null && !parent.behind;
  for (const { id, stat } of files) {
    const meta = readMeta(join(dir, `agent-${id}.meta.json`), inFolder(`agent-${id}.meta.json`));
    const work = scanWork(join(dir, `agent-${id}.jsonl`), inFolder(`agent-${id}.jsonl`), budget);
    if (work?.behind) behind = true;
    if (work !== null) sources.push(work.commands);
    // a file caught while it is written says nothing yet, and what was worked out without it is not final
    if (meta === null || work === null) { settled = false; continue; }
    if (work.behind) settled = false;
    // its status from the end of its file, which no budget holds back; the whole file only when that tells nothing
    const tail = readTail(join(dir, `agent-${id}.jsonl`), inFolder(`agent-${id}.jsonl`), stat);
    const view = tail.known ? tail : work.behind ? null : work;
    // not told yet: neither running nor ended
    if (view === null) { settled = false; continue; }
    // what it did is counted from the whole file, and shown once it is
    const counted = !work.behind;
    const firstAt = tail.firstAt ?? work.firstAt;
    let status: OmoTask["status"] | null = null;
    let endedAt: number | null = null;
    // what ended it last: its notice, or the answer to its synchronous call
    const note = parent?.notes.get(id);
    const answer = meta.toolUseId !== null ? parent?.results.get(meta.toolUseId) : undefined;
    const told = note && (!answer || note.at >= answer.at) ? { at: note.at, status: note.status, turn: false } : answer ? { at: answer.at, status: answer.error ? "failed" as const : "completed" as const, turn: false } : null;
    // its own file can say it stopped (a teammate gets no notification, and a notice may not be written yet)
    const stopped = view.turnEndedAt !== null ? { at: view.turnEndedAt, status: "completed" as const, turn: true } : null;
    // TaskStop stopped it: by its id, or a teammate by its name, unless it was started or sent a message after
    // the newer of a stop by its id and one by its name: a stop, a message and a second stop leave it stopped
    const stopsAt = [parent?.stops.get(id), meta.name !== null ? parent?.stops.get(meta.name) : undefined].filter((at) => at !== undefined);
    const stopAt = stopsAt.length > 0 ? Math.max(...stopsAt) : undefined;
    // only once its start and its whole file are read: a teammate not read yet may be a new one or resumed
    const halted = stopAt !== undefined && firstAt !== null && firstAt <= stopAt && !work.behind && Math.max(tail.dispatchAt ?? 0, work.dispatchAt ?? 0) <= stopAt
      ? { at: stopAt, status: "cancelled" as const, turn: true } : null;
    const end = ([told, stopped, halted] as ({ at: number; status: OmoTask["status"]; turn: boolean } | null)[])
      .reduce((newest, next) => next !== null && (newest === null || next.at >= newest.at) ? next : newest, null);
    if (end === halted && halted !== null) halts.set(work.commands, halted.at);
    // an end older than the agent's last entry is from before it was resumed; its own last turn ended is that entry
    if (end && (end.turn || view.lastAt === null || view.lastAt <= end.at)) { status = end.status; endedAt = end.at; }
    else if (parent === null) continue;
    // the transcript is not read to its end: what an agent was last read as stands until it is
    else if (parent.behind) {
      const old = previous.get(parentPath)?.get(id);
      if (!old) continue;
      status = old.status === "lost" ? "running" : old.status;
      endedAt = status === "running" ? null : time(old.ended_at) || null;
    }
    // the part read starts after it went quiet: not known to run
    else if (parent.windowed && parent.firstAt !== null && (view.lastAt ?? 0) < parent.firstAt) continue;
    else status = "running";
    const orphan = status === "running" && since !== null && view.lastAt !== null && view.lastAt < since - START_SLACK_MS;
    const lost = status === "running" && (!live || orphan);
    const task: OmoTask = {
      id,
      title: meta.title ?? meta.agent ?? id,
      category: meta.agent,
      model: counted ? work.model : null,
      status: lost ? "lost" : status,
      started_at: iso(firstAt),
      ended_at: iso(status === "running" ? (lost ? view.lastAt : null) : endedAt),
      turns: counted ? work.turns : null,
      tool_calls: counted ? work.toolCalls : null,
      tokens: counted ? work.tokens : null,
      // its own transcript can be opened (backgroundAgentDetail); a command's output is a screen's, which is never read
      detail_kind: "claude-subagent",
    };
    keep(task, Math.max(tail.dispatchAt ?? 0, work.dispatchAt ?? 0, firstAt ?? 0));
  }
  // a folder on the way swapped while its files were read: what was read, and kept, may be another folder's, and an
  // agent found old there may be a recent one here
  if (folder !== null && !intact(folder)) {
    listings.delete(dir);
    staleAgents.delete(dir);
    for (const kept of [works, metas, tails]) for (const path of kept.keys()) if (path.startsWith(`${dir}${sep}`)) kept.delete(path);
    return { tasks: [], historyNeeded: false, historyPending: false, settled: false, behind: false, watch: [], running: 0, turnRunning: 0, promptAt: null, resting: false };
  }
  // every end any transcript was told of, by id. A launch ends at the first one after it, in
  // whichever transcript was told first: an end no later than it (one in its very millisecond too:
  // timestamps tie across transcripts, unless it names the very call that started it, or it was
  // written after the launch in the same transcript) is of an earlier command that had the same
  // id, and so is one naming another `Bash` call
  const ends = new Map<string, CommandTold[]>();
  const tell = (id: string, end: CommandTold) => { const told = ends.get(id); if (told) told.push(end); else ends.set(id, [end]); };
  for (const source of sources) for (const [id, told] of source.ends) for (const end of told) tell(id, { ...end, source });
  const endOf = (id: string, launch: { at: number; call: string | null; seq: number }, source: Commands) => {
    let first: CommandTold | undefined;
    for (const end of ends.get(id) ?? []) {
      const named = end.call !== null && launch.call !== null;
      const after = end.source === source && end.seq !== undefined && end.seq > launch.seq;
      if (end.at < launch.at || (named && end.call !== launch.call) || (end.at === launch.at && !named && !after)) continue;
      if (first === undefined || end.at < first.at) first = end;
    }
    return first;
  };
  const unresolved = () => sources.some((source) => [...source.launches].some(([id, launch]) => endOf(id, launch, source) === undefined && !(launch.at <= (halts.get(source) ?? -Infinity))));
  const historyNeeded = parent !== null && parent.windowed && unresolved();
  const needed = () => new Set(sources.flatMap((source) => [...source.launches].filter(([id, launch]) => endOf(id, launch, source) === undefined).map(([id]) => id)));
  const evidence = historyNeeded ? history === undefined ? commandHistory(parentPath, parent!.historyLimit, true, needed()) : history : null;
  // evidence of an earlier version (handed to a file thread, or read before this one) vouches for no
  // end until each one's line reads the same in the transcript as it is now
  const wanted = needed();
  const current = evidence !== null && parent !== null && evidence.version.size === parent.version.size && evidence.version.mtimeMs === parent.version.mtimeMs;
  const told = evidence === null || parent === null || !sameHistory(evidence.version, parent.version) ? null
    : current ? evidence.ends : vouchedEnds(parentPath, parent.version.id, evidence.ends.filter((end) => wanted.has(end.id)));
  const validEvidence = told !== null;
  if (told !== null) for (const end of told) tell(end.id, end);
  // only what is listed waits for it: a pane's queue and rest never do (holdsQueue, restsOn)
  const historyPending = historyNeeded && unresolved() && !(validEvidence && evidence!.complete && evidence!.through >= parent!.historyLimit);
  if (historyPending) settled = false;
  for (const source of sources) {
    for (const [id, launch] of source.launches) {
      if (all.has(id)) continue;
      const halt = halts.get(source);
      // a command an agent left running stops with the agent
      const end = endOf(id, launch, source) ?? (halt !== undefined && launch.at <= halt ? { at: halt, status: "cancelled" as const } : undefined);
      const lost = !live || (since !== null && launch.at < since - START_SLACK_MS);
      keep({ id, title: launch.title, category: "shell", model: null, status: end?.status ?? (lost ? "lost" : "running"), started_at: iso(launch.at), ended_at: iso(end?.at ?? null), turns: null, tool_calls: null, tokens: null, detail_kind: null });
    }
  }
  remember(previous, parentPath, all, 256);
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  // a command lost with its process has no end of its own: its start stands for it
  const last = (task: OmoTask): number => time(task.ended_at) || time(task.started_at);
  ended.sort((a, b) => last(b) - last(a));
  // read to its end only: a part not read yet may hold the next turn
  const resting = parent !== null && !parent.behind && parent.whole && parent.restAt !== null;
  return { tasks: [...running, ...ended.slice(0, RECENT_LIMIT)], historyNeeded, historyPending, settled, behind: behind && budget.left < READ_BUDGET, watch: files.map(({ id }) => id), running: running.length, turnRunning, promptAt, resting };

  function keep(task: OmoTask, dispatched = time(task.started_at)): void {
    all.set(task.id, task);
    if (task.status === "running") {
      running.push(task);
      if (promptAt === null || dispatched >= promptAt) turnRunning += 1;
    }
    else {
      const at = time(task.ended_at) || time(task.started_at);
      if (at !== 0 && now - at <= RECENT_MS) ended.push(task);
    }
  }
}

export const claudeSubagents = (parentPath: string, live: boolean, now = Date.now(), since: number | null = null): OmoTask[] => claudeSubagentState(parentPath, live, now, since).tasks;

/**
 * The list as a file thread gives it (`file-tasks.ts`): the thread's caches start cold, and it runs
 * off the event loop under the long-task deadline, so it reads on, a budget at a time, until neither
 * an agent file nor the transcript is left behind. Its first answer then has the counts a warm read
 * has. It reads on only while a pass read something, so the loop ends; and only until `until` (by
 * `clock`), so a huge session answers with what it read so far inside its deadline.
 */
export function wholeClaudeSubagents(parentPath: string, live: boolean, now = Date.now(), since: number | null = null, until = Infinity, clock: () => number = Date.now, history?: HistoryEvidence | null): OmoTask[] {
  for (;;) {
    const from = parents.get(parentPath)?.offset;
    const state = claudeSubagentState(parentPath, live, now, since, history);
    const parent = parents.get(parentPath);
    const parentBehind = parent !== undefined && parent.behind && parent.offset !== from;
    if (!(state.behind || parentBehind) || clock() >= until) return state.tasks;
  }
}

/** Forget every read kept between calls (tests compare against a cold read). */
export function forgetSubagents(): void {
  resetCommandHistory();
  parents.clear();
  metas.clear();
  works.clear();
  tails.clear();
  listings.clear();
  staleAgents.clear();
  previous.clear();
}

export interface ClaudeSubagentDeps {
  /** a Claude pane's transcript, and its Claude process (its pid and when it started); null while it has no transcript */
  resolve: (pane: HerdrPane) => Promise<{ path: string; startedAt: number | null; pid?: number | null } | null>;
  /** the pid of the pane's Claude process now: a restart under the same session id is another process */
  pid?: (pane: HerdrPane) => Promise<number | null>;
  /** Positive session/process replacement, never first discovery or a retry. Discard the old turn's transition evidence. */
  onReset?: (paneId: string) => void;
  /**
   * A pane's running subagents and background commands changed, or how many of them its turn
   * started (`turnRunning`, server/background-wait.ts), or whether the session's own turn rests
   * (`resting`): no turn started or ended as herdr reads it.
   */
  onChange: (paneId: string, running: number, turnRunning: number, promptAt: number | null, resting: boolean) => void;
  pollMs?: number;
  refreshMs?: number;
  now?: () => number;
}

/** `sig`: what the files looked like when the count was last worked out from them in full */
interface Tracked {
  /** Opaque lifetime of an asynchronous task-list read, renewed on a proven replacement. */
  read: number;
  key: string; path: string | null; startedAt: number | null; pid: number | null;
  /** when its transcript, and its process, were last looked for */
  at: number; pidAt: number;
  live: boolean; running: number; turnRunning: number; promptAt: number | null; resting: boolean; holding?: boolean; looping?: boolean; sig: string | null;
  /** the session's turn has rested since background work last ran: herdr's working from then is still that work's */
  restedOnWork?: boolean;
  reset?: boolean;
  /** the turns of the transcript read, and the busy signals matched to them */
  turns?: Turns;
  /** the transcript's size when herdr's event last said the pane does no work: a turn herdr tells after it began past it */
  quiet?: { path: string; id: string; size: number };
  /** every observed agent, whose own file can end or resume its turn */
  watch: string[];
}

/** Unique across trackers too: several servers in one process share the file worker pool. */
let taskReadSequence = 0;

/**
 * What says a Claude pane's session may have begun a turn its transcript does not show yet: herdr
 * reading it as working, or the chat sending it a prompt. Each is matched on its own, so that one
 * turn told by both is still one turn.
 */
export type BusySource = "herdr" | "chat";

/**
 * A busy signal, and what places its turn in the transcript: for a chat send, when its Enter was
 * sent (`sentAt`; Claude dates the entry it writes for it no earlier); for herdr's, the
 * transcript's size at herdr's last word that the pane did no work (`quiet`).
 */
interface Signal { source: BusySource; at: number; sentAt?: number; quiet?: { id: string; size: number } }

/** A signal whose turn is not written yet: the first one begun past `size` is its own. */
interface Barrier { size: number; at: number }

/**
 * How long a signal holds the pane shown working while its turn is not written. Claude writes a
 * turn's first entry as the turn begins, so one that has none by then most likely began no turn (a
 * message taken into a turn already at work, a status herdr repeated). Most likely is no proof:
 * the queue stays held on it (`held`) until a rest is written past it or herdr says the pane does
 * no work.
 */
const BUSY_HOLD_MS = 5000;

/**
 * The start of the latest turn a source's signals were matched to, its signals still waiting for
 * theirs, and those that waited BUSY_HOLD_MS in vain (`held`): they hold the queue, not the display.
 */
interface Claim { turn: number; barriers: Barrier[]; held: Barrier[] }

/**
 * How long a turn Claude resumed by itself (a `/loop` wakeup's, another scheduled task's) holds the
 * pane's queue while no rest is written after it (#3494). Claude resumes it as the task fires, with no
 * prompt of the person's nor a send of the chat's, and herdr reads that turn a moment later: queued
 * input sent in between would land in the turn at work. A turn that writes no rest (interrupted, on a
 * Claude Code that writes none for it; its process killed) is waited on no longer than this.
 */
export const LOOP_HOLD_MS = 60_000;

/**
 * The latest fire or self-resumed prompt the pane took account of (`fire`, its byte boundary:
 * Parent.loopAt), and since when it holds the queue (`since`). null: it holds nothing, as a rest
 * was written past it, or the transcript's first read found it written LOOP_HOLD_MS ago or longer
 * (history: its turn may have been interrupted long ago). One found at any other boundary is another
 * one, wherever that stands: a transcript rewritten in place keeps no boundary of the read before.
 */
interface Loop { fire: number; since: number | null }

/**
 * Since when a fire found written at a transcript's first read (the server started, or the pane's
 * session was found late) holds the queue: from when it was written, by its own timestamp, so for
 * what is left of LOOP_HOLD_MS. Its turn may run now, as for a fire read later. One that old
 * already, or telling no time, is history (null); one dated ahead of this clock holds from now,
 * so never longer than LOOP_HOLD_MS.
 */
const foundFiring = (written: number | null, now: number): number | null => written !== null && now - written < LOOP_HOLD_MS ? Math.min(written, now) : null;

/**
 * A transcript's turns as the busy signals have them (#2072). A rest certifies a pane at rest only
 * when no signal waits for its turn. `retired`: the start of the latest turn a poll saw at rest,
 * which a later signal with nothing to place it is never matched to.
 */
interface Turns { readonly path: string; readonly id: string; retired: number; herdr: Claim; chat: Claim; loop: Loop }

/**
 * The running subagents and background commands of every Claude pane, for the pane's count. Only a pane whose agent is
 * `claude` is looked at (an OmO pane is named `omo` by then, any other agent is not Claude's):
 * its transcript is found once per session, and polled for what changed since. A pane that is
 * not Claude any more keeps the transcript it had, so that its list can say what was left
 * running there is lost; its count is 0. A poll that finds the folder, parent transcript and
 * watched agent files as they were reads nothing. An agent's own file can end or resume it.
 */
export class ClaudeSubagentStatus {
  private historyWatches = new Map<string, () => void>();
  private readonly panes = new Map<string, Tracked>();
  /** Identity observations precede async resolution, including snapshots queued behind a lookup. */
  private readonly sessions = new Map<string, string | null>();
  /** The latest lookup claim; a newer pane/session observation cancels an older answer. */
  private readonly lookups = new Map<string, { key: string }>();
  /** busy signals heard before the pane's transcript was read: matched at its first read */
  private readonly deferred = new Map<string, Signal[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** stopped: nothing is read any more, by a watch heard late or a lookup that answers after */
  private stopped = false;
  private refreshing: Promise<void> | null = null;
  private queued: HerdrPane[] | null = null;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly deps: ClaudeSubagentDeps) {
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? 5000;
  }

  start(): void {
    this.stopped = false;
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const release of this.historyWatches.values()) release();
    this.historyWatches.clear();
    this.lookups.clear();
    this.sessions.clear();
    this.deferred.clear();
    this.queued = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  /** Signals that waited for their turn in vain hold the pane's queue: nothing proves they began no turn. */
  holdsQueue(paneId: string): boolean {
    const turns = this.panes.get(paneId)?.turns;
    return turns !== undefined && turns.herdr.held.length + turns.chat.held.length > 0;
  }

  /**
   * Claude resumed a turn by itself (a `/loop` wakeup, a scheduled task) and no rest was written since:
   * the pane's queue holds. Until that turn's rest is written, or LOOP_HOLD_MS after the last entry that
   * told of it was read (a later fire or prompt holds anew). No word of herdr's ends it: herdr reads the
   * pane at rest until it reads the turn, and its working may be a late one for the turn before, or
   * heard while a delivery is at its last checks. So a resumed turn that is interrupted and writes no
   * rest holds the queue until that time is up, though herdr reads the pane at rest again.
   */
  loopHolds(paneId: string): boolean {
    const since = this.panes.get(paneId)?.turns?.loop.since ?? null;
    return since !== null && this.now() - since < LOOP_HOLD_MS;
  }

  /**
   * loopHolds as the pane's last poll found it, and told of it (onChange). A caller that kept that
   * telling back (a pane that settles) compares it across the poll.
   */
  loopTold(paneId: string): boolean {
    return this.panes.get(paneId)?.looping ?? false;
  }

  /**
   * loopHolds as the pane's transcript says now: what was appended since the pane's last poll is read
   * first, as a task may have fired since, or the resumed turn come to rest. A hold that read finds
   * begun or ended, or one whose time ran out untold, is a poll's to take account of, made at once: it
   * tells of it as any poll does (onChange). So is a fire in another file found in the transcript's
   * place: the poll begins the pane's turns anew from that file, and weighs the fire by its own age.
   * With no such change nothing more is read and nothing is told: the pane's counts, its turns and
   * its busy signals stay as its last poll left them. A pane whose transcript is not found, or not
   * read yet, has none to read: nothing holds it until then. Nor is anything read of a pane that
   * left Claude, or once the tracker stopped: what its last poll found stands, for its time.
   */
  loopHoldsNow(paneId: string): boolean {
    const tracked = this.panes.get(paneId);
    const turns = !this.stopped && tracked?.path != null && tracked.live && tracked.turns?.path === tracked.path ? tracked.turns : undefined;
    const parent = turns ? scanParent(turns.path) : null;
    if (tracked && turns && parent) {
      // what the file tells of a self-resumed turn is not what the pane's turns have: none any more, or one that is
      // not the one they took account of, in another place or in another file
      const changed = parent.loopAt === null ? turns.loop.since !== null : parent.id !== turns.id || parent.loopAt !== turns.loop.fire;
      // that poll reads the transcript: the file changed since its signature was certified, or none was, as
      // a poll that finds a hold standing certifies none (poll)
      if (changed || this.loopHolds(paneId) !== (tracked.looping ?? false)) this.poll(paneId);
    }
    return this.loopHolds(paneId);
  }

  /**
   * The session's own turn ended while subagents or commands still run: Claude keeps its busy
   * title up while a background subagent works, and herdr reads that as `working` (#2069). The
   * last of that work ending keeps the rest until a turn begins: herdr's working may be from before.
   */
  restsOn(paneId: string): boolean {
    const tracked = this.panes.get(paneId);
    return tracked !== undefined && tracked.resting && (tracked.running > 0 || tracked.restedOnWork === true);
  }

  /**
   * The pane's session may have begun a turn: herdr reads it as working, or the chat sent it a
   * prompt (`sentAt`: when its Enter was sent). Claude writes a turn's prompt to its transcript as
   * the turn begins, but a signal can come before that entry or after the whole turn. The
   * transcript is read first, and the signal matched to a turn in it (match); one with none written
   * yet holds the pane working until its turn is, for BUSY_HOLD_MS at most.
   */
  busy(paneId: string, source: BusySource, sentAt?: number): void {
    const tracked = this.panes.get(paneId);
    const signal: Signal = { source, at: this.now(), ...(sentAt !== undefined ? { sentAt } : {}) };
    if (source === "herdr" && tracked) {
      if (tracked.quiet && tracked.quiet.path === tracked.path) signal.quiet = { id: tracked.quiet.id, size: tracked.quiet.size };
      delete tracked.quiet;
    }
    const turns = tracked?.path != null && tracked.live && tracked.turns?.path === tracked.path ? tracked.turns : undefined;
    const size = turns ? plain(turns.path) : null;
    // the signal's own read, ahead of the poll that would take a turn it finds at rest for history
    const parent = turns && size?.id === turns.id ? scanParent(turns.path) : null;
    if (turns && parent?.id === turns.id) match(turns, parent, signal, size!.size);
    // a pane whose transcript is not found yet keeps its latest signals, not every one
    else this.deferred.set(paneId, [...(this.deferred.get(paneId) ?? []).slice(-15), signal]);
    if (!tracked) return;
    tracked.sig = null;
    this.poll(paneId);
  }

  /**
   * herdr says the pane does no work: its own signals holding the queue began nothing that still runs.
   * Said in an event (`event`), a turn it tells of next begins in what is written after now.
   */
  quiet(paneId: string, event: boolean): void {
    const tracked = this.panes.get(paneId);
    if (!tracked) return;
    // a chat send's is the transcript's to release: Claude may write its prompt late (a slow
    // UserPromptSubmit hook) while its title shows no work
    if (tracked.turns && tracked.turns.herdr.held.length > 0) {
      tracked.turns.herdr.held = [];
      // the next poll tells of the queue let go, though no file changed
      tracked.sig = null;
    }
    if (!event) return;
    const stat = tracked.path !== null && tracked.live ? plain(tracked.path) : null;
    if (stat !== null && tracked.path !== null) tracked.quiet = { path: tracked.path, id: stat.id, size: stat.size };
    else delete tracked.quiet;
  }

  /** The transcript of the Claude session the pane holds, or last held, whether it still runs Claude, and when that process started. */
  sessionOf(paneId: string): { path: string; live: boolean; startedAt: number | null; read?: number } | null {
    const tracked = this.panes.get(paneId);
    return tracked?.path ? { path: tracked.path, live: tracked.live, startedAt: tracked.startedAt, read: tracked.read } : null;
  }

  /** Finds the Claude panes of a snapshot and their transcripts; a lookup costs process calls, so a known one is not repeated. */
  refresh(panes: HerdrPane[]): Promise<void> {
    const ids = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of this.panes.keys()) if (!ids.has(paneId)) this.panes.delete(paneId);
    for (const paneId of this.lookups.keys()) if (!ids.has(paneId)) this.lookups.delete(paneId);
    for (const paneId of this.sessions.keys()) if (!ids.has(paneId)) this.sessions.delete(paneId);
    for (const paneId of this.deferred.keys()) if (!ids.has(paneId)) this.deferred.delete(paneId);
    for (const [path, release] of this.historyWatches) {
      if (![...this.panes.values()].some((pane) => pane.path === path && pane.live)) { release(); this.historyWatches.delete(path); }
    }
    for (const pane of panes) {
      this.observeSession(pane);
      const key = `${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
      if (pane.agent !== "claude" || this.lookups.get(pane.pane_id)?.key !== key) this.lookups.delete(pane.pane_id);
      if (pane.agent !== "claude") {
        const tracked = this.panes.get(pane.pane_id);
        if (tracked) tracked.live = false;
      }
    }
    if (this.refreshing) { this.queued = panes; return this.refreshing; }
    this.refreshing = (async () => {
      try {
        for (let next: HerdrPane[] | null = panes; next !== null; next = this.queued) {
          this.queued = null;
          await Promise.all(next.map((pane) => this.ensure(pane)));
          this.poll();
        }
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  /** One pane's transcript, looked up now if it is not known (or not known to be this session's). */
  async ensure(pane: HerdrPane): Promise<void> {
    this.observeSession(pane);
    const tracked = this.panes.get(pane.pane_id);
    if (pane.agent !== "claude") {
      this.lookups.delete(pane.pane_id);
      if (tracked) tracked.live = false;
      return;
    }
    // a session known by its id is looked up when it changes; one found by process only, now and then
    const session = pane.agent_session?.value ?? "";
    const key = `${session}\0${pane.cwd ?? ""}`;
    const claim = { key };
    this.lookups.set(pane.pane_id, claim);
    const due = !tracked || tracked.key !== key || !tracked.live || tracked.path === null || (session === "" && this.now() - tracked.at >= 6 * this.refreshMs);
    let again = due;
    // Retry incomplete process identity too: a transient lookup failure is not a permanent boundary.
    if (!due && tracked && this.now() - tracked.pidAt >= this.refreshMs) {
      tracked.pidAt = this.now();
      const pid = this.deps.pid ? await this.deps.pid(pane).catch(() => null) : null;
      if (this.lookups.get(pane.pane_id) !== claim) return;
      again = tracked.startedAt === null || tracked.pid === null || (pid !== null && pid !== tracked.pid);
    }
    if (!again) return;
    if (tracked && tracked.key === key && tracked.path === null && this.now() - tracked.at < this.refreshMs) return;
    const found = await this.deps.resolve(pane).catch(() => null);
    if (this.lookups.get(pane.pane_id) !== claim) return;
    const current = this.panes.get(pane.pane_id);
    const same = current?.key === key;
    // the same transcript of the same process under another key (its cwd changed, or its session id became known): the same lifetime
    const sameLife = current !== undefined && (same || (!!found && current.path === found.path));
    const reset = !!(found && current && ((current.path !== null && current.path !== found.path)
      || (current.pid !== null && found.pid != null && current.pid !== found.pid)
      || (current.startedAt !== null && found.startedAt !== null && current.startedAt !== found.startedAt)));
    if (reset) this.deps.onReset?.(pane.pane_id);
    // another process's transcript: what it holds is that process's, and a rest in it ends no turn of this one
    if (reset && found) this.deferred.set(pane.pane_id, [...this.deferred.get(pane.pane_id) ?? [], { source: "herdr", at: this.now() }]);
    // the count it had goes on from here: another session with none says so at the next poll
    // so does what was told of a self-resumed turn's hold: one that ran out meanwhile is told at the next poll, as no status event may be
    this.panes.set(pane.pane_id, { read: same && !reset ? current.read : ++taskReadSequence, key, path: found?.path ?? (same ? current.path : null), startedAt: found ? found.startedAt : same ? current.startedAt : null, pid: found ? found.pid ?? null : same ? current.pid : null, at: this.now(), pidAt: this.now(), live: true, running: current?.running ?? 0, turnRunning: current?.turnRunning ?? 0, promptAt: current?.promptAt ?? null, resting: current?.resting ?? false, looping: current?.looping, restedOnWork: sameLife && !reset ? current.restedOnWork : false, turns: reset ? undefined : current?.turns, sig: null, watch: same && !found ? current.watch : [], reset });
  }

  private observeSession(pane: HerdrPane): void {
    const previous = this.sessions.get(pane.pane_id);
    const session = pane.agent === "claude" ? pane.agent_session?.value ?? "" : null;
    // Missing hook identity becoming known (or a cwd change) is not a new lifetime.
    const replaced = previous !== undefined && previous !== session
      && (previous === null || session === null || (previous !== "" && session !== ""));
    this.sessions.set(pane.pane_id, session === "" && previous != null ? previous : session);
    if (!replaced) return;
    this.lookups.delete(pane.pane_id);
    this.deps.onReset?.(pane.pane_id);
    const tracked = this.panes.get(pane.pane_id);
    if (!tracked) return;
    tracked.read = ++taskReadSequence;
    tracked.live = false;
    tracked.reset = true;
    tracked.restedOnWork = false;
    // Leaving Claude retains the old transcript for the lost-task list, but a new Claude session cannot read it.
    if (session !== null) {
      tracked.path = null;
      tracked.startedAt = null;
      tracked.pid = null;
      tracked.at = -Infinity;
      tracked.watch = [];
      tracked.sig = null;
    }
    this.poll(pane.pane_id);
  }

  /** Reads what the files gained, of every pane or of one (a turn just ended there); a pane whose counts changed is told. */
  poll(only?: string): void {
    if (this.stopped) return;
    for (const [paneId, tracked] of this.panes) {
      if (only !== undefined && paneId !== only) continue;
      let running = 0;
      let turnRunning = 0;
      let promptAt: number | null = null;
      let resting = false;
      if (tracked.path !== null && tracked.live) {
        const scanAt = this.now();
        const before = subagentsSignature(tracked.path, tracked.watch, scanAt);
        if (`${before.sig}:${tracked.startedAt}` === tracked.sig) continue;
        const state = claudeSubagentState(tracked.path, true, this.now(), tracked.startedAt);
        ({ running, turnRunning, promptAt, resting } = state);
        // watched while it is needed, even once read: a check of what was read may yet take an end back
        if (!state.historyNeeded) { this.historyWatches.get(tracked.path)?.(); this.historyWatches.delete(tracked.path); }
        // a watch the history's session cap refused is asked for again at the next poll
        else if (!this.historyWatches.has(tracked.path)) {
          const path = tracked.path;
          const release = watchCommandHistory(path, () => {
            this.historyWatches.get(path)?.();
            this.historyWatches.delete(path);
            for (const pane of this.panes.values()) if (pane.path === path) pane.sig = null;
            this.poll();
          });
          if (release !== null) this.historyWatches.set(path, release);
        }
        const parent = parents.get(tracked.path);
        let waiting = false;
        if (parent === undefined) resting = false;
        else {
          const known = tracked.turns;
          const turns = this.turnsOf(paneId, tracked.path, parent);
          settle(turns, parent, this.now());
          // a fire or a self-resumed prompt written since the read before holds the queue from now, whatever herdr
          // said or says of the pane; a rest written past it ends that. One the transcript's first read finds
          // written holds by its own age (foundFiring). Any that is not the one last taken account of is one written
          // since: it stands past that one, or anywhere in a transcript rewritten in place
          if (parent.loopAt === null) turns.loop.since = null;
          else if (parent.loopAt !== turns.loop.fire) turns.loop = { fire: parent.loopAt, since: turns === known ? this.now() : foundFiring(parent.loopTime, this.now()) };
          // a turn seen at rest is history: a later signal with nothing to place it is not its own
          const latest = turnAt(parent);
          if (resting && latest !== null) turns.retired = Math.max(turns.retired, latest);
          // a signal whose turn is not written yet: no rest written so far ends that turn
          waiting = turns.herdr.barriers.length + turns.chat.barriers.length > 0;
          resting &&= !waiting;
        }
        tracked.watch = state.watch;
        const after = subagentsSignature(tracked.path, tracked.watch, this.now());
        // Certify only the versions and dependency set read, never a concurrent append's newer signature.
        // Coarse file clocks require every input to have been quiet before the scan began. A signal
        // waiting for its turn is read again at each poll, until the turn is written or it gives up;
        // so is a self-resumed turn holding the queue, whose time runs out with nothing written
        tracked.sig = !waiting && !this.loopHolds(paneId) && state.settled && before.sig === after.sig && scanAt - before.latestMs >= 1000
          ? `${after.sig}:${tracked.startedAt}` : null;
      }
      // a held queue let go of (a rest written past it) is told too, though the pane rested all along
      const holding = this.holdsQueue(paneId);
      const looping = this.loopHolds(paneId);
      if (!tracked.reset && running === tracked.running && turnRunning === tracked.turnRunning && promptAt === tracked.promptAt && resting === tracked.resting && holding === (tracked.holding ?? false) && looping === (tracked.looping ?? false)) continue;
      tracked.holding = holding;
      tracked.looping = looping;
      // the last of its work ending keeps the rest: herdr's working may be the busy title it had, said before
      // that work ended, until a turn begins (a busy signal, or one written) and the rest is gone
      // read together with its rest, the last of that work ending keeps it too: the rest and the end came before this read
      tracked.restedOnWork = resting && (running > 0 || (!tracked.reset && (tracked.running > 0 || (tracked.resting && tracked.restedOnWork === true))));
      tracked.reset = false;
      tracked.running = running;
      tracked.turnRunning = turnRunning;
      tracked.promptAt = promptAt;
      tracked.resting = resting;
      this.deps.onChange(paneId, running, turnRunning, promptAt, resting);
    }
  }

  /**
   * The pane's turns in the transcript just read, begun at its first read: what that read found at
   * rest is history, and the signals heard before it are matched against what it found.
   */
  private turnsOf(paneId: string, path: string, parent: Parent): Turns {
    const tracked = this.panes.get(paneId)!;
    if (tracked.turns?.path === path && tracked.turns.id === parent.id) return tracked.turns;
    // a fire or a self-resumed prompt this first read finds written is the poll's to weigh (foundFiring)
    const turns: Turns = { path, id: parent.id, retired: -1, herdr: { turn: -1, barriers: [], held: [] }, chat: { turn: -1, barriers: [], held: [] }, loop: { fire: -1, since: null } };
    if (parent.restAt !== null) turns.retired = turnAt(parent) ?? -1;
    for (const signal of this.deferred.get(paneId) ?? []) match(turns, parent, signal, parent.offset);
    this.deferred.delete(paneId);
    tracked.turns = turns;
    return turns;
  }
}

/** The turns (for a chat signal, also the messages taken into one at work) a source's signal can be matched to. */
const startsFor = (parent: Parent, source: BusySource): Start[] => source === "chat" ? parent.starts : parent.starts.filter((start) => start.turn);

/**
 * A busy signal, read against the transcript as `parent` has it (ClaudeSubagentStatus.busy). The
 * signals waiting before it take their turns first. Then a turn it can be placed in is its own:
 * for a chat send, the first begun since its Enter; for herdr's, the first begun past herdr's last
 * word that the pane did no work; with nothing to place it, the turn going on if no signal told
 * it (for a chat send with no time, the latest no signal told and no poll saw at rest). Otherwise
 * its turn is not written yet, and it waits for it.
 */
function match(turns: Turns, parent: Parent, signal: Signal, size: number): void {
  settle(turns, parent, null);
  const claim = turns[signal.source];
  const other = turns[signal.source === "herdr" ? "chat" : "herdr"];
  const starts = startsFor(parent, signal.source);
  let start: Start | undefined;
  if (claim.barriers.length === 0) {
    if (signal.sentAt !== undefined) start = starts.find((each) => each.end > claim.turn && each.at !== null && each.at >= signal.sentAt!);
    else if (signal.quiet?.id === parent.id) start = starts.find((each) => each.end > Math.max(claim.turn, signal.quiet!.size));
    else {
      const floor = Math.max(claim.turn, turns.retired, other.turn);
      // herdr's working with nothing to place it may be the next turn's, before its first entry: a
      // turn already at rest is not taken for it, unseen by a poll or not. A chat send's time is
      // always known where it is sent; without it, the latest turn no signal told is the send's
      if (signal.source === "chat") start = lastStart(starts, (each) => each.end > floor);
      else if (parent.turnOpen) start = lastStart(starts, (each) => each.turn && each.end > floor && each.end === turnAt(parent));
    }
  }
  if (start !== undefined) claim.turn = start.end;
  else claim.barriers.push({ size, at: signal.at });
}

/** Each waiting signal takes the first turn begun past it; one that waited BUSY_HOLD_MS began none (`now`). */
function settle(turns: Turns, parent: Parent, now: number | null): void {
  for (const source of ["herdr", "chat"] as const) {
    const claim = turns[source];
    for (let barrier = claim.barriers[0]; barrier !== undefined; barrier = claim.barriers[0]) {
      const floor = Math.max(barrier.size, claim.turn);
      const start = startsFor(parent, source).find((each) => each.end > floor);
      if (start === undefined) break;
      claim.turn = start.end;
      claim.barriers.shift();
    }
    if (now !== null) {
      claim.held.push(...claim.barriers.filter((barrier) => now - barrier.at >= BUSY_HOLD_MS));
      claim.barriers = claim.barriers.filter((barrier) => now - barrier.at < BUSY_HOLD_MS);
    }
    // a rest written past a held signal ends whatever turn it began; for a chat send, so does its
    // own entry written late (a bash-mode line), past which the turn, if any, shows open
    claim.held = claim.held.filter((barrier) => (parent.restAt === null || parent.restAt <= barrier.size)
      && !(source === "chat" && parent.starts.some((start) => start.end > barrier.size)));
  }
}

/** Waits for `work`, but not longer than `ms`: what a slow lookup finds is there for the next ask. */
export async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}
