import { beforeEach, describe, expect, it } from "bun:test";
import type { PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/protocol.ts";
import { closeLayoutPane, moveLayoutPane, resizeLayout, setLayoutSplitRatio, splitLayout, swapLayoutPanes } from "./layoutTree.ts";

const rect = (x: number, y: number, width: number, height: number): PaneLayoutRect => ({ x, y, width, height });
const area = rect(0, 0, 120, 40);
const tab = (panes: { id: string; rect: PaneLayoutRect }[]): PaneLayoutSnapshot => ({
  workspace_id: "w1", tab_id: "w1:t1", zoomed: false, area, focused_pane_id: panes[0]!.id,
  panes: panes.map((pane) => ({ pane_id: pane.id, focused: false, rect: pane.rect })),
  splits: [],
});
const rectOf = (panes: PaneLayoutSnapshot["panes"], id: string): PaneLayoutRect => panes.find((pane) => pane.pane_id === id)!.rect;

function split(layout: PaneLayoutSnapshot, id: string, made: string, direction: "right" | "down"): void {
  expect(splitLayout(layout, id, { pane_id: made, focused: false, rect: area }, direction)).toBe(true);
}

function expectTiling(panes: PaneLayoutSnapshot["panes"]): void {
  let covered = 0;
  for (const [index, pane] of panes.entries()) {
    const { x, y, width, height } = pane.rect;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(x >= area.x && y >= area.y && x + width <= area.x + area.width && y + height <= area.y + area.height).toBe(true);
    covered += width * height;
    for (const other of panes.slice(index + 1)) {
      const o = other.rect;
      expect(o.x >= x + width || x >= o.x + o.width || o.y >= y + height || y >= o.y + o.height).toBe(true);
    }
  }
  expect(covered).toBe(area.width * area.height);
}

let nested: PaneLayoutSnapshot;
beforeEach(() => {
  nested = tab([{ id: "left", rect: rect(0, 0, 60, 40) }, { id: "top", rect: rect(60, 0, 60, 20) }, { id: "bottom", rect: rect(60, 20, 60, 20) }]);
});

describe("resizeLayout", () => {
  it("sets an absolute ratio on a binary path and preserves separate aligned splits", () => {
    const layout = tab([{ id: "top-left", rect: area }]);
    split(layout, "top-left", "bottom-left", "down");
    split(layout, "top-left", "top-right", "right");
    split(layout, "bottom-left", "bottom-right", "right");
    expect(layout.splits.map((split) => split.id)).toEqual(["split_0_root", "split_1_0", "split_2_1"]);
    const saved = structuredClone(layout);
    expect(setLayoutSplitRatio(saved, [true], 0.75)).toBe(true);
    expect(rectOf(saved.panes, "bottom-left").width).toBe(90);
    expect(rectOf(saved.panes, "top-left").width).toBe(60);
    const top = layout.panes.filter((pane) => pane.pane_id.startsWith("top")).map((pane) => structuredClone(pane));
    expect(setLayoutSplitRatio(layout, [true], 0.75)).toBe(true);
    expect(layout.panes.filter((pane) => pane.pane_id.startsWith("top"))).toEqual(top);
    expect(rectOf(layout.panes, "bottom-left").width).toBe(90);
    expect(rectOf(layout.panes, "bottom-right").width).toBe(30);
    expect(layout.splits.map((split) => split.id)).toEqual(["split_0_root", "split_1_0", "split_2_1"]);
    expect(setLayoutSplitRatio(layout, [true, false], 0.5)).toBe(false);
    expect(setLayoutSplitRatio(layout, [], 0.6)).toBe(true);
    expect(rectOf(layout.panes, "top-left").height).toBe(24);
    expect(rectOf(layout.panes, "bottom-left").height).toBe(16);
    expectTiling(layout.panes);
  });
  it("keeps the tree and current focus through swap, zoom and close before resizing again", () => {
    const layout = tab([{ id: "top-left", rect: area }]);
    split(layout, "top-left", "bottom-left", "down");
    split(layout, "top-left", "top-right", "right");
    split(layout, "bottom-left", "bottom-right", "right");
    swapLayoutPanes(layout, "top-left", "bottom-left");
    layout.zoomed = true;
    layout.focused_pane_id = "bottom-left";
    for (const pane of layout.panes) pane.focused = pane.pane_id === "bottom-left";
    layout.panes = resizeLayout(layout, "bottom-left", "right", 0.05)!;
    expect(rectOf(layout.panes, "bottom-left")).toEqual(rect(0, 0, 66, 20));
    expect(layout.panes.find((pane) => pane.pane_id === "bottom-left")!.focused).toBe(true);
    layout.zoomed = false;

    closeLayoutPane(layout, "top-right");

    expect(rectOf(layout.panes, "bottom-left")).toEqual(rect(0, 0, 120, 20));
    expectTiling(layout.panes);
    layout.panes = resizeLayout(layout, "top-left", "right", 0.05)!;
    expect(rectOf(layout.panes, "bottom-left")).toEqual(rect(0, 0, 120, 20));
    expect(rectOf(layout.panes, "top-left")).toEqual(rect(0, 20, 66, 20));
    expectTiling(layout.panes);
  });

  it("bounds width by descendants and refuses a split that would make a zero-cell leaf", () => {
    const layout = tab([{ id: "p0", rect: area }]);
    for (let i = 0; i < 6; i += 1) split(layout, `p${i}`, `p${i + 1}`, "right");
    for (let i = 0; i < 20; i += 1) layout.panes = resizeLayout(layout, "p0", "right", 0.05) ?? layout.panes;
    expectTiling(layout.panes);
    expect(resizeLayout(layout, "p0", "left", 0.05)).not.toBeNull();
    const narrow = layout.panes.find((pane) => pane.rect.width === 1)!;
    const before = structuredClone(layout);
    expect(splitLayout(layout, narrow.pane_id, { pane_id: "extra", focused: false, rect: area }, "right")).toBe(false);
    expect(layout).toEqual(before);
  });

  it("preserves the separate bottom split when widening the top-left pane of a down-first grid", () => {
    const layout = tab([{ id: "top-left", rect: area }]);
    split(layout, "top-left", "bottom-left", "down");
    split(layout, "top-left", "top-right", "right");
    split(layout, "bottom-left", "bottom-right", "right");
    const bottom = layout.panes.filter((pane) => pane.pane_id.startsWith("bottom")).map((pane) => structuredClone(pane));

    const wider = resizeLayout(layout, "top-left", "right", 0.05)!;

    expect(rectOf(wider, "top-left").width).toBe(66);
    expect(wider.filter((pane) => pane.pane_id.startsWith("bottom"))).toEqual(bottom);
    expectTiling(wider);
  });

  it("keeps six down-split descendants visible and can shorten after three Taller actions", () => {
    const layout = tab([{ id: "p0", rect: area }]);
    for (let i = 0; i < 5; i += 1) split(layout, `p${i}`, `p${i + 1}`, "down");
    expect(layout.panes.map((pane) => pane.rect.height)).toEqual([20, 10, 5, 2, 1, 2]);

    for (let i = 0; i < 3; i += 1) layout.panes = resizeLayout(layout, "p0", "down", 0.05)!;

    expectTiling(layout.panes);
    const shorter = resizeLayout(layout, "p0", "up", 0.05);
    expect(shorter).not.toBeNull();
    expect(rectOf(shorter!, "p0").height).toBeLessThan(rectOf(layout.panes, "p0").height);
    expectTiling(shorter!);
  });

  it("moves the split the border belongs to and lays every pane under it out again", () => {
    const wider = resizeLayout(nested, "left", "right", 0.05)!;
    expect(rectOf(wider, "left")).toEqual(rect(0, 0, 66, 40));
    expect(rectOf(wider, "top")).toEqual(rect(66, 0, 54, 20));
    expect(rectOf(wider, "bottom")).toEqual(rect(66, 20, 54, 20));
    expectTiling(wider);
  });

  it("moves the opposite border of a pane with no neighbour on the side named, as herdr does", () => {
    const narrower = resizeLayout(nested, "top", "right", 0.05)!;
    expect(rectOf(narrower, "left").width).toBe(66);
    expect(rectOf(narrower, "top").x).toBe(66);
    expect(rectOf(narrower, "bottom").x).toBe(66);
    expectTiling(narrower);
  });

  it("leaves the panes outside the split alone", () => {
    const taller = resizeLayout(nested, "top", "down", 0.25)!;
    expect(rectOf(taller, "left")).toEqual(rect(0, 0, 60, 40));
    expect(rectOf(taller, "top")).toEqual(rect(60, 0, 60, 30));
    expect(rectOf(taller, "bottom")).toEqual(rect(60, 30, 60, 10));
    expectTiling(taller);
  });

  it("takes the amount on the split's own extent, caps it at herdr's half and holds the ratio to a tenth", () => {
    const columns = tab([{ id: "left", rect: rect(0, 0, 60, 40) }, { id: "mid", rect: rect(60, 0, 30, 40) }, { id: "right", rect: rect(90, 0, 30, 40) }]);
    const mid = resizeLayout(columns, "mid", "right", 0.25)!;
    expect(rectOf(mid, "mid")).toEqual(rect(60, 0, 45, 40));
    expect(rectOf(mid, "right")).toEqual(rect(105, 0, 15, 40));
    expectTiling(mid);
    const most = resizeLayout(nested, "left", "right", 0.8)!;
    expect(rectOf(most, "left").width).toBe(108);
    expectTiling(most);
    expect(resizeLayout({ ...nested, panes: most }, "left", "right", 0.05)).toBeNull();
  });

  it("has nothing to move for a pane alone, an axis the pane fills, an unknown pane, or rects no split line cuts", () => {
    expect(resizeLayout(tab([{ id: "only", rect: area }]), "only", "right", 0.05)).toBeNull();
    expect(resizeLayout(nested, "left", "down", 0.05)).toBeNull();
    expect(resizeLayout(nested, "nope", "right", 0.05)).toBeNull();
    const pinwheel = tab([
      { id: "top", rect: rect(0, 0, 80, 10) }, { id: "right", rect: rect(80, 0, 40, 30) }, { id: "bottom", rect: rect(40, 30, 80, 10) },
      { id: "left", rect: rect(0, 10, 40, 30) }, { id: "centre", rect: rect(40, 10, 40, 20) },
    ]);
    expectTiling(pinwheel.panes);
    expect(resizeLayout(pinwheel, "centre", "right", 0.05)).toBeNull();
  });
});

describe("moveLayoutPane", () => {
  it("measures the target's room once the pane has left the tree, and changes nothing when there is none", () => {
    const pair = tab([{ id: "narrow", rect: rect(0, 0, 1, 40) }, { id: "wide", rect: rect(1, 0, 119, 40) }]);
    expect(moveLayoutPane(pair, "wide", "narrow", "right")).toBe(true);
    expect(rectOf(pair.panes, "narrow")).toEqual(rect(0, 0, 60, 40));
    expect(rectOf(pair.panes, "wide")).toEqual(rect(60, 0, 60, 40));
    expectTiling(pair.panes);
    const three = tab([{ id: "narrow", rect: rect(0, 0, 1, 40) }, { id: "top", rect: rect(1, 0, 119, 20) }, { id: "bottom", rect: rect(1, 20, 119, 20) }]);
    const before = structuredClone(three);
    expect(moveLayoutPane(three, "bottom", "narrow", "right")).toBe(false);
    expect(three).toEqual(before);
    expect(moveLayoutPane(three, "bottom", "narrow", "down")).toBe(true);
    expect(rectOf(three.panes, "bottom")).toEqual(rect(0, 20, 1, 20));
    expectTiling(three.panes);
  });
});
