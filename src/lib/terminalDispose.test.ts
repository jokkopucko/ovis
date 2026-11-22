import { describe, expect, it } from "bun:test";
import { disposeAfterPendingFrame } from "./terminalDispose.ts";

function scheduler() {
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  return {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    frame: () => { for (const callback of frames.splice(0)) callback(); },
    tick: () => { for (const callback of timers.splice(0)) callback(); },
  };
}

describe("terminal disposal", () => {
  it("waits for the frame xterm already asked for, and a task after it", () => {
    const clock = scheduler();
    const order: string[] = [];
    clock.requestAnimationFrame(() => {
      order.push("viewport frame");
      clock.setTimeout(() => order.push("viewport task"));
    });

    disposeAfterPendingFrame({ dispose: () => order.push("dispose") }, clock);

    expect(order).toEqual([]);
    clock.tick();
    expect(order).toEqual([]);
    clock.frame();
    expect(order).toEqual(["viewport frame"]);
    clock.tick();
    expect(order).toEqual(["viewport frame", "viewport task", "dispose"]);
  });

  it("keeps the renderer alive for pending frame and constructor task reads", () => {
    const clock = scheduler();
    let renderer: { dimensions: number } | undefined = { dimensions: 80 };
    const reads: number[] = [];
    const syncScrollArea = () => {
      if (renderer === undefined) throw new TypeError("renderer disposed before viewport sync");
      reads.push(renderer.dimensions);
    };
    clock.setTimeout(syncScrollArea);
    clock.requestAnimationFrame(syncScrollArea);

    disposeAfterPendingFrame({ dispose: () => { renderer = undefined; } }, clock);

    // A hidden tab can run tasks without delivering its animation frames.
    clock.tick();
    expect(reads).toEqual([80]);
    clock.frame();
    expect(reads).toEqual([80, 80]);
    clock.tick();
    expect(renderer).toBeUndefined();
  });

  it("reproduces the pending viewport read failure with immediate disposal", () => {
    const clock = scheduler();
    let renderer: { dimensions: number } | undefined = { dimensions: 80 };
    clock.requestAnimationFrame(() => {
      if (renderer === undefined) throw new TypeError("renderer disposed before viewport sync");
      return renderer.dimensions;
    });

    renderer = undefined;

    expect(() => clock.frame()).toThrow(TypeError);
  });

  it("disposes once", () => {
    const clock = scheduler();
    let disposed = 0;

    disposeAfterPendingFrame({ dispose: () => { disposed++; } }, clock);

    clock.frame();
    clock.tick();
    clock.frame();
    clock.tick();
    expect(disposed).toBe(1);
  });
});
