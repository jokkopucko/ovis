import { describe, expect, it } from "bun:test";
import type { PaneLayoutSnapshot } from "../../shared/protocol.ts";
import { layoutCells, paneNeighbors, resizeMove, zoomMode, zoomedPaneId } from "./layoutMap.ts";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const tab = (panes: { id: string; rect: ReturnType<typeof rect>; focused?: boolean }[], zoomed = false, area = rect(0, 0, 120, 40)): PaneLayoutSnapshot => ({
  workspace_id: "w1", tab_id: "w1:t1", zoomed, area,
  focused_pane_id: panes.find((pane) => pane.focused)?.id ?? panes[0]!.id,
  panes: panes.map((pane) => ({ pane_id: pane.id, focused: pane.focused === true, rect: pane.rect })),
  splits: [],
});

const columns = tab([{ id: "p1", rect: rect(0, 0, 60, 40), focused: true }, { id: "p2", rect: rect(60, 0, 60, 40) }]);
const grid = tab([
  { id: "p1", rect: rect(0, 0, 48, 40) },
  { id: "p2", rect: rect(48, 0, 43, 20), focused: true },
  { id: "p4", rect: rect(48, 20, 43, 20) },
  { id: "p3", rect: rect(91, 0, 29, 40) },
]);

describe("layoutCells", () => {
  it("scales every pane's rect to percent of the area, in reading order", () => {
    expect(layoutCells(columns)).toEqual([
      { paneId: "p1", focused: true, left: 0, top: 0, width: 50, height: 100 },
      { paneId: "p2", focused: false, left: 50, top: 0, width: 50, height: 100 },
    ]);
    expect(layoutCells(grid).map((cell) => cell.paneId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(layoutCells(grid).find((cell) => cell.paneId === "p4")).toEqual({ paneId: "p4", focused: false, left: 40, top: 50, width: 43 / 120 * 100, height: 50 });
  });

  it("measures from the area's own origin", () => {
    const offset = tab([{ id: "p1", rect: rect(2, 1, 50, 20) }, { id: "p2", rect: rect(52, 1, 50, 20) }], false, rect(2, 1, 100, 20));
    expect(layoutCells(offset)).toEqual([
      { paneId: "p1", focused: false, left: 0, top: 0, width: 50, height: 100 },
      { paneId: "p2", focused: false, left: 50, top: 0, width: 50, height: 100 },
    ]);
  });

  it("survives an empty area", () => {
    expect(layoutCells(tab([{ id: "p1", rect: rect(0, 0, 0, 0) }], false, rect(0, 0, 0, 0)))).toEqual([{ paneId: "p1", focused: false, left: 0, top: 0, width: 0, height: 0 }]);
  });
});

describe("zoomedPaneId", () => {
  it("names the focused pane while the tab is zoomed, and nothing otherwise", () => {
    expect(zoomedPaneId(columns)).toBeNull();
    expect(zoomedPaneId({ ...columns, zoomed: true })).toBe("p1");
  });
});

describe("paneNeighbors", () => {
  it("finds the panes against each side", () => {
    expect(paneNeighbors(columns, "p1")).toEqual({ left: false, right: true, up: false, down: false });
    expect(paneNeighbors(columns, "p2")).toEqual({ left: true, right: false, up: false, down: false });
    expect(paneNeighbors(grid, "p2")).toEqual({ left: true, right: true, up: false, down: true });
    expect(paneNeighbors(grid, "p4")).toEqual({ left: true, right: true, up: true, down: false });
    expect(paneNeighbors(grid, "p1")).toEqual({ left: false, right: true, up: false, down: false });
  });

  it("takes a split rounded a cell either way as touching, and a pane off the layout as alone", () => {
    const rounded = tab([{ id: "p1", rect: rect(0, 0, 59, 40) }, { id: "p2", rect: rect(60, 0, 60, 40) }]);
    expect(paneNeighbors(rounded, "p1").right).toBe(true);
    const apart = tab([{ id: "p1", rect: rect(0, 0, 50, 40) }, { id: "p2", rect: rect(60, 0, 60, 40) }]);
    expect(paneNeighbors(apart, "p1").right).toBe(false);
    expect(paneNeighbors(columns, "nope")).toEqual({ left: false, right: false, up: false, down: false });
  });
});

describe("resizeMove", () => {
  it("grows a pane toward its neighbour and shrinks it away from the one it has", () => {
    expect(resizeMove(columns, "p1", "wider")).toEqual({ paneId: "p1", direction: "right" });
    expect(resizeMove(columns, "p1", "narrower")).toEqual({ paneId: "p1", direction: "left" });
    expect(resizeMove(columns, "p2", "wider")).toEqual({ paneId: "p2", direction: "left" });
    expect(resizeMove(columns, "p2", "narrower")).toEqual({ paneId: "p2", direction: "right" });
    expect(resizeMove(grid, "p4", "taller")).toEqual({ paneId: "p4", direction: "up" });
    expect(resizeMove(grid, "p4", "shorter")).toEqual({ paneId: "p4", direction: "down" });
    expect(resizeMove(grid, "p2", "shorter")).toEqual({ paneId: "p2", direction: "up" });
  });

  it("narrows a pane between two others through its neighbour, which herdr would only grow", () => {
    expect(resizeMove(grid, "p2", "wider")).toEqual({ paneId: "p2", direction: "right" });
    expect(resizeMove(grid, "p2", "narrower")).toEqual({ paneId: "p3", direction: "left" });
  });

  it("has nothing to do on an axis the pane fills", () => {
    expect(resizeMove(columns, "p1", "taller")).toBeNull();
    expect(resizeMove(columns, "p1", "shorter")).toBeNull();
    expect(resizeMove(grid, "p1", "taller")).toBeNull();
    expect(resizeMove(tab([{ id: "p1", rect: rect(0, 0, 120, 40) }]), "p1", "wider")).toBeNull();
  });
});

describe("zoomMode", () => {
  it("unzooms only the pane the tab shows alone, and shows any other pane alone with an explicit on", () => {
    // herdr focuses the pane before it reads the mode: a toggle on p2 of a tab zoomed on p1
    // would unzoom the tab, so p2 is zoomed `on`, and only p1 sends `off`
    const zoomedOnP1 = tab([{ id: "p1", rect: rect(0, 0, 60, 40), focused: true }, { id: "p2", rect: rect(60, 0, 60, 40) }], true);
    expect(zoomMode(zoomedOnP1, "p1")).toBe("off");
    expect(zoomMode(zoomedOnP1, "p2")).toBe("on");
    expect(zoomMode(columns, "p1")).toBe("on");
    expect(zoomMode(columns, "p2")).toBe("on");
  });
});
