/**
 * OpenCode 2 keeps every session in one SQLite database, written by its background service
 * (`opencode serve --service`) rather than by the TUI in the pane: `<data dir>/opencode.db`, the
 * data dir being `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` (on macOS too), and
 * `OPENCODE_DB` naming another file, relative to the data dir (what `opencode debug paths` prints).
 * The service is started with the user's environment, so this server's environment finds it; the
 * pane's process environment would not. A session is a `session_v2` row and its conversation the
 * `session_message` rows of its id, ordered by `seq`, each a `type` and a JSON `data`. OpenCode 1.x
 * wrote `session`/`message`/`part` instead (2.0 copies them into `session_v2` when it migrates).
 *
 * herdr's OpenCode integration reports the session the TUI shows (`herdr:opencode`, kind `id`),
 * so a pane is bound by that id, never by a guess from its cwd.
 *
 * A row is rewritten in place while its step streams (`time_updated` moves). `/undo` hides the
 * rows from a message on (`session_v2.revert`) until the next prompt deletes them. `seq` is never
 * handed out again: a row's `seq` is its event's sequence number, which `Bus.publish` takes as
 * `event_sequence.seq + 1` under a per-session lock and `Bus.reserveSequence` only raises, and the
 * revert commit deletes `session_message` rows without touching `event_sequence` (read from 2.0.24).
 */

import { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane, SkillActivity } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processStartIdentity, processStartLowerBound } from "./process-start.ts";
import { opencodeSkillInvocation } from "./skill-invocations/opencode.ts";
import { opencodeStartScreenUnused } from "./start-screen.ts";
import { trimOutput } from "./tool-output.ts";
import { MAX_TURNS, OMO_TASK_RESULT_MAX, toolSummary } from "./transcript-records.ts";

const MAX_PAGE_PROMPTS = MAX_TURNS / 2;
export const OPENCODE_WINDOW_BYTES = 16 * 1024 * 1024;
const NOTICE_CHARS = 16_000;
const BUSY_TIMEOUT_MS = 250;

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9]{1,64}$/;
export const OPENCODE_TOOL_REF = /^(msg_[A-Za-z0-9]{1,64}):(\d{1,4})$/;
export const OPENCODE_IMAGE_REF = /^opencode:(msg_[A-Za-z0-9]{1,64}):(\d{1,3})$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const iso = (value: unknown): string | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
const skillName = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value) ? value : null;
const cut = (value: string): string => value.length > NOTICE_CHARS ? `${value.slice(0, NOTICE_CHARS)}\n… trimmed` : value;

export function opencodeDatabasePath(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  const named = env["OPENCODE_DB"];
  if (named === ":memory:") return null;
  const data = join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
  return named ? resolve(data, named) : join(data, "opencode.db");
}

export function opencodeSessionId(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  if (session?.agent !== "opencode" || session.source !== "herdr:opencode" || session.kind !== "id" || !SESSION_ID.test(session.value)) return null;
  return session.value;
}

/** Flags an OpenCode TUI may be started with and still open no session; any other (`-c`, `-s`, `--prompt`, `--server`) may open one. */
const NO_SESSION_FLAGS = new Set(["--standalone", "--auto", "--print-logs"]);

function noSessionFolder(argv: readonly string[] | null | undefined, cwd: string | null | undefined): string | null {
  // after the program itself: a launcher script runs under its shell (`sh …/opencode`)
  const program = argv?.findIndex((word) => basename(word) === "opencode") ?? -1;
  if (program < 0 || !cwd) return null;
  let folder: string | null = null;
  for (let index = program + 1; index < argv!.length; index++) {
    const word = argv![index]!;
    if (NO_SESSION_FLAGS.has(word) || word.startsWith("--log-level=")) continue;
    if (word === "--log-level" && index + 1 < argv!.length) { index++; continue; }
    if (word.startsWith("-") || folder !== null) return null;
    folder = resolve(cwd, word);
    try { if (!statSync(folder).isDirectory()) return null; } catch { return null; }
  }
  return folder ?? cwd;
}

async function noSessionProcesses(paneId: string): Promise<{ pid: number; identity: number; folder: string }[] | null> {
  const foreground = (await paneProcessInfo(paneId))?.foreground_processes ?? [];
  const found: { pid: number; identity: number; folder: string }[] = [];
  for (const entry of foreground.filter((candidate) => candidate.name === "opencode")) {
    const folder = noSessionFolder(entry.argv, entry.cwd);
    const identity = Number.isSafeInteger(entry.pid) && entry.pid > 1 ? processStartIdentity(entry.pid) : null;
    if (folder === null || identity === null) return null;
    found.push({ pid: entry.pid, identity, folder });
  }
  return found.length === 0 ? null : found.sort((a, b) => a.pid - b.pid);
}

/**
 * herdr reports no session for an OpenCode at its home screen: its integration names one from the
 * first prompt on (#3600). `--session` opens the home screen too for an id the store does not hold yet.
 */
export async function opencodeFreshSession(pane: Pick<HerdrPane, "pane_id" | "cwd">, screen: string, store: string | null): Promise<string | null> {
  if (store === null || !opencodeStartScreenUnused(screen)) return null;
  try {
    const processes = await noSessionProcesses(pane.pane_id);
    if (processes === null) return null;
    const starts = processes.map((entry) => processStartLowerBound(entry.pid));
    if (starts.some((started) => started === null)) return null;
    const folders = [...new Set([pane.cwd, ...processes.map((entry) => entry.folder)].filter((folder): folder is string => typeof folder === "string" && folder !== "").flatMap((folder) => {
      try { return [folder, realpathSync(folder)]; } catch { return [folder]; }
    }))];
    if (statSync(store, { throwIfNoEntry: false }) !== undefined) {
      const begun = withStore(store, (db) => db.query<unknown, (string | number)[]>(
        `SELECT 1 FROM session_v2 WHERE directory IN (${folders.map(() => "?").join(", ")}) AND time_created >= ? LIMIT 1`,
      ).get(...folders, Math.min(...(starts as number[]))) !== null);
      if (begun !== false) return null;
    }
    const key = (list: { pid: number; identity: number }[]) => list.map((entry) => `${entry.pid}:${entry.identity}`).join(",");
    const again = await noSessionProcesses(pane.pane_id);
    return again !== null && key(again) === key(processes) ? `unwritten:opencode:${pane.pane_id}:${key(processes)}` : null;
  } catch { return null; }
}

export type OpencodeRecord =
  | { role: "user"; ts: string | null; parts: ConversationPart[] }
  | { role: "assistant"; ts: string | null; end: string | null; parts: ConversationPart[]; stop: boolean }
  | { role: "idle" };

/** The images a row carries, in the order its refs count them. Only inline data: a path is never followed. */
function rowImages(type: string, data: Row): { media_type: string; data: string }[] {
  const images: { media_type: string; data: string }[] = [];
  const add = (value: unknown) => {
    const file = record(value);
    const uri = typeof file.uri === "string" ? /^data:([\w.+/-]+);base64,(.*)$/s.exec(file.uri) : null;
    const type = uri?.[1] ?? file.mime;
    const base64 = uri?.[2] ?? (record(file.source).type === "inline" ? file.data : undefined);
    if (typeof type === "string" && IMAGE_TYPES.has(type) && typeof base64 === "string" && base64.length > 0) images.push({ media_type: type, data: base64 });
  };
  if (type === "user") (Array.isArray(data.files) ? data.files : []).forEach(add);
  if (type === "assistant") {
    for (const block of (Array.isArray(data.content) ? data.content : []).map(record)) {
      if (block.type !== "tool") continue;
      for (const item of (Array.isArray(record(block.state).content) ? record(block.state).content as unknown[] : []).map(record)) if (item.type === "file") add(item);
    }
  }
  return images;
}

function toolText(state: Row, name: string): string {
  if (state.status === "error") return text(record(state.error).message) ?? "";
  const output = (Array.isArray(state.content) ? state.content : []).map(record)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string).join("\n");
  return name === "subagent" ? unwrap(output) : output;
}

/**
 * A call's `state.status` as the transcript's outcome (shared/protocol.ts): not answered yet (1.x `pending`,
 * 2.x `streaming` while the model still writes its input, then `running`), answered, or failed.
 */
function toolState(status: unknown): Extract<ConversationPart, { kind: "tool" }>["state"] {
  return status === "pending" || status === "streaming" || status === "running" ? "pending" : status === "completed" ? "ok" : status === "error" ? "error" : undefined;
}

/** OpenCode's `skill` tool names the skill it loads by `id` (1.x: `name`). */
function toolSkill(name: string, input: Row, status: unknown): SkillActivity | null {
  if (name !== "skill") return null;
  const skill = skillName(input.id) ?? skillName(input.name);
  if (skill === null) return null;
  return { name: skill, evidence: "invocation", status: status === "completed" ? "loaded" : status === "error" ? "failed" : "requested" };
}

/** `<shell …>…</shell>` and `<subagent …>…</subagent>` wrap what OpenCode hands back to its model. */
function unwrap(body: string): string {
  const match = /^<(shell|subagent)\b[^>]*>\n?([\s\S]*?)\n*<\/\1>\s*$/.exec(body.trim());
  return (match?.[2] ?? body).trim();
}

export function opencodeRecord(id: string, type: string, data: Row): OpencodeRecord | null {
  const time = record(data.time);
  if (type === "user") {
    const images = rowImages(type, data).map((image, index): ConversationPart => ({ kind: "image", media_type: image.media_type, ref: `opencode:${id}:${index}` }));
    const display = text(record(data.metadata).displayText);
    const raw = text(data.text);
    const prompt = display ?? (raw === null ? null : opencodeSkillInvocation(raw));
    const skills = (Array.isArray(data.skills) ? data.skills : []).map(record).flatMap((skill): ConversationPart[] => {
      const name = skillName(skill.name) ?? skillName(skill.id);
      return name === null ? [] : [{ kind: "skill", skill: { name, evidence: "instructions", status: "loaded" } }];
    });
    const parts = [...images, ...(prompt === null ? [] : [{ kind: "text" as const, text: prompt }]), ...skills];
    return parts.length === 0 ? null : { role: "user", ts: iso(time.created), parts };
  }
  if (type === "assistant") {
    const parts: ConversationPart[] = [];
    let image = 0;
    (Array.isArray(data.content) ? data.content : []).forEach((value, index) => {
      const block = record(value);
      if (block.type === "text" && text(block.text) !== null) parts.push({ kind: "text", text: block.text as string });
      else if (block.type === "reasoning" && text(block.text) !== null) parts.push({ kind: "thinking", text: block.text as string });
      else if (block.type === "tool" && typeof block.name === "string") {
        const state = record(block.state);
        const input = record(state.input);
        const skill = toolSkill(block.name, input, state.status);
        const summary = toolSummary(block.name, input);
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool",
          name: block.name,
          summary: skill?.name ?? (summary === block.name && typeof input.query === "string" ? input.query.slice(0, 120) : summary),
          input: JSON.stringify(input, null, 2),
          output: "",
        };
        if (skill !== null) part.skill = skill;
        const outcome = toolState(state.status);
        if (outcome !== undefined) part.state = outcome;
        trimOutput(part, toolText(state, block.name), `${id}:${index}`);
        const exit = record(state.metadata).exit;
        if (state.status === "error" || (typeof exit === "number" && exit !== 0)) part.error = true;
        const files = (Array.isArray(state.content) ? state.content : []).map(record).filter((item) => item.type === "file");
        const shown = files.length === 0 ? [] : rowImages("assistant", { content: [block] });
        if (shown.length > 0) part.images = shown.map((found) => ({ media_type: found.media_type, ref: `opencode:${id}:${image++}` }));
        parts.push(part);
      }
    });
    const error = record(data.error);
    // Esc ends a step as `aborted`: the TUI says it was interrupted, not that anything failed
    if (error.type !== "aborted" && text(error.message) !== null) parts.push({ kind: "text", text: `Error: ${error.message as string}` });
    const end = iso(time.completed) ?? iso(time.streamed) ?? iso(time.created);
    return { role: "assistant", ts: iso(time.created), end, parts, stop: data.finish === "stop" };
  }
  if (type === "idle") return { role: "idle" };
  if (type === "shell" && typeof data.command === "string") {
    const output = record(data.output).output;
    const printed = typeof output === "string" && output.length > 0 ? `\n${output.replace(/[\r\n]+$/, "")}` : "";
    return { role: "user", ts: iso(time.created), parts: [{ kind: "notice", text: cut(`$ ${data.command}${printed}`), source: "shell" }] };
  }
  // what OpenCode put in the user's seat to wake its model: a background job's or subagent's
  // result, a restart. A `!` command is echoed this way too, with no job: its shell row shows it.
  if (type === "synthetic") {
    const metadata = record(data.metadata);
    if (metadata.source === "shell" && metadata.jobID === undefined) return null;
    const body = typeof data.text === "string" ? unwrap(data.text) : "";
    const label = text(data.description)?.trim() ?? null;
    // a background subagent that ended (SubagentCompletion.deliver in 2.0.32): its card, with its answer
    if (metadata.source === "subagent") {
      const agent = text(metadata.agent)?.trim() ?? null;
      const status = metadata.state === "error" ? "failed" as const : metadata.state === "cancelled" ? "cancelled" as const : "completed" as const;
      return { role: "user", ts: iso(time.created), parts: [{ kind: "task_result", tasks: [{
        id: text(metadata.childID) ?? id, title: label ?? agent ?? "subagent", agent, model: null, status,
        duration_ms: null, turns: null, tool_calls: null, tokens: null,
        result: body.slice(0, OMO_TASK_RESULT_MAX), ...(body.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
      }] }] };
    }
    const shown = label !== null && body.length > 0 && body !== label ? `${label}\n${body}` : label ?? body;
    if (shown.length === 0) return null;
    const source = text(metadata.source) ?? text(metadata.notice) ?? "synthetic";
    return { role: "user", ts: iso(time.created), parts: [{ kind: "notice", text: cut(shown), source }] };
  }
  if (type === "compaction" && data.status === "completed" && text(data.summary) !== null) {
    return { role: "user", ts: iso(time.created), parts: [{ kind: "compact", text: data.summary as string }] };
  }
  return null;
}

/**
 * A model step is a row of its own, so consecutive steps merge
 * into one assistant turn, until the turn ends: OpenCode marks that with an `idle` row, and a step
 * that finished with `stop` is the turn's answer.
 */
export function opencodeTurns(records: readonly (OpencodeRecord | null)[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let settled = false;
  for (const entry of records) {
    if (entry === null) continue;
    if (entry.role === "idle") { settled = true; continue; }
    if (entry.role === "user") { turns.push({ role: "user", ts: entry.ts, parts: [...entry.parts] }); settled = false; continue; }
    let turn = turns[turns.length - 1];
    if (turn === undefined || turn.role !== "assistant" || settled) {
      turn = { role: "assistant", ts: entry.ts, parts: [] };
      turns.push(turn);
    }
    turn.parts.push(...entry.parts.map((part, index) => entry.stop && index === entry.parts.length - 1 && part.kind === "text"
      ? { ...part, phase: "final_answer" as const } : part));
    if (entry.end !== null) turn.end_ts = entry.end;
    settled = entry.stop;
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

export interface RowMeta { id: string; seq: number; type: string; updated: number; size: number }

export function pageStart(rows: Iterable<RowMeta>, floor: number, widen: boolean, window = OPENCODE_WINDOW_BYTES, pagePrompts = MAX_PAGE_PROMPTS): number {
  let bytes = 0;
  let prompts = 0;
  let earliest: number | undefined;
  let newer: number | undefined;
  for (const row of rows) {
    bytes += row.size;
    if (bytes > (widen && earliest === undefined ? 4 * window : window)) return earliest ?? newer ?? row.seq;
    if (row.type === "user") {
      earliest = row.seq;
      if (++prompts === pagePrompts) return row.seq;
    }
    newer = row.seq;
  }
  return floor;
}

export type OpencodePage = { before?: string; since?: string; from?: string; prompts?: number };

function pagePrompts(page: OpencodePage): number {
  const asked = page.prompts;
  return typeof asked === "number" && Number.isFinite(asked) ? Math.min(MAX_PAGE_PROMPTS, Math.max(1, Math.floor(asked))) : MAX_PAGE_PROMPTS;
}

export type OpencodeAnswer =
  | { kind: "unavailable"; reason: string }
  | { kind: "history_changed" }
  | { kind: "page"; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; history_id: string; signature: string };

/**
 * Every update of a row moves its `time_updated` (OpenCode's timestamp columns are
 * `$onUpdate(Date.now)`), but two writes in one millisecond leave it where it was: the size tells
 * those apart too.
 */
const newestRecords = new Map<string, Map<string, { updated: number; size: number; record: OpencodeRecord | null }>>();
const answers = new Map<string, { signature: string; answer: Extract<OpencodeAnswer, { kind: "page" }> }>();

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

export function forgetOpencodeState(): void {
  newestRecords.clear();
  answers.clear();
  settings.clear();
}

export const opencodeReadKey = (path: string, sessionId: string): string => `${path}\0${sessionId}`;

export function forgetOpencodeRead(key: string): void {
  newestRecords.delete(key);
  for (const map of [answers, settings]) for (const entry of [...map.keys()]) if (entry.startsWith(`${key}\0`)) map.delete(entry);
}

function openStore(path: string, busyMs: number): Database | null {
  try {
    const db = new Database(path, { readonly: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${busyMs}`);
    return db;
  } catch { return null; }
}

export function withStore<T>(path: string, read: (db: Database) => T, busyMs = BUSY_TIMEOUT_MS): T | null {
  const db = openStore(path, busyMs);
  if (db === null) return null;
  try { return read(db); }
  finally { db.close(); }
}

function unusable(error: unknown): boolean {
  return error instanceof Error && (/no such (table|column)/.test(error.message) || (error as { code?: unknown }).code === "SQLITE_NOTADB");
}

/**
 * A store held past the busy timeout. OpenCode runs its store in WAL, where a reader waits only
 * while the store recovers after a crash; a store in another journal mode waits on any writer.
 */
function busy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

interface SessionView {
  end: number;
  historyId: string;
  signature: string;
}

export function sessionView(db: Database, sessionId: string): SessionView | null {
  const session = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session_v2 WHERE id = ?").get(sessionId);
  if (session === null) return null;
  const stats = db.query<{ count: number; last: number | null; updated: number | null }, [string]>(
    "SELECT count(*) AS count, max(seq) AS last, max(time_updated) AS updated FROM session_message WHERE session_id = ?",
  ).get(sessionId)!;
  let end = (stats.last ?? -1) + 1;
  let revert: unknown = null;
  try { revert = session.revert === null ? null : JSON.parse(session.revert); } catch {}
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const row = db.query<{ seq: number }, [string, string]>("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(sessionId, boundary);
    if (row !== null) end = row.seq;
  }
  const historyId = `opencode-${sessionId}${end > (stats.last ?? -1) ? "" : `-r${end.toString(36)}`}`;
  return { end, historyId, signature: `${historyId}:${stats.count}:${stats.last}:${stats.updated}` };
}

const settings = new Map<string, { updated: number; size: number; model: string | null; variant: string | null; tokens: Row | null; completed: boolean }>();

/**
 * The rows are walked from
 * the newest and parsed here: JSON1 is not part of every SQLite Bun may run on (on macOS it uses the
 * system's own), so nothing is asked of SQL beyond the index.
 */
function sessionMetadata(db: Database, key: string, sessionId: string, end: number, measure: OpencodeRowSize): ConversationMetadata {
  const data = db.query<{ data: string }, [string, string]>("SELECT data FROM session_message WHERE id = ? AND session_id = ?");
  const sizeOf = db.query<{ size: number }, [string, string]>(ROW_QUERIES[measure].size);
  let setting: { model: string | null; variant: string | null } | null = null;
  let usage: Row | null = null;
  let compacted = false;
  for (const row of db.query<{ id: string; type: string; updated: number }, [string, number]>(
    "SELECT id, type, time_updated AS updated FROM session_message WHERE session_id = ? AND type IN ('assistant', 'model-switched', 'compaction') AND seq < ? ORDER BY seq DESC",
  ).iterate(sessionId, end)) {
    let known = settings.get(`${key}\0${row.id}`);
    const size = sizeOf.get(row.id, sessionId)?.size ?? 0;
    if (known?.updated !== row.updated || known.size !== size) {
      const found = data.get(row.id, sessionId);
      const parsed = found === null ? {} : parseData(found.data);
      const model = record(parsed.model);
      known = {
        updated: row.updated,
        size,
        model: text(model.id),
        variant: text(model.variant),
        tokens: parsed.tokens === undefined ? null : record(parsed.tokens),
        completed: parsed.status === "completed",
      };
      remember(settings, `${key}\0${row.id}`, known, 256);
    }
    if (row.type === "compaction") {
      // the footer counts no step from before a compaction: its usage is gone with it
      if (known.completed && usage === null) compacted = true;
    } else {
      setting ??= { model: known.model, variant: known.variant };
      if (row.type === "assistant" && known.tokens !== null && !compacted) usage ??= known.tokens;
    }
    if (setting !== null && (usage !== null || compacted)) break;
  }
  const metadata: ConversationMetadata = {
    model: setting?.model ?? null,
    // `default` is the model's own reasoning, not a level anyone chose
    reasoning_effort: setting?.variant !== null && setting?.variant !== undefined && setting.variant !== "default" ? setting.variant : null,
  };
  if (usage !== null) {
    const cache = record(usage.cache);
    const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write);
    if (used > 0) metadata.context = { used, window: null };
  }
  return metadata;
}

function parseData(data: string): Row {
  try { return record(JSON.parse(data)); } catch { return {}; }
}

/**
 * Every cursor is the `seq` of a
 * page's first row, and a committed `/undo` deletes every row from its message on: a chat whose
 * pages reach a deleted turn holds a cursor to a deleted row. Reading the store answers that the
 * same way after a restart, which nothing kept in memory could.
 */
function cursorOf(db: Database, sessionId: string, historyId: string, cursor: string, end: number): number | null {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== historyId || !Number.isSafeInteger(offset) || offset < 0 || offset > end) return null;
  if (offset === 0) return offset;
  return db.query<{ seq: number }, [string, number]>("SELECT seq FROM session_message WHERE session_id = ? AND seq = ?").get(sessionId, offset) === null ? null : offset;
}

/**
 * `octet_length` (SQLite 3.43) answers without reading the row;
 * on macOS Bun runs the system's own SQLite, which can be older, and there the bytes are counted.
 */
export const OPENCODE_ROW_SIZE = { octets: "octet_length(data)", bytes: "length(CAST(data AS BLOB))" } as const;
export type OpencodeRowSize = (typeof OPENCODE_ROW_SIZE)[keyof typeof OPENCODE_ROW_SIZE];

let supported: OpencodeRowSize | null = null;
export function supportedRowSize(db: Database): OpencodeRowSize {
  if (supported === null) {
    try { db.query("SELECT octet_length('')").get(); supported = OPENCODE_ROW_SIZE.octets; }
    catch { supported = OPENCODE_ROW_SIZE.bytes; }
  }
  return supported;
}

const ROW_QUERIES: Record<OpencodeRowSize, { page: string; pageDescending: string; size: string }> = {
  [OPENCODE_ROW_SIZE.octets]: {
    page: "SELECT id, seq, type, time_updated AS updated, octet_length(data) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
    pageDescending: "SELECT id, seq, type, time_updated AS updated, octet_length(data) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC",
    size: "SELECT octet_length(data) AS size FROM session_message WHERE id = ? AND session_id = ?",
  },
  [OPENCODE_ROW_SIZE.bytes]: {
    page: "SELECT id, seq, type, time_updated AS updated, length(CAST(data AS BLOB)) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
    pageDescending: "SELECT id, seq, type, time_updated AS updated, length(CAST(data AS BLOB)) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC",
    size: "SELECT length(CAST(data AS BLOB)) AS size FROM session_message WHERE id = ? AND session_id = ?",
  },
};

export function opencodeConversation(path: string, sessionId: string, page: OpencodePage = {}, rowSize?: OpencodeRowSize): OpencodeAnswer {
  if (!SESSION_ID.test(sessionId)) return { kind: "unavailable", reason: "no_session_id" };
  const key = opencodeReadKey(path, sessionId);
  const cacheKey = `${key}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}\0${pagePrompts(page)}`;
  try {
    const answer = withStore(path, (db): OpencodeAnswer => {
      if (storeFlavor(db) === "v1") {
        try { return conversation1(db, cacheKey, sessionId, page); }
        catch (error) {
          if (busy(error)) return answers.get(`${cacheKey}\0v1`)?.answer ?? { kind: "unavailable", reason: "store_busy" };
          return { kind: "unavailable", reason: "transcript_missing" };
        }
      }
      const view = sessionView(db, sessionId);
      if (view === null) return { kind: "unavailable", reason: "session_not_found" };
      const cached = answers.get(cacheKey);
      if (cached?.signature === view.signature) return cached.answer;

      const end = view.end;
      const measure = rowSize ?? supportedRowSize(db);
      const descending = (from: number, to: number) => db.query<RowMeta, [string, number, number]>(ROW_QUERIES[measure].pageDescending).iterate(sessionId, from, to);
      let start: number;
      let to = end;
      if (page.before !== undefined) {
        const before = cursorOf(db, sessionId, view.historyId, page.before, end);
        const floor = page.since === undefined ? 0 : cursorOf(db, sessionId, view.historyId, page.since, end);
        if (before === null || floor === null || floor > before) return { kind: "history_changed" };
        start = before === floor ? floor : pageStart(descending(floor, before), floor, true, OPENCODE_WINDOW_BYTES, pagePrompts(page));
        to = before;
      } else {
        const held = page.from === undefined ? null : cursorOf(db, sessionId, view.historyId, page.from, end);
        if (page.from !== undefined && held === null) return { kind: "history_changed" };
        const newest = pageStart(descending(0, end), 0, false, OPENCODE_WINDOW_BYTES, pagePrompts(page));
        start = held !== null && held >= newest ? held : newest;
      }

      const records: (OpencodeRecord | null)[] = [];
      if (page.before === undefined) {
        const known = newestRecords.get(key) ?? new Map<string, { updated: number; size: number; record: OpencodeRecord | null }>();
        const kept = new Map<string, { updated: number; size: number; record: OpencodeRecord | null }>();
        const data = db.query<{ data: string }, [string, string]>("SELECT data FROM session_message WHERE id = ? AND session_id = ?");
        for (const row of db.query<RowMeta, [string, number, number]>(ROW_QUERIES[measure].page).iterate(sessionId, start, to)) {
          let entry = known.get(row.id);
          if (entry?.updated !== row.updated || entry.size !== row.size) {
            const found = data.get(row.id, sessionId);
            entry = { updated: row.updated, size: row.size, record: found === null ? null : opencodeRecord(row.id, row.type, parseData(found.data)) };
          }
          kept.set(row.id, entry);
          records.push(entry.record);
        }
        remember(newestRecords, key, kept, 8);
      } else {
        for (const row of db.query<{ id: string; type: string; data: string }, [string, number, number]>(
          "SELECT id, type, data FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
        ).iterate(sessionId, start, to)) records.push(opencodeRecord(row.id, row.type, parseData(row.data)));
      }
      const result = {
        kind: "page" as const,
        turns: opencodeTurns(records),
        metadata: sessionMetadata(db, key, sessionId, to, measure),
        cursor: start > 0 ? `${view.historyId}:${start}` : null,
        history_id: view.historyId,
        signature: view.signature,
      };
      remember(answers, cacheKey, { signature: view.signature, answer: result }, 32);
      return result;
    });
    return answer ?? { kind: "unavailable", reason: "transcript_missing" };
  } catch (error) {
    if (unusable(error)) return { kind: "unavailable", reason: "transcript_missing" };
    if (busy(error)) return answers.get(cacheKey)?.answer ?? { kind: "unavailable", reason: "store_busy" };
    throw error;
  }
}

function sessionRow(db: Database, sessionId: string, id: string): { type: string; data: Row } | null {
  const view = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session_v2 WHERE id = ?").get(sessionId);
  if (view === null) return null;
  const row = db.query<{ seq: number; type: string; data: string }, [string, string]>("SELECT seq, type, data FROM session_message WHERE id = ? AND session_id = ?").get(id, sessionId);
  if (row === null) return null;
  let revert: unknown = null;
  try { revert = view.revert === null ? null : JSON.parse(view.revert); } catch {}
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const hidden = db.query<{ seq: number }, [string, string]>("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(sessionId, boundary);
    if (hidden !== null && row.seq >= hidden.seq) return null;
  }
  return { type: row.type, data: parseData(row.data) };
}

function readRow<T>(path: string, sessionId: string, id: string, read: (row: { type: string; data: Row }) => T | null): T | null {
  if (!SESSION_ID.test(sessionId) || !MESSAGE_ID.test(id)) return null;
  try {
    return withStore(path, (db) => {
      const row = storeFlavor(db) === "v1" ? sessionRow1(db, sessionId, id) : sessionRow(db, sessionId, id);
      return row === null ? null : read(row);
    });
  } catch (error) {
    if (unusable(error) || busy(error)) return null;
    throw error;
  }
}

export function opencodeToolOutput(path: string, sessionId: string, ref: string): string | null {
  const match = OPENCODE_TOOL_REF.exec(ref);
  if (match === null) return null;
  return readRow(path, sessionId, match[1]!, (row) => {
    if (row.type !== "assistant" || !Array.isArray(row.data.content)) return null;
    const block = record(row.data.content[Number(match[2])]);
    return block.type === "tool" && typeof block.name === "string" ? toolText(record(block.state), block.name) : null;
  });
}

export function opencodeImage(path: string, sessionId: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = OPENCODE_IMAGE_REF.exec(ref);
  if (match === null) return null;
  return readRow(path, sessionId, match[1]!, (row) => {
    const image = rowImages(row.type, row.data)[Number(match[2])];
    return image === undefined ? null : { mediaType: image.media_type, bytes: new Uint8Array(Buffer.from(image.data, "base64")) };
  });
}

export function opencodeSessionVersion(path: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  try {
    return withStore(path, (db) => {
      const flavor = storeFlavor(db);
      if (flavor === "unknown") return null;
      const table = flavor === "v1" ? "session" : "session_v2";
      const row = db.query<{ version: unknown }, [string]>(`SELECT version FROM ${table} WHERE id = ?`).get(sessionId);
      return typeof row?.version === "string" && row.version !== "" ? row.version : null;
    });
  } catch (error) {
    if (unusable(error) || busy(error)) return null;
    throw error;
  }
}

/**
 * The terminal title OpenCode's TUI sets on a session with this title (its `app.tsx`). An untitled
 * session's terminal title is plain `OpenCode`, as on its home screen: it names no session.
 */
export function opencodeTerminalTitle(title: string): string {
  return `OC | ${title.length > 40 ? `${title.slice(0, 37)}\u2026` : title}`;
}

export function opencodeSessionsTitled(path: string | null, terminalTitle: string): string[] {
  if (path === null || !terminalTitle.startsWith("OC | ")) return [];
  // the title as shown, or the start OpenCode cut it to
  const start = terminalTitle.slice("OC | ".length).replace(/\u2026$/, "");
  if (start === "") return [];
  try {
    return withStore(path, (db) => {
      const flavor = storeFlavor(db);
      if (flavor === "unknown") return [];
      const table = flavor === "v1" ? "session" : "session_v2";
      const rows = db.query<{ id: string; title: unknown }, [string, string]>(`SELECT id, title FROM ${table} WHERE substr(title, 1, length(?)) = ?`).all(start, start);
      return rows.flatMap((row) => typeof row.title === "string" && opencodeTerminalTitle(row.title) === terminalTitle ? [row.id] : []);
    }, 0) ?? [];
  } catch (error) {
    if (unusable(error) || busy(error)) return [];
    throw error;
  }
}

/* -------------------------------------------------------------------------------------------------
 * OpenCode 1.x: session / message / part
 *
 * Before the 2.x store (2.0.24), OpenCode kept the same conversation in three tables: `session`, and
 * one `message` and several `part` rows per step. 2.0 copies them into `session_v2`/`session_message`
 * when it migrates; a store with no `session_v2` is still 1.x, which the 2.x reader refused (its
 * `session_v2` queries throw `no such table` and the chat fell back to the terminal).
 *
 * `message.data.role` is `user` or `assistant`; an assistant step keeps the model (`modelID`) and its
 * usage (`tokens`) on the message and its `text`/`reasoning`/`tool` blocks in `part` rows. There is no
 * `seq`: a message is ordered by `(time_created, id)`, and a page cursor names a message by its place
 * in that order. A `/undo` is `session.revert` (a `{ messageID }`), hiding the rows from it on; the
 * revert commit deletes that suffix, leaving the earlier places unchanged. Read-only, per `session_id`.
 * ----------------------------------------------------------------------------------------------- */

type StoreFlavor = "v2" | "v1" | "unknown";
const MAX_V1_ROWS = 10_000;
const MAX_V1_BYTES = 4 * OPENCODE_WINDOW_BYTES;

function storeFlavor(db: Database): StoreFlavor {
  const table = (name: string) => db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  if (table("session_v2")) return "v2";
  if (table("session") && table("message") && table("part")) return "v1";
  return "unknown";
}

interface Message1 {
  id: string;
  data: Row;
  parts: Row[];
  updated: number;
  size: number;
}

function loadSession1(db: Database, sessionId: string): Message1[] {
  const parts = new Map<string, Row[]>();
  const partBytes = new Map<string, number>();
  for (const row of db.query<{ message_id: string; data: string }, [string]>(
    "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
  ).iterate(sessionId)) {
    const list = parts.get(row.message_id) ?? [];
    list.push(parseData(row.data));
    parts.set(row.message_id, list);
    partBytes.set(row.message_id, (partBytes.get(row.message_id) ?? 0) + Buffer.byteLength(row.data, "utf8"));
  }
  const messages: Message1[] = [];
  for (const row of db.query<{ id: string; updated: number; data: string }, [string]>(
    "SELECT id, time_updated AS updated, data FROM message WHERE session_id = ? ORDER BY time_created, id",
  ).iterate(sessionId)) {
    const own = parts.get(row.id) ?? [];
    const size = Buffer.byteLength(row.data, "utf8") + (partBytes.get(row.id) ?? 0);
    messages.push({ id: row.id, data: parseData(row.data), parts: own, updated: row.updated, size });
  }
  return messages;
}

function adaptMessageError1(value: unknown): Row | undefined {
  const error = record(value);
  if (Object.keys(error).length === 0) return undefined;
  const name = typeof error.name === "string" ? error.name : "";
  const message = text(record(error.data).message) ?? text(error.message);
  return { type: /abort/i.test(name) ? "aborted" : name || "error", message: message ?? "" };
}

const adaptToolError1 = (value: unknown): unknown => typeof value === "string" && value.length > 0 ? { message: value } : value;

function adaptMessage1(message: Message1): { type: string; data: Row } | null {
  const role = message.data.role;
  if (role === "user") {
    const prompt = message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
    // a picture pasted in the prompt is a `file` part: its 1.x `url` is the 2.x `uri` `rowImages` reads
    const files = message.parts.filter((part) => part.type === "file" && typeof part.url === "string")
      .map((part) => ({ type: "file", uri: part.url, mime: part.mime }));
    return { type: "user", data: { time: message.data.time, text: prompt, files, skills: [] } };
  }
  if (role !== "assistant") return null;
  const content: Row[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part.type === "reasoning" && typeof part.text === "string") content.push({ type: "reasoning", text: part.text });
    else if (part.type === "tool" && typeof part.tool === "string") {
      const state = record(part.state);
      const metadata = record(state.metadata);
      const printed = typeof state.output === "string" && state.output.length > 0 ? state.output : typeof metadata.output === "string" ? metadata.output : "";
      const result: Row[] = printed.length === 0 ? [] : [{ type: "text", text: printed }];
      for (const value of (Array.isArray(state.attachments) ? state.attachments : []).map(record)) {
        if (value.type === "file") result.push({ type: "file", uri: value.url, mime: value.mime });
      }
      content.push({ type: "tool", name: part.tool, state: { status: state.status, input: state.input, content: result, error: adaptToolError1(state.error), metadata: state.metadata } });
    }
  }
  return { type: "assistant", data: { time: message.data.time, content, finish: message.data.finish, error: adaptMessageError1(message.data.error), tokens: message.data.tokens } };
}

function sessionView1(db: Database, sessionId: string): (SessionView & { rows: number }) | null {
  const session = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session WHERE id = ?").get(sessionId);
  if (session === null) return null;
  const stats = db.query<{ count: number; updated: number | null; parts: number; partUpdated: number | null }, [string, string, string, string]>(
    "SELECT (SELECT count(*) FROM message WHERE session_id = ?) AS count, (SELECT max(time_updated) FROM message WHERE session_id = ?) AS updated, (SELECT count(*) FROM part WHERE session_id = ?) AS parts, (SELECT max(time_updated) FROM part WHERE session_id = ?) AS partUpdated",
  ).get(sessionId, sessionId, sessionId, sessionId)!;
  let end = stats.count;
  let revert: unknown = null;
  try { revert = session.revert === null ? null : JSON.parse(session.revert); } catch {}
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const row = db.query<{ time_created: number }, [string, string]>("SELECT time_created FROM message WHERE id = ? AND session_id = ?").get(boundary, sessionId);
    if (row !== null) {
      end = db.query<{ count: number }, [string, number, number, string]>(
        "SELECT count(*) AS count FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))",
      ).get(sessionId, row.time_created, row.time_created, boundary)!.count;
    }
  }
  const historyId = `opencode-${sessionId}${end === stats.count ? "" : `-r${end.toString(36)}`}`;
  return { end, historyId, signature: `${historyId}:${stats.count}:${stats.updated}:${stats.parts}:${stats.partUpdated}`, rows: stats.count + stats.parts };
}

function sessionMetadata1(messages: readonly Message1[], end: number): ConversationMetadata {
  let model: string | null = null;
  let usage: Row | null = null;
  for (let index = end - 1; index >= 0; index--) {
    const data = messages[index]!.data;
    if (data.role !== "assistant") continue;
    if (model === null) model = text(data.modelID);
    if (usage === null && data.tokens !== undefined) usage = record(data.tokens);
    if (model !== null && usage !== null) break;
  }
  const metadata: ConversationMetadata = { model, reasoning_effort: null };
  if (usage !== null) {
    const cache = record(usage.cache);
    const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write);
    if (used > 0) metadata.context = { used, window: null };
  }
  return metadata;
}

function conversation1(db: Database, cacheKey: string, sessionId: string, page: OpencodePage): OpencodeAnswer {
  const view = sessionView1(db, sessionId);
  if (view === null) return { kind: "unavailable", reason: "session_not_found" };
  if (view.rows > MAX_V1_ROWS) return { kind: "unavailable", reason: "transcript_missing" };
  const key = `${cacheKey}\0v1`;
  const cached = answers.get(key);
  if (cached?.signature === view.signature) return cached.answer;

  const bytes = db.query<{ messages: number | null; parts: number | null }, [string, string]>(
    "SELECT (SELECT sum(length(CAST(data AS BLOB))) FROM message WHERE session_id = ?) AS messages, (SELECT sum(length(CAST(data AS BLOB))) FROM part WHERE session_id = ?) AS parts",
  ).get(sessionId, sessionId)!;
  if ((bytes.messages ?? 0) + (bytes.parts ?? 0) > MAX_V1_BYTES) return { kind: "unavailable", reason: "transcript_missing" };

  const messages = loadSession1(db, sessionId);
  const end = Math.min(view.end, messages.length);
  const cursorOf = (cursor: string): number | null => {
    const separator = cursor.lastIndexOf(":");
    const offset = Number(cursor.slice(separator + 1));
    if (separator <= 0 || cursor.slice(0, separator) !== view.historyId || !Number.isSafeInteger(offset) || offset < 0 || offset > end) return null;
    if (offset === 0) return 0;
    return offset < end ? offset : null;
  };
  const descending = (from: number, to: number): RowMeta[] => {
    const rows: RowMeta[] = [];
    for (let index = to - 1; index >= from; index--) {
      const message = messages[index]!;
      rows.push({ id: message.id, seq: index, type: typeof message.data.role === "string" ? message.data.role : "", updated: message.updated, size: message.size });
    }
    return rows;
  };

  let start: number;
  let to = end;
  if (page.before !== undefined) {
    const before = cursorOf(page.before);
    const floor = page.since === undefined ? 0 : cursorOf(page.since);
    if (before === null || floor === null || floor > before) return { kind: "history_changed" };
    start = before === floor ? floor : pageStart(descending(floor, before), floor, true, OPENCODE_WINDOW_BYTES, pagePrompts(page));
    to = before;
  } else {
    const held = page.from === undefined ? null : cursorOf(page.from);
    if (page.from !== undefined && held === null) return { kind: "history_changed" };
    const newest = pageStart(descending(0, end), 0, false, OPENCODE_WINDOW_BYTES, pagePrompts(page));
    start = held !== null && held >= newest ? held : newest;
  }

  const records: (OpencodeRecord | null)[] = [];
  for (let index = start; index < to; index++) {
    const adapted = adaptMessage1(messages[index]!);
    records.push(adapted === null ? null : opencodeRecord(messages[index]!.id, adapted.type, adapted.data));
  }
  const result = {
    kind: "page" as const,
    turns: opencodeTurns(records),
    metadata: sessionMetadata1(messages, to),
    cursor: start > 0 ? `${view.historyId}:${start}` : null,
    history_id: view.historyId,
    signature: view.signature,
  };
  remember(answers, key, { signature: view.signature, answer: result }, 32);
  return result;
}

function sessionRow1(db: Database, sessionId: string, id: string): { type: string; data: Row } | null {
  const view = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session WHERE id = ?").get(sessionId);
  if (view === null) return null;
  const row = db.query<{ time_created: number; data: string }, [string, string]>("SELECT time_created, data FROM message WHERE id = ? AND session_id = ?").get(id, sessionId);
  if (row === null) return null;
  let revert: unknown = null;
  try { revert = view.revert === null ? null : JSON.parse(view.revert); } catch {}
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const hidden = db.query<{ time_created: number }, [string, string]>("SELECT time_created FROM message WHERE id = ? AND session_id = ?").get(boundary, sessionId);
    if (hidden !== null && (row.time_created > hidden.time_created || (row.time_created === hidden.time_created && id >= boundary))) return null;
  }
  const parts = db.query<{ data: string }, [string]>("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id").all(id).map((part) => parseData(part.data));
  return adaptMessage1({ id, data: parseData(row.data), parts, updated: 0, size: 0 });
}
