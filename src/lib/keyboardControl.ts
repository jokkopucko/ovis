/*
 * The key bar's keyboard control (#1046): what its label says, and what its tap does, from both
 * the tap's word and the keyboard lib/viewport.ts measured, never from one alone.
 *
 * A tap is an event; data-keyboard is a value in flight while a phone's keyboard slides, and
 * Chromium's geometry overshoots the resting height with no signal for the settled value. Deciding
 * a tap from the measurement alone put the tap on whichever side of the animation the last event
 * landed: Hide ran as Show, the open control stayed armed over a keyboard visibly up, and Show
 * after Android's back gesture focused a field that was already focused, which raises nothing.
 *
 * So this store keeps the tap's `intent` until the measurement confirms it (and holds still) or the
 * settle window runs out, and keeps `measured` alongside. Only measurements taken after the tap
 * confirm it: a value that already agreed before it (the last animation still in flight) is no
 * answer to it. The intent is the tapping pane's word: another pane's control reads the
 * measurement, so a tap in flight in one pane never makes another one's control say what it cannot
 * do. The one derivation, keyboardControlView, is what the label, the glyph, aria-pressed and the
 * next tap's action all read. A hide confirmed
 * locally (its blur left no typing field focused) is evidence the measurement cannot give, for a
 * browser it is blind in: a zoomed page, a floating keyboard.
 */

/** What a tap asks for, and what the control's next tap will do. */
export type KeyboardDirection = "show" | "hide";

/**
 * The longest a tap's intent outlives its gesture without a confirming measurement — or a locally
 * confirmed hide stands after it: above the keyboard's slide, so a mid-animation value can never
 * take a tap back. Its cost is only a stale label on a tap that did nothing, which then falls back
 * to the measurement.
 */
export const KEYBOARD_SETTLE_MS = 700;

/**
 * How still the measured value must be before a change of it is trusted. Chromium's geometry
 * overshoot means a value that agrees with the intent once can disagree on the next event; one
 * quiet spell of this length is the cheapest honest "it stopped moving" this platform offers.
 */
export const KEYBOARD_QUIET_MS = 120;

export interface KeyboardControlState {
  /** the last measurement, or a local hidden confirmation, of the keyboard */
  measured: boolean;
  /** the last value the viewport itself measured: a local hidden confirmation does not move it */
  observed: boolean;
  /** the tap in flight: what the keyboard is on its way to, the word that holds the control */
  intent: KeyboardDirection | null;
  /** the pane whose control made the tap in flight: the word is that control's alone */
  owner: string | null;
  /**
   * the value measured at the tap already agreed with it (a reversal during the last animation):
   * that value is no answer to the tap until the measurement has moved away from it once
   */
  stale: boolean;
  /**
   * when a measurement taken after the tap first read the value the intent wants, every one since
   * reading it too; null until then, and again at each measurement that disagrees
   */
  agreedAt: number | null;
}

export interface KeyboardControlView {
  /** what the label, the glyph and the next tap's action all say */
  direction: KeyboardDirection;
  /** a tap is in flight: the intent, not the direction, is where the keyboard is heading */
  pending: boolean;
}

export type KeyboardControlEvent =
  | { type: "measure"; up: boolean; at: number }
  | { type: "press"; action: KeyboardDirection; owner: string; at: number }
  /** the tap's settle window ended: the measurement takes over whatever it says */
  | { type: "settle"; at: number }
  /** the quiet window after the last agreeing measurement ran out with no event against it */
  | { type: "quiet"; at: number }
  /** the tap's blur left no typing field focused anywhere: the keyboard is going */
  | { type: "hidden"; at: number };

/** The measured value that would confirm an intent: a show waits for the keyboard up. */
const wants = (intent: KeyboardDirection): boolean => intent === "show";

/** No tap in flight: the measurement decides alone. */
const AT_REST: KeyboardControlState = { measured: false, observed: false, intent: null, owner: null, stale: false, agreedAt: null };

/**
 * One step of the machine, free of DOM and clock. A measurement clears an intent it agrees with
 * only once the agreeable value, measured after the tap and not left over from before it, has held
 * still for the quiet window (a later measurement or the quiet timer ends it); a tap replaces the
 * intent and its owner, last tap wins; a settle window catches what the measurement never
 * confirmed; a hidden state is a dismissal seen at the focus, where a measurement can be blind.
 */
export function keyboardControlStep(state: KeyboardControlState, event: KeyboardControlEvent): KeyboardControlState {
  switch (event.type) {
    case "measure": {
      const measured = { measured: event.up, observed: event.up };
      if (state.intent === null) return { ...state, ...measured };
      // a value that disagrees (the overshoot inside a hide, the last animation landing) restarts the
      // hold, and is the move a stale value waited for
      if (event.up !== wants(state.intent)) return { ...state, ...measured, stale: false, agreedAt: null };
      // the value from before the tap, still unmoved: the old animation may yet carry it away
      if (state.stale) return { ...state, ...measured };
      const agreedAt = state.agreedAt ?? event.at;
      return event.at - agreedAt >= KEYBOARD_QUIET_MS ? { ...AT_REST, ...measured } : { ...state, ...measured, agreedAt };
    }
    case "quiet":
      return state.intent !== null && state.agreedAt !== null && event.at - state.agreedAt >= KEYBOARD_QUIET_MS
        ? { ...AT_REST, measured: state.measured, observed: state.observed } : state;
    case "press":
      // one intent at a time, the last tap's: a double tap cannot queue two moves, and what the
      // viewport measured before this tap is no answer to it (a blur's local word is not a
      // measurement: the viewport may still read the old animation)
      return { ...state, intent: event.action, owner: event.owner, stale: state.observed === wants(event.action), agreedAt: null };
    case "settle":
      return { ...AT_REST, measured: state.measured, observed: state.observed };
    case "hidden": // the blur says the keyboard is going; the tap's word stands till it settles or confirms
      return { ...state, measured: false, agreedAt: state.measured ? null : state.agreedAt };
  }
}

// the four views, one object each: a snapshot that is the same object while it says the same
const VIEWS = {
  show: { direction: "show", pending: false },
  hide: { direction: "hide", pending: false },
  showPending: { direction: "show", pending: true },
  hidePending: { direction: "hide", pending: true },
} as const satisfies Record<string, KeyboardControlView>;

/**
 * The one derivation: the label, the glyph, aria-pressed and the action all come from here, for
 * the control of `owner` (by default, the pane whose tap is in flight). Another pane's tap in flight
 * is not this control's word: it reads the measurement.
 */
export function keyboardControlView(state: KeyboardControlState, owner: string | null = state.owner): KeyboardControlView {
  if (state.intent === null || state.owner !== owner) return state.measured ? VIEWS.hide : VIEWS.show;
  // a show in flight is a keyboard on its way up: the next tap puts it away, and the label says so now
  return state.intent === "show" ? VIEWS.hidePending : VIEWS.showPending;
}

/** What the tap must do, or that it does nothing ("none") or is refused outright. */
export type KeyboardPress = KeyboardDirection | "refuse" | "none";

/** What the store takes to know about the pane, read at the tap. */
export interface KeyboardTap {
  /** a composition or a commit on its way (the bar's paste refusal blocks a tap before it gets here) */
  refused: boolean;
  /** a field of this pane that Hide may blur has the focus (else Hide has nothing to do here) */
  hideTarget: boolean;
  /** this pane has a field Show may focus (else the control is disabled and never gets here) */
  showTarget: boolean;
  /** the pane whose control was tapped: the word it leaves is that control's alone */
  owner: string;
}

/** The time this store lives by, injected so a test drives it without fake timers. */
export interface KeyboardClock {
  now(): number;
  set(handler: () => void, ms: number): number;
  clear(handle: number): void;
}

const defaultClock: KeyboardClock = {
  now: () => performance.now(),
  set: (handler, ms) => window.setTimeout(handler, ms),
  clear: (handle) => window.clearTimeout(handle),
};

export class KeyboardControlStore {
  readonly clock: KeyboardClock;
  private state: KeyboardControlState = AT_REST;
  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private quietTimer: number | null = null;

  constructor(clock: KeyboardClock = defaultClock) {
    this.clock = clock;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** `owner`'s control: the same object until what it derives changes, useSyncExternalStore's getSnapshot. */
  view = (owner: string): KeyboardControlView => keyboardControlView(this.state, owner);

  /** lib/viewport.ts, on every sync: the value and the fact that the measurement moved at all. */
  measure = (up: boolean): void => this.apply({ type: "measure", up, at: this.clock.now() });

  /**
   * The tap: refuse it in place before any state changes (nothing runs later), and a tap with no
   * target of this pane says so, recording nothing.
   */
  press = (tap: KeyboardTap): KeyboardPress => {
    if (tap.refused) return "refuse";
    const action = this.view(tap.owner).direction;
    if (action === "hide" ? !tap.hideTarget : !tap.showTarget) return "none";
    this.apply({ type: "press", action, owner: tap.owner, at: this.clock.now() });
    this.arm();
    return action;
  };

  /**
   * The pane performed the tap. A blur that leaves no typing field focused anywhere is the keyboard
   * going — every phone dismisses it on the blur, evidence a blind measurement cannot give. The
   * tap's word then stands through the animation the measurement still reports: only a still-quiet
   * measure or the settle window clears it. A focus is never evidence the other way, which is why
   * only "hide" confirms here.
   */
  settled = (action: KeyboardDirection, noFieldFocused: boolean): void => {
    if (action !== "hide" || !noFieldFocused) return;
    this.apply({ type: "hidden", at: this.clock.now() });
  };

  /**
   * The pane stopped being the one shown and selected: a tap of its still in flight is abandoned
   * (its field is blurred or inert), so the control it comes back to reads the measurement again.
   */
  release = (owner: string): void => {
    if (this.state.intent === null || this.state.owner !== owner) return;
    this.apply({ type: "settle", at: this.clock.now() });
  };

  private apply(event: KeyboardControlEvent): void {
    const before = this.state;
    const state = keyboardControlStep(before, event);
    this.state = state;
    // the timers follow the state: no intent, no settle window; a hold that started (or restarted)
    // gets its own quiet window, which a viewport that sends no further event still ends
    if (state.intent === null) this.cancel();
    if (state.intent === null || state.agreedAt === null) this.cancelQuiet();
    else if (state.agreedAt !== before.agreedAt || this.quietTimer === null) {
      this.cancelQuiet();
      const wait = Math.max(0, state.agreedAt + KEYBOARD_QUIET_MS - this.clock.now());
      this.quietTimer = this.clock.set(() => { this.quietTimer = null; this.apply({ type: "quiet", at: this.clock.now() }); }, wait);
    }
    // what any control's view reads: a quiet hold that only moves agreedAt notifies no one
    if (state.measured === before.measured && state.intent === before.intent && state.owner === before.owner) return;
    for (const listener of this.listeners) listener();
  }

  private cancelQuiet(): void {
    if (this.quietTimer === null) return;
    this.clock.clear(this.quietTimer);
    this.quietTimer = null;
  }

  private arm(): void {
    this.cancel();
    this.timer = this.clock.set(() => { this.timer = null; this.apply({ type: "settle", at: this.clock.now() }); }, KEYBOARD_SETTLE_MS);
  }

  private cancel(): void {
    if (this.timer === null) return;
    this.clock.clear(this.timer);
    this.timer = null;
  }
}

export const keyboardControl = new KeyboardControlStore();
