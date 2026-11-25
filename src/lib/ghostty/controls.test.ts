import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { matchHerdrWidths } from "../terminalWidths.ts";
import { controlScanner, controlsWriter, fallbackOutput } from "./controls.ts";
import { GhosttyVt } from "./vt.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const parsedOutput = (chunks: readonly string[]) => fallbackOutput(chunks.map((data) => ({ data, sent: data.length })));

const SESSION = "\x1b=\x1b[4h\x1b[?66$p\x1b[4$p\x1b>\x1b[4l" + "\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[>4;2m\x1b]0;a title\x07\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\"
  + "\x1b[2J\x1b[H\x1b[1;31m한글 prompt\x1b[0m $ \x1b[6n" + "x".repeat(70) + "\x1b[3;5H\x1b]52;c;aGVsbG8=\x07\x1b[?6n\x1b[c\x1b[>c\x1b[5n"
  + "\x1bPq#0;2;0;0;0#0~~\x1b\\\x1b_Gf=24;AAAA\x1b\\\x1b[?2026$p\x1b[14t\x1b[?25l\x1b[?1004h\r\nend\x1b[?25h";

test("the scanner takes the same controls from a stream however it is split", () => {
  const whole = controlScanner()(SESSION);
  const pieces = controlScanner();
  const split = [...SESSION].flatMap((ch) => pieces(ch));
  const flat = (list: typeof whole) => list.map((piece) => piece.controls + (piece.question ?? "")).join("");
  expect(flat(split)).toBe(flat(whole));
  expect(whole.map((piece) => piece.question).filter(Boolean)).toEqual(["\x1b[?66$p", "\x1b[4$p", "\x1b[6n", "\x1b[?6n", "\x1b[c", "\x1b[>c", "\x1b[5n", "\x1b[?2026$p", "\x1b[14t"]);
  expect(flat(whole)).not.toContain("prompt");
  expect(flat(whole)).not.toContain("a title");
  expect(flat(whole)).toContain("\x1b]52;c;aGVsbG8=\x07");
});

async function compare(chunks: string[]): Promise<void> {
  const full = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  const only = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  for (const term of [full, only]) matchHerdrWidths(term);
  const vt = await GhosttyVt.create(40, 6);
  const replies = { full: [] as string[], only: [] as string[] };
  full.onData((data) => replies.full.push(data));
  only.onData((data) => replies.only.push(data));
  const writeOnly = controlsWriter(vt, (data, callback) => only.write(data, callback));
  try {
    for (const chunk of chunks) {
      await parse(full, chunk);
      await new Promise<void>((resolve) => writeOnly(chunk, resolve));
    }
    const { buffer: fb, modes: fm } = full, { buffer: ob, modes: om } = only;
    expect(om).toEqual(fm);
    expect([ob.active.type, ob.active.cursorX, ob.active.cursorY]).toEqual([fb.active.type, fb.active.cursorX, fb.active.cursorY]);
    expect(vt.screenCursor()).toEqual({ x: fb.active.cursorX, y: fb.active.cursorY });
    expect(replies.only).toEqual(replies.full);
    expect(replies.only.some((reply) => /^\x1b\[\d+;\d+R$/.test(reply))).toBe(true);
    expect(ob.active.getLine(0)?.translateToString(true)).toBe("");
  } finally {
    vt.dispose();
    full.dispose();
    only.dispose();
  }
}

test("xterm fed the controls alone keeps the modes, the cursor and the answers of an xterm fed everything", async () => {
  await compare([SESSION]);
});

test("the same holds when every frame is cut at any point, a question included", async () => {
  await compare(SESSION.match(/[\s\S]{1,7}/g)!);
});

test("an OSC 52 split across frames reaches xterm whole, nothing written into it between them", async () => {
  const only = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  const vt = await GhosttyVt.create(20, 4);
  const copied: string[] = [];
  only.parser.registerOscHandler(52, (payload) => { copied.push(payload); return true; });
  try {
    const writeOnly = controlsWriter(vt, (data, callback) => only.write(data, callback));
    for (const frame of ["text \x1b]52;c;YWJj", "ZGVm\x07 more"]) await new Promise<void>((resolve) => writeOnly(frame, resolve));
    expect(copied).toEqual(["c;YWJjZGVm"]);
  } finally {
    vt.dispose();
    only.dispose();
  }
});

test("a stream handed to xterm whole keeps everything but the questions it already answered", () => {
  expect(parsedOutput(["a\x1b[6nb", "\x1b[?2004h c\x1b[c", "d"])).toBe("ab\x1b[?2004h cd");
});

test.each([
  ["a\x1b[", "6nb"],
  ["a\u009b", "6nb"],
  ["a\x1b]11;", "?\x07b"],
])("removes an answered query across frames (%j, %j)", (left, right) => {
  expect(parsedOutput([left, right])).toBe("ab");
});

test.each(["\x1b[", "\u009b"])("answers a cursor query before a later open clipboard OSC (%j)", async (csi) => {
  const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  const vt = await GhosttyVt.create(20, 4);
  const replies: string[] = [];
  term.onData((data) => replies.push(data));
  const write = controlsWriter(vt, term.write.bind(term));
  try {
    await new Promise<void>((done) => write(`abc${csi}6n\x1b]52;c;`, done));
    expect(replies).toEqual(["\x1b[1;4R"]);
  } finally { term.dispose(); vt.dispose(); }
});

test("the replay frame gives xterm the clipboard OSC before the live frame completes its id", () => {
  const scan = controlScanner();
  expect(scan("\x1b]5").map((piece) => piece.controls).join("")).toBe("\x1b]5");
  expect(scan("2;c;YWJj\x07").map((piece) => piece.controls).join("")).toBe("2;c;YWJj\x07");
});

test("an OSC 52 whose ST is split between ESC and the backslash reaches xterm's clipboard with the first frame, as a whole stream would", async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const copies: string[] = [];
  term.parser.registerOscHandler(52, (payload) => { copies.push(payload); return true; });
  const scan = controlScanner();
  const sent = ["\x1b]52;c;aGk=\x1b", "\\after"].map((frame) => scan(frame).map((piece) => piece.controls).join(""));
  await parse(term, sent[0]!);
  expect(copies).toEqual(["c;aGk="]);
  await parse(term, sent[1]!);
  expect(copies).toEqual(["c;aGk="]);
  term.dispose();
});
