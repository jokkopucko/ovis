import { describe, expect, it } from "bun:test";

import { clampSplit, keyedSplit, parseSidebarSplit, sectionAt, splitBounds, splitDrag, splitPercent, splitSnap, type SplitRoom } from "./sidebarSplit.ts";

const ROOM: SplitRoom = { topHead: 42, bottomHead: 42, room: 600, row: 34, topRow: 34, bottomRow: 34 };

describe("splitDrag", () => {
  it("previews the height a release saves", () => {
    expect(splitDrag(70, ROOM)).toEqual({ snap: null, height: 76, shown: 76 });
    expect(splitDrag(530, ROOM)).toEqual({ snap: null, height: 524, shown: 524 });
    expect(splitDrag(300, ROOM)).toEqual({ snap: null, height: 300, shown: 300 });
  });

  it("previews a snapping section at its head", () => {
    expect(splitDrag(50, ROOM)).toMatchObject({ snap: "top", shown: 42 });
    expect(splitDrag(550, ROOM)).toMatchObject({ snap: "bottom", shown: 558 });
  });
});

describe("splitPercent", () => {
  it("stays within the separator's 0-100 range in a window shorter than the heads", () => {
    expect(splitPercent(150, 600)).toBe(25);
    expect(splitPercent(52, 30)).toBe(100);
    expect(splitPercent(-22, 30)).toBe(0);
    expect(splitPercent(10, 0)).toBe(0);
  });
});

describe("splitBounds and clampSplit", () => {
  it("keeps a head and a row of each section in view", () => {
    expect(splitBounds(ROOM)).toEqual({ min: 76, max: 524 });
    expect(clampSplit(10, ROOM)).toBe(76);
    expect(clampSplit(900, ROOM)).toBe(524);
    expect(clampSplit(300.4, ROOM)).toBe(300);
  });

  it("clamps a kept split to a window too short for it", () => {
    expect(clampSplit(480, { ...ROOM, room: 300 })).toBe(224);
    expect(splitBounds({ ...ROOM, room: 100 })).toEqual({ min: 50, max: 50 });
    expect(splitBounds({ ...ROOM, room: 60 })).toEqual({ min: 30, max: 30 });
    expect(clampSplit(2000, { ...ROOM, room: 60 })).toBe(30);
  });
});

describe("splitSnap", () => {
  it("chooses the nearer heading where a short window's snap zones overlap", () => {
    const short = { ...ROOM, room: 100 };
    expect(splitSnap(47, short)).toBe("top");
    expect(splitSnap(53, short)).toBe("bottom");
    expect(splitSnap(50, short)).toBe("top");
  });

  it("folds the section dragged under about a row, and neither in between", () => {
    expect(splitSnap(50, ROOM)).toBe("top");
    expect(splitSnap(70, ROOM)).toBeNull();
    expect(splitSnap(300, ROOM)).toBeNull();
    expect(splitSnap(540, ROOM)).toBe("bottom");
  });

  it("never folds a section with no head (the PCs)", () => {
    expect(splitSnap(5, { ...ROOM, topHead: 0 })).toBeNull();
    expect(splitSnap(595, { ...ROOM, bottomHead: 0 })).toBeNull();
    expect(splitSnap(595, { ...ROOM, topHead: 0 })).toBe("bottom");
  });
});

describe("sectionAt", () => {
  it("names the section on each side of the line for either order", () => {
    expect([sectionAt("top", "pcs"), sectionAt("bottom", "pcs")]).toEqual(["pcs", "agents"]);
    expect([sectionAt("top", "agents"), sectionAt("bottom", "agents")]).toEqual(["agents", "pcs"]);
  });
});

describe("keyedSplit", () => {
  it("moves the line a row with the arrows, folds with Home and End, resets with Enter", () => {
    expect(keyedSplit(300, "ArrowUp", ROOM)).toEqual({ split: 266 });
    expect(keyedSplit(300, "ArrowDown", ROOM)).toEqual({ split: 334 });
    expect(keyedSplit(80, "ArrowUp", ROOM)).toEqual({ split: 76 });
    expect(keyedSplit(300, "Home", ROOM)).toEqual({ fold: "top" });
    expect(keyedSplit(300, "End", ROOM)).toEqual({ fold: "bottom" });
    expect(keyedSplit(300, "Enter", ROOM)).toEqual({ reset: true });
    expect(keyedSplit(300, "a", ROOM)).toBeNull();
  });

  it("takes a section with no head (the PCs) to its minimum on Home or End instead of folding it", () => {
    expect(keyedSplit(300, "Home", { ...ROOM, topHead: 0 })).toEqual({ split: 34 });
    expect(keyedSplit(300, "End", { ...ROOM, bottomHead: 0 })).toEqual({ split: 566 });
  });
});

describe("parseSidebarSplit", () => {
  it("reads a whole number of px, and nothing else", () => {
    expect(parseSidebarSplit("320")).toBe(320);
    expect(parseSidebarSplit(null)).toBeNull();
    expect(parseSidebarSplit("0")).toBeNull();
    expect(parseSidebarSplit("-5")).toBeNull();
    expect(parseSidebarSplit("12.5")).toBeNull();
    expect(parseSidebarSplit("99999")).toBeNull();
    expect(parseSidebarSplit("tall")).toBeNull();
  });
});
