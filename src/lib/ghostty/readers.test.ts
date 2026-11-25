import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { readScreen, readScreenLines } from "../inputRow.ts";
import { columnAt, rowHtml } from "../terminalFold.ts";
import type { ScreenRows } from "../terminalScreen.ts";
import { matchHerdrWidths } from "../terminalWidths.ts";
import { ghosttyRows } from "./screenRows.ts";
import { GhosttyVt } from "./vt.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const THEME = { foreground: "#d4d4d4", background: "#1e1e1e", red: "#cd3131", blue: "#2472c8" };

// a Claude-like screen: a styled history, a boxed input row with the cursor in it, wide and coloured cells
const SCREEN = Array.from({ length: 14 }, (_, index) => `\x1b[3${index % 8}m● line ${index} 한글 \x1b[1mbold\x1b[0m \x1b[48;2;40;40;60mbg\x1b[0m\r\n`).join("")
  + "\x1b[2m╭────────────────────────────╮\x1b[0m\r\n│ > fix the 테스트 please    │\r\n\x1b[2m╰────────────────────────────╯\x1b[0m\r\n  ? for shortcuts\x1b[2A\x1b[25G";

async function both<T>(read: (rows: ScreenRows) => T): Promise<{ xterm: T; ghostty: T }> {
  const term = new Terminal({ cols: 32, rows: 10, scrollback: 100, allowProposedApi: true });
  matchHerdrWidths(term);
  const vt = await GhosttyVt.create(32, 10);
  try {
    vt.setScrollback(100);
    vt.write(SCREEN);
    await parse(term, SCREEN);
    return { xterm: read(term.buffer.active), ghostty: read(ghosttyRows(vt)) };
  } finally {
    vt.dispose();
    term.dispose();
  }
}

test("the folded view draws the same rows off libghostty's screen as off xterm's, the cursor's row included", async () => {
  const draw = (rows: ScreenRows) => Array.from({ length: rows.length }, (_, y) => {
    const line = rows.getLine(y)!;
    const cursor = y === rows.baseY + rows.cursorY ? { x: rows.cursorX, shape: "block" as const } : null;
    return [rowHtml(line, 32, THEME, rows.getNullCell(), 4.5, cursor), columnAt(line, 32, 5, rows.getNullCell())];
  });
  const { xterm, ghostty } = await both(draw);
  expect(ghostty).toEqual(xterm);
});

test("the input row and the screen's lines read the same off libghostty's screen as off xterm's", async () => {
  const { xterm, ghostty } = await both((rows) => ({ screen: readScreen(rows, 32, 10), lines: readScreenLines(rows, 10), cursor: [rows.cursorX, rows.cursorY] }));
  expect(ghostty).toEqual(xterm);
});
