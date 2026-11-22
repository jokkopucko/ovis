import { createContext, useContext, useSyncExternalStore } from "react";

export function localDayKey(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** ms from `nowMs` to the next local midnight (by calendar, so a 23 or 25 hour DST day is right). */
export function msUntilNextLocalMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - nowMs;
}

export interface DayClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** a timer's clock can stop while the device sleeps */
  onResume?(fn: () => void): () => void;
}

export interface DayStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
}

export function createDayStore(clock: DayClock): DayStore {
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let notifiedKey = 0;
  let stopResume: (() => void) | null = null;
  const arm = (): void => {
    // at least 1 ms: a timer fired a moment early re-arms for the rest instead of spinning
    timer = clock.setTimer(fire, Math.max(1, msUntilNextLocalMidnight(clock.now())));
  };
  const fire = (): void => {
    timer = null;
    check();
  };
  const resume = (): void => {
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
    check();
  };
  const check = (): void => {
    const key = localDayKey(clock.now());
    if (key !== notifiedKey) {
      notifiedKey = key;
      for (const listener of [...listeners]) listener();
    }
    if (listeners.size > 0 && timer === null) arm();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        notifiedKey = localDayKey(clock.now());
        stopResume = clock.onResume?.(resume) ?? null;
        arm();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        if (timer !== null) clock.clearTimer(timer);
        timer = null;
        stopResume?.();
        stopResume = null;
      };
    },
    getSnapshot: () => localDayKey(clock.now()),
  };
}

const browserDay = createDayStore({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onResume: (fn) => {
    if (typeof document === "undefined") return () => {};
    const onVisible = (): void => { if (document.visibilityState === "visible") fn(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", fn);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", fn);
    };
  },
});

export const DayStoreContext = createContext<DayStore>(browserDay);

export function useLocalDay(): number {
  const store = useContext(DayStoreContext);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
