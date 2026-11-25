// allow: SIZE_OK - the overlay's drawing and cleanup share its terminal and renderer state.
/**
 * libghostty-vt draws every xterm terminal's screen, Kitty graphics pictures included, while xterm stays
 * the engine under it. xterm draws by itself if the module fails, or when it parses the same output
 * and an iTerm2 or sixel picture would move its cursor. In `only` mode libghostty draws those too.
 *
 * libghostty answers nothing: a reply it made to a replayed stream would reach the program as typing.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";
import { terminalDrawsPictures, terminalPictureLimits } from "../terminalImages.ts";
import { followLateFaces, glyphFit, iconScale, oversizedIcon } from "../terminalGlyphs.ts";
import { readableColor } from "../terminalFold.ts";
import { isBoxGlyph } from "../terminalBoxGlyphs.ts";
import { requestShownFrame } from "../shownFrame.ts";
import { GHOSTTY_DREW_EVENT, GHOSTTY_VIEW_EVENT, VIEW_MOVED_EVENT, ownView } from "./viewMoved.ts";
import { controlsWriter, currentQuestions, fallbackOutput, type DeferredQuestions, type RetainedOutput } from "./controls.ts";
import { itermPictureWriter } from "./itermPictureWriter.ts";
import { type ScreenLine, holdScreenRows, terminalScreen, type ScreenRows } from "../terminalScreen.ts";
import { holdSelection } from "./selection.ts";
import { ghosttyRows } from "./screenRows.ts";
import { wheelPansGrid } from "../terminalWheel.ts";
import { GhosttyVt, rgb, STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type GhosttyColors, type GhosttyImage, type GhosttyRun } from "./vt.ts";

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

/** `dispose(handOver)`: false when the terminal itself goes, so nothing is handed to xterm to draw */
export interface GhosttyOverlay { dispose(handOver?: boolean): void }

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

/** Nerd Font icons and the like, which a font means to fill one cell (terminalGlyphs.ts oversizedIcon) */
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
/** Powerline's separators run from the top of the row to the bottom: made smaller, a prompt's coloured segments would not join, so they are only narrowed */
const POWERLINE = /^[\ue0b0-\ue0d7]$/u;
/** Powerline glyphs xterm draws in their own colour whatever the contrast (its isPowerlineGlyph) */
const POWERLINE_GLYPH = /^[\ue0a4-\ue0d6]$/u;
/** distinct glyphs measured before the measures start over: a long session of ever new graphemes must not grow without end */
const MEASURED_MAX = 4096;

const latin1 = new TextDecoder("latin1");
const XTERM_PICTURE = /\x1b\]1337;(?:File|MultipartFile)=|\x1bP[0-9;]*q/g;
/** Pictures xterm's addon draws when both parsers receive the original output. */
export function hasXtermPicture(data: string | Uint8Array, carried = 0): boolean {
  const text = typeof data === "string" ? data : latin1.decode(data);
  for (const match of text.matchAll(XTERM_PICTURE)) {
    if (match.index + match[0].length > carried) return true;
  }
  return false;
}

export function xtermPictureScanner(): (data: string | Uint8Array) => boolean {
  let tail = "";
  return (data) => {
    const carried = tail.length;
    const text = tail + (typeof data === "string" ? data : latin1.decode(data));
    // longer than any start it looks for (`ESC ] 1337 ; MultipartFile =`, a sixel DCS with its parameters)
    tail = text.slice(-64);
    return hasXtermPicture(text, carried);
  };
}

/** how long after a wheel or a swipe a frame is taken for herdr's repaint of the scrolled screen, not for output */
const VIEW_REPAINT_MS = 1000;
const VIEW_GESTURES = ["wheel", "touchmove", VIEW_MOVED_EVENT];

const ANNOUNCED_LINES = 20;

interface XtermRowRenderer { renderRows(start: number, end: number): void }

type BufferPoint = readonly [x: number, y: number];
/** xterm's render service: its renderer, and the hook that hears the selection it draws change */
interface XtermRenderService {
  _renderer?: { value?: XtermRowRenderer };
  handleSelectionChanged?: (start?: BufferPoint, end?: BufferPoint, columnSelectMode?: boolean) => void;
}

function xtermRenderService(term: Terminal): XtermRenderService | null {
  return (term as unknown as { _core?: { _renderService?: XtermRenderService } })._core?._renderService ?? null;
}

/** xterm's DOM renderer, which writes its rows; xterm.js has no public way to stop it drawing */
function xtermRowRenderer(term: Terminal): XtermRowRenderer | null {
  const renderer = xtermRenderService(term)?._renderer?.value;
  return renderer && typeof renderer.renderRows === "function" ? renderer : null;
}

/** a selection as xterm draws it: buffer cells, end column excluded; a column one takes the same columns on every row */
interface Selection { readonly start: BufferPoint; readonly end: BufferPoint; readonly column: boolean }

/** the columns of buffer line `line` a selection covers, end excluded, or null, as xterm's row factory tells a selected cell */
function selectedColumns(selection: Selection | null, line: number, cols: number): readonly [number, number] | null {
  if (!selection) return null;
  const { start, end, column } = selection;
  if (line < Math.min(start[1], end[1]) || line > Math.max(start[1], end[1])) return null;
  const [from, to] = column
    ? [Math.min(start[0], end[0]), Math.max(start[0], end[0])]
    : [line === start[1] ? start[0] : 0, line === end[1] ? end[0] : cols];
  return to > from ? [from, to] : null;
}

/**
 * xterm's cell in device pixels, which follows the font alone, or null before it measured one. While its renderer is
 * paused (out of view) xterm tells a resize at once but resizes its screen later, from an idle task, so the screen
 * measured then is the old grid's. Under the chat lens the pane sits in a `content-visibility: hidden` subtree, where
 * the browser skips ResizeObserver, so nothing measured the screen again: the old screen over the new columns stuck (#3366).
 */
function xtermDeviceCell(term: Terminal): { width: number; height: number } | null {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { device?: { cell?: { width: number; height: number } } } } } })._core;
  const cell = core?._renderService?.dimensions?.device?.cell;
  return cell && cell.width > 0 && cell.height > 0 ? cell : null;
}

/** xterm.js 6's own ANSI colours, which it draws with wherever the theme names none (the dark palettes name none) */
const XTERM_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

function themeColors(term: Terminal): GhosttyColors {
  const theme = term.options.theme ?? {};
  const ansi = [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite]
    .map((color, index) => color || XTERM_ANSI[index]!);
  return { foreground: theme.foreground ?? "#d4d4d4", background: theme.background ?? "#1e1e1e", cursor: theme.cursor ?? theme.foreground ?? "#d4d4d4", ansi };
}

/** the output kept, with `only`, to hand xterm whole if libghostty stops drawing (the oldest goes past it) */
const KEPT_BYTES_MAX = 8 * 1024 * 1024;

/**
 * In `only` mode libghostty is the sole parser of screen output. xterm parses only the sequences its
 * input side reads, with its cursor kept on libghostty's (controls.ts). The history libghostty keeps is scrolled here, and every
 * reader takes libghostty's rows (terminalScreen.ts viewRows).
 */
export async function attachGhosttyOverlay(
  term: Terminal, host: HTMLElement, takeBacklog: () => (string | Uint8Array)[] | null,
  startup?: { readonly questions: readonly DeferredQuestions[] },
): Promise<GhosttyOverlay | null> {
  const only = startup !== undefined;
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error("ghostty overlay: the terminal is not open");
  const vt = await GhosttyVt.create(term.cols, term.rows);
  const backlog = takeBacklog();
  const pictureIn = only ? null : xtermPictureScanner();
  if (!backlog || (pictureIn && terminalDrawsPictures(term) && backlog.some(pictureIn))) {
    vt.dispose();
    return null;
  }
  let disposed = false;
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

  let rowEls: HTMLDivElement[] = [];
  let rowText: string[] = [];
  let primed = false;
  let written = false;
  // on herdr's own server xterm keeps no history: a wheel or a swipe scrolls herdr's screen, which comes back as
  // written bytes (TerminalViewportTools.tsx). Frames until a moment after the gesture tell nothing
  let viewMovedUntil = 0;
  const viewMoved = (): void => { if (!term.options.scrollback) viewMovedUntil = performance.now() + VIEW_REPAINT_MS; };
  let bottomText: string[] = [];
  // what each row shows: libghostty hands over only the rows that changed, so fresh row elements are refilled from it
  let rowHtml: string[] = [];
  const rowRuns: GhosttyRun[][] = [];
  let cellW = 0;
  let cellH = 0;
  let cancelFrame: (() => void) | null = null;
  const decoded = new Map<string, HTMLCanvasElement>();

  const metrics = (): void => {
    // the screen xterm draws for the grid it has now, rounded as its DomRenderer rounds it
    const device = xtermDeviceCell(term);
    const box = device
      ? { width: Math.round(device.width * term.cols / (window.devicePixelRatio || 1)), height: Math.round(device.height * term.rows / (window.devicePixelRatio || 1)) }
      : screen.getBoundingClientRect();
    cellW = box.width / term.cols;
    cellH = box.height / term.rows;
    const font = term.options.fontFamily ?? "monospace";
    const size = term.options.fontSize ?? 13;
    Object.assign(layer.style, { fontFamily: font, fontSize: `${size}px`, width: `${box.width}px`, height: `${box.height}px` });
    layer.style.setProperty("--ghostty-cw", `${cellW}px`);
    layer.style.setProperty("--ghostty-ch", `${cellH}px`);
    // each cell is xterm's width: a font whose advance differs is spaced to it. The probe measures the font's own
    // advance, not the spacing the last fit gave the layer: inherited, a wrong spacing flipped sign at every fit and
    // never healed, and Latin was drawn squashed over itself or spread apart
    const probe = document.createElement("span");
    probe.textContent = "W".repeat(50);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;letter-spacing:0";
    text.append(probe);
    const advance = probe.getBoundingClientRect().width / 50;
    probe.remove();
    layer.style.letterSpacing = `${cellW - advance}px`;
  };

  /** Only the latest message stays in the region: NVDA read a growing log whole, every earlier message again */
  const announce = (lines: string[]): void => {
    if (lines.length === 0) return;
    announcer.textContent = lines.slice(-ANNOUNCED_LINES).join("\n");
  };

  const rebuildRows = (): void => {
    text.textContent = "";
    rowEls = [];
    for (let y = 0; y < term.rows; y++) {
      const row = document.createElement("div");
      row.className = "ghostty-row";
      row.innerHTML = rowHtml[y] ?? "";
      text.append(row);
      rowEls.push(row);
    }
  };

  const redrawRows = (): void => {
    const selection = currentSelection();
    rowRuns.forEach((runs, y) => paintRow(y, runs, selection));
  };

  const renderService = xtermRenderService(term);
  const reader = terminalScreen(term);
  const currentSelection = (): Selection | null => reader.drawnSelection();
  const rowSelected: string[] = [];
  const paintRow = (y: number, runs: GhosttyRun[], selection: Selection | null): boolean => {
    const row = rowEls[y];
    if (!row) return false;
    const selected = selectedColumns(selection, reader.viewportY + y, term.cols);
    rowSelected[y] = String(selected);
    let html = "";
    for (const run of runs) html += runHtml(run, selected);
    if (rowHtml[y] === html) return false;
    row.innerHTML = html;
    rowHtml[y] = html;
    return true;
  };

  let grid = "";
  let replayRemaining = backlog.length;
  const heldQuestions = [...(startup?.questions ?? [])];
  const fit = (): void => {
    metrics();
    const now = `${term.cols}x${term.rows}@${cellW}x${cellH}`;
    if (now === grid) return;
    grid = now;
    vt.resize(term.cols, term.rows, cellW, cellH);
    // xterm reflows its own (empty) rows: its cursor, where the IME stands, goes back to libghostty's
    if (only && replayRemaining === 0) writeOnly.syncCursor();
    rowRuns.length = Math.min(rowRuns.length, term.rows);
    rebuildRows();
    redrawRows();
    schedule();
  };

  const colors = (): void => {
    const palette = themeColors(term);
    vt.setColors(palette);
    layer.style.color = palette.foreground;
    cursor.style.background = palette.cursor;
  };

  // glyphs are fitted to their cells as xterm's rows are (terminalGlyphs.ts): a wide glyph that leaves its two cells
  // half empty is drawn larger (Hangul on a 0.6em Latin cell), an icon wider than its one cell smaller
  let measure: CanvasRenderingContext2D | null | undefined;
  const widths = new Map<string, number>();
  const asked = new Set<string>();
  const glyphWidth = (text: string, flags: number): number => {
    const key = `${flags & (STYLE_BOLD | STYLE_ITALIC)}${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      measure ??= document.createElement("canvas").getContext("2d");
      if (!measure) return 0;
      const { fontFamily, fontSize, fontWeight, fontWeightBold } = term.options;
      measure.font = `${flags & STYLE_ITALIC ? "italic " : ""}${flags & STYLE_BOLD ? fontWeightBold ?? "bold" : fontWeight ?? "normal"} ${fontSize ?? 13}px ${fontFamily ?? "monospace"}`;
      width = measure.measureText(text).width;
      if (widths.size >= MEASURED_MAX) widths.clear();
      widths.set(key, width);
    }
    return width;
  };
  const fittedCell = ({ text, wide }: GhosttyRun["cells"][number], flags: number, glyph: string): string | null => {
    if (!wide && !PRIVATE_USE.test(text)) return null;
    // each character asks for its faces once a font, as xterm's rows do
    if (!asked.has(text)) {
      if (asked.size >= MEASURED_MAX) asked.clear();
      asked.add(text);
      lateFaces.ask(term.options.fontFamily ?? "", text);
    }
    const width = glyphWidth(text, flags);
    const size = term.options.fontSize ?? 13;
    const own = (...css: string[]): string => [...css, glyph].filter(Boolean).join(";");
    // xterm's `span:not(.xterm-bold)` rule sets every span's weight under its screen: a bold cell's box says it is bold
    const bold = flags & STYLE_BOLD ? " xterm-bold" : "";
    if (!wide) {
      if (!oversizedIcon(text, width, cellW)) return null;
      // a separator keeps its height and is narrowed to its cell, as xterm's rows draw it
      if (POWERLINE.test(text)) return `<span class="ghostty-icon${bold}"><span class="ghostty-fit${bold}" style="${own(`transform:scaleX(${cellW / width})`, "transform-origin:0 0")}">${escapeHtml(text)}</span></span>`;
      return `<span class="ghostty-icon${bold}" style="${own(`font-size:${size * iconScale([width], cellW)}px`)}">${escapeHtml(text)}</span>`;
    }
    const fit = glyphFit(2 * cellW - width, width, cellW);
    if (!fit) return `<span class="ghostty-wide${bold}"${glyph ? ` style="${glyph}"` : ""}>${escapeHtml(text)}</span>`;
    const scale = fit.scale !== 1 ? `font-size:${size * fit.scale}px` : "";
    const stretch = fit.stretch !== 1 ? `transform:scaleX(${fit.stretch})` : "";
    return `<span class="ghostty-wide${bold}"><span class="ghostty-fit${bold}" style="${own(scale, stretch)}">${escapeHtml(text)}</span></span>`;
  };
  const lateFaces = followLateFaces(document.fonts as Iterable<FontFace> | undefined, (callback) => requestAnimationFrame(callback), () => {
    widths.clear();
    redrawRows();
  });

  const runHtml = (run: GhosttyRun, selected: readonly [number, number] | null): string => {
    if (!selected) return pieceHtml(run, false);
    const pieces: { run: GhosttyRun; inside: boolean }[] = [];
    let x = run.x;
    for (const cell of run.cells) {
      // a wide cell is selected by its first column alone, as xterm's row factory tells it and its copy takes it: a column
      // whose edge falls inside the glyph leaves the glyph out when that edge is right of the first column
      const inside = x >= selected[0] && x < selected[1];
      const last = pieces.at(-1);
      if (last?.inside === inside) last.run.cells.push(cell);
      else pieces.push({ run: { ...run, x, cells: [cell] }, inside });
      x += cell.wide ? 2 : 1;
    }
    return pieces.map((piece) => pieceHtml(piece.run, piece.inside)).join("");
  };

  const pieceHtml = (run: GhosttyRun, selected: boolean): string => {
    let fg = run.fg, bg = run.bg;
    const theme = themeColors(term);
    if (run.flags & STYLE_INVERSE) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
    // xterm draws the selection under this layer: a selected cell leaves its background out so the selection shows, as
    // over a plain cell (#3407), and its text is made readable on the selection, as xterm's rows make it
    const under = selected ? term.options.theme?.selectionBackground ?? theme.background : bg ?? theme.background;
    // with `only` xterm's selection layer sizes its cells by a buffer with no text (a wide glyph is one column there):
    // the layer paints the selection itself
    const paintsSelection = selected && only;
    // xterm's minimumContrastRatio, as its own rows and a folded mirror draw it (terminalFold.ts cellStyle)
    const drawn = fg;
    if (fg !== null || bg !== null || selected) {
      const text = fg ?? theme.foreground;
      const readable = readableColor(text, under, term.options.minimumContrastRatio ?? 1);
      if (fg !== null || readable !== text) fg = readable;
    }
    // a box, block or Powerline glyph is part of a drawing, its colour against the next one's: xterm keeps it as written
    // (treatGlyphAsBackgroundColor), and so does this layer
    const keepsColour = (text: string): boolean => fg !== drawn && (isBoxGlyph(text) || POWERLINE_GLYPH.test(text));
    const box = [`left:calc(var(--ghostty-cw)*${run.x})`];
    if (bg && !selected) box.push(`background:${bg}`);
    if (paintsSelection) box.push(`background:${under}`);
    if (run.flags & STYLE_BOLD) box.push("font-weight:bold");
    // what its text inherits: a faint run dims its text, not its background, as xterm and a folded mirror draw it
    const colours = (colour: string | null): string[] => {
      const css: string[] = [];
      if (colour) css.push(`color:${colour}`);
      if (run.flags & STYLE_FAINT) css.push(`color:color-mix(in srgb, ${colour ?? "currentColor"} 50%, transparent)`);
      if (run.flags & STYLE_INVISIBLE) css.push("color:transparent");
      return css;
    };
    const rest: string[] = [];
    if (run.flags & STYLE_ITALIC) rest.push("font-style:italic");
    // an underline or strikethrough takes the colour of the element that draws it: it goes with the colour
    const lines = [run.flags & STYLE_UNDERLINE_MASK ? "underline" : "", run.flags & STYLE_STRIKE ? "line-through" : ""].filter(Boolean);
    if (lines.length) rest.push(`text-decoration:${lines.join(" ")}`);
    const glyph = [...colours(fg), ...rest];
    const kept = colours(drawn ?? theme.foreground);
    // an element whose parent has an inherited value of its own (a colour) misses the browser's style cache and is
    // styled from scratch: on a screen of Korean in a colour a cell, three elements a cell made each frame's style
    // recalculation several times longer than xterm's. A run that is only boxed cells (a wide or icon cell each)
    // gives the inherited values to the innermost box instead, so no element sits under a parent with a colour of its own
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
      // the grid is xterm's, in CSS pixels; libghostty placed the picture in the cell size it was given
      Object.assign(canvas.style, {
        left: `${image.col * cellW + image.offsetX}px`, top: `${image.row * cellH + image.offsetY}px`,
        width: `${image.width}px`, height: `${image.height}px`,
      });
      const { x, y, width, height } = image.source;
      canvas.getContext("2d")?.drawImage(source, x, y, width || source.width, height || source.height, 0, 0, canvas.width, canvas.height);
      (image.layer === 2 ? above : below).append(canvas);
    }
  };

  let options: unknown[] = [];
  const optionsChanged = (): boolean => {
    const now = [term.options.fontFamily, term.options.fontSize, term.options.theme, term.options.scrollback];
    if (now.every((value, index) => value === options[index])) return false;
    options = now;
    return true;
  };

  const draw = (): void => {
    if (disposed) return;
    try {
      drawFrame();
    } catch (error) {
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };

  const drawFrame = (): void => {
    if (optionsChanged()) {
      widths.clear();
      asked.clear();
      grid = "";
      colors();
      vt.setScrollback(term.options.scrollback ?? 0);
      fit();
    }
    // xterm's own history (a herdr-core server's `terminal-history`): the layer shows the rows xterm shows
    const buffer = reader.active();
    const rowsAbove = only ? fromBottom : buffer.baseY - buffer.viewportY;
    vt.scrollFromBottom(rowsAbove);
    const selection = currentSelection();
    const changed = vt.frame((y, runs) => {
      if (!rowEls[y]) return;
      rowRuns[y] = runs;
      // a row libghostty marks dirty can come out the same (a cursor that moved past it): no DOM write
      if (!paintRow(y, runs, selection)) return;
      rowText[y] = runs.map((run) => run.cells.map((cell) => cell.text).join("")).join("").trimEnd();
    });
    // a selection moves over rows libghostty does not mark dirty: only the rows whose selected columns changed are drawn again
    rowRuns.forEach((runs, y) => {
      if (rowSelected[y] !== String(selectedColumns(selection, buffer.viewportY + y, term.cols))) paintRow(y, runs, selection);
    });
    // lines are told from the screen at the bottom, the one a program writes to: a view scrolled back holds a
    // write until it is back there, and a frame that only moved the view tells nothing (#2963)
    if (rowsAbove === 0) {
      const screenText = rowText.slice(0, term.rows);
      // a grid that changed height keeps its bottom rows, as xterm does: the baseline lines up with them
      const before = Array.from({ length: term.rows }, (_, y) => bottomText[bottomText.length - term.rows + y] ?? "");
      if (primed && written && performance.now() >= viewMovedUntil) announce(newLines(before, screenText));
      // the screen a pane opens on is the first one written: herdr's own server paints it only after the attach
      if (written) primed = true;
      written = false;
      bottomText = screenText;
    }
    if (changed) host.dispatchEvent(new Event(GHOSTTY_DREW_EVENT));
    if (changed) {
      const c = vt.cursor();
      Object.assign(cursor.style, c.visible
        ? { display: "block", left: `${c.x * cellW}px`, top: `${c.y * cellH + (c.style === 2 ? cellH - 2 : 0)}px`, width: `${c.style === 0 ? 2 : cellW}px`, height: `${c.style === 2 ? 2 : cellH}px` }
        : { display: "none" });
    }
    const images = vt.placedImages();
    if (images) drawImages(images);
    // xterm may make a new renderer (a font or theme change): that one draws nothing either.
    if (host.hasAttribute("data-folded")) {
      if (muted) { unmuteXtermRows(); term.refresh(0, term.rows - 1); }
    } else muteXtermRows();
  };

  const schedule = (): void => {
    if (cancelFrame !== null || disposed) return;
    cancelFrame = requestShownFrame(() => {
      cancelFrame = null;
      draw();
    });
  };
  const cancelPaint = (): void => { cancelFrame?.(); };

  const write = term.write.bind(term);
  // a view scrolled back over libghostty's history (only) stays on its rows while new ones push the history up, as xterm's does
  let fromBottom = 0;
  const writeOnly = controlsWriter({
    write: (data) => {
      const before = fromBottom > 0 ? vt.history().scrollback : 0;
      vt.write(data);
      if (fromBottom > 0) fromBottom += vt.history().scrollback - before;
    },
    screenCursor: () => vt.screenCursor(),
  }, (data, callback) => write(data, callback));
  const pictures = only ? itermPictureWriter(
    () => terminalPictureLimits(term),
    () => ({ cols: term.cols, rows: term.rows, cellW, cellH }),
    // libghostty doesn't expose the current SGR background; use the terminal's default.
    () => rgb(themeColors(term).background) ?? [0, 0, 0],
  ) : null;
  const finishStartup = (): void => {
    if (writeOnly.syncCursor(currentQuestions(heldQuestions))) heldQuestions.length = 0;
  };
  const emitOnly = (frame: RetainedOutput, captured = false) => (data: string | Uint8Array, picture: boolean, end: number): void => {
    if (disposed) return;
    try {
      const send = captured ? writeOnly.seed : writeOnly;
      if (picture) {
        const { x } = vt.screenCursor();
        send(data);
        // xterm's default sixelScrolling (also used for iTerm2) ends on the last image row
        // at the original column. Kitty ends on that row too, but moves to the right.
        // This follows the default, not xterm's fixed-position DECSDM mode.
        if (vt.screenCursor().x !== x) send(`\x1b[${x + 1}G`);
      } else send(data);
      if (!captured) {
        frame.sent = end;
        if (replayRemaining === 0 && heldQuestions.length) finishStartup();
      }
      written = true;
    } catch (error) { readFailed(error); }
  };
  // Keep the raw output to reconstruct xterm's screen. Image conversion can leave a frame only partly submitted.
  const kept: RetainedOutput[] = [];
  let keptBytes = 0;
  const keep = (frame: RetainedOutput): void => {
    kept.push(frame);
    keptBytes += frame.data.length;
    while (keptBytes > KEPT_BYTES_MAX && kept.length > 1) keptBytes -= kept.shift()!.data.length;
  };
  term.write = ((data: string | Uint8Array, callback?: () => void) => {
    if (pictures && !disposed) {
      const frame = { data, sent: 0 };
      keep(frame);
      pictures.write(data, emitOnly(frame), () => {
        // xterm holds no rows and may skip rendering a cursor move. An open DEC 2026
        // update still waits for the render that ends it.
        write("", () => {
          if (!term.modes.synchronizedOutputMode) schedule();
          callback?.();
        });
      });
      return;
    }
    // libghostty takes Kitty pictures but not iTerm2 or sixel ones: when xterm draws one (Pictures in the terminal),
    // its cursor moves past the picture and libghostty's would not, so the text after it would sit on other rows.
    // xterm draws the pane from that picture on (#2980)
    if (!disposed && pictureIn?.(data) && terminalDrawsPictures(term)) overlay.dispose();
    if (!disposed) {
      try {
        vt.write(data);
        written = true;
      } catch (error) {
        console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
        overlay.dispose();
      }
    }
    write(data, callback);
  }) as Terminal["write"];
  // with `only` xterm keeps no history: a wheel, a swipe or a jump to the newest rows moves libghostty's view
  const { scrollLines, scrollToBottom } = term;
  const moveView = (rows: number): void => {
    if (rows === fromBottom) return;
    fromBottom = rows;
    schedule();
    term.element?.dispatchEvent(new Event(GHOSTTY_VIEW_EVENT));
  };
  if (only) {
    ownView(term, () => fromBottom);
    term.scrollLines = (amount: number) => moveView(Math.max(0, Math.min(Math.min(vt.history().scrollback, vt.scrollback), fromBottom - amount)));
    term.scrollToBottom = () => moveView(0);
  }
  const reset = term.reset.bind(term);
  // a wheel over history this terminal keeps scrolls xterm's own viewport, which with `only` holds no rows: it
  // moves libghostty's view instead, as far as xterm's would (a line a line, or the pixels of one row)
  let wheelPixels = 0;
  const onWheel = (event: WheelEvent): void => {
    if (disposed || wheelPansGrid(event) || (term.options.scrollback ?? 0) === 0 || term.buffer.active.type === "alternate" || term.modes.mouseTrackingMode !== "none") return;
    wheelPixels += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * cellH : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * cellH * term.rows : event.deltaY;
    const lines = cellH > 0 ? Math.trunc(wheelPixels / cellH) : 0;
    if (lines === 0) return;
    wheelPixels -= lines * cellH;
    term.scrollLines(lines);
  };
  if (only) host.addEventListener("wheel", onWheel, { passive: true });
  const restoreTerm = (): void => {
    if (only) host.removeEventListener("wheel", onWheel);
    term.write = write;
    term.reset = reset;
    if (only) {
      Object.assign(term, { scrollLines, scrollToBottom });
      ownView(term, null);
      term.element?.dispatchEvent(new Event(GHOSTTY_VIEW_EVENT));
    }
  };
  term.reset = () => {
    if (!disposed) {
      vt.reset();
      decoded.clear();
    }
    kept.length = 0;
    keptBytes = 0;
    heldQuestions.length = 0;
    writeOnly.reset();
    reset();
    pictures?.reset();
  };

  try {
    optionsChanged();
    colors();
    vt.setScrollback(term.options.scrollback ?? 0);
    fit();
    if (!only) {
      for (const chunk of backlog) vt.write(chunk);
      written = backlog.length > 0;
    }
  } catch (error) {
    disposed = true;
    cancelPaint();
    restoreTerm();
    lateFaces.stop();
    layer.remove();
    vt.dispose();
    throw error;
  }
  const refit = (): void => {
    if (disposed) return;
    try {
      fit();
    } catch (error) {
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };
  const subscriptions: IDisposable[] = [
    term.onResize(refit),
    term.onRender(() => schedule()),
    term.onScroll(() => schedule()),
  ];
  // xterm redraws its selection on every step of a drag, and tells onSelectionChange only at the release
  const handleSelectionChanged = renderService?.handleSelectionChanged;
  if (renderService && handleSelectionChanged) {
    renderService.handleSelectionChanged = (start, end, columnSelectMode) => {
      handleSelectionChanged.call(renderService, start, end, columnSelectMode);
      schedule();
    };
  }
  for (const gesture of VIEW_GESTURES) host.addEventListener(gesture, viewMoved, { capture: true, passive: true });
  const screenResize = new ResizeObserver(refit);
  screenResize.observe(screen);

  // xterm still parses every byte (its buffer serves input, selection, search and the input row), but its
  // own rows are hidden under this layer: redrawing them was a third of the cost of a busy pane
  let muted: { renderer: XtermRowRenderer; renderRows: XtermRowRenderer["renderRows"] } | null = null;
  const muteXtermRows = (): void => {
    const renderer = xtermRowRenderer(term);
    if (!renderer || muted?.renderer === renderer) return;
    unmuteXtermRows();
    muted = { renderer, renderRows: renderer.renderRows };
    renderer.renderRows = () => {};
  };
  const unmuteXtermRows = (): void => {
    if (!muted) return;
    muted.renderer.renderRows = muted.renderRows;
    muted = null;
  };
  muteXtermRows();

  host.dataset["renderer"] = "ghostty";
  // libghostty has every byte xterm was given by now, and each later one before xterm parses it
  // A read that fails gives the terminal back to xterm, which has every byte too: a reader runs in xterm's write
  // callback, where a throw would leave the output behind it queued
  const readFailed = (error: unknown): void => {
    console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
    overlay.dispose();
  };
  const heldRows = (): ScreenRows | null => {
    if (disposed) return null;
    try {
      const rows = ghosttyRows(vt);
      // xterm's line, read into xterm's own cells: a reader may hold one of libghostty's cells as its scratch
      const xtermLine = (y: number): ScreenLine | undefined => {
        const line = term.buffer.active.getLine(y);
        return line && { isWrapped: line.isWrapped, length: line.length, translateToString: (trimRight?: boolean, start?: number, end?: number) => line.translateToString(trimRight, start, end), getCell: (x: number) => line.getCell(x) };
      };
      return {
        ...rows,
        getLine: (y) => {
          if (disposed) return xtermLine(y);
          try {
            const line = rows.getLine(y);
            if (!line) return line;
            // a line's styled cells are read when first asked: a failure there falls back the same way
            return {
              ...line,
              getCell: (x, cell) => {
                if (!disposed) {
                  try { return line.getCell(x, cell); } catch (error) { readFailed(error); }
                }
                return xtermLine(y)?.getCell(x);
              },
            };
          } catch (error) {
            readFailed(error);
            return xtermLine(y);
          }
        },
      };
    } catch (error) {
      readFailed(error);
      return null;
    }
  };
  holdScreenRows(term, heldRows, only);
  const releaseSelection = holdSelection(term);
  const overlay: GhosttyOverlay = {
    dispose: (handOver = true) => {
      if (disposed) return;
      disposed = true;
      cancelPaint();
      delete host.dataset["renderer"];
      holdScreenRows(term, null);
      releaseSelection();
      unmuteXtermRows();
      term.refresh(0, term.rows - 1);
      restoreTerm();
      // Reset in parse order, behind the last controls xterm was sent and ahead of any discarded frame's callback.
      // CAN aborts an unfinished OSC before RIS; ESC alone would dispatch the OSC.
      if (only && handOver) write("\x18\x1bc" + fallbackOutput(kept, currentQuestions(heldQuestions)));
      pictures?.reset();
      kept.length = 0;
      heldQuestions.length = 0;
      for (const subscription of subscriptions) subscription.dispose();
      if (renderService && handleSelectionChanged) renderService.handleSelectionChanged = handleSelectionChanged;
      screenResize.disconnect();
      for (const gesture of VIEW_GESTURES) host.removeEventListener(gesture, viewMoved, { capture: true });
      lateFaces.stop();
      layer.remove();
      decoded.clear();
      vt.dispose();
    },
  };
  if (pictures) {
    const frames = backlog.map((data) => ({ data, sent: data.length }));
    for (const frame of frames) keep(frame);
    for (const frame of frames) {
      if (disposed) break;
      pictures.write(frame.data, emitOnly(frame, true), () => {
        replayRemaining--;
        if (!disposed) {
          if (replayRemaining === 0) finishStartup();
          schedule();
        }
      });
    }
  }
  return overlay;
}
