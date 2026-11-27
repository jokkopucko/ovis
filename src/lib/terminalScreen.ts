import type { GhosttyTerminal } from "./ghostty/terminal.ts";

/*
 * The one way the app reads what a terminal shows: its rows and cells, the cursor, where the view sits in
 * history, the selection and links in the libghostty screen.
 *
 * Rows are buffer rows, history first: `baseY` is the first row of the screen a program writes to, `viewportY`
 * the first row in view, `cursorX`/`cursorY` the cursor's cell on the screen (cursorY counts from `baseY`).
 */

export interface ScreenCell {
  getChars(): string;
  getWidth(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isInverse(): number;
  isInvisible(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}

export interface ScreenLine {
  readonly isWrapped: boolean;
  readonly length: number;
  /** cell `x`, read into `cell` when one is given (a reader that walks a row reuses one cell) */
  getCell(x: number, cell?: ScreenCell): ScreenCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  /** the OSC 8 target of cell `x`, or null */
  hyperlink?(x: number): string | null;
}

export interface ScreenRows {
  readonly length: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): ScreenLine | undefined;
  /** a blank cell to read cells into (getCell(x, cell)) */
  getNullCell(): ScreenCell;
}

type ScreenPoint = readonly [x: number, y: number];

export interface TerminalScreen extends ScreenRows {
  /** the rows of the screen up now (normal or alternate), held as they are for a read that walks them */
  active(): ScreenRows;
  /** a full-screen program's alternate screen is up: it keeps no history */
  readonly alternate: boolean;
  /** the OSC 8 target (`ESC ] 8 ; ; uri`) of cell `x` on row `y`, or null */
  hyperlinkAt(y: number, x: number): string | null;
  hasSelection(): boolean;
  getSelection(): string;
  /** the selection's first cell and the cell past its last one, in buffer rows */
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  /** the selection as it is drawn now: a drag moves it before the selection is told (on mouseup) */
  drawnSelection(): { start: ScreenPoint; end: ScreenPoint; column: boolean } | null;
}

type ScreenSource = { readonly buffer: { readonly active: ScreenRows } };
const engineRows = new WeakMap<ScreenSource, () => ScreenRows>();
const screens = new WeakMap<GhosttyTerminal, TerminalScreen>();

export function holdScreenRows(term: ScreenSource, rows: (() => ScreenRows) | null): void {
  if (rows) engineRows.set(term, rows);
  else engineRows.delete(term);
}

/** The visible screen and history in the same buffer coordinates for every reader. */
export function screenRows(term: ScreenSource): ScreenRows {
  return engineRows.get(term)?.() ?? term.buffer.active;
}

export const frameRows = screenRows;
export const viewRows = screenRows;

export function terminalScreen(term: GhosttyTerminal): TerminalScreen {
  const known = screens.get(term);
  if (known) return known;
  const active = (): ScreenRows => screenRows(term);
  const screen: TerminalScreen = {
    get length() { return active().length; },
    get baseY() { return active().baseY; },
    get viewportY() { return active().viewportY; },
    get cursorX() { return active().cursorX; },
    get cursorY() { return active().cursorY; },
    get alternate() { return term.buffer.active.alternate; },
    active,
    getLine: (y) => active().getLine(y),
    getNullCell: () => active().getNullCell(),
    hyperlinkAt: (y, x) => active().getLine(y)?.hyperlink?.(x) ?? null,
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    getSelectionPosition: () => term.getSelectionPosition(),
    drawnSelection: () => term.drawnSelection(),
  };
  screens.set(term, screen);
  return screen;
}
