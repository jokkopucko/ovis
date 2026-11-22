import { describe, expect, it } from "bun:test";
import { SCROLL_POLL_BUSY_MS, SCROLL_POLL_FOLLOW_MS, SCROLL_POLL_IDLE_MAX_MS, idleScrollPollDelay, scrollPollDelay, validScroll, visibleFindRects, visibleTerminalInputBounds, type CellReader } from "./terminalViewport.ts";
const scroll = { max_offset_from_bottom: 100, offset_from_bottom: 20, viewport_rows: 2 };
const cells = (lines: string[]): CellReader => (row, col) => ({ chars: lines[row]?.[col] ?? " ", width: 1 });

describe("terminal input viewport bounds", () => {
  it("expresses the host's visible area relative to a horizontally panned xterm screen", () => {
    expect(visibleTerminalInputBounds(
      { left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200 },
      { left: 50, top: 80, right: 850, bottom: 480, width: 800, height: 400 },
    )).toEqual({ left: 50, top: 20, right: 350, bottom: 220 });
  });
  it("clips the visible area to the screen and keeps empty intersections ordered", () => {
    expect(visibleTerminalInputBounds(
      { left: -20, top: 10, right: 20, bottom: 40, width: 40, height: 30 },
      { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    )).toEqual({ left: 0, top: 10, right: 20, bottom: 40 });
    expect(visibleTerminalInputBounds(
      { left: 140, top: 120, right: 180, bottom: 160, width: 40, height: 40 },
      { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    )).toEqual({ left: 100, top: 100, right: 100, bottom: 100 });
  });
});

describe("herdr viewport overlay", () => {
  it("maps a native wrapped range without using lost xterm wrap flags", () => {
    const match = { start: { row: 80, col: 3 }, end: { row: 81, col: 1 } };
    expect(visibleFindRects([match], scroll, "abcd", 5, 2, cells(["   ab", "cd   "]), match)).toEqual([
      { row: 0, col: 3, width: 2, current: true }, { row: 1, col: 0, width: 2, current: true },
    ]);
    expect(visibleFindRects([match], scroll, "abcd", 5, 2, cells(["   xy", "cd   "]), match)).toEqual([]);
  });
  it("keeps wide/combining cells whole, without normalizing text", () => {
    const read: CellReader = (row, col) => row === 0 ? [{ chars: "한", width: 2 }, { chars: "", width: 0 }, { chars: "e\u0301", width: 1 }][col] : undefined;
    const range = { start: { row: 80, col: 0 }, end: { row: 80, col: 2 } };
    expect(visibleFindRects([range], scroll, "한e\u0301", 3, 2, read)).toHaveLength(1);
    expect(visibleFindRects([range], scroll, "한é", 3, 2, read)).toEqual([]);
    expect(visibleFindRects([{ start: { row: 80, col: 2 }, end: { row: 80, col: 2 } }], scroll, "e", 3, 2, read)).toEqual([]);
    expect(visibleFindRects([{ start: { row: 80, col: 0 }, end: { row: 80, col: 0 } }], scroll, "한", 3, 2, read)).toEqual([]);
  });
  it("uses smart case and treats metacharacters literally", () => {
    const range = { start: { row: 80, col: 0 }, end: { row: 80, col: 2 } };
    expect(visibleFindRects([range], scroll, "a.b", 3, 2, cells(["A.B"]))).toHaveLength(1);
    expect(visibleFindRects([range], scroll, "A.b", 3, 2, cells(["a.b"]))).toEqual([]);
    expect(visibleFindRects([range], scroll, "a.b", 3, 2, cells(["axb"]))).toEqual([]);
  });
  it("rejects mismatched geometry and stale cells, clips history safely", () => {
    const range = { start: { row: 79, col: 3 }, end: { row: 80, col: 1 } };
    expect(visibleFindRects([range], scroll, "abcd", 5, 2, cells(["cd"]))).toHaveLength(1);
    expect(visibleFindRects([range], scroll, "abcd", 5, 3, cells(["cd"]))).toEqual([]);
    expect(visibleFindRects([range], scroll, "abcd", 5, 2, cells(["xx"]))).toEqual([]);
  });
});
describe("shared history metrics", () => {
  it("rejects impossible remote metrics", () => {
    expect(validScroll(scroll)).toBe(true);
    expect(validScroll({ ...scroll, viewport_rows: 0 })).toBe(false);
    expect(validScroll({ ...scroll, offset_from_bottom: 101 })).toBe(false);
    expect(validScroll({ ...scroll, max_offset_from_bottom: Infinity })).toBe(false);
  });
});

describe("scroll metrics poll", () => {
  it("backs off an idle pane from 1 s to a 15 s cap instead of asking herdr every second", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(idleScrollPollDelay)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    expect(idleScrollPollDelay(1e6)).toBe(SCROLL_POLL_IDLE_MAX_MS);
  });
  it("starts over at the first step for a reset or a nonsense count", () => {
    for (const reads of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(idleScrollPollDelay(reads)).toBe(1000);
    expect(idleScrollPollDelay(1.7)).toBe(2000);
  });
  it("keeps a 1 s read while scrolled up into history, where growing history may send no output", () => {
    const up = { max_offset_from_bottom: 100, offset_from_bottom: 20, viewport_rows: 24 };
    for (const reads of [0, 3, 20]) expect(scrollPollDelay(false, reads, up)).toBe(1000);
    expect(scrollPollDelay(true, 20, up)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(false, 20, { ...up, offset_from_bottom: 0 })).toBe(SCROLL_POLL_IDLE_MAX_MS);
    expect(scrollPollDelay(false, 20, null)).toBe(SCROLL_POLL_IDLE_MAX_MS);
    expect(scrollPollDelay(false, 20, { ...up, offset_from_bottom: 200 })).toBe(SCROLL_POLL_IDLE_MAX_MS);
  });
  it("reads a view following the bottom at the follow pace while only output moves it", () => {
    const bottom = { max_offset_from_bottom: 100, offset_from_bottom: 0, viewport_rows: 24 };
    expect(scrollPollDelay(true, 0, bottom, true)).toBe(SCROLL_POLL_FOLLOW_MS);
    expect(scrollPollDelay(true, 0, bottom, false)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(true, 0, bottom)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(true, 0, { ...bottom, offset_from_bottom: 5 }, true)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(true, 0, null, true)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(true, 0, { ...bottom, offset_from_bottom: 200 }, true)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(true, 0, { ...bottom, max_offset_from_bottom: 0 }, true)).toBe(SCROLL_POLL_FOLLOW_MS);
    expect(scrollPollDelay(false, 20, bottom, true)).toBe(SCROLL_POLL_IDLE_MAX_MS);
  });
  it("keeps a held page on the busy cadence even at the bottom of an alternate screen", () => {
    const bottom = { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 24 };
    expect(scrollPollDelay(true, 0, bottom, false)).toBe(SCROLL_POLL_BUSY_MS);
  });
  it("uses the busy cadence for a failed or invalid current read despite output-only activity", () => {
    for (const metrics of [null, undefined, { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 0 }]) {
      expect(scrollPollDelay(true, 0, metrics, true)).toBe(SCROLL_POLL_BUSY_MS);
    }
  });
  it("keeps the follow pace between the busy cadence and the idle cap", () => {
    expect(SCROLL_POLL_FOLLOW_MS).toBeGreaterThan(SCROLL_POLL_BUSY_MS);
    expect(SCROLL_POLL_FOLLOW_MS).toBeLessThan(SCROLL_POLL_IDLE_MAX_MS);
  });
  it("keeps the busy cadence below the first idle step", () => {
    expect(SCROLL_POLL_BUSY_MS).toBeLessThan(idleScrollPollDelay(0));
  });
});
