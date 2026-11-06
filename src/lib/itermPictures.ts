/**
 * iTerm2 inline pictures that xterm's image addon (0.9.0) does not take on its own, put into a form it
 * does before it sees them (lib/terminalImages.ts):
 *
 * - the multipart form iTerm2's own `imgcat` sends: `MultipartFile=<args>`, then `FilePart=<base64>`
 *   pieces, then `FileEnd`, joined into one `File=<args>:<base64>`;
 * - a picture without `size=` (`chafa -f iterm`), which the addon drops: the size is taken from the data;
 * - a TIFF picture (`chafa -f iterm` sends uncompressed RGBA TIFF), which a browser cannot decode: the
 *   baseline uncompressed 8-bit kind is turned into a PNG, any other kind into a hatched placeholder of
 *   its size, so the picture is not lost without a trace and the text after it lands where it would.
 *
 * Every other picture goes to the addon as it came. The addon's own caps still apply to what it is given.
 */

/** the addon's caps a picture is held to here too: decoded file bytes, and pixels */
export interface PictureLimits { sizeLimit: number; pixelLimit: number }

/** hands a whole `File=<args>:<base64>` payload to the addon's iTerm2 decoder */
export type PictureFeed = (payload: string) => boolean | Promise<boolean>;

/** an OSC handler of xterm's own parser, fed a payload piece by piece, as the addon's decoders are */
export interface OscStreamHandler {
  start(): void;
  put(data: Uint32Array, start: number, end: number): void;
  end(success: boolean): boolean | Promise<boolean>;
}

/** the most of a payload's command and arguments held to tell what it is, and room for them ahead of the base64 */
const ARGS_ROOM = 65536;

function textOf(data: Uint32Array, start: number, end: number): string {
  let out = "";
  // the parser hands code points; a slice at a time keeps the argument list short
  for (let i = start; i < end; i += 0x2000) out += String.fromCodePoint(...data.subarray(i, Math.min(end, i + 0x2000)));
  return out;
}

const decodedLength = (base64: string): number => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length / 4) * 3 - padding);
};

/** the base64 text that decodes to at most `bytes` bytes */
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

const sizeOf = (args: string): number | null => {
  const match = /(?:^|;)size=(\d+)/.exec(args);
  return match ? Number(match[1]) : null;
};

const withSize = (args: string, size: number): string =>
  sizeOf(args) === null ? `${args};size=${size}` : args.replace(/(^|;)size=\d+/, `$1size=${size}`);

const fromBase64 = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

function toBase64(bytes: Uint8Array): string {
  let out = "";
  // btoa takes a string of bytes; one call per slice keeps the argument list of fromCharCode short, and a
  // slice of a multiple of three bytes ends without padding, so the slices join into one base64 text
  const slice = 3 * 0x2aaa;
  for (let i = 0; i < bytes.length; i += slice) out += btoa(String.fromCharCode(...bytes.subarray(i, i + slice)));
  return out;
}

/** the first bytes of a picture's data, enough to tell its format; none where they are no base64 */
function headOf(base64: string): Uint8Array {
  try { return fromBase64(base64.slice(0, 8).replace(/=+$/, "")); } catch { return new Uint8Array(); }
}

const isTiff = (head: Uint8Array): boolean =>
  head.length >= 4 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0)
    || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a));

/** the tags decodeTiff reads; the strips' offsets and byte counts may hold one value a row */
const READ_TAGS = new Set([256, 257, 258, 259, 262, 274, 277, 278, 284, 338]);
const STRIP_TAGS = new Set([273, 279]);
const MAX_STRIPS = 65536;

/** a TIFF's size, and its pixels as RGBA when it is a kind decoded here (else null) */
export interface DecodedTiff { width: number; height: number; rgba: Uint8Array | null }

/**
 * Decodes a baseline TIFF's first image when it is uncompressed, 8 bits a sample, chunky, grey (with
 * or without alpha) or RGB (with or without alpha): what chafa writes. Null when it is no TIFF or its
 * directory cannot be read; `rgba` null when it is a TIFF of another kind, or larger than `pixelLimit`.
 */
export function decodeTiff(bytes: Uint8Array, pixelLimit: number): DecodedTiff | null {
  if (!isTiff(bytes) || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) return null;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > bytes.length) return null;
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    // only the tags read below, each read once: a directory of many tags pointing at the same bytes reads nothing more
    const most = STRIP_TAGS.has(tag) ? MAX_STRIPS : READ_TAGS.has(tag) && !tags.has(tag) ? 4 : 0;
    // BYTE, SHORT and LONG are all a baseline image needs; other types are skipped
    const width = type === 1 ? 1 : type === 3 ? 2 : type === 4 ? 4 : 0;
    if (width === 0 || n > most || tags.has(tag)) continue;
    const at = width * n <= 4 ? entry + 8 : u32(entry + 8);
    if (at + width * n > bytes.length) return null;
    tags.set(tag, Array.from({ length: n }, (_, k) => (width === 1 ? bytes[at + k]! : width === 2 ? u16(at + 2 * k) : u32(at + 4 * k))));
  }
  const one = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;
  const width = one(256, 0);
  const height = one(257, 0);
  if (width === 0 || height === 0) return null;
  const decoded = { width, height, rgba: null };
  const samples = one(277, 1);
  const photometric = one(262, -1);
  const bits = tags.get(258) ?? [1];
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  const grey = photometric === 0 || photometric === 1;
  // another orientation than top left would need its rows or columns turned: taken as a kind not decoded here
  if (one(259, 1) !== 1 || one(284, 1) !== 1 || one(274, 1) !== 1 || bits.some((b) => b !== 8) || offsets.length === 0
    || offsets.length !== counts.length || !(grey ? samples === 1 || samples === 2 : photometric === 2 && (samples === 3 || samples === 4))
    || width * height >= pixelLimit) return decoded;
  // gather the strips into one run of samples, row after row
  const total = width * height * samples;
  const pixels = new Uint8Array(total);
  let filled = 0;
  for (let i = 0; i < offsets.length && filled < total; i++) {
    const take = Math.min(counts[i]!, total - filled);
    if (offsets[i]! + take > bytes.length) return decoded;
    pixels.set(bytes.subarray(offsets[i]!, offsets[i]! + take), filled);
    filled += take;
  }
  if (filled < total) return decoded;
  const premultiplied = one(338, 0) === 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, s = 0; p < rgba.length; p += 4, s += samples) {
    if (grey) {
      const v = photometric === 0 ? 255 - pixels[s]! : pixels[s]!;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
    } else {
      rgba[p] = pixels[s]!;
      rgba[p + 1] = pixels[s + 1]!;
      rgba[p + 2] = pixels[s + 2]!;
    }
    const alpha = samples === 2 || samples === 4 ? pixels[s + samples - 1]! : 255;
    rgba[p + 3] = alpha;
    if (premultiplied && alpha < 255) {
      for (let c = 0; c < 3; c++) rgba[p + c] = alpha === 0 ? 0 : Math.min(255, Math.round((rgba[p + c]! * 255) / alpha));
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA pixels as a PNG the addon decodes in the browser, its rows compressed with the browser's own zlib */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const row = width * 4;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const zlib = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  let at = 0;
  const ihdr = new Uint8Array(13);
  const h = new DataView(ihdr.buffer);
  h.setUint32(0, width);
  h.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const chunks = [["IHDR", ihdr], ["IDAT", zlib], ["IEND", new Uint8Array()]] as const;
  const png = new Uint8Array(8 + chunks.reduce((sum, [, data]) => sum + 12 + data.length, 0));
  const out = new DataView(png.buffer);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  at = 8;
  for (const [type, data] of chunks) {
    out.setUint32(at, data.length);
    const body = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(data, 4);
    png.set(body, at + 4);
    out.setUint32(at + 4 + body.length, crc32(body));
    at += 12 + data.length;
  }
  return png;
}

/** the side of the most pixels a placeholder holds: the addon scales it to the picture's place anyway */
const PLACEHOLDER_SIDE = 256;

/** a grey box with darker diagonal stripes, in the picture's proportions, where a picture could not be decoded */
export function placeholderPng(width: number, height: number): Promise<Uint8Array> {
  const scale = Math.min(1, PLACEHOLDER_SIDE / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale) || PLACEHOLDER_SIDE);
  const h = Math.max(1, Math.round(height * scale) || PLACEHOLDER_SIDE / 4);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x + y) % 12 < 4 ? 0x60 : 0x90;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return encodePng(w, h, rgba);
}

/**
 * A TIFF as a PNG with the same arguments, or as a placeholder where it is of a kind not decoded here or
 * its PNG is past the addon's file cap. The placeholder is given the TIFF's own size where the arguments
 * name none, so the text after it lands where it would after the picture.
 */
async function fromTiff(args: string, base64: string, limits: PictureLimits): Promise<{ args: string; png: Uint8Array }> {
  const tiff = decodeTiff(fromBase64(base64), limits.pixelLimit);
  if (tiff?.rgba) {
    const png = await encodePng(tiff.width, tiff.height, tiff.rgba);
    if (png.length <= limits.sizeLimit) return { args, png };
  }
  const sized = tiff && !/(?:^|;)(?:width|height)=/.test(args) ? `${args};width=${tiff.width}px;height=${tiff.height}px` : args;
  return { args: sized, png: await placeholderPng(tiff?.width ?? 0, tiff?.height ?? 0) };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * An OSC 1337 handler, registered after the addon so it reads each payload first: true where it took
 * the payload (a multipart piece, or a picture it handed on in a form the addon takes), false where the
 * addon reads it as it came. `reset` drops a multipart picture still coming in.
 */
export function itermPictures(feed: PictureFeed, limits: () => PictureLimits): { handle(data: string): boolean | Promise<boolean>; stream: OscStreamHandler; reset(): void } {
  let multipart: { args: string; parts: string[]; length: number } | null = null;

  const picture = (args: string, base64: string): boolean | Promise<boolean> => {
    // a length of one past a multiple of four is no base64 at all: atob would throw on it
    if (base64.length === 0 || base64.length % 4 === 1 || !BASE64.test(base64)) return true;
    if (!isTiff(headOf(base64))) return feed(`File=${withSize(args, decodedLength(base64))}:${base64}`);
    // a picture that cannot be read is dropped: the parser goes on with the output after it
    return fromTiff(args, base64, limits()).then(({ args: sized, png }) => feed(`File=${withSize(sized, png.length)}:${toBase64(png)}`), () => true);
  };

  const handle = (data: string): boolean | Promise<boolean> => {
    if (data.startsWith("MultipartFile=")) {
      const args = data.slice("MultipartFile=".length);
      const size = sizeOf(args);
      multipart = size !== null && size > limits().sizeLimit ? null : { args, parts: [], length: 0 };
      return true;
    }
    if (data.startsWith("FilePart=")) {
      if (multipart) {
        const part = data.slice("FilePart=".length);
        multipart.length += part.length;
        // past the addon's cap the picture is dropped now, not once all of it is held
        if (multipart.length > base64Length(limits().sizeLimit)) multipart = null;
        else multipart.parts.push(part);
      }
      return true;
    }
    if (data.startsWith("FileEnd")) {
      const done = multipart;
      multipart = null;
      return done ? picture(done.args, done.parts.join("")) : true;
    }
    if (data.startsWith("File=")) {
      const colon = data.indexOf(":");
      if (colon < 0) return false;
      const args = data.slice("File=".length, colon);
      const base64 = data.slice(colon + 1);
      // a picture the addon reads as it is goes to it untouched
      if (sizeOf(args) !== null && !isTiff(headOf(base64))) return false;
      if (base64.length > base64Length(limits().sizeLimit)) return true;
      return picture(args, base64);
    }
    return false;
  };

  /** whether a payload's start already shows the addon reads it as it comes: it need not be held then */
  const leftToAddon = (head: string): boolean => {
    if (!["File=", "MultipartFile=", "FilePart=", "FileEnd"].some((command) => head.startsWith(command) || command.startsWith(head))) return true;
    if (!head.startsWith("File=")) return false;
    const colon = head.indexOf(":");
    return colon >= 0 && head.length >= colon + 9 && sizeOf(head.slice("File=".length, colon)) !== null && !isTiff(headOf(head.slice(colon + 1)));
  };

  // xterm's string handlers hold a payload up to 10,000,000 characters and are not called for a longer
  // one, which then went to the addon as it came: a picture of 7.5 MB or more without a size, or a TIFF,
  // was not drawn. Fed piece by piece, a payload is held here up to the addon's own cap.
  // pieces as the parser hands them, joined a thousand at a time: one string each costs more than its text
  let held: string[] = [];
  let recent: string[] = [];
  let heldLength = 0;
  let head = "";
  let state: "hold" | "addon" | "over" | "drop" = "hold";
  const release = () => { held = []; recent = []; };
  const stream: OscStreamHandler = {
    start: () => { release(); heldLength = 0; head = ""; state = "hold"; },
    put: (data, start, end) => {
      if (state !== "hold") return;
      const text = textOf(data, start, end);
      // the start up to the colon and a few characters of base64 after it
      const colon = head.indexOf(":");
      const room = colon >= 0 ? colon + 16 : ARGS_ROOM;
      if (head.length < room) head += text.slice(0, room - head.length);
      heldLength += text.length;
      // the cap is on the base64 after the arguments, as the addon's is on the file
      const argsLength = head.indexOf(":") >= 0 ? head.indexOf(":") + 1 : ARGS_ROOM;
      if (heldLength - argsLength > base64Length(limits().sizeLimit)) { release(); state = "over"; return; }
      if (leftToAddon(head)) { release(); state = "addon"; return; }
      // a piece of no multipart picture coming in is dropped by handle: nothing to hold for it
      if (head.startsWith("FilePart=") && multipart === null) { release(); state = "drop"; return; }
      recent.push(text);
      if (recent.length >= 1024) { held.push(recent.join("")); recent = []; }
    },
    end: (success) => {
      if (!success || state === "addon") { release(); return false; }
      if (state === "hold") {
        const data = held.join("") + recent.join("");
        release();
        return handle(data);
      }
      // past the addon's cap: a picture, or a piece of one, is dropped as the addon would drop it
      if (state === "over" && !head.startsWith("File=")) multipart = null;
      return true;
    },
  };

  return { handle, stream, reset: () => { multipart = null; } };
}
