/**
 * xterm's DOM renderer sizes every cell from the Latin font and gives each glyph the
 * difference to its cells as letter-spacing, which lands after the glyph: a narrower glyph
 * sits at the left edge of its cells. With a 1em CJK fallback beside a 0.54em Latin cell
 * (Linux) that leftover is a pixel. Apple's Menlo cell is 0.6em, though, and no font on
 * iPhone draws Hangul wider than 0.87em, so every syllable trailed a 4px gap and Korean read
 * as falling apart (kana and Han too, at 0.87em to 1em).
 *
 * So each span the renderer draws with extra spacing is adjusted after the fact:
 * - a glyph in two cells that fills less than FILL of them is drawn wider, up to
 *   MAX_SCALE, the way a CJK coding font sizes it against its Latin. It is widened before it
 *   is enlarged: the row is as tall as the Latin font's line, and a syllable enlarged to fill
 *   Menlo's 1.2em of two cells grew as tall as the row, so Korean lines nearly touched;
 * - the glyph is centered in its cells: padding moves the text right by half the spacing
 *   left over, a negative margin takes it back after the span so the next span keeps its
 *   column, and a clip trims the trailing half so an underline stays on its own cells.
 *   All of that goes on a span inside xterm's, which keeps the cells' background and block
 *   cursor: a stretched or clipped box ends inside a device pixel, and a background painted
 *   there left a line of the pane between it and the next cell's (a light seam after every
 *   Korean word in a dark block).
 * A glyph wider than its cells is left to run over, as in a native terminal.
 *
 * The renderer also hands the browser each cell's text as written, and two kinds of text
 * draw wrong on iPhone:
 * - iOS Safari draws only the first of two stacked marks on a decomposed letter (`e` +
 *   U+0302 + U+0301, as in a Vietnamese file name from a Mac), so such text is shown composed
 *   (NFC), and decomposed Hangul with it, which then measures as the syllable it is;
 * - iOS draws a symbol that is text by default, such as ⏺ (the bullet before every Claude
 *   Code message), as a color emoji two cells wide in its one cell, so a symbol that
 *   overflows its cell is asked for its text form (U+FE0E).
 * Copy reads xterm's buffer, not the DOM, and still returns what the pane wrote.
 */
import type { Terminal } from "@xterm/xterm";

import { BOX_GLYPHS, boxBackground, boxDrawing, boxRun, isBoxGlyph, pixelPlacement, type BoxDrawing } from "./terminalBoxGlyphs.ts";

/** Spacing up to this is rounding between the font and the cell grid, not a misfit glyph. */
const MIN_SPACING_PX = 1;
/**
 * A glyph filling this much of its cells is left as drawn (a 1em CJK glyph on Linux fills
 * 93%); a narrower one is centered, and a two-cell one enlarged to fill this much.
 */
const FILL = 0.9;
const MAX_SCALE = 1.2;
/**
 * The most a wide glyph is widened alone (horizontal scaling, 장평 in Korean typesetting, where
 * 90-110% is common); a glyph that needs more is enlarged for the rest.
 */
const MAX_STRETCH = 1.1;

/** how many copies of a glyph xterm's WidthCache measures at once (WidthCacheSettings.REPEAT) */
const XTERM_MEASURE_REPEAT = 32;
const VIEW_FIT_CACHE_MAX = 4096;

const BOX_CLASS = "herdr-box-glyph";

const DECOMPOSED = /[\p{M}\u1160-\u11ff]/u;
const TEXT_DEFAULT_PICTOGRAPH = /(?!\p{Emoji_Presentation})\p{Extended_Pictographic}/gu;
const PRESENTATION_SELECTOR = /[\ufe0e\ufe0f]/u;
const TEXT_PRESENTATION = "\ufe0e";

export interface GlyphFit {
  scale: number;
  stretch: number;
  spacing: number;
}

export function glyphFit(spacing: number, glyphWidth: number, cellWidth: number): GlyphFit | null {
  if (!(spacing > MIN_SPACING_PX) || !(glyphWidth > 0) || !(cellWidth > 0)) return null;
  const slot = glyphWidth + spacing;
  if (glyphWidth >= FILL * slot) return null;
  const wide = Math.round(slot / cellWidth) >= 2;
  const widen = wide ? Math.min(MAX_SCALE, (FILL * slot) / glyphWidth) : 1;
  const stretch = Math.min(widen, MAX_STRETCH);
  return { scale: widen / stretch, stretch, spacing: slot - glyphWidth * widen };
}

const PRIVATE_USE = /^[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const ANY_PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const POWERLINE_EXTRA = /^[\ue0b8-\ue0d7]/u;

const JOINS = /[\p{M}\u200d\ufe00-\ufe0f]/u;
export const ICON_FAMILY = "Symbols Nerd Font Mono";

const QUOTES = /["']/g;
/** A family name as CSS matches it: unquoted, and without regard to case ("pretendard variable" typed in Settings draws with "Pretendard Variable"). */
const familyKey = (name: string): string => name.replace(QUOTES, "").trim().toLowerCase();
// a unicode-range as code point pairs, by the text FontFace.unicodeRange gives back
const parsedRanges = new Map<string, [number, number][]>();

export function coversAny(unicodeRange: string, text: string): boolean {
  let ranges = parsedRanges.get(unicodeRange);
  if (!ranges) {
    ranges = unicodeRange.split(",").map((range): [number, number] => {
      const [low = "", high = low] = range.trim().replace(/^u\+/i, "").split("-");
      return [Number.parseInt(low.replace(/\?/g, "0"), 16), Number.parseInt(high.replace(/\?/g, "f"), 16)];
    });
    parsedRanges.set(unicodeRange, ranges);
  }
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (ranges.some(([low, high]) => point >= low && point <= high)) return true;
  }
  return false;
}

export interface LateFace {
  readonly family: string;
  readonly unicodeRange: string;
  readonly status: string;
  readonly loaded: Promise<unknown>;
}

export interface LateFaces {
  ask(families: string, text: string, painted?: boolean): boolean;
  stop(): void;
}

interface Relay {
  fire: (() => void) | null;
  arrivedQuietly: ((face: LateFace) => void) | null;
}

/**
 * A face that never loads holds on to the relay and its own entry alone, never a closure of the
 * terminal's (it would keep the terminal), and a stopped terminal's relay holds nothing.
 */
function whenLoaded(face: LateFace, relay: Relay, entry: { quiet: boolean }): void {
  face.loaded.then(() => entry.quiet ? relay.arrivedQuietly?.(face) : relay.fire?.(), () => undefined);
}

/**
 * Each face is followed by its own `loaded` promise and starts no load: the page loads the faces its
 * text reaches (a face behind a font that draws the character never loads), one face that fails or
 * stalls holds back none of the others, and a face that failed is not followed. A face followed only for
 * characters drawn as boxes measures nothing again when it arrives, since nothing drawn used it, but
 * xterm measured those characters with the stand-in too: the first time one is drawn from the font
 * (under the cursor), the terminal measures again then.
 */
export function followLateFaces<Face extends LateFace>(fonts: Iterable<Face> | undefined, frame: (callback: () => void) => void, arrived: () => void): LateFaces {
  const followed = new WeakMap<Face, { quiet: boolean }>();
  const arrivedQuietly = new Set<LateFace>();
  let waiting = false;
  let stopped = false;
  const relay: Relay = {
    fire: () => {
      if (waiting) return;
      waiting = true;
      frame(() => {
        waiting = false;
        if (stopped) return;
        arrivedQuietly.clear();
        arrived();
      });
    },
    arrivedQuietly: (face) => arrivedQuietly.add(face),
  };
  return {
    ask(families, text, painted = false) {
      if (!fonts || stopped) return false;
      let stale = false;
      const names = new Set(families.split(",").map(familyKey));
      for (const face of fonts) {
        if (!names.has(familyKey(face.family)) || !coversAny(face.unicodeRange, text)) continue;
        const following = followed.get(face);
        if (following) {
          if (painted) continue;
          following.quiet = false;
          if (arrivedQuietly.delete(face)) {
            stale = true;
            relay.fire?.();
          }
          continue;
        }
        if (face.status !== "unloaded" && face.status !== "loading") continue;
        const entry = { quiet: painted };
        followed.set(face, entry);
        whenLoaded(face, relay, entry);
      }
      return stale;
    },
    stop() {
      stopped = true;
      relay.fire = null;
      relay.arrivedQuietly = null;
      arrivedQuietly.clear();
    },
  };
}

/**
 * Symbols Nerd Font Mono advances 1em, two of the app's 0.5-0.6em cells, so each icon covered the
 * cell after it (`ls` with icons, a prompt's branch symbol). Only the private use areas: an emoji wider
 * than its one cell is left to run over, as xterm's Unicode 6 widths give most emoji one cell and they
 * came out tiny.
 */
export function oversizedIcon(char: string, width: number, cellWidth: number): boolean {
  return PRIVATE_USE.test(char) && width > cellWidth + MIN_SPACING_PX;
}

export function iconScale(widths: readonly number[], cellWidth: number): number {
  return Math.min(1, ...widths.map((width) => cellWidth / width));
}

let segmenter: Intl.Segmenter | undefined;

export function graphemes(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/**
 * The composition view's transform with a glyph stretch added. xterm moves a long text at the right
 * edge left by `translateX(min(0px, calc(<room>px - 100%)))`, 100% being the box's width, and a
 * browser gives that back in its own form (Chromium: `min(0px, -100% + <room>px)`): the move is
 * written again from its room with the stretched width, the stretch applying first, so the text
 * still ends at the edge.
 */
export function stretchedView(base: string, stretch: string): string {
  if (stretch === "") return base;
  if (base === "") return stretch;
  // the last length is the room, signed (Chromium writes a negative one as `-100% - 3.5px`)
  const room = base.includes("100%") ? base.match(/(?:-\s*)?[\d.]+px(?![\s\S]*px)/)?.[0].replace(/\s/g, "") : undefined;
  if (room === undefined) return `${base} ${stretch}`;
  const factor = Number(stretch.match(/^scaleX\(([\d.]+)\)$/)?.[1] ?? 1);
  return `translateX(min(0px, calc(${room} - ${+(100 * factor).toFixed(4)}%))) ${stretch}`;
}

export function displayText(text: string): string {
  return DECOMPOSED.test(text) ? text.normalize("NFC") : text;
}

export function textPresentation(text: string): string | null {
  if (PRESENTATION_SELECTOR.test(text)) return null;
  const textForm = text.replace(TEXT_DEFAULT_PICTOGRAPH, `$&${TEXT_PRESENTATION}`);
  return textForm === text ? null : textForm;
}

/**
 * Keeps every row the DOM renderer draws adjusted. The renderer rebuilds a row's spans on
 * each render (and on link hover, which fires no render event), so a MutationObserver
 * catches them all; it runs before the frame paints. Returns the stop function.
 */
export function adjustTerminalGlyphs(term: Terminal): () => void {
  const rows = term.element?.querySelector<HTMLElement>(".xterm-rows");
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const measure = document.createElement("canvas").getContext("2d");
  if (!rows || !screen || !measure) return () => {};
  const widths = new Map<string, number>();
  const viewFits = new Map<string, GlyphFit | null>();
  const asked = new Set<string>();
  const askedPainted = new Set<string>();
  let measuredFont = "";
  const boxes = new Map<string, BoxDrawing | null>();
  let boxCell = "";
  let placed: { box: HTMLSpanElement; drawing: BoxDrawing; cells: number; rowHeight: number }[] = [];

  /**
   * Rebuilds a span as runs: box characters drawn to their cells (terminalBoxGlyphs.ts), icons too
   * wide for their cells drawn smaller inside them, the way a terminal fits a Nerd Font's icons
   * (Symbols Nerd Font Mono advances 1em, two of the app's cells, and each icon covered the cell
   * after it), and the rest with xterm's spacing in a span of its own: xterm merges cells that share
   * a spacing (an icon with a Powerline arrow, or with a 1em CJK symbol), and their fits differ.
   */
  const rebuild = (span: HTMLSpanElement, text: string, cellWidth: number, rowHeight: number, fontSize: number, widthOf: (glyph: string) => number): boolean => {
    const cell = `${cellWidth}x${rowHeight}@${fontSize}`;
    if (cell !== boxCell) {
      boxes.clear();
      boxCell = cell;
    }
    const drawingOf = (char: string): BoxDrawing | null => {
      let drawing = boxes.get(char);
      if (drawing === undefined) {
        drawing = BOX_GLYPHS.test(char) ? boxDrawing(char, cellWidth, rowHeight, fontSize) : null;
        boxes.set(char, drawing);
      }
      return drawing;
    };
    if (JOINS.test(text)) return false;
    const chars = [...text];
    const kinds = chars.map((char) => drawingOf(char) !== null ? "box"
      : !oversizedIcon(char, widthOf(char), cellWidth) ? "text" : POWERLINE_EXTRA.test(char) ? "shape" : "icon");
    if (!kinds.some((kind) => kind !== "text")) return false;
    const spacing = span.style.letterSpacing || "0px";
    const parts: HTMLSpanElement[] = [];
    for (let start = 0; start < chars.length;) {
      let end = start;
      while (end < chars.length && kinds[end] === kinds[start] && (kinds[start] !== "icon" || end === start)) end += 1;
      const run = chars.slice(start, end);
      const part = document.createElement("span");
      part.className = BOX_CLASS;
      if (kinds[start] === "text") {
        part.style.cssText = `display:inline;letter-spacing:${spacing};font-weight:inherit`;
        part.textContent = run.join("");
      } else {
        // an inline-block takes no underline, strikethrough or overline from the span around it: it asks for them
        part.style.cssText = `display:inline-block;position:relative;width:${cellWidth * run.length}px;height:${rowHeight}px;vertical-align:top;white-space:pre;letter-spacing:0;text-decoration:inherit;font-weight:inherit`;
        const glyphs = document.createElement("span");
        glyphs.className = BOX_CLASS;
        glyphs.textContent = run.join("");
        if (kinds[start] === "box") {
          // the characters stay for the DOM's sake, unpainted, in a block the box's decoration reaches into
          // (xterm makes every span of a row an inline-block, which it does not), cut to the cells
          glyphs.style.cssText = "display:block;width:100%;height:100%;overflow:hidden;color:transparent";
          placed.push({ box: part, drawing: boxRun(run.map((char) => drawingOf(char)!), cellWidth), cells: run.length, rowHeight });
        } else if (kinds[start] === "shape") {
          const size = rowHeight;
          const squeeze = cellWidth / (widthOf(run[0]!) * (size / fontSize));
          glyphs.style.cssText = `display:block;width:${100 / squeeze}%;height:100%;font-size:${size}px;line-height:${rowHeight}px;letter-spacing:0;font-weight:inherit;transform:scaleX(${squeeze});transform-origin:0 0`;
          part.style.overflow = "hidden";
        } else {
          const scale = iconScale(run.map(widthOf), cellWidth);
          const left = cellWidth - widthOf(run[0]!) * scale;
          glyphs.style.cssText = `display:block;width:100%;height:100%;overflow:hidden;font-size:${fontSize * scale}px;line-height:${rowHeight}px;letter-spacing:${left}px;padding-left:${left / 2}px;font-weight:inherit`;
        }
        part.append(glyphs);
      }
      parts.push(part);
      start = end;
    }
    span.style.letterSpacing = "0px";
    span.replaceChildren(...parts);
    return true;
  };

  const adjustAll = (spans: Iterable<Node>): void => {
    const { fontFamily, fontSize, fontWeight, fontWeightBold } = term.options;
    if (fontSize === undefined) return;
    const font = `${fontSize}px ${fontFamily}`;
    if (font !== measuredFont) {
      widths.clear();
      asked.clear();
      askedPainted.clear();
      measuredFont = font;
    }
    const cellWidth = Number.parseFloat(screen.style.width) / term.cols;
    const rowHeight = Number.parseFloat(screen.style.height) / term.rows;
    for (const span of spans) {
      if (!(span instanceof HTMLSpanElement) || span.classList.contains(BOX_CLASS)) continue;
      const text = span.textContent ?? "";
      let shown = displayText(text);
      const bold = span.classList.contains("xterm-bold");
      const italic = span.classList.contains("xterm-italic");
      const style = `${italic ? "italic " : ""}${bold ? fontWeightBold : fontWeight} ${fontSize}px`;
      const widthOf = (glyph: string): number => {
        const key = `${bold ? 1 : 0}${italic ? 1 : 0}${glyph}`;
        let width = widths.get(key);
        if (width === undefined) {
          measure.font = `${style} ${fontFamily}`;
          width = measure.measureText(glyph).width;
          widths.set(key, width);
        }
        return width;
      };
      // boxes drawn and icons fitted to their cells. The cell under the cursor keeps the font's glyph:
      // xterm draws an underline or bar cursor as the span's own border and shadow, which they would cover
      const rebuilt = (BOX_GLYPHS.test(shown) || ANY_PRIVATE_USE.test(shown)) && !span.classList.contains("xterm-cursor") && cellWidth > 0 && rowHeight > 0
        && rebuild(span, shown, cellWidth, rowHeight, fontSize, widthOf);
      // every character drawn asks for its faces once, whether or not its span is fitted: xterm
      // measured it too, and a span that already fills its cells is wrong once a late face arrives.
      // A box character drawn as a box is painted, not taken from a face, and asks quietly: a
      // Powerline prompt's separators would otherwise draw every row again when the icon font arrives
      let fresh = "";
      let painted = "";
      for (const char of shown) {
        if (rebuilt && isBoxGlyph(char)) {
          if (!askedPainted.has(char)) {
            askedPainted.add(char);
            painted += char;
          }
          continue;
        }
        if (asked.has(char)) continue;
        asked.add(char);
        fresh += char;
      }
      if (painted !== "") lateFaces.ask(fontFamily ?? "", painted, true);
      if (fresh !== "" && lateFaces.ask(fontFamily ?? "", fresh)) {
        widths.clear();
        if (span.classList.contains("xterm-cursor") && isBoxGlyph(shown) && [...shown].length === 1 && cellWidth > 0) {
          span.style.letterSpacing = `${cellWidth - widthOf(shown)}px`;
        }
      }
      if (rebuilt) continue;
      if (span.classList.contains("xterm-cursor") && [...shown].length === 1 && oversizedIcon(shown, widthOf(shown), cellWidth)) {
        span.style.cssText += `;font-size:${fontSize * iconScale([widthOf(shown)], cellWidth)}px;letter-spacing:0px`;
        continue;
      }
      const xtermSpacing = Number.parseFloat(span.style.letterSpacing);
      if (!(Math.abs(xtermSpacing) > MIN_SPACING_PX)) {
        if (shown !== text) span.textContent = shown;
        continue;
      }
      // a span merges only cells drawn with the same spacing, so its first glyph speaks for all
      const first = String.fromCodePoint(shown.codePointAt(0) ?? 0x20);
      let glyphWidth = widthOf(first);
      let spacing = xtermSpacing;
      const textForm = spacing < 0 ? textPresentation(shown) : null;
      if (textForm?.startsWith(first + TEXT_PRESENTATION)) {
        const slot = glyphWidth + spacing;
        shown = textForm;
        glyphWidth = widthOf(first + TEXT_PRESENTATION);
        spacing = slot - glyphWidth;
      }
      if (shown !== text) span.textContent = shown;
      const fit = glyphFit(spacing, glyphWidth, cellWidth);
      if (!fit) {
        if (spacing !== xtermSpacing) span.style.letterSpacing = `${spacing}px`;
        continue;
      }
      const spaced = fit.spacing / fit.stretch;
      const half = spaced / 2;
      const slot = glyphWidth + spacing;
      const margin = fit.stretch === 1 ? -half : graphemes(shown) * slot * (1 - 1 / fit.stretch) - half;
      const stretch = fit.stretch !== 1 ? `transform:scaleX(${fit.stretch});transform-origin:0 0;` : "";
      // an inline-block (xterm's rule for a row's spans) takes no underline or strikethrough from the span around it: it asks for them
      const glyphs = document.createElement("span");
      glyphs.className = BOX_CLASS;
      glyphs.style.cssText = `${fit.scale !== 1 ? `font-size:${fontSize * fit.scale}px;` : ""}${stretch}letter-spacing:${spaced}px;padding-left:${half}px;margin-right:${margin}px;clip-path:inset(0 ${half}px 0 0);text-decoration:inherit;font-weight:inherit`;
      glyphs.textContent = shown;
      span.style.letterSpacing = "0px";
      span.replaceChildren(glyphs);
    }
  };

  /**
   * Paints the boxes of a pass. Text and boxes each round their width to the layout's own
   * unit, so a box sits a fraction of a pixel off its column, differently in every row, and
   * the browser rounds each element's corner its own way before painting (measured at 2x:
   * the same column's line fell a device pixel apart in a row where its cell stood alone and
   * in one where it was the fifteenth of a run). So the lines go on a layer inside the box
   * that is put on a whole device pixel of the grid at the column the box stands in, and are
   * placed from there (pixelPlacement). Everything is counted inside the grid (a grid shown
   * scaled or panned is measured back to its own pixels), so every row lands alike whenever
   * it was drawn. All boxes are measured first and painted after: one layout, however many.
   */
  const placeBoxes = (): void => {
    const made = placed;
    placed = [];
    if (made.length === 0) return;
    const cellWidth = Number.parseFloat(screen.style.width) / term.cols;
    if (!(cellWidth > 0)) return;
    const frame = rows.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const scale = rows.offsetWidth > 0 && frame.width > 0 ? frame.width / rows.offsetWidth : 1;
    const corners = made.map(({ box }) => box.getBoundingClientRect());
    const snap = (value: number): number => Math.round(value * ratio) / ratio;
    made.forEach(({ box, drawing, cells, rowHeight }, index) => {
      const corner = corners[index]!;
      const left = (corner.left - frame.left) / scale;
      const top = (corner.top - frame.top) / scale;
      const column = Math.round(left / cellWidth) * cellWidth;
      const row = Math.round(top / rowHeight) * rowHeight;
      const layer = document.createElement("span");
      layer.className = BOX_CLASS;
      layer.style.cssText = `position:absolute;left:${snap(column) - left}px;top:${snap(row) - top}px;width:${cells * cellWidth + 1}px;height:${rowHeight}px;background:${boxBackground(drawing, pixelPlacement(column, row, snap(column), snap(row), ratio))}`;
      box.append(layer);
    });
  };

  /**
   * The icon font and the Hangul face are fetched only once a pane prints an icon or Korean that
   * reaches them (unicode-range, and no font ahead of them drawing it), after xterm and this module
   * measured those characters with whatever stood in for them, and both keep what they measured. So
   * a character drawn while a face that covers it has not loaded follows that face
   * (followLateFaces): its own `loaded` promise tells when it arrives, as no event can (WebKit, in
   * Safari and Ovis for Mac's window, fires no `loadingdone` for a face a stylesheet loads). Then,
   * once a frame whatever number of faces arrived, the widths here start over, the font family is
   * set again in a form that reads differently and means the same, so xterm measures anew, and every
   * row is drawn again: xterm keeps the rows it drew while the cell stays the same size, and only a
   * row drawn again is fitted again. The widths are cleared here rather than when the family reads
   * differently: two arrivals set it back as it was. A face that never loads leaves the fallback as
   * measured.
   */
  const lateFaces = followLateFaces(document.fonts as FontFaceSet | undefined, (callback) => { requestAnimationFrame(callback); }, () => {
    widths.clear();
    viewFits.clear();
    const family = term.options.fontFamily ?? "";
    const double = `"${ICON_FAMILY}"`;
    const single = `'${ICON_FAMILY}'`;
    if (family.includes(double)) term.options.fontFamily = family.replace(double, single);
    else if (family.includes(single)) term.options.fontFamily = family.replace(single, double);
    term.refresh(0, term.rows - 1);
  });
  // the composition view's own follower: a face that only a composing glyph reached measures the view again
  // when it arrives, and nothing else. No row drew from it, so the rows are neither measured nor drawn again
  // (that would blank the pane for a frame under the person's typing)
  const viewFaces = followLateFaces(document.fonts as FontFaceSet | undefined, (callback) => { requestAnimationFrame(callback); }, () => { viewFits.clear(); });
  adjustAll(rows.querySelectorAll("span"));
  placeBoxes();
  const observer = new MutationObserver((records) => {
    for (const record of records) adjustAll(record.addedNodes);
    placeBoxes();
  });
  observer.observe(rows, { childList: true, subtree: true });

  /**
   * An IME's pending text is not a row: xterm draws it in a box of its own over the cursor (the
   * composition view), in the plain font size. A Hangul syllable the rows enlarge above stayed the
   * font's narrow glyph there, so the syllable being typed looked smaller than every syllable
   * before it until it was committed. The box gets the fit its row will give it.
   */
  const view = screen.querySelector<HTMLElement>(".composition-view");
  const probe = document.createElement("span").style;
  // xterm's own transform of the box (a long text at the right edge is moved left to show its end),
  // which the stretch is added to, and the transform this module wrote last
  let viewBase = "";
  let viewWritten = "";
  const fitView = (): void => {
    if (!view) return;
    const { fontFamily, fontSize, fontWeight } = term.options;
    if (fontSize === undefined) return;
    let size = `${fontSize}px`;
    let spacing = "";
    let padding = "";
    let stretch = "";
    const cellWidth = Number.parseFloat(screen.style.width) / term.cols;
    const first = String.fromCodePoint((view.textContent ?? "").codePointAt(0) ?? 0x20);
    // the row's spacing is xterm's, from its own measure of the glyph (WidthCache: a run of it in
    // a span), which a canvas can measure differently (Hangul on macOS WebKit: 13px against 11.2px)
    const xtermMeasure = term.element?.querySelector<HTMLElement>(".xterm-width-cache-measure-container .xterm-char-measure-element");
    if (view.classList.contains("active") && cellWidth > 0 && xtermMeasure) {
      // xterm rewrites the box several times for each key an IME takes (its text, place and font), and
      // reading offsetWidth makes the browser recalculate the whole page's style first: measured on
      // every rewrite, fast Korean typing kept the main thread busy and the box lagged behind. A fit
      // is measured once for its glyph and font; a face that arrives late clears it with the widths
      // the device pixel ratio too: xterm measures its cells again when the page zooms or the window changes screen
      const key = `${first}\u0000${fontWeight}\u0000${fontSize}\u0000${fontFamily}\u0000${cellWidth}\u0000${globalThis.devicePixelRatio ?? 1}`;
      let fit = viewFits.get(key);
      if (fit === undefined) {
        // a face still loading for this glyph is followed from here as well: the rows ask only for text they
        // draw, and a syllable composed before any row drew its script would keep the stand-in's fit for good
        viewFaces.ask(fontFamily ?? "", first);
        const held = xtermMeasure.textContent;
        xtermMeasure.textContent = first.repeat(XTERM_MEASURE_REPEAT);
        const drawn = xtermMeasure.offsetWidth / XTERM_MEASURE_REPEAT;
        xtermMeasure.textContent = held;
        measure.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        const glyphWidth = measure.measureText(first).width;
        const cells = drawn > cellWidth + MIN_SPACING_PX ? 2 : 1;
        fit = glyphFit(cells * cellWidth - drawn, glyphWidth, cellWidth);
        if (viewFits.size >= VIEW_FIT_CACHE_MAX) viewFits.clear();
        viewFits.set(key, fit);
      }
      if (fit) {
        size = `${fontSize * fit.scale}px`;
        spacing = `${fit.spacing / fit.stretch}px`;
        padding = `${fit.spacing / fit.stretch / 2}px`;
        if (fit.stretch !== 1) stretch = `scaleX(${fit.stretch})`;
      }
    }
    // each write is a mutation this observer sees again: only what differs is written, compared
    // as the browser stores it (15.600000000000001px reads back rounded)
    if (view.style.transform !== viewWritten) viewBase = view.style.transform;
    probe.transform = stretchedView(viewBase, stretch);
    if (stretch !== "" && probe.transform === "") {
      probe.transform = viewBase;
      stretch = "";
      spacing = padding = "";
    }
    probe.fontSize = size;
    probe.letterSpacing = spacing;
    probe.paddingLeft = padding;
    if (view.style.fontSize !== probe.fontSize) view.style.fontSize = probe.fontSize;
    if (view.style.transform !== probe.transform) view.style.transform = probe.transform;
    viewWritten = view.style.transform;
    const origin = stretch === "" ? "" : "0 0";
    if (view.style.transformOrigin !== origin) view.style.transformOrigin = origin;
    if (view.style.letterSpacing !== probe.letterSpacing) view.style.letterSpacing = probe.letterSpacing;
    if (view.style.paddingLeft !== probe.paddingLeft) view.style.paddingLeft = probe.paddingLeft;
  };
  // xterm writes the text, then its own font size, then once more on the next task
  const viewObserver = new MutationObserver(fitView);
  if (view) viewObserver.observe(view, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  return () => {
    observer.disconnect();
    viewObserver.disconnect();
    lateFaces.stop();
    viewFaces.stop();
  };
}
