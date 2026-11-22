export const TOUCH_WHEEL_REPORTS_PER_FRAME = 6;
export const TOUCH_WHEEL_QUEUE_LIMIT = 64;

export interface FrameClock {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/**
 * Where one gesture's reports go: `allowed` is asked immediately before each report, and a no
 * (another pane, an observer, a lost attach) cancels everything still waiting rather than sending
 * it later.
 */
export interface TouchWheelTarget {
  emit(sign: -1 | 1): void;
  allowed(): boolean;
}

export interface TouchWheelPacer {
  push(steps: number, target: TouchWheelTarget): void;
  cancel(): void;
  dispose(): void;
  readonly pending: number;
  readonly peak: number;
  readonly dropped: number;
}

const browserFrames: FrameClock = {
  request: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Reports go out only from the frame callback:
 * the browser runs a frame's touch handlers before its animation-frame callbacks, so a report sent
 * from the handler would land in the same frame as the callback's.
 */
export function createTouchWheelPacer(frames: FrameClock = browserFrames): TouchWheelPacer {
  const queue: Array<{ sign: -1 | 1; target: TouchWheelTarget }> = [];
  let frame: number | null = null;
  let peak = 0;
  let dropped = 0;
  let disposed = false;

  const onFrame = (): void => {
    frame = null;
    let sent = 0;
    while (queue.length > 0 && sent < TOUCH_WHEEL_REPORTS_PER_FRAME) {
      const next = queue.shift()!;
      if (!next.target.allowed()) {
        queue.length = 0;
        break;
      }
      sent += 1;
      next.target.emit(next.sign);
    }
    if (!disposed && queue.length > 0 && frame === null) frame = frames.request(onFrame);
  };

  return {
    push(steps, target) {
      if (disposed || steps === 0 || !Number.isFinite(steps)) return;
      const sign = Math.sign(steps) as -1 | 1;
      const count = Math.abs(Math.trunc(steps));
      for (let n = 0; n < count; n++) {
        if (queue.length >= TOUCH_WHEEL_QUEUE_LIMIT) {
          dropped += count - n;
          break;
        }
        queue.push({ sign, target });
      }
      peak = Math.max(peak, queue.length);
      if (queue.length > 0 && frame === null) frame = frames.request(onFrame);
    },
    cancel() {
      queue.length = 0;
      if (frame !== null) frames.cancel(frame);
      frame = null;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      if (frame !== null) frames.cancel(frame);
      frame = null;
    },
    get pending() { return queue.length; },
    get peak() { return peak; },
    get dropped() { return dropped; },
  };
}
