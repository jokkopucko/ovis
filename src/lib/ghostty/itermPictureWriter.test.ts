import { expect, test } from "bun:test";
import { encodePng } from "../itermPictures.ts";
import { itermPictureWriter } from "./itermPictureWriter.ts";
import { ghosttyRows } from "./screenRows.ts";
import { GhosttyVt } from "./vt.ts";

const CAPS = { sizeLimit: 20_000_000, pixelLimit: 4096 * 4096 };
const GRID = { cols: 20, rows: 10, cellW: 8, cellH: 16 };
const png = Buffer.from(await encodePng(2, 2, new Uint8Array(16).fill(255))).toString("base64");
const osc = (body: string, end = "\x07") => `\x1b]1337;${body}${end}`;
const file = (args: string, base64 = png, end?: string) => osc(`File=${args}:${base64}`, end);
const cancel = "\x18";
const kitty = (base64: string, placement = "") => `\x1b_Gf=100,a=T,q=2${placement},m=0;${base64}\x1b\\`;

function rewrite(chunks: readonly (string | Uint8Array)[], caps: typeof CAPS | null = CAPS): Buffer {
  const writer = itermPictureWriter(() => caps, () => GRID);
  const result: Buffer[] = [];
  for (const chunk of chunks) writer.write(chunk, (output) => { result.push(Buffer.from(output)); });
  return Buffer.concat(result);
}

test("rewrites a picture at every byte boundary without touching other bytes", () => {
  const before = Buffer.concat([Buffer.from("前\x1b[31m\x1b]0;title\x1b\\\x1b]1337;SetMark\x07"), Buffer.from([0xff])]);
  const after = Buffer.from("\x1b_Ga=d\x1b\\\x1bP$qm\x1b\\後\x1b[0m");
  const input = Buffer.concat([before, Buffer.from(file("inline=1;width=3;height=2;preserveAspectRatio=0", png, "\x1b\\")), after]);
  const expected = Buffer.concat([before, Buffer.from(cancel + kitty(png, ",c=3,r=2")), after]);
  const splitAtOsc = before.length + 2;
  const expectedSplit = Buffer.concat([before, Buffer.from("\x1b]" + cancel + kitty(png, ",c=3,r=2")), after]);
  expect(rewrite([input])).toEqual(expected);
  for (let i = 1; i < input.length; i++) {
    expect(rewrite([input.subarray(0, i), input.subarray(i)])).toEqual(i === splitAtOsc ? expectedSplit : expected);
  }
  expect(rewrite(Array.from(input, (byte) => Uint8Array.of(byte)))).toEqual(expectedSplit);
});

async function rewriteAll(chunks: readonly (string | Uint8Array)[], caps: Parameters<typeof itermPictureWriter>[0] = () => CAPS): Promise<Buffer> {
  const writer = itermPictureWriter(caps, () => GRID, () => [12, 34, 56]);
  const result: Buffer[] = [];
  for (const chunk of chunks) writer.write(chunk, (output) => { result.push(Buffer.from(output)); });
  await new Promise<void>((done) => writer.write("", (output) => { result.push(Buffer.from(output)); }, done));
  return Buffer.concat(result);
}

test("holds split sixels and emits their PNG before same-write and later text at every byte boundary", async () => {
  const dcs = '\x1bP0;1;0q"1;1;2;1#1@\x1b\\';
  const before = Buffer.concat([Buffer.from("前\x1b[31m"), Buffer.from([0xff])]);
  const after = Buffer.from("\x1bP$qm\x1b\\後\x1b[0m");
  const input = Buffer.concat([before, Buffer.from(dcs), after]);
  const converted = Buffer.from(await encodePng(2, 1, Uint8Array.of(51, 51, 204, 255, 0, 0, 0, 0))).toString("base64");
  const expected = Buffer.concat([before, Buffer.from(cancel + kitty(converted)), after]);
  expect(await rewriteAll([input])).toEqual(expected);
  for (let i = 1; i < input.length; i++) {
    expect(await rewriteAll([input.subarray(0, i), input.subarray(i)])).toEqual(expected);
  }
  expect(await rewriteAll(Array.from(input, (byte) => Uint8Array.of(byte)))).toEqual(expected);
});

test("uses opaque background when P2 is omitted", async () => {
  const converted = Buffer.from(await encodePng(2, 1, Uint8Array.of(255, 255, 255, 255, 12, 34, 56, 255))).toString("base64");
  expect((await rewriteAll(['\x1bPq"1;1;2;1@\x1b\\'])).toString()).toBe(cancel + kitty(converted));
});

test.each([
  { body: "#1@", caps: null, name: "pictures off" },
  { body: "#1@", caps: { ...CAPS, sixelSizeLimit: 2 }, name: "sixel byte cap" },
  { body: "!200~", caps: { ...CAPS, pixelLimit: 100 }, name: "pixel cap" },
  { body: "!20000~", caps: { ...CAPS, pixelLimit: Infinity }, name: "hard side cap" },
  { body: "!2", caps: CAPS, name: "malformed repeat" },
])("drops sixels without losing following text ($name)", async ({ body, caps }) => {
  expect((await rewriteAll(`a\x1bP0;1q${body}\x1b\\b`.split(""), () => caps)).toString()).toBe(`a${cancel}b`);
});

test("joins imgcat parts and places the picture at FileEnd", () => {
  const input = `a${osc("MultipartFile=inline=1")}${osc(`FilePart=${png.slice(0, 7)}`)}b${osc(`FilePart=${png.slice(7)}`)}c${osc("FileEnd", "\x1b\\")}d`;
  const boundary = "\x1b]" + cancel;
  expect(rewrite(input.split("")).toString()).toBe(`a${boundary}${boundary}b${boundary}c${boundary}${kitty(png)}d`);
});

test("swallows downloads, disabled, invalid and over-limit pictures without losing following text", () => {
  expect(rewrite([file("inline=0"), "download", file("inline=1", "bad!"), "invalid"]).toString()).toBe(`${cancel}download${cancel}invalid`);
  expect(rewrite([file("inline=1"), "off"], null).toString()).toBe(`${cancel}off`);
  expect(rewrite([file("inline=1"), "bytes"], { ...CAPS, sizeLimit: 8 }).toString()).toBe(`${cancel}bytes`);
  expect(rewrite([file("inline=1"), "pixels"], { ...CAPS, pixelLimit: 4 }).toString()).toBe(`${cancel}pixels`);
  expect(rewrite([file("inline=1;width=4294967295"), "oversized placement"]).toString()).toBe(`${cancel}oversized placement`);
  const overflowingPart = osc(`FilePart=${"A".repeat(70_000)}`);
  expect(rewrite([osc("MultipartFile=inline=1"), overflowingPart, osc(`FilePart=${png}`), osc("FileEnd"), "tail"], { ...CAPS, sizeLimit: 100 }).toString()).toBe(`${cancel.repeat(4)}tail`);
});

test.each([false, true])("a disabled picture cancels a preceding partial CSI (split: %s)", async (split) => {
  const chunks = split ? ["\x1b[31", file("inline=1"), "mvisible"] : [`\x1b[31${file("inline=1")}mvisible`];
  const vt = await GhosttyVt.create(GRID.cols, GRID.rows);
  try {
    vt.write(rewrite(chunks, null));
    expect(ghosttyRows(vt).getLine(0)?.translateToString(true)).toBe("mvisible");
  } finally { vt.dispose(); }
});

test("translates dimensions and keeps the aspect ratio unless explicitly disabled", () => {
  expect(rewrite([file("inline=1;width=25%;height=32px")]).toString()).toBe(cancel + kitty(png, ",c=5"));
  expect(rewrite([file("inline=1;width=auto;height=17px")]).toString()).toBe(cancel + kitty(png, ",r=2"));
  expect(rewrite([file("inline=1;width=17px;height=20%;preserveAspectRatio=0")]).toString()).toBe(cancel + kitty(png, ",c=3,r=2"));
});

test("sends a chunked PNG to libghostty and places it before subsequent text", async () => {
  let seed = 42;
  const pixels = Uint8Array.from({ length: 48 * 48 * 4 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  });
  const payload = Buffer.from(await encodePng(48, 48, pixels)).toString("base64");
  const output = rewrite([file("inline=1;width=4;height=3;preserveAspectRatio=0", payload), "X"]).toString();
  const apcs = [...output.matchAll(/\x1b_G([^;]+);([A-Za-z0-9+/=]+)\x1b\\/g)];
  expect(apcs.map((match) => match[1])).toEqual([
    "f=100,a=T,q=2,c=4,r=3,m=1", ...Array.from({ length: Math.ceil(payload.length / 4096) - 2 }, () => "m=1"), "m=0",
  ]);
  expect(apcs.map((match) => match[2]?.length)).toEqual(Array.from({ length: apcs.length }, (_, i) => Math.min(4096, payload.length - i * 4096)));
  expect(apcs.map((match) => match[2]).join("")).toBe(payload);

  const vt = await GhosttyVt.create(GRID.cols, GRID.rows);
  try {
    vt.resize(GRID.cols, GRID.rows, GRID.cellW, GRID.cellH);
    vt.write(output);
    const lines: string[] = [];
    vt.frame((y, runs) => { lines[y] = runs.flatMap((run) => run.cells.map((cell) => cell.text)).join(""); });
    expect(vt.placedImages()).toEqual([expect.objectContaining({ col: 0, row: 0, width: 32, height: 48 })]);
    expect(lines[2]).toMatch(/^ {4}X/);
  } finally { vt.dispose(); }
});

// A baseline little-endian, 8-bit greyscale TIFF with one pixel, one strip and an IFD.
function greyTiff(): string {
  const tags = [[256, 1], [257, 1], [258, 8], [259, 1], [262, 1], [273, 8], [279, 1]];
  const bytes = Buffer.alloc(12 + tags.length * 12 + 4);
  bytes.set([0x49, 0x49, 42, 0, 10, 0, 0, 0, 123, 0]);
  bytes.writeUInt16LE(tags.length, 10);
  tags.forEach(([tag = 0, value = 0], i) => {
    const at = 12 + i * 12;
    bytes.writeUInt16LE(tag, at);
    bytes.writeUInt16LE(4, at + 2);
    bytes.writeUInt32LE(1, at + 4);
    bytes.writeUInt32LE(value, at + 8);
  });
  return bytes.toString("base64");
}

test("waits for TIFF conversion before same-write and later text", async () => {
  const writer = itermPictureWriter(() => CAPS, () => GRID);
  const output: string[] = [];
  const emit = (data: string | Uint8Array) => { output.push(data.toString()); };
  writer.write(`head${file("inline=1", greyTiff())}same`, emit);
  const finished = new Promise<void>((resolve) => writer.write("later", emit, resolve));
  expect(output).toEqual(["head", cancel]);
  await finished;
  const converted = Buffer.from(await encodePng(1, 1, Uint8Array.of(123, 123, 123, 255))).toString("base64");
  expect(output.join("")).toBe(`head${cancel}${kitty(converted)}samelater`);
});

test("drops the pending image on queue overflow but still emits every later byte", () => {
  const writer = itermPictureWriter(() => CAPS, () => GRID);
  const output: string[] = [];
  const emit = (data: string | Uint8Array) => { output.push(data.toString()); };
  const large = "x".repeat(4 * 1024 * 1024 + 1);
  writer.write(`${file("inline=1", greyTiff())}same`, emit);
  writer.write("later", emit);
  writer.write(large, emit);
  expect(output).toEqual([cancel, "same", "later", large]);
});

test("a string whose ESC ends a write goes on with that ESC, as xterm ends the string there", () => {
  const writer = itermPictureWriter(() => CAPS, () => GRID);
  const out: string[] = [];
  for (const chunk of ["\x1b]52;c;aGk=\x1b", "\\after"]) writer.write(chunk, (output) => { out.push(Buffer.from(output).toString()); });
  expect(out).toEqual(["\x1b]52;c;aGk=\x1b", "\\after"]);
});
