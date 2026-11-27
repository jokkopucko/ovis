/** Agy's append-only step ledger, reduced in physical order before shared paging. */
import type { Database } from "bun:sqlite";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { closeSync, fstatSync, openSync, read as readFd, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { ConversationReadPending } from "./conversation-shared.ts";
import { readSqliteSnapshot, type SnapshotCache } from "./sqlite-snapshot.ts";
import type { AgyPendingStep } from "./dialogs/agy-record.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";
import { agyInvokedSkills } from "./skill-invocations/agy.ts";
import { skillDocument } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

const MAX_ENTRIES = 100_000;
const MAX_LINE = 16 * 1024 * 1024;
const SCAN_BYTES = 32 * 1024 * 1024;
// The catalog's database and WAL grow with the session's payloads, not its step count: a long
// session passes 32 MiB during a turn (#2618). The copy repeats while a turn writes, on a file
// thread since #2706, but it still holds that thread and the disk for its duration. A session of
// two days passed 64 MiB (48 MiB database, 33 MiB WAL) and its chat went blank.
export const AGY_CATALOG_BYTES = 256 * 1024 * 1024;
const CATALOG_BYTES = AGY_CATALOG_BYTES;
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class AgyUnavailable extends Error { constructor() { super("Agy history is unavailable"); } }
interface StepModel { model: string; reasoning_effort: string | null; source: "settings" | "planner" }
interface Step { index: number; start: number; end: number; type: string; status: string; digest: string; activity?: "working" | "idle"; model?: StepModel }
interface Index { identity: string; size: number; changed: string; scanned: number; prefix: Hash; revision: string; steps: Step[]; visible: Step[]; retired: Set<number> }
const indexes = new Map<string, Index>();
const catalogs = new Map<string, { key: string; rows: number[] }>();
const MAX_CATALOGS = 32;
export function forgetAgyState(path?: string): void {
  if (path === undefined) { indexes.clear(); catalogs.clear(); pendings.clear(); } else { indexes.delete(path); catalogs.delete(agyDatabasePath(path)); pendings.delete(agyDatabasePath(path)); }
}

export function agyDatabasePath(path: string): string {
  const sessionDir = dirname(dirname(dirname(path)));
  return join(dirname(dirname(sessionDir)), "conversations", `${basename(sessionDir)}.db`);
}

/** `read` on Antigravity's conversation database (sqlite-snapshot.ts), whose every refusal is AgyUnavailable. */
function readAgyDatabase<T>(dbPath: string, read: (db: Database) => T, cache: SnapshotCache<T> | null, beforeOpen?: () => void, copy?: "always"): T {
  try { return readSqliteSnapshot(dbPath, read, cache, CATALOG_BYTES, beforeOpen, copy); } catch { throw new AgyUnavailable(); }
}

export function agyCatalog(path: string, beforeOpen?: () => void): Set<number> {
  const dbPath = agyDatabasePath(path);
  const cache: SnapshotCache<number[]> = {
    get: (key) => { const cached = catalogs.get(dbPath); return cached?.key === key ? cached.rows : undefined; },
    set: (key, rows) => {
      catalogs.delete(dbPath);
      catalogs.set(dbPath, { key, rows });
      if (catalogs.size > MAX_CATALOGS) catalogs.delete(catalogs.keys().next().value!);
    },
  };
  return new Set(readAgyDatabase(dbPath, (db) => {
    const rows = db.query<{ idx: number }, []>(`SELECT idx FROM steps ORDER BY idx LIMIT ${MAX_ENTRIES + 1}`).all();
    if (rows.length > MAX_ENTRIES || rows.some((row) => !Number.isSafeInteger(row.idx) || row.idx < 0)) throw new AgyUnavailable();
    return rows.map((row) => row.idx);
  }, cache, beforeOpen));
}

const pendings = new Map<string, { key: string; steps: AgyPendingStep[] }>();

/**
 * The tool calls that wait on the user (dialogs/agy-record.ts), as the conversation database holds them now; a step
 * with no payload stays among them, empty, as one whose command is not known. Asked on every look at a card, so a copy
 * of files unchanged (and settled) since the last is not made again.
 */
export function agyPendingSteps(path: string): AgyPendingStep[] {
  const dbPath = agyDatabasePath(path);
  const cache: SnapshotCache<AgyPendingStep[]> = {
    get: (key) => { const cached = pendings.get(dbPath); return cached?.key === key ? cached.steps : undefined; },
    set: (key, steps) => {
      pendings.delete(dbPath);
      pendings.set(dbPath, { key, steps });
      if (pendings.size > MAX_CATALOGS) pendings.delete(pendings.keys().next().value!);
    },
  };
  return readAgyDatabase(dbPath, (db) =>
    db.query<{ idx: number; payload: Uint8Array | null }, []>("SELECT idx, step_payload AS payload FROM steps WHERE step_type = 132 AND status = 9 LIMIT 8").all()
      .map(({ idx, payload }) => ({ idx, payload: payload instanceof Uint8Array ? payload : new Uint8Array() })), cache, undefined, "always");
}

/** `agyPendingSteps` on a file thread, as `agyCatalogOffThread`: it copies the same database. */
export async function agyPendingStepsOffThread(path: string): Promise<AgyPendingStep[]> {
  try { return await fileTask<AgyPendingStep[]>({ op: "agy-pending", path }); }
  catch (error) { throw error instanceof FileBusyError ? error : new AgyUnavailable(); }
}

function entry(line: string): Record<string, unknown> {
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(line)); } catch { throw new AgyUnavailable(); }
  if (!Number.isSafeInteger(value.step_index) || (value.step_index as number) < 0 || typeof value.type !== "string") throw new AgyUnavailable();
  return value;
}

/**
 * `agyCatalog` on a file thread (`file-pool.ts`): copying and opening a long session's catalog takes
 * up to a second, which on the server's thread stalls every request and terminal (#2706).
 */
export async function agyCatalogOffThread(path: string): Promise<Set<number>> {
  let rows: number[];
  try { rows = await fileTask<number[]>({ op: "agy-catalog", path }); }
  catch (error) { throw error instanceof FileBusyError ? error : new AgyUnavailable(); }
  return new Set(rows);
}

export interface AgyProjection { segments: { start: number; end: number }[]; promptStarts: number[]; revision: string; indices: number[]; activity: "working" | "idle"; model: string | null; reasoning_effort: string | null }
const SETTINGS_OPEN = "<USER_SETTINGS_CHANGE>";
const SETTINGS_CLOSE = "</USER_SETTINGS_CHANGE>";
// display names hold dots (`Gemini 3.8 Flash (High)`): the value ends at the sentence's period
const AGY_SETTINGS_MODEL = /^The user changed setting `Model Selection` from [^\n]+? to ([^\n]+?)\.(?: |$)/mu;
const AGY_PAREN_EFFORT = /^(.*\S)\s+\((none|minimal|extra-low|low|medium|high|xhigh|max)\)$/iu;
const AGY_ID_EFFORT = /^(.+?)-(extra-low|minimal|low|medium|high|xhigh|max)$/u;
const normalizeModelKey = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Agy appends its settings block last, after every skill body and mentioned item it expands: a block inside one of those is text. */
function agySettingsBlock(metadata: string): string | null {
  const trimmed = metadata.trimEnd();
  if (!trimmed.endsWith(SETTINGS_CLOSE)) return null;
  const open = trimmed.lastIndexOf(SETTINGS_OPEN);
  return open < 0 ? null : trimmed.slice(open + SETTINGS_OPEN.length, -SETTINGS_CLOSE.length);
}

function stepModel(value: Record<string, unknown>): StepModel | undefined {
  if (value.status !== "DONE") return undefined;
  if (value.type === "USER_INPUT" && typeof value.content === "string") {
    const envelope = agyEnvelope(value.content);
    const block = envelope === null ? null : agySettingsBlock(envelope.metadata);
    const chosen = (block === null ? null : AGY_SETTINGS_MODEL.exec(block))?.[1]?.trim() ?? "";
    if (!chosen || chosen === "None") return undefined;
    const paren = AGY_PAREN_EFFORT.exec(chosen);
    return paren
      ? { model: paren[1]!.trim(), reasoning_effort: paren[2]!.toLowerCase(), source: "settings" }
      : { model: chosen, reasoning_effort: null, source: "settings" };
  }
  if (value.type === "PLANNER_RESPONSE" && typeof value.model === "string") {
    const raw = value.model.trim();
    if (!raw) return undefined;
    const suffixed = AGY_ID_EFFORT.exec(raw);
    return suffixed
      ? { model: suffixed[1]!, reasoning_effort: suffixed[2]!.toLowerCase(), source: "planner" }
      : { model: raw, reasoning_effort: null, source: "planner" };
  }
  return undefined;
}

const readLedger = promisify(readFd);

async function agyScan(path: string, fd: number): Promise<Index> {
  const stat = fstatSync(fd);
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  let index = indexes.get(path);
  if (index?.identity === identity && index.scanned > 0 && stat.size > index.size) {
    // A rewrite can preserve the old tail but move earlier rows. Verify every consumed byte
    // through the held descriptor, in chunks off the server thread's synchronous I/O path.
    const prefix = createHash("sha256");
    const bytes = Buffer.alloc(256 * 1024);
    for (let at = 0; at < index.scanned;) {
      const length = Math.min(bytes.length, index.scanned - at);
      const { bytesRead } = await readLedger(fd, bytes, 0, length, at);
      if (bytesRead === 0) throw new ConversationReadPending();
      prefix.update(bytes.subarray(0, bytesRead));
      at += bytesRead;
    }
    const verified = fstatSync(fd);
    if (verified.size !== stat.size || verified.mtimeMs !== stat.mtimeMs || verified.ctimeMs !== stat.ctimeMs) throw new ConversationReadPending();
    if (prefix.digest("hex") !== index.prefix.copy().digest("hex")) index = undefined;
  }
  if (!index || index.identity !== identity || stat.size < index.size || (stat.size === index.size && changed !== index.changed)) {
    index = { identity, size: stat.size, changed, scanned: 0, prefix: createHash("sha256"), revision: randomUUID(), steps: [], visible: [], retired: new Set() };
  }
  index.size = stat.size; index.changed = changed;
  indexes.delete(path); indexes.set(path, index);
  if (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
  let position = index.scanned;
  let carry: Buffer[] = [];
  let carried = 0;
  const end = Math.min(stat.size, position + SCAN_BYTES);
  while (position < end) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, end - position));
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (!read) throw new AgyUnavailable();
    const bytes = chunk.subarray(0, read);
    let start = 0;
    for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, start)) {
      if (carried + newline - start > MAX_LINE) throw new AgyUnavailable();
      const chunkLine = bytes.subarray(start, newline + 1);
      const rawLine = carried ? Buffer.concat([...carry, chunkLine]) : chunkLine;
      const line = rawLine.toString("utf8", 0, rawLine.length - 1);
      const lineStart = position + start - carried;
      const lineEnd = position + newline + 1;
      carry = []; carried = 0;
      const value = entry(line);
      const number = value.step_index as number;
      if (index.steps.length && number <= index.steps.at(-1)!.index) {
        while (index.steps.length && index.steps.at(-1)!.index >= number) index.steps.pop();
      }
      // DONE completes one exported step, not the turn. In the native 1.3.3 trace,
      // a planner response with tools continues work; its tool-free answer ends it.
      // Reasoning is exported after the planner finishes, so it cannot prove Thinking.
      const activity = value.status !== "DONE" ? undefined
        : value.type === "USER_INPUT" ? "working"
        : value.type === "PLANNER_RESPONSE"
          ? (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) || typeof value.content !== "string" || !value.content.trim() ? "working" : "idle"
          : undefined;
      index.steps.push({ index: number, start: lineStart, end: lineEnd, type: value.type as string, status: String(value.status ?? ""), digest: hash(line), activity, model: stepModel(value) });
      if (index.steps.length > MAX_ENTRIES) throw new AgyUnavailable();
      index.prefix.update(rawLine);
      index.scanned = lineEnd;
      start = newline + 1;
    }
    if (start < bytes.length) { carry.push(bytes.subarray(start)); carried += bytes.length - start; }
    if (carried > MAX_LINE) throw new AgyUnavailable();
    position += read;
  }
  if (position < stat.size) throw new AgyUnavailable();
  return index;
}

/** The scanned steps the catalog keeps, read after the scan as Agy writes the ledger first. */
function agyReduce(index: Index, catalog: Set<number>): AgyProjection {
  // Native idle rewind updates the DB before any replacement ledger lines arrive.
  // DB-only steps are normal; equality or a strict prefix would reject healthy logs.
  const physicalStarts = new Set(index.steps.map((step) => step.start));
  for (const start of index.retired) if (!physicalStarts.has(start)) index.retired.delete(start);
  for (const step of index.visible) if (!catalog.has(step.index) && physicalStarts.has(step.start)) index.retired.add(step.start);
  const retained = index.steps.filter((step) => catalog.has(step.index) && !index.retired.has(step.start));
  const visible = retained.at(-1)?.status !== "DONE" ? retained.slice(0, -1) : retained;
  if (index.visible.some((step, at) => visible[at]?.start !== step.start || visible[at]?.end !== step.end)) index.revision = randomUUID();
  index.visible = visible;
  const segments: AgyProjection["segments"] = [];
  const promptStarts: number[] = [], indices: number[] = [];
  let length = 0;
  let activity: AgyProjection["activity"] = "idle";
  let model: string | null = null;
  let reasoning_effort: string | null = null;
  let display: { key: string; model: string; reasoning_effort: string | null } | null = null;
  for (const step of visible) {
    if (step.activity !== undefined) activity = step.activity;
    if (step.model !== undefined) {
      if (step.model.source === "settings") {
        model = step.model.model;
        reasoning_effort = step.model.reasoning_effort;
        display = { key: normalizeModelKey(step.model.model), model: step.model.model, reasoning_effort: step.model.reasoning_effort };
      } else if (display !== null && display.key === normalizeModelKey(step.model.model)) {
        model = display.model;
        reasoning_effort = step.model.reasoning_effort ?? display.reasoning_effort;
      } else {
        model = step.model.model;
        reasoning_effort = step.model.reasoning_effort;
      }
    }
    indices.push(step.index);
    if (step.type === "USER_INPUT" && step.status === "DONE") promptStarts.push(length);
    const previous = segments.at(-1);
    if (previous?.end === step.start) previous.end = step.end;
    else segments.push({ start: step.start, end: step.end });
    length += step.end - step.start;
  }
  return { segments, promptStarts, revision: index.revision, indices, activity, model, reasoning_effort };
}

const historyReads = new Map<string, Promise<unknown>>();

/**
 * With `authorized`, only that file at its originally canonical path is read. A replacement
 * file or a link is pending, for the next read to authorize afresh.
 */
export function withAgyHistory<T>(path: string, read: (projection: AgyProjection, fd: number) => T, authorized?: { dev: number; ino: number }): Promise<T> {
  const run = (historyReads.get(path) ?? Promise.resolve()).then(() => agyHistoryRead(path, read, authorized), () => agyHistoryRead(path, read, authorized));
  const settled = run.then(() => {}, () => {});
  historyReads.set(path, settled);
  void settled.then(() => { if (historyReads.get(path) === settled) historyReads.delete(path); });
  return run;
}

async function agyHistoryRead<T>(path: string, read: (projection: AgyProjection, fd: number) => T, authorized?: { dev: number; ino: number }): Promise<T> {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (authorized !== undefined && (before.dev !== authorized.dev || before.ino !== authorized.ino)) throw new ConversationReadPending();
    if (realpathSync(path) !== path) throw authorized !== undefined ? new ConversationReadPending() : new AgyUnavailable();
    const index = await agyScan(path, fd);
    const catalog = await agyCatalogOffThread(path);
    if (indexes.get(path) !== index) {
      indexes.delete(path); indexes.set(path, index);
      if (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
    }
    const projection = agyReduce(index, catalog);
    const result = read(projection, fd);
    const current = await agyCatalogOffThread(path);
    if (realpathSync(path) !== path) throw authorized !== undefined ? new ConversationReadPending() : new AgyUnavailable();
    const after = statSync(path), pinned = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || pinned.size < before.size
      || (pinned.size === before.size && (pinned.mtimeMs !== before.mtimeMs || pinned.ctimeMs !== before.ctimeMs))
      || projection.indices.some((index) => !current.has(index))) throw new AgyUnavailable();
    return result;
  } finally { closeSync(fd); }
}

/** A USER_INPUT step's request and the metadata Agy appends after it, or null when it is not that envelope. */
function agyEnvelope(text: string): { request: string; metadata: string } | null {
  if (!text.startsWith("<USER_REQUEST>")) return null;
  const end = text.lastIndexOf("</USER_REQUEST>");
  if (end < 0) return null;
  const metadata = text.slice(end + "</USER_REQUEST>".length);
  if (!/^\s*<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/.test(metadata)) return null;
  return { request: text.slice("<USER_REQUEST>".length, end).replace(/^\n|\n$/g, ""), metadata };
}

/** A USER_INPUT step's prompt, without the request wrapper Agy adds around it. */
export function agyUserText(text: string): string {
  return agyEnvelope(text)?.request ?? text;
}
function outputRef(path: string, step: Step): string {
  const index = indexes.get(path)!;
  return `agy:${hash(JSON.stringify([path, index.identity, index.revision, step.start, step.digest]))}`;
}
export function parseAgyTranscript(text: string, path?: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const steps = path ? new Map(indexes.get(path)?.visible.map((step) => [step.index, step])) : undefined;
  let idle = false;
  let woken = false;
  type ToolPart = Extract<ConversationPart, { kind: "tool" }>;
  let pendingBatch: { plannerIndex: number; calls: ToolPart[]; generics: { stepIndex: number; content: string; line: string; ts: string | null; step: Step | undefined }[] } | null = null;
  const appendAssistant = (parts: ConversationPart[], ts: string | null, fromPlanner: boolean): void => {
    if (!parts.length) return;
    const previous = turns.at(-1);
    const opens = woken && fromPlanner;
    if (previous?.role === "assistant" && !opens) {
      previous.parts.push(...parts);
      if (!woken && (!idle || fromPlanner)) previous.end_ts = ts ?? undefined;
    } else {
      turns.push({ role: "assistant", ts, end_ts: ts ?? undefined, parts });
      woken = false;
    }
  };
  const flushBatch = (): void => {
    if (pendingBatch === null) return;
    const { plannerIndex, calls, generics } = pendingBatch;
    pendingBatch = null;
    if (generics.length === 0) return;
    // Agy allocates sequential step indices to tool results in dispatch order right after the
    // planner step. Pair them only when the count and indices match 1-to-1; otherwise keep each
    // result independent rather than guessing.
    if (generics.length === calls.length && generics.every((entry, idx) => entry.stepIndex === plannerIndex + 1 + idx)) {
      for (let idx = 0; idx < calls.length; idx++) {
        const result = generics[idx]!;
        if (!result.content) continue;
        trimOutput(calls[idx]!, result.content, path && result.step ? outputRef(path, result.step) : `agy:${hash(result.line)}`);
        const previous = turns.at(-1);
        if (previous?.role === "assistant" && !woken && !idle) previous.end_ts = result.ts ?? undefined;
      }
      return;
    }
    for (const result of generics) {
      if (!result.content) continue;
      const part: ToolPart = { kind: "tool", name: "Tool output", summary: `Step ${result.stepIndex}`, input: "", output: "" };
      trimOutput(part, result.content, path && result.step ? outputRef(path, result.step) : `agy:${hash(result.line)}`);
      appendAssistant([part], result.ts, false);
    }
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = entry(line);
    if (value.status !== "DONE") continue;
    const content = typeof value.content === "string" ? value.content : "";
    const ts = typeof value.created_at === "string" ? value.created_at : null;
    if (value.type === "GENERIC" && pendingBatch !== null) {
      pendingBatch.generics.push({ stepIndex: value.step_index as number, content, line, ts, step: steps?.get(value.step_index as number) });
      continue;
    }
    flushBatch();
    if (value.type === "USER_INPUT") {
      const envelope = agyEnvelope(content);
      const skills = envelope === null ? [] : agyInvokedSkills(envelope.request, envelope.metadata).map((skill) => ({ kind: "skill" as const, skill }));
      turns.push({ role: "user", ts, parts: [{ kind: "text", text: envelope?.request ?? content }, ...skills] });
      idle = false;
      woken = false;
      continue;
    }
    if (value.type === "SYSTEM_MESSAGE") {
      // A background task, timer or subagent notification after a tool-free answer resumes the planner in a new turn.
      if (idle) { woken = true; idle = false; }
      continue;
    }
    if (value.type !== "PLANNER_RESPONSE" && value.type !== "GENERIC") continue;
    const parts: ConversationPart[] = [];
    const callParts: ToolPart[] = [];
    let malformedCall = false;
    if (value.type === "GENERIC") {
      if (!content) continue;
      // Native exports provide no call ID. Keep this result independent of planner calls.
      const part: ToolPart = { kind: "tool", name: "Tool output", summary: `Step ${value.step_index}`, input: "", output: "" };
      const step = steps?.get(value.step_index as number);
      trimOutput(part, content, path && step ? outputRef(path, step) : `agy:${hash(line)}`);
      parts.push(part);
    } else {
      if (content) parts.push({ kind: "text", text: content });
      for (const call of Array.isArray(value.tool_calls) ? value.tool_calls : []) {
        const tool = record(call), input = record(tool.args);
        if (typeof tool.name !== "string") { malformedCall = true; continue; }
        const mapped = { ...input, command: input.CommandLine, file_path: input.Path ?? input.AbsolutePath ?? input.TargetFile };
        const part: ToolPart = { kind: "tool", name: tool.name, summary: toolSummary(tool.name, mapped), input: JSON.stringify(input), output: "" };
        // the ledger ties no output step to its call, so a read stays requested
        const skill = tool.name === "read_file" ? skillDocument(input.Path) : null;
        if (skill) part.skill = { ...skill, status: "requested" };
        parts.push(part);
        callParts.push(part);
      }
    }
    if (!parts.length) continue;
    if (value.type === "PLANNER_RESPONSE") {
      idle = (!Array.isArray(value.tool_calls) || value.tool_calls.length === 0) && content.trim().length > 0;
      if (callParts.length > 0 && !malformedCall) {
        pendingBatch = { plannerIndex: value.step_index as number, calls: callParts, generics: [] };
      }
    }
    appendAssistant(parts, ts, value.type === "PLANNER_RESPONSE");
  }
  flushBatch();
  return turns;
}

export async function agyToolOutput(path: string, ref: string): Promise<string | null> {
  if (!/^agy:[A-Za-z0-9_-]{43}$/.test(ref)) return null;
  try {
    return await withAgyHistory(path, (projection, fd) => {
      const visible = new Set(projection.indices);
      for (const step of indexes.get(path)?.visible ?? []) {
        if (step.type !== "GENERIC" || !visible.has(step.index) || outputRef(path, step) !== ref) continue;
        const bytes = Buffer.alloc(step.end - step.start);
        if (readSync(fd, bytes, 0, bytes.length, step.start) !== bytes.length) return null;
        const value = entry(bytes.toString("utf8"));
        const text = typeof value.content === "string" ? value.content : "";
        return text.length > 2_000_000 ? `${text.slice(0, 2_000_000)}\n… trimmed` : text;
      }
      return null;
    });
  } catch (error) {
    if (error instanceof FileBusyError) throw error;
    return null;
  }
}
