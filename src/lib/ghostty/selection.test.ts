import { expect, test } from "bun:test";
import { viewRows, type ScreenRows } from "../terminalScreen.ts";
import { selectionText, wordAt, wrappedRange } from "./selection.ts";

import { testTerminal } from "./testTerminal.test-support.ts";

const SEPARATORS = " ()[]{}',\"`";
async function readSelection<T>(cols: number, rows: number, stream: string, read: (rows: ScreenRows) => T): Promise<T> {
  const term = await testTerminal({ cols, rows, scrollback: 50 });
  try { term.write(stream); return read(viewRows(term)); }
  finally { term.dispose(); }
}

const SCREEN = "$ ls (src/lib) 한글단어 x\r\n👨‍👩‍👧 emoji-word, \"quoted\"\r\n" + "averyveryverylongwordthatwraps".repeat(2) + " tail\r\n  \tindented   line   \r\n";

test("a double click counts wide cells and follows a wrapped word", async () => {
  const points: [number, number][] = [[14, 0], [1, 1], [1, 3], [3, 4], [0, 6]];
  const read = (rows: ScreenRows) => points.map((point) => wordAt(rows, 20, SEPARATORS, point, false));
  expect(await readSelection(20, 8, SCREEN, read)).toEqual([undefined, { start: 0, length: 4 }, { start: -4, length: 6 }, { start: 0, length: 60 }, { start: -40, length: 60 }]);
});

test("a word is cut at xterm's separators and follows a wrap onto the next row", async () => {
  const ghostty = await readSelection(20, 4, `ab (word) cd\r\n${"x".repeat(30)}\r\n`, (rows) => ({
    inParens: wordAt(rows, 20, SEPARATORS, [5, 0], false),
    wrapped: wordAt(rows, 20, SEPARATORS, [3, 1], false),
    blank: wordAt(rows, 20, SEPARATORS, [15, 0], false),
    lines: wrappedRange(rows, 2),
  }));
  // "word" is columns 4-7 of row 0; the 30 x's fill row 1 and wrap 10 columns onto row 2
  expect(ghostty).toEqual({ inParens: { start: 4, length: 4 }, wrapped: { start: 0, length: 30 }, blank: undefined, lines: { first: 1, last: 2 } });
});

test("a triple click and a copy join soft wraps but retain hard breaks", async () => {
  const read = (rows: ScreenRows) => ({
    ranges: [0, 1, 2, 3, 4, 5, 6].map((y) => wrappedRange(rows, y)),
    text: selectionText(rows, [3, 0], [5, 6], false, "\n"),
    oneRow: selectionText(rows, [2, 1], [12, 1], false, "\n"),
    column: selectionText(rows, [2, 0], [9, 6], true, "\n"),
    empty: selectionText(rows, [4, 0], [4, 3], true, "\n"),
  });
  const expected = {
    ranges: ([[0, 1], [0, 1], [2, 3], [2, 3], [4, 7], [4, 7], [4, 7]] as const).map(([first, last]) => ({ first, last })),
    text: "s (src/lib) 한글단어 x\n👨‍👩‍👧 emoji-word, \"quoted\"\naveryveryverylongwordthatwrapsaveryveryverylo",
    oneRow: "어 x", column: "ls (src\n어 x\n emoji-\n\"\neryvery\nhatwrap\nylongwo", empty: "",
  };
  expect(await readSelection(20, 8, SCREEN, read)).toEqual(expected);
});

test("a wide glyph's second column is taken as xterm takes it: in a double click, a copy that starts there and a column copy", async () => {
  const ghostty = await readSelection(4, 4, "界 cat\r\na界BC\r\n0123\r\na界B\r\n0123", (rows) => ({
    rightHalf: wordAt(rows, 4, SEPARATORS, [1, 0], false),
    wrapped: wordAt(rows, 4, SEPARATORS, [2, 2], false),
    fromSecondHalf: selectionText(rows, [1, 0], [5, 0], false, "\n"),
    column: selectionText(rows, [2, 4], [4, 6], true, "\n"),
  }));
  // xterm.js 6: the word is the glyph; the word runs on over the wrap; a copy from the second column starts with a space
  expect(ghostty).toEqual({ rightHalf: { start: 0, length: 2 }, wrapped: { start: 0, length: 5 }, fromSecondHalf: "  c", column: "23\n B\n23" });
});

test("selection reads the visible cells before and after scrolling", async () => {
  const term = await testTerminal({ cols: 80, rows: 3, scrollback: 50 });
  try {
    const lines = [1, 2, 3, 4, 5, 6].map((n) => String(n).repeat(100));
    term.write(lines.join("\r\n"));
    term.resize(120, 3);
    const shown = () => {
      const rows = viewRows(term);
      return Array.from({ length: 3 }, (_, y) => rows.getLine(rows.viewportY + y)?.translateToString(true));
    };
    expect(shown()).toEqual(lines.slice(-3));
    term.scrollFromBottom(50);
    expect(shown()).toEqual(lines.slice(0, 3));
  } finally { term.dispose(); }
});

test("a triple click includes the start of a wrapped line above the view", async () => {
  const term = await testTerminal({ cols: 10, rows: 2, scrollback: 50 });
  try {
    term.write("abcdefghijklmnopqrstuvwxyz123\r\n$ ");
    const rows = viewRows(term);
    const { first, last } = wrappedRange(rows, rows.viewportY);
    expect({ first, last }).toEqual({ first: 0, last: 2 });
    expect(selectionText(rows, [0, first], [10, last], false, "\n")).toBe("abcdefghijklmnopqrstuvwxyz123");
  } finally { term.dispose(); }
});
