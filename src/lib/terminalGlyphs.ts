/**
 * The renderer sizes every cell from the Latin font and gives each glyph the
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
 *   All of that goes on a span inside the run's own, which keeps the cells' background and block
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
 * Copy reads libghostty's rows, not the DOM, and still returns what the pane wrote.
 */

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
const VIEW_FIT_CACHE_MAX = 4096;

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

export interface ViewFont { readonly family: string; readonly size: number; readonly weight?: string | number }

/**
 * An IME's pending text is not a row: it is drawn in a box of its own over the cursor (the composition view), in the plain
 * font size. A Hangul syllable the rows enlarge (renderer.ts fits a wide glyph to its two cells) stayed the font's narrow
 * glyph there, so the syllable being typed looked smaller than every syllable before it until it was committed. The box
 * gets the fit its row will give it: its first glyph takes two cells when it is wider than one, as libghostty lays it out.
 * Returns the undo.
 */
export function fitCompositionView(view: HTMLElement, cellWidth: () => number, font: () => ViewFont): () => void {
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return () => {};
  const fits = new Map<string, GlyphFit | null>();
  const faces = followLateFaces(document.fonts as FontFaceSet | undefined, (callback) => { requestAnimationFrame(callback); }, () => { fits.clear(); });
  const probe = document.createElement("span").style;
  // the input layer's own transform of the box (a long text at the right edge is moved left to show its end), which
  // the stretch is added to, and the transform written here last
  let base = "";
  let written = "";
  const fit = (): void => {
    const { family, size: fontSize, weight = "normal" } = font();
    const cell = cellWidth();
    let size = `${fontSize}px`;
    let spacing = "";
    let padding = "";
    let stretch = "";
    const first = String.fromCodePoint((view.textContent ?? "").codePointAt(0) ?? 0x20);
    if (view.classList.contains("active") && cell > 0) {
      const key = `${first}\u0000${weight}\u0000${fontSize}\u0000${family}\u0000${cell}\u0000${globalThis.devicePixelRatio ?? 1}`;
      let found = fits.get(key);
      if (found === undefined) {
        faces.ask(family, first);
        measure.font = `${weight} ${fontSize}px ${family}`;
        const glyphWidth = measure.measureText(first).width;
        const cells = glyphWidth > cell + MIN_SPACING_PX ? 2 : 1;
        found = glyphFit(cells * cell - glyphWidth, glyphWidth, cell);
        if (fits.size >= VIEW_FIT_CACHE_MAX) fits.clear();
        fits.set(key, found);
      }
      if (found) {
        size = `${fontSize * found.scale}px`;
        spacing = `${found.spacing / found.stretch}px`;
        padding = `${found.spacing / found.stretch / 2}px`;
        if (found.stretch !== 1) stretch = `scaleX(${found.stretch})`;
      }
    }
    // each write is a mutation the observer sees again: only what differs is written, compared as the browser stores it
    if (view.style.transform !== written) base = view.style.transform;
    probe.transform = stretchedView(base, stretch);
    if (stretch !== "" && probe.transform === "") {
      probe.transform = base;
      stretch = "";
      spacing = padding = "";
    }
    probe.fontSize = size;
    probe.letterSpacing = spacing;
    probe.paddingLeft = padding;
    if (view.style.fontSize !== probe.fontSize) view.style.fontSize = probe.fontSize;
    if (view.style.transform !== probe.transform) view.style.transform = probe.transform;
    written = view.style.transform;
    const origin = stretch === "" ? "" : "0 0";
    if (view.style.transformOrigin !== origin) view.style.transformOrigin = origin;
    if (view.style.letterSpacing !== probe.letterSpacing) view.style.letterSpacing = probe.letterSpacing;
    if (view.style.paddingLeft !== probe.paddingLeft) view.style.paddingLeft = probe.paddingLeft;
  };
  const observer = new MutationObserver(fit);
  observer.observe(view, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  return () => {
    observer.disconnect();
    faces.stop();
  };
}
