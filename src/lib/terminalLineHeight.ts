import type { Terminal } from "@xterm/xterm";

/**
 * How tall a terminal row is drawn. xterm makes a row as tall as the Latin font's line, and
 * Hangul fills the height of its line where Latin's lowercase does not: in Menlo's 15px line at
 * 13px a syllable leaves 2.5px to the next row, and Korean lines read crowded. So the row is made
 * as tall as a syllable's ink and a gap of HANGUL_GAP_EM below it, and no taller: a Latin font
 * whose line is already that tall (JetBrains Mono, Noto Sans Mono) keeps its rows as they are.
 */

/** The ink of the terminal's Hangul, Ovis Hangul Mono (D2Coding's outlines): 0.78em above the baseline to 0.133em below. */
export const HANGUL_INK_EM = 0.913;
/** The gap left between two Korean rows: 4.6px at 13px, Menlo's 16.5px row on a 2x screen. */
const HANGUL_GAP_EM = 0.35;
/** xterm counts a row in whole device pixels: a factor a hair above the quotient keeps its floor on the wanted pixel. */
const ROUNDING = 0.001;

/**
 * xterm's lineHeight for a font whose line (as xterm measures it) is `charHeight` px at
 * `fontSize`, on a screen of `ratio` device pixels per CSS pixel: the smallest that makes a row
 * as tall as Hangul's ink and its gap (to the nearest device pixel), and 1 when the font's line
 * already is.
 */
export function terminalLineHeight(charHeight: number, fontSize: number, ratio: number): number {
  if (!(charHeight > 0) || !(fontSize > 0) || !(ratio > 0)) return 1;
  // xterm's own rounding (DomRenderer): the line up to whole device pixels, the row down; the row
  // wanted is the nearest whole device pixel, so a 1x screen gives no more than a 2x one
  const line = Math.ceil(charHeight * ratio);
  const wanted = Math.round((HANGUL_INK_EM + HANGUL_GAP_EM) * fontSize * ratio);
  return wanted <= line ? 1 : (wanted + ROUNDING) / line;
}

let measure: CanvasRenderingContext2D | null | undefined;

/**
 * Sets the terminal's lineHeight for its current font, measured as xterm measures it (a canvas's
 * font bounding box of "W"). Called after every change of the font's family or size; a browser
 * without font metrics keeps the font's own line.
 */
export function fitLineHeight(term: Terminal): void {
  const { fontFamily, fontSize } = term.options;
  if (fontSize === undefined || typeof document === "undefined") return;
  if (measure === undefined) measure = document.createElement("canvas").getContext("2d");
  if (!measure) return;
  measure.font = `${fontSize}px ${fontFamily}`;
  const metrics = measure.measureText("W");
  const charHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const lineHeight = terminalLineHeight(charHeight, fontSize, window.devicePixelRatio || 1);
  if (term.options.lineHeight !== lineHeight) term.options.lineHeight = lineHeight;
}
