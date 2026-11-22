import { createEmulator } from "../emulator/ghostty.ts";
import type { Emulator } from "../emulator/index.ts";

/** One cell of laid-out text: its column counted from where the text starts, its grapheme and its width. */
export interface LaidCell { col: number; text: string; width: 1 | 2 }
export interface Laid { cells: LaidCell[]; end: number }

/** the longest text laid out at once (tui/emulator's widest terminal) */
const LINE_COLS = 1000;
/** room for a wide cell left of a wide cell, away from both edges, and a last column of its own */
const PAIR_COLS = 8;
const MIDDLE = 2;
/** answers kept per question before the memo starts again */
const MEMO_LIMIT = 8192;
const HOME = "\x1b[H\x1b[2K";
const encoder = new TextEncoder();
const cup = (col: number): string => `\x1b[1;${col + 1}H`;

const isPlainAscii = (text: string): boolean => text.length === 1 && text.charCodeAt(0) >= 0x20 && text.charCodeAt(0) < 0x7f;

function firstRow(emulator: Emulator): LaidCell[] | null {
  const cells: LaidCell[] = [];
  const drawn = emulator.frameAll((y, runs) => {
    if (y !== 0) return;
    for (const run of runs) {
      let col = run.x;
      for (const cell of run.cells) {
        cells.push({ col, text: cell.text, width: cell.wide ? 2 : 1 });
        col += cell.wide ? 2 : 1;
      }
    }
  });
  return drawn.ok ? cells : null;
}

function remember<T>(memo: Map<string, T>, key: string, answer: T): T {
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, answer);
  return answer;
}

/**
 * How a host terminal with herdr-core's widths lays text out, asked of the engine itself rather than of a width table: text is
 * written into small emulators of this module's own (the same engine and widths as every pane, autowrap on as a host has it)
 * and their cells read back. Answers are remembered. If the emulators could not be made, nothing but plain ASCII is trusted.
 */
export class HostLayout {
  private readonly laid = new Map<string, Laid>();
  private readonly placed = new Map<string, boolean>();

  constructor(private readonly line: Emulator | null, private readonly pair: Emulator | null, private readonly single: Emulator | null) {}

  /** the cells `text` takes when written from a column of its own, and the column after it */
  layout(text: string): Laid {
    const known = this.laid.get(text);
    if (known) return known;
    const cells = this.line && this.line.write(encoder.encode(HOME + text)).ok ? firstRow(this.line) : null;
    const cursor = cells && this.line ? this.line.cursorState() : null;
    if (!cells || !cursor?.ok) {
      const plain = [...text].map((char, col): LaidCell => ({ col, text: isPlainAscii(char) ? char : "?", width: 1 }));
      return { cells: plain, end: plain.length };
    }
    const end = cursor.value.x;
    const used = cells.filter(({ col }) => col < end || (end === LINE_COLS - 1 && col === end));
    return remember(this.laid, text, { cells: used, end: Math.min(LINE_COLS, end) });
  }

  /**
   * Whether a host shows `text` as one cell of `width` when it is written at column `col` of a screen `cols` wide right after
   * the cell `left` (its text and width; "" in the first column): false when the host would join it to its left neighbour,
   * draw it another width, wrap it, or lose part of it.
   */
  fits(left: string, leftWidth: number, text: string, width: number, col: number, cols: number): boolean {
    const edge = cols === 1 ? "one" : col === 0 ? "first" : col === cols - 1 ? "last" : "middle";
    const key = `${edge}\u0000${edge === "one" || edge === "first" ? "" : `${leftWidth}${left}`}\u0000${width}${text}`;
    const known = this.placed.get(key);
    if (known !== undefined) return known;
    return remember(this.placed, key, this.tryPlace(edge, left, leftWidth, text, width));
  }

  private tryPlace(edge: "one" | "first" | "last" | "middle", left: string, leftWidth: number, text: string, width: number): boolean {
    const emulator = edge === "one" ? this.single : this.pair;
    if (!emulator) return false;
    const at = edge === "one" || edge === "first" ? 0 : edge === "last" ? PAIR_COLS - 1 : MIDDLE;
    const before = at === 0 || left === "" ? "" : `${cup(at - leftWidth)}${left}`;
    if (!emulator.write(encoder.encode(`${HOME}${before}${cup(at)}${text}`)).ok) return false;
    const cells = firstRow(emulator);
    if (!cells) return false;
    const cell = (col: number) => cells.find((laid) => laid.col === col);
    const shown = cell(at)?.text === text && cell(at)?.width === width;
    return shown && (before === "" || (cell(at - leftWidth)?.text === left && cell(at - leftWidth)?.width === leftWidth));
  }
}

async function make(cols: number, setup: string): Promise<Emulator | null> {
  const made = await createEmulator({ cols, rows: 1, events: {} });
  if (!made.ok) return null;
  return made.value.write(encoder.encode(setup)).ok ? made.value : null;
}

/** the one layout every painter asks: made once, when tui/view is first imported */
export const hostLayout = new HostLayout(...(await Promise.all([make(LINE_COLS, "\x1b[?7l"), make(PAIR_COLS, ""), make(1, "")])));
