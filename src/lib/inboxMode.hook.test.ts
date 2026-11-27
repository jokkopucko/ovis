import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { NAV_KEY } from "./deepLink.ts";
import { SEEN_KEY } from "./historyKeys.ts";
import { useInboxMode, type InboxMode } from "./inboxMode.ts";

describe("useInboxMode", () => {
  let page: Page;
  let mode: InboxMode;
  let writes: string[];
  let entries: Array<{ state: object | null; url: URL }>;
  let index: number;
  let heardAfter: number;
  let loadWrites: string[];

  beforeEach(() => {
    page = openPage("http://localhost:7317/");
    entries = [];
    writes = [];
    heardAfter = 0;
    const write = (method: "pushState" | "replaceState") => (state: object | null, _unused: string, url?: string): void => {
      const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
      if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
      writes.push(`${method} ${index} ${entry.url.search}${entry.url.hash}`);
    };
    const { window: browser } = page;
    const location = browser.location;
    Object.defineProperty(browser, "location", { configurable: true, get: () => entries[index]?.url ?? location });
    Object.defineProperties(browser.history, {
      state: { configurable: true, get: () => entries[index]?.state ?? null },
      pushState: { configurable: true, value: write("pushState") },
      replaceState: { configurable: true, value: write("replaceState") },
      go: { configurable: true, value: (steps: number) => {
        index += steps;
        browser.dispatchEvent(new browser.PopStateEvent("popstate", { state: entries[index]!.state }));
      } },
    });
  });

  afterEach(async () => { await page.close(); });

  async function mount(addresses: string[], startsIn = false): Promise<void> {
    entries = addresses.map((address) => ({ state: null, url: new URL(`http://localhost:7317${address}`) }));
    index = entries.length - 1;
    function Probe() { mode = useInboxMode({ startsIn: () => startsIn }); return null; }
    await page.render(createElement(Probe));
    window.addEventListener("popstate", () => { heardAfter += 1; });
    loadWrites = writes;
    writes = [];
  }
  const back = (): Promise<void> => act(async () => { window.history.go(-1); });
  const forward = (): Promise<void> => act(async () => { window.history.go(1); });
  const searches = (): string[] => entries.map((entry) => entry.url.search);
  const emit = (type: string): void => { page.window.dispatchEvent(new page.window.Event(type)); };

  it("is off on the app's own address and on on the mode's, and at load only marks the entry the page loaded on, its address as it was", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);
    expect([mode.on, mode.at()]).toEqual([false, false]);
    expect(loadWrites).toEqual(["replaceState 0 ?ws=w1-api&pane=p1&view=chat"]);
    expect(entries[0]!.state).toEqual({ [SEEN_KEY]: true });
    await page.render(null);

    await mount(["/?app=inbox"]);
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(loadWrites).toEqual(["replaceState 0 ?app=inbox"]);
    expect(entries).toHaveLength(1);
    await page.render(null);

    entries = [{ state: { [NAV_KEY]: true }, url: new URL("http://localhost:7317/?app=inbox") }];
    index = 0;
    function Probe() { mode = useInboxMode({}); return null; }
    await page.render(createElement(Probe));
    expect(writes).toEqual([]);
    expect(entries[0]!.state).toEqual({ [NAV_KEY]: true });
  });

  it("marks an entry left without a state by the time the page is hidden or left, and writes on none that has one", async () => {
    const { window: browser } = page;
    const view = browser.document;
    const visibilityAdded = spyOn(view, "addEventListener");
    const visibilityRemoved = spyOn(view, "removeEventListener");
    const pagehideAdded = spyOn(browser, "addEventListener");
    const pagehideRemoved = spyOn(browser, "removeEventListener");
    const visibility = (state: string): void => {
      Object.defineProperty(view, "visibilityState", { configurable: true, value: state });
      view.dispatchEvent(new browser.Event("visibilitychange"));
    };
    await mount(["/?pane=p1"]);
    window.history.replaceState(null, "", "/?pane=p1");
    writes = [];

    visibility("visible");
    expect(writes).toEqual([]);
    visibility("hidden");
    expect(writes).toEqual(["replaceState 0 ?pane=p1"]);
    expect(entries[0]!.state).toEqual({ [SEEN_KEY]: true });

    visibility("hidden");
    emit("pagehide");
    await act(async () => { mode.enter(); });
    emit("pagehide");
    expect(writes).toEqual(["replaceState 0 ?pane=p1", "pushState 1 ?pane=p1&app=inbox"]);
    expect(entries[1]!.state).toEqual({ [NAV_KEY]: true });

    window.history.replaceState(null, "", "/?pane=p1&app=inbox");
    emit("pagehide");
    expect(entries[1]!.state).toEqual({ [SEEN_KEY]: true });

    await page.render(null);
    expect(visibilityAdded.mock.calls.filter(([type, listener]) => type === "visibilitychange" &&
      !visibilityRemoved.mock.calls.some(([removed, callback]) => removed === type && callback === listener))).toEqual([]);
    expect(pagehideAdded.mock.calls.filter(([type, listener]) => type === "pagehide" &&
      !pagehideRemoved.mock.calls.some(([removed, callback]) => removed === type && callback === listener))).toEqual([]);
  });

  it("enters by one entry that keeps the address's other parameters, and Back and Forward follow it", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { mode.enter(); });
    expect(mode.on).toBe(true);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat&app=inbox"]);
    expect(entries[1]!.state).toEqual({ [NAV_KEY]: true });

    await back();
    expect([mode.on, mode.at()]).toEqual([false, false]);
    await forward();
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(writes).toHaveLength(1);
    expect(heardAfter).toBe(2);
  });

  it("leaves by one entry, and Back returns to the mode", async () => {
    await mount(["/?app=inbox&ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { mode.leave(); });
    expect(mode.on).toBe(false);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat"]);

    await back();
    expect(mode.on).toBe(true);
    expect(searches()).toEqual(["?app=inbox&ws=w1-api&pane=p1&view=chat", "?ws=w1-api&pane=p1&view=chat"]);
  });

  it("pushes nothing when asked for the mode it is already in", async () => {
    await mount(["/?app=inbox"]);
    await act(async () => { mode.enter(); });
    expect(writes).toEqual([]);
    await page.render(null);

    await mount(["/?pane=p1"]);
    await act(async () => { mode.leave(); });
    expect(writes).toEqual([]);
  });

  it("says where the history is before React has drawn it", async () => {
    let seen: boolean[] = [];
    window.addEventListener("popstate", () => { seen = [mode.on, mode.at()]; });
    await mount(["/?pane=p1", "/?app=inbox"]);

    await back();

    expect(seen).toEqual([true, false]);
    expect(mode.on).toBe(false);
  });

  it("starts in the mode on a device that says so, its address taking the mark by a replace with nothing pushed", async () => {
    await mount(["/"], true);
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(loadWrites).toEqual(["replaceState 0 ?app=inbox"]);
    expect(entries).toEqual([{ state: { [SEEN_KEY]: true }, url: new URL("http://localhost:7317/?app=inbox") }]);
    await page.render(null);

    await mount(["/?pane=p1&view=chat"], true);
    expect(mode.on).toBe(true);
    expect(loadWrites).toEqual(["replaceState 0 ?pane=p1&view=chat&app=inbox"]);
    await page.render(null);

    await mount(["/?app=inbox"], true);
    expect(loadWrites).toEqual(["replaceState 0 ?app=inbox"]);
  });

  it("hands the shell one ref for its blocked drawer, set from the mode the page loads in", async () => {
    await mount(["/?app=inbox"]);
    const blocked = mode.drawerBlocked;
    expect(blocked.current).toBe(true);
    await act(async () => { mode.leave(); });
    expect(mode.drawerBlocked).toBe(blocked);
    await page.render(null);
    await mount(["/"]);
    expect(mode.drawerBlocked.current).toBe(false);
  });

  it("writes the mode into the hosted shell's fragment", async () => {
    const meta = page.window.document.createElement("meta");
    meta.name = "ovis-shell";
    meta.content = "relay";
    page.window.document.head.append(meta);
    const scope = `/s/${"ab".repeat(16)}/`;
    await mount([`${scope}#pane=p1`]);
    expect(mode.on).toBe(false);

    await act(async () => { mode.enter(); });

    expect(writes).toEqual(["pushState 1 #pane=p1&app=inbox"]);
    expect([mode.on, mode.at()]).toEqual([true, true]);
  });
});
