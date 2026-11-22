import { describe, expect, it } from "bun:test";

import { clampSidebarWidth, keyedSidebarWidth, parseSidebarWidth, sidebarMaxWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH_STEP } from "./sidebarWidth.ts";

describe("clampSidebarWidth", () => {
  it("keeps the width between the two limits, in whole pixels", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(333.6)).toBe(334);
  });

  it("never lets the sidebar take more than half of a narrow window", () => {
    expect(sidebarMaxWidth(800)).toBe(400);
    expect(clampSidebarWidth(480, 800)).toBe(400);
    expect(clampSidebarWidth(480, 300)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe("keyedSidebarWidth", () => {
  it("moves the edge a step with the arrows and to a limit with Home and End", () => {
    expect(keyedSidebarWidth(320, "ArrowRight")).toBe(320 + SIDEBAR_WIDTH_STEP);
    expect(keyedSidebarWidth(320, "ArrowLeft")).toBe(320 - SIDEBAR_WIDTH_STEP);
    expect(keyedSidebarWidth(SIDEBAR_MIN_WIDTH, "ArrowLeft")).toBe(SIDEBAR_MIN_WIDTH);
    expect(keyedSidebarWidth(320, "Home")).toBe(SIDEBAR_MIN_WIDTH);
    expect(keyedSidebarWidth(320, "End", 900)).toBe(450);
  });

  it("leaves every other key alone", () => {
    expect(keyedSidebarWidth(320, "Enter")).toBeNull();
    expect(keyedSidebarWidth(320, "a")).toBeNull();
  });
});

describe("parseSidebarWidth", () => {
  it("reads a stored width and clamps it", () => {
    expect(parseSidebarWidth("360")).toBe(360);
    expect(parseSidebarWidth("12")).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("falls back to the default width for anything else", () => {
    expect(parseSidebarWidth(null)).toBeNull();
    expect(parseSidebarWidth("")).toBeNull();
    expect(parseSidebarWidth("wide")).toBeNull();
    expect(parseSidebarWidth("320px")).toBeNull();
  });
});
