/*
 * A tap is an event; data-keyboard is a value in flight while a phone's keyboard slides, and
 * Chromium's geometry overshoots the resting height with no signal for the settled value. Deciding
 * a tap from the measurement alone put the tap on whichever side of the animation the last event
 * landed: Hide ran as Show, the open control stayed armed over a keyboard visibly up, and Show
 * after Android's back gesture focused a field that was already focused, which raises nothing.
 *
 * A hide confirmed locally (its blur left no typing field focused) is evidence the measurement
 * cannot give, for a browser it is blind in: a zoomed page, a floating keyboard.
 */

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
  measured: boolean;
  observed: boolean;
  intent: KeyboardDirection | null;
  owner: string | null;
  stale: boolean;
  agreedAt: number | null;
}

export interface KeyboardControlView {
  direction: KeyboardDirection;
  pending: boolean;
}

export type KeyboardControlEvent =
  | { type: "measure"; up: boolean; at: number }
  | { type: "press"; action: KeyboardDirection; owner: string; at: number }
  | { type: "settle"; at: number }
  | { type: "quiet"; at: number }
  | { type: "hidden"; at: number };

const wants = (intent: KeyboardDirection): boolean => intent === "show";

const AT_REST: KeyboardControlState = { measured: false, observed: false, intent: null, owner: null, stale: false, agreedAt: null };

export function keyboardControlStep(state: KeyboardControlState, event: KeyboardControlEvent): KeyboardControlState {
  switch (event.type) {
    case "measure": {
      const measured = { measured: event.up, observed: event.up };
      if (state.intent === null) return { ...state, ...measured };
      if (event.up !== wants(state.intent)) return { ...state, ...measured, stale: false, agreedAt: null };
      if (state.stale) return { ...state, ...measured };
      const agreedAt = state.agreedAt ?? event.at;
      return event.at - agreedAt >= KEYBOARD_QUIET_MS ? { ...AT_REST, ...measured } : { ...state, ...measured, agreedAt };
    }
    case "quiet":
      return state.intent !== null && state.agreedAt !== null && event.at - state.agreedAt >= KEYBOARD_QUIET_MS
        ? { ...AT_REST, measured: state.measured, observed: state.observed } : state;
    case "press":
      return { ...state, intent: event.action, owner: event.owner, stale: state.observed === wants(event.action), agreedAt: null };
    case "settle":
      return { ...AT_REST, measured: state.measured, observed: state.observed };
    case "hidden":
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

export function keyboardControlView(state: KeyboardControlState, owner: string | null = state.owner): KeyboardControlView {
  if (state.intent === null || state.owner !== owner) return state.measured ? VIEWS.hide : VIEWS.show;
  return state.intent === "show" ? VIEWS.hidePending : VIEWS.showPending;
}

export type KeyboardPress = KeyboardDirection | "refuse" | "none";

export interface KeyboardTap {
  refused: boolean;
  hideTarget: boolean;
  showTarget: boolean;
  owner: string;
}

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

  view = (owner: string): KeyboardControlView => keyboardControlView(this.state, owner);

  measure = (up: boolean): void => this.apply({ type: "measure", up, at: this.clock.now() });

  press = (tap: KeyboardTap): KeyboardPress => {
    if (tap.refused) return "refuse";
    const action = this.view(tap.owner).direction;
    if (action === "hide" ? !tap.hideTarget : !tap.showTarget) return "none";
    this.apply({ type: "press", action, owner: tap.owner, at: this.clock.now() });
    this.arm();
    return action;
  };

  /**
   * A blur that leaves no typing field focused anywhere is the keyboard going — every phone
   * dismisses it on the blur, evidence a blind measurement cannot give. The tap's word then stands
   * through the animation the measurement still reports: only a still-quiet measure or the settle
   * window clears it. A focus is never evidence the other way, which is why only "hide" confirms here.
   */
  settled = (action: KeyboardDirection, noFieldFocused: boolean): void => {
    if (action !== "hide" || !noFieldFocused) return;
    this.apply({ type: "hidden", at: this.clock.now() });
  };

  release = (owner: string): void => {
    if (this.state.intent === null || this.state.owner !== owner) return;
    this.apply({ type: "settle", at: this.clock.now() });
  };

  private apply(event: KeyboardControlEvent): void {
    const before = this.state;
    const state = keyboardControlStep(before, event);
    this.state = state;
    if (state.intent === null) this.cancel();
    if (state.intent === null || state.agreedAt === null) this.cancelQuiet();
    else if (state.agreedAt !== before.agreedAt || this.quietTimer === null) {
      this.cancelQuiet();
      const wait = Math.max(0, state.agreedAt + KEYBOARD_QUIET_MS - this.clock.now());
      this.quietTimer = this.clock.set(() => { this.quietTimer = null; this.apply({ type: "quiet", at: this.clock.now() }); }, wait);
    }
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
