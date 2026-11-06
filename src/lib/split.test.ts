import { afterEach, describe, expect, it } from "bun:test";
import { activateSlot, besideSide, closeSlots, dockPane, draggedPane, dropSide, dropZone, MAX_SPLIT_SLOTS, paneDragData, pickInSlot, resizeSplit, sideZone, slotRects, slotSide, slotsOf, splitDividers, splitShows, storedSplit, storeSplit, withoutSlots, zoneRect, type SplitChange, type SplitState } from "./split.ts";

const A = { machineId: "local", paneId: "w1:p1" };
const B = { machineId: "local", paneId: "w1:p2" };
const C = { machineId: "pc2", paneId: "w1:p1" };
const D = { machineId: "pc2", paneId: "w2:p1" };

/** two halves as the two-half split kept them: `b` on `bSide`, the other slot's pane `other` */
const halves = (other: typeof A, bSide: "left" | "right", active: "a" | "b"): SplitState => ({
  root: { dir: "row", ratio: 0.5, first: { slot: bSide === "left" ? "b" : "a" }, second: { slot: bSide === "left" ? "a" : "b" } },
  panes: { [active === "a" ? "b" : "a"]: other },
  active,
});

describe("split view", () => {
  it("opens a dropped pane beside the single one, on the side it was dropped on", () => {
    expect(dockPane(null, A, B, { slot: "a", edge: "right" })).toEqual({ split: halves(A, "right", "b"), solo: "b", select: B });
    expect(dockPane(null, A, B, { slot: "a", edge: "left" })).toEqual({ split: halves(A, "left", "b"), solo: "b", select: B });
    // the single pane's slot keeps it, on the other side
    expect(slotSide(halves(A, "left", "b"), "a")).toBe("right");
  });

  it("opens a dropped pane in a new slot when the single pane is in slot b", () => {
    // a split closed from its left half leaves its pane in slot b: dropping again keeps it there
    const next = dockPane(null, A, B, { slot: "b", edge: "right" }, "b")!;
    expect(next.split).toEqual(halves(A, "left", "a"));
    expect(slotSide(next.split!, "a")).toBe("right");
    expect(slotSide(next.split!, "b")).toBe("left");
  });

  it("does nothing for a pane dropped onto the active slot that shows it, or with nothing open", () => {
    expect(dockPane(null, null, B, { slot: "a", edge: "left" })).toBeNull();
    expect(dockPane(halves(A, "right", "b"), B, B, { slot: "b", edge: null })).toBeNull();
  });

  it("opens the single pane beside itself when it is dropped on a half", () => {
    expect(dockPane(null, A, A, { slot: "a", edge: "left" })!.split).toEqual(halves(A, "left", "b"));
  });

  it("opens a pane dropped on the active slot there, and on another slot there, making it active", () => {
    // B active on the right (slot b), A on the left (slot a)
    const split = halves(A, "right", "b");
    expect(dockPane(split, B, C, { slot: "b", edge: null })).toEqual({ split, solo: "b", select: C });
    expect(dockPane(split, B, C, { slot: "a", edge: null })).toEqual({ split: halves(B, "right", "a"), solo: "a", select: C });
  });

  it("shows a slot's own pane in another slot too, never moving either", () => {
    const split = halves(A, "right", "b");
    // the active B dropped on the left: the left shows B as well and is active, the right keeps B
    expect(dockPane(split, B, B, { slot: "a", edge: null })!.split).toEqual(halves(B, "right", "a"));
    // the other pane A dropped on the active right half: the right shows A as well, the left keeps A
    expect(dockPane(split, B, A, { slot: "b", edge: null })!.split).toEqual(split);
  });

  it("makes another slot active without moving any pane", () => {
    const next = activateSlot(halves(A, "right", "b"), B, "a")!;
    expect(next).toEqual({ split: halves(B, "right", "a"), solo: "a", select: A });
    expect(slotSide(next.split!, "a")).toBe("left");
    expect(activateSlot(halves(A, "right", "b"), B, "b")).toBeNull();
    expect(activateSlot(halves(A, "right", "b"), B, "z")).toBeNull();
  });

  it("maps a half of the area to its slot as the two halves took a drop", () => {
    expect(sideZone(null, "a", "left")).toEqual({ slot: "a", edge: "left" });
    const split = halves(A, "right", "b");
    expect(sideZone(split, "b", "left")).toEqual({ slot: "a", edge: null });
    expect(sideZone(split, "b", "right")).toEqual({ slot: "b", edge: null });
    // two slots stacked cover both halves alike: either half is the active slot's, not always the lower one
    const stacked = dockPane(null, A, B, { slot: "a", edge: "bottom" })!.split!;
    expect(sideZone(stacked, "b", "left")).toEqual({ slot: "b", edge: null });
    expect(sideZone({ ...stacked, active: "a", panes: { b: B } }, "a", "right")).toEqual({ slot: "a", edge: null });
    // otherwise the slot covering most of that half
    const three = dockPane(split, B, C, { slot: "b", edge: "bottom" })!.split!;
    expect(sideZone(resizeSplit(three, "", 0.3), "c", "left")).toEqual({ slot: "a", edge: null });
    expect(sideZone(resizeSplit(three, "", 0.8), "c", "right")).toEqual({ slot: "a", edge: null });
  });

  it("tells the half by the middle of the area, and reads only a pane's drag data", () => {
    expect(dropSide(100, 0, 400)).toBe("left");
    expect(dropSide(250, 0, 400)).toBe("right");
    expect(draggedPane(paneDragData(C))).toEqual(C);
    expect(draggedPane("{\"workspace_id\":\"w1\"}")).toBeNull();
    expect(draggedPane("not json")).toBeNull();
  });

  it("uses the exact midpoint on first entry, including an offset pane area", () => {
    expect(dropSide(299, 100, 400)).toBe("left");
    expect(dropSide(300, 100, 400)).toBe("right");
    expect(dropSide(301, 100, 400, null)).toBe("right");
  });

  it("keeps either preview side until the pointer crosses the 12px band", () => {
    expect(dropSide(212, 0, 400, "left")).toBe("left");
    expect(dropSide(213, 0, 400, "left")).toBe("right");
    expect(dropSide(188, 0, 400, "right")).toBe("right");
    expect(dropSide(187, 0, 400, "right")).toBe("left");
  });

  it("keeps the preview steady while the pointer moves back and forth around the middle", () => {
    let previous = dropSide(199, 0, 400);
    for (const x of [201, 198, 204, 212, 190]) {
      previous = dropSide(x, 0, 400, previous);
      expect(previous).toBe("left");
    }
    previous = dropSide(213, 0, 400, previous);
    expect(previous).toBe("right");
    for (const x of [205, 199, 201, 188]) {
      previous = dropSide(x, 0, 400, previous);
      expect(previous).toBe("right");
    }
  });

  it("puts a pane beside another on the side nearest the pointer, each edge's distance a share of the pane", () => {
    const pane = { left: 100, top: 50, width: 800, height: 200 };
    expect(besideSide(150, 150, pane)).toBe("left");
    expect(besideSide(850, 150, pane)).toBe("right");
    expect(besideSide(500, 70, pane)).toBe("up");
    expect(besideSide(500, 240, pane)).toBe("down");
    // 100px of an 800px width is nearer than 40px of a 200px height: each side takes a quarter of a wide pane too
    expect(besideSide(200, 90, pane)).toBe("left");
  });

  it("keeps the side shown where two sides' shares meet, as the halves keep theirs around the middle", () => {
    const pane = { left: 100, top: 50, width: 800, height: 200 };
    expect(besideSide(160, 66, pane)).toBe("left");
    expect(besideSide(160, 66, pane, "up")).toBe("up");
    expect(besideSide(160, 90, pane, "up")).toBe("left");
    expect(besideSide(500, 150, pane, "right")).toBe("right");
    expect(besideSide(500, 150, pane, "down")).toBe("down");
  });

  it("shrinks the band for narrow areas and caps it for wide ones", () => {
    expect(dropSide(30, 0, 40, "left")).toBe("left");
    expect(dropSide(31, 0, 40, "left")).toBe("right");
    expect(dropSide(10, 0, 40, "right")).toBe("right");
    expect(dropSide(9, 0, 40, "right")).toBe("left");
    expect(dropSide(1_012, 0, 2_000, "left")).toBe("left");
    expect(dropSide(1_013, 0, 2_000, "left")).toBe("right");
  });

  it("measures the band relative to an area with negative viewport coordinates", () => {
    expect(dropSide(-301, -500, 400)).toBe("left");
    expect(dropSide(-300, -500, 400)).toBe("right");
    expect(dropSide(-288, -500, 400, "left")).toBe("left");
    expect(dropSide(-287, -500, 400, "left")).toBe("right");
    expect(dropSide(-312, -500, 400, "right")).toBe("right");
    expect(dropSide(-313, -500, 400, "right")).toBe("left");
  });

  it("commits to the previewed half when released inside the band", () => {
    const preview = dropSide(205, 0, 400, "left");
    expect(preview).toBe("left");
    expect(dropSide(205, 0, 400)).toBe("right");
    const committed = dropSide(208, 0, 400, preview);
    const result = dockPane(null, A, B, sideZone(null, "a", committed)!)!;
    expect(slotSide(result.split!, result.split!.active)).toBe(preview);
    expect(result.select).toEqual(B);
  });
});

describe("split rows and columns", () => {
  const box = { left: 0, top: 0, width: 1000, height: 800 };

  it("opens a pane above or below the single one from a band along its top and bottom", () => {
    expect(dropZone(500, 100, box, null, "a")).toEqual({ slot: "a", edge: "top" });
    expect(dropZone(500, 700, box, null, "a")).toEqual({ slot: "a", edge: "bottom" });
    // the sides keep the halves' midpoint and its steady band
    expect(dropZone(100, 400, box, null, "a")).toEqual({ slot: "a", edge: "left" });
    expect(dropZone(505, 400, box, null, "a", { slot: "a", edge: "left" })).toEqual({ slot: "a", edge: "left" });
    expect(dropZone(500, 900, box, null, "a")).toBeNull();
  });

  it("opens a third pane beside, above or below a slot from its edge, and in its place from its middle", () => {
    const split = halves(A, "right", "b");
    // the right half, slot b, spans x 500-1000
    expect(dropZone(560, 400, box, split, "b")).toEqual({ slot: "b", edge: "left" });
    expect(dropZone(750, 700, box, split, "b")).toEqual({ slot: "b", edge: "bottom" });
    expect(dropZone(750, 400, box, split, "b")).toEqual({ slot: "b", edge: null });
    const below = dockPane(split, B, C, { slot: "b", edge: "bottom" })!;
    expect(below.select).toEqual(C);
    expect(below.split!.active).toBe("c");
    expect(slotsOf(below.split!.root)).toEqual(["a", "b", "c"]);
    expect(below.split!.panes).toEqual({ a: A, b: B });
    expect(slotRects(below.split!.root)).toEqual(new Map([
      ["a", { x: 0, y: 0, w: 0.5, h: 1 }],
      ["b", { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
      ["c", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
    ]));
    // three slots are no longer two halves side by side
    expect(slotSide(below.split!, "a")).toBeNull();
    expect(zoneRect({ slot: "b", edge: "bottom" }, split, "b")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("takes no new slot past the limit: a full area opens a pane in a slot's place", () => {
    let state: SplitState | null = null;
    let active = A;
    const panes = [B, C, D];
    for (const [index, pane] of panes.entries()) {
      const change: SplitChange = dockPane(state, active, pane, { slot: state?.active ?? "a", edge: "right" })!;
      state = change.split; active = change.select;
      expect(slotsOf(state!.root)).toHaveLength(index + 2);
    }
    expect(slotsOf(state!.root)).toHaveLength(MAX_SPLIT_SLOTS);
    expect(dockPane(state, active, A, { slot: state!.active, edge: "left" })).toBeNull();
    const rect = slotRects(state!.root).get(state!.active)!;
    // the very edge of the active slot, which would open beside it in a smaller split
    expect(dropZone((rect.x + 0.01) * 1000, (rect.y + rect.h / 2) * 800, box, state, "a")).toEqual({ slot: state!.active, edge: null });
  });

  it("closes a slot into its sibling's place, the active one's place going to its nearest slot", () => {
    const three = dockPane(halves(A, "right", "b"), B, C, { slot: "b", edge: "bottom" })!.split!;
    // closing the active c: b, its sibling, takes the right column again and is active
    const closed = closeSlots(three, C, new Set(["c"]))!;
    expect(closed).toEqual({ split: halves(A, "right", "b"), solo: "b", select: B });
    // closing another slot keeps the active one
    const left = closeSlots(three, C, new Set(["a"]))!;
    expect(left.select).toEqual(C);
    expect(left.split!.root).toEqual({ dir: "column", ratio: 0.5, first: { slot: "b" }, second: { slot: "c" } });
    // a slot whose pane is gone closes without touching the selection
    expect(withoutSlots(three, new Set(["a"]))).toEqual({ split: { ...three, root: left.split!.root, panes: { b: B } }, solo: "c" });
    expect(withoutSlots(three, new Set(["a", "b"]))).toEqual({ split: null, solo: "c" });
    // down to one slot ends the split in the slot that is left
    expect(closeSlots(halves(A, "right", "b"), B, new Set(["b"]))).toEqual({ split: null, solo: "a", select: A });
    expect(closeSlots(halves(A, "right", "b"), B, new Set(["a"]))).toEqual({ split: null, solo: "b", select: B });
  });

  it("opens a pane picked in another slot there and makes it active", () => {
    const three = dockPane(halves(A, "right", "b"), B, C, { slot: "b", edge: "bottom" })!.split!;
    const picked = pickInSlot(three, C, "a", D)!;
    expect(picked.select).toEqual(D);
    expect(picked.split!.active).toBe("a");
    expect(picked.split!.panes).toEqual({ b: B, c: C });
    expect(splitShows(picked.split, C)).toBe(true);
    expect(splitShows(picked.split, D)).toBe(false);
  });

  it("moves a boundary within its limits and lists every boundary with its area", () => {
    const three = dockPane(halves(A, "right", "b"), B, C, { slot: "b", edge: "bottom" })!.split!;
    expect(splitDividers(three.root).map(({ path, dir, area }) => ({ path, dir, area }))).toEqual([
      { path: "", dir: "row", area: { x: 0, y: 0, w: 1, h: 1 } },
      { path: "1", dir: "column", area: { x: 0.5, y: 0, w: 0.5, h: 1 } },
    ]);
    const wider = resizeSplit(three, "", 0.3);
    expect(slotRects(wider.root).get("b")).toEqual({ x: 0.3, y: 0, w: 0.7, h: 0.5 });
    expect((resizeSplit(three, "1", 0.01).root as { second: { ratio: number } }).second.ratio).toBe(0.15);
    expect((resizeSplit(three, "1", 0.99).root as { second: { ratio: number } }).second.ratio).toBe(0.85);
    expect(resizeSplit(three, "", Number.NaN)).toBe(three);
    expect(resizeSplit(three, "", 0.5)).toBe(three);
  });
});

describe("split storage", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storageKey = "ovis:split";

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  it("stores and restores the split in session storage, not local storage", () => {
    const session = new Map<string, string>();
    const local = new Map<string, string>();
    const storage = (entries: Map<string, string>) => ({
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: storage(session), localStorage: storage(local) },
    });

    const split = halves(A, "right", "b");
    storeSplit(split);
    expect(session.get(storageKey)).toBe(JSON.stringify(split));
    expect(local.has(storageKey)).toBe(false);
    expect(storedSplit()).toEqual(split);

    storeSplit(null);
    expect(session.has(storageKey)).toBe(false);
    expect(local.has(storageKey)).toBe(false);
  });

  it("opens a split kept by the two-half version, and a grid as it was left", () => {
    const session = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); }, removeItem: (key: string) => { session.delete(key); } } },
    });
    session.set(storageKey, JSON.stringify({ other: A, bSide: "left", active: "a" }));
    expect(storedSplit()).toEqual(halves(A, "left", "a"));
    const three = dockPane(halves(A, "right", "b"), B, C, { slot: "b", edge: "bottom" })!.split!;
    storeSplit(resizeSplit(three, "", 0.35));
    expect(storedSplit()).toEqual(resizeSplit(three, "", 0.35));
    // a broken or foreign value opens no split
    for (const value of [
      { other: A, bSide: "up", active: "a" },
      { root: { slot: "a" }, panes: {}, active: "a" },
      { root: { dir: "row", ratio: 0.5, first: { slot: "a" }, second: { slot: "a" } }, panes: {}, active: "a" },
      { root: { dir: "row", ratio: 0.01, first: { slot: "a" }, second: { slot: "b" } }, panes: { b: A }, active: "a" },
      { root: { dir: "row", ratio: 0.5, first: { slot: "a" }, second: { slot: "b" } }, panes: {}, active: "a" },
      { root: { dir: "row", ratio: 0.5, first: { slot: "A1" }, second: { slot: "b" } }, panes: { b: A }, active: "A1" },
    ]) {
      session.set(storageKey, JSON.stringify(value));
      expect(storedSplit()).toBeNull();
    }
  });

  it("keeps storage access failures non-fatal", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        sessionStorage: {
          getItem() { throw new Error("storage denied"); },
          setItem() { throw new Error("storage denied"); },
          removeItem() { throw new Error("storage denied"); },
        },
      },
    });

    expect(storedSplit()).toBeNull();
    expect(() => storeSplit(halves(A, "right", "b"))).not.toThrow();
    expect(() => storeSplit(null)).not.toThrow();
  });
});
