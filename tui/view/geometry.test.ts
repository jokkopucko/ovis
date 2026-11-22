import { describe, expect, test } from "bun:test";
import type { LayoutNode } from "../../server/herdr-core/layout-doc.ts";
import { cellsOf, intersect, NO_CELLS, regions, type Rect } from "./geometry.ts";

const area = (rect: Rect): number => rect.width * rect.height;
/** `inner` lies inside `outer` (an empty rectangle lies anywhere) */
const inside = (outer: Rect, inner: Rect): boolean => area(inner) === 0 || JSON.stringify(intersect(outer, inner)) === JSON.stringify(inner);

describe("regions", () => {
  test("a wide screen: sidebar left, tab bar over the panes, mode bar along the bottom, every cell in exactly one region", () => {
    const shape = regions(120, 40, { sidebar: 26, tabBar: true, modeBar: true });
    expect(shape.narrow).toBe(false);
    expect(shape.sidebar).toEqual({ x: 0, y: 0, width: 26, height: 39 });
    expect(shape.tabBar).toEqual({ x: 26, y: 0, width: 94, height: 1 });
    expect(shape.panes).toEqual({ x: 26, y: 1, width: 94, height: 38 });
    expect(shape.modeBar).toEqual({ x: 0, y: 39, width: 120, height: 1 });
    const parts = [shape.sidebar, shape.tabBar, shape.panes, shape.modeBar];
    expect(parts.reduce((sum, rect) => sum + area(rect), 0)).toBe(120 * 40);
    for (const [i, a] of parts.entries()) for (const b of parts.slice(i + 1)) expect(intersect(a, b)).toEqual(NO_CELLS);
  });

  test("a narrow screen has no sidebar, and hidden bars give their rows to the panes", () => {
    const shape = regions(64, 20, { sidebar: 26, tabBar: false, modeBar: false });
    expect(shape.narrow).toBe(true);
    expect(shape.sidebar).toEqual(NO_CELLS);
    expect(shape.panes).toEqual({ x: 0, y: 0, width: 64, height: 20 });
  });

  test("a screen smaller than its chrome keeps a cell for the panes, and an empty screen has none", () => {
    expect(regions(80, 1, { sidebar: 30, tabBar: true, modeBar: true }).panes).toEqual({ x: 30, y: 0, width: 50, height: 1 });
    expect(regions(70, 2, { sidebar: 200, tabBar: true, modeBar: true })).toMatchObject({ sidebar: { width: 69, height: 1 }, tabBar: NO_CELLS, panes: { x: 69, y: 0, width: 1, height: 1 } });
    const none = regions(0, 0, { sidebar: 26, tabBar: true, modeBar: true });
    expect([none.sidebar, none.tabBar, none.panes, none.modeBar]).toEqual([NO_CELLS, NO_CELLS, NO_CELLS, NO_CELLS]);
  });
});

describe("cellsOf", () => {
  const tree: LayoutNode = { split: "right", ratio: 0.5, first: { leaf: "a" }, second: { split: "down", ratio: 0.25, first: { leaf: "b" }, second: { leaf: "c" } } };

  test("the layout document's place() cut into cells, with a border inside each share", () => {
    const { panes, splits } = cellsOf(tree, { x: 10, y: 2, width: 80, height: 20 });
    expect(panes).toEqual([
      { pane: "a", outer: { x: 10, y: 2, width: 40, height: 20 }, inner: { x: 11, y: 3, width: 38, height: 18 }, cols: 38, rows: 18 },
      { pane: "b", outer: { x: 50, y: 2, width: 40, height: 5 }, inner: { x: 51, y: 3, width: 38, height: 3 }, cols: 38, rows: 3 },
      { pane: "c", outer: { x: 50, y: 7, width: 40, height: 15 }, inner: { x: 51, y: 8, width: 38, height: 13 }, cols: 38, rows: 13 },
    ]);
    expect(splits.map(({ id, direction }) => [id, direction])).toEqual([["split_0_root", "right"], ["split_1_1", "down"]]);
    expect(cellsOf(tree, { x: 0, y: 0, width: 80, height: 20 }, { borders: false }).panes[0]!.inner).toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });

  test("shares never overlap and stay inside the area, and every pane asks for at least 1x1", () => {
    for (const [width, height] of [[1, 1], [2, 2], [3, 1], [5, 4], [200, 60]] as const) {
      const box = { x: 3, y: 1, width, height };
      const { panes } = cellsOf(tree, box);
      expect(panes.map(({ pane }) => pane)).toEqual(["a", "b", "c"]);
      for (const [i, pane] of panes.entries()) {
        expect(inside(box, pane.outer) && inside(pane.outer, pane.inner)).toBe(true);
        expect(pane.cols >= 1 && pane.rows >= 1).toBe(true);
        for (const other of panes.slice(i + 1)) expect(intersect(pane.outer, other.outer)).toEqual(NO_CELLS);
      }
    }
  });

  test("a share too small for a border shows the terminal on all of it; no tree has no panes", () => {
    const { panes } = cellsOf({ split: "right", ratio: 0.5, first: { leaf: "a" }, second: { leaf: "b" } }, { x: 0, y: 0, width: 10, height: 2 });
    expect(panes.map(({ inner }) => inner)).toEqual([{ x: 0, y: 0, width: 5, height: 2 }, { x: 5, y: 0, width: 5, height: 2 }]);
    expect(cellsOf(null, { x: 0, y: 0, width: 10, height: 2 })).toEqual({ panes: [], splits: [] });
  });
});
