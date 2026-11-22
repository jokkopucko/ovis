import { place, type LayoutNode, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";

/** A rectangle of screen cells; x and y count from the screen's top-left cell, 0-based. */
export interface Rect { x: number; y: number; width: number; height: number }

export const NO_CELLS: Rect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : NO_CELLS;
}

export const holds = (rect: Rect, col: number, row: number): boolean =>
  col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;

/** At or below this many columns the screen is narrow: it shows no sidebar. */
export const NARROW_COLUMNS = 64;

/** What the chrome asks for: the sidebar's width in columns (0 when collapsed), and whether the tab bar and the mode bar show. */
export interface ChromeShape { sidebar: number; tabBar: boolean; modeBar: boolean }

/**
 * Where each part of the screen goes. The panes always keep at least one cell while the screen has one: a part of the chrome
 * that would take the last row or column from them is left out (its rectangle is empty).
 */
export interface Regions {
  screen: Rect;
  narrow: boolean;
  /** the left column of workspaces and agents, down to the mode bar */
  sidebar: Rect;
  /** one row above the panes, right of the sidebar */
  tabBar: Rect;
  panes: Rect;
  /** the bottom row, the whole width */
  modeBar: Rect;
}

export function regions(width: number, height: number, chrome: ChromeShape): Regions {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const narrow = w <= NARROW_COLUMNS;
  const modeRows = chrome.modeBar && h >= 2 ? 1 : 0;
  const tabRows = chrome.tabBar && h - modeRows >= 2 ? 1 : 0;
  const side = narrow ? 0 : Math.max(0, Math.min(Math.floor(chrome.sidebar), w - 1));
  const body = h - modeRows;
  return {
    screen: { x: 0, y: 0, width: w, height: h },
    narrow,
    sidebar: side > 0 && body > 0 ? { x: 0, y: 0, width: side, height: body } : NO_CELLS,
    tabBar: tabRows > 0 && w - side > 0 ? { x: side, y: 0, width: w - side, height: tabRows } : NO_CELLS,
    panes: w - side > 0 && body - tabRows > 0 ? { x: side, y: tabRows, width: w - side, height: body - tabRows } : NO_CELLS,
    modeBar: modeRows > 0 && w > 0 ? { x: 0, y: h - 1, width: w, height: 1 } : NO_CELLS,
  };
}

/**
 * One pane's cells: `outer` is its share of the area, `inner` what its terminal shows in (inside the border, or the whole
 * share when it is too small for one). `cols` and `rows` are the size the terminal is asked for: at least 1x1 even when the
 * share has no cell on screen, as an emulator is never smaller.
 */
export interface PaneCells { pane: string; outer: Rect; inner: Rect; cols: number; rows: number }
export interface SplitCells { id: string; direction: SplitDirection; rect: Rect }

/** The smallest share that has room for a border around one cell. */
const BORDERED = 3;

/**
 * A tab's tree cut into `area`'s cells by the layout document's own `place()` (each split's first side gets its ratio of the
 * extent, at least one cell to every pane while the area has room). A tree with more panes than the area has cells along an
 * axis leaves the last ones without cells on screen.
 */
export function cellsOf(tree: LayoutNode | null, area: Rect, options: { borders: boolean } = { borders: true }): { panes: PaneCells[]; splits: SplitCells[] } {
  if (!tree) return { panes: [], splits: [] };
  const placed = place(tree, area);
  const panes = placed.panes.filter(({ pane_id }) => pane_id !== "").map(({ pane_id, rect }): PaneCells => {
    const outer = intersect(rect, area);
    const bordered = options.borders && outer.width >= BORDERED && outer.height >= BORDERED;
    const inner = bordered ? { x: outer.x + 1, y: outer.y + 1, width: outer.width - 2, height: outer.height - 2 } : outer;
    return { pane: pane_id, outer, inner, cols: Math.max(1, inner.width), rows: Math.max(1, inner.height) };
  });
  const splits = placed.splits.map(({ id, direction, rect }) => ({ id, direction: direction as SplitDirection, rect: intersect(rect, area) }));
  return { panes, splits };
}
