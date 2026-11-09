/** Agy's append-only step ledger, reduced in physical order before shared paging. */
import { constants as sqliteConstants, Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { ConversationReadPending } from "./conversation-shared.ts";
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
// thread since #2706, but it still holds that thread and the disk for its duration.
export const AGY_CATALOG_BYTES = 64 * 1024 * 1024;
const CATALOG_BYTES = AGY_CATALOG_BYTES;
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class AgyUnavailable extends Error { constructor() { super("Agy history is unavailable"); } }
interface Step { index: number; start: number; end: number; type: string; status: string; digest: string; activity?: "working" | "idle" }
interface Index { identity: string; size: number; changed: string; scanned: number; revision: string; steps: Step[]; visible: Step[]; retired: Set<number> }
const indexes = new Map<string, Index>();
/** The last snapshot read per catalog, keyed on the stats of the files it copied. */
const catalogs = new Map<string, { key: string; rows: number[] }>();
const MAX_CATALOGS = 32;
// Timestamps tick coarsely, so a same-size rewrite just after a read can keep both of them. Only a
// read this long after the files' last change may be reused (git's "racy" rule).
const CATALOG_SETTLED_MS = 2000;
export function forgetAgyState(path?: string): void {
  if (path === undefined) { indexes.clear(); catalogs.clear(); } else { indexes.delete(path); catalogs.delete(agyDatabasePath(path)); }
}

/** The catalog beside this resolved native ledger; also watched for saved rewinds. */
export function agyDatabasePath(path: string): string {
  const sessionDir = dirname(dirname(dirname(path)));
  return join(dirname(dirname(sessionDir)), "conversations", `${basename(sessionDir)}.db`);
}

/** The database supplies only the active indices, never payloads or guessed numeric statuses. */
export function agyCatalog(path: string, beforeOpen?: () => void): Set<number> {
  const dbPath = agyDatabasePath(path);
  let db: Database | undefined;
  let fd: number | undefined;
  const sideFds: number[] = [];
  let snapshot: string | undefined;
  let catalogKey: string | undefined;
  let reused: number[] | undefined;
  const began = Date.now();
  try {
    if (realpathSync(dbPath) !== dbPath) throw new AgyUnavailable();
    const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(dbPath, readFlags);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new AgyUnavailable();
    const header = Buffer.alloc(20);
    const walBefore = existsSync(`${dbPath}-wal`), shmBefore = existsSync(`${dbPath}-shm`);
    const wal = readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2;
    const files = [{ path: dbPath, fd, stat: before }];
    beforeOpen?.();
    // Every source open is immutable, even if a writer switches journal modes
    // after the header read. Only the private snapshot may create side files.
    // An incomplete WAL pair therefore exposes checkpointed rows only.
    let immutable = true;
    const descriptor = process.platform === "linux" || (process.platform === "darwin" && immutable) ? `/dev/fd/${fd}` : null;
    let name = descriptor ?? dbPath;
    if (wal && walBefore && shmBefore) {
      // A readonly SQLite open can create -wal even with readonly_shm=1. Never open
      // a live source that way: recover its WAL only beside a bounded private copy.
      for (const suffix of ["-wal", "-shm"]) {
        const path = `${dbPath}${suffix}`;
        const sideFd = openSync(path, readFlags);
        sideFds.push(sideFd);
        const stat = fstatSync(sideFd, { bigint: true });
        if (!stat.isFile()) throw new AgyUnavailable();
        files.push({ path, fd: sideFd, stat });
      }
      const snapshotFiles = files.slice(0, 2);
      if (snapshotFiles.reduce((bytes, file) => bytes + file.stat.size, 0n) > BigInt(CATALOG_BYTES)) throw new AgyUnavailable();
      // Unchanged pinned files hold the bytes the last validated copy read.
      const key = snapshotFiles.map(({ stat }) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`).join("|");
      const cached = catalogs.get(dbPath);
      // A reused catalog still passes the same final checks on every pinned file below.
      if (cached?.key === key) { reused = cached.rows; catalogKey = key; }
      else if (snapshotFiles.every(({ stat }) => began - Number(stat.mtimeNs / 1_000_000n) >= CATALOG_SETTLED_MS
        && began - Number(stat.ctimeNs / 1_000_000n) >= CATALOG_SETTLED_MS)) catalogKey = key;
      // macOS: tmpdir() is under the /var symlink, which SQLITE_OPEN_NOFOLLOW refuses
      // (assigned before resolving, so a failed realpath still removes the directory)
      if (reused === undefined) {
        snapshot = mkdtempSync(join(tmpdir(), "ovis-agy-catalog-"));
        snapshot = realpathSync(snapshot);
        name = join(snapshot, "catalog.db");
        for (const [index, file] of snapshotFiles.entries()) {
          const target = openSync(index === 0 ? name : `${name}-wal`, "wx", 0o600);
          try {
            const bytes = Buffer.alloc(64 * 1024);
            const size = Number(file.stat.size);
            let offset = 0;
            while (offset < size) {
              const read = readSync(file.fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
              if (!read) throw new AgyUnavailable();
              writeFileSync(target, bytes.subarray(0, read));
              offset += read;
            }
          } finally { closeSync(target); }
        }
      }
      immutable = false;
    }
    let rows: { idx: number }[];
    if (reused !== undefined) rows = reused.map((idx) => ({ idx }));
    else {
      const flags = sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;
      db = new Database(immutable ? `${pathToFileURL(name).href}?immutable=1` : name,
        descriptor === null || snapshot !== undefined ? flags | sqliteConstants.SQLITE_OPEN_NOFOLLOW : flags);
      const opened = statSync(dbPath, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || realpathSync(dbPath) !== dbPath) throw new AgyUnavailable();
      db.exec("PRAGMA busy_timeout = 100");
      rows = db.query<{ idx: number }, []>(`SELECT idx FROM steps ORDER BY idx LIMIT ${MAX_ENTRIES + 1}`).all();
    }
    for (const file of files) {
      const after = statSync(file.path, { bigint: true }), pinned = fstatSync(file.fd, { bigint: true });
      if (after.dev !== file.stat.dev || after.ino !== file.stat.ino || realpathSync(file.path) !== file.path
        || pinned.size !== file.stat.size || pinned.mtimeNs !== file.stat.mtimeNs || pinned.ctimeNs !== file.stat.ctimeNs) throw new AgyUnavailable();
    }
    if (existsSync(`${dbPath}-wal`) !== walBefore || existsSync(`${dbPath}-shm`) !== shmBefore
      || (!wal && existsSync(`${dbPath}-journal`))) throw new AgyUnavailable();
    if (rows.length > MAX_ENTRIES || rows.some((row) => !Number.isSafeInteger(row.idx) || row.idx < 0)) throw new AgyUnavailable();
    const indices = rows.map((row) => row.idx);
    if (catalogKey !== undefined) {
      catalogs.delete(dbPath);
      catalogs.set(dbPath, { key: catalogKey, rows: indices });
      if (catalogs.size > MAX_CATALOGS) catalogs.delete(catalogs.keys().next().value!);
    }
    return new Set(indices);
  } catch { throw new AgyUnavailable(); }
  finally {
    db?.close();
    for (const sideFd of sideFds) closeSync(sideFd);
    if (fd !== undefined) closeSync(fd);
    if (snapshot !== undefined) rmSync(snapshot, { recursive: true, force: true });
  }
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

export interface AgyProjection { segments: { start: number; end: number }[]; promptStarts: number[]; revision: string; indices: number[]; activity: "working" | "idle" }
/** The ledger's index, scanned on to the end of the file `fd` holds. */
function agyScan(path: string, fd: number): Index {
  const stat = fstatSync(fd);
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  let index = indexes.get(path);
  if (!index || index.identity !== identity || stat.size < index.size || (stat.size === index.size && changed !== index.changed)) {
    index = { identity, size: stat.size, changed, scanned: 0, revision: randomUUID(), steps: [], visible: [], retired: new Set() };
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
      const line = (carried ? Buffer.concat([...carry, bytes.subarray(start, newline)]) : bytes.subarray(start, newline)).toString("utf8");
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
      index.steps.push({ index: number, start: lineStart, end: lineEnd, type: value.type as string, status: String(value.status ?? ""), digest: hash(line), activity });
      if (index.steps.length > MAX_ENTRIES) throw new AgyUnavailable();
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
  // Once the active DB removed a displayed step, its old bytes cannot return merely
  // because the replacement DB row precedes the replacement export. Never-published
  // lagging steps remain eligible. The set is bounded by the active physical index.
  for (const step of index.visible) if (!catalog.has(step.index) && physicalStarts.has(step.start)) index.retired.add(step.start);
  const retained = index.steps.filter((step) => catalog.has(step.index) && !index.retired.has(step.start));
  const visible = retained.at(-1)?.status !== "DONE" ? retained.slice(0, -1) : retained;
  // A DB snapshot can lag an exported append. Keep the physical index intact so the
  // next poll can admit it. Only changes to already published spans invalidate paging.
  if (index.visible.some((step, at) => visible[at]?.start !== step.start || visible[at]?.end !== step.end)) index.revision = randomUUID();
  index.visible = visible;
  const segments: AgyProjection["segments"] = [];
  const promptStarts: number[] = [], indices: number[] = [];
  let length = 0;
  let activity: AgyProjection["activity"] = "idle";
  for (const step of visible) {
    if (step.activity !== undefined) activity = step.activity;
    indices.push(step.index);
    if (step.type === "USER_INPUT" && step.status === "DONE") promptStarts.push(length);
    const previous = segments.at(-1);
    if (previous?.end === step.start) previous.end = step.end;
    else segments.push({ start: step.start, end: step.end });
    length += step.end - step.start;
  }
  return { segments, promptStarts, revision: index.revision, indices, activity };
}

const historyReads = new Map<string, Promise<unknown>>();

/**
 * Keep one fd through projection and page reads, and reject a cut during the read. One read of a
 * ledger at a time: each updates the ledger's shared index, and each now waits for its catalog.
 * With `authorized`, only that file is read: another one at the path (renamed over it while this
 * read waited) is pending, for the next read to authorize afresh.
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
    if (realpathSync(path) !== path) throw new AgyUnavailable();
    const before = fstatSync(fd);
    if (authorized !== undefined && (before.dev !== authorized.dev || before.ino !== authorized.ino)) throw new ConversationReadPending();
    const index = agyScan(path, fd);
    const catalog = await agyCatalogOffThread(path);
    // forgotten or evicted while the catalog was read: parsing and output refs look it up by path
    if (indexes.get(path) !== index) {
      indexes.delete(path); indexes.set(path, index);
      if (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
    }
    const projection = agyReduce(index, catalog);
    const result = read(projection, fd);
    const current = await agyCatalogOffThread(path);
    // after the wait, so a ledger cut or replaced during it is seen
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
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = entry(line);
    if (value.status !== "DONE") continue;
    const content = typeof value.content === "string" ? value.content : "";
    const ts = typeof value.created_at === "string" ? value.created_at : null;
    if (value.type === "USER_INPUT") {
      const envelope = agyEnvelope(content);
      const skills = envelope === null ? [] : agyInvokedSkills(envelope.request, envelope.metadata).map((skill) => ({ kind: "skill" as const, skill }));
      turns.push({ role: "user", ts, parts: [{ kind: "text", text: envelope?.request ?? content }, ...skills] });
      continue;
    }
    if (value.type !== "PLANNER_RESPONSE" && value.type !== "GENERIC") continue;
    const parts: ConversationPart[] = [];
    if (value.type === "GENERIC") {
      if (!content) continue;
      // Native exports provide no call ID. Keep this result independent of planner calls.
      const part: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "Tool output", summary: `Step ${value.step_index}`, input: "", output: "" };
      const step = steps?.get(value.step_index as number);
      trimOutput(part, content, path && step ? outputRef(path, step) : `agy:${hash(line)}`);
      parts.push(part);
    } else {
      if (content) parts.push({ kind: "text", text: content });
      for (const call of Array.isArray(value.tool_calls) ? value.tool_calls : []) {
        const tool = record(call), input = record(tool.args);
        if (typeof tool.name !== "string") continue;
        const mapped = { ...input, command: input.CommandLine, file_path: input.AbsolutePath ?? input.TargetFile };
        const part: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: tool.name, summary: toolSummary(tool.name, mapped), input: JSON.stringify(input), output: "" };
        // the ledger ties no output step to its call, so a read stays requested
        const skill = tool.name === "read_file" ? skillDocument(input.Path) : null;
        if (skill) part.skill = { ...skill, status: "requested" };
        parts.push(part);
      }
    }
    if (!parts.length) continue;
    const previous = turns.at(-1);
    if (previous?.role === "assistant") { previous.parts.push(...parts); previous.end_ts = ts ?? undefined; }
    else turns.push({ role: "assistant", ts, end_ts: ts ?? undefined, parts });
  }
  return turns;
}

export async function agyToolOutput(path: string, ref: string): Promise<string | null> {
  if (!/^agy:[A-Za-z0-9_-]{43}$/.test(ref)) return null;
  try {
    return await withAgyHistory(path, (projection, fd) => {
      const visible = new Set(projection.indices);
      // forgotten (forgetAgyState) while this read waited for its catalog
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
    // every file thread busy: worth another try soon (http.ts answers 503), not a missing output
    if (error instanceof FileBusyError) throw error;
    return null;
  }
}
