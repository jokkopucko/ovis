import { expect, test } from "bun:test";
import type { ScreenRows } from "../terminalScreen.ts";
import { testTerminal } from "./testTerminal.test-support.ts";

async function read<T>(cols: number, rows: number, scrollback: number, stream: readonly string[], take: (rows: ScreenRows & { readonly alternate: boolean }) => T): Promise<T> {
  const term = await testTerminal({ cols, rows, scrollback });
  try {
    for (const data of stream) term.write(data);
    return take(term.buffer.active);
  } finally { term.dispose(); }
}

const lines = (rows: ScreenRows) => Array.from({ length: rows.length }, (_, y) => rows.getLine(y)?.translateToString(true));

test("screen rows expose text, wide cells, graphemes, styles, colors and wraps", async () => {
  await read(12, 5, 0, [
    "plain \x1b[1mbold\x1b[0m\r\n",
    "한글 \x1b[3;4mit\x1b[9mx\x1b[53mo\x1b[0m \x1b[2;7md\x1b[8mh\x1b[0m\r\n",
    "\x1b[31mred\x1b[38;5;208m208\x1b[38;2;1;2;3mrgb\x1b[48;5;4mb\x1b[48;2;9;8;7mB\x1b[0m\r\n",
    "👨‍👩‍👧 🇰🇷 \x1b[44m\x1b[K\x1b[0mwrapping on",
  ], (rows) => {
    expect(lines(rows)).toEqual(["plain bold", "한글 itxo dh", "red208rgbbB", "👨‍👩‍👧 🇰🇷 wrappi", "ng on"]);
    expect([rows.baseY, rows.viewportY, rows.cursorX, rows.cursorY]).toEqual([0, 0, 5, 4]);
    expect(rows.getLine(4)?.isWrapped).toBe(true);
    expect(rows.getLine(4)?.translateToString(false)).toBe("ng on       ");
    expect(rows.getLine(1)?.translateToString(true, 2, 9)).toBe("글 itxo");
    const cell = (y: number, x: number) => rows.getLine(y)?.getCell(x);
    expect([cell(1, 0)?.getWidth(), cell(1, 1)?.getWidth(), cell(3, 0)?.getChars(), cell(3, 3)?.getChars()]).toEqual([2, 0, "👨‍👩‍👧", "🇰🇷"]);
    expect([cell(0, 6)?.isBold(), cell(1, 5)?.isItalic(), cell(1, 5)?.isUnderline(), cell(1, 7)?.isStrikethrough(), cell(1, 8)?.isOverline(), cell(1, 10)?.isDim(), cell(1, 10)?.isInverse(), cell(1, 11)?.isInvisible()].map(Boolean)).toEqual(Array(8).fill(true));
    expect([cell(2, 0)?.getFgColor(), cell(2, 3)?.getFgColor(), cell(2, 6)?.getFgColor(), cell(2, 9)?.getBgColor(), cell(2, 10)?.getBgColor()]).toEqual([1, 208, 0x010203, 4, 0x090807]);
    expect([cell(2, 0)?.isBgDefault(), cell(2, 6)?.isFgRGB(), cell(2, 9)?.isBgRGB(), cell(2, 10)?.isBgRGB()]).toEqual([true, true, false, true]);
  });
});

test("history precedes a wrapped wide cell and the cursor is relative to the active screen", async () => {
  await read(9, 3, 100, [...Array.from({ length: 8 }, (_, n) => "line " + n + "\r\n"), "abcdefgh한글 next\r\nPassword: "], (rows) => {
    expect([rows.length, rows.baseY, rows.viewportY, rows.cursorX, rows.cursorY]).toEqual([12, 9, 9, 1, 2]);
    expect(lines(rows).slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, n) => "line " + n));
    expect(rows.getLine(8)?.translateToString(false)).toBe("abcdefgh ");
    expect(rows.getLine(9)?.isWrapped).toBe(true);
    expect(rows.getLine(9)?.translateToString(true)).toBe("한글 next");
    expect(rows.getLine(10)?.translateToString(true)).toBe("Password:");
  });
});

test("an alternate screen has its own rows and no history", async () => {
  await read(10, 3, 100, ["before\r\n", "\x1b[?1049h\x1b[2;3Halt \x1b[1mscreen\x1b[0m", "\x1b[3;1H$ "], (rows) => {
    expect(rows.alternate).toBe(true);
    expect([rows.baseY, rows.viewportY, rows.cursorX, rows.cursorY]).toEqual([0, 0, 2, 2]);
    expect(lines(rows)).toEqual(["", "  alt scre", "$ "]);
    expect(rows.getLine(1)?.getCell(6)?.isBold()).toBeTruthy();
  });
});

test("erasing from the first column of a wrapped row ends its wrap", async () => {
  await read(10, 6, 0, ["a".repeat(12) + "\x1b[2;1H\x1b[K", "\r\n" + "b".repeat(12) + "\x1b[4;1H\x1b[2Kc", "\r\n" + "d".repeat(12) + "\x1b[6;1H\x1b[J"], (rows) => {
    expect(lines(rows)).toEqual(["aaaaaaaaaa", "", "bbbbbbbbbb", "c", "dddddddddd", ""]);
    expect([1, 3, 5].map((y) => rows.getLine(y)?.isWrapped)).toEqual([false, false, false]);
    expect([rows.cursorX, rows.cursorY]).toEqual([0, 5]);
  });
});
