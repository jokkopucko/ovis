import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, readSync } from "node:fs";
import { imageType, inlineImageType, MAX_IMAGE_BYTES } from "./codex-images.ts";
import { openCopilotFile } from "./copilot-store.ts";
import { MAX_TURNS, toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const CALL_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const OUTPUT_REF = /^([A-Za-z0-9_:.-]{1,128})@([0-9a-z]+)@([0-9a-z]+)@([0-9a-f]{32})$/;
const RECORD_MAX = 8 * 1024 * 1024;
const outputKey = randomBytes(32);

function outputSeal(id: string, requestAt: number, resultAt: number, request: string, result: string): string {
  return createHmac("sha256", outputKey).update(`${id}\0${requestAt}\0${resultAt}\0`)
    .update(request).update("\0").update(result).digest("hex").slice(0, 32);
}

function outputRef(id: string, requestAt: number, resultAt: number, request: string, result: string): string {
  return `${id}@${requestAt.toString(36)}@${resultAt.toString(36)}@${outputSeal(id, requestAt, resultAt, request, result)}`;
}

/**
 * A picture Copilot interned in its session: the CLI writes a picture's bytes once, as base64 in a
 * `session.binary_asset` record named `sha256:<digest of the bytes>`, and a prompt's attachments and a
 * tool's `binaryResultsForLlm` name it by that id (1.0.105). The chat names it `copilot:<digest>`.
 */
export const COPILOT_IMAGE_REF = /^copilot:([a-f0-9]{64})$/;
const ASSET_ID = /^sha256:([a-f0-9]{64})$/;
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The pictures `values` name by an interned asset, in order and each once: declared a raster the chat
 * shows, within the size the image endpoint serves. Only the name is read here; copilotImage checks
 * the bytes it serves. `kind` holds a tool's results to its images (a prompt's attachments are files
 * or blobs, told apart by their type instead).
 */
function assetPictures(values: unknown, kind?: "image"): { media_type: string; ref: string }[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const asset = row(value);
    const digest = typeof asset?.assetId === "string" ? ASSET_ID.exec(asset.assetId)?.[1] : undefined;
    if (asset === null || digest === undefined || (kind !== undefined && asset.type !== kind)
      || typeof asset.mimeType !== "string" || !RASTER_TYPES.has(asset.mimeType)
      || (typeof asset.byteLength === "number" && asset.byteLength > MAX_IMAGE_BYTES)) return [];
    const ref = `copilot:${digest}`;
    if (seen.has(ref)) return [];
    seen.add(ref);
    return [{ media_type: asset.mimeType, ref }];
  });
}

/** The pictures a prompt carries: its attachments Copilot interned as pictures. */
export function copilotPromptPictures(data: unknown): { media_type: string; ref: string }[] {
  return assetPictures(row(data)?.attachments);
}

/** Whether a root `user.message`'s data opens a turn: it has words, or pictures (the parser draws either). */
export function copilotPromptOpens(data: unknown): boolean {
  const content = row(data)?.content;
  return typeof content === "string" && (!!content.trim() || copilotPromptPictures(data).length > 0);
}

/** The longest record copilotImage reads: a picture of MAX_IMAGE_BYTES as base64, and room for its fields. */
const ASSET_RECORD_MAX = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;
const ASSET_WINDOW = 1024 * 1024;

/** The lines of the file open at `fd`, from its start, the last one too when no newline ends it, each at most ASSET_RECORD_MAX bytes: a longer one is dropped as it is read. */
async function* boundedLines(fd: number): AsyncGenerator<string> {
  const window = Buffer.alloc(ASSET_WINDOW);
  let pieces: Buffer[] = [];
  let length = 0;
  let oversized = false;
  for (let position = 0; ;) {
    const count = readSync(fd, window, 0, window.length, position);
    if (count === 0) {
      if (!oversized && length > 0) yield Buffer.concat(pieces, length).toString("utf8");
      return;
    }
    position += count;
    for (let at = 0; at < count;) {
      const newline = window.subarray(0, count).indexOf(0x0a, at);
      const end = newline < 0 ? count : newline;
      if (!oversized && length + end - at <= ASSET_RECORD_MAX) { pieces.push(Buffer.from(window.subarray(at, end))); length += end - at; }
      else { oversized = true; pieces = []; length = 0; }
      if (newline < 0) break;
      if (!oversized) yield Buffer.concat(pieces, length).toString("utf8");
      pieces = []; length = 0; oversized = false;
      at = newline + 1;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * The picture `ref` names in the Copilot transcript `path`, from the root `session.binary_asset`
 * record that interned it, and only when its bytes are a raster within MAX_IMAGE_BYTES (inlineImageType,
 * as the other agents' inline pictures) that hash to the digest the ref names. The transcript is opened
 * pinned as the page reads it (openCopilotFile) and read a window at a time, the event loop running
 * between windows; a line longer than the largest picture record it could serve is skipped without
 * being held, and a line that does not name the digest is never parsed. Null for anything else.
 */
export async function copilotImage(path: string, ref: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const digest = COPILOT_IMAGE_REF.exec(ref)?.[1];
  if (digest === undefined) return null;
  let fd: number;
  try { fd = openCopilotFile(path); } catch { return null; }
  try {
    for await (const line of boundedLines(fd)) {
      if (!line.includes('"session.binary_asset"') || !line.includes(digest)) continue;
      let entry: Row | null;
      try { entry = row(JSON.parse(line)); } catch { continue; }
      const data = row(entry?.data);
      if (entry?.type !== "session.binary_asset" || !copilotRootRecord(entry) || data === null
        || data.assetId !== `sha256:${digest}` || data.type !== "image") continue;
      const declared = inlineImageType(data.mimeType, data.data);
      if (declared === null) continue;
      const bytes = Buffer.from(data.data as string, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== digest || imageType(bytes) !== declared) continue;
      return { mediaType: declared, bytes: new Uint8Array(bytes) };
    }
  } catch { return null; }
  finally { closeSync(fd); }
  return null;
}

/** A task parent can occur on a root prompt; only agent identity marks a child. */
export function copilotRootRecord(value: unknown): boolean {
  const entry = row(value);
  return entry !== null && entry.agentId == null && row(entry.data)?.agentId == null;
}

/** Lines written by the CLI, not its ephemeral streaming updates or nested agents. */
export function copilotRecords(jsonl: string, strict = false, baseOffset?: number): { type: string; data: Row; timestamp: string | null; offset?: number; raw?: string }[] {
  const records: { type: string; data: Row; timestamp: string | null; offset?: number; raw?: string }[] = [];
  const lines = jsonl.split("\n");
  let offset = baseOffset ?? 0;
  for (const [index, line] of lines.entries()) {
    const at = offset;
    if (baseOffset !== undefined) offset += Buffer.byteLength(line) + 1;
    // a checked picture record the newest-turn cache keeps only the length of (copilotSetAside)
    const setAside = SET_ASIDE.exec(line);
    if (setAside !== null) { offset += Number(setAside[1]) - Buffer.byteLength(line); continue; }
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      // An unfinished final append is retried; complete unreadable records are
      // not proof of an empty conversation.
      if (strict && index < lines.length - 1) throw new ConversationUnavailable("transcript_unreadable");
      continue;
    }
    const entry = row(value);
    if (!entry || typeof entry.type !== "string") {
      if (strict) throw new ConversationUnavailable("transcript_unreadable");
      continue;
    }
    if (!copilotRootRecord(entry)) continue;
    const data = row(entry.data);
    if (data === null) {
      if (strict) throw new ConversationUnavailable("transcript_unreadable");
      continue;
    }
    records.push({ type: entry.type, data, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      ...(baseOffset === undefined ? {} : { offset: at, raw: line }) });
  }
  return records;
}

/** A line copilotSetAside stands in for: the byte length of the record it replaces, behind a mark made for this process that no file holds. */
const SET_ASIDE_MARK = `\u0000copilot-set-aside:${randomBytes(16).toString("hex")}:`;
const SET_ASIDE = new RegExp(`^${SET_ASIDE_MARK}(\\d{1,10})$`);

/**
 * A picture record (`session.binary_asset`) a page keeps in memory as its length only, once it has been
 * checked whole as the page parser would read it: the parser never reads one, and copilotRecords keeps
 * every later record's offset. Any other line, or one that does not parse, is returned as it is.
 */
export function copilotSetAside(line: string): string {
  if (!line.startsWith('{"type":"session.binary_asset",')) return line;
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return line; }
  return row(entry)?.type === "session.binary_asset" && row(row(entry)?.data) !== null ? `${SET_ASIDE_MARK}${Buffer.byteLength(line)}` : line;
}

/** Convert persisted Copilot CLI turns to the shared, read-only chat shape. */
export function parseCopilotTranscript(jsonl: string, maxTurns = MAX_TURNS, baseOffset?: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, { part: Extract<ConversationPart, { kind: "tool" }>; requestAt?: number; request?: string }>();
  const completionTools = new Map<string, string>();
  let finished = false;
  let completion: string | null = null;
  const flushCompletion = (): void => {
    const last = turns.at(-1);
    const lastText = last?.parts.filter((part) => part.kind === "text").at(-1);
    if (completion !== null && last?.role === "assistant") {
      if (lastText?.kind === "text" && lastText.text === completion) lastText.phase = "final_answer";
      else if (!last.parts.some((part) => part.kind === "text" && part.phase === "final_answer")) {
        last.parts.push({ kind: "text", text: completion, phase: "final_answer" });
      }
    }
    completion = null;
  };
  const assistant = (ts: string | null): ConversationTurn => {
    const last = turns.at(-1);
    if (last?.role === "assistant" && !finished) return last;
    const turn: ConversationTurn = { role: "assistant", ts, parts: [] };
    turns.push(turn);
    finished = false;
    return turn;
  };
  const addTool = (data: Row, ts: string | null, name: string, intention: string | null = null, at?: number, raw?: string): void => {
    const id = data.toolCallId;
    if (typeof id !== "string" || !CALL_ID.test(id) || pending.has(id)) return;
    const rawArgs = data.arguments;
    let args = row(rawArgs) ?? {};
    if (typeof rawArgs === "string") {
      try { args = row(JSON.parse(rawArgs)) ?? {}; } catch { /* Preserve raw input even when it cannot summarize a call. */ }
    }
    const part: Extract<ConversationPart, { kind: "tool" }> = {
      kind: "tool", name, summary: text(data.toolTitle) ?? intention ?? toolSummary(name, args),
      input: (typeof rawArgs === "string" ? rawArgs : JSON.stringify(args, null, 2)).slice(0, 16_000), output: "",
    };
    assistant(ts).parts.push(part);
    pending.set(id, { part, requestAt: at, request: raw });
    const summary = text(args.summary);
    if (name === "task_complete" && summary !== null) completionTools.set(id, summary);
  };
  for (const { type, data, timestamp, offset, raw } of copilotRecords(jsonl, true, baseOffset)) {
    if (type === "user.message") {
      if (typeof data.content !== "string") throw new ConversationUnavailable("transcript_unreadable");
      const content = text(data.content);
      const pictures = copilotPromptPictures(data).map((picture) => ({ kind: "image" as const, ...picture }));
      // a prompt that is only pictures is a turn too (copilotPromptOpens)
      if (content !== null || pictures.length > 0) {
        flushCompletion();
        turns.push({ role: "user", ts: timestamp, parts: [...content === null ? [] : [{ kind: "text" as const, text: content }], ...pictures] });
        pending.clear();
        completionTools.clear();
        finished = false;
      }
    } else if (type === "assistant.message") {
      if ((data.content != null && typeof data.content !== "string")
        || (data.content == null && !Array.isArray(data.toolRequests))
        || (data.toolRequests !== undefined && !Array.isArray(data.toolRequests))) throw new ConversationUnavailable("transcript_unreadable");
      const content = text(data.content);
      const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      if (content === null && requests.length === 0) continue;
      const turn = assistant(timestamp);
      if (timestamp !== null) turn.end_ts = timestamp;
      if (content !== null) turn.parts.push({
        kind: "text", text: content,
        ...(data.phase === "final_answer" || data.phase === "commentary" ? { phase: data.phase } : {}),
      });
      for (const candidate of requests) {
        const request = row(candidate);
        const name = text(request?.name);
        if (request === null || typeof request.toolCallId !== "string" || !CALL_ID.test(request.toolCallId)
          || name === null || (request.arguments != null && typeof request.arguments !== "string" && row(request.arguments) === null)) {
          throw new ConversationUnavailable("transcript_unreadable");
        }
        addTool(request, timestamp, name, text(request.intentionSummary), offset, raw);
      }
      if (data.phase === "final_answer") finished = true;
    } else if (type === "tool.execution_start") {
      addTool(data, timestamp, text(data.toolName) ?? "tool", null, offset, raw);
    } else if (type === "tool.execution_complete") {
      const id = data.toolCallId;
      const call = typeof id === "string" ? pending.get(id) : undefined;
      if (!call || typeof id !== "string") continue;
      const output = text(row(data.result)?.content) ?? "";
      const ref = call.requestAt !== undefined && call.request !== undefined && offset !== undefined && raw !== undefined
        && Buffer.byteLength(call.request) <= RECORD_MAX && Buffer.byteLength(raw) <= RECORD_MAX
        ? outputRef(id, call.requestAt, offset, call.request, raw) : id;
      trimOutput(call.part, output, ref);
      const images = assetPictures(row(data.result)?.binaryResultsForLlm, "image");
      if (images.length > 0) call.part.images = images;
      if (data.success === false) call.part.error = true;
      if (data.success !== false && completionTools.has(id)) completion ??= completionTools.get(id)!;
      pending.delete(id);
      completionTools.delete(id);
    } else if (type === "session.task_complete") {
      if (turns.length && turns.at(-1)?.role === "user") assistant(timestamp);
      completion = text(data.summary) ?? completion;
    } else if (type === "assistant.turn_end") {
      const last = turns.at(-1);
      if (last?.role === "assistant" && timestamp !== null) last.end_ts = timestamp;
    }
  }
  flushCompletion();
  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

function recordAt(fd: number, position: number): string | null {
  const chunk = Buffer.alloc(64 * 1024);
  const pieces: Buffer[] = [];
  let length = 0;
  while (length <= RECORD_MAX) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, RECORD_MAX + 1 - length), position + length);
    if (count === 0) break;
    const newline = chunk.subarray(0, count).indexOf(0x0a);
    const end = newline < 0 ? count : newline;
    pieces.push(Buffer.from(chunk.subarray(0, end)));
    length += end;
    if (newline >= 0) break;
  }
  if (length > RECORD_MAX) return null;
  return Buffer.concat(pieces, length).toString("utf8");
}

/** Read exactly the two root records the page paired, without searching intervening history. */
export function copilotOffsetOutput(fd: number, ref: string, outputMax: number): string | null {
  const match = OUTPUT_REF.exec(ref);
  if (!match) return null;
  const [, id, requestText, resultText, seal] = match;
  const requestAt = parseInt(requestText!, 36);
  const resultAt = parseInt(resultText!, 36);
  if (!Number.isSafeInteger(requestAt) || !Number.isSafeInteger(resultAt) || requestAt < 0 || resultAt <= requestAt
    || requestAt.toString(36) !== requestText || resultAt.toString(36) !== resultText) return null;
  const request = recordAt(fd, requestAt);
  const result = recordAt(fd, resultAt);
  if (request === null || result === null) return null;
  const expected = Buffer.from(outputSeal(id!, requestAt, resultAt, request, result), "hex");
  if (!timingSafeEqual(expected, Buffer.from(seal!, "hex"))) return null;
  let asked: Row | null;
  let answered: Row | null;
  try { asked = row(JSON.parse(request)); answered = row(JSON.parse(result)); }
  catch { return null; }
  if (!copilotRootRecord(asked) || !copilotRootRecord(answered)) return null;
  const data = row(asked?.data);
  const requested = asked?.type === "assistant.message" && Array.isArray(data?.toolRequests)
    ? data.toolRequests.some((value) => row(value)?.toolCallId === id)
    : asked?.type === "tool.execution_start" && data?.toolCallId === id;
  if (!requested || answered?.type !== "tool.execution_complete") return null;
  const completion = row(answered.data);
  if (completion === null || completion.toolCallId !== id) return null;
  const content = row(completion.result)?.content;
  return typeof content === "string" ? content.length > outputMax ? `${content.slice(0, outputMax)}\n… trimmed` : content : null;
}

/**
 * Legacy direct ID lookup, retained for callers of transcriptToolOutput; pane refs
 * carry signed offsets instead. Scan a pinned descriptor forward in 64 KiB reads,
 * holding at most one 8 MiB record.
 * Oversized unrelated lines are discarded without parsing; an oversized line that
 * mentions the requested ID fails closed. I/O is linear up to the first result (or
 * EOF for a missing ID), capped at 32 MiB total on the server event loop.
 */
export function copilotOutput(fd: number, ref: string, outputMax: number): string | null {
  if (!CALL_ID.test(ref)) return null;
  const chunk = Buffer.alloc(64 * 1024);
  const needle = Buffer.from(JSON.stringify(ref));
  const recordMax = RECORD_MAX;
  let pieces: Buffer[] = [];
  let length = 0;
  let oversized = false;
  let mentionsRef = false;
  let overlap = Buffer.alloc(0);
  let requested = false;
  const consume = (): string | null | undefined => {
    if (oversized) return mentionsRef ? null : undefined;
    if (!mentionsRef) return undefined;
    let entry: Row | null;
    try { entry = row(JSON.parse(Buffer.concat(pieces, length).toString("utf8"))); }
    catch { return undefined; }
    if (!copilotRootRecord(entry)) return undefined;
    const data = row(entry?.data);
    if (data === null) return undefined;
    if (entry?.type === "assistant.message" && Array.isArray(data.toolRequests)) {
      requested ||= data.toolRequests.some((value) => row(value)?.toolCallId === ref);
    }
    if (entry?.type === "tool.execution_start" && data.toolCallId === ref) requested = true;
    if (entry?.type !== "tool.execution_complete" || data.toolCallId !== ref) return undefined;
    if (!requested) return null;
    const content = row(data.result)?.content;
    return typeof content === "string" ? content.length > outputMax ? `${content.slice(0, outputMax)}\n… trimmed` : content : null;
  };
  const scanMax = 32 * 1024 * 1024;
  for (let scanned = 0; scanned < scanMax;) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, scanMax - scanned), null);
    if (count === 0) return consume() ?? null;
    scanned += count;
    for (let at = 0; at < count;) {
      const newline = chunk.indexOf(0x0a, at);
      const end = newline < 0 || newline >= count ? count : newline;
      const segment = chunk.subarray(at, end);
      // Keep the needle's trailing bytes so a call ID split across reads is still detected.
      const search = overlap.length ? Buffer.concat([overlap, segment]) : segment;
      if (search.includes(needle)) mentionsRef = true;
      overlap = Buffer.from(search.subarray(Math.max(0, search.length - needle.length + 1)));
      if (!oversized && length + segment.length <= recordMax) { pieces.push(Buffer.from(segment)); length += segment.length; }
      else { oversized = true; pieces = []; length = 0; }
      if (newline < 0 || newline >= count) break;
      const result = consume();
      if (result !== undefined) return result;
      pieces = []; length = 0; oversized = false; mentionsRef = false; overlap = Buffer.alloc(0);
      at = newline + 1;
    }
  }
  // The limit can cut a record: never interpret that prefix as a complete one.
  return null;
}
