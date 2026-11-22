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
}

export type OmoAsks = readonly OmoAskCall[];

interface Entry {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown; details?: unknown };
}

const ANSWER_FRAME_RE = /^\[Answer to question ([^\]\r\n]+)\]\r?\n/;

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
      .map((part) => ({ id: part["id"] as string, wait: waits(part["arguments"]), args: part["arguments"] }));
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
