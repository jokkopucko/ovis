import { afterAll, describe, expect, test } from "bun:test";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import type { LayoutNode } from "../../server/herdr-core/layout-doc.ts";
import { createEmulator } from "../emulator/ghostty.ts";
import type { Emulator, EngineEvents, WrittenColor } from "../emulator/index.ts";
import { placeholderChrome } from "./chrome.ts";
import { cellsOf, holds, intersect, regions, type Rect } from "./geometry.ts";
import { PaneGrid } from "./grid.ts";
import { hostLayout } from "./host-layout.ts";
import { Painter, type Frame, type HitTarget, type Part, type PaneScene, type Scene } from "./paint.ts";

// The painter's writes are replayed into a second emulator standing in for the host terminal: after a frame whose write was
// taken whole, the host's screen must equal the painter's model cell for cell, and its cursor must be where the rule says.

const encoder = new TextEncoder();
/** `inner` lies inside `outer` (an empty rectangle lies anywhere) */
const inside = (outer: Rect, inner: Rect): boolean => inner.width <= 0 || inner.height <= 0 || JSON.stringify(intersect(outer, inner)) === JSON.stringify(inner);
const decoder = new TextDecoder();
const made: Emulator[] = [];
afterAll(() => {
  for (const emulator of made) emulator.dispose();
});

async function emulator(cols: number, rows: number, events: EngineEvents = {}): Promise<Emulator> {
  const result = await createEmulator({ cols, rows, events });
  if (!result.ok) throw new Error(`emulator ${cols}x${rows}: ${result.error.message}`);
  made.push(result.value);
  return result.value;
}

function feed(target: Emulator, bytes: string | Uint8Array): void {
  const result = target.write(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  if (!result.ok) throw new Error(`write: ${result.error.message}`);
}

/** a host as the screen leaves it after start: on the alternate screen */
async function hostOf(cols: number, rows: number): Promise<Emulator> {
  const host = await emulator(cols, rows);
  feed(host, "\x1b[?1049h");
  return host;
}

interface Cell { text: string; width: number; fg: WrittenColor | null; bg: WrittenColor | null; flags: number }

function hostCells(host: Emulator, cols: number, rows: number): Cell[] {
  const cells: Cell[] = Array.from({ length: cols * rows }, () => ({ text: " ", width: 1, fg: null, bg: null, flags: 0 }));
  const drawn = host.frameAll((y, runs) => {
    for (const run of runs) {
      let x = run.x;
      for (const cell of run.cells) {
        if (x >= cols || y >= rows) break;
        cells[y * cols + x] = { text: cell.text, width: cell.wide ? 2 : 1, fg: run.fg, bg: run.bg, flags: run.flags };
        if (cell.wide && x + 1 < cols) cells[y * cols + x + 1] = { text: "", width: 0, fg: run.fg, bg: run.bg, flags: run.flags };
        x += cell.wide ? 2 : 1;
      }
    }
  });
  if (!drawn.ok) throw new Error(drawn.error.message);
  return cells;
}

function modelCells(painter: Painter): Cell[] {
  const grid = painter.screen;
  return grid.text.map((text, i) => ({ text, width: grid.width[i]!, ...painter.styles.get(grid.style[i]!) }));
}

const sameColor = (a: WrittenColor | null, b: WrittenColor | null): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
const sameCell = (a: Cell, b: Cell): boolean =>
  a.text === b.text && a.width === b.width && a.flags === b.flags && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg);

/** the first cell where the host and the model differ, or null */
function mismatch(host: Emulator, painter: Painter): string | null {
  const { cols, rows } = painter.screen;
  const seen = hostCells(host, cols, rows);
  const want = modelCells(painter);
  for (let i = 0; i < want.length; i++) {
    if (!sameCell(seen[i]!, want[i]!)) {
      return `cell ${i % cols},${Math.floor(i / cols)}: host ${JSON.stringify(seen[i])} model ${JSON.stringify(want[i])}`;
    }
  }
  return null;
}

/** where the host's cursor is: a hidden one is shown for a moment to read its place, then hidden again */
function hostCursor(host: Emulator): { col: number; row: number; visible: boolean; shape: string; blinking: boolean } {
  const read = () => {
    host.frameAll(() => {});
    const cursor = host.cursorState();
    if (!cursor.ok) throw new Error(cursor.error.message);
    return cursor.value;
  };
  const cursor = read();
  if (cursor.visible) return { col: cursor.x, row: cursor.y, visible: true, shape: cursor.style, blinking: cursor.blinking };
  feed(host, "\x1b[?25h");
  const parked = read();
  feed(host, "\x1b[?25l");
  read();
  return { col: parked.x, row: parked.y, visible: false, shape: "block", blinking: false };
}

function expectReplay(host: Emulator, painter: Painter, frame: Frame): void {
  expect(mismatch(host, painter)).toBeNull();
  const cursor = hostCursor(host);
  if (frame.cursor.visible) expect(cursor).toEqual({ ...frame.cursor });
  else expect({ ...cursor, shape: "block", blinking: false }).toEqual({ ...frame.cursor });
}

/** the cells a write addresses, read from its own moves and text (each grapheme takes the model's width at its place) */
function addressed(bytes: Uint8Array, painter: Painter): Set<string> {
  const grid = painter.screen;
  const out = new Set<string>();
  const text = decoder.decode(bytes);
  let row = 0;
  let col = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x18") { i++; continue; }
    if (text[i] === "\x1b") {
      const match = /^\x1b\[([0-9;:? ]*)([A-Za-z])/.exec(text.slice(i, i + 64));
      if (!match) throw new Error(`unknown sequence at ${i}`);
      if (match[2] === "H") {
        const [r = "1", c = "1"] = match[1]!.split(";");
        row = Number(r) - 1;
        col = Number(c) - 1;
      }
      i += match[0].length;
      continue;
    }
    let end = text.indexOf("\x1b", i);
    if (end < 0) end = text.length;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.slice(i, end))) {
      if (segment === "\x18") continue;
      out.add(`${col},${row}`);
      const width = grid.width[row * grid.cols + col] === 2 ? 2 : 1;
      if (width === 2) out.add(`${col + 1},${row}`);
      col += width;
    }
    i = end;
  }
  return out;
}

/** non-ASCII graphemes of a write that are followed by anything but an absolute move (or the write's end) */
function unplaced(bytes: Uint8Array): string[] {
  const text = decoder.decode(bytes);
  const out: string[] = [];
  for (const chunk of text.matchAll(/[^\x1b\x18]+/g)) {
    const after = text.slice(chunk.index + chunk[0].length);
    const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(chunk[0])];
    for (const [i, { segment }] of parts.entries()) {
      if (/^[\x20-\x7e]$/.test(segment)) continue;
      if (i < parts.length - 1 || !/^(?:\x1b\[\d+;\d+H|$)/.test(after)) out.push(segment);
    }
  }
  return out;
}

/** the SGR sequences a full frame needs: one per change of style in writing order, and a reset after a styled last cell */
function styleChanges(painter: Painter): number {
  const grid = painter.screen;
  let changes = 0;
  let last = -1;
  for (let i = 0; i < grid.text.length; i++) {
    if (grid.width[i] === 0) continue;
    if (grid.style[i] !== last) changes++;
    last = grid.style[i]!;
  }
  return changes + (last > 0 ? 1 : 0);
}

interface Shown { emulator: Emulator; grid: PaneGrid; held: { hold: boolean } }

async function shownPane(painter: Painter, cols: number, rows: number, text = ""): Promise<Shown> {
  const held = { hold: false };
  const target = await emulator(cols, rows, { onHold: (hold) => { held.hold = hold; } });
  if (text) feed(target, text);
  const shown = { emulator: target, grid: new PaneGrid(painter.styles, cols, rows), held };
  copy(shown);
  return shown;
}

function copy(shown: Shown): void {
  const result = shown.grid.copy(shown.emulator, shown.grid.allDirty);
  if (!result.ok) throw new Error(result.error.message);
}

function paneScene(id: string, shown: Shown, rect: Rect, extra: Partial<PaneScene> = {}): PaneScene {
  return { id, rect, grid: shown.grid, live: true, hold: shown.held.hold, scrolledBack: false, ...extra };
}

/** one frame: the write handed to the host whole, or only its first `cut` bytes */
function step(painter: Painter, host: Emulator | null, scene: Scene, cut?: number): Frame {
  const frame = painter.paint(scene);
  if (cut === undefined) {
    if (host && frame.bytes.length > 0) feed(host, frame.bytes);
    painter.taken(true);
  } else {
    if (host) feed(host, frame.bytes.subarray(0, cut));
    painter.taken(false);
  }
  return frame;
}

const overlay = (key: string, rect: Rect, text: string): Part => ({
  key, rect, version: 0,
  draw: (canvas) => {
    canvas.fill(canvas.style({ bg: 236 }));
    canvas.print(rect.x + 1, rect.y, text, canvas.style({ fg: 15, bg: 236, flags: 1 }));
    canvas.hit({ x: rect.x + 1, y: rect.y, width: Math.min(rect.width - 1, 4), height: 1 }, "close");
  },
});

const scene = (width: number, height: number, rest: Partial<Scene>): Scene => ({ width, height, parts: [], panes: [], overlays: [], focus: null, input: null, ...rest });

const LINES = [
  "\x1b[1;1H\x1b[31mred\x1b[0m plain \x1b[38;5;208m256\x1b[0m \x1b[38;2;10;200;30mtrue\x1b[0m \x1b[1;4:3mbold-curly\x1b[0m",
  "\x1b[2;1H한글 테스트 漢字 \x1b[7minverse\x1b[0m \x1b[48;5;24m bg \x1b[0m",
  "\x1b[3;1He\u0301 \u{1F469}\u200D\u{1F4BB} \u2764\uFE0F \x1b[9;53mstrike-over\x1b[0m",
].join("");

const span = (from: number, to: number, step = 1): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
/** code points of every Grapheme_Cluster_Break class, and of the width classes around them */
const SWEEP = [...new Set([
  0x20, 0x21, 0x30, 0x41, 0x61, 0x7c, 0x7e,
  ...span(0x1100, 0x115f, 4), 0x115f, ...span(0x1160, 0x11a7, 4), ...span(0x11a8, 0x11ff, 4),
  ...span(0xa960, 0xa97c, 4), ...span(0xd7b0, 0xd7c6, 4), ...span(0xd7cb, 0xd7fb, 6),
  0xac00, 0xac1c, 0xb098, 0xb2e4, 0xb77c, 0xb9c8, 0xbc14, 0xc0ac, 0xc544, 0xc790,
  0xac01, 0xac10, 0xd55c, 0xae00, 0xb2ec, 0xb9ce, 0xc12d, 0xd7a3,
  ...span(0x300, 0x36f, 6), 0x483, 0x591, 0x5b0, 0x610, 0x64b, 0x670, 0x93c, 0x941, 0x94d, 0xe31, 0xe34, 0x1ab0, 0x1dc0, 0x20d0, 0x20dd, 0x20e3, 0x302a, 0x3099, 0xfe20,
  ...span(0x1f3fb, 0x1f3ff), 0xe0020, 0xe0041, 0xe007f, 0x200c, ...span(0xfe00, 0xfe0f), 0xe0100, 0x200d,
  0x903, 0x93e, 0x93f, 0x940, 0x949, 0x94e, 0xe33, 0xeb3, 0x1031, 0x9be, 0xa3e, 0xbbf, 0x102b, 0x1b04,
  ...span(0x600, 0x605), 0x6dd, 0x70f, 0x890, 0x8e2, 0xd4e, 0x110bd, 0x111c2, 0x11a3a,
  ...span(0x1f1e6, 0x1f1ff),
  0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x231a, 0x2328, 0x23cf, 0x23e9, 0x25aa, 0x2600, 0x2614, 0x2639, 0x263a, 0x2640, 0x2642,
  0x2660, 0x2665, 0x2696, 0x26a1, 0x26bd, 0x2702, 0x2705, 0x2728, 0x2764, 0x27a1, 0x2b50, 0x3030, 0x303d, 0x3297, 0x1f004, 0x1f0cf,
  0x1f170, 0x1f300, 0x1f308, 0x1f377, 0x1f3c3, 0x1f408, 0x1f44d, 0x1f466, 0x1f467, 0x1f468, 0x1f469, 0x1f4bb, 0x1f600, 0x1f602,
  0x1f60d, 0x1f62d, 0x1f680, 0x1f6d2, 0x1f90c, 0x1f9d1, 0x1fae0, 0x1f9d1,
  0x4e00, 0x3042, 0x30a2, 0xff21, 0x3000, 0x20000, 0xe9, 0x3b1, 0x416, 0x627, 0x5d0, 0xe01, 0x915, 0x2500, 0x2588, 0xfffd,
  0xad, 0x200b, 0x200e, 0x2060, 0xfeff, 0x61c,
])];

/** pieces of chrome text whose width a host and a width table may see differently */
const ATOMS = ["\u26BD\uFE0E", "\u26BD", "\u2764\uFE0F", "\u2764", "a\uFE0F", "\u{1F1FA}", "\u{1F1F0}\u{1F1F7}", "\uD55C", "\u1100", "\u1100\u1161", "e\u0301", "\u0301", "\u{1F469}\u200D\u{1F4BB}", "\u{1F600}\u200D", "\u{1F44D}\u{1F3FD}", "x", " ", "\u6F22", "\u200B", "\u0600a", "ab"];
function chromeText(next: () => number): string {
  return Array.from({ length: 1 + Math.floor(next() * 8) }, () => ATOMS[Math.floor(next() * ATOMS.length)]!).join("");
}

describe("the frame painter", () => {
  test("replay equals model", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [100, 20];
    const shape = regions(W, H, { sidebar: 18, tabBar: true, modeBar: true });
    const tree: LayoutNode = { split: "right", ratio: 0.5, first: { leaf: "a" }, second: { leaf: "b" } };
    const { panes } = cellsOf(tree, shape.panes);
    const [a, b] = await Promise.all(panes.map((cells) => shownPane(painter, cells.cols, cells.rows, LINES)));
    const host = await hostOf(W, H);
    const build = (overlays: Part[]): Scene => scene(W, H, {
      parts: placeholderChrome(shape, panes), overlays, focus: "a",
      panes: [paneScene("a", a!, panes[0]!.inner), paneScene("b", b!, panes[1]!.inner)],
    });
    const help = overlay("help", { x: 30, y: 6, width: 30, height: 5 }, "도움말 help ✓");

    let frame = step(painter, host, build([help]));
    expect(frame.full).toBe(true);
    expectReplay(host, painter, frame);

    feed(a!.emulator, "\x1b[4;1Hmore 한 line\r\n".repeat(30));
    copy(a!);
    frame = step(painter, host, build([help]));
    expect(frame.full).toBe(false);
    expect(frame.bytes.length).toBeGreaterThan(0);
    expectReplay(host, painter, frame);

    frame = step(painter, host, build([]));
    expectReplay(host, painter, frame);

    feed(b!.emulator, "\x1b[2J\x1b[5;3H\x1b[42m카드 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\x1b[0m");
    copy(b!);
    frame = step(painter, host, build([]));
    expectReplay(host, painter, frame);
  });

  test("diff equals full", async () => {
    const [W, H] = [70, 14];
    const steps = [
      LINES,
      "\x1b[5;5H\x1b[33mchanged 한\x1b[0m",
      "\x1b[1;1H\x1b[2K\x1b[1;40H\u{1F469}\u200D\u{1F4BB}e\u0301",
      "\r\n".repeat(20) + "scrolled \u2764\uFE0F",
      "\x1b[3;3H\x1b[38;2;1;2;3;48;5;200mx\x1b[0m\x1b[?25l",
      "\x1b[?25h\x1b[6;10H\x1b[5 q",
    ];
    const painter = new Painter({ sync: true });
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 52, 14);
    for (const [i, bytes] of steps.entries()) {
      feed(shown.emulator, bytes);
      copy(shown);
      const now = scene(W, H, { focus: "p", panes: [paneScene("p", shown, { x: 10, y: 1, width: 50, height: 12 }, { view: { col: 1, row: 2 } })] });
      const frame = step(painter, host, now);
      expectReplay(host, painter, frame);
      // the same state drawn from nothing, by a new painter on a new host, every cell written
      const fresh = new Painter({ sync: true }, painter.styles);
      const freshHost = await hostOf(W, H);
      const whole = step(fresh, freshHost, now);
      expect(whole.full).toBe(true);
      expect(hostCells(host, W, H)).toEqual(hostCells(freshHost, W, H));
      expect(hostCursor(host)).toEqual(hostCursor(freshHost));
      if (i > 0) expect(frame.bytes.length).toBeLessThan(whole.bytes.length);
    }
  });

  test("one bracketed write", async () => {
    for (const sync of [true, false]) {
      const painter = new Painter({ sync });
      const host = await hostOf(40, 8);
      const shown = await shownPane(painter, 30, 6, `${LINES}\x1b[2;4H`);
      const build = () => scene(40, 8, { focus: "p", panes: [paneScene("p", shown, { x: 2, y: 1, width: 30, height: 6 })] });
      const frame = step(painter, host, build());
      const text = decoder.decode(frame.bytes);
      const open = "\x1b[?2026h";
      const close = "\x1b[?2026l";
      if (sync) {
        expect(text.startsWith(`${open}\x1b[?25l`)).toBe(true);
        expect(text.endsWith(`\x1b[?25h${close}`)).toBe(true);
        expect(text.split(open).length - 1).toBe(1);
        expect(text.split(close).length - 1).toBe(1);
      } else {
        expect(text.includes("2026")).toBe(false);
        expect(text.startsWith("\x1b[?25l")).toBe(true);
        expect(text.endsWith("\x1b[?25h")).toBe(true);
      }
      // SGR only where the style changes
      expect(text.match(/\x1b\[[0-9;:]*m/g)?.length).toBe(styleChanges(painter));
      // the cursor is hidden before the first cell and shown only at the end
      expect(text.indexOf("\x1b[?25l")).toBeLessThan(text.indexOf("red"));
      expect(text.indexOf("\x1b[?25h")).toBe(text.lastIndexOf("\x1b[?25h"));
      expectReplay(host, painter, frame);

      // nothing changed: nothing is written
      expect(step(painter, host, build()).bytes.length).toBe(0);

      // only the cursor moved: one write with no cell in it
      feed(shown.emulator, "\x1b[5;9H");
      copy(shown);
      const moved = step(painter, host, build());
      const movedText = decoder.decode(moved.bytes);
      expect(movedText).toBe(`${sync ? open : ""}\x1b[?25l\x1b[6;11H\x1b[?25h${sync ? close : ""}`);
      expectReplay(host, painter, moved);
    }
  });

  test("clip", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [50, 14];
    const host = await hostOf(W, H);
    const rect = { x: 5, y: 2, width: 20, height: 8 };
    const view = { col: 6, row: 3 };
    const shown = await shownPane(painter, 40, 16, Array.from({ length: 16 }, (_, row) => `\x1b[${row + 1};1H${String.fromCharCode(65 + row).repeat(40)}`).join(""));
    const cover = { x: 15, y: 4, width: 20, height: 3 };
    const build = () => scene(W, H, {
      focus: "p", panes: [paneScene("p", shown, rect, { view })],
      parts: [{ key: "frame", rect: { x: 0, y: 0, width: W, height: H }, version: 0, draw: (canvas) => canvas.fill(canvas.style({ fg: 2 }), ":") }],
      overlays: [overlay("menu", cover, "menu")],
    });
    // the pane's own rows show through its view offset
    let frame = step(painter, host, build());
    expectReplay(host, painter, frame);
    expect(painter.screen.text[rect.y * W + rect.x]).toBe(String.fromCharCode(65 + view.row));

    // every row of the pane changes; only its cells outside the overlay may be written
    feed(shown.emulator, Array.from({ length: 16 }, (_, row) => `\x1b[${row + 1};1H${String.fromCharCode(97 + row).repeat(40)}`).join(""));
    copy(shown);
    frame = step(painter, host, build());
    const cells = addressed(frame.bytes, painter);
    expect(cells.size).toBeGreaterThan(0);
    for (const cell of cells) {
      const [col, row] = cell.split(",").map(Number) as [number, number];
      expect({ cell, inPane: holds(rect, col, row), underOverlay: holds(cover, col, row) }).toEqual({ cell, inPane: true, underOverlay: false });
    }
    expectReplay(host, painter, frame);
  });

  test("wide and combining", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [24, 6];
    const host = await hostOf(W, H);
    const text = "\x1b[1;1H한글\u{1F469}\u200D\u{1F4BB}e\u0301x\x1b[2;1Habc한글\x1b[3;1He\u0301한x";
    const left = await shownPane(painter, 12, 3, text);
    const right = await shownPane(painter, 12, 3, text);
    const leftRect = { x: 2, y: 1, width: 7, height: 3 };
    const rightRect = { x: 12, y: 1, width: 5, height: 3 };
    const build = () => scene(W, H, {
      focus: "l",
      parts: [{ key: "ground", rect: { x: 0, y: 0, width: W, height: H }, version: 0, draw: (canvas) => canvas.fill(canvas.style({ fg: 5 }), "#") }],
      panes: [paneScene("l", left, leftRect, { view: { col: 1, row: 0 } }), paneScene("r", right, rightRect)],
    });
    const frames = [step(painter, host, build())];
    const grid = painter.screen;
    const at = (col: number, row: number) => ({ text: grid.text[row * W + col], width: grid.width[row * W + col] });
    // the left clip edge cuts 한 in two: its visible half is a blank, and everything right of it is where the pane has it
    expect(at(2, 1)).toEqual({ text: " ", width: 1 });
    expect([at(3, 1), at(5, 1), at(7, 1), at(8, 1)]).toEqual([{ text: "글", width: 2 }, { text: "\u{1F469}\u200D\u{1F4BB}", width: 2 }, { text: "e\u0301", width: 1 }, { text: "x", width: 1 }]);
    expect([at(2, 2), at(3, 2), at(4, 2), at(6, 2), at(8, 2)]).toEqual([{ text: "b", width: 1 }, { text: "c", width: 1 }, { text: "한", width: 2 }, { text: "글", width: 2 }, { text: " ", width: 1 }]);
    // the right clip edge cuts the emoji: a blank, and the ground right of the pane is untouched
    expect([at(12, 1), at(14, 1), at(16, 1), at(17, 1)]).toEqual([{ text: "한", width: 2 }, { text: "글", width: 2 }, { text: " ", width: 1 }, { text: "#", width: 1 }]);
    expectReplay(host, painter, frames[0]!);
    // every wide or non-ASCII cell is followed by an absolute move, so the host's own width for it cannot shift the rest
    expect(unplaced(frames[0]!.bytes)).toEqual([]);

    // one changed cell between unchanged wide ones: the host keeps every other cell where the model has it
    feed(left.emulator, "\x1b[1;7HE\u0301");
    copy(left);
    frames.push(step(painter, host, build()));
    expect(at(7, 1)).toEqual({ text: "E\u0301", width: 1 });
    expectReplay(host, painter, frames[1]!);
    expect(unplaced(frames[1]!.bytes)).toEqual([]);

    // xterm, the browser's terminal, with its grapheme widths: the same cells and the same cursor column
    const term = new Terminal({ cols: W, rows: H, allowProposedApi: true });
    term.loadAddon(new UnicodeGraphemesAddon());
    term.unicode.activeVersion = "15-graphemes";
    try {
      for (const frame of frames) await new Promise<void>((resolve) => term.write(frame.bytes, resolve));
      const buffer = term.buffer.active;
      for (let row = 0; row < H; row++) {
        const line = buffer.getLine(row)!;
        for (let col = 0; col < W; col++) {
          const want = at(col, row);
          const cell = line.getCell(col)!;
          expect({ col, row, text: want.width === 0 ? "" : cell.getChars() || " ", width: cell.getWidth() }).toEqual({ col, row, text: want.text ?? "", width: want.width ?? -1 });
        }
      }
      const cursor = frames[1]!.cursor;
      expect({ x: buffer.cursorX, y: buffer.cursorY }).toEqual({ x: cursor.col, y: cursor.row });
    } finally {
      term.dispose();
    }

    // a host draws an emoji narrowed by U+FE0E wide first, which marks the column right of it: that column, unchanged in
    // the model, is written again
    const narrowed = new Painter({ sync: true });
    const narrowedHost = await hostOf(8, 1);
    const glyph = (version: number, text: string): Part => ({
      key: "glyph", rect: { x: 0, y: 0, width: 8, height: 1 }, version,
      draw: (canvas) => canvas.put(2, 0, text, 1, canvas.style({ fg: 4, bg: [3, 185, 136], flags: 8 })),
    });
    expectReplay(narrowedHost, narrowed, step(narrowed, narrowedHost, scene(8, 1, { parts: [glyph(0, "X")] })));
    const rewritten = step(narrowed, narrowedHost, scene(8, 1, { parts: [glyph(1, "\u26BD\uFE0E")] }));
    expect(narrowed.screen.text.slice(2, 4)).toEqual(["\u26BD\uFE0E", " "]);
    expectReplay(narrowedHost, narrowed, rewritten);

    // in the screen's last column the same cell would wrap on the host: it is a blank there
    const lastColumn = new Painter({ sync: true });
    const lastHost = await hostOf(8, 2);
    const last = step(lastColumn, lastHost, scene(8, 2, { parts: [{ key: "edge", rect: { x: 0, y: 0, width: 8, height: 2 }, version: 0, draw: (canvas) => canvas.put(7, 0, "\u26BD\uFE0E", 1, 0) }] }));
    expect(lastColumn.screen.text[7]).toBe(" ");
    expectReplay(lastHost, lastColumn, last);

    // an overlay whose edge covers the second column of a wide cell: the wide cell's first column becomes a blank
    const covered = new Painter({ sync: true });
    const coveredHost = await hostOf(10, 1);
    const wide = await shownPane(covered, 6, 1, "\uD55C\uAE00x");
    const cut = step(covered, coveredHost, scene(10, 1, { panes: [paneScene("w", wide, { x: 1, y: 0, width: 6, height: 1 })], overlays: [overlay("o", { x: 2, y: 0, width: 3, height: 1 }, "")] }));
    expect([covered.screen.text[1], covered.screen.width[1]]).toEqual([" ", 1]);
    expectReplay(coveredHost, covered, cut);
  });

  test("cursor", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [40, 12];
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 20, 6, "\x1b[2;4H\x1b[5 q");
    const rect = { x: 5, y: 2, width: 20, height: 6 };
    const frameOf = (extra: Partial<PaneScene>, rest: Partial<Scene> = {}): Record<string, unknown> => {
      const frame = step(painter, host, scene(W, H, { focus: "p", panes: [paneScene("p", shown, rect, extra)], ...rest }));
      expectReplay(host, painter, frame);
      return { ...frame.cursor };
    };
    // the focused pane's cursor through its rectangle, with the shape the program chose
    expect(frameOf({})).toEqual({ col: 8, row: 3, visible: true, shape: "bar", blinking: true });
    // hidden, and parked at the pane's last cursor cell, in a hold, when scrolled back, when not Live, under an overlay
    const parked = { col: 8, row: 3, visible: false, shape: "block", blinking: false };
    expect(frameOf({ hold: true })).toEqual(parked);
    expect(frameOf({ scrolledBack: true })).toEqual(parked);
    expect(frameOf({ live: false })).toEqual(parked);
    expect(frameOf({}, { input: "overlay" })).toEqual(parked);
    // an overlay's text field owns it
    expect(frameOf({}, { input: { col: 30, row: 10 } })).toEqual({ col: 30, row: 10, visible: true, shape: "bar", blinking: false });
    // the program hid it: hidden where it was last seen
    feed(shown.emulator, "\x1b[4;7H\x1b[?25l");
    copy(shown);
    expect(frameOf({})).toEqual(parked);
    feed(shown.emulator, "\x1b[?25h\x1b[2 q");
    copy(shown);
    expect(frameOf({})).toEqual({ col: 11, row: 5, visible: true, shape: "block", blinking: false });
    // outside the clip (the view moved it off): hidden, parked inside the pane's cells
    expect(frameOf({ view: { col: 8, row: 0 } })).toEqual({ col: 5, row: 5, visible: false, shape: "block", blinking: false });
    // no focused pane: hidden where it was
    expect(step(painter, host, scene(W, H, { panes: [paneScene("p", shown, rect)] })).cursor.visible).toBe(false);
  });

  test("baseline", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [60, 10];
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 40, 8, LINES);
    const build = () => scene(W, H, {
      focus: "p", panes: [paneScene("p", shown, { x: 10, y: 1, width: 40, height: 8 })],
      parts: [{ key: "side", rect: { x: 0, y: 0, width: 10, height: H }, version: 0, draw: (canvas) => canvas.fill(canvas.style({ fg: 4 }), ".") }],
    });
    expectReplay(host, painter, step(painter, host, build()));

    // the host takes only part of the next write: it stops inside an escape sequence
    feed(shown.emulator, "\x1b[6;1H\x1b[32mnew text 한글 here\x1b[0m");
    copy(shown);
    const cutFrame = painter.paint(build());
    const cutAt = decoder.decode(cutFrame.bytes).lastIndexOf("\x1b[") + 3;
    feed(host, cutFrame.bytes.subarray(0, cutAt));
    painter.taken(false);

    // so the next frame cancels whatever was left open and writes every cell
    const frame = step(painter, host, build());
    expect(frame.full).toBe(true);
    expect(frame.bytes[0]).toBe(0x18);
    expect(addressed(frame.bytes, painter).size).toBe(W * H);
    expectReplay(host, painter, frame);

    // and after it, frames are small again
    expect(step(painter, host, build()).bytes.length).toBe(0);
  });

  test("resize", async () => {
    const painter = new Painter({ sync: true });
    const host = await hostOf(40, 12);
    const tree: LayoutNode = { split: "down", ratio: 0.5, first: { leaf: "a" }, second: { split: "right", ratio: 0.4, first: { leaf: "b" }, second: { leaf: "c" } } };
    const shown = new Map<string, Shown>();
    for (const id of ["a", "b", "c"]) shown.set(id, await shownPane(painter, 30, 10, LINES));
    const build = (W: number, H: number) => {
      const shape = regions(W, H, { sidebar: 10, tabBar: true, modeBar: true });
      const { panes } = cellsOf(tree, shape.panes);
      return scene(W, H, { focus: "a", parts: placeholderChrome(shape, panes), panes: panes.map((cells) => paneScene(cells.pane, shown.get(cells.pane)!, cells.inner)) });
    };
    expectReplay(host, painter, step(painter, host, build(40, 12)));

    for (const [W, H] of [[30, 8], [90, 30], [10, 3], [1, 1]] as const) {
      const resized = host.resize(W, H, 0, 0);
      expect(resized.ok).toBe(true);
      const frame = step(painter, host, build(W, H));
      expect(frame.full).toBe(true);
      const cells = addressed(frame.bytes, painter);
      for (const cell of cells) {
        const [col, row] = cell.split(",").map(Number) as [number, number];
        expect({ cell, inside: col < W && row < H }).toEqual({ cell, inside: true });
      }
      expect(cells.size).toBe(W * H);
      expectReplay(host, painter, frame);
    }
    const empty = painter.paint(build(0, 0));
    expect(empty.bytes.length).toBe(0);
    expect(painter.screen.text.length).toBe(0);
  });

  test("hit map", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [100, 24];
    const shape = regions(W, H, { sidebar: 20, tabBar: true, modeBar: true });
    const tree: LayoutNode = { split: "right", ratio: 0.6, first: { leaf: "a" }, second: { leaf: "b" } };
    const { panes } = cellsOf(tree, shape.panes);
    const shownPanes = await Promise.all(panes.map((cells) => shownPane(painter, cells.cols, cells.rows, LINES)));
    const parts = placeholderChrome(shape, panes);
    const menu = overlay("menu", { x: 50, y: 8, width: 30, height: 6 }, "menu");
    const build = () => scene(W, H, { focus: "a", parts, overlays: [menu], panes: panes.map((cells, i) => paneScene(cells.pane, shownPanes[i]!, cells.inner)) });
    const screen = { x: 0, y: 0, width: W, height: H };
    const drawnRect = (target: HitTarget): Rect => {
      if ("pane" in target) return panes.find(({ pane }) => pane === target.pane)!.inner;
      return [...parts, menu].find(({ key }) => key === target.part)!.rect;
    };
    const expected = (col: number, row: number): HitTarget | null => {
      if (holds(menu.rect, col, row)) return holds({ x: 51, y: 8, width: 4, height: 1 }, col, row) ? { part: "menu", id: "close" } : { part: "menu", id: "" };
      const pane = panes.find(({ inner }) => holds(inner, col, row));
      if (pane) return { pane: pane.pane };
      const part = [...parts].reverse().find(({ rect }) => holds(rect, col, row));
      if (!part) return null;
      return part.key.startsWith("border") ? { part: part.key, id: "" } : { part: part.key, id: part.key };
    };
    for (const round of [0, 1]) {
      const frame = step(painter, null, build());
      expect(frame.full).toBe(round === 0);
      for (const hit of frame.hits.hits) expect({ hit, inside: inside(drawnRect(hit.target), hit.rect) && inside(screen, hit.rect) }).toEqual({ hit, inside: true });
      const wrong: string[] = [];
      for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
        if (JSON.stringify(frame.hits.at(col, row)) !== JSON.stringify(expected(col, row))) wrong.push(`${col},${row}`);
      }
      expect(wrong).toEqual([]);
    }
  });
});

describe("the frame painter, attempt 2", () => {
  test("chrome redraw keeps panes", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [30, 8];
    const host = await hostOf(W, H);
    const inner = { x: 5, y: 2, width: 20, height: 4 };
    const outer = { x: 4, y: 1, width: 22, height: 6 };
    const shown = await shownPane(painter, 20, 4, LINES);
    const border = (version: number, mark: string): Part => ({
      key: "border", rect: outer, version,
      draw: (canvas) => {
        const style = canvas.style({ fg: version + 1 });
        for (let col = outer.x; col < outer.x + outer.width; col++) { canvas.put(col, outer.y, mark, 1, style); canvas.put(col, outer.y + outer.height - 1, mark, 1, style); }
        for (let row = outer.y; row < outer.y + outer.height; row++) { canvas.put(outer.x, row, mark, 1, style); canvas.put(outer.x + outer.width - 1, row, mark, 1, style); }
      },
    });
    const title: Part = { key: "title", rect: { x: 6, y: 1, width: 10, height: 1 }, version: 0, draw: (canvas) => { canvas.print(6, 1, "title \uD55C", 0); } };
    const menu = overlay("menu", { x: 20, y: 3, width: 9, height: 3 }, "menu");
    const build = (version: number, mark: string) => scene(W, H, { focus: "p", parts: [border(version, mark), title], panes: [paneScene("p", shown, inner)], overlays: [menu] });
    const paneCells = () => {
      const out: string[] = [];
      for (let row = inner.y; row < inner.y + inner.height; row++) for (let col = inner.x; col < inner.x + inner.width; col++) {
        if (!holds(menu.rect, col, row)) out.push(painter.screen.text[row * W + col]!);
      }
      return out.join("");
    };
    expectReplay(host, painter, step(painter, host, build(0, "|")));
    const before = paneCells();
    expect(before).toContain("red");
    // only the border's version changes: the pane wrote nothing and keeps every cell, the title on the border stays
    const frame = step(painter, host, build(1, "#"));
    expect(frame.full).toBe(false);
    expectReplay(host, painter, frame);
    expect(paneCells()).toBe(before);
    expect(painter.screen.text[outer.y * W + outer.x]).toBe("#");
    expect(painter.screen.text.slice(W + 6, W + 11).join("")).toBe("title");
  });

  test("joined cells", async () => {
    // cells a program can leave side by side (it wrote the right one first) that a host would merge when written left to right
    const pairs: [string, string][] = [["\u1100", "\uAC00"], ["\u1100", "\u1100"], ["\u1100", "\u1161"], ["\u{1F600}\u200D", "\u2764"], ["\u{1F1F0}", "\u{1F1F7}"], ["\u{1F44D}", "\u{1F3FD}"], ["\uD55C", "\uAE00"]];
    for (const [left, right] of pairs) {
      const painter = new Painter({ sync: true });
      const host = await hostOf(8, 1);
      const shown = await shownPane(painter, 8, 1, `\x1b[1;5H${right}\x1b[1;3H${left}`);
      expect(shown.grid.grid.text[2]).toBe(left);
      const frame = step(painter, host, scene(8, 1, { panes: [paneScene("p", shown, { x: 0, y: 0, width: 8, height: 1 })] }));
      expect(painter.screen.text[2]).toBe(left);
      expectReplay(host, painter, frame);
    }
  });

  test("one column", async () => {
    for (const text of ["e\u0301", "\u2764\uFE0E", "\u2764\uFE0F", "\uD55C", "\u{1F469}\u200D\u{1F4BB}", "\u{1F1FA}", "x"]) {
      // a 1-column screen showing the first column of a wider pane
      const painter = new Painter({ sync: true });
      const host = await hostOf(1, 2);
      const shown = await shownPane(painter, 4, 2, text);
      expectReplay(host, painter, step(painter, host, scene(1, 2, { panes: [paneScene("p", shown, { x: 0, y: 0, width: 1, height: 2 })] })));
      // a 1-column pane between chrome on a wider screen
      const wider = new Painter({ sync: true });
      const widerHost = await hostOf(5, 2);
      const narrow = await shownPane(wider, 4, 2, text);
      const ground: Part = { key: "ground", rect: { x: 0, y: 0, width: 5, height: 2 }, version: 0, draw: (canvas) => canvas.fill(0, "|") };
      expectReplay(widerHost, wider, step(wider, widerHost, scene(5, 2, { parts: [ground], panes: [paneScene("p", narrow, { x: 2, y: 0, width: 1, height: 2 })] })));
    }
  });

  test("chrome text widths", async () => {
    // the cells of printed text are the host's: an emoji narrowed by U+FE0E takes one, a lone regional indicator two
    const painter = new Painter({ sync: true });
    const [W, H] = [30, 10];
    const host = await hostOf(W, H);
    const line = (version: number, texts: string[], cols: number[]): Part => ({
      key: "line", rect: { x: 0, y: 0, width: W, height: H }, version,
      draw: (canvas) => texts.forEach((text, row) => canvas.print(cols[row]!, row, text, canvas.style({ fg: row % 8 }))),
    });
    expectReplay(host, painter, step(painter, host, scene(W, H, { parts: [line(0, ["\u26BD\uFE0Ex", "\u{1F1FA}x"], [0, 0])] })));
    const cells = (row: number) => [0, 1, 2].map((col) => [painter.screen.text[row * W + col], painter.screen.width[row * W + col]]);
    expect(cells(0)).toEqual([["\u26BD\uFE0E", 1], ["x", 1], [" ", 1]]);
    expect(cells(1)).toEqual([["\u{1F1FA}", 2], ["", 0], ["x", 1]]);
    // 200 strings of emoji, selectors, regional indicators, Korean and marks, at random columns, the last ones among them
    const next = random(20);
    for (let frame = 0; frame < 20; frame++) {
      const texts = Array.from({ length: H }, () => chromeText(next));
      const cols = texts.map(() => (next() < 0.5 ? W - 1 - Math.floor(next() * 6) : Math.floor(next() * W)));
      const drawn = step(painter, host, scene(W, H, { parts: [line(frame + 1, texts, cols)] }));
      const wrong = mismatch(host, painter);
      if (wrong) throw new Error(`frame ${frame} ${JSON.stringify(texts)} at ${JSON.stringify(cols)}: ${wrong}`);
      expectReplay(host, painter, drawn);
    }
  });

  test("invalidate", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [30, 6];
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 24, 4, LINES);
    const build = () => scene(W, H, { focus: "p", panes: [paneScene("p", shown, { x: 3, y: 1, width: 24, height: 4 })] });
    expectReplay(host, painter, step(painter, host, build()));
    // something else drew on the host (as a host may after a focus change): the painter is told, and writes every cell
    feed(host, "\x1b[2J\x1b[3;3H\x1b[41mjunk\x1b[0m");
    painter.invalidate();
    const frame = step(painter, host, build());
    expect(frame.full).toBe(true);
    expect(addressed(frame.bytes, painter).size).toBe(W * H);
    expectReplay(host, painter, frame);
    expect(step(painter, host, build()).bytes.length).toBe(0);
  });
});

describe("pair sweep", () => {
  test(`every ordered pair of ${SWEEP.length} code points in adjacent cells, and each alone at the screen's edges`, async () => {
    expect(SWEEP.length).toBeGreaterThanOrEqual(300);
    const texts = SWEEP.map((cp) => String.fromCodePoint(cp));
    // each code point's width as a cell of its own, read from an emulator
    const probe = await emulator(8, texts.length);
    feed(probe, texts.map((text, row) => `\x1b[${row + 1};3H${text}`).join(""));
    const widths = texts.map(() => 1);
    probe.frameAll((y, runs) => {
      let x = 0;
      for (const run of runs) {
        x = run.x;
        for (const cell of run.cells) {
          if (x === 2 && cell.text === texts[y]) widths[y] = cell.wide ? 2 : 1;
          x += cell.wide ? 2 : 1;
        }
      }
    });

    const [W, H] = [200, 60];
    const painter = new Painter({ sync: false });
    const host = await hostOf(W, H);
    const shown = { emulator: probe, grid: new PaneGrid(painter.styles, W, H), held: { hold: false } };
    const set = (row: number, col: number, text: string, width: number) => {
      const grid = shown.grid.grid;
      const i = row * W + col;
      grid.text[i] = text;
      grid.width[i] = width;
      if (width === 2) { grid.text[i + 1] = ""; grid.width[i + 1] = 0; }
    };
    let [row, col, pairs, frames, kept] = [0, 0, 0, 0, 0];
    const placed: [number, number, string][] = [];
    const flush = () => {
      shown.grid.allDirty = true;
      step(painter, host, scene(W, H, { panes: [paneScene("p", shown, { x: 0, y: 0, width: W, height: H })] }));
      frames++;
      const wrong = mismatch(host, painter);
      if (wrong) throw new Error(`pair frame ${frames}: ${wrong}`);
      for (const [r, c, text] of placed) if (painter.screen.text[r * W + c] === text) kept++;
      placed.length = 0;
      shown.grid.grid.clear();
      [row, col] = [0, 0];
    };
    for (const [a, left] of texts.entries()) {
      for (const [b, right] of texts.entries()) {
        const need = widths[a]! + widths[b]! + 1;
        if (col + need > W) {
          [row, col] = [row + 1, 0];
          if (row === H) flush();
        }
        set(row, col, left, widths[a]!);
        set(row, col + widths[a]!, right, widths[b]!);
        set(row, col + widths[a]! + widths[b]!, "|", 1);
        placed.push([row, col + widths[a]!, right]);
        col += need;
        pairs++;
      }
    }
    flush();

    // each alone: in the first column, in the last column after a letter, and on a screen one column wide
    const edges = new Painter({ sync: false });
    const edgeHost = await hostOf(8, texts.length);
    const edgeGrid = { emulator: probe, grid: new PaneGrid(edges.styles, 8, texts.length), held: { hold: false } };
    for (const [i, text] of texts.entries()) {
      const grid = edgeGrid.grid.grid;
      grid.text[i * 8] = text;
      grid.width[i * 8] = widths[i]!;
      if (widths[i] === 2) { grid.text[i * 8 + 1] = ""; grid.width[i * 8 + 1] = 0; }
      const at = 8 - widths[i]!;
      grid.text[i * 8 + at - 1] = "a";
      grid.text[i * 8 + at] = text;
      grid.width[i * 8 + at] = widths[i]!;
      if (widths[i] === 2) { grid.text[i * 8 + 7] = ""; grid.width[i * 8 + 7] = 0; }
    }
    step(edges, edgeHost, scene(8, texts.length, { panes: [paneScene("p", edgeGrid, { x: 0, y: 0, width: 8, height: texts.length })] }));
    expect(mismatch(edgeHost, edges)).toBeNull();
    const single = new Painter({ sync: false });
    const singleHost = await hostOf(1, texts.length);
    const singleGrid = { emulator: probe, grid: new PaneGrid(single.styles, 1, texts.length), held: { hold: false } };
    texts.forEach((text, i) => { singleGrid.grid.grid.text[i] = text; });
    step(single, singleHost, scene(1, texts.length, { panes: [paneScene("p", singleGrid, { x: 0, y: 0, width: 1, height: texts.length })] }));
    expect(mismatch(singleHost, single)).toBeNull();
    console.log(`pair sweep: ${texts.length} code points, ${pairs} ordered pairs in ${frames} frames replayed equal; ${kept} right cells kept as written, ${pairs - kept} drawn as blanks; ${texts.length} x 3 edge cells equal`);
  }, 120_000);
});

describe("a neighbour's change", () => {
  /** four cases a row, eight columns each: two chrome parts side by side, the left one's text ending where the right one's begins */
  const sideBySide = (cases: { left: string; leftVersion: number; right: string; rightVersion: number }[]): Scene => scene(32, Math.ceil(cases.length / 4), {
    parts: cases.flatMap((one, n) => {
      const [x, y] = [(n % 4) * 8, Math.floor(n / 4)];
      return [
        { key: `l${n}`, rect: { x, y, width: 4, height: 1 }, version: one.leftVersion, draw: (canvas: Parameters<Part["draw"]>[0]) => canvas.print(x + 4 - hostLayout.layout(one.left).end, y, one.left, 0) },
        { key: `r${n}`, rect: { x: x + 4, y, width: 2, height: 1 }, version: one.rightVersion, draw: (canvas: Parameters<Part["draw"]>[0]) => canvas.print(x + 4, y, one.right, 0) },
      ];
    }),
  });
  /** paints `before` then `after` on one painter and host, and `after` alone on new ones: both must show the same */
  async function incrementalAgainstFresh(before: Scene, after: Scene): Promise<Painter> {
    const painter = new Painter({ sync: false });
    const host = await hostOf(after.width, after.height);
    step(painter, host, before);
    expectReplay(host, painter, step(painter, host, after));
    const fresh = new Painter({ sync: false }, painter.styles);
    const freshHost = await hostOf(after.width, after.height);
    expectReplay(freshHost, fresh, step(fresh, freshHost, after));
    expect(modelCells(painter)).toEqual(modelCells(fresh));
    expect(hostCells(host, after.width, after.height)).toEqual(hostCells(freshHost, after.width, after.height));
    for (const target of [host, freshHost]) target.dispose();
    return painter;
  }

  test("a cell blanked for its left neighbour comes back when that neighbour changes, as a fresh paint draws it", async () => {
    const at = (left: string, leftVersion: number): Scene => scene(8, 1, {
      parts: [
        { key: "left", rect: { x: 0, y: 0, width: 2, height: 1 }, version: leftVersion, draw: (canvas) => canvas.print(0, 0, left, 0) },
        { key: "right", rect: { x: 2, y: 0, width: 2, height: 1 }, version: 0, draw: (canvas) => canvas.print(2, 0, "\uAC00", 0) },
      ],
    });
    // after a lone leading jamo the syllable would join it, so it is a blank; after "xx" it is drawn again
    const painter = await incrementalAgainstFresh(at("\u1100", 0), at("xx", 1));
    expect(painter.screen.text.slice(0, 4)).toEqual(["x", "x", "\uAC00", ""]);
  });

  test("every change of a wide or narrow neighbour, on either side, paints what a fresh paint draws", async () => {
    const LEFTS = ["x", "xx", "\u1100", "\uAC00", "\u{1F600}\u200D", "e\u0301", "\u0301", "\u2764\uFE0E", " "];
    const RIGHTS = ["\uAC00", "x", "\u1161", "\u0301", "\u{1F600}", "\u2764\uFE0E"];
    const before: { left: string; leftVersion: number; right: string; rightVersion: number }[] = [];
    const after: typeof before = [];
    for (const right of RIGHTS) {
      for (const a of LEFTS) {
        for (const b of LEFTS) {
          if (a === b) continue;
          before.push({ left: a, leftVersion: 0, right, rightVersion: 0 });
          after.push({ left: b, leftVersion: 1, right, rightVersion: 0 });
        }
      }
    }
    for (const left of LEFTS) {
      for (const a of RIGHTS) {
        for (const b of RIGHTS) {
          if (a === b) continue;
          before.push({ left, leftVersion: 0, right: a, rightVersion: 0 });
          after.push({ left, leftVersion: 0, right: b, rightVersion: 1 });
        }
      }
    }
    await incrementalAgainstFresh(sideBySide(before), sideBySide(after));
  }, 60_000);
});

describe("edges", () => {
  test("a 1x1 pane, no panes, a wide cell in the last column, a long cluster, and a pane removed between frames", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [12, 4];
    const host = await hostOf(W, H);
    const tiny = await shownPane(painter, 1, 1, "Z");
    const marks = await shownPane(painter, 4, 1, `e${"\u0301".repeat(10_000)}x\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}`);
    const edge = await shownPane(painter, 6, 1, "abcd한");
    const all = scene(W, H, {
      focus: "t",
      panes: [paneScene("t", tiny, { x: 0, y: 0, width: 1, height: 1 }), paneScene("m", marks, { x: 2, y: 1, width: 4, height: 1 }), paneScene("e", edge, { x: 7, y: 2, width: 6, height: 1 })],
    });
    let frame = step(painter, host, all);
    expect(frame.full).toBe(true);
    expectReplay(host, painter, frame);
    expect(painter.screen.text[0]).toBe("Z");
    // the engine keeps as many of the 10 000 marks as it holds for one cell; the screen shows exactly that cluster
    expect(painter.screen.text[W + 2]).toBe(marks.grid.grid.text[0]!);
    expect(painter.screen.text[W + 2]!.startsWith("e\u0301\u0301")).toBe(true);
    // the pane reaches past the screen's last column: its wide cell there is a blank
    expect([painter.screen.text[2 * W + 11], painter.screen.width[2 * W + 11]]).toEqual([" ", 1]);

    // two panes go away: none of their cells is left
    frame = step(painter, host, scene(W, H, { focus: "t", panes: [paneScene("t", tiny, { x: 0, y: 0, width: 1, height: 1 })] }));
    expectReplay(host, painter, frame);
    expect(painter.screen.text.filter((text) => text !== " ")).toEqual(["Z"]);

    // and none at all
    frame = step(painter, host, scene(W, H, {}));
    expectReplay(host, painter, frame);
    expect(painter.screen.text.every((text) => text === " ")).toBe(true);
    expect(frame.cursor.visible).toBe(false);
  });
});

// ---- the overall proof: random scenes, every frame replayed ----

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env["PAINT_SEED"] ?? 20261117);
const SCENES = 300;

const PIECES = [
  "hello ", "world", "x", "  ", "한글", "테스트 ", "漢字", "\u{1F469}\u200D\u{1F4BB}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F1F0}\u{1F1F7}",
  "\u{1F44D}\u{1F3FD}", "e\u0301", "a\u0308\u0323", "\u2764\uFE0F", "\u26BD\uFE0E", "\u0301", "\u{1F3FB}", "\t", "\r\n", "\n", "\x1b[K", "\x1b[1J",
  "\x1b[S", "\x1b[2T", "\x1b[L", "\x1b[P", "\x1b[3@", "\x1b[0m", "\x1b[?25l", "\x1b[?25h", "\x1b[3 q", "\x1b[6 q",
  "\u1100", "\u1161", "\u11A8", "\u{1F600}\u200D", "a\uFE0F", "\u2764\uFE0E", "\u{1F1FA}", "\u0600", "\u0903", "\u200B",
];
/** cells a program leaves side by side by writing the right one first */
const JOINERS = ["\u1100", "\uAC00", "\u1161", "\u11A8", "\u{1F600}\u200D", "\u2764", "\u{1F1F0}", "\u{1F1F7}", "\u{1F44D}", "\u{1F3FD}", "\u0301", "\uFE0F", "\uFE0E", "a", "\u0600", "\u0903"];

function randomText(next: () => number, cols: number, rows: number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const n = (max: number) => Math.floor(next() * max);
  const color = () => {
    const kind = n(4);
    if (kind === 0) return `${30 + n(8)}`;
    if (kind === 1) return `${90 + n(8)}`;
    if (kind === 2) return `38;5;${n(256)}`;
    return `38;2;${n(256)};${n(256)};${n(256)}`;
  };
  let out = "";
  const count = 5 + n(60);
  for (let i = 0; i < count; i++) {
    const roll = next();
    if (roll < 0.06) {
      const [row, col] = [1 + n(rows), 1 + n(cols)];
      out += `\x1b[${row};${col + 2}H${pick(JOINERS)}\x1b[${row};${col}H${pick(JOINERS)}`;
    } else if (roll < 0.12) out += `\x1b[${1 + n(rows)};${1 + n(cols)}H`;
    else if (roll < 0.22) out += `\x1b[${color()}m`;
    else if (roll < 0.28) out += `\x1b[${color().replace(/^3/, "4").replace(/^9/, "10")}m`;
    else if (roll < 0.34) out += `\x1b[${pick(["1", "2", "3", "4", "4:2", "4:3", "4:4", "4:5", "5", "7", "8", "9", "53", "21", "22", "24"])}m`;
    else if (roll < 0.36) out += "x".repeat(n(cols * 2));
    else out += pick(PIECES);
  }
  return out;
}

function randomTree(next: () => number, ids: string[]): LayoutNode {
  if (ids.length === 1) return { leaf: ids[0]! };
  const cut = 1 + Math.floor(next() * (ids.length - 1));
  return { split: next() < 0.5 ? "right" : "down", ratio: 0.2 + next() * 0.6, first: randomTree(next, ids.slice(0, cut)), second: randomTree(next, ids.slice(cut)) };
}

describe("property", () => {
  test(`replay equals model over ${SCENES} seeded random scenes (seed ${SEED})`, async () => {
    const next = random(SEED);
    const n = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    let frames = 0;
    let checked = 0;
    let cuts = 0;
    for (let sceneNo = 0; sceneNo < SCENES; sceneNo++) {
      const painter = new Painter({ sync: next() < 0.8 });
      const size = (): [number, number] => (next() < 0.08 ? [n(1, 3), n(1, 30)] : [n(20, 200), n(6, 60)]);
      let [W, H] = size();
      const host = await hostOf(W, H);
      const ids = Array.from({ length: n(1, 6) }, (_, i) => `p${i}`);
      const tree = randomTree(next, ids);
      const chrome = { sidebar: n(0, 30), tabBar: next() < 0.7, modeBar: next() < 0.7 };
      const borders = next() < 0.6;
      const panes = new Map<string, Shown & { view: { col: number; row: number }; scrolled: boolean }>();
      const owned: Emulator[] = [host];
      const layout = () => {
        const shape = regions(W, H, chrome);
        return { shape, cells: cellsOf(tree, shape.panes, { borders }).panes };
      };
      for (const cells of layout().cells) {
        const cols = Math.max(1, cells.cols + n(-3, 6));
        const rows = Math.max(1, cells.rows + n(-2, 4));
        const shown = await shownPane(painter, cols, rows);
        owned.push(shown.emulator);
        panes.set(cells.pane, { ...shown, view: { col: 0, row: 0 }, scrolled: false });
      }
      const frameCount = n(2, 5);
      for (let f = 0; f < frameCount; f++) {
        if (f > 0 && next() < 0.2) {
          [W, H] = size();
          expect(host.resize(W, H, 0, 0).ok).toBe(true);
        }
        const { shape, cells } = layout();
        for (const pane of cells) {
          const shown = panes.get(pane.pane)!;
          if (next() < 0.15) {
            const cols = Math.max(1, pane.cols + n(-3, 6));
            const rows = Math.max(1, pane.rows + n(-2, 4));
            expect(shown.emulator.resize(cols, rows, 0, 0).ok).toBe(true);
            shown.grid.resize(cols, rows);
          }
          const { cols, rows } = shown.grid.grid;
          if (next() < 0.8) feed(shown.emulator, randomText(next, cols, rows));
          if (next() < 0.05) feed(shown.emulator, shown.held.hold ? "\x1b[?2026l" : "\x1b[?2026h");
          if (next() < 0.1) {
            shown.scrolled = !shown.scrolled;
            expect(shown.emulator.scrollFromBottom(shown.scrolled ? n(1, 5) : 0).ok).toBe(true);
          }
          shown.view = { col: n(0, Math.max(0, cols - pane.inner.width + 2)), row: n(0, Math.max(0, rows - pane.inner.height + 2)) };
          copy(shown);
        }
        const overlays: Part[] = next() < 0.4
          ? [overlay("o", { x: n(-5, W), y: n(-2, H), width: n(1, 40), height: n(1, 10) }, chromeText(next))]
          : [];
        const focus = next() < 0.9 ? ids[n(0, ids.length - 1)]! : null;
        const inputRoll = next();
        const sceneNow = scene(W, H, {
          parts: [...placeholderChrome(shape, cells), titlePart(next, W, H, n(0, 1))],
          panes: cells.map((pane) => {
            const shown = panes.get(pane.pane)!;
            return paneScene(pane.pane, shown, pane.inner, { view: shown.view, scrolledBack: shown.scrolled, live: next() < 0.9 });
          }),
          overlays, focus,
          input: inputRoll < 0.85 ? null : inputRoll < 0.92 ? "overlay" : { col: n(0, W - 1), row: n(0, H - 1) },
        });
        const cut = next() < 0.12;
        const frame = painter.paint(sceneNow);
        frames++;
        if (cut) {
          cuts++;
          feed(host, frame.bytes.subarray(0, Math.floor(next() * frame.bytes.length)));
          painter.taken(false);
          continue;
        }
        if (frame.bytes.length > 0) feed(host, frame.bytes);
        painter.taken(true);
        const wrong = mismatch(host, painter);
        if (wrong) throw new Error(`seed ${SEED} scene ${sceneNo} frame ${f} (${W}x${H}): ${wrong}`);
        // the same scene drawn from nothing by a new painter: the incremental model must be the same, cell for cell
        const fresh = new Painter({ sync: false }, painter.styles);
        fresh.paint(sceneNow);
        const [incremental, whole] = [modelCells(painter), modelCells(fresh)];
        const stale = incremental.findIndex((cell, i) => !sameCell(cell, whole[i]!));
        if (stale >= 0) throw new Error(`seed ${SEED} scene ${sceneNo} frame ${f}: cell ${stale % W},${Math.floor(stale / W)} is ${JSON.stringify(incremental[stale])} but a fresh paint gives ${JSON.stringify(whole[stale])}`);
        const cursor = hostCursor(host);
        const want = frame.cursor.visible ? frame.cursor : { ...frame.cursor };
        const seen = frame.cursor.visible ? cursor : { ...cursor, shape: "block", blinking: false };
        if (JSON.stringify(seen) !== JSON.stringify(want)) throw new Error(`seed ${SEED} scene ${sceneNo} frame ${f}: cursor ${JSON.stringify(seen)} want ${JSON.stringify(want)}`);
        checked++;
      }
      for (const target of owned) target.dispose();
    }
    console.log(`property: seed ${SEED}, ${SCENES} scenes, ${frames} frames, ${checked} replayed and equal to the host and to a fresh paint, ${cuts} not taken whole`);
    expect(checked).toBeGreaterThan(SCENES);
  }, 600_000);
});

/** a chrome part over the panes whose version changes from frame to frame, printing chrome text up to the last columns */
function titlePart(next: () => number, W: number, H: number, version: number): Part {
  const rect = { x: Math.floor(next() * W), y: Math.floor(next() * H), width: 1 + Math.floor(next() * 40), height: 1 + Math.floor(next() * 3) };
  const texts = [chromeText(next), chromeText(next)];
  const cols = [rect.x + Math.floor(next() * rect.width), rect.x + rect.width - 1 - Math.floor(next() * 3)];
  return { key: "title", rect, version, draw: (canvas) => texts.forEach((text, i) => canvas.print(cols[i]!, rect.y + i, text, canvas.style({ fg: 2 + i }))) };
}

