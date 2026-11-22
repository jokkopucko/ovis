import { describe, expect, test } from "bun:test";
import { createTouchWheelPacer, type FrameClock, TOUCH_WHEEL_QUEUE_LIMIT, TOUCH_WHEEL_REPORTS_PER_FRAME } from "./touchWheelPacer.ts";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "./wheelSteps.ts";

const FRAME_MS = 1000 / 60;

function controlledFrames() {
  let callbacks = new Map<number, () => void>();
  let next = 1;
  let index = 0;
  const clock: FrameClock = {
    request(callback) { callbacks.set(next, callback); return next++; },
    cancel(handle) { callbacks.delete(handle); },
  };
  return {
    clock,
    get index() { return index; },
    get waiting() { return callbacks.size; },
    frame() {
      index += 1;
      const due = callbacks;
      callbacks = new Map();
      for (const callback of due.values()) callback();
    },
  };
}

function harness() {
  const frames = controlledFrames();
  const pacer = createTouchWheelPacer(frames.clock);
  const sent: Array<{ sign: -1 | 1; frame: number }> = [];
  let allowed = true;
  const target = { emit: (sign: -1 | 1) => { sent.push({ sign, frame: frames.index }); }, allowed: () => allowed };
  const perFrame = () => {
    const counts = new Map<number, number>();
    for (const report of sent) counts.set(report.frame, (counts.get(report.frame) ?? 0) + 1);
    return [...counts.values()];
  };
  const drain = () => { while (frames.waiting > 0) frames.frame(); };
  return { frames, pacer, sent, target, perFrame, drain, deny() { allowed = false; } };
}

function gesture(moves: number[], cellHeight: number): number[][] {
  const stepPixels = cellHeight * HERDR_MOUSE_SCROLL_LINES;
  let pixels = 0;
  const batches: number[][] = [];
  for (const move of moves) {
    const { steps, rest } = wheelSteps(pixels + move, stepPixels);
    pixels = rest;
    batches.push([steps]);
  }
  batches.push([finalStep(pixels, stepPixels)]);
  return batches;
}

const derived = (batches: number[][]): number[] => batches.flat().flatMap((steps) => Array<number>(Math.abs(steps)).fill(Math.sign(steps)));

const CELL = 17;
const SCREEN = 50 * CELL;
const travel = (screens: number) => screens * SCREEN + (CELL * HERDR_MOUSE_SCROLL_LINES) / 4;
const slowMoves = (pixels: number) => Array<number>(Math.ceil(pixels / (CELL / 2))).fill(pixels / Math.ceil(pixels / (CELL / 2)));
const fastMoves = (pixels: number) => Array<number>(6).fill(pixels / 6);

describe("touchWheelPacer", () => {
  test("at most six touch reports dispatch per animation frame", () => {
    const { pacer, target, perFrame, drain, frames, sent } = harness();
    pacer.push(5, target);
    pacer.push(4, target);
    expect(sent.length).toBe(0);
    frames.frame();
    expect(sent.length).toBe(TOUCH_WHEEL_REPORTS_PER_FRAME);
    pacer.push(3, target);
    expect(sent.length).toBe(TOUCH_WHEEL_REPORTS_PER_FRAME);
    frames.frame();
    expect(sent.length).toBe(12);
    pacer.push(20, target);
    drain();
    expect(Math.max(...perFrame())).toBe(TOUCH_WHEEL_REPORTS_PER_FRAME);
    expect(perFrame().every((count) => count <= TOUCH_WHEEL_REPORTS_PER_FRAME)).toBe(true);
    expect(sent.length).toBe(32);
    expect(frames.waiting).toBe(0);
  });

  test("queue holds at most sixty-four reports and counts only overflow drops", () => {
    const { pacer, target, drain, sent } = harness();
    pacer.push(TOUCH_WHEEL_QUEUE_LIMIT + 30, target);
    pacer.push(6, target);
    expect(pacer.peak).toBe(TOUCH_WHEEL_QUEUE_LIMIT);
    expect(pacer.dropped).toBe(36);
    drain();
    expect(sent.length).toBe(TOUCH_WHEEL_QUEUE_LIMIT);
    pacer.push(10, target);
    pacer.cancel();
    expect(pacer.dropped).toBe(36);
    expect(pacer.pending).toBe(0);
  });

  test("ordinary one-screen and two-screen swipes lose zero derived steps", () => {
    for (const screens of [1, 2]) for (const moves of [slowMoves(travel(screens)), fastMoves(travel(screens)), [travel(screens)]]) {
      const { pacer, target, drain, sent } = harness();
      const batches = gesture(moves, CELL);
      for (const [steps] of batches) pacer.push(steps!, target);
      drain();
      expect(sent.map((report) => report.sign)).toEqual(derived(batches) as Array<-1 | 1>);
      expect(sent.length).toBe(Math.round(travel(screens) / (CELL * HERDR_MOUSE_SCROLL_LINES)));
      expect(pacer.dropped).toBe(0);
      expect(pacer.peak).toBeLessThanOrEqual(TOUCH_WHEEL_QUEUE_LIMIT);
    }
  });

  test("two-screen queue drains within three hundred milliseconds of touchend", () => {
    const { pacer, target, frames, sent } = harness();
    const batches = gesture([travel(2)], CELL);
    for (const [steps] of batches) pacer.push(steps!, target);
    const liftFrame = frames.index;
    while (frames.waiting > 0) frames.frame();
    const lastFrame = sent.at(-1)!.frame;
    expect(sent.length).toBe(derived(batches).length);
    expect((lastFrame - liftFrame) * FRAME_MS).toBeLessThanOrEqual(300);
  });

  test("within-gesture reversal preserves signed step order", () => {
    const { pacer, target, drain, sent } = harness();
    const down = travel(1);
    const batches = gesture([...fastMoves(down), ...fastMoves(-down / 2)], CELL);
    for (const [steps] of batches) pacer.push(steps!, target);
    drain();
    const signs = sent.map((report) => report.sign);
    expect(signs).toEqual(derived(batches) as Array<-1 | 1>);
    expect(signs.includes(1) && signs.includes(-1)).toBe(true);
    expect(signs.indexOf(-1)).toBeGreaterThan(signs.lastIndexOf(1));
  });

  test("new touch key disconnect target role and lease changes cancel every queued report", () => {
    const boundaries = ["new touch", "key", "disconnect", "target", "role", "lease"] as const;
    for (const boundary of boundaries) for (const by of ["cancel", "refusal"] as const) {
      const { pacer, target, drain, sent, frames, deny } = harness();
      pacer.push(20, target);
      frames.frame();
      expect(sent.length).toBe(TOUCH_WHEEL_REPORTS_PER_FRAME);
      if (by === "cancel") pacer.cancel();
      else deny();
      frames.frame();
      drain();
      expect({ boundary, by, sent: sent.length, pending: pacer.pending }).toEqual({ boundary, by, sent: TOUCH_WHEEL_REPORTS_PER_FRAME, pending: 0 });
      expect(pacer.dropped).toBe(0);
      if (by === "cancel") expect(frames.waiting).toBe(0);
    }
    const { pacer, target, frames, sent } = harness();
    pacer.push(20, target);
    frames.frame();
    pacer.dispose();
    expect(frames.waiting).toBe(0);
    pacer.push(3, target);
    expect(frames.waiting).toBe(0);
    expect(sent.length).toBe(TOUCH_WHEEL_REPORTS_PER_FRAME);
  });
});
