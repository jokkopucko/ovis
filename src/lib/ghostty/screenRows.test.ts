import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { matchHerdrWidths } from "../terminalWidths.ts";
import type { ScreenCell, ScreenRows } from "../terminalScreen.ts";
import { ghosttyRows } from "./screenRows.ts";
import { GhosttyVt } from "./vt.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));

function cellOf(cell: ScreenCell): string {
  const styles = [cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isStrikethrough(), cell.isOverline(), cell.isInverse(), cell.isInvisible()]
    .map((flag) => (flag ? 1 : 0)).join("");
  const colour = (unset: boolean, rgb: boolean, value: number): string => (unset ? "-" : `${rgb ? "#" : "@"}${value}`);
  return `${cell.getChars()}/${cell.getWidth()}/${styles}/${colour(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor())}/${colour(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor())}`;
}

function readAll(rows: ScreenRows, cols: number): string[] {
  const out = [`length ${rows.length} base ${rows.baseY} view ${rows.viewportY} cursor ${rows.cursorX},${rows.cursorY}`];
  for (let y = 0; y < rows.length; y++) {
    const line = rows.getLine(y);
    if (!line) { out.push(`${y} missing`); continue; }
    const cells = Array.from({ length: cols }, (_, x) => { const cell = line.getCell(x); return cell ? cellOf(cell) : "none"; });
    out.push(`${y} ${line.isWrapped ? "wrapped" : "own"} [${line.translateToString(true)}] [${line.translateToString(false)}] [${line.translateToString(true, 2, 9)}] ${cells.join(" ")}`);
  }
  return out;
}

async function both(cols: number, rows: number, scrollback: number, stream: string[]): Promise<{ xterm: string[]; ghostty: string[] }> {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  matchHerdrWidths(term);
  const vt = await GhosttyVt.create(cols, rows);
  try {
    vt.setScrollback(scrollback);
    for (const chunk of stream) {
      vt.write(chunk);
      await parse(term, chunk);
    }
    return { xterm: readAll(term.buffer.active, cols), ghostty: readAll(ghosttyRows(vt), cols) };
  } finally {
    vt.dispose();
    term.dispose();
  }
}

test("libghostty's rows read as xterm's: text, wide cells, graphemes, styles, colours, wraps and the cursor", async () => {
  const { xterm, ghostty } = await both(12, 4, 0, [
    "plain \x1b[1mbold\x1b[0m\r\n",
    "한글 \x1b[3;4mit\x1b[9mx\x1b[53mo\x1b[0m \x1b[2;7md\x1b[8mh\x1b[0m\r\n",
    "\x1b[31mred\x1b[38;5;208m208\x1b[38;2;1;2;3mrgb\x1b[48;5;4mb\x1b[48;2;9;8;7mB\x1b[0m\r\n",
    "👨‍👩‍👧 🇰🇷 \x1b[44m\x1b[K\x1b[0mwrapping on",
  ]);
  expect(ghostty).toEqual(xterm);
});

test("libghostty's rows read as xterm's with history above the screen and a wide cell pushed to the next row", async () => {
  const { xterm, ghostty } = await both(9, 3, 100, [
    ...Array.from({ length: 8 }, (_, index) => `line ${index}\r\n`),
    "abcdefgh한글 next\r\nPassword: ",
  ]);
  expect(ghostty).toEqual(xterm);
});

test("libghostty's rows read as xterm's on the alternate screen", async () => {
  const { xterm, ghostty } = await both(10, 3, 100, ["before\r\n", "\x1b[?1049h\x1b[2;3Halt \x1b[1mscreen\x1b[0m", "\x1b[3;1H$ "]);
  expect(ghostty).toEqual(xterm);
});

test("libghostty's rows read as xterm's after an erase from a wrapped row's first column ends its wrap", async () => {
  const { xterm, ghostty } = await both(10, 6, 0, [
    `${"a".repeat(12)}\x1b[2;1H\x1b[K`,
    `\r\n${"b".repeat(12)}\x1b[4;1H\x1b[2Kc`,
    `\r\n${"d".repeat(12)}\x1b[6;1H\x1b[J`,
  ]);
  expect(ghostty).toEqual(xterm);
});
