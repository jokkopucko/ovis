import { base64Length, ITERM_ARGS_ROOM, ITERM_PICTURE_COMMANDS, itermFile, itermMultipart, toBase64, type PictureLimits } from "../itermPicturePayload.ts";
import { encodePng } from "../itermPictures.ts";
import { itermKitty, kittyPng, MAX_PICTURE_BYTES, MAX_PICTURE_PIXELS, type PictureGrid, type PicturePayload } from "./itermKitty.ts";
import { decodeSixel } from "./sixel.ts";

type Chunk = string | Uint8Array;
type Rgb = readonly [number, number, number];
interface SixelPayload { readonly body: string; readonly transparent: boolean }
type Segment = Chunk | PicturePayload | SixelPayload;
interface LocatedSegment { readonly data: Segment; readonly end: number }

const OSC = "\x1b]1337;", DCS = "\x1bP";
const CANCEL = "\x18";
const HEADS = ITERM_PICTURE_COMMANDS.map((command) => OSC + command);
const latin1 = new TextDecoder("latin1");
const ascii = new TextEncoder();
// Bound speculative DCS parameters too; longer headers are left to the terminal parser.
const DCS_HEAD_MAX = 128;

function pictureScanner(limits: () => PictureLimits | null) {
  let state: "text" | "head" | "string" | "picture" = "text";
  let head = "";
  let streamedHead = false;
  let byteHead = false;
  let stringEscape = false;
  let stringDcs = false;
  let pictureEscape = false;
  let single = false;
  let sixel = false;
  let transparent = false;
  let parts: string[] = [];
  let recent: string[] = [];
  let size = 0;
  let limit = 0;
  const multipart = itermMultipart((args, base64) => ({ args, base64 }), () => limits() ?? { sizeLimit: 0, pixelLimit: 0 });
  const startHead = (): void => { head = "\x1b"; streamedHead = false; state = "head"; };

  function* scan(data: Chunk): Generator<LocatedSegment, void> {
    const text = typeof data === "string" ? data : latin1.decode(data);
    const slice = (start: number, end: number): Chunk => typeof data === "string" ? text.slice(start, end) : data.subarray(start, end);
    const oscBoundary = /[\x07\x18\x1a\x1b]/g;
    const dcsBoundary = /[\x18\x1a\x1b]/g;
    let at = 0;
    let from = 0;
    // The held ESC may have come from a previous write. Keep the common case in contiguous slices.
    let escapeAt = -1;
    while (at < text.length) {
      let st = false;
      if (state === "head") {
        const ch = text.charAt(at);
        const next = head + ch;
        if (next === DCS || (head.startsWith(DCS) && head.length < DCS_HEAD_MAX && /[\d;]/.test(ch))) {
          head = next;
          at++;
        } else if (head.startsWith(DCS) && ch === "q") {
          if (escapeAt > from) yield { data: slice(from, escapeAt), end: escapeAt };
          state = "picture";
          sixel = true;
          transparent = Number(head.slice(DCS.length).split(";")[1]) === 1;
          const caps = limits();
          limit = caps?.sixelSizeLimit ?? 0;
          size = 0;
          at++;
          yield { data: CANCEL, end: at };
        } else if (HEADS.some((prefix) => prefix.startsWith(next))) {
          head = next;
          at++;
          if (HEADS.includes(head)) {
            if (escapeAt > from) yield { data: slice(from, escapeAt), end: escapeAt };
            state = "picture";
            sixel = false;
            single = head.endsWith(";File=");
            const caps = limits();
            limit = caps ? ITERM_ARGS_ROOM + base64Length(caps.sizeLimit) : 0;
            size = head.length - OSC.length;
            if (limit) recent.push(head.slice(OSC.length));
            // The original picture's ESC cancelled any unfinished VT sequence, even if no image is drawn.
            yield { data: CANCEL, end: at };
          }
        } else {
          state = head.length > 1 || "P_^X".includes(ch) ? "string" : "text";
          stringDcs = head.startsWith(DCS);
          // ESC plus a string introducer is not part of that string's payload.
          if (head.length === 1 && state === "string") { head += ch; at++; }
          if (escapeAt < 0) {
            const held = streamedHead ? head.slice(2) : head;
            if (held) yield { data: byteHead ? ascii.encode(held) : held, end: at };
            from = at;
          }
        }
        continue;
      }
      if (state === "picture" && pictureEscape) {
        pictureEscape = false;
        if (text.charAt(at) !== "\\") {
          if (!sixel && !single) multipart.reset();
          parts = []; recent = [];
          startHead();
          from = Math.max(escapeAt, 0);
          continue;
        }
        st = true;
      } else if (state === "string" && stringEscape) {
        stringEscape = false;
        if (text.charAt(at) === "\\") {
          if (escapeAt < 0) { yield { data: byteHead ? ascii.encode("\x1b\\") : "\x1b\\", end: at + 1 }; from = at + 1; }
          at++;
        }
        else { startHead(); continue; }
        state = "text";
        continue;
      }

      if (state === "text") {
        const esc = text.indexOf("\x1b", at);
        if (esc < 0) { at = text.length; break; }
        startHead();
        escapeAt = esc;
        byteHead = typeof data !== "string";
        at = esc + 1;
        continue;
      }

      const boundary = (state === "picture" ? sixel : stringDcs) ? dcsBoundary : oscBoundary;
      boundary.lastIndex = at;
      const end = st ? at : boundary.exec(text)?.index ?? text.length;
      if (state === "string") {
        if (end === text.length) { at = end; break; }
        // xterm ends a string at its ESC: one that ends the write goes on now (a copy is made when xterm makes it), and
        // the backslash after it comes as text. A picture whose introducer follows that very ESC in the next write is
        // not told apart then.
        if (end === text.length - 1 && text.charAt(end) === "\x1b") { state = "text"; at = text.length; break; }
        if (text.charAt(end) === "\x1b") {
          stringEscape = true;
          escapeAt = end;
          byteHead = typeof data !== "string";
        } else state = "text";
      } else {
        if (limit && end > at) {
          size += end - at;
          if (size > limit) { limit = 0; parts = []; recent = []; }
          else {
            recent.push(text.slice(at, end));
            if (recent.length >= 1024) parts.push(recent.splice(0).join(""));
          }
        }
        if (end === text.length) return;
        if (text.charAt(end) === "\x1b") {
          pictureEscape = true;
          escapeAt = end;
          byteHead = typeof data !== "string";
        } else {
          state = "text";
          from = end + 1;
          const payload = limit && limits() && (st || text.charAt(end) === "\x07") ? parts.join("") + recent.join("") : "";
          parts = []; recent = [];
          if (!payload && !sixel && !single) multipart.reset();
          const picture = payload ? (sixel ? { body: payload, transparent } : single ? itermFile(payload) : multipart.handle(payload)) : null;
          if (picture) yield { data: picture, end: from };
        }
      }
      at = end + 1;
    }
    if (state === "picture") return;
    const safeEnd = state === "head" || stringEscape ? escapeAt : at;
    if (safeEnd > from) yield { data: slice(from, safeEnd), end: safeEnd };
    // `ESC ]` might be the start of an image or a clipboard copy. xterm must see the
    // introducer in this frame for its clipboard replay guard, whichever ID comes next.
    if (state === "head" && head === "\x1b]" && !streamedHead) {
      streamedHead = true;
      yield { data: head, end: at };
    }
  }
  return {
    scan,
    reset: () => {
      state = "text";
      stringEscape = pictureEscape = false;
      parts = []; recent = [];
      multipart.reset();
    },
  };
}

type Emit = (data: Chunk, picture: boolean, end: number) => void;
interface Job {
  readonly input: Generator<LocatedSegment, void>;
  readonly weight: number;
  readonly emit: Emit;
  readonly done?: () => void;
}

const MAX_PENDING = 8 * 1024 * 1024;
/** a conversion still running past this is skipped: the output behind it, and its acknowledgement, never wait longer */
const CONVERSION_DEADLINE_MS = 1000;
const MAX_ACTIVE = 64 * 1024 * 1024;
const MAX_WRITES = 1024;

export function itermPictureWriter(settings: () => PictureLimits | null, grid: () => PictureGrid, background: () => Rgb = () => [0, 0, 0]) {
  const limits = (): PictureLimits | null => {
    const caps = settings();
    return caps && {
      sizeLimit: Math.min(caps.sizeLimit, MAX_PICTURE_BYTES),
      sixelSizeLimit: Math.min(caps.sixelSizeLimit ?? caps.sizeLimit, MAX_PICTURE_BYTES),
      pixelLimit: Math.min(caps.pixelLimit, MAX_PICTURE_PIXELS),
    };
  };
  const scanner = pictureScanner(limits);
  const queue: Job[] = [];
  let weight = 0;
  let draining = false;
  let pending: Promise<string> | null = null;
  let decoding = false;

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (pending === null) {
        const job = queue[0];
        if (!job) break;
        const next = job.input.next();
        if (next.done) {
          queue.shift();
          weight -= job.weight;
          job.done?.();
          continue;
        }
        const { data: part, end } = next.value;
        if (typeof part === "string" || part instanceof Uint8Array) { job.emit(part, false, end); continue; }
        const caps = limits();
        if (!caps) continue;
        const image = "base64" in part ? itermKitty(part, caps, grid) : async () => {
          if (part.body.length > (caps.sixelSizeLimit ?? 0)) return "";
          const decoded = decodeSixel(part.body, { transparent: part.transparent, background: background(), pixelLimit: caps.pixelLimit });
          if (!decoded) return "";
          const png = await encodePng(decoded.width, decoded.height, decoded.rgba);
          return png.length <= MAX_PICTURE_BYTES ? kittyPng(toBase64(png)) : "";
        };
        if (typeof image === "string") { if (image) job.emit(image, true, end); continue; }
        if (decoding || job.weight > MAX_ACTIVE || weight - job.weight > MAX_PENDING) continue;
        decoding = true;
        const conversion = image();
        pending = conversion;
        // skipped as an overflow skips it: the text after it goes on, and a picture that comes before this decode ends is
        // dropped too (one browser decode at a time), so a slow phone may show neither
        const late = setTimeout(() => {
          if (pending !== conversion) return;
          pending = null;
          drain();
        }, CONVERSION_DEADLINE_MS);
        const finish = (output: string): void => {
          clearTimeout(late);
          decoding = false;
          if (pending !== conversion) return;
          pending = null;
          if (output && limits()) job.emit(output, true, end);
          drain();
        };
        void conversion.then(finish, () => finish(""));
      }
    } finally { draining = false; }
  };
  return {
    write(data: Chunk, emit: Emit, done?: () => void): void {
      const size = data.length * (typeof data === "string" ? 2 : 1);
      queue.push({ input: scanner.scan(data), weight: size, emit, done });
      weight += size;
      // Skip the in-flight image on overflow, not the bytes queued behind it. Do not start
      // another browser decode until the abandoned one has finished.
      if (weight - (queue[0]?.weight ?? 0) > MAX_PENDING || queue.length > MAX_WRITES) pending = null;
      drain();
    },
    reset(): void {
      pending = null;
      scanner.reset();
      const discarded = queue.splice(0);
      weight = 0;
      for (const job of discarded) job.done?.();
    },
  };
}
