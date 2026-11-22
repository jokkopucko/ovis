import { describe, expect, test } from "bun:test";
import { createDayStore, localDayKey, msUntilNextLocalMidnight, type DayClock } from "./localDay.ts";
import { formatChatTimestamp } from "./chatTimestamp.ts";
import { translate } from "./i18n.ts";

function fakeClock(startMs: number) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const resumers = new Set<() => void>();
  const clock: DayClock = {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (handle) => { timers.delete(handle as number); },
    onResume: (fn) => { resumers.add(fn); return () => resumers.delete(fn); },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) if (entry[1].at <= end && (due === null || entry[1].at < due[1].at)) due = entry;
      if (due === null) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const sleep = (ms: number): void => { now += ms; };
  const resume = (): void => { for (const fn of [...resumers]) fn(); };
  return { clock, advance, sleep, resume, timers, resumers };
}

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const MIN = 60_000;

describe("localDayKey / msUntilNextLocalMidnight", () => {
  test("one key all day, a new one at local midnight", () => {
    expect(localDayKey(new Date(2026, 9, 13, 0, 0).getTime())).toBe(localDayKey(new Date(2026, 9, 13, 23, 59, 59, 999).getTime()));
    expect(localDayKey(new Date(2026, 9, 14, 0, 0).getTime())).toBe(new Date(2026, 9, 14).getTime());
  });
  test("the wait runs to the next local midnight", () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 13, 23, 59).getTime())).toBe(MIN);
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 13, 0, 0).getTime())).toBe(new Date(2026, 9, 14).getTime() - new Date(2026, 9, 13).getTime());
  });
});

describe("createDayStore", () => {
  test("listeners hear the day change at midnight, once, and not before", () => {
    const fake = fakeClock(new Date(2026, 9, 13, 23, 58).getTime());
    const store = createDayStore(fake.clock);
    let calls = 0;
    const stop = store.subscribe(() => { calls++; });
    const before = store.getSnapshot();
    fake.advance(MIN);
    expect(calls).toBe(0);
    expect(store.getSnapshot()).toBe(before);
    fake.advance(MIN);
    expect(calls).toBe(1);
    expect(store.getSnapshot()).toBe(new Date(2026, 9, 14).getTime());
    fake.advance(24 * 60 * MIN);
    expect(calls).toBe(2);
    stop();
  });

  test("one shared timer for any number of listeners, none once all leave", () => {
    const fake = fakeClock(new Date(2026, 9, 13, 12, 0).getTime());
    const store = createDayStore(fake.clock);
    const stops = Array.from({ length: 50 }, () => store.subscribe(() => {}));
    expect(fake.timers.size).toBe(1);
    expect(fake.resumers.size).toBe(1);
    for (const stop of stops) stop();
    expect(fake.timers.size).toBe(0);
    expect(fake.resumers.size).toBe(0);
  });

  test("a timer fired early re-arms instead of announcing a day that has not come", () => {
    const fake = fakeClock(new Date(2026, 9, 13, 23, 0).getTime());
    let pending: (() => void) | null = null;
    const store = createDayStore({ ...fake.clock, setTimer: (fn) => { pending = fn; return 1; } });
    let calls = 0;
    store.subscribe(() => { calls++; });
    const early = pending as (() => void) | null;
    pending = null;
    early?.();
    expect(calls).toBe(0);
    expect(pending).not.toBeNull();
  });

  test("waking past midnight while the timer slept announces the new day", () => {
    const fake = fakeClock(new Date(2026, 9, 13, 22, 0).getTime());
    const store = createDayStore(fake.clock);
    let calls = 0;
    store.subscribe(() => { calls++; });
    fake.sleep(4 * 60 * MIN);
    expect(store.getSnapshot()).toBe(new Date(2026, 9, 14).getTime());
    fake.resume();
    expect(calls).toBe(1);
    fake.advance(60 * MIN);
    expect(calls).toBe(1);
    expect(fake.timers.size).toBe(1);
  });

  test("a turn's label follows the day key: 'Today 23:59' becomes yesterday after midnight", () => {
    const fake = fakeClock(new Date(2026, 9, 13, 23, 59, 30).getTime());
    const store = createDayStore(fake.clock);
    const ts = new Date(2026, 9, 13, 23, 59).toISOString();
    const label = () => formatChatTimestamp(ts, store.getSnapshot(), "en-US", t)?.label;
    let renders = 0;
    store.subscribe(() => { renders++; });
    expect(label()).toBe("11:59 PM");
    fake.advance(MIN);
    expect(renders).toBe(1);
    expect(label()).toBe("yesterday at 11:59 PM");
  });
});
