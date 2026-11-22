import { describe, expect, test } from "bun:test";
import { STRIP_AT_REST, stripPlaced, stripScrolled, stripSelected } from "./tabStripScroll.ts";

describe("whose scroll moved the tab strip", () => {
  const placed = stripPlaced(STRIP_AT_REST, 240);

  test("the scroll event of the strip's own placing is not the user's", () => {
    expect(stripScrolled(placed, 240, 600)).toBe(placed);
  });

  test("a scroll that ends anywhere else is the user's, to either side", () => {
    expect(stripScrolled(placed, 0, 600)).toEqual({ at: 0, moved: true });
    expect(stripScrolled(placed, 600, 600).moved).toBe(true);
    expect(stripScrolled(placed, 239.5, 600).moved).toBe(true);
  });

  test("a strip that never placed itself was scrolled by the user", () => {
    expect(stripScrolled(STRIP_AT_REST, 12, 600).moved).toBe(true);
  });

  test("a row that got shorter and was pulled back to its new end is not the user's, and the strip is known to be there", () => {
    const pulled = stripScrolled(placed, 200, 200);
    expect(pulled).toEqual({ at: 200, moved: false });
    expect(stripScrolled(pulled, 200, 200).moved).toBe(false);
    expect(stripScrolled(pulled, 120, 200).moved).toBe(true);
  });

  test("the user's scroll stays theirs through the strip's later events, until another tab is opened", () => {
    let strip = stripScrolled(placed, 0, 600);
    strip = stripScrolled(strip, 240, 600);
    expect(strip.moved).toBe(true);
    strip = stripPlaced(strip, 300);
    expect(strip.moved).toBe(true);
    strip = stripPlaced(stripSelected(strip), 480);
    expect(strip).toEqual({ at: 480, moved: false });
    expect(stripScrolled(strip, 480, 600).moved).toBe(false);
  });

  test("a tab opened where the strip already showed it: the user's next scroll is still seen", () => {
    const opened = stripSelected(stripScrolled(stripPlaced(STRIP_AT_REST, 0), 600, 600));
    expect(opened).toEqual({ at: 600, moved: false });
    expect(stripScrolled(opened, 0, 600).moved).toBe(true);
  });
});
