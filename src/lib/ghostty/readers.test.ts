import { expect, test } from "bun:test";
import { readScreen, readScreenLines } from "../inputRow.ts";
import { columnAt, rowHtml } from "../terminalFold.ts";
import type { ScreenRows } from "../terminalScreen.ts";

import { testTerminal } from "./testTerminal.test-support.ts";

const THEME = { foreground: "#d4d4d4", background: "#1e1e1e", red: "#cd3131", blue: "#2472c8" };

// a Claude-like screen: a styled history, a boxed input row with the cursor in it, wide and coloured cells
const SCREEN = Array.from({ length: 14 }, (_, index) => `\x1b[3${index % 8}m● line ${index} 한글 \x1b[1mbold\x1b[0m \x1b[48;2;40;40;60mbg\x1b[0m\r\n`).join("")
  + "\x1b[2m╭────────────────────────────╮\x1b[0m\r\n│ > fix the 테스트 please    │\r\n\x1b[2m╰────────────────────────────╯\x1b[0m\r\n  ? for shortcuts\x1b[2A\x1b[25G";

async function read<T>(take: (rows: ScreenRows) => T): Promise<T> {
  const term = await testTerminal({ cols: 32, rows: 10, scrollback: 100 });
  try { term.write(SCREEN); return take(term.buffer.active); }
  finally { term.dispose(); }
}

test("the folded view preserves styled text and locates its cursor and wide-cell columns", async () => {
  await read((rows) => {
    const line = rows.getLine(rows.baseY + rows.cursorY);
    if (!line) throw new Error("missing cursor line");
    const cursor = { x: rows.cursorX, shape: "block" as const };
    expect(rowHtml(line, 32, THEME, rows.getNullCell(), 4.5, cursor)).toBe('│ &gt; fix the 테스트 pleas<span class="terminal-fold-cursor" style="background:#d4d4d4;color:#1e1e1e;">e</span>    │');
    const history = rows.getLine(0);
    if (!history) throw new Error("missing history line");
    expect([9, 10, 11].map((x) => columnAt(history, 32, x, rows.getNullCell()))).toEqual([9, 11, 13]);
    expect(rowHtml(history, 32, THEME, rows.getNullCell(), 4.5)).toContain('font-weight:bold;');
  });
});

test("input readers see the live screen and cursor, not the older history", async () => {
  await read((rows) => {
    const screen = readScreen(rows, 32, 10);
    expect(screen.rows[7]?.text).toBe("│ > fix the 테스트 please    │");
    expect([rows.cursorX, rows.cursorY]).toEqual([24, 7]);
    expect(readScreenLines(rows, 10)).toEqual([
      ...Array.from({ length: 6 }, (_, n) => "● line " + (n + 8) + " 한글 bold bg"),
      "╭────────────────────────────╮", "│ > fix the 테스트 please    │", "╰────────────────────────────╯", "  ? for shortcuts",
    ]);
  });
});
