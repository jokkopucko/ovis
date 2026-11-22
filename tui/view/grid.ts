import {
  STYLE_BOLD,
  STYLE_FAINT,
  STYLE_INVERSE,
  STYLE_INVISIBLE,
  STYLE_ITALIC,
  STYLE_STRIKE,
  STYLE_UNDERLINE_MASK,
  type Emulator,
  type EmulatorResult,
  type EngineCursor,
  type GhosttyRun,
  type WrittenColor,
} from "../emulator/index.ts";

/** ghostty's style flags in its own order: blink is bit 3 and overline bit 7, between the ones tui/emulator names */
export const STYLE_BLINK = 1 << 3;
export const STYLE_OVERLINE = 1 << 7;
/** every flag the painter can write back to a host; anything else the engine reports is dropped from the model */
export const SHOWN_FLAGS = STYLE_BOLD | STYLE_ITALIC | STYLE_FAINT | STYLE_BLINK | STYLE_INVERSE | STYLE_INVISIBLE | STYLE_STRIKE | STYLE_OVERLINE | STYLE_UNDERLINE_MASK;

/** A cell's look: colours as the program wrote them (null: the host's default) and the STYLE_* flags. */
export interface Style { fg: WrittenColor | null; bg: WrittenColor | null; flags: number }

const colorKey = (color: WrittenColor | null): string => color === null ? "" : typeof color === "number" ? `${color}` : color.join(",");

/** Styles interned to small numbers, so two cells compare by one number. Id 0 is the default style. */
export class Styles {
  private readonly ids = new Map<string, number>([["||0", 0]]);
  private readonly list: Style[] = [{ fg: null, bg: null, flags: 0 }];

  id(fg: WrittenColor | null, bg: WrittenColor | null, flags: number): number {
    const shown = flags & SHOWN_FLAGS;
    const key = `${colorKey(fg)}|${colorKey(bg)}|${shown}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.list.length;
      this.list.push({ fg, bg, flags: shown });
      this.ids.set(key, id);
    }
    return id;
  }

  get(id: number): Style {
    return this.list[id]!;
  }

  /** the style a blank keeps when it stands in for a cut cell: the same background, inverse included, with no text marks */
  blank(id: number): number {
    const style = this.get(id);
    return this.id(style.fg, style.bg, style.flags & STYLE_INVERSE);
  }
}

/**
 * A rectangle of cells. Each cell has its text (one grapheme; " " when empty), its width (1, 2 for the first column of a
 * wide cell, 0 for the column a wide cell covers) and its style id. A wide cell's covered column holds "" and the wide
 * cell's style.
 */
export class Grid {
  readonly text: string[];
  readonly width: Uint8Array;
  readonly style: Uint32Array;

  constructor(readonly cols: number, readonly rows: number) {
    const size = cols * rows;
    this.text = new Array<string>(size).fill(" ");
    this.width = new Uint8Array(size).fill(1);
    this.style = new Uint32Array(size);
  }

  clearRow(row: number): void {
    const start = row * this.cols;
    this.text.fill(" ", start, start + this.cols);
    this.width.fill(1, start, start + this.cols);
    this.style.fill(0, start, start + this.cols);
  }

  clear(): void {
    this.text.fill(" ");
    this.width.fill(1);
    this.style.fill(0);
  }

  copyRow(from: Grid, row: number): void {
    const start = row * this.cols;
    for (let i = start; i < start + this.cols; i++) this.text[i] = from.text[i]!;
    this.width.set(from.width.subarray(start, start + this.cols), start);
    this.style.set(from.style.subarray(start, start + this.cols), start);
  }
}

/**
 * One pane's cells at its terminal's real size, filled only from the emulator's frames (step 1 of a frame pass), and the rows
 * that changed since the painter last drew them.
 */
export class PaneGrid {
  grid: Grid;
  readonly dirty: Set<number> = new Set();
  /** every row is to be drawn again: a new grid, or a pane shown for the first time */
  allDirty = true;
  /** the cursor read after the last copied frame; null before the first */
  cursor: EngineCursor | null = null;
  /** the last place the cursor was seen visible, where a hidden cursor is parked */
  lastSeen: { x: number; y: number } | null = null;

  constructor(private readonly styles: Styles, cols: number, rows: number) {
    this.grid = new Grid(cols, rows);
  }

  /** a new size, after the terminal's own changed: every row is drawn again, from the next `copy(…, true)` */
  resize(cols: number, rows: number): void {
    if (cols === this.grid.cols && rows === this.grid.rows) return;
    this.grid = new Grid(cols, rows);
    this.dirty.clear();
    this.allDirty = true;
  }

  /**
   * Step 1: the rows the emulator changed since its last frame (every row with `all`) copied in, then its cursor. The draw
   * callback only copies cells; the emulator is called again only after `frame` returned.
   */
  copy(emulator: Emulator, all = false): EmulatorResult<boolean> {
    const draw = (y: number, runs: GhosttyRun<WrittenColor>[]): void => {
      if (y >= this.grid.rows) return;
      this.copyRow(y, runs);
      this.dirty.add(y);
    };
    let drawn: EmulatorResult<boolean>;
    if (all) {
      const result = emulator.frameAll(draw);
      drawn = result.ok ? { ok: true, value: true } : result;
    } else {
      drawn = emulator.frame(draw);
    }
    if (!drawn.ok) return drawn;
    const cursor = emulator.cursorState();
    if (!cursor.ok) return cursor;
    this.cursor = cursor.value;
    if (cursor.value.visible) this.lastSeen = { x: cursor.value.x, y: cursor.value.y };
    return drawn;
  }

  private copyRow(y: number, runs: GhosttyRun<WrittenColor>[]): void {
    const { grid } = this;
    grid.clearRow(y);
    const base = y * grid.cols;
    for (const run of runs) {
      const style = this.styles.id(run.fg, run.bg, run.flags);
      let col = run.x;
      for (const cell of run.cells) {
        if (col >= grid.cols) break;
        const i = base + col;
        if (cell.wide && col + 1 < grid.cols) {
          grid.text[i] = cell.text;
          grid.width[i] = 2;
          grid.style[i] = style;
          grid.text[i + 1] = "";
          grid.width[i + 1] = 0;
          grid.style[i + 1] = style;
        } else {
          grid.text[i] = cell.wide ? " " : cell.text;
          grid.width[i] = 1;
          grid.style[i] = cell.wide ? this.styles.blank(style) : style;
        }
        col += cell.wide ? 2 : 1;
      }
    }
  }
}
