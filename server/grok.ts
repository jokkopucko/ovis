/** Grok's native update log, projected onto active history before the shared pager reads it. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ConversationPart, ConversationTurn, ConversationResponse } from "../shared/protocol.ts";
import { imageType, inlineImageType } from "./codex-images.ts";
import { toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
const MAX_LINE = 16 * 1024 * 1024;
const SCAN_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
export const GROK_TOOL_REF = /^grok:[A-Za-z0-9_-]{43}$/;
export class GrokUnavailable extends Error {
  constructor() { super("Grok history cannot be reconstructed"); this.name = "GrokUnavailable"; }
}

export interface GrokEvent { update: RecordValue; session: string; ts: string | null }
/** Validate the envelope, not a substring that could also occur inside tool output. */
export function grokEvent(line: string, expectedSession?: string): GrokEvent | null {
  if (!line.trim()) return null;
  let value: RecordValue;
  try { value = record(JSON.parse(line)); } catch { throw new GrokUnavailable(); }
  if (value.method !== "session/update" && value.method !== "_x.ai/session/update") return null;
  const params = record(value.params);
  if (typeof params.sessionId !== "string" || (expectedSession !== undefined && params.sessionId !== expectedSession)) throw new GrokUnavailable();
  const update = record(params.update);
  if (typeof update.sessionUpdate !== "string") throw new GrokUnavailable();
  const ms = record(params._meta).agentTimestampMs;
  const time = typeof ms === "number" ? ms : typeof value.timestamp === "number" ? value.timestamp * 1000 : NaN;
  const ts = Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null;
  return { update, session: params.sessionId, ts };
}

interface Prompt { index: number; start: number; end: number; answered: boolean; calls: Set<string>; activity: NonNullable<ConversationResponse["activity"]> }
interface Call { owner: Prompt; revision: number; digest: string }
interface Index {
  identity: string; changed: string; size: number; scanned: number; revision: number;
  prompts: Prompt[]; calls: Map<string, Call>; failed: boolean;
}
const indexes = new Map<string, Index>();
export function forgetGrokState(path?: string): void {
  if (path === undefined) indexes.clear(); else indexes.delete(path);
}

function apply(index: Index, event: GrokEvent | null, start: number, end: number): void {
  const u = event?.update;
  let current = index.prompts.at(-1);
  if (u?.sessionUpdate === "rewind_marker") {
    const target = u.target_prompt_index;
    if (!Number.isSafeInteger(target) || (target as number) < 0 || !index.prompts.some((p) => p.index === target)) throw new GrokUnavailable();
    while (index.prompts.length && index.prompts.at(-1)!.index >= (target as number)) {
      const removed = index.prompts.pop()!;
      for (const id of removed.calls) index.calls.delete(id);
    }
    // Marker-only rewinds can shorten the sole range without changing its start.
    index.revision = end;
    return;
  }
  if (u?.sessionUpdate === "user_message_chunk") {
    const number = record(u._meta).promptIndex;
    if (!Number.isSafeInteger(number) || (number as number) < 0) throw new GrokUnavailable();
    if (current && current.index === number) {
      // Multiple chunks of one prompt precede its answer. Reused indices after an answer
      // require an explicit rewind; otherwise their boundaries cannot be established.
      if (current.answered) throw new GrokUnavailable();
    } else {
      if (current && (number as number) <= current.index) throw new GrokUnavailable();
      current = { index: number as number, start, end, answered: false, calls: new Set(), activity: "working" };
      index.prompts.push(current);
    }
  }
  if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
    const id = u.toolCallId;
    if (!current || typeof id !== "string" || id.length === 0 || id.length > 1024) throw new GrokUnavailable();
    if (u.sessionUpdate === "tool_call") {
      if (index.calls.has(id)) throw new GrokUnavailable();
      current.calls.add(id);
      index.calls.set(id, { owner: current, revision: end, digest: hash(JSON.stringify(u)) });
    } else {
      const call = index.calls.get(id);
      if (!call || call.owner !== current) throw new GrokUnavailable();
      call.revision = end;
      call.digest = hash(call.digest + JSON.stringify(u));
    }
  }
  if (current) {
    if (u?.sessionUpdate === "turn_completed") current.activity = "idle";
    else if (u?.sessionUpdate === "agent_thought_chunk") current.activity = "thinking";
    else if (u && ["agent_message_chunk", "tool_call"].includes(String(u.sessionUpdate))) current.activity = "working";
    // Background tool updates after completion must not reopen a finished turn.
    // A retained prompt ends before a rewind marker, not at the following replacement.
    // Only physically adjacent records extend its segment.
    if (current.end === start || current.start === start) current.end = end;
    else if (u && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "turn_completed"].includes(String(u.sessionUpdate))) throw new GrokUnavailable();
    if (u && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "turn_completed"].includes(String(u.sessionUpdate))) current.answered = true;
  } else if (u && ["agent_message_chunk", "tool_call", "tool_call_update"].includes(String(u.sessionUpdate))) throw new GrokUnavailable();
  if (index.prompts.length + index.calls.size > MAX_ENTRIES) throw new GrokUnavailable();
}

export interface GrokProjection {
  activity: NonNullable<ConversationResponse["activity"]>;
  segments: { start: number; end: number }[];
  promptStarts: number[];
  revision: string;
}

/** Scan complete records once in bounded chunks. An unfinished catch-up is unavailable,
 * never a partially validated history. The next poll continues the same scan. Size,
 * identity and change all come from the caller's one stat, so an append between two
 * stats cannot reset a finished scan. */
export function grokProjection(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): GrokProjection {
  const { size } = stat;
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  let index = indexes.get(path);
  if (!index || index.identity !== identity || size < index.size || (size === index.size && changed !== index.changed)) {
    index = { identity, changed, size, scanned: 0, revision: 0, prompts: [], calls: new Map(), failed: false };
  }
  index.size = size; index.changed = changed;
  indexes.delete(path); indexes.set(path, index);
  if (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
  // Known limitation: one malformed or unreconstructable record keeps this file on the
  // terminal view until it is replaced or shrinks. Skipping the line could misplace a rewind.
  if (index.failed) throw new GrokUnavailable();
  const fd = openSync(path, "r");
  let position = index.scanned;
  let carry: Buffer[] = [];
  let carried = 0;
  const deadline = Math.min(size, position + SCAN_BYTES);
  try {
    while (position < deadline) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, deadline - position));
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (!read) throw new GrokUnavailable();
      const bytes = chunk.subarray(0, read);
      let offset = 0;
      for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, offset)) {
        if (carried + newline - offset > MAX_LINE) throw new GrokUnavailable();
        const line = carried ? Buffer.concat([...carry, bytes.subarray(offset, newline)]) : bytes.subarray(offset, newline);
        const start = position + offset - carried;
        const end = position + newline + 1;
        apply(index, grokEvent(line.toString("utf8"), basename(dirname(path))), start, end);
        index.scanned = end;
        carry = []; carried = 0;
        offset = newline + 1;
      }
      if (offset < bytes.length) { carry.push(bytes.subarray(offset)); carried += bytes.length - offset; }
      if (carried > MAX_LINE) throw new GrokUnavailable();
      position += read;
    }
  } catch (error) { index.failed = true; throw error; }
  finally { closeSync(fd); }
  if (position < size) throw new GrokUnavailable();
  const segments: GrokProjection["segments"] = [];
  const promptStarts: number[] = [];
  let length = 0;
  for (const prompt of index.prompts) {
    promptStarts.push(length);
    const previous = segments.at(-1);
    if (previous?.end === prompt.start) previous.end = prompt.end;
    else segments.push({ start: prompt.start, end: prompt.end });
    length += prompt.end - prompt.start;
  }
  return { segments, promptStarts, revision: index.revision.toString(36), activity: index.prompts.at(-1)?.activity ?? "idle" };
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    const content = record(block.content);
    if (block.type === "content" && content.type === "text" && typeof content.text === "string") return content.text;
    if (block.type === "diff") return `--- ${typeof block.path === "string" ? block.path : ""}\n${typeof block.oldText === "string" ? block.oldText : ""}\n+++ ${typeof block.path === "string" ? block.path : ""}\n${typeof block.newText === "string" ? block.newText : ""}`;
    // This is a native reference, not terminal output we have fetched via ACP.
    if (block.type === "terminal" && typeof block.terminalId === "string") return JSON.stringify(block);
    return "";
  }).filter(Boolean).join("\n");
}

function outputRef(path: string, id: string): string {
  const index = indexes.get(path);
  const call = index?.calls.get(id);
  if (!index || !call) throw new GrokUnavailable();
  return `grok:${hash(JSON.stringify([path, index.identity, index.revision, id, call.revision, call.digest]))}`;
}

type Tool = Extract<ConversationPart, { kind: "tool" }>;
/** Pages contain complete prompts. A bounded mid-prompt page without its call seed fails
 * rather than manufacturing tool metadata or silently dropping native updates. */
export function parseGrokTranscript(text: string, path?: string, wholeCall?: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let user: ConversationTurn | undefined;
  let assistant: ConversationTurn | undefined;
  let prompt: number | undefined;
  const calls = new Map<string, { fields: RecordValue; part: Tool; diffs: Map<string, RecordValue> }>();
  const appendText = (turn: ConversationTurn, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const last = turn.parts.at(-1);
    if (last?.kind === "text") last.text += value; else turn.parts.push({ kind: "text", text: value });
  };
  for (const line of text.split("\n")) {
    const event = grokEvent(line, path ? basename(dirname(path)) : undefined);
    if (!event) continue;
    const u = event.update;
    const meta = record(u._meta);
    if (u.sessionUpdate === "rewind_marker") throw new GrokUnavailable();
    if (u.sessionUpdate === "turn_completed") {
      const last = assistant?.parts.at(-1);
      if (last?.kind === "text") last.phase = "final_answer";
      assistant = undefined; continue;
    }
    if (u.sessionUpdate === "user_message_chunk") {
      if (!Number.isSafeInteger(meta.promptIndex)) throw new GrokUnavailable();
      if (prompt !== meta.promptIndex) {
        prompt = meta.promptIndex as number;
        user = { role: "user", ts: event.ts, parts: [] };
        assistant = undefined; calls.clear(); turns.push(user);
      }
      if (meta.hideFromScrollback !== true) appendText(user!, record(u.content).text);
      for (const picture of updatePictures(u)) user!.parts.push({ kind: "image", media_type: picture.mediaType, ref: `grok-image:${digestOf(picture.data)}` });
      continue;
    }
    if (!["agent_message_chunk", "tool_call", "tool_call_update"].includes(String(u.sessionUpdate))) continue;
    if (prompt === undefined) throw new GrokUnavailable();
    if (!assistant) { assistant = { role: "assistant", ts: event.ts, parts: [] }; turns.push(assistant); }
    if (event.ts !== null) assistant.end_ts = event.ts;
    if (u.sessionUpdate === "agent_message_chunk") { appendText(assistant, record(u.content).text); continue; }
    const id = u.toolCallId;
    if (typeof id !== "string") throw new GrokUnavailable();
    let call = calls.get(id);
    if (u.sessionUpdate === "tool_call") {
      if (call) throw new GrokUnavailable();
      call = { fields: {}, part: { kind: "tool", name: "", summary: "", input: "", output: "" }, diffs: new Map() };
      calls.set(id, call); assistant.parts.push(call.part);
    }
    if (!call) throw new GrokUnavailable();
    for (const [key, value] of Object.entries(u)) {
      // ACP optional nullable raw fields and name use null for "unchanged".
      if (value === null && ["rawInput", "rawOutput", "name"].includes(key)) continue;
      call.fields[key] = value;
    }
    const fields = call.fields;
    const input = record(fields.rawInput);
    const name = fields.name ?? record(record(fields._meta)["x.ai/tool"]).name;
    call.part.name = typeof name === "string" ? name
      : fields.kind === "search" && (input.variant === "WebSearch" || input.variant === "XSearch") ? input.variant
      : typeof fields.kind === "string" ? fields.kind : id;
    call.part.summary = typeof fields.title === "string" && fields.title ? fields.title.slice(0, 120) : toolSummary(call.part.name, input);
    call.part.input = typeof fields.rawInput === "string" ? fields.rawInput : fields.rawInput === undefined ? "" : JSON.stringify(fields.rawInput);
    call.part.error = fields.status === "failed";
    // ACP replaces content as a whole. Keep the edit evidence separately so a later
    // completion message cannot erase a diff that the tool already displayed.
    const content = Array.isArray(fields.content) ? fields.content : [];
    for (const value of content) {
      const block = record(value);
      if (block.type === "diff") call.diffs.set(hash(JSON.stringify(block)), block);
    }
    const output = outputText([...call.diffs.values(), ...content.filter((block) => record(block).type !== "diff")]);
    const images = [...new Set(updatePictures(fields).map((picture) => `${picture.mediaType}\0grok-image:${digestOf(picture.data)}`))]
      .map((key) => ({ media_type: key.slice(0, key.indexOf("\0")), ref: key.slice(key.indexOf("\0") + 1) }));
    if (images.length > 0) call.part.images = images; else delete call.part.images;
    delete call.part.output_ref; delete call.part.output_size;
    if (wholeCall === id) call.part.output = output.length > 2_000_000 ? `${output.slice(0, 2_000_000)}\n… trimmed` : output;
    else trimOutput(call.part, output, path ? outputRef(path, id) : `grok:${hash(id + output)}`);
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

export function grokToolOutput(path: string, ref: string): string | null {
  if (!GROK_TOOL_REF.test(ref)) return null;
  try {
    grokProjection(path, statSync(path));
    const index = indexes.get(path)!;
    for (const [id, call] of index.calls) {
      if (outputRef(path, id) !== ref) continue;
      const length = call.owner.end - call.owner.start;
      if (length > 64 * 1024 * 1024) return null;
      const fd = openSync(path, "r");
      try {
        const bytes = Buffer.alloc(length);
        if (readSync(fd, bytes, 0, length, call.owner.start) !== length) return null;
        const turns = parseGrokTranscript(bytes.toString("utf8"), path, id);
        // Tool order follows first tool_call records, including calls with no output yet.
        const at = [...call.owner.calls].indexOf(id);
        return turns.flatMap((turn) => turn.parts).filter((part): part is Tool => part.kind === "tool")[at]?.output ?? null;
      } finally { closeSync(fd); }
    }
  } catch { /* changed, incomplete or unavailable history */ }
  return null;
}

/**
 * A picture Grok holds inline in its update log: a prompt's `{ type: "image", data, mimeType }` chunk,
 * or one in a tool update's content (`{ type: "content", content: { type: "image", ... } }`), as ACP
 * writes them (1.0.67). The chat names it `grok-image:<sha256 of its bytes>`.
 */
export const GROK_IMAGE_REF = /^grok-image:([a-f0-9]{64})$/;

/** The pictures `blocks` carry that the chat shows: a raster declared as one, within MAX_IMAGE_BYTES (inlineImageType). */
function pictures(blocks: unknown[]): { mediaType: string; data: string }[] {
  return blocks.flatMap((block) => {
    const image = record(block);
    const mediaType = image.type === "image" ? inlineImageType(image.mimeType, image.data) : null;
    return mediaType === null ? [] : [{ mediaType, data: image.data as string }];
  });
}

/** The pictures one update carries: a visible prompt chunk's, or a tool update's content blocks'. */
function updatePictures(u: RecordValue): { mediaType: string; data: string }[] {
  if (u.sessionUpdate === "user_message_chunk") return record(u._meta).hideFromScrollback === true ? [] : pictures([u.content]);
  if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update" || !Array.isArray(u.content)) return [];
  return pictures(u.content.flatMap((block) => record(block).type === "content" ? [record(block).content] : []));
}

const digestOf = (data: string): string => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");

/** How much of the update log the image lookup reads at a time, the event loop running between windows. */
const IMAGE_WINDOW = 1024 * 1024;

/** The lines in [start, end) of the file open at `fd`, each with its byte offset, read a window at a time. */
async function* segmentLines(fd: number, start: number, end: number): AsyncGenerator<{ line: string; at: number }> {
  const window = Buffer.alloc(IMAGE_WINDOW);
  let pieces: Buffer[] = [];
  let length = 0;
  let lineStart = start;
  for (let position = start; position < end;) {
    const read = readSync(fd, window, 0, Math.min(window.length, end - position), position);
    if (read === 0) throw new GrokUnavailable();
    for (let offset = 0; offset < read;) {
      const newline = window.subarray(0, read).indexOf(10, offset);
      const stop = newline === -1 ? read : newline;
      // the projection holds every record to MAX_LINE: a longer one means the file changed under it
      if (length + stop - offset > MAX_LINE) throw new GrokUnavailable();
      pieces.push(Buffer.from(window.subarray(offset, stop)));
      length += stop - offset;
      if (newline === -1) break;
      yield { line: Buffer.concat(pieces, length).toString("utf8"), at: lineStart };
      pieces = []; length = 0;
      lineStart = position + newline + 1;
      offset = newline + 1;
    }
    position += read;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * The picture `ref` names in the Grok update log `path`, read only from the prompts its active
 * history keeps (grokProjection: a prompt rewound away serves nothing, also when it is rewound while
 * the lookup reads), and only when its bytes are a raster within MAX_IMAGE_BYTES that hash to the
 * digest the ref names. The log is read a window at a time. Null for anything else.
 */
export async function grokImage(path: string, ref: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const digest = GROK_IMAGE_REF.exec(ref)?.[1];
  if (digest === undefined) return null;
  try {
    if (realpathSync(path) !== path) return null;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const { segments, revision } = grokProjection(path, statSync(path));
      // the file read is the one the projection checked, not one moved into its path since
      const opened = fstatSync(fd);
      const named = statSync(path);
      if (opened.dev !== named.dev || opened.ino !== named.ino) return null;
      for (const segment of segments) {
        for await (const { line, at } of segmentLines(fd, segment.start, segment.end)) {
          // a picture's type is written "image", or with JSON escapes in it
          if (!line.includes('"image"') && !line.includes("\\u")) continue;
          const event = grokEvent(line, basename(dirname(path)));
          for (const picture of event === null ? [] : updatePictures(event.update)) {
            if (digestOf(picture.data) !== digest) continue;
            const data = Buffer.from(picture.data, "base64");
            if (imageType(data) !== picture.mediaType) return null;
            // the history may have moved while the lookup read: the record must still be active
            const current = statSync(path);
            if (current.dev !== opened.dev || current.ino !== opened.ino) return null;
            const now = grokProjection(path, current);
            if (now.revision !== revision || !now.segments.some((kept) => kept.start <= at && at < kept.end)) return null;
            return { mediaType: picture.mediaType, bytes: new Uint8Array(data) };
          }
        }
      }
    } finally { closeSync(fd); }
  } catch { /* changed, incomplete or unavailable history */ }
  return null;
}
