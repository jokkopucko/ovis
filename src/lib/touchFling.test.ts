import { describe, expect, test } from "bun:test";
import {
  createTouchFling, createVelocityTracker, FLING_DECELERATION, FLING_HORIZON_MS, FLING_MAX_VELOCITY, FLING_MIN_VELOCITY,
  FLING_SLOP_PX, FLING_STOP_VELOCITY, FLING_STOPPED_MS, flingStep,
} from "./touchFling.ts";
import type { FrameClock } from "./touchWheelPacer.ts";

const FRAME_MS = 1000 / 60;

function controlledFrames() {
  let callbacks = new Map<number, () => void>();
  let next = 1;
  let time = 0;
  const clock: FrameClock = {
    request(callback) { callbacks.set(next, callback); return next++; },
    cancel(handle) { callbacks.delete(handle); },
  };
  return {
    clock,
    now: () => time,
    get waiting() { return callbacks.size; },
    frame() {
      time += FRAME_MS;
      const due = callbacks;
      callbacks = new Map();
      for (const callback of due.values()) callback();
    },
  };
}

function swipe(speed: number, ms: number) {
  const tracker = createVelocityTracker();
  let t = 0;
  for (; t <= ms; t += FRAME_MS) tracker.add(t, speed * t);
  return { tracker, last: t - FRAME_MS };
}

describe("the finger's speed at the lift", () => {
  test("is the travel over the last moments, with the travel's sign", () => {
    const down = swipe(2, 200);
    expect(down.tracker.release(down.last)).toBeCloseTo(2, 5);
    const up = swipe(-1.5, 200);
    expect(up.tracker.release(up.last)).toBeCloseTo(-1.5, 5);
  });

  test("counts only the last horizon: a drag that sped up at the end flings at its end speed", () => {
    const tracker = createVelocityTracker();
    let position = 0;
    let t = 0;
    for (; t < 500; t += FRAME_MS) { tracker.add(t, position); position += 0.1 * FRAME_MS; }
    for (const end = t + FLING_HORIZON_MS * 2; t < end; t += FRAME_MS) { tracker.add(t, position); position += 3 * FRAME_MS; }
    expect(tracker.release(t - FRAME_MS)).toBeGreaterThan(2.5);
  });

  test("is none for a finger that stopped before it lifted", () => {
    const { tracker, last } = swipe(3, 200);
    expect(tracker.release(last + FLING_STOPPED_MS + 1)).toBe(0);
    expect(tracker.release(last + FLING_STOPPED_MS)).not.toBe(0);
  });

  test("is none for a slow drag, which ends where the finger does", () => {
    const { tracker, last } = swipe(FLING_MIN_VELOCITY * 0.9, 300);
    expect(tracker.release(last)).toBe(0);
  });

  test("is at most the fastest fling, and needs a move", () => {
    const tracker = createVelocityTracker();
    tracker.add(0, 0);
    expect(tracker.release(0)).toBe(0);
    tracker.add(0, 500);
    expect(tracker.release(0)).toBe(FLING_MAX_VELOCITY);
    tracker.reset();
    expect(tracker.release(0)).toBe(0);
  });

  test("is none for a tap that jittered: under the touch slop no speed flings", () => {
    // 3 px in 8 ms is 0.375 px/ms, over the slowest fling, and 2 px in one timestamp counts as 2 px/ms
    for (const moves of [[[8, 3]], [[0, 2]], [[4, 2], [8, -3], [12, FLING_SLOP_PX - 1]]]) {
      const tracker = createVelocityTracker();
      tracker.add(0, 0);
      for (const [t, position] of moves) tracker.add(t!, position!);
      expect(tracker.release(moves.at(-1)![0]!)).toBe(0);
    }
    const tracker = createVelocityTracker();
    tracker.add(0, 0);
    tracker.add(24, FLING_SLOP_PX + 1);
    expect(tracker.release(24)).toBeGreaterThan(FLING_MIN_VELOCITY);
  });
});

describe("a fling's frames", () => {
  test("decay by the deceleration rate, and add up to the whole glide however the frames fall", () => {
    const step = flingStep(2, 10);
    expect(step.velocity).toBeCloseTo(2 * FLING_DECELERATION ** 10, 10);
    let velocity = 2;
    let total = 0;
    for (let n = 0; n < 1000; n++) {
      const frame = flingStep(velocity, FRAME_MS);
      total += frame.travel;
      velocity = frame.velocity;
    }
    expect(total).toBeCloseTo(2 / -Math.log(FLING_DECELERATION), 0);
    expect(flingStep(2, 1000).travel).toBeCloseTo(flingStep(2, 400).travel + flingStep(flingStep(2, 400).velocity, 600).travel, 8);
  });

  test("travel nothing without time", () => {
    expect(flingStep(2, 0)).toEqual({ travel: 0, velocity: 2 });
    expect(flingStep(Number.NaN, 16)).toEqual({ travel: 0, velocity: 0 });
  });
});

describe("the glide", () => {
  test("goes one step per frame in the lift's direction, slows, and ends by itself once", () => {
    const frames = controlledFrames();
    const fling = createTouchFling(frames.clock, frames.now);
    const travel: number[] = [];
    let done = 0;
    fling.start(-3, (pixels) => { travel.push(pixels); return true; }, () => { done += 1; });
    expect(travel).toEqual([]);
    expect(fling.active).toBe(true);
    let guard = 0;
    while (frames.waiting > 0 && guard++ < 10_000) frames.frame();
    expect(done).toBe(1);
    expect(fling.active).toBe(false);
    expect(travel.every((pixels) => pixels < 0)).toBe(true);
    for (let n = 1; n < travel.length; n++) expect(Math.abs(travel[n]!)).toBeLessThan(Math.abs(travel[n - 1]!));
    const whole = travel.reduce((sum, pixels) => sum + pixels, 0);
    expect(whole).toBeCloseTo(-3 / -Math.log(FLING_DECELERATION), -2);
    expect(Math.abs(travel.at(-1)! / FRAME_MS)).toBeLessThan(FLING_STOP_VELOCITY * 1.1);
  });

  test("stops at once on a cancel, and never says it ended", () => {
    const frames = controlledFrames();
    const fling = createTouchFling(frames.clock, frames.now);
    let steps = 0;
    let done = 0;
    fling.start(3, () => { steps += 1; return true; }, () => { done += 1; });
    frames.frame();
    frames.frame();
    fling.cancel();
    expect(frames.waiting).toBe(0);
    frames.frame();
    expect(steps).toBe(2);
    expect(done).toBe(0);
  });

  test("stops when a step is refused: another pane, a lost attach", () => {
    const frames = controlledFrames();
    const fling = createTouchFling(frames.clock, frames.now);
    let steps = 0;
    let done = 0;
    fling.start(3, () => ++steps < 3, () => { done += 1; });
    for (let n = 0; n < 10; n++) frames.frame();
    expect(steps).toBe(3);
    expect(done).toBe(0);
    expect(fling.active).toBe(false);
  });

  test("a new glide replaces the one before it", () => {
    const frames = controlledFrames();
    const fling = createTouchFling(frames.clock, frames.now);
    const first: number[] = [];
    fling.start(3, (pixels) => { first.push(pixels); return true; }, () => undefined);
    frames.frame();
    fling.start(-3, () => true, () => undefined);
    for (let n = 0; n < 5; n++) frames.frame();
    expect(first.length).toBe(1);
    expect(frames.waiting).toBe(1);
  });

  test("too slow to glide ends at once; a disposed glide never starts", () => {
    const frames = controlledFrames();
    const fling = createTouchFling(frames.clock, frames.now);
    let done = 0;
    fling.start(0, () => true, () => { done += 1; });
    expect(done).toBe(1);
    expect(frames.waiting).toBe(0);
    fling.dispose();
    fling.start(3, () => true, () => { done += 1; });
    expect(done).toBe(1);
    expect(frames.waiting).toBe(0);
  });

  test("a long frame advances by at most 50 ms, so a glide after a hidden tab does not jump", () => {
    const clock = controlledFrames();
    let time = 0;
    const fling = createTouchFling(clock.clock, () => time);
    const travel: number[] = [];
    fling.start(4, (pixels) => { travel.push(pixels); return true; }, () => undefined);
    time = 5000;
    clock.frame();
    expect(travel[0]).toBeCloseTo(flingStep(4, 50).travel, 8);
  });
});
