/**
 * A terminal's cell and grid sizes, measured and rounded as xterm.js 6 measures and rounds them (CharSizeService's
 * TextMetrics strategy, DomRenderer._updateDimensions, FitAddon.proposeDimensions; MIT, Copyright (c) The xterm.js
 * authors), so a pane keeps the columns and rows it had under xterm and the program in it is not resized.
 */

export interface CharSize { readonly width: number; readonly height: number }
export interface CellDimensions {
  /** one cell in CSS pixels: the grid's CSS size over its cells, so every row and column lines up with the grid's edge */
  readonly cell: { readonly width: number; readonly height: number };
  /** the whole grid in CSS pixels, rounded to whole pixels as xterm's screen is */
  readonly grid: { readonly width: number; readonly height: number };
  /** one cell in device pixels: a picture's cell size (CSI 16 t) */
  readonly device: { readonly width: number; readonly height: number };
}

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

let canvas: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null | undefined;
const context = (): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null => {
  if (canvas !== undefined) return canvas;
  canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(100, 100).getContext("2d") : document.createElement("canvas").getContext("2d");
  return canvas;
};

/** the advance and line height of "W" in the font, or null where the font cannot be measured yet (a hidden page) */
export function measureChar(fontFamily: string, fontSize: number): CharSize | null {
  const ctx = context();
  if (!ctx) return null;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText("W");
  const height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
  return metrics.width > 0 && height > 0 ? { width: metrics.width, height } : null;
}

export function cellDimensions(char: CharSize, cols: number, rows: number, options: { lineHeight: number; letterSpacing: number; dpr: number }): CellDimensions {
  const { dpr } = options;
  const charWidth = char.width * dpr;
  const charHeight = Math.ceil(char.height * dpr);
  const device = { width: charWidth + Math.round(options.letterSpacing), height: Math.floor(charHeight * options.lineHeight) };
  const grid = { width: Math.round(device.width * cols / dpr), height: Math.round(device.height * rows / dpr) };
  return { device, grid, cell: { width: grid.width / cols, height: grid.height / rows } };
}

/** the grid that fits the space `element`'s parent gives it, past the element's own padding and any scrollbar it keeps */
export function proposeGrid(element: HTMLElement, cell: { width: number; height: number }, scrollbarWidth: number): { cols: number; rows: number } | null {
  const parent = element.parentElement;
  if (!parent || cell.width === 0 || cell.height === 0) return null;
  const parentStyle = window.getComputedStyle(parent);
  const height = Number.parseInt(parentStyle.getPropertyValue("height"));
  const width = Math.max(0, Number.parseInt(parentStyle.getPropertyValue("width")));
  const own = window.getComputedStyle(element);
  const padding = (side: string): number => Number.parseInt(own.getPropertyValue(`padding-${side}`)) || 0;
  const availableHeight = height - padding("top") - padding("bottom");
  const availableWidth = width - padding("left") - padding("right") - scrollbarWidth;
  const cols = Math.max(MINIMUM_COLS, Math.floor(availableWidth / cell.width));
  const rows = Math.max(MINIMUM_ROWS, Math.floor(availableHeight / cell.height));
  return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows } : null;
}
