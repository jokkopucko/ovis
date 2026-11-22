import { describe, expect, test } from "bun:test";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "./wheelSteps.ts";

function reports(moves: number[], cellHeight: number): number {
  let pixels = 0;
  let sent = 0;
  for (const move of moves) {
    const { steps, rest } = wheelSteps(pixels + move, cellHeight * HERDR_MOUSE_SCROLL_LINES);
    pixels = rest;
    sent += steps;
  }
  return sent;
}

describe("wheelSteps", () => {
  test("a fast swipe sends as many reports as a slow drag over the same distance", () => {
    const fast = reports(Array(5).fill(60), 20);
    const slow = reports(Array(30).fill(10), 20);
    expect(fast).toBe(slow);
    expect(fast).toBe(5);
  });

  test("the report count follows finger travel, not the number of moves", () => {
    expect(reports([300], 20)).toBe(5);
    expect(reports(Array(300).fill(1), 20)).toBe(5);
  });

  test("steps keep the direction and the rest carries to the next move", () => {
    expect(wheelSteps(130, 60)).toEqual({ steps: 2, rest: 10 });
    expect(wheelSteps(-130, 60)).toEqual({ steps: -2, rest: -10 });
    expect(wheelSteps(59, 60)).toEqual({ steps: 0, rest: 59 });
  });

  test("a reversal pays back the gathered travel before scrolling the other way", () => {
    expect(reports([50, -50, -50], 20)).toBe(0);
    expect(reports([50, -50, -130], 20)).toBe(-2);
  });

  test("an unlaid-out terminal makes no steps", () => {
    expect(wheelSteps(500, 0)).toEqual({ steps: 0, rest: 0 });
    expect(wheelSteps(500, Number.NaN)).toEqual({ steps: 0, rest: 0 });
  });
});

describe("finalStep", () => {
  test("half a step or more left at the lift sends one more report in its direction", () => {
    expect(finalStep(36, 60)).toBe(1);
    expect(finalStep(30, 60)).toBe(1);
    expect(finalStep(-36, 60)).toBe(-1);
  });

  test("less than half a step left sends nothing", () => {
    expect(finalStep(24, 60)).toBe(0);
    expect(finalStep(-24, 60)).toBe(0);
    expect(finalStep(0, 60)).toBe(0);
  });

  test("an unlaid-out terminal makes no step", () => {
    expect(finalStep(36, 0)).toBe(0);
    expect(finalStep(Number.NaN, 60)).toBe(0);
  });
});
