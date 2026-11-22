/**
 * Letta Code's conversation transcript, read into turns. The TUI appends each turn when it ends
 * (`end_turn`) to `<transcripts>/<agent>/<conversation>/transcript.jsonl`, on the cloud and the
 * local backend alike (letta-code 0.34.27, `appendTranscriptDeltaJsonl`). A line is one entry:
 * - `{ kind: "user" | "assistant" | "reasoning" | "error", text, captured_at }`;
 * - `{ kind: "tool_call", name?, argsText?, resultText?, resultOk?, captured_at }`, the call and its
 *   result in one entry.
 * Each also names a `source_line_id` (unique in the file) and may name a `source_message_id`. Every
 * entry of one turn has the same `captured_at`. A turn that was cancelled or failed is not written,
 * and a turn still running is written only when it ends.
 */
import { closeSync, constants, fstatSync, readSync } from "node:fs";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { type FileIdentity, openBound, readBound } from "./conversation-shared.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

type Row = Record<string, unknown>;
type Tool = Extract<ConversationPart, { kind: "tool" }>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const optional = (value: unknown, type: "string" | "boolean"): boolean => value === undefined || typeof value === type;

export class LettaUnavailable extends Error {
  constructor() { super("Letta transcript is in a shape the reader does not know"); this.name = "LettaUnavailable"; }
}

/** The fields letta-code 0.34.27 writes, by kind: an entry with any other could carry words the reader would drop. */
const FIELDS = new Set(["kind", "text", "captured_at", "source_line_id", "source_message_id"]);
const TOOL_FIELDS = new Set(["kind", "name", "argsText", "resultText", "resultOk", "captured_at", "source_line_id", "source_message_id"]);
const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;

function known(entry: Row): boolean {
  if (!Object.keys(entry).every((key) => (entry.kind === "tool_call" ? TOOL_FIELDS : FIELDS).has(key))) return false;
  if (typeof entry.captured_at !== "string" || !optional(entry.source_line_id, "string") || !optional(entry.source_message_id, "string")) return false;
  if (entry.kind === "tool_call") {
    return optional(entry.name, "string") && optional(entry.argsText, "string") && optional(entry.resultText, "string") && optional(entry.resultOk, "boolean");
  }
  return (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "reasoning" || entry.kind === "error") && typeof entry.text === "string";
}

export function lettaPrompt(entry: Row): string | null {
  return entry.kind === "user" && typeof entry.text === "string" && entry.text.trim() !== "" ? entry.text : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parseLettaTranscript(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const answer = (ts: string | null, part: ConversationPart): void => {
    const last = turns.at(-1);
    if (last?.role === "assistant") { last.parts.push(part); if (ts !== null) last.end_ts = ts; }
    else turns.push({ role: "assistant", ts, ...(ts === null ? {} : { end_ts: ts }), parts: [part] });
  };
  const lines = text.split("\n");
  for (const [at, line] of lines.entries()) {
    if (line === "") continue;
    let entry: unknown;
    // the last line can be one Letta is still writing
    try { entry = JSON.parse(line); } catch { if (at < lines.length - 1) throw new LettaUnavailable(); continue; }
    if (!isRow(entry) || !known(entry)) throw new LettaUnavailable();
    const ts = iso(entry.captured_at);
    const prompt = lettaPrompt(entry);
    if (prompt !== null) { turns.push({ role: "user", ts, parts: [{ kind: "text", text: prompt }] }); continue; }
    const words = typeof entry.text === "string" ? entry.text : "";
    if (entry.kind === "assistant" && words.trim() !== "") answer(ts, { kind: "text", text: words });
    else if (entry.kind === "reasoning" && words.trim() !== "") answer(ts, { kind: "thinking", text: words });
    else if (entry.kind === "error" && words.trim() !== "") answer(ts, { kind: "notice", text: words, source: "error" });
    else if (entry.kind === "tool_call") {
      const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : "tool";
      const input = typeof entry.argsText === "string" ? entry.argsText : "";
      let args: Row = {};
      try { const parsed: unknown = JSON.parse(input); if (isRow(parsed)) args = parsed; } catch {}
      const part: Tool = { kind: "tool", name, summary: toolSummary(name, args), input, output: "" };
      const ref = typeof entry.source_line_id === "string" && TOOL_REF.test(entry.source_line_id) ? entry.source_line_id : "";
      trimOutput(part, typeof entry.resultText === "string" ? entry.resultText : "", ref);
      if (ref === "") { delete part.output_ref; delete part.output_size; }
      if (entry.resultOk === false) part.error = true;
      answer(ts, part);
    }
  }
  return turns;
}

const SCAN_CUT = "the transcript was not read to its end in time";
export class LettaScanCut extends Error {
  constructor() { super(SCAN_CUT); this.name = "LettaScanCut"; }
}
/** What a file thread answers for such a scan (lettaToolOutputIn): an error crosses a thread as its message alone. */
export interface LettaScanCutAnswer { cut: true }

const TOOL_OUTPUT_SCAN_BYTES = 256 * 1024 * 1024;
const TOOL_CALL = Buffer.from('"tool_call"');

function resultIn(line: Buffer, id: Buffer, ref: string): string | undefined {
  if (!line.includes(id) || !line.includes(TOOL_CALL)) return undefined;
  let entry: unknown;
  try { entry = JSON.parse(line.toString("utf8")); } catch { return undefined; }
  if (!isRow(entry) || entry.kind !== "tool_call" || entry.source_line_id !== ref) return undefined;
  return typeof entry.resultText === "string" ? entry.resultText : "";
}

export function lettaToolOutput(path: string, ref: string, until = Number.POSITIVE_INFINITY): string | null {
  const id = Buffer.from(JSON.stringify(ref));
  let fd: number;
  // never through a link put where the transcript was, never waiting on a FIFO
  // nor another file than the one the lookup is bound to (openBound)
  try { fd = openBound(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  let cut = false;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const chunk = Buffer.alloc(1024 * 1024);
    // the line still without its newline, as the pieces each read brought of it: they are joined once,
    // when the newline comes, as joining what was read so far at every read copied a long line over and
    // over (a 64 MiB one took about 3 s, #3326)
    let pieces: Buffer[] = [];
    for (let position = 0, got = 0; position < TOOL_OUTPUT_SCAN_BYTES; position += got) {
      if (Date.now() >= until) { cut = position < stat.size; break; }
      if ((got = readSync(fd, chunk, 0, chunk.length, position)) <= 0) break;
      const read = chunk.subarray(0, got);
      let start = 0;
      for (let end = read.indexOf(0x0a); end >= 0; end = read.indexOf(0x0a, start)) {
        const rest = read.subarray(start, end);
        const output = resultIn(pieces.length === 0 ? rest : Buffer.concat([...pieces, rest]), id, ref);
        if (output !== undefined) return output;
        pieces = [];
        start = end + 1;
      }
      // a copy: the next read overwrites `chunk`
      if (start < got) pieces.push(Buffer.from(read.subarray(start)));
    }
  } catch { return null; } finally { closeSync(fd); }
  if (cut) throw new LettaScanCut();
  return null;
}

/**
 * An open that finds another file there answers nothing (readBound, bound here: each thread has its
 * own bindings), and the cut is made here, so no more than a page of output is copied to the
 * server's thread.
 */
export function lettaToolOutputIn(path: string, ref: string, file: FileIdentity, max: number, budgetMs: number): string | LettaScanCutAnswer | null {
  const until = Date.now() + budgetMs;
  let output: string | null;
  try { output = readBound([[path, file]], () => lettaToolOutput(path, ref, until)); }
  catch (error) { if (error instanceof LettaScanCut) return { cut: true }; throw error; }
  return output !== null && output.length > max ? `${output.slice(0, max)}\n… trimmed` : output;
}

/**
 * lettaToolOutput on a file thread (`file-pool.ts`), read from the file `file` names at `path` and cut
 * to `max` characters there: on the server's thread one long line held every request and terminal for
 * as long as it took to join, decode and parse (#3326).
 */
export async function lettaToolOutputOffThread(path: string, ref: string, file: FileIdentity, max: number): Promise<string | null> {
  let answer: string | LettaScanCutAnswer | null;
  try { answer = await fileTask<string | LettaScanCutAnswer | null>({ op: "letta-output", path, ref, file: { dev: file.dev, ino: file.ino }, max }); }
  catch (error) { if (error instanceof FileBusyError) throw error; return null; }
  if (answer !== null && typeof answer === "object") throw new FileBusyError(SCAN_CUT);
  return answer;
}
