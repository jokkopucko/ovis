/**
 * Draws libghostty's rows into a terminal's screen (terminal.ts): one row element a grid row, each a run of styled
 * spans, its Kitty pictures above and below the text, the cursor, and the new lines told to a screen reader. The
 * styling follows the folded mirror's and xterm's own rows (contrast, faint, wide glyphs fitted to their cells).
 */
import { followLateFaces, glyphFit, iconScale, oversizedIcon } from "../terminalGlyphs.ts";
import { readableColor } from "../terminalFold.ts";
import { isBoxGlyph } from "../terminalBoxGlyphs.ts";
import { STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type GhosttyColors, type GhosttyImage, type GhosttyRun, type GhosttyVt } from "./vt.ts";

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

/** Nerd Font icons and the like, which a font means to fill one cell (terminalGlyphs.ts oversizedIcon) */
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
/** Powerline's separators run from the top of the row to the bottom: made smaller, a prompt's coloured segments would not join, so they are only narrowed */
const POWERLINE = /^[\ue0b0-\ue0d7]$/u;
/** Powerline glyphs drawn in their own colour whatever the contrast (xterm's isPowerlineGlyph) */
const POWERLINE_GLYPH = /^[\ue0a4-\ue0d6]$/u;
/** distinct glyphs measured before the measures start over: a long session of ever new graphemes must not grow without end */
const MEASURED_MAX = 4096;
const ANNOUNCED_LINES = 20;

/** the ANSI colours xterm.js 6 draws with wherever the theme names none (the dark palettes name none) */
const DEFAULT_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

export interface RendererTheme {
  foreground?: string; background?: string; cursor?: string; cursorAccent?: string; selectionBackground?: string;
  black?: string; red?: string; green?: string; yellow?: string; blue?: string; magenta?: string; cyan?: string; white?: string;
  brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string; brightBlue?: string; brightMagenta?: string; brightCyan?: string; brightWhite?: string;
}

export function themeColors(theme: RendererTheme | undefined): GhosttyColors {
  const t = theme ?? {};
  const ansi = [t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white,
    t.brightBlack, t.brightRed, t.brightGreen, t.brightYellow, t.brightBlue, t.brightMagenta, t.brightCyan, t.brightWhite]
    .map((color, index) => color || DEFAULT_ANSI[index]!);
  return { foreground: t.foreground ?? "#d4d4d4", background: t.background ?? "#1e1e1e", cursor: t.cursor ?? t.foreground ?? "#d4d4d4", ansi };
}

export interface RendererStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight?: string | number;
  fontWeightBold?: string | number;
  theme?: RendererTheme;
  minimumContrastRatio: number;
}

/** the columns of view row `y` a selection covers, end excluded, or null */
export type RowSelection = (y: number) => readonly [number, number] | null;

/** the lines that are new on `after`, the screen now, against `before`, the screen last told: the shift that matches most rows is the scroll between */
export function newLines(before: readonly string[], after: readonly string[]): string[] {
  const rows = after.length;
  let best = 0;
  let bestMatches = -1;
  for (let shift = 0; shift < rows; shift++) {
    let matches = 0;
    for (let y = 0; y + shift < rows; y++) if (after[y] && before[y + shift] === after[y]) matches++;
    if (matches > bestMatches) { best = shift; bestMatches = matches; }
  }
  return after.filter((line, y) => line && (y >= rows - best || before[y + best] !== line));
}

export interface RowsRenderer {
  readonly layer: HTMLElement;
  /** the grid and cell size changed: rows are made again and redrawn */
  fit(cols: number, rows: number, cellW: number, cellH: number): void;
  /** the font or theme changed: measures start over and every row is drawn again */
  restyle(): void;
  /** draws what changed; true when a row did. `atBottom`: the view shows the screen a program writes to */
  draw(selection: RowSelection, atBottom: boolean, announceNew: boolean): boolean;
  /** draws rows whose selected columns changed, the text being the same */
  redrawSelection(selection: RowSelection): void;
  dispose(): void;
}

export function createRowsRenderer(screen: HTMLElement, vt: GhosttyVt, style: () => RendererStyle): RowsRenderer {
  const layer = document.createElement("div");
  layer.className = "ghostty-layer";
  const below = document.createElement("div");
  below.className = "ghostty-images";
  const text = document.createElement("div");
  text.className = "ghostty-text";
  const above = document.createElement("div");
  above.className = "ghostty-images is-above";
  const cursor = document.createElement("div");
  cursor.className = "ghostty-cursor";
  for (const decoration of [below, above, cursor]) decoration.setAttribute("aria-hidden", "true");
  const announcer = document.createElement("div");
  announcer.className = "visually-hidden";
  announcer.setAttribute("aria-live", "polite");
  layer.append(below, text, above, cursor, announcer);
  screen.append(layer);

  let cols = 0;
  let rowCount = 0;
  let cellW = 0;
  let cellH = 0;
  let rowEls: HTMLDivElement[] = [];
  const rowText: string[] = [];
  let rowHtml: string[] = [];
  const rowRuns: GhosttyRun[][] = [];
  const rowSelected: string[] = [];
  let bottomText: string[] = [];
  let primed = false;
  const decoded = new Map<string, HTMLCanvasElement>();

  /** Only the latest message stays in the region: NVDA read a growing log whole, every earlier message again */
  const announce = (lines: string[]): void => {
    if (lines.length === 0) return;
    announcer.textContent = lines.slice(-ANNOUNCED_LINES).join("\n");
  };

  const measureLetterSpacing = (): void => {
    // each cell is the grid's width: a font whose advance differs is spaced to it. The probe measures the font's own
    // advance, not the spacing the last fit gave the layer, which would flip sign at every fit and never heal
    const probe = document.createElement("span");
    probe.textContent = "W".repeat(50);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;letter-spacing:0";
    text.append(probe);
    const advance = probe.getBoundingClientRect().width / 50;
    probe.remove();
    layer.style.letterSpacing = `${cellW - advance}px`;
  };

  const applyStyle = (): void => {
    const { fontFamily, fontSize, theme } = style();
    const palette = themeColors(theme);
    vt.setColors(palette);
    layer.style.color = palette.foreground;
    cursor.style.background = palette.cursor;
    Object.assign(layer.style, { fontFamily, fontSize: `${fontSize}px` });
  };

  const rebuildRows = (): void => {
    text.textContent = "";
    rowEls = [];
    for (let y = 0; y < rowCount; y++) {
      const row = document.createElement("div");
      row.className = "ghostty-row";
      row.innerHTML = rowHtml[y] ?? "";
      text.append(row);
      rowEls.push(row);
    }
  };

  // glyphs are fitted to their cells as xterm's rows are (terminalGlyphs.ts): a wide glyph that leaves its two cells
  // half empty is drawn larger (Hangul on a 0.6em Latin cell), an icon wider than its one cell smaller
  let measure: CanvasRenderingContext2D | null | undefined;
  const widths = new Map<string, number>();
  const asked = new Set<string>();
  const glyphWidth = (glyph: string, flags: number): number => {
    const key = `${flags & (STYLE_BOLD | STYLE_ITALIC)}${glyph}`;
    let width = widths.get(key);
    if (width === undefined) {
      measure ??= document.createElement("canvas").getContext("2d");
      if (!measure) return 0;
      const { fontFamily, fontSize, fontWeight, fontWeightBold } = style();
      measure.font = `${flags & STYLE_ITALIC ? "italic " : ""}${flags & STYLE_BOLD ? fontWeightBold ?? "bold" : fontWeight ?? "normal"} ${fontSize}px ${fontFamily}`;
      width = measure.measureText(glyph).width;
      if (widths.size >= MEASURED_MAX) widths.clear();
      widths.set(key, width);
    }
    return width;
  };
  const lateFaces = followLateFaces(document.fonts as Iterable<FontFace> | undefined, (callback) => requestAnimationFrame(callback), () => {
    widths.clear();
    redrawRows();
  });
  const fittedCell = ({ text: glyph, wide }: GhosttyRun["cells"][number], flags: number, own: string): string | null => {
    if (!wide && !PRIVATE_USE.test(glyph)) return null;
    if (!asked.has(glyph)) {
      if (asked.size >= MEASURED_MAX) asked.clear();
      asked.add(glyph);
      lateFaces.ask(style().fontFamily, glyph);
    }
    const width = glyphWidth(glyph, flags);
    const size = style().fontSize;
    const css = (...parts: string[]): string => [...parts, own].filter(Boolean).join(";");
    const bold = flags & STYLE_BOLD ? " xterm-bold" : "";
    if (!wide) {
      if (!oversizedIcon(glyph, width, cellW)) return null;
      if (POWERLINE.test(glyph)) return `<span class="ghostty-icon${bold}"><span class="ghostty-fit${bold}" style="${css(`transform:scaleX(${cellW / width})`, "transform-origin:0 0")}">${escapeHtml(glyph)}</span></span>`;
      return `<span class="ghostty-icon${bold}" style="${css(`font-size:${size * iconScale([width], cellW)}px`)}">${escapeHtml(glyph)}</span>`;
    }
    const fit = glyphFit(2 * cellW - width, width, cellW);
    if (!fit) return `<span class="ghostty-wide${bold}"${own ? ` style="${own}"` : ""}>${escapeHtml(glyph)}</span>`;
    const scale = fit.scale !== 1 ? `font-size:${size * fit.scale}px` : "";
    const stretch = fit.stretch !== 1 ? `transform:scaleX(${fit.stretch})` : "";
    return `<span class="ghostty-wide${bold}"><span class="ghostty-fit${bold}" style="${css(scale, stretch)}">${escapeHtml(glyph)}</span></span>`;
  };

  const pieceHtml = (run: GhosttyRun, selected: boolean): string => {
    let fg = run.fg, bg = run.bg;
    const { theme, minimumContrastRatio } = style();
    const colors = themeColors(theme);
    if (run.flags & STYLE_INVERSE) [fg, bg] = [bg ?? colors.background, fg ?? colors.foreground];
    // the selection is drawn under the rows (terminal.ts): a selected cell leaves its background out so it shows, and its
    // text is made readable on it, as xterm's rows make it
    const under = selected ? theme?.selectionBackground ?? colors.background : bg ?? colors.background;
    const drawn = fg;
    if (fg !== null || bg !== null || selected) {
      const ink = fg ?? colors.foreground;
      const readable = readableColor(ink, under, minimumContrastRatio);
      if (fg !== null || readable !== ink) fg = readable;
    }
    // a box, block or Powerline glyph is part of a drawing, its colour against the next one's: kept as written
    const keepsColour = (glyph: string): boolean => fg !== drawn && (isBoxGlyph(glyph) || POWERLINE_GLYPH.test(glyph));
    const box = [`left:calc(var(--ghostty-cw)*${run.x})`];
    if (bg && !selected) box.push(`background:${bg}`);
    if (run.flags & STYLE_BOLD) box.push("font-weight:bold");
    const colours = (colour: string | null): string[] => {
      const css: string[] = [];
      if (colour) css.push(`color:${colour}`);
      if (run.flags & STYLE_FAINT) css.push(`color:color-mix(in srgb, ${colour ?? "currentColor"} 50%, transparent)`);
      if (run.flags & STYLE_INVISIBLE) css.push("color:transparent");
      return css;
    };
    const rest: string[] = [];
    if (run.flags & STYLE_ITALIC) rest.push("font-style:italic");
    const lines = [run.flags & STYLE_UNDERLINE_MASK ? "underline" : "", run.flags & STYLE_STRIKE ? "line-through" : ""].filter(Boolean);
    if (lines.length) rest.push(`text-decoration:${lines.join(" ")}`);
    const glyph = [...colours(fg), ...rest];
    const kept = colours(drawn ?? colors.foreground);
    // a run that is only boxed cells gives the inherited values to the innermost box: an element under a parent with a
    // colour of its own misses the browser's style cache (a screen of coloured Korean recalculated styles many times over)
    let boxed = run.cells.map((cell) => fittedCell(cell, run.flags, keepsColour(cell.text) ? kept.join(";") : ""));
    const leaves = glyph.length > 0 && boxed.every((html) => html !== null);
    if (leaves) boxed = run.cells.map((cell) => fittedCell(cell, run.flags, [...(keepsColour(cell.text) ? kept : colours(fg)), ...rest].join(";")));
    let body = "";
    let plain = "";
    run.cells.forEach((cell, index) => {
      const fitted = boxed[index] ?? (keepsColour(cell.text) ? `<span style="${kept.join(";")}">${escapeHtml(cell.text)}</span>` : null);
      if (fitted) {
        if (plain) { body += escapeHtml(plain); plain = ""; }
        body += fitted;
      } else plain += cell.text;
    });
    if (plain) body += escapeHtml(plain);
    return `<span style="${(leaves ? box : [...box, ...glyph]).join(";")}">${body}</span>`;
  };

  const runHtml = (run: GhosttyRun, selected: readonly [number, number] | null): string => {
    if (!selected) return pieceHtml(run, false);
    const pieces: { run: GhosttyRun; inside: boolean }[] = [];
    let x = run.x;
    for (const cell of run.cells) {
      // a wide cell is selected by its first column alone, as a copy takes it
      const inside = x >= selected[0] && x < selected[1];
      const last = pieces.at(-1);
      if (last?.inside === inside) last.run.cells.push(cell);
      else pieces.push({ run: { ...run, x, cells: [cell] }, inside });
      x += cell.wide ? 2 : 1;
    }
    return pieces.map((piece) => pieceHtml(piece.run, piece.inside)).join("");
  };

  const paintRow = (y: number, runs: GhosttyRun[], selection: RowSelection): boolean => {
    const row = rowEls[y];
    if (!row) return false;
    const selected = selection(y);
    rowSelected[y] = String(selected);
    let html = "";
    for (const run of runs) html += runHtml(run, selected);
    if (rowHtml[y] === html) return false;
    row.innerHTML = html;
    rowHtml[y] = html;
    return true;
  };
  let lastSelection: RowSelection = () => null;
  const redrawRows = (): void => { rowRuns.forEach((runs, y) => paintRow(y, runs, lastSelection)); };

  const picture = (image: GhosttyImage): HTMLCanvasElement | null => {
    const key = `${image.id}:${image.generation}`;
    let source = decoded.get(key);
    if (!source) {
      const pixels = vt.imagePixels(image.id);
      if (!pixels) return null;
      for (const old of decoded.keys()) if (old.startsWith(`${image.id}:`)) decoded.delete(old);
      source = document.createElement("canvas");
      source.width = pixels.width;
      source.height = pixels.height;
      source.getContext("2d")?.putImageData(pixels, 0, 0);
      decoded.set(key, source);
    }
    return source;
  };

  const drawImages = (images: GhosttyImage[]): void => {
    below.textContent = "";
    above.textContent = "";
    const live = new Set(images.map((image) => `${image.id}:${image.generation}`));
    for (const key of decoded.keys()) if (!live.has(key)) decoded.delete(key);
    for (const image of [...images].sort((a, b) => a.z - b.z)) {
      const source = picture(image);
      if (!source || image.width === 0 || image.height === 0) continue;
      const scale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.className = "ghostty-image";
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      Object.assign(canvas.style, {
        left: `${image.col * cellW + image.offsetX}px`, top: `${image.row * cellH + image.offsetY}px`,
        width: `${image.width}px`, height: `${image.height}px`,
      });
      const { x, y, width, height } = image.source;
      canvas.getContext("2d")?.drawImage(source, x, y, width || source.width, height || source.height, 0, 0, canvas.width, canvas.height);
      (image.layer === 2 ? above : below).append(canvas);
    }
  };

  applyStyle();
  return {
    layer,
    fit(nextCols, nextRows, nextCellW, nextCellH) {
      cols = nextCols;
      rowCount = nextRows;
      cellW = nextCellW;
      cellH = nextCellH;
      Object.assign(layer.style, { width: `${cellW * cols}px`, height: `${cellH * rowCount}px` });
      layer.style.setProperty("--ghostty-cw", `${cellW}px`);
      layer.style.setProperty("--ghostty-ch", `${cellH}px`);
      measureLetterSpacing();
      rowRuns.length = Math.min(rowRuns.length, rowCount);
      rebuildRows();
      redrawRows();
    },
    restyle() {
      widths.clear();
      asked.clear();
      applyStyle();
      if (cellW > 0) measureLetterSpacing();
      rowHtml = [];
      redrawRows();
    },
    draw(selection, atBottom, announceNew) {
      lastSelection = selection;
      const changed = vt.frame((y, runs) => {
        if (!rowEls[y]) return;
        rowRuns[y] = runs;
        if (!paintRow(y, runs, selection)) return;
        rowText[y] = runs.map((run) => run.cells.map((cell) => cell.text).join("")).join("").trimEnd();
      });
      rowRuns.forEach((runs, y) => { if (rowSelected[y] !== String(selection(y))) paintRow(y, runs, selection); });
      // lines are told from the screen at the bottom, the one a program writes to: a view scrolled back holds a
      // write until it is back there, and a frame that only moved the view tells nothing (#2963)
      if (atBottom) {
        const screenText = rowText.slice(0, rowCount);
        const before = Array.from({ length: rowCount }, (_, y) => bottomText[bottomText.length - rowCount + y] ?? "");
        if (primed && announceNew) announce(newLines(before, screenText));
        if (announceNew) primed = true;
        bottomText = screenText;
      }
      if (changed) {
        const c = vt.cursor();
        Object.assign(cursor.style, c.visible
          ? { display: "block", left: `${c.x * cellW}px`, top: `${c.y * cellH + (c.style === 2 ? cellH - 2 : 0)}px`, width: `${c.style === 0 ? 2 : cellW}px`, height: `${c.style === 2 ? 2 : cellH}px` }
          : { display: "none" });
      }
      const images = vt.placedImages();
      if (images) drawImages(images);
      return changed;
    },
    redrawSelection(selection) {
      lastSelection = selection;
      rowRuns.forEach((runs, y) => { if (rowSelected[y] !== String(selection(y))) paintRow(y, runs, selection); });
    },
    dispose() {
      lateFaces.stop();
      layer.remove();
      decoded.clear();
    },
  };
}
