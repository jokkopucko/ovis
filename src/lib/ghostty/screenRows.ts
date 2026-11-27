import type { ScreenCell, ScreenLine, ScreenRows } from "../terminalScreen.ts";
import { STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_OVERLINE, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type EngineCell, type EngineRowText, type GhosttyVt } from "./vt.ts";

const packed = (color: EngineCell["fg"]): number => (color === null ? -1 : typeof color === "number" ? color : (color[0] << 16) | (color[1] << 8) | color[2]);

const BLANK: EngineCell = { text: "", width: 1, flags: 0, fg: null, bg: null };

/**
 * An engine cell as xterm's IBufferCell answers: an empty cell has no characters, a wide cell's second column is
 * width 0. As xterm's, one cell can be read into again (getCell(x, cell)), which a reader walking a row does.
 */
class GhosttyCell implements ScreenCell {
  constructor(public cell: EngineCell) {}
  private flag(bit: number): number { return this.cell.flags & bit ? 1 : 0; }
  getChars(): string { return this.cell.text; }
  getWidth(): number { return this.cell.width; }
  isBold(): number { return this.flag(STYLE_BOLD); }
  isDim(): number { return this.flag(STYLE_FAINT); }
  isItalic(): number { return this.flag(STYLE_ITALIC); }
  isUnderline(): number { return this.flag(STYLE_UNDERLINE_MASK); }
  isStrikethrough(): number { return this.flag(STYLE_STRIKE); }
  isOverline(): number { return this.flag(STYLE_OVERLINE); }
  isInverse(): number { return this.flag(STYLE_INVERSE); }
  isInvisible(): number { return this.flag(STYLE_INVISIBLE); }
  isFgDefault(): boolean { return this.cell.fg === null; }
  isBgDefault(): boolean { return this.cell.bg === null; }
  isFgRGB(): boolean { return Array.isArray(this.cell.fg); }
  isBgRGB(): boolean { return Array.isArray(this.cell.bg); }
  getFgColor(): number { return packed(this.cell.fg); }
  getBgColor(): number { return packed(this.cell.bg); }
}

/** kept row `y` as xterm's IBufferLine answers: its text and wrap read with the line, its styled cells the first time they are asked */
function screenLine(vt: GhosttyVt, y: number, row: EngineRowText): ScreenLine {
  const { codes, widths, graphemes, hyperlinks } = row;
  let cells: EngineCell[] | null = null;
  return {
    isWrapped: row.continues,
    length: codes.length,
    getCell: (x, into) => {
      cells ??= vt.rowCells(y) ?? [];
      const cell = cells[x];
      if (!cell) return undefined;
      if (into instanceof GhosttyCell) { into.cell = cell; return into; }
      return new GhosttyCell(cell);
    },
    hyperlink: (x) => hyperlinks.get(x) ?? null,
    translateToString: (trimRight = false, startColumn = 0, endColumn = codes.length) => {
      // as xterm: a trimmed row ends after its last printed cell (a written space is kept), a blank cell reads as a
      // space, and a cell is passed by its width, so a wide glyph is read once and its second column, read on its own
      // (a read that starts there), as a space
      let end = Math.min(endColumn, codes.length);
      if (trimRight) {
        let printed = 0;
        for (let x = codes.length - 1; x >= 0; x--) if (codes[x] !== 0) { printed = x + widths[x]!; break; }
        end = Math.min(end, printed);
      }
      let text = "";
      for (let x = startColumn; x < end; x += widths[x] || 1) {
        const code = codes[x]!;
        text += code === 0 ? " " : graphemes.get(x) ?? String.fromCodePoint(code);
      }
      return text;
    },
  };
}

/**
 * libghostty's kept rows as the app reads xterm's (terminalScreen.ts ScreenRows), as they are when this is called;
 * a line's styled cells are read when first asked, so a reader is done with them before the terminal is written again.
 * History past the lines asked for (vt.scrollback), which libghostty has not freed yet, is left out, as xterm drops it.
 */
export function ghosttyRows(vt: GhosttyVt): ScreenRows & { readonly alternate: boolean } {
  const history = vt.history();
  const cursor = vt.screenCursor();
  const hidden = Math.max(0, history.scrollback - vt.scrollback);
  const length = history.total - hidden;
  const lines = new Map<number, ScreenLine | undefined>();
  return {
    alternate: vt.alternate(),
    length,
    baseY: history.scrollback - hidden,
    viewportY: Math.max(0, history.viewportTop - hidden),
    cursorX: cursor.x,
    cursorY: cursor.y,
    getNullCell: () => new GhosttyCell(BLANK),
    getLine: (y) => {
      if (!lines.has(y)) {
        const row = y >= 0 && y < length ? vt.rowText(y + hidden) : null;
        lines.set(y, row ? screenLine(vt, y + hidden, row) : undefined);
      }
      return lines.get(y);
    },
  };
}
