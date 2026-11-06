import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { Terminal } from "@xterm/xterm";
import { decodeTiff, itermPictures, type OscStreamHandler } from "./itermPictures.ts";
import { registerOscStream } from "./terminalImages.ts";

const LIMITS = { sizeLimit: 20_000_000, pixelLimit: 4096 * 4096 };

/** the handler with a feed that keeps what it is given, as the addon's decoder would take it */
function handler(limits = LIMITS) {
  const fed: string[] = [];
  const pictures = itermPictures((payload) => { fed.push(payload); return true; }, () => limits);
  return { fed, handle: pictures.handle, stream: pictures.stream, reset: pictures.reset };
}

/** an uncompressed RGBA TIFF laid out as chafa writes it for `chafa -f iterm`: pixels first, then the directory */
function chafaTiff(width: number, height: number, rgba: Uint8Array, { compression = 1, orientation = 1, samples = 4 } = {}): Uint8Array {
  const tags: Array<[number, number, number, number]> = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, samples, samples === 1 ? 8 : 8 + rgba.length + 2 + 12 * 12 + 4], [259, 3, 1, compression],
    [262, 3, 1, samples === 1 ? 1 : 2], [273, 4, 1, 8], [274, 3, 1, orientation], [277, 3, 1, samples], [278, 4, 1, height],
    [279, 4, 1, rgba.length], [284, 3, 1, 1], [338, 3, 1, samples === 4 ? 2 : 0],
  ];
  const out = new Uint8Array(8 + rgba.length + 2 + tags.length * 12 + 4 + 8);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0]);
  view.setUint32(4, 8 + rgba.length, true);
  out.set(rgba, 8);
  let at = 8 + rgba.length;
  view.setUint16(at, tags.length, true);
  at += 2;
  for (const [tag, type, count, value] of tags) {
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
    at += 12;
  }
  at += 4;
  for (let i = 0; i < 4; i++) view.setUint16(at + 2 * i, 8, true);
  return out;
}

/** a PNG's size and RGBA pixels, read back with zlib (filter 0 rows, as the encoder writes them) */
function readPng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idatLength = view.getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  expect(raw.length).toBe((width * 4 + 1) * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, rgba };
}

const fedPicture = (payload: string) => {
  // one base64 text: padding only at its end
  const match = /^File=(.*):([A-Za-z0-9+/]*={0,2})$/.exec(payload)!;
  const bytes = Buffer.from(match[2]!, "base64");
  return { args: match[1]!, bytes: new Uint8Array(bytes) };
};

const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0, 1, 2, 3, 4, 200, 100, 50, 255]);

test("joins imgcat's multipart picture into one the addon reads, with its arguments", () => {
  const { fed, handle } = handler();
  const png = Buffer.from("\x89PNG\r\n\x1a\n-not-really-a-png-but-long-enough", "latin1").toString("base64");
  expect(handle(`MultipartFile=inline=1;size=${Buffer.from(png, "base64").length};name=cmdiLnBuZw==`)).toBe(true);
  for (let i = 0; i < png.length; i += 8) expect(handle(`FilePart=${png.slice(i, i + 8)}`)).toBe(true);
  expect(fed).toEqual([]);
  expect(handle("FileEnd")).toBe(true);
  expect(fed).toEqual([`File=inline=1;size=${Buffer.from(png, "base64").length};name=cmdiLnBuZw==:${png}`]);
  expect(handle("FileEnd")).toBe(true);
  expect(fed.length).toBe(1);
});

test("leaves a PNG with its size to the addon, and anything that is no picture", () => {
  const { fed, handle } = handler();
  const png = Buffer.from("\x89PNG\r\n\x1a\nxxxxxxxxxxxxxxxxxxxxxxxx", "latin1").toString("base64");
  expect(handle(`File=inline=1;size=32:${png}`)).toBe(false);
  expect(handle("SetMark")).toBe(false);
  expect(handle("CurrentDir=/tmp")).toBe(false);
  expect(fed).toEqual([]);
});

test("turns chafa's TIFF, sent without a size, into a PNG of the same pixels", async () => {
  const { fed, handle } = handler();
  const tiff = chafaTiff(3, 2, PIXELS);
  expect(await handle(`File=inline=1;width=24;height=6;preserveAspectRatio=0:${Buffer.from(tiff).toString("base64")}`)).toBe(true);
  expect(fed.length).toBe(1);
  const { args, bytes } = fedPicture(fed[0]!);
  expect(args).toBe(`inline=1;width=24;height=6;preserveAspectRatio=0;size=${bytes.length}`);
  expect(readPng(bytes)).toEqual({ width: 3, height: 2, rgba: PIXELS });
});

test("turns a TIFF of more than one base64 slice into one PNG of the same pixels", async () => {
  const { fed, handle } = handler();
  const pixels = Uint8Array.from({ length: 100 * 100 * 4 }, (_, i) => (i * 7919) % 251);
  expect(await handle(`File=inline=1:${Buffer.from(chafaTiff(100, 100, pixels)).toString("base64")}`)).toBe(true);
  expect(readPng(fedPicture(fed[0]!).bytes)).toEqual({ width: 100, height: 100, rgba: pixels });
});

test("drops a TIFF whose base64 cannot be read, and the output after it goes on", async () => {
  const { fed, handle } = handler();
  expect(await handle("File=inline=1:SUkqAAAAA")).toBe(true);
  expect(await handle("File=inline=1:SUkqAAAA")).toBe(true);
  expect(fed.length).toBe(1);
  expect(fedPicture(fed[0]!).args).toBe("inline=1;size=" + fedPicture(fed[0]!).bytes.length);
});

test("gives a TIFF it cannot decode a placeholder taking the TIFF's own size instead of nothing", async () => {
  const { fed, handle } = handler();
  const tiff = chafaTiff(3, 2, PIXELS, { compression: 5 });
  expect(decodeTiff(tiff, LIMITS.pixelLimit)).toEqual({ width: 3, height: 2, rgba: null });
  expect(decodeTiff(chafaTiff(3, 2, PIXELS, { orientation: 2 }), LIMITS.pixelLimit)).toEqual({ width: 3, height: 2, rgba: null });
  expect(await handle(`File=inline=1;size=${tiff.length}:${Buffer.from(tiff).toString("base64")}`)).toBe(true);
  const { args, bytes } = fedPicture(fed[0]!);
  expect(args).toBe(`inline=1;size=${bytes.length};width=3px;height=2px`);
  const placeholder = readPng(bytes);
  expect([placeholder.width, placeholder.height]).toEqual([3, 2]);
  expect([...placeholder.rgba.subarray(0, 4)]).toEqual([0x60, 0x60, 0x60, 255]);
});

test("drops a picture past the addon's size cap, multipart ones before all of it is held", () => {
  const { fed, handle, reset } = handler({ sizeLimit: 30, pixelLimit: LIMITS.pixelLimit });
  expect(handle("MultipartFile=inline=1;size=31")).toBe(true);
  expect(handle("FilePart=AAAA")).toBe(true);
  expect(handle("FileEnd")).toBe(true);
  expect(handle("MultipartFile=inline=1")).toBe(true);
  for (let i = 0; i < 11; i++) expect(handle("FilePart=AAAA")).toBe(true);
  expect(handle("FileEnd")).toBe(true);
  expect(handle(`File=inline=1:${"A".repeat(44)}`)).toBe(true);
  expect(handle("MultipartFile=inline=1")).toBe(true);
  expect(handle("FilePart=AAAA")).toBe(true);
  reset();
  expect(handle("FileEnd")).toBe(true);
  expect(fed).toEqual([]);
});

test("gives a placeholder where the PNG a TIFF turns into is past the addon's file cap", async () => {
  const { fed, handle } = handler({ sizeLimit: 6000, pixelLimit: LIMITS.pixelLimit });
  // noise does not compress: its RGBA PNG is about four times the grey TIFF
  let seed = 1;
  const grey = Uint8Array.from({ length: 64 * 64 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
  const tiff = chafaTiff(64, 64, grey, { samples: 1 });
  expect(tiff.length).toBeLessThan(6000);
  expect(await handle(`File=inline=1:${Buffer.from(tiff).toString("base64")}`)).toBe(true);
  const { args, bytes } = fedPicture(fed[0]!);
  expect(bytes.length).toBeLessThanOrEqual(6000);
  expect(args).toBe(`inline=1;width=64px;height=64px;size=${bytes.length}`);
  expect([...readPng(bytes).rgba.subarray(0, 4)]).toEqual([0x60, 0x60, 0x60, 255]);
});

test("reads a picture past the 10,000,000 characters xterm holds for a string handler, from xterm's own parser", async () => {
  const { fed, stream } = handler();
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  // the handler before it: reached only where the pictures handler leaves a payload to the addon
  const left: boolean[] = [];
  const addon: OscStreamHandler = { start() {}, put() {}, end: (success) => { left.push(success); return true; } };
  expect(registerOscStream(term, 1337, addon)).not.toBeNull();
  expect(registerOscStream(term, 1337, stream)).not.toBeNull();
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  // 2048 x 1280 RGBA: 10,485,760 bytes, about 14 million base64 characters
  const pixels = Uint8Array.from({ length: 2048 * 1280 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i >> 13) % 256));
  const base64 = Buffer.from(chafaTiff(2048, 1280, pixels)).toString("base64");
  expect(base64.length).toBeGreaterThan(10_000_000);
  await write(`\x1b]1337;File=inline=1:${base64}\x07`);
  expect(fed.length).toBe(1);
  const png = readPng(fedPicture(fed[0]!).bytes);
  expect([png.width, png.height]).toEqual([2048, 1280]);
  expect(png.rgba).toEqual(pixels);
  // a picture with its size, of a kind the addon reads, is not held here: the addon reads it
  await write(`\x1b]1337;File=inline=1;size=7500000:iVBORw0KGgo${"A".repeat(10_000_000)}\x07`);
  expect(fed.length).toBe(1);
  // the TIFF ended unread there (false), the PNG was read there (true)
  expect(left).toEqual([false, true]);
  term.dispose();
});

test("reads a payload fed in small pieces as the whole of it, long arguments and characters past U+FFFF too", async () => {
  const { fed, stream } = handler();
  const name = `${"n".repeat(5000)}\u{1003b}`;
  const payload = `File=inline=1;name=${name}:${Buffer.from(chafaTiff(3, 2, PIXELS)).toString("base64")}`;
  const points = Uint32Array.from([...payload].map((c) => c.codePointAt(0)!));
  stream.start();
  for (let i = 0; i < points.length; i += 7) stream.put(points, i, Math.min(points.length, i + 7));
  expect(await stream.end(true)).toBe(true);
  const { args, bytes } = fedPicture(fed[0]!);
  expect(args).toBe(`inline=1;name=${name};size=${bytes.length}`);
  expect(readPng(bytes).rgba).toEqual(PIXELS);
});

test("holds the cap to the base64 alone: long arguments do not push a picture at the cap past it", () => {
  const { fed, stream } = handler({ sizeLimit: 30, pixelLimit: LIMITS.pixelLimit });
  const feed = (payload: string) => {
    const points = Uint32Array.from([...payload].map((c) => c.codePointAt(0)!));
    stream.start();
    for (let i = 0; i < points.length; i += 500) stream.put(points, i, Math.min(points.length, i + 500));
    return stream.end(true);
  };
  const args = `inline=1;size=30${";width=1".repeat(1000)}`;
  // a PNG of 30 bytes with its size: the addon's to read
  expect(feed(`File=${args}:iVBORw0KGgo${"A".repeat(29)}`)).toBe(false);
  // one past the cap: dropped here, as the addon drops it
  expect(feed(`File=inline=1${";width=1".repeat(1000)}:${"A".repeat(44)}`)).toBe(true);
  expect(fed).toEqual([]);
});

test("does not decode a TIFF larger than the pixel cap", () => {
  const tiff = chafaTiff(3, 2, PIXELS);
  expect(decodeTiff(tiff, 6)).toEqual({ width: 3, height: 2, rgba: null });
  expect(decodeTiff(tiff, 7)?.rgba).toEqual(PIXELS);
});
