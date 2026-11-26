import { describe, expect, test } from "bun:test";
import { attachTerminalWheel, canPanTerminalGrid } from "./terminalWheel.ts";

function fixture(mirrored = true, adopted = true, omoQuestion = false, drag = false, pan = false) {
  let handle!: (event: WheelEvent) => boolean;
  const lines: number[] = [];
  let cleared = false;
  const term = {
    attachCustomWheelEventHandler(handler: typeof handle) { handle = handler; },
    hasSelection: () => true,
    clearSelection() { cleared = true; },
    modes: { mouseTrackingMode: "none" as const, bracketedPasteMode: false, synchronizedOutputMode: false, applicationCursorKeysMode: false, applicationKeypadMode: false, sendFocusMode: false },
  };
  attachTerminalWheel(term, { current: { speed: 2, omoQuestion } }, {
    drag: () => drag, pan: () => pan, adopted: () => adopted, mirrored: () => mirrored,
    scroll: (count) => lines.push(count),
  });
  const wheel = (deltaY: number, isTrusted = true, ctrlKey = false, shiftKey = false, deltaX = 0) => {
    let prevented = false;
    const result = handle({ deltaX, deltaY, isTrusted, ctrlKey, shiftKey,
      preventDefault() { prevented = true; },
    } as WheelEvent);
    return { result, prevented };
  };
  return { lines, wheel, cleared: () => cleared };
}

describe("fixed grid local pan", () => {
  test("pans only where the larger grid has more cells to reveal", () => {
    const view = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };
    expect(canPanTerminalGrid(view, -120)).toBe(true);
    expect(canPanTerminalGrid(view, 120)).toBe(true);
    expect(canPanTerminalGrid(view, 0)).toBe(false);
    expect(canPanTerminalGrid({ ...view, scrollTop: 0 }, -120)).toBe(false);
    expect(canPanTerminalGrid({ ...view, scrollTop: 400 }, 120)).toBe(false);
    expect(canPanTerminalGrid({ ...view, scrollTop: 399.5 }, 120)).toBe(false);
    expect(canPanTerminalGrid({ ...view, scrollTop: 0.5 }, -120)).toBe(false);
    expect(canPanTerminalGrid({ ...view, scrollTop: 0, clientHeight: 600 }, 120)).toBe(false);
  });
});

describe("terminal mirror wheel", () => {
  test("an interactive fixed mirror scrolls history in both directions without mouse reporting", () => {
    const f = fixture();
    expect(f.wheel(-120)).toEqual({ result: false, prevented: true });
    f.wheel(120);
    expect(f.lines).toEqual([6, -6]);
    expect(f.cleared()).toBe(true);
  });

  test("synthetic touch steps are not multiplied by wheel speed", () => {
    const f = fixture();
    f.wheel(-1, false);
    expect(f.lines).toEqual([3]);
  });

  test("zero delta, pinch and horizontal shift-wheel do not move history", () => {
    const f = fixture();
    f.wheel(0);
    f.wheel(-120, true, true);
    f.wheel(-120, true, false, true);
    expect(f.lines).toEqual([]);
  });

  test("a sideways wheel leaves a mirror's wide grid to the browser's own pan", () => {
    const f = fixture();
    expect(f.wheel(0, true, false, false, 120)).toEqual({ result: false, prevented: false });
    expect(f.lines).toEqual([]);
    expect(f.cleared()).toBe(false);
  });

  test("observer grids and selecting drags retain their existing routing", () => {
    for (const f of [fixture(false, true), fixture(true, true, false, true), fixture(true, true, false, false, true)]) {
      f.wheel(-120);
      expect(f.lines).toEqual([]);
      expect(f.cleared()).toBe(false);
    }
  });

  test("the existing OmO question path still scrolls non-mirrored history", () => {
    const f = fixture(false, false, true);
    f.wheel(-120);
    expect(f.lines).toEqual([6]);
  });

  test("ordinary non-reporting terminals do not receive fallback keys or API scrolls", () => {
    const f = fixture(false, false);
    expect(f.wheel(-120).result).toBe(false);
    expect(f.lines).toEqual([]);
  });
});
