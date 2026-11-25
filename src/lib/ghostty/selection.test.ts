import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { matchHerdrWidths } from "../terminalWidths.ts";
import { holdScreenRows, viewRows, type ScreenRows } from "../terminalScreen.ts";
import { ghosttyRows } from "./screenRows.ts";
import { selectionText, wordAt, wrappedRange } from "./selection.ts";
import { GhosttyVt } from "./vt.ts";

const SEPARATORS = " ()[]{}',\"`";
const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));

async function both(cols: number, rows: number, stream: string, read: (rows: ScreenRows) => unknown): Promise<{ xterm: unknown; ghostty: unknown }> {
  const term = new Terminal({ cols, rows, scrollback: 50, allowProposedApi: true });
  matchHerdrWidths(term);
  const vt = await GhosttyVt.create(cols, rows);
  try {
    vt.setScrollback(50);
    vt.write(stream);
    await parse(term, stream);
    return { xterm: read(term.buffer.active), ghostty: read(ghosttyRows(vt)) };
  } finally {
    vt.dispose();
    term.dispose();
  }
}

const SCREEN = "$ ls (src/lib) 한글단어 x\r\n👨‍👩‍👧 emoji-word, \"quoted\"\r\n" + "averyveryverylongwordthatwraps".repeat(2) + " tail\r\n  \tindented   line   \r\n";

test("a double click takes the same word off either engine's rows, wide cells, graphemes and wraps included", async () => {
  const points: [number, number][] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 20; x++) points.push([x, y]);
  const read = (rows: ScreenRows) => points.map((point) => [wordAt(rows, 20, SEPARATORS, point, true), wordAt(rows, 20, SEPARATORS, point, false)]);
  const { xterm, ghostty } = await both(20, 8, SCREEN, read);
  expect(ghostty).toEqual(xterm);
});

test("a word is cut at xterm's separators and follows a wrap onto the next row", async () => {
  const { ghostty } = await both(20, 4, `ab (word) cd\r\n${"x".repeat(30)}\r\n`, (rows) => ({
    inParens: wordAt(rows, 20, SEPARATORS, [5, 0], false),
    wrapped: wordAt(rows, 20, SEPARATORS, [3, 1], false),
    blank: wordAt(rows, 20, SEPARATORS, [15, 0], false),
    lines: wrappedRange(rows, 2),
  }));
  // "word" is columns 4-7 of row 0; the 30 x's fill row 1 and wrap 10 columns onto row 2
  expect(ghostty).toEqual({ inParens: { start: 4, length: 4 }, wrapped: { start: 0, length: 30 }, blank: undefined, lines: { first: 1, last: 2 } });
});

test("a triple click and a copy take the same lines and text off either engine's rows", async () => {
  const read = (rows: ScreenRows) => ({
    ranges: [0, 1, 2, 3, 4, 5, 6].map((y) => wrappedRange(rows, y)),
    text: selectionText(rows, [3, 0], [5, 6], false, "\n"),
    oneRow: selectionText(rows, [2, 1], [12, 1], false, "\n"),
    column: selectionText(rows, [2, 0], [9, 6], true, "\n"),
    empty: selectionText(rows, [4, 0], [4, 3], true, "\n"),
  });
  const { xterm, ghostty } = await both(20, 8, SCREEN, read);
  expect(ghostty).toEqual(xterm);
});

test("a wide glyph's second column is taken as xterm takes it: in a double click, a copy that starts there and a column copy", async () => {
  const { ghostty, xterm } = await both(4, 4, "界 cat\r\na界BC\r\n0123\r\na界B\r\n0123", (rows) => ({
    rightHalf: wordAt(rows, 4, SEPARATORS, [1, 0], false),
    wrapped: wordAt(rows, 4, SEPARATORS, [2, 2], false),
    fromSecondHalf: selectionText(rows, [1, 0], [5, 0], false, "\n"),
    column: selectionText(rows, [2, 4], [4, 6], true, "\n"),
  }));
  expect(ghostty).toEqual(xterm);
  // xterm.js 6: the word is the glyph; the word runs on over the wrap; a copy from the second column starts with a space
  expect(ghostty).toEqual({ rightHalf: { start: 0, length: 2 }, wrapped: { start: 0, length: 5 }, fromSecondHalf: "  c", column: "23\n B\n23" });
});

test("a row of xterm's view reads as the row libghostty draws there, at the bottom and at the top", async () => {
  const term = new Terminal({ cols: 80, rows: 3, scrollback: 50, allowProposedApi: true });
  const vt = await GhosttyVt.create(80, 3);
  try {
    vt.setScrollback(50);
    const stream = [1, 2, 3, 4, 5, 6].map((n) => String(n).repeat(100)).join("\r\n");
    vt.write(stream);
    await parse(term, stream);
    // widened, the two engines lay the screen out differently and keep different depths of history
    term.resize(120, 3);
    vt.resize(120, 3, 8, 16);
    holdScreenRows(term, () => ghosttyRows(vt));
    // the overlay shows libghostty's view as far from the bottom as xterm's (overlay.ts drawFrame)
    const follow = (): void => vt.scrollFromBottom(term.buffer.active.baseY - term.buffer.active.viewportY);
    const shown = (): (string | undefined)[] => [0, 1, 2].map((y) => viewRows(term).getLine(term.buffer.active.viewportY + y)?.translateToString(true));
    const drawn = (): (string | undefined)[] => { const rows = ghosttyRows(vt); return [0, 1, 2].map((y) => rows.getLine(rows.viewportY + y)?.translateToString(true)); };
    follow();
    expect(shown()).toEqual(drawn());
    term.scrollToTop();
    follow();
    expect(shown()).toEqual(drawn());
  } finally {
    holdScreenRows(term, null);
    vt.dispose();
    term.dispose();
  }
});

test("with no history in xterm, a triple click on a line that wraps from above the view takes it from its start", async () => {
  const term = new Terminal({ cols: 10, rows: 2, scrollback: 0, allowProposedApi: true });
  const vt = await GhosttyVt.create(10, 2);
  try {
    vt.setScrollback(50);
    vt.write("abcdefghijklmnopqrstuvwxyz123\r\n$ ");
    holdScreenRows(term, () => ghosttyRows(vt));
    // the view shows the line's last row and the prompt: the line starts two rows above it
    const rows = viewRows(term);
    const { first, last } = wrappedRange(rows, 0);
    expect({ first, last }).toEqual({ first: -2, last: 0 });
    expect(selectionText(rows, [0, first], [10, last], false, "\n")).toBe("abcdefghijklmnopqrstuvwxyz123");
  } finally {
    holdScreenRows(term, null);
    vt.dispose();
    term.dispose();
  }
});
