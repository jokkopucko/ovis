import { describe, expect, it } from "bun:test";
import { adjacentTabBoundary, drawnTabBoundary, movedTabOrder, tabDropBoundary } from "./tabOrder.ts";

describe("native tab insertion boundaries", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves in both directions, including the first and last gaps", () => {
    expect(movedTabOrder(ids, "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(movedTabOrder(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(movedTabOrder(ids, "b", 3)).toEqual(["a", "c", "b", "d"]);
    expect(movedTabOrder(ids, "c", 1)).toEqual(["a", "c", "b", "d"]);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
  it("ignores both gaps beside the source and refuses stale sources/invalid boundaries", () => {
    for (const index of [1, 2, -1, 5, 1.5, NaN]) expect(movedTabOrder(ids, "b", index)).toBeNull();
    expect(movedTabOrder(ids, "closed", 0)).toBeNull();
    expect(movedTabOrder([], "a", 0)).toBeNull();
  });
  it("keyboard and touch moves share the native coordinates without wrapping", () => {
    expect(adjacentTabBoundary(ids, "b", -1)).toBe(0);
    expect(adjacentTabBoundary(ids, "b", 1)).toBe(3);
    expect(adjacentTabBoundary(ids, "a", -1)).toBeNull();
    expect(adjacentTabBoundary(ids, "d", 1)).toBeNull();
    expect(adjacentTabBoundary(ids, "closed", 1)).toBeNull();
  });
  it("uses each tab midpoint, including clipped tabs in a scrolled strip", () => {
    const rects = [{ left: -80, right: 20 }, { left: 24, right: 144 }, { left: 148, right: 208 }];
    expect(tabDropBoundary(rects, -90)).toBe(0);
    expect(tabDropBoundary(rects, 0)).toBe(1);
    expect(tabDropBoundary(rects, 85)).toBe(2);
    expect(tabDropBoundary(rects, 208)).toBe(3);
  });
});

describe("a drop among the drawn tabs of a row that leaves some out", () => {
  it("goes right after the drawn tab before the line, past the tabs left out", () => {
    expect(drawnTabBoundary([0, 1, 5], 2)).toBe(2);
    expect(movedTabOrder(["A", "B", "C", "D", "E", "F"], "F", drawnTabBoundary([0, 1, 5], 2))).toEqual(["A", "B", "F", "C", "D", "E"]);
    expect(drawnTabBoundary([0, 1, 5], 3)).toBe(6);
    expect(drawnTabBoundary([0, 1, 5], 0)).toBe(0);
  });

  it("is the drawn place where every tab is drawn", () => {
    expect([0, 1, 2, 3].map((at) => drawnTabBoundary([0, 1, 2], at))).toEqual([0, 1, 2, 3]);
  });
});
