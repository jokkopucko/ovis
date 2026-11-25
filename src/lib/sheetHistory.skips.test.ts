import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { sheetStep } from "./historyKeys.ts";

/**
 * The module on a browser whose Back skips the entries of a page that added one with no tap since
 * the last Back or Forward (Chromium): it is told by `navigator.userActivation` and a Chrome user
 * agent, read once when the module loads, so this file has a browser of its own.
 */
let originalWindow: PropertyDescriptor | undefined;
let originalNavigator: PropertyDescriptor | undefined;

/** A history with the browser's key for each entry (kept by a replace, new with a push), the Navigation API's way onto one, and taps. */
function fakeBrowser() {
  let keys = 0;
  const entries: Array<{ state: unknown; href: string; key: string }> = [{ state: null, href: "/?pane=a", key: "k0" }];
  let index = 0;
  const activation = { isActive: false };
  /** the browser drops the next traversal asked for by key, as when another one overtakes it */
  let dropping = false;
  let silentBack = false;
  type Pop = { state: unknown; stopImmediatePropagation: () => void };
  const listeners = new Map<string, Array<(event: Pop) => void>>();
  const land = (next: number): void => {
    if (next === index || next < 0 || next >= entries.length) return;
    index = next;
    queueMicrotask(() => {
      // one event for every listener in the order they were added, until one stops it
      let stopped = false;
      const event: Pop = { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } };
      for (const listener of listeners.get("popstate") ?? []) { if (stopped) break; listener(event); }
    });
  };
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); keys += 1; entries.push({ state, href: url ?? entries[index]!.href, key: `k${keys}` }); index += 1; },
    replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href, key: entries[index]!.key }; },
    back() {
      if (silentBack) { silentBack = false; index -= 1; return; }
      land(index - 1);
    },
    forward() { land(index + 1); },
    // a step by count is what the browser drops with a way by key: `back` and `forward` are the user's own here
    go(by: number) { if (!dropping) land(index + by); },
  };
  const window = {
    history,
    get location() { return { href: entries[index]!.href }; },
    navigation: {
      get currentEntry() { return { key: entries[index]!.key, index }; },
      entries() { return entries.map((entry, at) => ({ key: entry.key, index: at })); },
      traverseTo(key: string) {
        if (dropping) return { committed: Promise.reject(new Error("dropped")), finished: Promise.reject(new Error("dropped")) };
        land(entries.findIndex((entry) => entry.key === key));
        return { committed: Promise.resolve(), finished: Promise.resolve() };
      },
    },
    addEventListener(type: string, listener: (event: Pop) => void) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  return {
    window, entries, activation,
    at: () => index,
    key: () => entries[index]!.key,
    drop: (on: boolean) => { dropping = on; },
    muteNextBack: () => { silentBack = true; },
    /** an entry the browser makes by itself, as for a #fragment: none of the page's writers sees it */
    fragment: (href: string) => { entries.splice(index + 1); keys += 1; entries.push({ state: null, href, key: `k${keys}` }); index += 1; },
    first: (listener: (event: Pop) => void) => { listeners.set("popstate", [listener, ...(listeners.get("popstate") ?? [])]); },
    tap: () => { activation.isActive = true; for (const listener of listeners.get("pointerup") ?? []) listener({ state: null, stopImmediatePropagation: () => {} }); },
  };
}
const fake = fakeBrowser();
const h = fake.window.history;
const settled = async () => {
  jest.advanceTimersByTime(1);
  for (let i = 0; i < 6; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
};
let sheetHistory: typeof import("./sheetHistory.ts");
const enter = (onBack: () => boolean | void, returns = false): (() => void) => { const id = sheetHistory.enterSheet(onBack, null, false, returns); return () => sheetHistory.leaveSheet(id); };

beforeAll(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fake.window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36", userActivation: fake.activation } });
  const modulePath = "./sheetHistory.ts?sheet-history-skips-test";
  sheetHistory = await import(modulePath);
});
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

describe("a phone's sheet where Back skips an entry made with no tap", () => {
  it("waits for a tap to make the entry of a sheet that opened with none, and makes it then", async () => {
    const start = fake.at();
    let closed = 0;
    const leave = enter(() => { closed += 1; });
    expect(fake.entries.length).toBe(start + 1);
    fake.tap();
    expect(fake.entries.length).toBe(start + 2); expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("makes no entry for a sheet that opens after a Back with no new tap, until one comes", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFirst = enter(() => {});
    h.back(); await settled();
    leaveFirst(); await settled();
    expect(fake.at()).toBe(start);
    const entries = fake.entries.length;
    const leaveSecond = enter(() => {});
    await settled();
    expect(fake.entries.length).toBe(entries); expect(fake.at()).toBe(start);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("steps off a later sheet after Chromium committed a Back without firing any events", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFirst = enter(() => {});
    fake.muteNextBack();
    leaveFirst(); await settled();
    expect(fake.at()).toBe(start);
    fake.tap();
    const leaveNext = enter(() => {});
    expect(fake.at()).toBe(start + 1);
    leaveNext(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("does not strand the entry of an automatic approval that opens after a silent Back", async () => {
    const start = fake.at();
    fake.tap();
    fake.muteNextBack();
    enter(() => {})(); await settled();
    fake.activation.isActive = false;
    const leaveApproval = enter(() => false);
    fake.tap();
    leaveApproval(); await settled();
    enter(() => {})(); await settled();
    expect(fake.at()).toBe(start);
  });

  it.each(["/?", "/#"])("steps off the confirmation after widening restores the sidebar preference in its %s URL", async (base) => {
    const start = fake.at();
    const history = fake.window.history;
    const before = fake.window.location.href;
    const document = Object.getOwnPropertyDescriptor(globalThis, "document");
    if (base === "/#") Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => "relay" }) } });
    try {
      history.replaceState(history.state, "", `${base}pane=a&settings=devices`);
      fake.tap();
      const leave = enter(() => {});
      history.replaceState(history.state, "", `${fake.window.location.href}&sidebar=hidden`);
      leave(); await settled();
      expect(fake.at()).toBe(start);
    } finally {
      history.replaceState(history.state, "", before);
      if (document) Object.defineProperty(globalThis, "document", document); else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("rebuilds Settings levels when dismissing a confirmation lands without a popstate", async () => {
    const settingsPath = "./settingsHistory.ts?sheet-history-skips-test";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    const start = fake.at();
    fake.tap();
    settings.recordSettings(settings.settingsLevels(true, "devices", false));
    const leave = enter(() => {});
    settings.recordSettings(settings.settingsLevels(false, "devices", false));
    fake.muteNextBack();
    leave(); await settled();
    jest.advanceTimersByTime(1000);
    await settled();
    expect(settings.settingsEntry(h.state)).toEqual({ page: "devices", keyBar: false, depth: 1 });
    settings.recordSettings([]);
    await settled();
    expect(fake.at()).toBe(start);
  });

  it("goes again onto the entry of a sheet that refuses Back, and tells the app both steps were the sheet's own", async () => {
    const start = fake.at();
    let busy = true;
    let asked = 0;
    const own: boolean[] = [];
    fake.window.addEventListener("popstate", () => { own.push(sheetHistory.sheetSteppedOff()); });
    fake.tap();
    const leave = enter(() => { asked += 1; if (busy) return false; });
    const entry = fake.key();
    const entries = fake.entries.length;
    h.back(); await settled();
    expect(asked).toBe(1); expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    expect(own).toEqual([true, true]);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start);
    expect(own).toEqual([true, true, false]);
    leave(); await settled();
  });

  it("makes the entry of a sheet that refused Back at the next tap, when the way back onto its old one is dropped", async () => {
    const start = fake.at();
    let busy = true;
    fake.tap();
    const leave = enter(() => { if (busy) return false; });
    const entries = fake.entries.length;
    fake.drop(true);
    h.back(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start); expect(fake.entries.length).toBe(entries);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    busy = false;
    h.back(); await settled();
    expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("goes again onto the entry the sheet on top took from the one under it, which Back leaves up", async () => {
    const start = fake.at();
    let drawerClosed = 0;
    let menuClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    const entry = fake.key();
    fake.tap();
    const leaveMenu = enter(() => { menuClosed += 1; });
    const entries = fake.entries.length;
    expect(fake.key()).toBe(entry);
    h.back(); await settled();
    expect(menuClosed).toBe(1); expect(drawerClosed).toBe(0);
    expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    leaveMenu(); await settled();
    expect(fake.key()).toBe(entry);
    h.back(); await settled();
    expect(drawerClosed).toBe(1); expect(fake.at()).toBe(start);
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("tells the app its way back onto the entry Back left is on its way until it lands, so no address is written on the entry under it", async () => {
    const start = fake.at();
    fake.tap();
    const leaveDrawer = enter(() => {});
    fake.tap();
    const leaveMenu = enter(() => {});
    const entry = fake.key();
    const pending: Array<["sheet's entry" | "entry under it", boolean]> = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => {
      if (listening) pending.push([(event.state as Record<string, unknown> | null)?.["ovis:sheet"] === undefined ? "entry under it" : "sheet's entry", sheetHistory.sheetTraversalPending()]);
    });
    h.back(); await settled();
    expect(pending).toEqual([["entry under it", true], ["sheet's entry", false]]);
    expect(fake.key()).toBe(entry);
    listening = false;
    leaveMenu(); await settled();
    h.back(); await settled();
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
    expect(sheetHistory.sheetTraversalPending()).toBe(false);
  });

  it("keeps the address off the entry under a sheet whose way back the browser dropped until a tap makes its entry, and says so then", async () => {
    const start = fake.at();
    fake.tap();
    const leaveDrawer = enter(() => {});
    fake.tap();
    const leaveMenu = enter(() => {});
    let over = 0;
    const stop = sheetHistory.onSheetTraversalOver(() => { over += 1; });
    fake.drop(true);
    h.back(); await settled(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start);
    expect(sheetHistory.sheetTraversalPending()).toBe(true);
    leaveMenu(); await settled();
    expect(sheetHistory.sheetTraversalPending()).toBe(true); expect(over).toBe(0);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    expect(sheetHistory.sheetTraversalPending()).toBe(false); expect(over).toBe(1);
    stop();
    h.back(); await settled();
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("tells nothing when the way back for a sheet with no entry that refused Back is dropped: the history is still on another pane's entry", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const leave = enter(() => false);
    let over = 0;
    const stop = sheetHistory.onSheetTraversalOver(() => { over += 1; });
    fake.drop(true);
    h.back(); await settled(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start);
    expect(over).toBe(0);
    stop();
    leave(); await settled();
    jest.advanceTimersByTime(1000);
    h.forward(); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("steps off the entry again when the sheet it came back for closed before the way back landed", async () => {
    const start = fake.at();
    let drawerClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    fake.tap();
    const leaveMenu = enter(() => {});
    // the drawer closes by itself while the history is on its way back onto the entry for it: an
    // app's listener, after the module's, closes it as the Back that closed the menu is heard, and
    // its own leave runs before that way back lands (a browser lands a traversal later than a timer)
    let closing = true;
    fake.window.addEventListener("popstate", () => { if (closing) { closing = false; leaveDrawer(); jest.advanceTimersByTime(1); } });
    h.back(); await settled(); await settled();
    leaveMenu(); await settled();
    expect(fake.at()).toBe(start);
    expect(drawerClosed).toBe(0);
    expect(sheetHistory.sheetSteppedOff()).toBe(true);
  });

  it("makes the entry of a sheet that opens with no new tap after a closed sheet's own step: the tap before it still counts", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFirst = enter(() => {});
    expect(fake.at()).toBe(start + 1);
    leaveFirst(); await settled();
    expect(fake.at()).toBe(start);
    let closed = 0;
    const leaveSecond = enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveSecond(); await settled();
  });

  it("takes the entry the user's Back left for the file list that comes back in front with it, and tells the file's viewer the way onto it is not its own", async () => {
    const start = fake.at();
    const address = fake.window.location.href;
    const shown: unknown[] = [];
    fake.window.addEventListener("popstate", (event) => { shown.push(sheetStep.taking(event as unknown as Event) ? "taken" : (event.state as Record<string, unknown> | null)?.["file"] ?? null); });
    fake.tap();
    h.pushState({ file: "notes.txt" }, "", "/?pane=a&file=notes.txt");
    const fileEntry = fake.key();
    h.back(); await settled();
    expect(shown).toEqual([null]);
    let closed = 0;
    const entries = fake.entries.length;
    const leave = enter(() => { closed += 1; }, true);
    await settled();
    expect(fake.key()).toBe(fileEntry); expect(fake.entries.length).toBe(entries);
    expect((h.state as Record<string, unknown>)["file"]).toBeUndefined();
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    expect(fake.window.location.href).toBe(address);
    expect(sheetHistory.sheetSteppedOff()).toBe(true);
    expect(shown).toEqual([null, "taken"]);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    expect(shown).toEqual([null, "taken", null]);
    leave(); await settled();
  });

  it("goes back off that entry when the list closed before the way onto it landed, and the file is not shown again", async () => {
    const start = fake.at();
    const shown: unknown[] = [];
    fake.window.addEventListener("popstate", (event) => { shown.push(sheetStep.taking(event as unknown as Event) ? "taken" : (event.state as Record<string, unknown> | null)?.["file"] ?? null); });
    fake.tap();
    h.pushState({ file: "notes.txt" }, "");
    h.back(); await settled();
    const leave = enter(() => {}, true);
    expect(fake.at()).toBe(start + 1);
    leave();
    await settled(); await settled();
    expect(fake.at()).toBe(start);
    expect(shown).toEqual([null, "taken", null]);
    expect(sheetHistory.sheetSteppedOff()).toBe(true);
  });

  it("waits for a tap after all when the browser drops the way onto the entry the Back left", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ file: "notes.txt" }, "");
    h.back(); await settled();
    fake.drop(true);
    let closed = 0;
    const leave = enter(() => { closed += 1; }, true);
    await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("leaves the entry ahead alone once a tap came: the sheet makes its own", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ file: "notes.txt" }, "");
    const fileEntry = fake.key();
    h.back(); await settled();
    fake.tap();
    const leave = enter(() => {}, true);
    await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.key()).not.toBe(fileEntry);
    leave(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("makes the entry of a dialog that comes back from under a file closed by its own control, with no new tap", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFiles = enter(() => {});
    h.pushState({ file: true }, "");
    leaveFiles(); await settled();
    expect(fake.at()).toBe(start + 1);
    expect(sheetStep.goingBack(h.state)).toBe(false);
    h.go(-1); await settled();
    expect(fake.at()).toBe(start);
    let closed = 0;
    const leaveAgain = enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveAgain(); await settled();
  });

  it("makes the entry of a sheet left up by a step the app took by itself at once, where the step landed", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ dialog: true }, "");
    let closed = 0;
    const leave = enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 2);
    expect(sheetStep.goingBack(h.state)).toBe(true);
    h.go(-2); await settled();
    expect(closed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.entries.length).toBe(start + 2);
    expect((h.state as Record<string, unknown>)["dialog"]).toBeUndefined();
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("keeps the app where it is when a sheet with no entry of its own refuses Back: the history goes again onto the entry it stood on, and both steps are held", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const entry = fake.key();
    const steps: Array<[boolean, boolean, unknown]> = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => { if (listening) steps.push([sheetStep.holds(event as unknown as Event), sheetHistory.sheetSteppedOff(), (event.state as Record<string, unknown> | null)?.["pane"] ?? null]); });
    let asked = 0;
    const entries = fake.entries.length;
    const leave = enter(() => { asked += 1; return false; });
    expect(fake.entries.length).toBe(entries); expect(fake.key()).toBe(entry);
    h.back(); await settled();
    expect(asked).toBe(1);
    expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    expect(steps).toEqual([[true, true, null], [true, true, "b"]]);
    h.forward(); await settled();
    expect(asked).toBe(2); expect(fake.key()).toBe(entry);
    expect(steps.slice(2)).toEqual([[true, true, "c"], [true, true, "b"]]);
    fake.tap();
    expect(fake.at()).toBe(start + 2);
    h.back(); await settled();
    expect(asked).toBe(3); expect(fake.at()).toBe(start + 2);
    expect(steps.slice(4).map(([held]) => held)).toEqual([false, false]);
    listening = false;
    leave(); await settled();
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("answers a listener that hears the event before its own does: the sheets are asked then, and once", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const entry = fake.key();
    const held: boolean[] = [];
    let listening = true;
    fake.first((event) => { if (listening) held.push(sheetStep.holds(event as unknown as Event)); });
    let asked = 0;
    const leave = enter(() => { asked += 1; return false; });
    h.back(); await settled();
    expect(held).toEqual([true, true]);
    expect(asked).toBe(1); expect(fake.key()).toBe(entry);
    listening = false;
    leave(); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("asks the sheet opened last first, and one that refuses keeps Back from the sheets under it", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const entry = fake.key();
    let closed = 0;
    const leaveUnder = enter(() => { closed += 1; });
    const leaveOver = enter(() => false);
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.key()).toBe(entry);
    leaveOver(); await settled();
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveUnder(); await settled();
  });

  it("takes the way back again when another Back overtakes it: the history still ends on the entry it stood on", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.pushState({ pane: "d" }, "", "/?pane=d");
    h.back(); await settled();
    const entry = fake.key();
    const leave = enter(() => false);
    // the browser drops the way back onto C, as when the user's second Back overtakes it
    fake.drop(true);
    h.back(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(fake.key()).toBe(entry);
    leave(); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start + 1); expect(sheetHistory.sheetSteppedOff()).toBe(false);
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("follows the user's Forward onto the entry a refused Back left, once the request that refused is gone and the way back never landed", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const entry = fake.key();
    const held: boolean[] = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => { if (listening) held.push(sheetStep.holds(event as unknown as Event)); });
    const leave = enter(() => false);
    fake.drop(true);
    h.back(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start); expect(held).toEqual([true]);
    leave(); await settled();
    h.forward(); await settled();
    expect(fake.key()).toBe(entry);
    expect(held).toEqual([true, false]); expect(sheetHistory.sheetSteppedOff()).toBe(false);
    listening = false;
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("holds the landing of a way back still on its way when the request that refused it closed meanwhile: a sheet that opened since is not asked", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const entry = fake.key();
    const leave = enter(() => false);
    const held: boolean[] = [];
    const next: { asked: number; leave?: () => void } = { asked: 0 };
    let listening = true;
    fake.window.addEventListener("popstate", (event) => {
      if (!listening) return;
      held.push(sheetStep.holds(event as unknown as Event));
      if (next.leave === undefined) { leave(); next.leave = enter(() => { next.asked += 1; }); }
    });
    h.back(); await settled();
    expect(fake.key()).toBe(entry); expect(held).toEqual([true, true]); expect(next.asked).toBe(0);
    listening = false;
    next.leave?.(); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });
});

describe("a sheet that stays up under a navigation which took its entry", () => {
  const stay = (onBack: () => boolean | void): (() => void) => { const id = sheetHistory.enterSheet(onBack, null, true); return () => sheetHistory.leaveSheet(id); };

  it("takes its entry back when the user's Back closes the navigation, and the next Back closes the sheet alone", async () => {
    const start = fake.at();
    const address = fake.window.location.href;
    const shown: unknown[] = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => { if (listening) shown.push(sheetStep.taking(event as unknown as Event) ? "taken" : (event.state as Record<string, unknown> | null)?.["settings"] ?? null); });
    let closed = 0;
    fake.tap();
    const leave = stay(() => { closed += 1; });
    const entry = fake.key();
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 1 }, "", "/?pane=a&settings=list");
    expect(fake.key()).toBe(entry); expect((h.state as Record<string, unknown>)["ovis:sheet"]).toBeUndefined();
    const entries = fake.entries.length;
    h.back(); await settled();
    expect(closed).toBe(0);
    expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    expect((h.state as Record<string, unknown>)["settings"]).toBeUndefined();
    expect(fake.window.location.href).toBe(address);
    expect(shown).toEqual([null, "taken"]);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    listening = false;
    leave(); await settled();
  });

  it("stays under the navigation while Back moves between the navigation's own entries", async () => {
    const start = fake.at();
    let closed = 0;
    fake.tap();
    const leave = stay(() => { closed += 1; });
    const entry = fake.key();
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 1 }, "", "/?pane=a&settings=list");
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 2 }, "", "/?pane=a&settings=page");
    expect(fake.at()).toBe(start + 2);
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.key()).toBe(entry);
    expect((h.state as Record<string, unknown>)["settings"]).toBe(1);
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.key()).toBe(entry);
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("stays under a navigation that took the entry from a menu opened over it", async () => {
    const start = fake.at();
    let closed = 0;
    fake.tap();
    const leave = stay(() => { closed += 1; });
    const entry = fake.key();
    fake.tap();
    const leaveMenu = enter(() => {});
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 1 }, "", "/?pane=a&settings=list");
    leaveMenu(); await settled();
    expect(fake.key()).toBe(entry);
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 2 }, "", "/?pane=a&settings=page");
    h.back(); await settled();
    fake.tap();
    expect(closed).toBe(0); expect(fake.key()).toBe(entry); expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.key()).toBe(entry);
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("is not kept from a traversal while it is under a sheet alone, also once a navigation has been over it: Forward off the menu over it closes the menu, and the entry is the sheet's own again", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.pushState({ pane: "d" }, "", "/?pane=d");
    h.back(); await settled();
    h.back(); await settled();
    let listClosed = 0;
    const list = sheetHistory.enterSheet(() => { listClosed += 1; }, null, true, true);
    await settled();
    expect(fake.at()).toBe(start + 2);
    const entry = fake.key();
    fake.tap();
    h.pushState({ ...(h.state as object), file: 1 }, "", "/?pane=b&file=1");
    h.back(); await settled();
    expect(listClosed).toBe(0); expect(fake.key()).toBe(entry);
    let menuClosed = 0;
    fake.tap();
    const leaveMenu = enter(() => { menuClosed += 1; });
    expect(fake.key()).toBe(entry);
    h.forward(); await settled();
    leaveMenu(); await settled();
    expect(menuClosed).toBe(1); expect(listClosed).toBe(0);
    expect(fake.key()).toBe(entry); expect((h.state as Record<string, unknown>)["ovis:sheet"]).toBe(list);
    h.back(); await settled();
    expect(listClosed).toBe(1); expect(fake.at()).toBe(start + 1);
    sheetHistory.leaveSheet(list); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });
});

describe("a phone's sheet where Back skips an entry made with no tap, in a browser with no Navigation API: each entry's place is kept in its state", () => {
  const api = fake.window.navigation;
  beforeEach(() => { (fake.window as { navigation?: unknown }).navigation = undefined; });
  afterEach(() => { fake.window.navigation = api; });
  const sheetOn = (): unknown => (h.state as Record<string, unknown> | null)?.["ovis:sheet"];
  const stay = (onBack: () => boolean | void): (() => void) => { const id = sheetHistory.enterSheet(onBack, null, true); return () => sheetHistory.leaveSheet(id); };

  it("goes onto the drawer's entry again when Back closes the menu over it, and the next Back closes the drawer alone", async () => {
    const start = fake.at();
    const own: boolean[] = [];
    let listening = true;
    fake.window.addEventListener("popstate", () => { if (listening) own.push(sheetHistory.sheetSteppedOff()); });
    let drawerClosed = 0;
    let menuClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    fake.tap();
    const leaveMenu = enter(() => { menuClosed += 1; });
    const entries = fake.entries.length;
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(menuClosed).toBe(1); expect(drawerClosed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.entries.length).toBe(entries);
    expect(typeof sheetOn()).toBe("string");
    expect(own).toEqual([true, true]);
    leaveMenu(); await settled();
    h.back(); await settled();
    expect(drawerClosed).toBe(1); expect(fake.at()).toBe(start);
    expect(own).toEqual([true, true, false]);
    listening = false;
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("goes again onto the entry of a sheet that refuses Back", async () => {
    const start = fake.at();
    let busy = true;
    let asked = 0;
    fake.tap();
    const leave = enter(() => { asked += 1; if (busy) return false; });
    const entries = fake.entries.length;
    h.back(); await settled();
    expect(asked).toBe(1); expect(fake.at()).toBe(start + 1); expect(fake.entries.length).toBe(entries);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("goes onto the drawer's entry again after a jump back past more than one entry, as it does by the browser's own keys", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    let drawerClosed = 0;
    let menuClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    fake.tap();
    const leaveMenu = enter(() => { menuClosed += 1; });
    expect(fake.at()).toBe(start + 2);
    h.go(-2); await settled();
    expect(menuClosed).toBe(1); expect(drawerClosed).toBe(0);
    expect(fake.at()).toBe(start + 2); expect(typeof sheetOn()).toBe("string");
    leaveMenu(); await settled();
    h.back(); await settled();
    expect(drawerClosed).toBe(1); expect(fake.at()).toBe(start + 1);
    expect(sheetHistory.sheetSteppedOff()).toBe(false);
    leaveDrawer(); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps the app where it is when a sheet with no entry of its own refuses Back, and Forward", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    h.replaceState({ pane: "b", shown: true }, "", "/?pane=b");
    expect((h.state as Record<string, unknown>)["shown"]).toBe(true);
    const steps: Array<[boolean, boolean, unknown]> = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => { if (listening) steps.push([sheetStep.holds(event as unknown as Event), sheetHistory.sheetSteppedOff(), (event.state as Record<string, unknown> | null)?.["pane"] ?? null]); });
    let asked = 0;
    const entries = fake.entries.length;
    const leave = enter(() => { asked += 1; return false; });
    expect(fake.entries.length).toBe(entries); expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(asked).toBe(1); expect(fake.at()).toBe(start + 1); expect(fake.entries.length).toBe(entries);
    expect(steps).toEqual([[true, true, null], [true, true, "b"]]);
    h.forward(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start + 1);
    expect(steps.slice(2)).toEqual([[true, true, "c"], [true, true, "b"]]);
    listening = false;
    leave(); await settled();
    h.back(); await settled();
    expect(fake.at()).toBe(start); expect(sheetHistory.sheetSteppedOff()).toBe(false);
  });

  it("waits no longer than a step takes for a way back that landed nowhere: with the request gone, the user's Forward onto the entry is the app's to follow", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "c" }, "", "/?pane=c");
    h.back(); await settled();
    const held: boolean[] = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => { if (listening) held.push(sheetStep.holds(event as unknown as Event)); });
    const leave = enter(() => false);
    // the request refuses Back, and the step back onto B lands nowhere: a browser with no Navigation API tells nothing of it
    fake.drop(true);
    h.back(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start); expect(held).toEqual([true]);
    leave(); await settled();
    jest.advanceTimersByTime(1000);
    h.forward(); await settled();
    expect(fake.at()).toBe(start + 1);
    expect(held).toEqual([true, false]); expect(sheetHistory.sheetSteppedOff()).toBe(false);
    listening = false;
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("leaves a staying sheet under a navigation while Back moves between the navigation's own entries, and gives it its entry back after", async () => {
    const start = fake.at();
    let closed = 0;
    fake.tap();
    const leave = stay(() => { closed += 1; });
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 1 }, "", "/?pane=a&settings=list");
    expect(fake.at()).toBe(start + 1); expect(sheetOn()).toBeUndefined();
    fake.tap();
    h.pushState({ ...(h.state as object), settings: 2 }, "", "/?pane=a&settings=page");
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.at()).toBe(start + 1);
    expect((h.state as Record<string, unknown>)["settings"]).toBe(1);
    const entries = fake.entries.length;
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.at()).toBe(start + 1); expect(fake.entries.length).toBe(entries);
    expect(typeof sheetOn()).toBe("string");
    expect((h.state as Record<string, unknown>)["settings"]).toBeUndefined();
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("lets go of a way onto an entry that another traversal overtook: the next sheet that comes back in front finds its own", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    h.pushState({ pane: "b", file: "a.txt" }, "");
    h.back(); await settled();
    let closed = 0;
    fake.drop(true);
    const leaveFirst = enter(() => { closed += 1; }, true);
    fake.drop(false);
    h.back(); await settled(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveFirst(); await settled();
    fake.tap();
    h.pushState({ pane: "a", file: "b.txt" }, "");
    h.back(); await settled();
    const leaveSecond = enter(() => {}, true);
    await settled();
    expect(fake.at()).toBe(start + 1); expect(typeof sheetOn()).toBe("string");
    h.back(); await settled();
    expect(fake.at()).toBe(start);
    leaveSecond(); await settled();
  });

  it("tells nothing when the sheet a way back past more than one entry was for closes before it lands: the history is on another pane's entry", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    fake.tap();
    const leaveDrawer = enter(() => {});
    fake.tap();
    const leaveMenu = enter(() => {});
    let over = 0;
    const stop = sheetHistory.onSheetTraversalOver(() => { over += 1; });
    // the user's jump lands on pane a; the way back onto b's drawer, a step by count, is dropped with no word
    let jumped = false;
    fake.first(() => { if (!jumped) { jumped = true; fake.drop(true); } });
    h.go(-2); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start);
    expect(sheetHistory.sheetTraversalPending()).toBe(true);
    leaveMenu(); await settled();
    leaveDrawer(); await settled();
    expect(sheetHistory.sheetTraversalPending()).toBe(false); expect(over).toBe(0);
    stop();
    h.forward(); await settled(); await settled();
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("holds no address once every sheet is closed, when the way back onto the entry Back left lands nowhere", async () => {
    const start = fake.at();
    fake.tap();
    const leaveDrawer = enter(() => {});
    fake.tap();
    const leaveMenu = enter(() => {});
    let over = 0;
    const stop = sheetHistory.onSheetTraversalOver(() => { over += 1; });
    // the way back is a step by count here, which the browser drops with no word
    fake.drop(true);
    h.back(); await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start);
    expect(sheetHistory.sheetTraversalPending()).toBe(true);
    leaveMenu(); await settled();
    leaveDrawer(); await settled();
    expect(sheetHistory.sheetTraversalPending()).toBe(false); expect(over).toBe(0);
    // a sheet opened afresh, with no traversal since, is no sheet that way back was for
    fake.tap();
    const leaveFresh = enter(() => {});
    expect(typeof sheetOn()).toBe("string");
    expect(sheetHistory.sheetTraversalPending()).toBe(false); expect(over).toBe(1);
    stop();
    leaveFresh(); await settled();
    expect(fake.at()).toBe(start);
    // the next traversal lets go of the way that landed nowhere
    h.forward(); await settled(); await settled();
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("tells nothing on an entry the browser made by itself, and counts anew from it at the next push", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ pane: "b" }, "", "/?pane=b");
    fake.fragment("/?pane=b#notes");
    h.back(); await settled();
    const held: boolean[] = [];
    let listening = true;
    fake.window.addEventListener("popstate", (event) => { if (listening) held.push(sheetStep.holds(event as unknown as Event)); });
    let asked = 0;
    let busy = true;
    const leave = enter(() => { asked += 1; if (busy) return false; });
    h.forward(); await settled();
    expect(asked).toBe(1); expect(fake.at()).toBe(start + 2);
    expect(held).toEqual([false]);
    listening = false;
    fake.tap();
    expect(fake.at()).toBe(start + 3);
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start + 3);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(3); expect(fake.at()).toBe(start + 2);
    leave(); await settled();
    h.go(-2); await settled();
    expect(fake.at()).toBe(start);
  });
});
