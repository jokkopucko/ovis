import { describe, expect, test } from "bun:test";
import { KEYBOARD_QUIET_MS, KEYBOARD_SETTLE_MS, type KeyboardClock, type KeyboardControlState, KeyboardControlStore, keyboardControlStep, keyboardControlView } from "./keyboardControl.ts";

/** A clock the tests drive by hand: `goto` moves time, `fire` runs the armed settle timer, `live` names them. */
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
    // runs every timer armed so far (each once); one a run arms is left for the next fire
    fire: () => { for (const [id, timer] of [...timers]) { if (!timers.delete(id)) continue; timer.run(); } },
    // runs only the timers whose deadline has come, as a real clock would at this time
    due: () => { for (const [id, timer] of [...timers]) { if (timer.deadline > at || !timers.delete(id)) continue; timer.run(); } },
    live: () => [...timers.values()].map((timer) => timer.ms),
  };
};

const PANE = "pane-a";
const SIBLING = "pane-b";
/** A tap of `owner`'s control, with a field to blur and one to focus. */
const tap = (owner: string) => ({ refused: false, hideTarget: true, showTarget: true, owner });
const atRest = (measured: boolean): KeyboardControlState => ({ measured, observed: measured, intent: null, owner: null, stale: false, agreedAt: null });
const pressing = (state: KeyboardControlState, action: "show" | "hide", at = 0): KeyboardControlState =>
  keyboardControlStep(state, { type: "press", action, owner: PANE, at });
/** The store's derived pair as `owner`'s control reads it, deep-comparable. */
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
    // an intent replaces another one; an unconfirmed intent expires into the measurement
    const swapped = pressing(pressing(atRest(true), "show", 10), "hide", 5_000);
    expect(keyboardControlView(swapped)).toEqual({ direction: "show", pending: true });
    expect(keyboardControlView(keyboardControlStep(swapped, { type: "settle", at: 5_600 })))
      .toEqual({ direction: "hide", pending: false });
  });

  test("a measurement the intent disagrees with leaves it alone, however much it stumbles", () => {
    // a hide whose blur leaves the window occluded mid-animation: the control keeps the tap's word
    let state = keyboardControlStep({ ...atRest(true), intent: "hide" }, { type: "measure", up: true, at: 1_000 });
    expect(state.intent).toBe("hide");
    state = keyboardControlStep({ ...atRest(true), intent: "hide" }, { type: "measure", up: false, at: 1_100 });
    expect(state.intent).toBe("hide");
    // the blur's hidden state keeps the word too: only the quiet hold or the settle clears it
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
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]); // armed with the settle window, its one timer
    goto(KEYBOARD_SETTLE_MS + 1);
    fire();
    expect(says(store)).toEqual(["show", false]);
    expect(live()).toEqual([]);
  });

  test("a locally confirmed hide stands through a mid-animation measurement, and the window ends it when the measurement never agrees", () => {
    // regression: the blur says the keyboard is going, but the viewport's own focusout sync still
    // measures the hiding animation: the control must not arm back over a keyboard going down
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    store.press(tap(PANE));
    store.settled("hide", true);
    goto(KEYBOARD_SETTLE_MS);
    store.measure(true); // the occlusion the animation still reports
    expect(says(store)).toEqual(["show", true]);
    goto(KEYBOARD_SETTLE_MS + 1);
    fire(); // the window runs out: the measurement rules again, mid-animation value and all
    expect(says(store)).toEqual(["hide", false]); // the documented cost: a blind edition reads Hide over a keyboard gone
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
    store.measure(false); // the keyboard goes at the animation's end
    expect(says(store)).toEqual(["show", true]);
    goto(KEYBOARD_QUIET_MS * 4);
    store.measure(false); // still down: confirmed
    expect(says(store)).toEqual(["show", false]);
  });

  test("a show's onFocus is never evidence (a hardware keyboard leaves a field focused too)", () => {
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.press(tap(PANE));
    store.settled("show", false);
    expect(says(store)).toEqual(["hide", true]);
    goto(KEYBOARD_SETTLE_MS + 1); // a focus the field gained never confirms it: the window runs out
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
    expect(says(store)).toEqual(["hide", true]); // 10 - 10 < KEYBOARD_QUIET_MS: still in flight
    goto(10 + KEYBOARD_QUIET_MS);
    store.measure(true);
    expect(says(store)).toEqual(["hide", false]); // the same value, held: confirmed
  });

  test("the overshoot inside a hide does not flap the control: the quiet window rides it out", () => {
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    goto(1);
    store.measure(true);
    store.press(tap(PANE));
    expect(says(store)).toEqual(["show", true]);
    goto(50);
    store.measure(true); // still occluded mid-slide: agrees with nothing, changes nothing
    expect(says(store)).toEqual(["show", true]);
    goto(60);
    store.measure(false); // first down: too fresh to confirm the tap
    expect(says(store)).toEqual(["show", true]);
    goto(120);
    store.measure(true); // Chromium's overshoot, and back
    expect(says(store)).toEqual(["show", true]);
    goto(130);
    store.measure(false);
    expect(says(store)).toEqual(["show", true]); // the new down is fresh too
    goto(130 + KEYBOARD_QUIET_MS);
    store.measure(false); // held still through the overshoot: the tap is done
    expect(says(store)).toEqual(["show", false]);
  });

  test("a reversal tap is confirmed only by geometry measured after it, never by the last animation's value", () => {
    // regression (#2333 review): Hide, then Show while the hiding keyboard still occludes. Show's own
    // focusin reads that old value; it agreed with Show long before the tap, but is not the tap's answer
    const { clock, goto } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    goto(1_000);
    expect(store.press(tap(PANE))).toBe("hide");
    store.settled("hide", true);
    store.measure(true); // the hiding keyboard still occludes
    goto(1_150);
    expect(store.press(tap(PANE))).toBe("show");
    store.measure(true); // Show's synchronous focusin: still the old animation's value
    expect(says(store)).toEqual(["hide", true]);
    goto(1_160);
    store.measure(false); // the old hide animation lands
    expect(says(store)).toEqual(["hide", true]); // the last tap was Show: the control keeps its word
    goto(1_300);
    store.measure(true); // the keyboard Show raised
    expect(says(store)).toEqual(["hide", true]);
    goto(1_300 + KEYBOARD_QUIET_MS);
    store.measure(true); // held still after the tap: confirmed
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
    store.measure(false); // the blur's sync: the same down as before the taps
    expect(says(store)).toEqual(["show", true]);
    goto(1_080);
    store.measure(true); // Show's keyboard was already on its way: it shows mid-flight
    expect(says(store)).toEqual(["show", true]);
  });

  test("a tap in flight is its own pane's word: another pane reads the measurement, and its Show acts", () => {
    // regression (#2333 review): Show in pane A, then pane B shown before A's settle window ends and
    // with the keyboard still measured down. B's control must not say A's Hide, and its Show must act
    const { clock, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    expect(says(store, PANE)).toEqual(["hide", true]);
    expect(says(store, SIBLING)).toEqual(["show", false]);
    expect(store.press({ refused: false, hideTarget: false, showTarget: true, owner: SIBLING })).toBe("show");
    expect(says(store, SIBLING)).toEqual(["hide", true]);
    expect(says(store, PANE)).toEqual(["show", false]); // one keyboard: the last tap, B's, holds the word
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
  });

  test("a reversal whose value already agreed at the tap waits for the measurement to move, however long it holds", () => {
    // regression (#2333 review, round 2): the old Hide animation can keep reading up past the quiet
    // window after a Show; an unchanged value is no proof the keyboard stopped moving
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
    store.measure(true); // the old animation, still above the threshold
    goto(1_180);
    store.measure(false); // and landing
    expect(says(store)).toEqual(["hide", true]); // the last tap was Show: the control keeps its word
    expect(store.press(tap(PANE))).toBe("hide");
    expect(store.press(tap(PANE))).toBe("show"); // and it acts on what it says
    goto(1_300);
    store.measure(true);
    goto(1_300 + KEYBOARD_QUIET_MS);
    due(); // only the quiet window is due: the last tap's settle window (1_880) is still ahead
    expect(says(store)).toEqual(["hide", false]);
    expect(live()).toEqual([]); // confirmed by the quiet window, which cleared the settle window too
  });

  test("a reversal tapped before the blur's deferred measurement is judged by the viewport, not by the blur's word", () => {
    // regression (#2333 review, round 3): Hide's blur says down locally; Show lands before the
    // viewport's deferred focusout sync, then the old animation still reads up past the quiet window
    const { clock, goto, due } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    goto(1_000);
    expect(store.press(tap(PANE))).toBe("hide");
    store.settled("hide", true);
    expect(store.press(tap(PANE))).toBe("show");
    store.measure(true); // Show's focusin, and the deferred sync: the old Hide animation
    goto(1_000 + KEYBOARD_QUIET_MS);
    due(); // the timers due by now: no quiet window may confirm a value from before the tap
    goto(1_180);
    store.measure(false); // the old animation lands
    expect(says(store)).toEqual(["hide", true]);
    expect(store.press(tap(PANE))).toBe("hide"); // the control does what the last tap's word says
  });

  test("a hold ends at its quiet window without a further measurement, so a later dismissal reads down", () => {
    // regression (#2333 review, round 2): one up after Show and no further event; Android's back
    // gesture then puts the keyboard away. The control (and the mode switch) must read it down
    const { clock, goto, due, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    goto(20);
    store.measure(true);
    expect(live().sort()).toEqual([KEYBOARD_QUIET_MS, KEYBOARD_SETTLE_MS]);
    goto(20 + KEYBOARD_QUIET_MS);
    due(); // only the quiet window is due, long before the settle window
    expect(says(store)).toEqual(["hide", false]);
    expect(live()).toEqual([]); // confirmed: no timer is left
    goto(300);
    store.measure(false); // the back gesture
    expect(says(store)).toEqual(["show", false]);
  });

  test("a pane that stops being shown gives up its tap in flight, and comes back reading the measurement", () => {
    // regression (#2333 review, round 2): Show in A, B selected, A selected again inside the window
    const { clock, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    expect(store.press(tap(PANE))).toBe("show");
    store.release(SIBLING); // another pane's release leaves A's word alone
    expect(says(store)).toEqual(["hide", true]);
    store.release(PANE);
    expect(says(store)).toEqual(["show", false]);
    expect(live()).toEqual([]);
    expect(store.press({ ...tap(PANE), hideTarget: false })).toBe("show"); // its Show acts again
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
    expect(notifications).toBe(1); // the stop: a remounting subscriber never leaks
  });

  test("one armed timer a tap: the last tap replaces the armed one, and a blur leaves the window armed", () => {
    const { clock, goto, fire, live } = clockRig();
    const store = new KeyboardControlStore(clock);
    store.measure(true);
    store.press(tap(PANE));
    store.press(tap(PANE)); // last tap wins, one timer
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
    store.settled("hide", true); // the blur's confirmation does not clear the window: it still bounds the word
    expect(live()).toEqual([KEYBOARD_SETTLE_MS]);
    goto(KEYBOARD_SETTLE_MS);
    fire();
    expect(live()).toEqual([]);
    expect(says(store)).toEqual(["show", false]);
  });
});
