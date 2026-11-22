import { describe, expect, test } from "bun:test";
import { KEYBOARD_QUIET_MS, KEYBOARD_SETTLE_MS, type KeyboardClock, type KeyboardControlState, KeyboardControlStore, keyboardControlStep, keyboardControlView } from "./keyboardControl.ts";

const clockRig = (): { clock: KeyboardClock; goto: (at: number) => void; fire: () => void; due: () => void; live: () => number[] } => {
  let at = 0;
  let next = 0;
  const timers = new Map<number, { run: () => void; ms: number; deadline: number }>();
  const fake: KeyboardClock = {
    now: () => at,
    set: (run, ms) => { const id = ++next; timers.set(id, { run, ms, deadline: at + ms }); return id; },
    clear: (id) => { timers.delete(id); },
  };
  return {
    clock: fake,
    goto: (value) => { at = value; },
    fire: () => { for (const [id, timer] of [...timers]) { if (!timers.delete(id)) continue; timer.run(); } },
    due: () => { for (const [id, timer] of [...timers]) { if (timer.deadline > at || !timers.delete(id)) continue; timer.run(); } },
    live: () => [...timers.values()].map((timer) => timer.ms),
  };
};

const PANE = "pane-a";
const SIBLING = "pane-b";
const tap = (owner: string) => ({ refused: false, hideTarget: true, showTarget: true, owner });
const atRest = (measured: boolean): KeyboardControlState => ({ measured, observed: measured, intent: null, owner: null, stale: false, agreedAt: null });
const pressing = (state: KeyboardControlState, action: "show" | "hide", at = 0): KeyboardControlState =>
  keyboardControlStep(state, { type: "press", action, owner: PANE, at });
const says = (store: KeyboardControlStore, owner = PANE): [string, boolean] => [store.view(owner).direction, store.view(owner).pending];

describe("keyboardControlStep", () => {
  test("the measurement decides at rest: up is a hide, down is a show", () => {
    expect(keyboardControlView(atRest(false))).toEqual({ direction: "show", pending: false });
    expect(keyboardControlView(atRest(true))).toEqual({ direction: "hide", pending: false });
  });

  test("a tap is the wanted truth at once, whichever way the measurement points", () => {
    expect(keyboardControlView(pressing(atRest(false), "show"))).toEqual({ direction: "hide", pending: true });
    expect(keyboardControlView(pressing(atRest(true), "hide"))).toEqual({ direction: "show", pending: true });
  });

  test("the last tap wins, and the settle window hands the decision back to the measurement", () => {
    const swapped = pressing(pressing(atRest(true), "show", 10), "hide", 5_000);
    expect(keyboardControlView(swapped)).toEqual({ direction: "show", pending: true });
    expect(keyboardControlView(keyboardControlStep(swapped, { type: "settle", at: 5_600 })))
      .toEqual({ direction: "hide", pending: false });
  });

  test("a measurement the intent disagrees with leaves it alone, however much it stumbles", () => {
    let state = keyboardControlStep({ ...atRest(true), intent: "hide" }, { type: "measure", up: true, at: 1_000 });
    expect(state.intent).toBe("hide");
    state = keyboardControlStep({ ...atRest(true), intent: "hide" }, { type: "measure", up: false, at: 1_100 });
    expect(state.intent).toBe("hide");
    state = keyboardControlStep({ ...atRest(true), intent: "hide" }, { type: "hidden", at: 1_200 });
    expect(state).toEqual({ measured: false, observed: true, intent: "hide", owner: null, stale: false, agreedAt: null });
    expect(keyboardControlView(state)).toEqual({ direction: "show", pending: true });
  });
});

describe("keyboardControlStore", () => {
  test("a show sits pending until the measurement answers, and expires if it never does", () => {
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    expect(says(store)).toEqual(["hide", true]);
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
    goto(KEYBOARD_SETTLE_MS + 1);
    fire();
    expect(says(store)).toEqual(["show", false]);
    expect(live()).toEqual([]);
  });

  test("a locally confirmed hide stands through a mid-animation measurement, and the window ends it when the measurement never agrees", () => {
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    store.press(tap(PANE));
    store.settled("hide", true);
    goto(KEYBOARD_SETTLE_MS);
    store.measure(true);
    expect(says(store)).toEqual(["show", true]);
    goto(KEYBOARD_SETTLE_MS + 1);
    fire();
    expect(says(store)).toEqual(["hide", false]);
    expect(live()).toEqual([]);
  });

  test("a settled hide with a field still focused records nothing: the word stands for the measurement", () => {
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    store.press(tap(PANE));
    store.settled("hide", false);
    expect(says(store)).toEqual(["show", true]);
    goto(KEYBOARD_QUIET_MS * 2);
    store.measure(false);
    expect(says(store)).toEqual(["show", true]);
    goto(KEYBOARD_QUIET_MS * 4);
    store.measure(false);
    expect(says(store)).toEqual(["show", false]);
  });

  test("a show's onFocus is never evidence (a hardware keyboard leaves a field focused too)", () => {
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.press(tap(PANE));
    store.settled("show", false);
    expect(says(store)).toEqual(["hide", true]);
    goto(KEYBOARD_SETTLE_MS + 1);
    fire();
    expect(says(store)).toEqual(["show", false]);
    expect(live()).toEqual([]);
  });

  test("a composition, a pending commit or a paste refuses the tap, recording nothing and arming nothing", () => {
    const { clock, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    expect(store.press({ ...tap(PANE), refused: true })).toBe("refuse");
    expect(says(store)).toEqual(["hide", false]);
    expect(live()).toEqual([]);
  });

  test("no target for the tap says so and records nothing (a Hide while another pane owns the keyboard)", () => {
    const { clock, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    expect(store.press({ ...tap(PANE), hideTarget: false })).toBe("none");
    expect(says(store)).toEqual(["hide", false]);
    const { clock: downClock } = clockRig();
    const downStore = new KeyboardControlStore(downClock);
    expect(downStore.press({ ...tap(PANE), showTarget: false })).toBe("none");
    expect(says(downStore)).toEqual(["show", false]);
    expect(live()).toEqual([]);
  });

  test("a show confirms only once the measured up has held still for the quiet window", () => {
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.press(tap(PANE));
    goto(10);
    store.measure(true);
    expect(says(store)).toEqual(["hide", true]);
    goto(10 + KEYBOARD_QUIET_MS);
    store.measure(true);
    expect(says(store)).toEqual(["hide", false]);
  });

  test("the overshoot inside a hide does not flap the control: the quiet window rides it out", () => {
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    goto(1);
    store.measure(true);
    store.press(tap(PANE));
    expect(says(store)).toEqual(["show", true]);
    goto(50);
    store.measure(true);
    expect(says(store)).toEqual(["show", true]);
    goto(60);
    store.measure(false);
    expect(says(store)).toEqual(["show", true]);
    goto(120);
    store.measure(true);
    expect(says(store)).toEqual(["show", true]);
    goto(130);
    store.measure(false);
    expect(says(store)).toEqual(["show", true]);
    goto(130 + KEYBOARD_QUIET_MS);
    store.measure(false);
    expect(says(store)).toEqual(["show", false]);
  });

  test("a reversal tap is confirmed only by geometry measured after it, never by the last animation's value", () => {
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    goto(1_000);
    expect(store.press(tap(PANE))).toBe("hide");
    store.settled("hide", true);
    store.measure(true);
    goto(1_150);
    expect(store.press(tap(PANE))).toBe("show");
    store.measure(true);
    expect(says(store)).toEqual(["hide", true]);
    goto(1_160);
    store.measure(false);
    expect(says(store)).toEqual(["hide", true]);
    goto(1_300);
    store.measure(true);
    expect(says(store)).toEqual(["hide", true]);
    goto(1_300 + KEYBOARD_QUIET_MS);
    store.measure(true);
    expect(says(store)).toEqual(["hide", false]);
  });

  test("a quick Hide after Show is not confirmed by the down measured before either tap", () => {
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(false);
    goto(1_000);
    expect(store.press(tap(PANE))).toBe("show");
    goto(1_050);
    expect(store.press(tap(PANE))).toBe("hide");
    store.measure(false);
    expect(says(store)).toEqual(["show", true]);
    goto(1_080);
    store.measure(true);
    expect(says(store)).toEqual(["show", true]);
  });

  test("a tap in flight is its own pane's word: another pane reads the measurement, and its Show acts", () => {
    const { clock, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    expect(says(store, PANE)).toEqual(["hide", true]);
    expect(says(store, SIBLING)).toEqual(["show", false]);
    expect(store.press({ refused: false, hideTarget: false, showTarget: true, owner: SIBLING })).toBe("show");
    expect(says(store, SIBLING)).toEqual(["hide", true]);
    expect(says(store, PANE)).toEqual(["show", false]);
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
  });

  test("a reversal whose value already agreed at the tap waits for the measurement to move, however long it holds", () => {
    const { clock, goto, due, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    goto(1_000);
    expect(store.press(tap(PANE))).toBe("hide");
    store.settled("hide", true);
    store.measure(true);
    goto(1_020);
    expect(store.press(tap(PANE))).toBe("show");
    store.measure(true);
    goto(1_140);
    store.measure(true);
    goto(1_180);
    store.measure(false);
    expect(says(store)).toEqual(["hide", true]);
    expect(store.press(tap(PANE))).toBe("hide");
    expect(store.press(tap(PANE))).toBe("show");
    goto(1_300);
    store.measure(true);
    goto(1_300 + KEYBOARD_QUIET_MS);
    due();
    expect(says(store)).toEqual(["hide", false]);
    expect(live()).toEqual([]);
  });

  test("a reversal tapped before the blur's deferred measurement is judged by the viewport, not by the blur's word", () => {
    const { clock, goto, due } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    goto(1_000);
    expect(store.press(tap(PANE))).toBe("hide");
    store.settled("hide", true);
    expect(store.press(tap(PANE))).toBe("show");
    store.measure(true);
    goto(1_000 + KEYBOARD_QUIET_MS);
    due();
    goto(1_180);
    store.measure(false);
    expect(says(store)).toEqual(["hide", true]);
    expect(store.press(tap(PANE))).toBe("hide");
  });

  test("a hold ends at its quiet window without a further measurement, so a later dismissal reads down", () => {
    const { clock, goto, due, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    goto(20);
    store.measure(true);
    expect(live().sort()).toEqual([KEYBOARD_QUIET_MS, KEYBOARD_SETTLE_MS]);
    goto(20 + KEYBOARD_QUIET_MS);
    due();
    expect(says(store)).toEqual(["hide", false]);
    expect(live()).toEqual([]);
    goto(300);
    store.measure(false);
    expect(says(store)).toEqual(["show", false]);
  });

  test("a pane that stops being shown gives up its tap in flight, and comes back reading the measurement", () => {
    const { clock, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    store.release(SIBLING);
    expect(says(store)).toEqual(["hide", true]);
    store.release(PANE);
    expect(says(store)).toEqual(["show", false]);
    expect(live()).toEqual([]);
    expect(store.press({ ...tap(PANE), hideTarget: false })).toBe("show");
  });

  test("view() returns the same object until what it derives changes, and the stop leaves nothing notified", () => {
    const { clock } = clockRig();
    const store = new KeyboardControlStore(clock);
    const first = store.view(PANE);
    expect(first).toEqual({ direction: "show", pending: false });
    let notifications = 0;
    const stop = store.subscribe(() => { notifications++; });
    store.measure(true);
    const second = store.view(PANE);
    expect(second).not.toBe(first);
    expect(store.view(PANE)).toBe(second);
    store.measure(true);
    expect(store.view(PANE)).toBe(second);
    expect(notifications).toBe(1); // no change, no notice: useSyncExternalStore would loop
    stop();
    store.measure(false);
    expect(store.view(PANE)).toEqual({ direction: "show", pending: false });
    expect(notifications).toBe(1);
  });

  test("one armed timer a tap: the last tap replaces the armed one, and a blur leaves the window armed", () => {
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    store.press(tap(PANE));
    store.press(tap(PANE));
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
    store.settled("hide", true);
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
    goto(KEYBOARD_SETTLE_MS);
    fire();
    expect(live()).toEqual([]);
    expect(says(store)).toEqual(["show", false]);
  });
});
