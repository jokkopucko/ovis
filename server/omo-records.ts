import { readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Long records retain their envelope and tool calls, even between large content strings. */
export type OmoLine = { text: string } | { head: string; tail: string; record?: string };
const CHUNK_BYTES = 256 * 1024;
const LONG_LINE_BYTES = 64 * 1024;
const LINE_END_BYTES = 4096;

/**
 * A JSON projection with bounded string values. Keep complete JSON escapes, including across
 * chunks, and scan to each closing quote: text that looks like a tool call inside a string is
 * never interpreted as one. Question arguments fit within this limit; large tool output and
 * thinking do not need to be retained to reconstruct the question lifecycle.
 */
class RecordProjection {
  private parts: string[] = [];
  private quoted = false;
  private escaped = false;
  private unicode = 0;
  private token = "";
  private safe = 0;
  private length = 0;
  private decoder = new StringDecoder("utf8");

  add(bytes: Buffer): void {
    const text = this.decoder.write(bytes);
    let outside = "";
    for (const char of text) {
      if (!this.quoted) {
        if (char === '"') {
          this.parts.push(outside);
          outside = "";
          this.quoted = true;
          this.token = "";
          this.safe = 0;
          this.length = 0;
        } else outside += char;
        continue;
      }
      if (char === '"' && !this.escaped && this.unicode === 0) {
        this.parts.push('"' + this.token.slice(0, this.safe) + '"');
        this.quoted = false;
        continue;
      }
      this.length += char.length;
      if (this.length <= LONG_LINE_BYTES) this.token += char;
      if (this.unicode > 0) this.unicode -= 1;
      else if (this.escaped) { this.escaped = false; if (char === "u") this.unicode = 4; }
      else if (char === "\\") this.escaped = true;
      if (!this.escaped && this.unicode === 0 && this.length <= LONG_LINE_BYTES) this.safe = this.token.length;
    }
    this.parts.push(outside);
  }

  finish(): string { return this.parts.join(""); }
}

/** Complete JSONL records only; an unfinished final record is retried from its first byte. */
export function readOmoLines(fd: number, from: number, size: number, each: (line: OmoLine) => void, read: typeof readSync = readSync): number {
  const chunks = readOmoChunks(fd, from, size, each, read);
  let next = chunks.next();
  while (!next.done) next = chunks.next();
  return next.value;
}

/** Small reads finish inline; larger reads yield even in the middle of one JSONL record. */
export function readOmoLinesCooperatively(fd: number, from: number, size: number, each: (line: OmoLine) => void, current: () => boolean): number | Promise<number> {
  const chunks = readOmoChunks(fd, from, size, each, readSync);
  const advance = (): number | Promise<number> => {
    if (!current()) { chunks.return(from); return from; }
    const next = chunks.next();
    if (next.done) return next.value;
    return new Promise<void>((resolve) => setImmediate(resolve)).then(advance);
  };
  return advance();
}

/** Keep the decoder and unfinished record alive across bounded read steps. */
function* readOmoChunks(fd: number, from: number, size: number, each: (line: OmoLine) => void, read: typeof readSync): Generator<void, number> {
  let offset = from;
  let position = from;
  let parts: Buffer[] = [];
  let held = 0;
  let head: Buffer | null = null;
  let tail = Buffer.alloc(0);
  let projection = new RecordProjection();
  const keep = (piece: Buffer) => {
    projection.add(piece);
    if (head !== null) tail = Buffer.concat([tail, piece]).subarray(-LINE_END_BYTES);
    else {
      parts.push(piece);
      held += piece.length;
      if (held > LONG_LINE_BYTES) {
        const all = Buffer.concat(parts);
        head = all.subarray(0, LINE_END_BYTES);
        tail = all.subarray(-LINE_END_BYTES);
        parts = [];
      }
    }
  };
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
    const got = read(fd, chunk, 0, chunk.length, position);
    if (got <= 0) break;
    const bytes = chunk.subarray(0, got);
    let start = 0;
    for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, start)) {
      keep(bytes.subarray(start, newline));
      if (head !== null) each({ head: (head as Buffer).toString("utf8"), tail: tail.toString("utf8"), record: projection.finish() });
      else each({ text: Buffer.concat(parts).toString("utf8") });
      parts = [];
      held = 0;
      head = null;
      tail = Buffer.alloc(0);
      projection = new RecordProjection();
      start = newline + 1;
      offset = position + start;
    }
    keep(bytes.subarray(start));
    position += got;
    if (position < size) yield;
  }
  return offset;
}
