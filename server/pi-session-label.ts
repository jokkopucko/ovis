/**
 * A streaming projection of Pi JSONL, not a transcript loader. Only label/header fields survive.
 * Label semantics follow Pi 1.4.0's buildSessionInfo/getSessionName (MIT, earendil-works/pi);
 * this parser is independently implemented. In particular, only `text` blocks count, joined by
 * spaces, and a session_info with no usable name clears the old name. No `title` extension entry.
 *
 * Strings (including image data) are validated without buffering them. Selected strings retain
 * only their first 2001 non-leading-whitespace characters (201 for names); header fields retain
 * at most 16 KiB; overflowing cwd/id fields are refused, never used as truncated identities.
 * Keys, numbers and nesting are bounded too. Malformed records, including records
 * deeper than 64 levels, are discarded through the next newline, never hiding later records.
 */
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === "object" ? value as Json : {};

class Text {
  value = "";
  leading = "";
  overflowed = false;
  private beyond = false;
  constructor(readonly max: number, readonly trimLeading = false) {}
  add(text: string): void {
    if (this.max === 0) return;
    if (this.trimLeading && this.value === "") {
      const trimmed = text.trimStart();
      if (this.leading.length < this.max) this.leading += text.slice(0, Math.min(text.length - trimmed.length, this.max - this.leading.length));
      text = trimmed;
    }
    const remaining = this.max - this.value.length;
    if (text.length > remaining) this.overflowed = true;
    if (text.slice(remaining).trim() !== "") this.beyond = true;
    if (remaining > 0) this.value += text.slice(0, remaining);
  }
  // Keep evidence of usable text beyond a clipped whitespace suffix, so the row still clips it.
  retained(): string { return this.value + (this.beyond && /\s$/.test(this.value) ? "…" : ""); }
}

type Mode = "root" | "message" | "content" | "block" | "ignore";
type Frame = { array: boolean; mode: Mode; state: "key" | "colon" | "value" | "comma" | "first"; key: string; result: Json; text: Text; blocks: number };
const KEYS: Record<Mode, readonly string[]> = {
  root: ["type", "version", "id", "cwd", "timestamp", "name", "message"],
  message: ["role", "content"], block: ["type", "text"], content: [], ignore: [],
};
const ESCAPED: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** One JSON value, consumed incrementally; no value is published until its entire record is valid. */
class Projection {
  private frames: Frame[] = [];
  private token: "string" | "primitive" | null = null;
  private string = new Text(0);
  private readonly stringEnd = /["\\\u0000-\u001f]/g;
  private key = false;
  private escape = false;
  private unicode: string | null = null;
  private primitive = "";
  private invalid = false;
  private ended = false;
  private result: unknown;

  private accept(value: unknown): void {
    const parent = this.frames.at(-1);
    if (!parent) { this.result = value; this.ended = true; return; }
    if (parent.array) {
      if (parent.mode === "content") {
        const block = object(value);
        if (block.type === "text" && block.text instanceof Text) {
          if (parent.blocks++ > 0) parent.text.add(" ");
          parent.text.add(block.text.leading);
          parent.text.add(block.text.retained());
        }
      }
    } else if (KEYS[parent.mode].includes(parent.key)) parent.result[parent.key] = value;
    parent.state = "comma";
  }

  private begin(array: boolean): void {
    const parent = this.frames.at(-1);
    let mode: Mode = !parent && !array ? "root" : "ignore";
    if (parent?.mode === "root" && parent.key === "message" && !array) mode = "message";
    if (parent?.mode === "message" && parent.key === "content" && array) mode = "content";
    if (parent?.mode === "content" && !array) mode = "block";
    if (this.frames.length >= 64) { this.invalid = true; return; }
    this.frames.push({ array, mode, state: "first", key: "", result: {}, text: new Text(2001, true), blocks: 0 });
  }

  private end(char: string): void {
    const frame = this.frames.pop();
    if (!frame || (char === "]") !== frame.array) { this.invalid = true; return; }
    this.accept(frame.mode === "content" ? frame.text.retained() : frame.result);
  }

  feed(text: string): void {
    for (let at = 0; at < text.length && !this.invalid; at++) {
      const char = text[at]!;
      if (this.token === "string") {
        if (this.unicode !== null) {
          if (!/[0-9a-fA-F]/.test(char)) { this.invalid = true; continue; }
          this.unicode += char;
          if (this.unicode.length === 4) { this.string.add(String.fromCharCode(parseInt(this.unicode, 16))); this.unicode = null; }
        } else if (this.escape) {
          this.escape = false;
          if (char === "u") this.unicode = "";
          else {
            if (ESCAPED[char] === undefined) this.invalid = true;
            else this.string.add(ESCAPED[char]!);
          }
        } else if (char === "\\") this.escape = true;
        else if (char === '"') {
          this.token = null;
          if (this.key) {
            const frame = this.frames.at(-1)!;
            frame.key = this.string.value;
            frame.state = "colon";
          } else {
            const frame = this.frames.at(-1);
            if (frame?.mode === "root" && (frame.key === "cwd" || frame.key === "id") && this.string.overflowed) this.accept(null);
            else this.accept(frame?.mode === "block" && frame.key === "text" ? this.string : this.string.retained());
          }
        } else if (char.charCodeAt(0) < 32) this.invalid = true;
        else {
          // Validate ordinary string spans in the regexp engine, not one JS iteration and
          // clipped-text update per character of a huge system prompt, tool result or image.
          // Quotes, escapes and forbidden controls still take the checked path above, even
          // after the retained text is full. Each span stays inside the current read chunk.
          this.stringEnd.lastIndex = at;
          const end = this.stringEnd.exec(text)?.index ?? text.length;
          this.string.add(text.slice(at, end));
          at = end - 1;
        }
        continue;
      }
      if (this.token === "primitive") {
        if (!/[\s,}\]]/.test(char)) {
          if (this.primitive.length >= 128) this.invalid = true;
          else this.primitive += char;
          continue;
        }
        this.finishPrimitive();
        if (this.invalid) continue;
      }
      if (/\s/.test(char)) {
        if (!/[ \t\r\n]/.test(char)) this.invalid = true;
        continue;
      }
      if (this.ended) { this.invalid = true; continue; }
      const frame = this.frames.at(-1);
      if (frame?.state === "colon") {
        if (char !== ":") this.invalid = true;
        else frame.state = "value";
        continue;
      }
      if (frame?.state === "comma") {
        if (char === (frame.array ? "]" : "}")) this.end(char);
        else if (char !== ",") this.invalid = true;
        else frame.state = frame.array ? "value" : "key";
        continue;
      }
      if (frame?.state === "first" && char === (frame.array ? "]" : "}")) { this.end(char); continue; }
      this.key = !!frame && !frame.array && (frame.state === "key" || frame.state === "first");
      if (this.key && char !== '"') { this.invalid = true; continue; }
      if (char === '"') {
        this.token = "string";
        // A root string keeps one character to distinguish native falsy preambles from
        // truthy non-headers; ignored object fields still retain no string content.
        const keep = !frame || this.key || KEYS[frame.mode].includes(frame.key);
        const max = !frame ? 1 : this.key ? 64 : frame.mode === "root" && frame.key === "name" ? 201
          : frame?.mode === "block" || frame?.mode === "message" ? 2001 : 16384;
        this.string = new Text(keep ? max : 0, !this.key && (frame?.key === "name" || frame?.key === "content" || (frame?.mode === "block" && frame.key === "text")));
      } else if (char === "{" || char === "[") this.begin(char === "[");
      else if (/[0-9tfn-]/.test(char)) { this.token = "primitive"; this.primitive = char; }
      else this.invalid = true;
    }
  }

  private finishPrimitive(): void {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.primitive)) this.invalid = true;
    else this.accept(JSON.parse(this.primitive) as unknown);
    this.token = null;
  }

  complete(): Json | null {
    if (this.token === "primitive") this.finishPrimitive();
    return this.token === null && !this.invalid && this.ended && this.frames.length === 0 && this.result ? object(this.result) : null;
  }
}

export interface PiLabel {
  header: { id: string; cwd: string; timestamp: unknown; version: unknown } | null;
  title: string | null;
  firstMessage: string | null;
}
const usable = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function apply(label: PiLabel, value: Json | null): PiLabel {
  if (value === null) return label;
  if (label.header === null) {
    // As in Pi's listing, the first truthy parsed record must be a session header.
    if (value.type !== "session") return { ...label, header: { id: "", cwd: "", timestamp: null, version: null } };
    return { ...label, header: {
      id: typeof value.id === "string" && value.id.trim() !== "" ? value.id : "",
      cwd: typeof value.cwd === "string" && value.cwd.trim() !== "" ? value.cwd : "",
      timestamp: value.timestamp, version: value.version,
    } };
  }
  if (value.type === "session_info") return { ...label, title: usable(value.name) };
  const message = object(value.message);
  if (label.firstMessage === null && value.type === "message" && message.role === "user") {
    return { ...label, firstMessage: usable(message.content) };
  }
  return label;
}

/** Keeps only metadata and one bounded unfinished projection for this scan. */
export class PiLabelParser {
  private label: PiLabel = { header: null, title: null, firstMessage: null };
  private projection = new Projection();
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private malformedUtf8 = false;

  /** Bytes from the already checked descriptor. Newline is ASCII in UTF-8. */
  feed(bytes: Buffer): void {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (!this.malformedUtf8) {
        try { this.projection.feed(this.decoder.decode(bytes.subarray(start, end), { stream: newline < 0 })); }
        catch { this.malformedUtf8 = true; }
      }
      if (newline < 0) break;
      this.label = apply(this.label, this.malformedUtf8 ? null : this.projection.complete());
      this.projection = new Projection();
      this.decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      this.malformedUtf8 = false;
      start = newline + 1;
    }
  }

  /** A completed header can identify a row before EOF; unfinished labels must stay private. */
  partial(): PiLabel { return { header: this.label.header, title: null, firstMessage: null }; }

  /** Finalize once at EOF: Pi accepts a whole final record without a newline, but not cut UTF-8. */
  finish(): PiLabel {
    if (this.malformedUtf8) return this.label;
    try { this.projection.feed(this.decoder.decode()); }
    catch { return this.label; }
    this.label = apply(this.label, this.projection.complete());
    return this.label;
  }
}
