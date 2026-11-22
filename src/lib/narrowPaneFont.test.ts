import { describe, expect, it } from "bun:test";

import { narrowPaneFontSize } from "./narrowPaneFont.ts";

const pane = (width: number) => (size: number): number => Math.floor(width / (size * 0.6));

describe("narrowPaneFontSize", () => {
  it("keeps the user's size in a pane that already has 80 columns", () => {
    expect(narrowPaneFontSize(13, pane(700))).toBe(13);
  });

  it("keeps the user's chosen size when a split narrows below 80 columns", () => {
    const colsAt = pane(565);
    expect(colsAt(13)).toBe(72);
    expect(narrowPaneFontSize(13, colsAt)).toBe(13);
    expect(narrowPaneFontSize(16, colsAt)).toBe(16);
  });

  it("keeps the user's size at intermediate and narrow widths", () => {
    expect(narrowPaneFontSize(13, pane(580))).toBe(13);
    expect(narrowPaneFontSize(13, pane(480))).toBe(13);
    expect(narrowPaneFontSize(13, pane(470))).toBe(13);
    expect(narrowPaneFontSize(13, pane(200))).toBe(13);
  });

  it("keeps the user's size while the pane is not laid out", () => {
    expect(narrowPaneFontSize(13, () => null)).toBe(13);
  });
});
