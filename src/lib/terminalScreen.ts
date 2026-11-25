import type { IBufferCell, Terminal } from "@xterm/xterm";

/*
 * The one way the app reads what a terminal shows: its rows and cells, the cursor, where the view sits in
 * history, the selection and the links in it. Two engines hold a screen: xterm, under every terminal
 * (`terminalScreen`), and libghostty, which draws it while it can (ghostty/overlay.ts) and answers the rows of a
 * reader moved to it (`screenRows`). Readers move over one at a time; the rest still read xterm's buffer. The
 * shapes follow xterm's buffer API, so its rows and cells serve as they are.
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
}

export interface ScreenRows {
  readonly length: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): ScreenLine | undefined;
}

type ScreenPoint = readonly [x: number, y: number];

export interface TerminalScreen extends ScreenRows {
  /** the rows of the screen up now (normal or alternate), held as they are for a read that walks them */
  active(): ScreenRows;
  /** a full-screen program's alternate screen is up: it keeps no history */
  readonly alternate: boolean;
  getNullCell(): ScreenCell;
  /** the OSC 8 target (`ESC ] 8 ; ; uri`) of cell `x` on row `y`, or null */
  hyperlinkAt(y: number, x: number): string | null;
  hasSelection(): boolean;
  getSelection(): string;
  /** the selection's first cell and the cell past its last one, in buffer rows */
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  /** the selection as it is drawn now: a drag moves it before the selection is told (on mouseup) */
  drawnSelection(): { start: ScreenPoint; end: ScreenPoint; column: boolean } | null;
}

interface XtermInternals {
  _core?: {
    _oscLinkService?: { getLinkData?: (id: number) => { uri?: string } | undefined };
    _renderService?: { _selectionState?: { start?: ScreenPoint; end?: ScreenPoint; columnSelectMode?: boolean } };
  };
}

const screens = new WeakMap<Terminal, TerminalScreen>();
const engineRows = new WeakMap<Terminal, () => ScreenRows | null>();

/** libghostty's rows for `term` while it holds the screen (ghostty/overlay.ts); null, or rows it cannot give, leave the reads to xterm */
export function holdScreenRows(term: Terminal, rows: (() => ScreenRows | null) | null): void {
  if (rows) engineRows.set(term, rows);
  else engineRows.delete(term);
}

/** the rows of the screen up now (normal or alternate): libghostty's while it holds the screen, xterm's otherwise */
export function screenRows(term: Terminal): ScreenRows {
  return engineRows.get(term)?.() ?? term.buffer.active;
}

/**
 * The rows of the screen up now numbered as xterm's buffer numbers them, for a reader that takes its rows from xterm
 * (a selection, a pointer on the view): libghostty's while it holds the screen, xterm's otherwise. A row of xterm's
 * view is the row libghostty draws there (overlay.ts), so a selection is copied and a pointer hits as they are shown:
 * where a resize left the two engines' histories at different depths, the view's top is where they meet. While the
 * two are on different screens (a switch libghostty took and xterm has yet to parse), xterm's own rows answer.
 */
export function viewRows(term: Terminal): ScreenRows {
  const rows = engineRows.get(term)?.();
  const own = term.buffer.active;
  if (!rows) return own;
  if ("alternate" in rows && rows.alternate !== (own.type === "alternate")) return own;
  const offset = rows.viewportY - own.viewportY;
  if (offset === 0) return rows;
  return {
    length: rows.length - offset, baseY: rows.baseY - offset, viewportY: rows.viewportY - offset, cursorX: rows.cursorX, cursorY: rows.cursorY,
    getLine: (y) => rows.getLine(y + offset),
  };
}

/** xterm's screen: reads go to whichever of its buffers (normal or alternate) is up when they are made */
export function terminalScreen(term: Terminal): TerminalScreen {
  const known = screens.get(term);
  if (known) return known;
  const internals = (term as unknown as XtermInternals)._core;
  const screen: TerminalScreen = {
    get length() { return term.buffer.active.length; },
    get baseY() { return term.buffer.active.baseY; },
    get viewportY() { return term.buffer.active.viewportY; },
    get cursorX() { return term.buffer.active.cursorX; },
    get cursorY() { return term.buffer.active.cursorY; },
    get alternate() { return term.buffer.active.type === "alternate"; },
    active: () => term.buffer.active,
    getLine: (y) => term.buffer.active.getLine(y),
    getNullCell: () => term.buffer.active.getNullCell(),
    // xterm (5.5 and 6.0) keeps OSC 8 targets in its own link service with no public way to read them: this reads
    // its internals and finds nothing where they are not there; the caller applies its own link policy to the uri
    hyperlinkAt: (y, x) => {
      const cell = term.buffer.active.getLine(y)?.getCell(x) as (IBufferCell & { extended?: { urlId?: number } }) | undefined;
      const id = cell?.extended?.urlId;
      if (!id) return null;
      const uri = internals?._oscLinkService?.getLinkData?.(id)?.uri;
      return typeof uri === "string" && uri !== "" ? uri : null;
    },
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    getSelectionPosition: () => term.getSelectionPosition(),
    drawnSelection: () => {
      const state = internals?._renderService?._selectionState;
      return state?.start && state.end ? { start: state.start, end: state.end, column: state.columnSelectMode === true } : null;
    },
  };
  screens.set(term, screen);
  return screen;
}
