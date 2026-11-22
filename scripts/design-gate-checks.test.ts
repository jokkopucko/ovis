import { describe, expect, it } from "bun:test";
import { moves, ringOwner, targetVerdict, walkFocus, type FocusDriver, type FocusStop, type Layout, type RingRead } from "./design-gate-checks.ts";

function fakePage(start: FocusStop<string>, order: FocusStop<string>[]): FocusDriver<string> & { presses: () => number } {
  let at = -1;
  return {
    current: () => Promise.resolve(start),
    tab: () => { at += 1; return Promise.resolve(order[at % order.length]!); },
    presses: () => at + 1,
  };
}
const stop = (id: number): FocusStop<string> => ({ id, verdict: `control ${id}` });

describe("design gate focus walk", () => {
  it("measures the initially focused control and every stop of a cycle longer than 25", async () => {
    const controls = Array.from({ length: 40 }, (_, index) => stop(index + 1));
    const page = fakePage(controls[0]!, [...controls.slice(1), controls[0]!]);
    const walk = await walkFocus(page, 200);
    expect(walk.complete).toBe(true);
    expect([...walk.verdicts.keys()].sort((a, b) => a - b)).toEqual(controls.map((control) => control.id ?? 0));
    expect(page.presses()).toBe(40);
  });
  it("closes the cycle after focus leaves the page past the last stop", async () => {
    const page = fakePage({ id: null }, [stop(1), stop(2), { id: null }, stop(1)]);
    const walk = await walkFocus(page, 200);
    expect(walk).toMatchObject({ complete: true, presses: 4 });
    expect([...walk.verdicts.keys()]).toEqual([1, 2]);
  });
  it("reports an incomplete walk when focus never returns within the ceiling", async () => {
    let next = 0;
    const endless: FocusDriver<string> = { current: () => Promise.resolve({ id: null }), tab: () => Promise.resolve(stop((next += 1))) };
    const walk = await walkFocus(endless, 200);
    expect(walk).toMatchObject({ complete: false, presses: 200 });
  });
});

describe("design gate focus ring owner", () => {
  const plain: RingRead = { outline: "none 0px rgb(0, 0, 0) 0px", boxShadow: "none", border: "solid 1px rgb(200, 200, 200)" };
  const lit: RingRead = { ...plain, boxShadow: "rgb(140, 80, 0) 0px 0px 0px 2px" };
  const drawn = { outline: false, boxShadow: true, border: true };
  it("credits the first wrapper whose drawn ring changes with focus, the control's own ring first", () => {
    const textarea = { focused: plain, blurred: { ...plain, outline: "none 3px rgb(0, 0, 0) 0px" }, drawn: { ...drawn, boxShadow: false } };
    expect(ringOwner(false, [textarea, { focused: plain, blurred: plain, drawn }, { focused: lit, blurred: plain, drawn }])).toEqual({ on: "ancestor", index: 2, changed: ["boxShadow"] });
    expect(ringOwner(true, [{ focused: lit, blurred: plain, drawn }])).toEqual({ on: "self" });
    expect(ringOwner(false, [{ focused: plain, blurred: plain, drawn }])).toEqual({ on: null });
  });
});

describe("design gate layout comparison", () => {
  const before: Layout = {
    "main-chat|1440|light": { header: { x: 0, y: 0, w: 10, h: 10 }, gear: { x: 5, y: 5, w: 4, h: 4 } },
    "sidebar|1440|light": { gear: { x: 5, y: 5, w: 4, h: 4 } },
  };
  const sidebarOnly: Layout = { "sidebar|1440|light": { gear: { x: 5, y: 5, w: 4, h: 4 } } };
  it("reports every anchor of a lost baseline visit unless a narrowed run did not ask for it", () => {
    const lost = ["MOVED header main-chat 1440 light missing missing", "MOVED gear main-chat 1440 light missing missing"];
    expect(moves(before, sidebarOnly, { requested: new Set(Object.keys(before)), narrowed: false, tolerance: 2 })).toEqual(lost);
    expect(moves(before, sidebarOnly, { requested: new Set(Object.keys(before)), narrowed: true, tolerance: 2 })).toEqual(lost);
    expect(moves(before, sidebarOnly, { requested: new Set(["sidebar|1440|light"]), narrowed: true, tolerance: 2 })).toEqual([]);
  });
  it("reports every anchor of a visit the baseline does not have as added, as it does a new anchor of a baselined visit", () => {
    const now: Layout = { ...before, "drawer-open|390|dark": { gear: { x: 1, y: 2, w: 4, h: 4 } } };
    const requested = new Set(Object.keys(now));
    expect(moves(sidebarOnly, now, { requested, narrowed: false, tolerance: 2 })).toEqual([
      "MOVED header main-chat 1440 light added added",
      "MOVED gear main-chat 1440 light added added",
      "MOVED gear drawer-open 390 dark added added",
    ]);
  });
});

describe("design gate effective target", () => {
  const gear = { left: 12, top: 792, width: 34, height: 44 };
  const inside = (left: number, right: number) => (x: number, y: number): boolean => x >= left && x <= right && y >= gear.top && y <= gear.top + gear.height;
  it("passes a small box whose expander owns all five points of the 44x44 square, and names the method", () => {
    expect(targetVerdict(gear, 44, inside(gear.left - 10, gear.left + gear.width))).toEqual({ method: "effective", hits: 5 });
    expect(targetVerdict({ ...gear, width: 44 }, 44, () => false)).toEqual({ method: "box", hits: 5 });
  });
  it("fails a small box whose own box is all that hits", () => {
    expect(targetVerdict(gear, 44, inside(gear.left, gear.left + gear.width))).toEqual({ method: null, hits: 1 });
  });
  it.each([
    { width: 43, height: 44, min: 44, rasterOverlap: 0 },
    { width: 44, height: 43, min: 44, rasterOverlap: 0 },
    { width: 16, height: 16, min: 44, rasterOverlap: 0 },
    { width: 23, height: 24, min: 24, rasterOverlap: 0 },
    { width: 24, height: 23, min: 24, rasterOverlap: 0 },
    { width: 43, height: 44, min: 44, rasterOverlap: 1 },
    { width: 44, height: 43, min: 44, rasterOverlap: 1 },
  ])("rejects an unexpanded $width x $height target against the $min floor with $rasterOverlap px raster overlap", ({ width, height, min, rasterOverlap }) => {
    const box = { left: 12, top: 80, width, height };
    // Chromium's point hit test also intersects the pixel immediately before the left/top edge.
    const owns = (x: number, y: number) => x > box.left - rasterOverlap && x < box.left + width && y > box.top - rasterOverlap && y < box.top + height;
    expect(targetVerdict(box, min, owns).method).toBeNull();
  });
  it("accepts the gear expander with fractional coordinates and exclusive far edges", () => {
    const box = { ...gear, left: gear.left + 0.125, top: gear.top + 0.125 };
    const owns = (x: number, y: number) => x >= box.left - 10 && x < box.left + box.width && y >= box.top && y < box.top + box.height;
    expect(targetVerdict(box, 44, owns)).toEqual({ method: "effective", hits: 5 });
  });
});
