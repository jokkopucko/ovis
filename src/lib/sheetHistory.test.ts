import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { sheetStep } from "./historyKeys.ts";

let originalWindow: PropertyDescriptor | undefined;

/** A browser's history as the module uses it: entries with a state and an address, a cursor, popstate after a traversal. */
function fakeWindow() {
  const entries: Array<{ state: unknown; href: string }> = [{ state: null, href: "/?pane=a" }];
  let index = 0;
  const listeners: Array<(event: { state: unknown }) => void> = [];
  /** a browser runs a traversal later, toward the entry it named when called: a test turns this on to open something meanwhile */
  let deferred = false;
  let pending = false;
  const traverse = (by: number): void => {
    const next = Math.max(0, Math.min(entries.length - 1, index + by));
    if (next === index) return;
    // one event for every listener, as a browser dispatches it
    const dispatch = (): void => { const event = { state: entries[index]!.state }; for (const listener of listeners) listener(event); };
    const land = (): void => {
      index = Math.min(next, entries.length - 1);
      dispatch();
    };
    if (!deferred) { index = next; queueMicrotask(dispatch); return; }
    pending = true;
    setTimeout(() => { pending = false; land(); }, 1);
  };
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); entries.push({ state, href: url ?? entries[index]!.href }); index += 1; },
    replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href }; },
    back() { traverse(-1); },
    forward() { traverse(1); },
    go(by: number) { traverse(by); },
  };
  const window = {
    history,
    get location() { return { href: entries[index]!.href }; },
    addEventListener(type: string, listener: (event: { state: unknown }) => void) { if (type === "popstate") listeners.push(listener); },
  };
  return { window, entries, at: () => index, defer: (on: boolean) => { deferred = on; }, pending: () => pending, marks: () => entries.map((entry) => typeof (entry.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string") };
}
const fake = fakeWindow();
const settled = async () => {
  jest.advanceTimersByTime(1);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
};

const h = fake.window.history;
/** RowMenu's effect, without React: the hook's enter on mount and leave on unmount (sheetHistory exports them for this) */
let sheetHistory: typeof import("./sheetHistory.ts");
const hooks = { enter: (onBack: () => void, stays = false): (() => void) => { const id = sheetHistory.enterSheet(onBack, null, stays); return () => sheetHistory.leaveSheet(id); } };

beforeAll(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fake.window });
  // Markdown's lightbox may have loaded the normal module before this window existed.
  // A test-only instance installs its history wrapper and listener on our own browser.
  const modulePath = "./sheetHistory.ts?sheet-history-test";
  sheetHistory = await import(modulePath);
});
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
});

describe("a phone's sheet in the history", () => {
  it("is an entry Back closes, and leaves no entry behind when closed another way", async () => {
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; });
    expect(fake.entries.length).toBe(2); expect(fake.marks()).toEqual([false, true]);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(0);
    leave();
    // Cancel: the sheet's entry is stepped off after the click's effects
    const leave2 = hooks.enter(() => { closed += 1; });
    expect(fake.at()).toBe(1);
    leave2(); await settled();
    expect(fake.at()).toBe(0); expect(closed).toBe(1);
  });

  it("marks the entry it opens over with its id, so a navigation that takes its entry can tell that entry", async () => {
    const start = fake.at();
    const leave = hooks.enter(() => undefined);
    const under = (fake.entries[start]!.state as Record<string, unknown>)["ovis:sheet-under"];
    const own = fake.entries[start + 1]!.state as Record<string, unknown>;
    expect(typeof under).toBe("string");
    expect(own["ovis:sheet"]).toBe(under);
    expect(own["ovis:sheet-under"]).toBe(under);
    leave(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("gives its entry to a navigation an item makes, so Back goes to the pane before and Forward returns", async () => {
    // on pane a (entry 0); the retired entry of the first test lies at 1
    const leave = hooks.enter(() => {});
    const length = fake.entries.length;
    leave();
    // the item's navigation, in the same click: another pane is an entry of its own in the app
    h.pushState({ nav: true }, "", "/?pane=b");
    await settled();
    expect(fake.entries.length).toBe(length);
    expect(fake.marks()).toEqual([false, false]);
    expect(fake.window.location.href).toBe("/?pane=b");
    h.back(); await settled();
    expect(fake.window.location.href).toBe("/?pane=a");
    h.forward(); await settled();
    expect(fake.window.location.href).toBe("/?pane=b");
  });

  it("keeps its entry for an item that changed the address on it, instead of stepping back", async () => {
    // the New tab dialog: the app replaces the entry's address while the sheet leaves
    const leave = hooks.enter(() => {});
    leave();
    h.replaceState(h.state, "", "/?pane=b&new=tab");
    await settled();
    expect(fake.window.location.href).toBe("/?pane=b&new=tab");
    expect(fake.marks().at(-1)).toBe(false);
    h.back(); await settled();
    expect(fake.window.location.href).toBe("/?pane=b");
  });

  it("reuses the entry for a sheet opened from a sheet", async () => {
    const start = fake.at();
    const leaveFirst = hooks.enter(() => {});
    leaveFirst();
    // a sheet opened from a sheet's item: the second mounts in the first's closing click
    const leaveSecond = hooks.enter(() => {});
    await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps the entry of a sheet that refuses Back while busy, and lets it go once it closes", async () => {
    const start = fake.at();
    let busy = true;
    let asked = 0;
    const leave = hooks.enter(() => { asked += 1; if (busy) return false; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(asked).toBe(1);
    // the dialog stayed: its entry is back over the pane, so the next Back asks it again
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start);
    leave(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("goes on past the entry of a sheet that Back closed when Forward lands on it", async () => {
    const start = fake.at();
    let closed = 0;
    hooks.enter(() => { closed += 1; });
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    // beyond the retired entry: nothing, so Forward stays put on it as an ordinary entry
    h.forward(); await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(false);
  });

  it("keeps a sheet that opens while the step off a closed sheet's entry is on its way", async () => {
    const start = fake.at();
    let closed = 0;
    const leaveFirst = hooks.enter(() => {});
    fake.defer(true);
    leaveFirst();
    // the leave's step back is called, and the browser has not run it yet
    jest.advanceTimersByTime(0);
    expect(fake.pending()).toBe(true);
    const leaveSecond = hooks.enter(() => { closed += 1; });
    await settled();
    fake.defer(false);
    expect(fake.pending()).toBe(false);
    expect(closed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    // its entry is an ordinary sheet's: Back closes it onto the pane, and closing it steps off nothing more
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps a sheet that stays up under another sheet: that sheet's close, or a Back, comes back to it", async () => {
    const start = fake.at();
    let peekClosed = 0;
    let moreClosed = 0;
    // a terminal peek (App's usePhoneSheetBack, staying), then the header's ⋯ menu over it
    const leavePeek = hooks.enter(() => { peekClosed += 1; }, true);
    const leaveMore = hooks.enter(() => { moreClosed += 1; });
    expect(fake.at()).toBe(start + 1);
    // the menu's Cancel: it steps off, and the peek's entry is made again
    leaveMore(); await settled();
    expect(peekClosed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    // Back with the menu up closes the menu alone
    const leaveMoreAgain = hooks.enter(() => { moreClosed += 1; });
    h.back(); await settled();
    expect(moreClosed).toBe(1); expect(peekClosed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    leaveMoreAgain(); await settled();
    expect(fake.at()).toBe(start + 1);
    // and the next Back is the peek's
    h.back(); await settled();
    expect(peekClosed).toBe(1); expect(fake.at()).toBe(start);
    leavePeek(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps a sheet that stays up under a navigation, and makes its entry again when the navigation goes", async () => {
    const start = fake.at();
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; }, true);
    // Settings opened over it: its entry takes the sheet's, and leaving it lands under both
    h.pushState({ settings: true }, "", "/?pane=b&settings=general");
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    expect(fake.window.location.href).toBe(fake.entries[start]!.href);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("closes any other sheet still up under one opened over it with that one, as before", async () => {
    // the Files dialog under the palette: the palette's close steps off and closes Files too
    const start = fake.at();
    let filesClosed = 0;
    const leaveFiles = hooks.enter(() => { filesClosed += 1; });
    const leavePalette = hooks.enter(() => {});
    leavePalette(); await settled();
    expect(filesClosed).toBe(1); expect(fake.at()).toBe(start);
    leaveFiles(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("tells the app a closed sheet's own step off its entry from a Back", async () => {
    // the app's Back listens after this module, as App's effect does
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => { seen.push(sheetHistory.sheetSteppedOff()); });
    // an item that opened a pane the roster does not list yet: nothing wrote the address, so the sheet steps back
    const leave = hooks.enter(() => {});
    leave(); await settled();
    expect(seen).toEqual([true]);
    hooks.enter(() => {});
    h.back(); await settled();
    expect(seen).toEqual([true, false]);
  });

  it("answers whether a popstate is that step, before it handles the event and after (#2000)", async () => {
    const answers: boolean[] = [];
    fake.window.addEventListener("popstate", (event) => { answers.push(sheetStep.lands(event as unknown as Event)); });
    const leave = hooks.enter(() => {});
    fake.defer(true);
    leave();
    // the step back is asked for; until it lands, a popstate not yet handled here is that step
    jest.advanceTimersByTime(0);
    expect(fake.pending()).toBe(true);
    expect(sheetStep.lands({} as Event)).toBe(true);
    await settled();
    fake.defer(false);
    hooks.enter(() => {});
    h.back(); await settled();
    expect(answers).toEqual([true, false]);
  });

  // last: Settings' module stays on this browser from here, after this module, as in the app
  it("keeps Settings opened before a closed palette's step lands, over a peek that stays up too (#2000)", async () => {
    const settingsPath = "./settingsHistory.ts?with-sheets";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    const moves: Array<boolean> = [];
    settings.onSettingsHistory((_entry, own) => moves.push(own));
    let peekClosed = 0;
    const leavePeek = hooks.enter(() => { peekClosed += 1; }, true);
    const leavePalette = hooks.enter(() => {});
    fake.defer(true);
    leavePalette();
    jest.advanceTimersByTime(0);
    expect(fake.pending()).toBe(true);
    // Settings opens before the palette's step back lands
    settings.recordSettings(settings.settingsLevels(true, null, false));
    await settled();
    fake.defer(false);
    expect(moves).toEqual([]);
    expect(settings.settingsEntry(h.state)).toEqual({ page: null, keyBar: false, depth: 1 });
    expect(peekClosed).toBe(0);
    // and Settings closed by its X leaves the peek up, on its entry
    settings.recordSettings([]);
    await settled();
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(peekClosed).toBe(0);
    leavePeek(); await settled();

    // a sheet closed above Settings (a lightbox in a preview opened over it) steps onto the preview's
    // entry: not the entry the palette opened over, so Settings is not made again there
    const leaveRoute = hooks.enter(() => {});
    settings.recordSettings(settings.settingsLevels(true, null, false));
    leaveRoute(); await settled();
    h.pushState({ ...settings.outsideSettings(h.state), "ovis:file-preview": { path: "README.md" } }, "");
    const leaveLightbox = hooks.enter(() => {});
    leaveLightbox(); await settled();
    expect((h.state as Record<string, unknown>)["ovis:file-preview"]).toBeDefined();
    expect(settings.settingsEntry(h.state)).toBeNull();
  });

  // after the one above: Settings' module is on this browser
  it("closes Settings when it closes while a sheet opened inside it is still stepping off its entry", async () => {
    const settingsPath = "./settingsHistory.ts?with-sheets";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    // Phone & devices on a phone: the list, then the page; Pair a device opens Connect a phone's sheet over it
    settings.recordSettings(settings.settingsLevels(true, "devices", false));
    await settled();
    const base = fake.at() - 2;
    const leaveConnect = hooks.enter(() => {});
    const reopened: boolean[] = [];
    const stopListening = settings.onSettingsHistory((entry, own) => { if (entry !== null && !own) reopened.push(true); });
    // the phone pairs: the sheet closes by itself, and its step back is queued for after this task.
    // Escape closes Settings before that step runs
    leaveConnect();
    settings.recordSettings([]);
    await settled();
    await settled();
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(fake.at()).toBe(base);
    expect(reopened).toEqual([]);
    stopListening();
  });

  it("closes Settings too when the closed sheet's entry had its address changed before its step back", async () => {
    const settingsPath = "./settingsHistory.ts?with-sheets";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    settings.recordSettings(settings.settingsLevels(true, "devices", false));
    await settled();
    const base = fake.at() - 2;
    const leaveConnect = hooks.enter(() => {});
    const reopened: boolean[] = [];
    const stopListening = settings.onSettingsHistory((entry, own) => { if (entry !== null && !own) reopened.push(true); });
    // the app writes another address on the sheet's entry (a renamed workspace) as the sheet closes
    h.replaceState(h.state, "", "/?pane=renamed");
    leaveConnect();
    settings.recordSettings([]);
    await settled();
    await settled();
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(fake.at()).toBe(base);
    expect(reopened).toEqual([]);
    stopListening();
  });
});
