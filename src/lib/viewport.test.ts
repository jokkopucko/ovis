import { describe, expect, test } from "bun:test";
import { keyboardHoldsGrid, keyboardViewportReference } from "./keyboard.ts";

describe("keyboard viewport reference", () => {
  test("Android layout and lvh shrink retains the unobstructed grid (regression: fails on main)", () => {
    // Given: the measured Chrome 133 viewport before opening Gboard.
    const remembered = { large: 790, height: 790 };
    // When: resizes-content shrinks the visual/layout viewport and the lvh ruler.
    const reference = keyboardViewportReference(477, 533, 477, remembered, true);
    expect(reference).toBe(790);
    expect(keyboardHoldsGrid(reference - 477 > reference * 0.2, 390, 390)).toBe(true);
  });

  test("iOS visual-only keyboard shrink retains the grid (control)", () => {
    const reference = keyboardViewportReference(472, 852, 852, { large: 852, height: 852 }, true);
    expect(reference).toBe(852);
    expect(keyboardHoldsGrid(reference - 472 > reference * 0.2, 393, 393)).toBe(true);
  });

  test("dismissal with a focused field restores the full viewport (control)", () => {
    const reference = keyboardViewportReference(790, 790, 790, { large: 790, height: 790 }, true);
    expect(reference).toBe(790);
    expect(keyboardHoldsGrid(reference - 790 > reference * 0.2, 390, 390)).toBe(false);
  });

  test("rotation uses the new width's baseline and refits (control)", () => {
    const heights = new Map([[393, { large: 852, height: 852 }]]);
    const reference = keyboardViewportReference(372, 393, 393, heights.get(852), true);
    expect(reference).toBe(393);
    expect(keyboardHoldsGrid(reference - 372 > reference * 0.2, 852, 393)).toBe(false);
  });

  test("a focused split view with a visual inset replaces the old height (control)", () => {
    const reference = keyboardViewportReference(576, 600, 600, { large: 1000, height: 1000 }, true);
    expect(reference).toBe(600);
    expect(keyboardHoldsGrid(reference - 576 > reference * 0.2, 393, 393)).toBe(false);
  });

  test("an unfocused window shrink replaces its unobstructed baseline (control)", () => {
    const reference = keyboardViewportReference(477, 533, 477, { large: 790, height: 790 }, false);
    expect(reference).toBe(533);
    expect(keyboardHoldsGrid(false, 390, 390)).toBe(false);
  });

  test("a window resize without a visual inset accepts the smaller height (regression: fails on main)", () => {
    const reference = keyboardViewportReference(500, 500, 500, { large: 800, height: 800 }, false);
    expect(reference).toBe(500);
  });
});
