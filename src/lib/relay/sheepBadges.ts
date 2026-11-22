import type { MascotState } from "./mascot.ts";

/**
 * Which of the owner's mascot performances each pairing screen wears; a screen that changes its sheep changes
 * only its line here. "hello" is the default, eyes-closed sheep, for a screen no state of its own belongs to.
 */
export const SHEEP_FOR = {
  start: "hello",
  header: "hello",
  waiting: "approval",
  connecting: "connecting",
  done: "done",
  refused: "refused",
} as const satisfies Record<string, MascotState>;

export type SheepScreen = keyof typeof SHEEP_FOR;
