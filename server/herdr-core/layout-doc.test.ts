import { describe, expect, it } from "bun:test";
import { type LayoutNode, place, reconcile, resizeLeaf } from "./layout-doc.ts";

const leaf = (address: string): LayoutNode => ({ leaf: address });
const split = (direction: "right" | "down", ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: direction, ratio, first, second });

describe("place", () => {
  it("keeps every pane of a deep split at least one unit wide", () => {
    let root = leaf("p6");
    for (const address of ["p5", "p4", "p3", "p2", "p1"]) root = split("right", 0.1, root, leaf(address));
    const widths = place(root, { x: 0, y: 0, width: 6, height: 1 }).panes.map((pane) => pane.rect.width);
    expect(widths).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("reconcile", () => {
  it("places a pane the document names twice once, drops a gone one and adds a new one to the right", () => {
    const doc = { schema: 1 as const, workspaces: [{ id: "S", tabs: [{ id: "T", zoomed: "gone", root: split("down", 0.5, split("right", 0.5, leaf("a"), leaf("a")), leaf("gone")) }] }] };
    const [tab] = reconcile(doc, [{ id: "S", tabs: [{ id: "T", panes: ["a", "b"] }] }]).workspaces[0]!.tabs;
    expect(tab).toEqual({ id: "T", zoomed: null, root: split("right", 0.5, leaf("a"), leaf("b")) });
  });
});

describe("resizeLeaf", () => {
  it("moves the nearest split whose cut is the pane's edge, else the one on its other side", () => {
    const root = split("right", 0.5, leaf("a"), split("down", 0.5, leaf("b"), leaf("c")));
    expect(resizeLeaf(root, "b", "right", 0.1)).toEqual(split("right", 0.6, leaf("a"), split("down", 0.5, leaf("b"), leaf("c"))));
    expect(resizeLeaf(root, "b", "down", 0.1)).toEqual(split("right", 0.5, leaf("a"), split("down", 0.6, leaf("b"), leaf("c"))));
    expect(resizeLeaf(split("right", 0.9, leaf("a"), leaf("b")), "a", "right", 0.1)).toBeNull();
  });
});
