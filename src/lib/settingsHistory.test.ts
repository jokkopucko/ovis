import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { sheetStep } from "./historyKeys.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function fakeWindow() {
  const stack: unknown[] = [null];
  let index = 0;
  const listeners: Array<(event: { state: unknown }) => void> = [];
  const history = {
    get state() { return stack[index]; },
    pushState(state: unknown) { stack.splice(index + 1); stack.push(state); index += 1; },
    replaceState(state: unknown) { stack[index] = state; },
    go(by: number) { index = Math.max(0, Math.min(stack.length - 1, index + by)); queueMicrotask(() => { for (const listener of listeners) listener({ state: stack[index] }); }); },
  };
  const window = { history, addEventListener(type: string, listener: (event: { state: unknown }) => void) { if (type === "popstate") listeners.push(listener); } };
  const held = () => stack.slice(0, index + 1).map((state) => (state as Record<string, unknown> | null)?.["ovis:settings"] ?? null);
  return { window, held };
}
const fake = fakeWindow();
(globalThis as unknown as { window: unknown }).window = fake.window;
const { outsideSettings, recordSettings, settingsEntry, settingsLevels, settingsSteppedOff } = await import("./settingsHistory.ts");
const settled = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined))); };

describe("settingsLevels", () => {
  it("makes a phone's list a step of its own, under the page and the key bar editor", () => {
    expect(settingsLevels(true, null, false)).toEqual([{ page: null, keyBar: false }]);
    expect(settingsLevels(true, "chat", false)).toEqual([{ page: null, keyBar: false }, { page: "chat", keyBar: false }]);
    expect(settingsLevels(true, "terminal", true)).toEqual([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
  });

  it("opens a wider dialog on its page: one step, and the key bar editor a second", () => {
    expect(settingsLevels(false, "appearance", false)).toEqual([{ page: "appearance", keyBar: false }]);
    expect(settingsLevels(false, "terminal", true)).toEqual([{ page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
  });

  it("has no key bar step without a page under it", () => {
    expect(settingsLevels(true, null, true)).toEqual([{ page: null, keyBar: false }]);
  });
});

describe("settingsEntry", () => {
  const state = (entry: unknown) => ({ "ovis:settings": entry });

  it("reads the entry beside whatever else the state holds", () => {
    expect(settingsEntry({ ...state({ page: "chat", keyBar: false, depth: 2 }), "ovis:file-preview": { path: "a" } })).toEqual({ page: "chat", keyBar: false, depth: 2 });
    expect(settingsEntry(state({ page: null, keyBar: false, depth: 1 }))).toEqual({ page: null, keyBar: false, depth: 1 });
  });

  it("is null for a state without one, or one it did not write", () => {
    for (const other of [null, undefined, "settings", 1, {}, state(null), state("chat"), state({ page: 3, keyBar: false, depth: 1 }), state({ page: "chat", keyBar: "no", depth: 1 }),
      state({ page: "chat", keyBar: false }), state({ page: "chat", keyBar: false, depth: 0 }), state({ page: "chat", keyBar: false, depth: 1.5 }), state({ page: "chat", keyBar: false, depth: 9 })]) {
      expect(settingsEntry(other)).toBeNull();
    }
  });
});

function openSheet(history: { state: unknown; replaceState(state: unknown): void; pushState(state: unknown): void }, id: string): void {
  const fields = history.state !== null && typeof history.state === "object" ? history.state : {};
  history.replaceState({ ...fields, "ovis:sheet-under": id });
  history.pushState({ ...fields, "ovis:sheet-under": id, "ovis:sheet": id });
}

const withoutSheet = (state: unknown): unknown => {
  if (state === null || typeof state !== "object") return state;
  const { ["ovis:sheet"]: _sheet, ...rest } = state as Record<string, unknown>;
  return rest;
};

describe("recordSettings", () => {
  it("rebuilds the earlier steps when the width changes: the list goes under a page a wider dialog opened, and away again", async () => {
    recordSettings([{ page: "terminal", keyBar: false }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: "terminal", keyBar: false, depth: 1 }]);
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: null, keyBar: false, depth: 1 }, { page: "terminal", keyBar: false, depth: 2 }]);
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    recordSettings([{ page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: "terminal", keyBar: false, depth: 1 }, { page: "terminal", keyBar: true, depth: 2 }]);
    recordSettings([]);
    await settled();
    expect(fake.held()).toEqual([null]);
  });

  it("tells the app's Back that closing Settings stepped off its entries, and that a Back between panes did not", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": true });
    recordSettings([{ page: "remote", keyBar: false }]);
    await settled();
    recordSettings([]);
    await settled();
    expect(seen).toEqual([true]);
    fake.window.history.go(-1);
    await settled();
    expect(seen).toEqual([true, false]);
  });

  it("counts Settings closing when it opened from a phone sheet whose entry it took over", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": true });
    openSheet(fake.window.history, "palette");
    const push = fake.window.history.pushState;
    fake.window.history.pushState = (state: unknown) => { fake.window.history.pushState = push; fake.window.history.replaceState(withoutSheet(state)); };
    recordSettings([{ page: null, keyBar: false }, { page: "remote", keyBar: false }]);
    await settled();
    expect(Object.keys((fake.window.history.state ?? {}) as object)).not.toContain("ovis:sheet");
    fake.window.history.go(-1);
    await settled();
    expect(Object.keys((fake.window.history.state ?? {}) as object)).not.toContain("ovis:sheet");
    fake.window.history.go(-1);
    await settled();
    expect(seen).toEqual([false, true]);
    recordSettings([]);
    await settled();
    openSheet(fake.window.history, "palette-2");
    fake.window.history.pushState = (state: unknown) => { fake.window.history.pushState = push; fake.window.history.replaceState(withoutSheet(state)); };
    recordSettings([{ page: null, keyBar: false }, { page: "remote", keyBar: false }]);
    await settled();
    recordSettings([]);
    await settled();
    expect(seen).toEqual([false, true, true]);
    fake.window.history.go(-1);
    await settled();
  });

  it("does not take a jump past the entry a phone sheet opened over for Settings closing", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": "a" });
    fake.window.history.pushState({ "ovis:nav": "b" });
    openSheet(fake.window.history, "palette-3");
    const push = fake.window.history.pushState;
    fake.window.history.pushState = (state: unknown) => { fake.window.history.pushState = push; fake.window.history.replaceState(withoutSheet(state)); };
    recordSettings([{ page: null, keyBar: false }, { page: "remote", keyBar: false }]);
    await settled();
    fake.window.history.go(-3);
    await settled();
    expect(seen).toEqual([false]);
    recordSettings([]);
    await settled();
    fake.window.history.go(-(fake.held().length - 1));
    await settled();
  });

  it("keeps the entry a phone sheet opened over as its anchor when another sheet opens inside Settings", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": "a" });
    fake.window.history.pushState({ "ovis:nav": "b" });
    openSheet(fake.window.history, "palette-4");
    const push = fake.window.history.pushState;
    fake.window.history.pushState = (state: unknown) => { fake.window.history.pushState = push; fake.window.history.replaceState(withoutSheet(state)); };
    recordSettings([{ page: null, keyBar: false }, { page: "devices", keyBar: false }]);
    await settled();
    openSheet(fake.window.history, "sign-out");
    fake.window.history.go(-1);
    await settled();
    recordSettings([{ page: null, keyBar: false }, { page: "remote", keyBar: false }]);
    await settled();
    fake.window.history.go(-2);
    await settled();
    expect(seen).toEqual([false, true]);
    recordSettings([]);
    await settled();
    fake.window.history.go(-(fake.held().length - 1));
    await settled();
  });

  it("does not carry an earlier opening's anchor into Settings opened again over the same entries", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": "a" });
    fake.window.history.pushState({ "ovis:nav": "b" });
    openSheet(fake.window.history, "palette-5");
    const push = fake.window.history.pushState;
    fake.window.history.pushState = (state: unknown) => { fake.window.history.pushState = push; fake.window.history.replaceState(withoutSheet(state)); };
    recordSettings([{ page: null, keyBar: false }, { page: "remote", keyBar: false }]);
    await settled();
    fake.window.history.pushState(outsideSettings(fake.window.history.state));
    recordSettings([]);
    await settled();
    recordSettings([{ page: null, keyBar: false }, { page: "devices", keyBar: false }]);
    await settled();
    openSheet(fake.window.history, "sign-out-2");
    fake.window.history.go(-1);
    await settled();
    fake.window.history.go(-5);
    await settled();
    expect(settingsEntry(fake.window.history.state)).toBeNull();
    expect((fake.window.history.state as Record<string, unknown>)["ovis:nav"]).toBe("b");
    expect(seen).toEqual([false, false]);
    recordSettings([]);
    await settled();
    fake.window.history.go(-(fake.held().length - 1));
    await settled();
  });

  it("does not take a jump from Settings past the entry it opened over for Settings closing", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": "a" });
    fake.window.history.pushState({ "ovis:nav": "b" });
    recordSettings([{ page: "remote", keyBar: false }]);
    await settled();
    fake.window.history.go(-2);
    await settled();
    expect(seen).toEqual([false]);
    recordSettings([]);
    await settled();
    fake.window.history.go(-(fake.held().length - 1));
    await settled();
  });

  it("does not take Forward onto a preview opened over Settings for Settings closing", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => seen.push(settingsSteppedOff()));
    fake.window.history.pushState({ "ovis:nav": true });
    recordSettings([{ page: "remote", keyBar: false }]);
    await settled();
    fake.window.history.pushState(outsideSettings(fake.window.history.state));
    fake.window.history.go(-1);
    await settled();
    fake.window.history.go(1);
    await settled();
    expect(seen).toEqual([false, false]);
    fake.window.history.go(-1);
    await settled();
    recordSettings([]);
    await settled();
    expect(seen).toEqual([false, false, false, true]);
    fake.window.history.go(-1);
    await settled();
  });

  it("does not take a step it cannot see on trust: entries of an earlier opening a Forward landed on are rebuilt", async () => {
    const key = "ovis:settings";
    fake.window.history.pushState({ [key]: { page: "terminal", keyBar: false, depth: 1 } });
    fake.window.history.pushState({ [key]: { page: "terminal", keyBar: true, depth: 2 } });
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: null, keyBar: false, depth: 1 }, { page: "terminal", keyBar: false, depth: 2 }, { page: "terminal", keyBar: true, depth: 3 }]);
    recordSettings([]);
    await settled();
    expect(fake.held()).toEqual([null]);
  });
});

// Restore globals so this import-time browser stub cannot leak into another file.
const baselineWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
afterEach(() => {
  if (baselineWindow) Object.defineProperty(globalThis, "window", baselineWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let loadId = 0;
async function delayedHistory(initial: unknown[] = [null]) {
  const stack = [...initial];
  let index = stack.length - 1;
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners: Array<(event: { state: unknown }) => void> = [];
  const requests: number[] = [];
  const history = {
    get state() { return stack[index]; },
    pushState(state: unknown) { stack.splice(index + 1); stack.push(state); index++; },
    replaceState(state: unknown) { stack[index] = state; },
    go(by: number) { requests.push(index + by); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    history,
    addEventListener(type: string, listener: (event: { state: unknown }) => void) {
      if (type === "popstate") listeners.push(listener);
    },
  } });
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: (run: () => void, ms: number) => {
    timers.set(++timerId, { at: now + ms, run });
    return timerId;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: (id: number) => timers.delete(id) });
  const module: typeof import("./settingsHistory.ts") = await import(`./settingsHistory.ts?delayed=${++loadId}`);
  const dispatch = async () => {
    await new Promise<void>((resolve) => queueMicrotask(() => {
      for (const listener of listeners) listener({ state: history.state });
      resolve();
    }));
  };
  return {
    ...module, history, requests,
    get index() { return index; },
    async land() {
      const target = requests.shift();
      if (target === undefined) throw new Error("no requested traversal to land");
      if (target >= 0 && target < stack.length && target !== index) { index = target; await dispatch(); }
    },
    async move(by: number) { index += by; await dispatch(); },
    dispatch,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
      }
      now = end;
    },
  };
}

describe("history traversal races", () => {
  it("keeps a late width-change traversal its own after the landing deadline", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(500);
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.advance(501);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "terminal", keyBar: true, depth: 3 });
  });

  it("does not retry a traversal every second when no landing arrives", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings([]);
    browser.advance(10_000);
    expect(browser.requests).toHaveLength(1);
  });

  it("waits for the same pending destination across updates after the deadline", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "terminal", keyBar: true, depth: 3 });
  });

  it("reconciles the latest levels after a delayed traversal lands", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "appearance", keyBar: false, depth: 1 });
    expect(browser.requests).toEqual([]);
  });

  it("completes an unmount reset after a pending width traversal lands late", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(1001);
    browser.recordSettings([]);
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
    expect(browser.requests).toEqual([]);
  });

  it("does not notify an unsubscribed listener when a traversal lands", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    const unsubscribe = browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    unsubscribe();
    await browser.land();
    expect(moves).toEqual([]);
  });

  it("steps Back over Settings entries a markerless entry buried, instead of opening them again", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: Array<[ReturnType<typeof browser.settingsEntry>, boolean]> = [];
    browser.onSettingsHistory((entry, own) => moves.push([entry, own]));
    browser.history.pushState({ route: "markerless" });
    browser.history.pushState({ route: "after-markerless" });

    await browser.move(-1);
    expect(moves).toEqual([[null, false]]);
    browser.recordSettings([]);
    expect(browser.requests).toEqual([]);
    await browser.move(-1);
    expect(moves).toEqual([[null, false]]);
    await browser.land();
    expect(moves).toEqual([[null, false], [null, true]]);
    expect(browser.index).toBe(0);
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
    await browser.move(1);
    expect(moves[2]).toEqual([{ page: null, keyBar: false, depth: 1 }, false]);
  });

  it("does not take the step over buried Settings entries for Settings closing: the app's Back still goes back", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(false, "about", false));
    const stepped: boolean[] = [];
    browser.onSettingsHistory(() => stepped.push(browser.settingsSteppedOff()));
    browser.history.pushState({ route: "markerless" });
    browser.history.pushState({ route: "after-markerless" });
    await browser.move(-1);
    browser.recordSettings([]);
    await browser.move(-1);
    await browser.land();
    expect(browser.index).toBe(0);
    expect(stepped).toEqual([false, false]);
  });

  it("steps over every opening a markerless entry buried, not only the latest", async () => {
    const browser = await delayedHistory();
    const moves: Array<[ReturnType<typeof browser.settingsEntry>, boolean]> = [];
    browser.onSettingsHistory((entry, own) => moves.push([entry, own]));
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    browser.history.pushState({ route: "first" });
    browser.history.pushState({ route: "after-first" });
    await browser.move(-1);
    browser.recordSettings([]);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    browser.history.pushState({ route: "second" });
    browser.history.pushState({ route: "after-second" });
    await browser.move(-1);
    browser.recordSettings([]);
    expect(browser.requests).toEqual([]);
    await browser.move(-1);
    await browser.land();
    await browser.move(-1);
    await browser.land();
    expect(browser.index).toBe(0);
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
    expect(browser.requests).toEqual([]);
    expect(moves.at(-1)).toEqual([null, true]);
  });

  it("steps over the entries a foreign pushState buried when Settings closed by itself", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.history.pushState({ route: "other" });
    browser.recordSettings([]);
    expect(browser.requests).toEqual([]);
    await browser.move(-1);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.index).toBe(0);
  });

  it("keeps a preview opened over Settings on a reload, and steps Back over the Settings under it", async () => {
    const base = { "ovis:settings-base": "a" };
    const settings = { ...base, "ovis:settings": { page: "about", keyBar: false, depth: 1 } };
    const preview = { ...outsideSettings(settings), "ovis:file-preview": { path: "README.md", paneId: null, machineId: "local" } };
    expect(settingsEntry(preview)).toBeNull();
    const browser = await delayedHistory([base, settings, preview]);
    const moves: Array<[ReturnType<typeof browser.settingsEntry>, boolean]> = [];
    browser.onSettingsHistory((entry, own) => moves.push([entry, own]));
    expect(browser.loadedOnSettingsEntry()).toBe(true);
    expect(browser.requests).toEqual([]);
    await browser.move(-1);
    await browser.land();
    expect(moves).toEqual([[null, true]]);
    expect(browser.index).toBe(0);
  });

  it("records a deeper reopening after an unanswered close traversal", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, null, false));
    browser.recordSettings([]);
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(true, "terminal", false));
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "terminal", keyBar: false, depth: 2 });
    expect(browser.requests).toHaveLength(1);
  });

  it("does not replace an unanswered traversal with another rewind", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings([]);
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    expect(browser.requests).toHaveLength(1);
  });

  it("keeps its step back through the address written as Settings closes, and opens again once it lands (#2000)", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings([]);
    browser.history.replaceState({ ...browser.history.state as object });
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "appearance", keyBar: false, depth: 1 });
  });

  it("stays open when a closed sheet's step off the entry it opened over lands under it (#2000)", async () => {
    for (const step of [true, false]) {
      const browser = await delayedHistory([{ "ovis:sheet-under": "palette" }, { "ovis:sheet-under": "palette", "ovis:sheet": "palette" }]);
      const moves: boolean[] = [];
      browser.onSettingsHistory((_entry, own) => moves.push(own));
      browser.recordSettings(browser.settingsLevels(true, null, false));
      const answer = sheetStep.lands;
      sheetStep.lands = () => step;
      try { await browser.move(-2); }
      finally { sheetStep.lands = answer; }
      expect(moves).toEqual(step ? [] : [false]);
      expect(browser.settingsEntry(browser.history.state)).toEqual(step ? { page: null, keyBar: false, depth: 1 } : null);
      expect(browser.index).toBe(step ? 1 : 0);
    }
  });

  it("leaves Settings as it is for a Back that a phone sheet with no entry refused, and for its way back", async () => {
    const browser = await delayedHistory([{ "ovis:nav": true }]);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    expect(browser.index).toBe(1);
    const moves: Array<[string | null, boolean]> = [];
    browser.onSettingsHistory((entry, own) => moves.push([entry?.page ?? null, own]));
    const answer = sheetStep.holds;
    sheetStep.holds = () => true;
    try { await browser.move(-1); await browser.move(1); }
    finally { sheetStep.holds = answer; }
    expect(moves).toEqual([]);
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "appearance", keyBar: false, depth: 1 });
    expect(browser.settingsSteppedOff()).toBe(false);
    await browser.move(-1);
    expect(moves).toEqual([[null, false]]);
    expect(browser.settingsSteppedOff()).toBe(true);
  });

  it("does not open again on an entry it left, when a phone sheet goes onto that entry to take it", async () => {
    const browser = await delayedHistory([{ "ovis:nav": true }]);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    const moves: Array<[string | null, boolean]> = [];
    browser.onSettingsHistory((entry, own) => moves.push([entry?.page ?? null, own]));
    await browser.move(-1);
    browser.recordSettings([]);
    expect(moves).toEqual([[null, false]]);
    const answer = sheetStep.taking;
    sheetStep.taking = () => true;
    try { await browser.move(1); }
    finally { sheetStep.taking = answer; }
    expect(moves).toEqual([[null, false]]);
    await browser.move(-1);
    await browser.move(1);
    expect(moves.at(-1)).toEqual(["appearance", false]);
  });

  it("lets go of its step back when a write on the same entry changes the Settings it holds", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings([]);
    const state = browser.history.state as Record<string, unknown>;
    browser.history.replaceState({ ...state, "ovis:settings": { page: "terminal", keyBar: false, depth: 1 } });
    await browser.land();
    expect(moves).toEqual([false]);
  });

  it("does not consume Back after a timed-out close and reopening", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, null, false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings([]);
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(true, null, false));
    await browser.move(-1);
    expect(moves).toEqual([false]);
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
  });

  it("does not consume Back when reopening precedes the timeout", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, null, false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings([]);
    browser.advance(500);
    browser.recordSettings(browser.settingsLevels(true, null, false));
    browser.advance(501);
    await browser.move(-1);
    expect(moves).toEqual([false]);
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
  });

  it("steps out of reload entries even when the traversal lands late", async () => {
    const browser = await delayedHistory([null,
      { "ovis:settings": { page: "terminal", keyBar: false, depth: 1 } },
      { "ovis:settings": { page: "terminal", keyBar: true, depth: 2 } },
    ]);
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.advance(1001);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.index).toBe(0);
    expect(browser.requests).toEqual([]);
  });

  it("expires pending ownership when an unrelated landing wins", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    await browser.move(-2); // depth 1 is not the requested depth 2
    await browser.land();
    expect(moves).toEqual([false, false]);
  });

  for (const method of ["pushState", "replaceState"] as const) {
    it(`releases pending ownership after foreign ${method}`, async () => {
      const browser = await delayedHistory();
      browser.recordSettings(browser.settingsLevels(true, null, false));
      browser.recordSettings([]);
      browser.advance(1001);
      browser.history[method]({ route: "other" });
      browser.recordSettings(browser.settingsLevels(true, null, false));
      expect(browser.settingsEntry(browser.history.state)).toEqual({ page: null, keyBar: false, depth: 1 });
      const beforeClose = browser.requests.length;
      browser.recordSettings([]);
      expect(browser.requests).toHaveLength(beforeClose + 1);
    });

    it(`does not claim Back after silent foreign ${method}`, async () => {
      const browser = await delayedHistory();
      browser.recordSettings(browser.settingsLevels(true, "terminal", true));
      const moves: boolean[] = [];
      browser.onSettingsHistory((_entry, own) => moves.push(own));
      browser.recordSettings(browser.settingsLevels(false, "terminal", true));
      browser.recordSettings(browser.settingsLevels(true, "terminal", true));
      browser.advance(1001);
      browser.history[method]({ route: "other" });
      await browser.move(method === "pushState" ? -2 : -1);
      expect(moves).toEqual([false]);
    });
  }
});
