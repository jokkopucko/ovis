/**
 * GET /api/pane/btw: the side conversations an OMP pane's session saved with `/btw`, for the
 * composer's side conversations chip. OMP keeps them out of its transcript, one file per topic in
 * the session's artifacts folder (the session file's path without `.jsonl`): `btw-history/entry-<id>.json`,
 * with an optional `entry-<id>.title` beside it (OMP 18.14, packages/coding-agent/src/session/btw-history.ts).
 * Only the main session's topics are read: `btw-history/sessions/` holds a focused subagent's, which
 * are another conversation. A record is taken only as OMP itself would load it (a regular file, its
 * exact fields, its id matching its name); anything else is skipped, and so is a history reached
 * through a linked folder. A read has hard caps, since the chip asks again every few seconds: the
 * folder listing stops after 2,000 entries or 200 ms, at most the hundred most recently written
 * topics are read, a topic file over 16 MiB or of more than 20,000 JSON items is skipped (items are
 * what a parse costs; a screenshot in a question is one long string, and the answer drops it), one
 * request reads at most 32 MiB, every byte read counted, a topic keeps its first 200 follow-ups, and the
 * answer stays under a megabyte. `more` says a cap left something out. Each file is read through one
 * descriptor, never following a link or opening anything but a regular file, and never past its cap.
 * A record is kept until its file changes. Statuses are shown as saved:
 * a reader cannot tell a topic still being answered from one whose writer stopped. Pictures attached
 * to a question are not sent. The dispatcher in index.ts runs the access gate first.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { OmpBtwExchange, OmpBtwHistory, OmpBtwTopic } from "../shared/protocol.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

const MAX_TOPICS = 100;
const MAX_FOLLOW_UPS = 200;
const MAX_SCAN_ENTRIES = 2000;
const MAX_SCAN_MS = 200;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_JSON_ITEMS = 20_000;
/** read-only, never through a link, and never waiting on a pipe put where a topic file was */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_BYTES = 4096;
const MAX_CACHED_HISTORIES = 16;
type Stamp = { size: number; mtimeMs: number; ctimeMs: number; ino: number };
type Cached = Stamp & { topic: Omit<OmpBtwTopic, "title"> | null; text: number; cut: boolean };
type Read = { topic: Omit<OmpBtwTopic, "title"> | null; cut: boolean };

type Bounded = { text: string | null; big: boolean; bytes: number };
function readBounded(path: string, limit: number): Bounded {
  let fd: number;
  try { fd = openSync(path, OPEN_FLAGS); } catch { return { text: null, big: false, bytes: 0 }; }
  let read = 0;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: null, big: false, bytes: 0 };
    if (stat.size > limit) return { text: null, big: true, bytes: 0 };
    const buffer = Buffer.alloc(stat.size + 1);
    for (let got = 1; got > 0 && read < buffer.length; read += got) got = readSync(fd, buffer, read, buffer.length - read, null);
    return read > stat.size ? { text: null, big: true, bytes: read } : { text: buffer.toString("utf8", 0, read), big: false, bytes: read };
  } catch {
    return { text: null, big: false, bytes: read };
  } finally {
    closeSync(fd);
  }
}

function tooManyItems(text: string): boolean {
  let items = 0;
  let inString = false;
  let opened = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index++;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (opened) {
      opened = false;
      if (code !== 0x5d && code !== 0x7d && ++items > MAX_JSON_ITEMS) return true;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x7b || code === 0x5b) {
      opened = true;
      if (++items > MAX_JSON_ITEMS) return true;
    } else if (code === 0x2c && ++items > MAX_JSON_ITEMS) return true;
  }
  return false;
}
const same = (a: Stamp, b: Stamp): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
const textOf = (topic: Omit<OmpBtwTopic, "title"> | null): number => topic === null ? 0
  : [topic, ...topic.follow_ups].reduce((sum, exchange) => sum + exchange.question.length + exchange.answer.length + (exchange.error?.length ?? 0), 0);
const cache = new Map<string, Map<string, Cached>>();
const ENTRY = /^entry-([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.json$/;
const STATUSES = new Set<string>(["running", "complete", "cancelled", "error", "interrupted"]);
const EXCHANGE_KEYS = new Set(["question", "images", "answer", "status", "createdAt", "updatedAt", "error"]);
const TOPIC_KEYS = new Set([...EXCHANGE_KEYS, "id", "leafId", "followUps"]);

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;

function exchangeOf(record: Row, keys: Set<string>): OmpBtwExchange | null {
  if (Object.keys(record).some((key) => !keys.has(key))) return null;
  const { question, answer, status, createdAt, updatedAt, error, images } = record;
  if (typeof question !== "string" || typeof answer !== "string" || typeof status !== "string" || !STATUSES.has(status)) return null;
  if (!time(createdAt) || !time(updatedAt) || (error !== undefined && typeof error !== "string") || (images !== undefined && !Array.isArray(images))) return null;
  return { question, answer, status: status as OmpBtwExchange["status"], error: error ?? null, at: new Date(createdAt).toISOString() };
}

function topicOf(path: string, id: string, limit: number): Read & { bytes: number; big: boolean } {
  const { text, big, bytes } = readBounded(path, limit);
  const none = { topic: null, cut: false, bytes, big };
  if (text === null) return none;
  if (tooManyItems(text)) return { ...none, big: true };
  try {
    const record = row(JSON.parse(text));
    if (record === null || record["id"] !== id || !(record["leafId"] === null || typeof record["leafId"] === "string")) return none;
    const head = exchangeOf(record, TOPIC_KEYS);
    const all = record["followUps"] === undefined ? [] : Array.isArray(record["followUps"]) ? record["followUps"] : null;
    const followUps = all?.slice(0, MAX_FOLLOW_UPS).map((entry) => { const found = row(entry); return found && exchangeOf(found, EXCHANGE_KEYS); }) ?? null;
    if (head === null || all === null || followUps === null || followUps.some((entry) => entry === null)) return none;
    return { topic: { id, ...head, follow_ups: followUps as OmpBtwExchange[] }, cut: all.length > MAX_FOLLOW_UPS, bytes, big: false };
  } catch {
    return none;
  }
}

function titleOf(path: string, limit: number): { title: string | null; cut: boolean; bytes: number } {
  const { text, big, bytes } = readBounded(path, limit);
  const title = text?.trim() ?? "";
  return { title: title.length > 0 ? title.slice(0, 300) : null, cut: big || title.length > 300, bytes };
}

const folder = (path: string): boolean => { try { return lstatSync(path).isDirectory(); } catch { return false; } };

type Listed = Stamp & { name: string; id: string };
function listed(directory: string): { files: Listed[]; stopped: boolean } {
  const dir = opendirSync(directory);
  const began = performance.now();
  const files: Listed[] = [];
  try {
    for (let entry = dir.readSync(), seen = 1; entry !== null; entry = dir.readSync(), seen++) {
      const id = ENTRY.exec(entry.name)?.[1];
      if (id !== undefined) {
        try {
          const stat = lstatSync(join(directory, entry.name));
          if (stat.isFile()) files.push({ name: entry.name, id, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
        } catch {
          // removed since the listing
        }
      }
      if (seen >= MAX_SCAN_ENTRIES || performance.now() - began >= MAX_SCAN_MS) return { files, stopped: dir.readSync() !== null };
    }
    return { files, stopped: false };
  } finally {
    dir.closeSync();
  }
}

export function ompBtwTopics(transcript: string): OmpBtwHistory {
  const none = { topics: [], more: false };
  if (!transcript.endsWith(".jsonl")) return none;
  const artifacts = transcript.slice(0, -".jsonl".length);
  const directory = join(artifacts, "btw-history");
  let matched: Listed[];
  let more = false;
  try {
    if (!folder(artifacts) || !folder(directory)) throw new Error("no history folder");
    const listing = listed(directory);
    matched = listing.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    more = listing.stopped;
  } catch {
    cache.delete(directory);
    return none;
  }
  if (matched.length > MAX_TOPICS) more = true;
  const files = matched.slice(0, MAX_TOPICS);
  const known = cache.get(directory);
  const kept = new Map<string, Cached>();
  let budget = MAX_READ_BYTES;
  let text = 0;
  for (const file of files) {
    const before = known?.get(file.name);
    let entry: Cached;
    if (before && same(before, file)) entry = before;
    else {
      if (file.size > MAX_FILE_BYTES || file.size > budget) { more = true; continue; }
      const read = topicOf(join(directory, file.name), file.id, Math.min(MAX_FILE_BYTES, budget));
      budget -= read.bytes;
      if (read.big) { more = true; continue; }
      const { topic, cut } = read;
      entry = { size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs, ino: file.ino, topic, text: textOf(topic), cut };
    }
    if (text + entry.text > MAX_TEXT_BYTES) { more = true; break; }
    if (entry.cut) more = true;
    text += entry.text;
    kept.set(file.name, entry);
  }
  cache.delete(directory);
  cache.set(directory, kept);
  if (cache.size > MAX_CACHED_HISTORIES) cache.delete(cache.keys().next().value!);
  const topics = [...kept.values()].flatMap(({ topic }) => {
    if (topic === null) return [];
    const { title, cut, bytes: read } = titleOf(join(directory, `entry-${topic.id}.title`), Math.min(MAX_TITLE_BYTES, budget));
    budget -= read;
    if (cut) more = true;
    return [{ ...topic, title }];
  });
  // OMP's own order: newest first, then by id
  topics.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const answered: OmpBtwTopic[] = [];
  let bytes = Buffer.byteLength('{"topics":[],"more":false}');
  for (const topic of topics) {
    const size = Buffer.byteLength(JSON.stringify(topic)) + 1;
    if (bytes + size > MAX_RESPONSE_BYTES) { more = true; continue; }
    bytes += size;
    answered.push(topic);
  }
  return { topics: answered, more };
}

export type BtwSources = { transcript: (paneId: string) => Promise<string | null> };

export async function handleBtwRequest(request: Request, url: URL, pathname: string, { transcript }: BtwSources): Promise<Response | null> {
  if (pathname !== "/api/pane/btw") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  try {
    const path = await transcript(paneId);
    const history: OmpBtwHistory = path === null ? { topics: [], more: false } : ompBtwTopics(path);
    return jsonResponse(history);
  } catch (error) {
    return errorResponse(error);
  }
}
