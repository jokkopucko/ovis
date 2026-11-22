import type { KeyBarItem } from "./keyBar.ts";

export const KEY_REPEAT_DELAY_MS = 400;
export const KEY_REPEAT_INTERVAL_MS = 50;
export const KEY_REPEAT_MOVE_SLOP_PX = 10;

/**
 * Keys that move or edit, which a held hardware key repeats too. Escape, Tab, Enter, ^C and the
 * function keys stay single: a repeated Tab or ^C acts many times on what one press meant.
 */
const REPEATABLE_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
]);

export function isRepeatableKeyBarItem(item: KeyBarItem): boolean {
  return item.type === "key" && REPEATABLE_KEYS.has(item.key);
}

export interface KeyRepeatClock {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface KeyRepeat {
  press: (x: number, y: number) => void;
  move: (x: number, y: number) => boolean;
  release: () => boolean;
  cancel: () => boolean;
  takeClick: () => boolean;
}

const defaultClock: KeyRepeatClock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as number),
};

export function createKeyRepeat(send: () => void, clock: KeyRepeatClock = defaultClock): KeyRepeat {
  let timer: unknown = null;
  let generation = 0;
  let active = false;
  let repeating = false;
  let suppressClick = false;
  let startX = 0;
  let startY = 0;

  const stop = (): void => {
    generation++;
    active = false;
    repeating = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  return {
    press(x, y) {
      stop();
      suppressClick = false;
      active = true;
      startX = x;
      startY = y;
      const pressedGeneration = generation;
      const repeat = (): void => {
        if (!active || generation !== pressedGeneration) return;
        timer = null;
        repeating = true;
        send();
        if (active && generation === pressedGeneration) timer = clock.setTimeout(repeat, KEY_REPEAT_INTERVAL_MS);
      };
      timer = clock.setTimeout(repeat, KEY_REPEAT_DELAY_MS);
    },
    move(x, y) {
      if (!active || repeating) return false;
      const dx = x - startX;
      const dy = y - startY;
      if (dx * dx + dy * dy <= KEY_REPEAT_MOVE_SLOP_PX * KEY_REPEAT_MOVE_SLOP_PX) return false;
      stop();
      return true;
    },
    release() {
      const repeated = repeating;
      if (repeated) suppressClick = true;
      stop();
      return repeated;
    },
    cancel() {
      const repeated = repeating;
      stop();
      suppressClick = false;
      return repeated;
    },
    takeClick() {
      const allowed = !suppressClick;
      suppressClick = false;
      return allowed;
    },
  };
}
