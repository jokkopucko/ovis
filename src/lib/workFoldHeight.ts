import { heightFor, settled, type HeightState } from "./animatedHeight.ts";

export function contentHeightFor(state: HeightState, measured: number, animateContent: boolean): HeightState {
  const next = heightFor(state, measured);
  return animateContent || next === state ? next : settled(next);
}
