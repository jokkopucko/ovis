import { closeSync, fstatSync, openSync } from "node:fs";
import { readOmoLines } from "./omo-records.ts";

/**
 * The questions an OmO session has open, as its session file records them: ask_user_question
 * (request_user_input under a Codex model), read the way OmO itself finds the questions it
 * restores after a restart (its ask-user extension, resume.js in omo 5.1.19).
 *
 * A call that waits for its answer (`waitForAnswer: true`) is open until its tool result, including
 * when newer assistant messages have been recorded. A call that does not wait gets a result at
 * once that accepts it (`details: { accepted: true, status: "pending" }`); OmO folds it into a
 * widget over its input box and goes on, and it stays open until it is settled: an
 * `ask-user:settlement` record, or the answer delivered as a user message (`[Answer to question
 * <id>]`). A result that is an error (a malformed call) closes either kind.
 */

export const OMO_ASK_TOOLS: ReadonlySet<string> = new Set(["ask_user_question", "request_user_input"]);

export interface OmoAskCall {
  id: string;
  wait: boolean;
  args: unknown;
  /** the tool's name, which says how OmO numbers its questions (omo-questions.ts omoAskOf) */
  tool?: string;
}

export type OmoAsks = readonly OmoAskCall[];

export type OmoAskState = "open" | "cancelled";

interface Entry {
  type?: unknown;
  customType?: unknown;
  display?: unknown;
  inputSource?: unknown;
  content?: unknown;
  data?: unknown;
  message?: { role?: unknown; content?: unknown; display?: unknown; inputSource?: unknown; toolCallId?: unknown; isError?: unknown; details?: unknown };
}

const ANSWER_FRAME_RE = /^\[Answer to question ([^\]\r\n]+)\]\r?\n([\s\S]*)$/;
const LABEL_BLOCK_RE = /^\[(.+)\]$/s;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isCancelledAnswerBody = (body: string): boolean =>
  body === "The user dismissed the question."
  || body.includes("The user cancelled the question after answering part of it.")
  || body.includes("The question was cancelled after part of it was answered.")
  || body.includes("No answer: do not take the action it gates.");

/**
 * Ask ids opened, marked cancelled, or closed by an OmO session record, for matching late
 * `[Answer to question <id>]` deliveries. A non-cancelled `ask-user:settlement` is written right
 * before OmO delivers the framed message, so it keeps the id open; a `cancelled` settlement may
 * deliver no message at all (lifecycle cancel), so it restricts matching to cancellation-shaped
 * bodies; a non-pending `toolResult` (immediate answer or error) closes the id.
 */
export function omoAskUpdates(value: unknown): { open: { id: string; state: OmoAskState }[]; close: string[] } {
  const entry = typeof value === "object" && value !== null ? value as Entry : null;
  if (entry === null) return { open: [], close: [] };
  if (entry.type === "custom") {
    if (entry.customType === "ask-user:question" || entry.customType === "ask-user:settlement") {
      const data = entry.data as { requestId?: unknown; status?: unknown } | null;
      const id = data?.requestId;
      if (typeof id === "string" && id.length > 0) {
        const state: OmoAskState = entry.customType === "ask-user:settlement" && data?.status === "cancelled" ? "cancelled" : "open";
        return { open: [{ id, state }], close: [] };
      }
    }
    return { open: [], close: [] };
  }
  const message = entry.type === "message" ? entry.message : undefined;
  if (!message || typeof message !== "object") return { open: [], close: [] };
  const open: { id: string; state: OmoAskState }[] = [];
  const close: string[] = [];
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content as Record<string, unknown>[]) {
      if (!part || typeof part !== "object") continue;
      if (part["type"] === "toolCall" && part["incomplete"] !== true) {
        const name = typeof part["toolName"] === "string" ? part["toolName"] : part["name"];
        const id = typeof part["toolCallId"] === "string" ? part["toolCallId"]
          : typeof part["id"] === "string" ? part["id"]
          : typeof part["callId"] === "string" ? part["callId"] : undefined;
        if (typeof name === "string" && OMO_ASK_TOOLS.has(name) && id !== undefined && id.length > 0) open.push({ id, state: "open" });
      } else if (part["type"] === "toolResult") {
        const id = typeof part["toolCallId"] === "string" ? part["toolCallId"]
          : typeof part["callId"] === "string" ? part["callId"]
          : typeof part["id"] === "string" ? part["id"] : undefined;
        const details = (part["details"] ?? {}) as { accepted?: unknown; status?: unknown };
        const accepted = part["isError"] !== true && details.accepted === true && details.status === "pending";
        if (!accepted && id !== undefined && id.length > 0) close.push(id);
      }
    }
    return { open, close };
  }
  if (message.role === "toolResult") {
    const record = message as { toolCallId?: unknown; callId?: unknown; isError?: unknown; details?: unknown };
    const id = typeof record.toolCallId === "string" ? record.toolCallId
      : typeof record.callId === "string" ? record.callId : undefined;
    const details = (record.details ?? {}) as { accepted?: unknown; status?: unknown };
    const accepted = record.isError !== true && details.accepted === true && details.status === "pending";
    if (!accepted && id !== undefined && id.length > 0) close.push(id);
  }
  return { open, close };
}

function parseUserWordLabel(label: string, id: string): { kind: "comment" } | { kind: "typed"; header: string } | null {
  const suffix = ` for question ${id}`;
  const base = label.replace(/ \(\d+\)$/, "");
  if (!base.endsWith(suffix)) return null;
  const prefix = base.slice(0, -suffix.length);
  if (prefix === "The user's comment") return { kind: "comment" };
  if (prefix.startsWith("The user's answer to ")) {
    const header = prefix.slice("The user's answer to ".length);
    return header.length > 0 ? { kind: "typed", header } : null;
  }
  return null;
}

/**
 * Display text of an OmO late answer delivered as a user message or held `extension-user-message`,
 * matching an open ask id in the session. Strips the `[Answer to question <id>]` frame and
 * resolves OmO 5.1.81's separated `[The user's …]` word blocks into their matching line slots
 * (single-pass so user words are never re-expanded and another question's selected option cannot
 * be overwritten). Returns null when not a matched OmO answer frame or stripping leaves it empty.
 */
export function omoAnswerText(content: unknown, openAsks: ReadonlyMap<string, OmoAskState>): { id: string; text: string } | null {
  if (openAsks.size === 0) return null;
  let blocks: { type: "text"; text: string }[];
  if (typeof content === "string") blocks = [{ type: "text", text: content }];
  else if (Array.isArray(content) && content.length > 0) {
    blocks = [];
    for (const part of content) {
      if (!part || typeof part !== "object") return null;
      const block = part as { type?: unknown; text?: unknown };
      if (block.type !== "text" || typeof block.text !== "string") return null;
      blocks.push({ type: "text", text: block.text });
    }
  } else return null;

  const framed = ANSWER_FRAME_RE.exec(blocks[0]!.text);
  if (framed === null) return null;
  const id = framed[1]!;
  const body = framed[2]!;
  const state = openAsks.get(id);
  if (state === undefined) return null;
  if (state === "cancelled" && !isCancelledAnswerBody(body)) return null;

  let resolved = body;
  if (blocks.length > 1) {
    const rest = blocks.slice(1);
    if (rest.length % 2 !== 0) return null;
    const seen = new Set<string>();
    const words: { ref: string; linePattern: RegExp; text: string }[] = [];
    for (let index = 0; index < rest.length; index += 2) {
      const label = LABEL_BLOCK_RE.exec(rest[index]!.text)?.[1];
      if (label === undefined || seen.has(label)) return null;
      const parsed = parseUserWordLabel(label, id);
      if (parsed === null) return null;
      seen.add(label);
      const ref = `(see [${label}] below)`;
      const escapedRef = escapeRegExp(ref);
      const linePattern = parsed.kind === "comment"
        ? new RegExp(`^(The user responded: )${escapedRef}$`)
        : new RegExp(`^((?:Before going idle the user had selected(?: \\(not an answer\\))?: )?${escapeRegExp(parsed.header)}: )${escapedRef}$`);
      words.push({ ref, linePattern, text: rest[index + 1]!.text });
    }
    const lines = body.split("\n");
    let cursor = 0;
    for (const word of words) {
      let matched = -1;
      for (let lineIndex = cursor; lineIndex < lines.length; lineIndex++) {
        if (word.linePattern.test(lines[lineIndex]!)) { matched = lineIndex; break; }
      }
      if (matched === -1) return null;
      lines[matched] = lines[matched]!.replace(word.linePattern, (_full, prefix: string) => prefix + word.text);
      cursor = matched + 1;
    }
    resolved = lines.join("\n");
  }
  return resolved.length === 0 ? null : { id, text: resolved };
}

/**
 * Recognizes an OmO late-answer record — either a regular `user` message (excluding interactive
 * human typing) or a visible `extension-user-message` custom record written during an engine hold.
 */
export function omoAnswerEntry(value: unknown, openAsks: ReadonlyMap<string, OmoAskState>): { id: string; text: string } | null {
  if (openAsks.size === 0 || value === null || typeof value !== "object") return null;
  const entry = value as Entry;
  if (entry.display === false) return null;
  if (entry.inputSource === "interactive" || entry.inputSource === "person") return null;
  if (entry.type === "custom_message" && entry.customType === "extension-user-message") {
    return omoAnswerText(entry.content, openAsks);
  }
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message;
    if (message.role !== "user" || message.display === false) return null;
    if (message.inputSource === "interactive" || message.inputSource === "person") return null;
    return omoAnswerText(message.content, openAsks);
  }
  return null;
}

function waits(args: unknown): boolean {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  return (record["waitForAnswer"] ?? record["wait_for_answer"]) !== false;
}

function without(open: OmoAsks, id: string): OmoAsks {
  return open.some((call) => call.id === id) ? open.filter((call) => call.id !== id) : open;
}

export function omoAsksAfter(open: OmoAsks, entry: Entry): OmoAsks {
  if (entry.type === "custom") {
    const id = entry.customType === "ask-user:settlement" ? (entry.data as { requestId?: unknown } | null)?.requestId : undefined;
    return typeof id === "string" ? without(open, id) : open;
  }
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role === "assistant") {
    const calls = (Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [])
      .filter((part) => part?.["type"] === "toolCall" && typeof part["id"] === "string" && OMO_ASK_TOOLS.has(part["name"] as string) && part["incomplete"] !== true)
      .map((part) => ({ id: part["id"] as string, wait: waits(part["arguments"]), args: part["arguments"], tool: part["name"] as string }));
    const ids = new Set(calls.map((call) => call.id));
    return calls.length > 0 ? [...open.filter((call) => !ids.has(call.id)), ...calls] : open;
  }
  if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
    const details = (message.details ?? {}) as { accepted?: unknown; status?: unknown };
    const accepted = message.isError !== true && details.accepted === true && details.status === "pending";
    return accepted ? open : without(open, message.toolCallId);
  }
  if (message?.role === "user") {
    const texts = typeof message.content === "string" ? [message.content]
      : Array.isArray(message.content) ? (message.content as { type?: unknown; text?: unknown }[]).flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []) : [];
    return texts.reduce((rest, text) => {
      const id = ANSWER_FRAME_RE.exec(text)?.[1];
      return id === undefined ? rest : without(rest, id);
    }, open);
  }
  return open;
}


/**
 * omp records the call when its
 * dialog opens and its toolResult when it is answered or cancelled. A user message starts a new
 * turn, so no call stays open past one.
 */
export function ompAsksAfter(open: OmoAsks, entry: Entry): OmoAsks {
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role === "user") return open.length > 0 ? [] : open;
  if (message?.role === "assistant") {
    const calls = (Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [])
      .filter((part) => part?.["type"] === "toolCall" && typeof part["id"] === "string" && part["name"] === "ask" && part["incomplete"] !== true)
      .map((part) => ({ id: part["id"] as string, wait: true, args: part["arguments"] }));
    const ids = new Set(calls.map((call) => call.id));
    return calls.length > 0 ? [...open.filter((call) => !ids.has(call.id)), ...calls] : open;
  }
  if (message?.role === "toolResult" && typeof message.toolCallId === "string") return without(open, message.toolCallId);
  return open;
}

export class OmoAskReader {
  constructor(private readonly after: (open: OmoAsks, entry: Entry) => OmoAsks = omoAsksAfter) {}

  private files = new Map<string, { id: string; size: number; mtime: number; offset: number; asks: OmoAsks }>();

  read(path: string): OmoAsks {
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      const id = `${stat.dev}:${stat.ino}`;
      let state = this.files.get(path);
      if (!state || state.id !== id || stat.size < state.size || (stat.size === state.size && stat.mtimeMs !== state.mtime)) {
        state = { id, size: 0, mtime: 0, offset: 0, asks: [] };
      }
      state.offset = readOmoLines(fd, state.offset, stat.size, (line) => {
        const text = "text" in line ? line.text : line.record;
        if (text === undefined) return;
        try { state!.asks = this.after(state!.asks, JSON.parse(text)); } catch {}
      });
      state.size = stat.size;
      state.mtime = stat.mtimeMs;
      this.files.delete(path);
      this.files.set(path, state);
      if (this.files.size > 64) this.files.delete(this.files.keys().next().value!);
      return state.asks;
    } finally { closeSync(fd); }
  }
}
