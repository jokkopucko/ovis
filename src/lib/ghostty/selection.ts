/*
 * xterm's selection reads (the selected text, the word under a double click, the lines a triple click takes),
 * answered from any ScreenRows: libghostty's while it holds a screen (ghostty/overlay.ts). The rules are xterm's
 * own, adapted from xterm.js 6 SelectionService and Buffer (MIT, Copyright (c) 2017 The xterm.js authors), so a
 * selection takes the same cells and copies the same text whichever engine holds the rows.
 */
import type { Terminal } from "@xterm/xterm";
import { viewRows, type ScreenLine, type ScreenRows } from "../terminalScreen.ts";

type Point = readonly [x: number, y: number];
const NON_BREAKING_SPACE = /\u00a0/g;

const chars = (line: ScreenLine, x: number): string => line.getCell(x)?.getChars() ?? "";
const width = (line: ScreenLine, x: number): number => line.getCell(x)?.getWidth() ?? 1;
/** xterm's getCodePoint: a blank cell is 0, so only a printed space is 32 */
const isSpace = (line: ScreenLine, x: number): boolean => chars(line, x) === " ";

/** the selected text, as xterm's selectionText: wrapped rows joined, each line's unprinted end left out */
export function selectionText(rows: ScreenRows, start: Point, end: Point, column: boolean, newline: string): string {
  const text = (y: number, from = 0, to?: number): string => rows.getLine(y)?.translateToString(true, from, to) ?? "";
  const result: string[] = [];
  if (column) {
    if (start[0] === end[0]) return "";
    const from = Math.min(start[0], end[0]), to = Math.max(start[0], end[0]);
    for (let y = start[1]; y <= end[1]; y++) result.push(text(y, from, to));
  } else {
    result.push(text(start[1], start[0], start[1] === end[1] ? end[0] : undefined));
    for (let y = start[1] + 1; y <= end[1]; y++) {
      const line = y === end[1] ? text(y, 0, end[0]) : text(y);
      if (rows.getLine(y)?.isWrapped) result[result.length - 1] += line;
      else result.push(line);
    }
  }
  return result.map((line) => line.replace(NON_BREAKING_SPACE, " ")).join(newline);
}

/**
 * the rows a triple click takes: the line under it with every row it wraps over. With libghostty alone parsing, xterm's
 * rows are the view's, and a line that wraps from above the view goes on into rows numbered below 0
 */
export function wrappedRange(rows: ScreenRows, y: number): { first: number; last: number } {
  let first = y, last = y;
  while (rows.getLine(first - 1) !== undefined && rows.getLine(first)?.isWrapped) first--;
  while (last + 1 < rows.length && rows.getLine(last + 1)?.isWrapped) last++;
  return { first, last };
}

/** the string index of column `x` in the row's text, as xterm's _convertViewportColToCharacterIndex */
function charIndexOf(line: ScreenLine, x: number): number {
  let index = x;
  for (let i = 0; i <= x; i++) {
    const length = chars(line, i).length;
    if (width(line, i) === 0) index--;
    else if (length > 1 && x !== i) index += length - 1;
  }
  return index;
}

/** the word under `point` (start column, may be negative when it began on a row above, and its length in columns), as xterm's _getWordAt */
export function wordAt(rows: ScreenRows, cols: number, separators: string, point: Point, allowWhitespace: boolean,
  followAbove = true, followBelow = true): { start: number; length: number } | undefined {
  const [x, y] = point;
  if (x >= cols) return undefined;
  const line = rows.getLine(y);
  if (!line) return undefined;
  const text = line.translateToString(false);
  const separator = (col: number): boolean => width(line, col) !== 0 && separators.includes(chars(line, col));
  let startIndex = charIndexOf(line, x);
  let endIndex = startIndex;
  const charOffset = x - startIndex;
  let leftWide = 0, rightWide = 0, leftLong = 0, rightLong = 0;
  if (text.charAt(startIndex) === " ") {
    while (startIndex > 0 && text.charAt(startIndex - 1) === " ") startIndex--;
    while (endIndex < text.length && text.charAt(endIndex + 1) === " ") endIndex++;
  } else {
    let startCol = x, endCol = x;
    if (width(line, startCol) === 0) { leftWide++; startCol--; }
    if (width(line, endCol) === 2) { rightWide++; endCol++; }
    const first = chars(line, endCol).length;
    if (first > 1) { rightLong += first - 1; endIndex += first - 1; }
    while (startCol > 0 && startIndex > 0 && !separator(startCol - 1)) {
      const length = chars(line, startCol - 1).length;
      if (width(line, startCol - 1) === 0) { leftWide++; startCol--; } else if (length > 1) { leftLong += length - 1; startIndex -= length - 1; }
      startIndex--;
      startCol--;
    }
    while (endCol < line.length && endIndex + 1 < text.length && !separator(endCol + 1)) {
      const length = chars(line, endCol + 1).length;
      if (width(line, endCol + 1) === 2) { rightWide++; endCol++; } else if (length > 1) { rightLong += length - 1; endIndex += length - 1; }
      endIndex++;
      endCol++;
    }
  }
  endIndex++;
  let start = startIndex + charOffset - leftWide + leftLong;
  let length = Math.min(cols, endIndex - startIndex + leftWide + rightWide - leftLong - rightLong);
  if (!allowWhitespace && text.slice(startIndex, endIndex).trim() === "") return undefined;
  if (followAbove && start === 0 && !isSpace(line, 0)) {
    const above = rows.getLine(y - 1);
    if (above && line.isWrapped && !isSpace(above, cols - 1)) {
      const word = wordAt(rows, cols, separators, [cols - 1, y - 1], false, true, false);
      if (word) {
        const offset = cols - word.start;
        start -= offset;
        length += offset;
      }
    }
  }
  if (followBelow && start + length === cols && !isSpace(line, cols - 1)) {
    const below = rows.getLine(y + 1);
    if (below?.isWrapped && !isSpace(below, 0)) {
      const word = wordAt(rows, cols, separators, [0, y + 1], false, false, true);
      if (word) length += word.length;
    }
  }
  return { start, length };
}

/** xterm's selection service, whose model keeps the selection in xterm's buffer rows */
interface XtermSelection {
  _getWordAt(coords: [number, number], allowWhitespace: boolean, followAbove?: boolean, followBelow?: boolean): { start: number; length: number } | undefined;
  _selectLineAt(line: number): void;
  readonly selectionText: string;
  _activeSelectionMode: number;
  _model: { finalSelectionStart?: [number, number]; finalSelectionEnd?: [number, number]; selectionStart?: [number, number]; selectionEnd?: [number, number]; selectionStartLength: number };
}
/** xterm's SelectionMode.COLUMN */
const COLUMN_MODE = 3;

/**
 * Has xterm's selection read libghostty's rows (terminalScreen.ts viewRows) in place of its own buffer: the word a
 * double click takes, the lines a triple click takes and the text a copy takes. xterm keeps the gestures and the
 * selection's cells.
 * Returns the undo.
 */
export function holdSelection(term: Terminal): () => void {
  const service = (term as unknown as { _core?: { _selectionService?: XtermSelection } })._core?._selectionService;
  if (!service || typeof service._getWordAt !== "function" || typeof service._selectLineAt !== "function") return () => {};
  // xterm's own buffer answers its own reads: only libghostty's rows are read here
  const view = (): ScreenRows | null => {
    const rows = viewRows(term);
    return rows === term.buffer.active ? null : rows;
  };
  const own = { getWordAt: service._getWordAt, selectLineAt: service._selectLineAt };
  service._getWordAt = function (coords, allowWhitespace, followAbove = true, followBelow = true) {
    const rows = view();
    return rows ? wordAt(rows, term.cols, term.options.wordSeparator ?? "", coords, allowWhitespace, followAbove, followBelow)
      : own.getWordAt.call(this, coords, allowWhitespace, followAbove, followBelow);
  };
  service._selectLineAt = function (line) {
    const rows = view();
    if (!rows) { own.selectLineAt.call(this, line); return; }
    const { first, last } = wrappedRange(rows, line);
    this._model.selectionStart = [0, first];
    this._model.selectionEnd = undefined;
    this._model.selectionStartLength = term.cols * (last - first) + term.cols;
  };
  const textOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), "selectionText")?.get;
  Object.defineProperty(service, "selectionText", {
    configurable: true,
    get(this: XtermSelection): string {
      const rows = view();
      const { finalSelectionStart: start, finalSelectionEnd: end } = this._model;
      if (!rows) return textOf?.call(this) ?? "";
      if (!start || !end) return "";
      const text = selectionText(rows, start, end, this._activeSelectionMode === COLUMN_MODE, /Win/.test(navigator.platform) ? "\r\n" : "\n");
      // a row read that failed on the way gave the terminal back to xterm (overlay.ts): the copy is xterm's whole, not half of each
      return view() === null ? textOf?.call(this) ?? "" : text;
    },
  });
  // the service's own methods and getter are its prototype's: dropping the instance's puts them back
  return () => {
    delete (service as Partial<XtermSelection>)._getWordAt;
    delete (service as Partial<XtermSelection>)._selectLineAt;
    delete (service as { selectionText?: string }).selectionText;
  };
}
