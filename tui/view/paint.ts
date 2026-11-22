import { STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type EngineCursor, type WrittenColor } from "../emulator/index.ts";
import { holds, intersect, type Rect } from "./geometry.ts";
import { Grid, STYLE_BLINK, STYLE_OVERLINE, Styles, type PaneGrid, type Style } from "./grid.ts";
import { hostLayout, type HostLayout } from "./host-layout.ts";

/** What a cell of the hit map belongs to: a pane, or a part of the chrome or an overlay (`id` "" for the part as a whole). */
export type HitTarget = { pane: string } | { part: string; id: string };
export interface Hit { rect: Rect; target: HitTarget }

/** The hit rectangles of one frame, in drawing order: a later one lies on top. */
export class HitMap {
  constructor(readonly hits: readonly Hit[]) {}

  at(col: number, row: number): HitTarget | null {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const hit = this.hits[i]!;
      if (holds(hit.rect, col, row)) return hit.target;
    }
    return null;
  }
}

/** How a part of the chrome or an overlay draws: screen cells, clipped to the part's rectangle. */
export interface Canvas {
  readonly rect: Rect;
  style(style: Partial<Style>): number;
  /** one cell; a wide one that does not fit becomes a blank, and control characters are drawn as U+FFFD */
  put(col: number, row: number, text: string, width: 1 | 2, style: number): void;
  /** text from (col, row) on, one grapheme per cell at its width; answers the column after the last cell drawn */
  print(col: number, row: number, text: string, style: number): number;
  fill(style: number, text?: string): void;
  hit(rect: Rect, id: string): void;
}

/** A part of the chrome or an overlay. A chrome part is drawn again when its `version` changes; an overlay on every frame. */
export interface Part {
  key: string;
  rect: Rect;
  version: string | number;
  draw(canvas: Canvas): void;
}

/** A pane as the frame shows it. */
export interface PaneScene {
  id: string;
  /** the screen cells the pane's terminal shows in (inside its border) */
  rect: Rect;
  grid: PaneGrid;
  /** the terminal cell drawn at the rectangle's top-left, when the terminal is larger than its cells on screen */
  view?: { col: number; row: number };
  /** its attach is Live (first paint complete) */
  live: boolean;
  /** inside the program's own synchronized update */
  hold: boolean;
  /** showing history above the screen */
  scrolledBack: boolean;
}

export interface Scene {
  width: number;
  height: number;
  /** the chrome, drawn first */
  parts: readonly Part[];
  panes: readonly PaneScene[];
  /** drawn last, on top of everything */
  overlays: readonly Part[];
  /** the pane the user drives */
  focus: string | null;
  /** who owns typing besides the focused pane: an overlay's text field at a cell, an overlay without one, or nobody */
  input: { col: number; row: number } | "overlay" | null;
}

export type CursorShape = "block" | "underline" | "bar";
export interface HostCursor { col: number; row: number; visible: boolean; shape: CursorShape; blinking: boolean }

export interface Frame {
  /** the one write of this frame; empty when nothing changed */
  bytes: Uint8Array;
  hits: HitMap;
  cursor: HostCursor;
  /** every cell is written: the first frame, a new size, or the frame after a write that was not taken whole */
  full: boolean;
}

export interface PainterOptions {
  /** the host answered DECRQM 2026 at start: each frame is bracketed by `CSI ?2026h` and `CSI ?2026l` */
  sync: boolean;
  /** what the host shows (tui/host `colorDepth`): on a 256-colour host an RGB colour is written as its nearest palette index */
  colors?: ColorDepth;
}

/** the colours a host shows: RGB as written, or the 256 of its palette */
export type ColorDepth = "truecolor" | "256";

const ESC = "\x1b";
const CAN = "\x18";
const cup = (row: number, col: number): string => `${ESC}[${row + 1};${col + 1}H`;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

const SHAPES: Record<CursorShape, [blink: number, steady: number]> = { block: [1, 2], underline: [3, 4], bar: [5, 6] };

/** the six levels of each channel in the xterm-256 colour cube (indexes 16-231) */
const CUBE = [0, 95, 135, 175, 215, 255];

/** The xterm-256 index nearest to an RGB colour: the nearest cube colour or grey (232-255), by squared distance. */
export function nearest256([r, g, b]: readonly [number, number, number]): number {
  const level = (value: number) => CUBE.reduce((best, step, at) => Math.abs(step - value) < Math.abs(CUBE[best]! - value) ? at : best, 0);
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const distance = (x: number, y: number, z: number) => (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
  const g8 = 8 + grey * 10;
  return distance(CUBE[cr]!, CUBE[cg]!, CUBE[cb]!) <= distance(g8, g8, g8) ? 16 + 36 * cr + 6 * cg + cb : 232 + grey;
}

function colorSgr(color: WrittenColor, base: 30 | 40, colors: ColorDepth): string {
  if (typeof color !== "number") return colors === "256" ? `${base + 8};5;${nearest256(color)}` : `${base + 8};2;${color[0]};${color[1]};${color[2]}`;
  if (color < 8) return `${base + color}`;
  if (color < 16) return `${base + 60 + color - 8}`;
  return `${base + 8};5;${color}`;
}

function sgrOf(style: Style, colors: ColorDepth): string {
  const codes = ["0"];
  const { flags } = style;
  if (flags & STYLE_BOLD) codes.push("1");
  if (flags & STYLE_FAINT) codes.push("2");
  if (flags & STYLE_ITALIC) codes.push("3");
  const underline = (flags & STYLE_UNDERLINE_MASK) >> 8;
  if (underline === 1) codes.push("4");
  else if (underline > 1) codes.push(`4:${underline}`);
  if (flags & STYLE_BLINK) codes.push("5");
  if (flags & STYLE_INVERSE) codes.push("7");
  if (flags & STYLE_INVISIBLE) codes.push("8");
  if (flags & STYLE_STRIKE) codes.push("9");
  if (flags & STYLE_OVERLINE) codes.push("53");
  if (style.fg !== null) codes.push(colorSgr(style.fg, 30, colors));
  if (style.bg !== null) codes.push(colorSgr(style.bg, 40, colors));
  return `${ESC}[${codes.join(";")}m`;
}

/** columns written again after a non-ASCII cell: what a host that draws an emoji sequence as two emoji can spill into */
const REWRITTEN_AFTER = 2;

const isPlainAscii = (text: string): boolean => text.length === 1 && text.charCodeAt(0) >= 0x20 && text.charCodeAt(0) < 0x7f;

interface Pending { rows: number[] | "all"; cursor: HostCursor }

/**
 * The frame painter (steps 3 to 8 of a frame pass): composes the next screen from the chrome, the panes' grids and the
 * overlays, diffs it against what the host shows, and answers the one write that brings the host there. It writes nowhere,
 * reads no clock and calls no emulator: the caller copies the panes' frames in first (`PaneGrid.copy`), writes the bytes,
 * and reports through `taken` whether the host took the write whole.
 */
export class Painter {
  /** the screen as the chrome, the panes and the overlays draw it, before any cell the host cannot draw is blanked */
  private composed = new Grid(0, 0);
  /** what the host shows once the last frame's write is taken: the composed screen as the host can draw it (fitHost) */
  private next = new Grid(0, 0);
  /** what the host shows, as far as the painter knows */
  private prev = new Grid(0, 0);
  private prevValid = false;
  private touched = new Uint8Array(0);
  private layout: string | null = null;
  private readonly versions = new Map<string, string | number>();
  private readonly partHits = new Map<string, Hit[]>();
  private written: HostCursor | null = null;
  private shape: string | null = null;
  private cut = false;
  private pending: Pending | null = null;

  /**
   * `styles` is the table the panes' grids were filled through; a painter shares it to read their cells. `host` answers how a
   * host lays cells and chrome text out.
   */
  constructor(private readonly options: PainterOptions, readonly styles: Styles = new Styles(), private readonly host: HostLayout = hostLayout) {}

  get screen(): Grid {
    return this.next;
  }

  paint(scene: Scene): Frame {
    if (this.pending) this.taken(false);
    const width = Math.max(0, Math.floor(scene.width));
    const height = Math.max(0, Math.floor(scene.height));
    if (width !== this.next.cols || height !== this.next.rows) {
      this.composed = new Grid(width, height);
      this.next = new Grid(width, height);
      this.prev = new Grid(width, height);
      this.touched = new Uint8Array(height);
      this.prevValid = false;
      this.layout = null;
    }
    const layout = layoutKey(scene);
    const full = layout !== this.layout;
    this.layout = layout;
    if (full) {
      this.composed.clear();
      this.touched.fill(1);
      this.versions.clear();
      this.partHits.clear();
    }

    const screen: Rect = { x: 0, y: 0, width, height };
    const hits: Hit[] = [];
    // a part drawn again blanks its rectangle first: what lies over it there (a later part, a pane's rows) is drawn again too
    const redrawn: Rect[] = [];
    for (const part of scene.parts) {
      const clip = intersect(part.rect, screen);
      const redraw = full || this.versions.get(part.key) !== part.version || redrawn.some((rect) => intersect(rect, clip).width > 0);
      this.drawPart(part, clip, hits, redraw);
      if (redraw && !full && clip.width > 0) redrawn.push(clip);
    }
    for (const pane of scene.panes) this.drawPane(pane, screen, hits, full, redrawn);
    for (const overlay of scene.overlays) this.drawPart(overlay, intersect(overlay.rect, screen), hits, true);
    this.fitHost();

    const rows = this.prevValid ? [...this.touched.keys()].filter((row) => this.touched[row]) : "all";
    const cells = this.diff(rows === "all" ? null : rows);
    this.touched.fill(0);
    const cursor = this.cursorOf(scene, screen);
    const bytes = this.bytes(cells, cursor);
    this.pending = { rows, cursor };
    return { bytes, hits: new HitMap(hits), cursor, full: rows === "all" };
  }

  /**
   * Step 8: whether the host took the last frame's write whole. Only then does the painter count it as shown; otherwise the
   * next frame starts with CAN (ending any sequence the cut write left open) and writes every cell. A frame painted before
   * this was called counts as not taken.
   */
  taken(whole: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (!whole) {
      this.prevValid = false;
      this.written = null;
      this.shape = null;
      this.cut = true;
      return;
    }
    if (pending.rows === "all") for (let row = 0; row < this.next.rows; row++) this.prev.copyRow(this.next, row);
    else for (const row of pending.rows) this.prev.copyRow(this.next, row);
    this.prevValid = true;
    this.written = pending.cursor;
    if (pending.cursor.visible) this.shape = `${pending.cursor.shape} ${pending.cursor.blinking}`;
    this.cut = false;
  }

  /** the host's screen can no longer be trusted (another program drew on it, or a host lost it): the next frame writes every cell */
  invalidate(): void {
    this.pending = null;
    this.prevValid = false;
    this.written = null;
    this.shape = null;
  }

  /** one cell of the composed screen, keeping wide cells whole: a wide cell half covered by this one becomes a blank */
  private put(col: number, row: number, text: string, width: 1 | 2, style: number): void {
    const grid = this.composed;
    const i = row * grid.cols + col;
    if (grid.width[i] === 0 && col > 0) this.blankAt(grid, i - 1);
    const last = i + width - 1;
    if (grid.width[last] === 2 && col + width < grid.cols) this.blankAt(grid, last + 1);
    grid.text[i] = text;
    grid.width[i] = width;
    grid.style[i] = style;
    if (width === 2) {
      grid.text[i + 1] = "";
      grid.width[i + 1] = 0;
      grid.style[i + 1] = style;
    }
    this.touched[row] = 1;
  }

  private blankAt(grid: Grid, i: number): void {
    grid.text[i] = " ";
    grid.width[i] = 1;
    grid.style[i] = this.styles.blank(grid.style[i]!);
  }

  private drawPart(part: Part, clip: Rect, hits: Hit[], redraw: boolean): void {
    hits.push({ rect: clip, target: { part: part.key, id: "" } });
    if (!redraw) {
      hits.push(...(this.partHits.get(part.key) ?? []));
      return;
    }
    const own: Hit[] = [];
    const canvas = this.canvas(part.key, clip, own);
    canvas.fill(0);
    part.draw(canvas);
    this.versions.set(part.key, part.version);
    this.partHits.set(part.key, own);
    hits.push(...own);
  }

  private canvas(key: string, clip: Rect, own: Hit[]): Canvas {
    const put = (col: number, row: number, text: string, width: 1 | 2, style: number): void => {
      if (!holds(clip, col, row)) return;
      const clean = text === "" ? " " : text.replace(CONTROL, "\ufffd");
      if (width === 2 && !holds(clip, col + 1, row)) this.put(col, row, " ", 1, this.styles.blank(style));
      else this.put(col, row, clean, width, style);
    };
    return {
      rect: clip,
      style: ({ fg = null, bg = null, flags = 0 }) => this.styles.id(fg, bg, flags),
      put,
      print: (col, row, text, style) => {
        const laid = this.host.layout(text.replace(CONTROL, "\ufffd"));
        for (const cell of laid.cells) put(col + cell.col, row, cell.text, cell.width, style);
        return col + laid.end;
      },
      fill: (style, text = " ") => {
        for (let row = clip.y; row < clip.y + clip.height; row++) for (let col = clip.x; col < clip.x + clip.width; col++) put(col, row, text, 1, style);
      },
      hit: (rect, id) => {
        const inside = intersect(rect, clip);
        if (inside.width > 0) own.push({ rect: inside, target: { part: key, id } });
      },
    };
  }

  /**
   * A pane's rows through its view offset, clipped to its rectangle: every row on a full frame, else the rows its frames
   * changed and the rows a part drawn again in this frame blanked.
   */
  private drawPane(pane: PaneScene, screen: Rect, hits: Hit[], full: boolean, redrawn: readonly Rect[]): void {
    const clip = intersect(pane.rect, screen);
    hits.push({ rect: clip, target: { pane: pane.id } });
    const source = pane.grid;
    const view = pane.view ?? { col: 0, row: 0 };
    if (clip.width > 0) {
      const rows = new Set(full || source.allDirty ? range(clip.y, clip.y + clip.height) : [...source.dirty].map((gy) => pane.rect.y + gy - view.row));
      for (const rect of redrawn) {
        const under = intersect(rect, clip);
        for (let row = under.y; row < under.y + under.height; row++) rows.add(row);
      }
      for (const row of rows) if (row >= clip.y && row < clip.y + clip.height) this.drawPaneRow(pane, clip, view, row);
    }
    source.dirty.clear();
    source.allDirty = false;
  }

  private drawPaneRow(pane: PaneScene, clip: Rect, view: { col: number; row: number }, row: number): void {
    const grid = pane.grid.grid;
    const gy = row - pane.rect.y + view.row;
    const right = clip.x + clip.width;
    for (let col = clip.x; col < right; col++) {
      const gx = col - pane.rect.x + view.col;
      if (gy < 0 || gy >= grid.rows || gx < 0 || gx >= grid.cols) {
        this.put(col, row, " ", 1, 0);
        continue;
      }
      const i = gy * grid.cols + gx;
      const width = grid.width[i]!;
      const style = grid.style[i]!;
      if (width === 0) {
        // the covered column of a wide cell whose first column lies left of the clip
        if (col === clip.x) this.put(col, row, " ", 1, this.styles.blank(style));
        continue;
      }
      if (width === 2 && col + 1 >= right) {
        this.put(col, row, " ", 1, this.styles.blank(style));
        continue;
      }
      this.put(col, row, grid.text[i]!, width as 1 | 2, style);
    }
  }

  /**
   * Each row this frame touched is taken from the composed screen again, and a cell the host cannot draw where it is becomes
   * a blank there, so the host and the model agree. The blank is the shown screen's alone: once the cell's left neighbour
   * changes, the composed cell is asked again, as a fresh paint would ask it. Whether a cell lands as itself is asked of the
   * host layout, for that cell after its left neighbour at its column (first, last, or on a screen one column wide): it
   * catches a cell the host joins to its left neighbour (a mark with no base, a lone leading jamo, a cell ending in ZWJ before
   * an emoji) and one it wraps (an emoji narrowed by U+FE0E in the last column). Only two plain ASCII cells side by side are
   * never asked.
   */
  private fitHost(): void {
    const grid = this.next;
    for (let row = 0; row < grid.rows; row++) {
      if (!this.touched[row]) continue;
      grid.copyRow(this.composed, row);
      const start = row * grid.cols;
      for (let col = 0; col < grid.cols; col++) {
        const i = start + col;
        const text = grid.text[i]!;
        if (grid.width[i] === 0) continue;
        const leftAt = col === 0 ? -1 : grid.width[i - 1] === 0 ? i - 2 : i - 1;
        const left = leftAt < start ? "" : grid.text[leftAt]!;
        if (isPlainAscii(text) && (left === "" || isPlainAscii(left))) continue;
        if (this.host.fits(left, leftAt < start ? 0 : grid.width[leftAt]!, text, grid.width[i]!, col, grid.cols)) continue;
        const wide = grid.width[i] === 2;
        this.blankAt(grid, i);
        if (wide) this.blankAt(grid, i + 1);
      }
    }
  }

  /**
   * Step 5: the changed cells of the given rows (all rows when null) as runs, each from an absolute position. A host may lay a
   * non-ASCII cell out wider than the model does, or narrow it only after drawing it wide (an emoji with U+FE0E), and leave
   * marks in the next columns: so after one, the next REWRITTEN_AFTER columns are written again even when unchanged.
   */
  private diff(rows: number[] | null): string {
    const { next, prev } = this;
    const cols = next.cols;
    let out = "";
    let sgr = -1;
    for (const row of rows ?? range(0, next.rows)) {
      let at = -1;
      let rewrite = -1;
      const start = row * cols;
      for (let col = 0; col < cols; col++) {
        const i = start + col;
        const width = next.width[i]!;
        if (width === 0) continue;
        if (rows !== null && col >= rewrite && sameCell(next, prev, i) && (width === 1 || sameCell(next, prev, i + 1))) continue;
        if (at !== col) out += cup(row, col);
        const style = next.style[i]!;
        if (style !== sgr) {
          out += sgrOf(this.styles.get(style), this.options.colors ?? "truecolor");
          sgr = style;
        }
        const text = next.text[i]!;
        out += text;
        const plain = width === 1 && isPlainAscii(text);
        at = plain ? col + 1 : -1;
        if (!plain) rewrite = Math.max(rewrite, col + width + REWRITTEN_AFTER);
      }
    }
    if (sgr > 0) out += `${ESC}[0m`;
    return out;
  }

  /** step 6, the cursor rule */
  private cursorOf(scene: Scene, screen: Rect): HostCursor {
    const parked = (col: number, row: number): HostCursor => ({ col, row, visible: false, shape: "block", blinking: false });
    const clamp = (col: number, row: number, rect: Rect): [number, number] => [
      Math.min(Math.max(col, rect.x), rect.x + Math.max(0, rect.width - 1)),
      Math.min(Math.max(row, rect.y), rect.y + Math.max(0, rect.height - 1)),
    ];
    const input = scene.input;
    if (input !== null && input !== "overlay") {
      const [col, row] = clamp(input.col, input.row, screen);
      return { col, row, visible: holds(screen, input.col, input.row), shape: "bar", blinking: false };
    }
    const pane = scene.panes.find(({ id }) => id === scene.focus);
    if (!pane) {
      const last = this.written ?? parked(0, 0);
      const [col, row] = clamp(last.col, last.row, screen);
      return parked(col, row);
    }
    const view = pane.view ?? { col: 0, row: 0 };
    const clip = intersect(pane.rect, screen);
    const cursor: EngineCursor | null = pane.grid.cursor;
    const place = (x: number, y: number): [number, number] => [pane.rect.x + x - view.col, pane.rect.y + y - view.row];
    if (cursor?.visible && input === null && pane.live && !pane.hold && !pane.scrolledBack) {
      const [col, row] = place(cursor.x, cursor.y);
      if (holds(clip, col, row)) {
        const shape = cursor.style === "hollow" ? "block" : cursor.style;
        return { col, row, visible: true, shape, blinking: cursor.blinking };
      }
    }
    const seen = pane.grid.lastSeen ?? { x: 0, y: 0 };
    const [col, row] = clamp(...place(seen.x, seen.y), clip.width > 0 ? clip : screen);
    return parked(col, row);
  }

  /** step 7: the one write */
  private bytes(cells: string, cursor: HostCursor): Uint8Array {
    if (this.next.cols === 0 || this.next.rows === 0) return new Uint8Array(0);
    const last = this.written;
    const shape = `${cursor.shape} ${cursor.blinking}`;
    const moved = !last || last.col !== cursor.col || last.row !== cursor.row || last.visible !== cursor.visible || (cursor.visible && shape !== this.shape);
    if (cells === "" && !moved) return new Uint8Array(0);
    let out = this.cut ? CAN : "";
    if (this.options.sync) out += `${ESC}[?2026h`;
    out += `${ESC}[?25l${cells}${cup(cursor.row, cursor.col)}`;
    if (cursor.visible) {
      if (shape !== this.shape) out += `${ESC}[${SHAPES[cursor.shape][cursor.blinking ? 0 : 1]} q`;
      out += `${ESC}[?25h`;
    }
    if (this.options.sync) out += `${ESC}[?2026l`;
    return new TextEncoder().encode(out);
  }
}

function sameCell(a: Grid, b: Grid, i: number): boolean {
  return a.text[i] === b.text[i] && a.width[i] === b.width[i] && a.style[i] === b.style[i];
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

/** everything whose change makes a frame full: the size and where each part, pane and overlay goes */
function layoutKey(scene: Scene): string {
  const rect = (r: Rect): string => `${r.x},${r.y},${r.width},${r.height}`;
  return [
    `${scene.width}x${scene.height}`,
    ...scene.parts.map((part) => `p ${part.key} ${rect(part.rect)}`),
    ...scene.panes.map((pane) => `t ${pane.id} ${rect(pane.rect)} ${pane.view?.col ?? 0},${pane.view?.row ?? 0} ${pane.grid.grid.cols}x${pane.grid.grid.rows}`),
    ...scene.overlays.map((overlay) => `o ${overlay.key} ${rect(overlay.rect)}`),
  ].join("\n");
}
