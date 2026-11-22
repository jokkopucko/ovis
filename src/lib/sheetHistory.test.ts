import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { sheetStep } from "./historyKeys.ts";

let originalWindow: PropertyDescriptor | undefined;

function fakeWindow() {
  let keys = 0;
  const entries: Array<{ state: unknown; href: string; key: string }> = [{ state: null, href: "/?pane=a", key: "k0" }];
  let index = 0;
  const listeners: Array<(event: { state: unknown }) => void> = [];
  /** a browser runs a traversal later, toward the entry it named when called: a test turns this on to open something meanwhile */
  let deferred = false;
  let pending = false;
  /** or holds every traversal until the test releases them, in order */
  let holding = false;
  const held: Array<() => void> = [];
  const traverse = (by: number): void => {
    const next = Math.max(0, Math.min(entries.length - 1, index + by));
    if (next === index) return;
    // one event for every listener, as a browser dispatches it
    const dispatch = (): void => { const event = { state: entries[index]!.state }; for (const listener of listeners) listener(event); };
    const land = (): void => {
      index = Math.min(next, entries.length - 1);
      dispatch();
    };
    if (holding) { pending = true; held.push(() => { pending = false; land(); }); return; }
    if (!deferred) { index = next; queueMicrotask(dispatch); return; }
    pending = true;
    setTimeout(() => { pending = false; land(); }, 1);
  };
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); keys += 1; entries.push({ state, href: url ?? entries[index]!.href, key: `k${keys}` }); index += 1; },
    replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href, key: entries[index]!.key }; },
    back() { traverse(-1); },
    forward() { traverse(1); },
    go(by: number) { traverse(by); },
  };
  const window = {
    history,
    get location() { return { href: entries[index]!.href }; },
    addEventListener(type: string, listener: (event: { state: unknown }) => void) { if (type === "popstate") listeners.push(listener); },
  };
  /** the browser's key for each entry, as the Navigation API tells it: a test hands it to the window */
  const navigation = {
    get currentEntry() { return { key: entries[index]!.key, index }; },
    entries() { return entries.map((entry, at) => ({ key: entry.key, index: at })); },
  };
  return { window, entries, navigation, at: () => index, defer: (on: boolean) => { deferred = on; },
    hold: () => { holding = true; }, release: () => { holding = false; for (const go of held.splice(0)) go(); }, pending: () => pending, marks: () => entries.map((entry) => typeof (entry.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string") };
}
const fake = fakeWindow();
const settled = async () => {
  jest.advanceTimersByTime(1);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
};

const h = fake.window.history;
let sheetHistory: typeof import("./sheetHistory.ts");
const hooks = { enter: (onBack: () => void, stays = false): (() => void) => { const id = sheetHistory.enterSheet(onBack, null, stays); return () => sheetHistory.leaveSheet(id); } };

beforeAll(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fake.window });
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
    const leave = hooks.enter(() => {});
    const length = fake.entries.length;
    leave();
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
    h.forward(); await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(false);
  });

  it("leaves a retired entry copied from a web page's as one more of the page's, so closing the page goes past it (#3058)", async () => {
    const start = fake.at();
    const under = h.state;
    h.replaceState({ "ovis:web-panel": { url: "http://localhost:3000/a" }, "ovis:web-panel-below": 1 }, "");
    hooks.enter(() => {});
    h.back(); await settled();
    h.forward(); await settled();
    expect(fake.at()).toBe(start + 1);
    expect(h.state).toMatchObject({ "ovis:web-panel": { url: "http://localhost:3000/a" }, "ovis:web-panel-below": 2 });
    h.replaceState(null, "");
    h.back(); await settled();
    h.replaceState(under, "");
    hooks.enter(() => {});
    h.back(); await settled();
    h.forward(); await settled();
    expect(h.state).not.toHaveProperty("ovis:web-panel-below");
    h.replaceState({ "ovis:file-preview": { path: "/r/README.md", machineId: "local", paneId: "p" }, "ovis:web-panel-below": 2 }, "");
    hooks.enter(() => {});
    h.back(); await settled();
    h.forward(); await settled();
    expect(h.state).toMatchObject({ "ovis:web-panel-below": 3 });
  });

  it("counts a sheet's copy of a plain file's or a diff's entry, kept over it, as one more under it, and not one Forward lands on (#3101)", async () => {
    const under = h.state;
    const href = fake.window.location.href;
    for (const own of [
      { "ovis:file-preview": { path: "/r/README.md", machineId: "local", paneId: "p" } },
      { "ovis:repo-diff": { machineId: "local", paneId: "p", directory: "/r", scope: "workspace", base: null, head: null, comparison: null, path: "a.ts", oldPath: null } },
    ]) {
      h.replaceState(own, "");
      const leave = hooks.enter(() => {});
      h.replaceState(h.state, "", `${href}&new=1`);
      leave(); await settled();
      expect(h.state).toEqual({ ...own, "ovis:sheet-under": expect.any(String), "ovis:web-panel-below": 1 });
      h.back(); await settled();
      hooks.enter(() => {});
      h.back(); await settled();
      h.forward(); await settled();
      expect(h.state).not.toHaveProperty("ovis:web-panel-below");
      h.back(); await settled();
    }
    h.replaceState(under, "", href);
  });

  it("keeps a sheet that opens while the step off a closed sheet's entry is on its way", async () => {
    const start = fake.at();
    let closed = 0;
    const leaveFirst = hooks.enter(() => {});
    fake.defer(true);
    leaveFirst();
    jest.advanceTimersByTime(0);
    expect(fake.pending()).toBe(true);
    const leaveSecond = hooks.enter(() => { closed += 1; });
    await settled();
    fake.defer(false);
    expect(fake.pending()).toBe(false);
    expect(closed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps a sheet that stays up under another sheet: that sheet's close, or a Back, comes back to it", async () => {
    const start = fake.at();
    let peekClosed = 0;
    let moreClosed = 0;
    const leavePeek = hooks.enter(() => { peekClosed += 1; }, true);
    const leaveMore = hooks.enter(() => { moreClosed += 1; });
    expect(fake.at()).toBe(start + 1);
    leaveMore(); await settled();
    expect(peekClosed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    const leaveMoreAgain = hooks.enter(() => { moreClosed += 1; });
    h.back(); await settled();
    expect(moreClosed).toBe(1); expect(peekClosed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    leaveMoreAgain(); await settled();
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(peekClosed).toBe(1); expect(fake.at()).toBe(start);
    leavePeek(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("hands the entry back to a sheet that stays when the one over it closes itself: no step, and no entry made after one", async () => {
    const start = fake.at();
    let drawerClosed = 0;
    let pops = 0;
    fake.window.addEventListener("popstate", () => { pops += 1; });
    const leaveDrawer = hooks.enter(() => { drawerClosed += 1; }, true);
    const leaveMenu = hooks.enter(() => {});
    const entries = fake.entries.length;
    leaveMenu(); await settled();
    expect(pops).toBe(0); expect(fake.entries.length).toBe(entries);
    expect(drawerClosed).toBe(0); expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    const leaveMenuAgain = hooks.enter(() => {});
    leaveMenuAgain();
    const leaveConfirm = hooks.enter(() => {});
    await settled();
    leaveConfirm(); await settled();
    expect(pops).toBe(0); expect(fake.entries.length).toBe(entries);
    expect(drawerClosed).toBe(0); expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(drawerClosed).toBe(1); expect(fake.at()).toBe(start);
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps a sheet that stays up under a navigation, and makes its entry again when the navigation goes", async () => {
    const start = fake.at();
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; }, true);
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

  it("closes a staying sheet by its own Back after the busy sheet over it refused one Back and then opened Settings: the sheet has an entry of its own by then", async () => {
    const start = fake.at();
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; }, true);
    const leaveBusy = hooks.enter(() => false);
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.at()).toBe(start + 2);
    h.pushState({ settings: 1 }, "", "/?pane=b&settings=list");
    leaveBusy(); await settled();
    expect(fake.at()).toBe(start + 2);
    h.back(); await settled();
    expect(closed).toBe(0); expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("leaves a sheet still up under one opened over it: Back closes the one on top, and its own close comes back to the one under", async () => {
    const start = fake.at();
    let filesClosed = 0;
    let confirmClosed = 0;
    const leaveFiles = hooks.enter(() => { filesClosed += 1; });
    const leaveConfirm = hooks.enter(() => { confirmClosed += 1; });
    expect(fake.at()).toBe(start + 1);
    leaveConfirm(); await settled();
    expect(filesClosed).toBe(0); expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    const leaveConfirmAgain = hooks.enter(() => { confirmClosed += 1; });
    h.back(); await settled();
    expect(confirmClosed).toBe(1); expect(filesClosed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    leaveConfirmAgain(); await settled();
    h.back(); await settled();
    expect(filesClosed).toBe(1); expect(fake.at()).toBe(start);
    leaveFiles(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("tells the app a closed sheet's own step off its entry from a Back", async () => {
    const seen: boolean[] = [];
    fake.window.addEventListener("popstate", () => { seen.push(sheetHistory.sheetSteppedOff()); });
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
    jest.advanceTimersByTime(0);
    expect(fake.pending()).toBe(true);
    expect(sheetStep.lands({} as Event)).toBe(true);
    // with no Navigation API it names no entry its step lands on
    expect(sheetHistory.sheetBackOnto()).toBeNull();
    await settled();
    fake.defer(false);
    hooks.enter(() => {});
    h.back(); await settled();
    expect(answers).toEqual([true, false]);
  });

  it("names the entry its step lands on and tells that landing from any other traversal, also when a sheet opened and closed meanwhile (#4221)", async () => {
    const browser = fake.window as { navigation?: unknown };
    browser.navigation = fake.navigation;
    try {
      const landed: boolean[] = [];
      fake.window.addEventListener("popstate", (event) => { landed.push(sheetHistory.sheetBackLanded(event as unknown as Event)); });
      const start = fake.at();
      const under = fake.entries[start]!.key;
      const leaveFirst = hooks.enter(() => {});
      fake.hold();
      leaveFirst();
      jest.advanceTimersByTime(0);
      expect(fake.pending()).toBe(true);
      expect(sheetHistory.sheetBackOnto()).toBe(under);
      // a sheet opens over the entry the step leaves, and closes, before the step lands: it takes no step of its own
      const leaveSecond = hooks.enter(() => {});
      expect(fake.at()).toBe(start + 2);
      leaveSecond();
      jest.advanceTimersByTime(0);
      expect(sheetHistory.sheetBackOnto()).toBe(under);
      fake.release();
      await settled();
      expect(fake.at()).toBe(start);
      expect(landed).toEqual([true]);
      expect(sheetHistory.sheetBackOnto()).toBeNull();
      // a Back of the user's own is no landing of the step
      const leaveThird = hooks.enter(() => {});
      h.back(); await settled();
      leaveThird();
      expect(fake.at()).toBe(start);
      expect(landed).toEqual([true, false]);
    } finally {
      Reflect.deleteProperty(browser, "navigation");
    }
  });

  it("keeps Settings opened as the palette closes over a peek that stays up: the palette's entry is the peek's again, with no step left to land under Settings (#2000)", async () => {
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
    expect(fake.pending()).toBe(false);
    settings.recordSettings(settings.settingsLevels(true, null, false));
    await settled();
    fake.defer(false);
    expect(moves).toEqual([]);
    expect(settings.settingsEntry(h.state)).toEqual({ page: null, keyBar: false, depth: 1 });
    expect(peekClosed).toBe(0);
    settings.recordSettings([]);
    await settled();
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(peekClosed).toBe(0);
    leavePeek(); await settled();

    const leaveRoute = hooks.enter(() => {});
    settings.recordSettings(settings.settingsLevels(true, null, false));
    leaveRoute(); await settled();
    h.pushState({ ...settings.outsideSettings(h.state), "ovis:file-preview": { path: "README.md" } }, "");
    const leaveLightbox = hooks.enter(() => {});
    leaveLightbox(); await settled();
    expect((h.state as Record<string, unknown>)["ovis:file-preview"]).toBeDefined();
    expect(settings.settingsEntry(h.state)).toBeNull();
  });

  it("closes Settings when it closes while a sheet opened inside it is still stepping off its entry", async () => {
    const settingsPath = "./settingsHistory.ts?with-sheets";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    settings.recordSettings(settings.settingsLevels(true, "devices", false));
    await settled();
    const base = fake.at() - 2;
    const leaveConnect = hooks.enter(() => {});
    const reopened: boolean[] = [];
    const stopListening = settings.onSettingsHistory((entry, own) => { if (entry !== null && !own) reopened.push(true); });
    leaveConnect();
    settings.recordSettings([]);
    await settled();
    await settled();
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(fake.at()).toBe(base);
    expect(reopened).toEqual([]);
    stopListening();
  });

  it("keeps a sheet that opens as Settings closes, over the sheet that closed inside it: its entry is made where Settings lands", async () => {
    const settingsPath = "./settingsHistory.ts?with-sheets";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    settings.recordSettings(settings.settingsLevels(true, "devices", false));
    await settled();
    const base = fake.at() - 2;
    const leaveConnect = hooks.enter(() => {});
    const reopened: boolean[] = [];
    const stopListening = settings.onSettingsHistory((entry, own) => { if (entry !== null && !own) reopened.push(true); });
    // Add in Add a connection's SSH tab: the sheet closes, Add PC opens (a child's effect runs before
    // the app's, so it takes the closed sheet's entry first), and Settings closes by itself
    let closed = 0;
    leaveConnect();
    const leaveAddPc = hooks.enter(() => { closed += 1; });
    settings.recordSettings([]);
    await settled();
    await settled();
    expect(closed).toBe(0);
    expect(reopened).toEqual([]);
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(fake.at()).toBe(base + 1); expect(fake.marks()[base + 1]).toBe(true);
    expect(fake.entries.length).toBe(base + 2);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(base);
    expect(reopened).toEqual([]);
    leaveAddPc(); await settled();
    stopListening();
  });

  it("keeps a sheet that opens while Settings' own step back is on its way, and makes no entry before it lands", async () => {
    const settingsPath = "./settingsHistory.ts?with-sheets";
    const settings: typeof import("./settingsHistory.ts") = await import(settingsPath);
    settings.recordSettings(settings.settingsLevels(true, "devices", false));
    await settled();
    const base = fake.at() - 2;
    const reopened: boolean[] = [];
    const stopListening = settings.onSettingsHistory((entry, own) => { if (entry !== null && !own) reopened.push(true); });
    fake.defer(true);
    settings.recordSettings([]);
    expect(fake.pending()).toBe(true);
    let closed = 0;
    const leaveSheet = hooks.enter(() => { closed += 1; });
    expect(fake.entries.length).toBe(base + 3);
    await settled();
    fake.defer(false);
    expect(fake.pending()).toBe(false);
    expect(closed).toBe(0);
    expect(reopened).toEqual([]);
    expect(settings.settingsEntry(h.state)).toBeNull();
    expect(fake.at()).toBe(base + 1); expect(fake.marks()[base + 1]).toBe(true);
    expect(fake.entries.length).toBe(base + 2);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(base);
    leaveSheet(); await settled();
    stopListening();
  });

  it("stops waiting for a step the app asked for that never lands: a sheet that opened meanwhile gets its entry, and the next Back is the user's", async () => {
    const start = fake.at();
    expect(sheetStep.goingBack(h.state)).toBe(false);
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; });
    expect(fake.at()).toBe(start);
    jest.advanceTimersByTime(999);
    expect(fake.at()).toBe(start);
    jest.advanceTimersByTime(1);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("ends the wait at once when the step is said to be dropped", async () => {
    const start = fake.at();
    expect(sheetStep.goingBack(h.state)).toBe(false);
    sheetStep.dropped();
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
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
