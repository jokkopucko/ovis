export interface HeightState {
  readonly height: number | null;
  readonly moving: boolean;
}

export const RESTING: HeightState = { height: null, moving: false };

export const SETTLE_GRACE_MS = 100;

export function heightFor(state: HeightState, measured: number | null): HeightState {
  const height = measured === null ? 0 : Math.ceil(measured);
  if (state.height === height) return state;
  return { height, moving: state.height !== null };
}

export function settled(state: HeightState): HeightState {
  return state.moving ? { height: state.height, moving: false } : state;
}

/** Each entry of a computed `transition-duration` or `transition-delay` ("0.18s, 50ms"), in ms. */
export function transitionTimes(value: string): number[] {
  return value.split(",").map((entry) => {
    const match = /^\s*(-?\d*\.?\d+)(ms|s)\s*$/.exec(entry);
    if (match === null) return 0;
    return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  });
}

/**
 * How long the longest of an element's transitions runs from now, its delay included, in ms:
 * 0 when none moves (`transition: none`, reduced motion), so the box can rest
 * at once instead of waiting for an end event that never comes. A delay list shorter than the
 * duration list repeats, as the browser pairs them.
 */
export function transitionSpan(duration: string, delay: string): number {
  const durations = transitionTimes(duration);
  const delays = transitionTimes(delay);
  let span = 0;
  durations.forEach((length, index) => {
    if (length <= 0) return;
    span = Math.max(span, length + (delays[index % delays.length] ?? 0));
  });
  return span;
}
