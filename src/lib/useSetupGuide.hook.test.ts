import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { GUIDE_STORAGE_KEY, FIRST_RUN, REOPENED, type GuideState } from "./setupGuideFlow.ts";
import { SETUP_ROW_KEY, USAGE_ARMED_KEY } from "./firstHints.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";
import { useOtherDevice, useSetupGuide, type SetupGuideFacts } from "./useSetupGuide.ts";

describe("the setup guide closed in another tab", () => {
  let page: Page;
  let hook: ReturnType<typeof useSetupGuide>;

  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  async function resumeAt(state: GuideState): Promise<void> {
    page.window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ status: "open", state }));
    function Probe() {
      hook = useSetupGuide({ enabled: true, workspaces: 0, pairingGate: "open", watching: false });
      return null;
    }
    await page.render(createElement(Probe));
  }

  async function otherTabWrites(value: string): Promise<void> {
    page.window.localStorage.setItem(GUIDE_STORAGE_KEY, value);
    const event = new page.window.StorageEvent("storage", { key: GUIDE_STORAGE_KEY, newValue: value });
    await act(async () => { page.window.dispatchEvent(event); });
  }

  it("turns Setup: N left on when the guide closes, so Set up later leaves a way back", async () => {
    await resumeAt(REOPENED);
    await act(async () => { hook.close(); });
    expect(page.window.localStorage.getItem(SETUP_ROW_KEY)).toBe("on");
    page.window.localStorage.clear();
    await page.render(null);
    await resumeAt(FIRST_RUN);
    await act(async () => { hook.close(); });
    expect(page.window.localStorage.getItem(SETUP_ROW_KEY)).toBe("on");
  });

  it("keeps a remembered Continue as spent once plan usage is on, and forgets it when usage goes off", async () => {
    page.window.localStorage.setItem(USAGE_ARMED_KEY, "1");
    let showUsage = false;
    function Usage() { hook = useSetupGuide({ enabled: true, workspaces: 0, pairingGate: "open", watching: false, showUsage }); return null; }
    await page.render(createElement(Usage));
    expect(page.window.localStorage.getItem(USAGE_ARMED_KEY)).toBe("1");
    showUsage = true;
    await page.render(createElement(Usage));
    expect(page.window.localStorage.getItem(USAGE_ARMED_KEY)).toBe("on");
    showUsage = false;
    await page.render(createElement(Usage));
    expect(page.window.localStorage.getItem(USAGE_ARMED_KEY)).toBeNull();
  });

  it("is settled once another tab closes the guide, though this one never decided", async () => {
    function Fresh() { hook = useSetupGuide({ enabled: true, workspaces: null, pairingGate: undefined, watching: false }); return null; }
    await page.render(createElement(Fresh));
    expect(hook.settled).toBe(false);
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    expect(hook.settled).toBe(true);
  });

  it("opens the first workspace's pane only when the user stayed on the guide", async () => {
    await resumeAt(REOPENED);
    const opened: string[] = [];
    await act(async () => { hook.finish(() => opened.push("w1:p1")); });
    expect(opened).toEqual(["w1:p1"]);
    expect(hook.guide).toBeNull();
  });

  it("a Start that ends after the user went to another pane closes the guide but keeps their pane", async () => {
    await resumeAt(REOPENED);
    await act(async () => { hook.stepAside(); });
    const opened: string[] = [];
    await act(async () => { hook.finish(() => opened.push("w1:p1")); });
    expect(opened).toEqual([]);
    expect(hook.guide).toBeNull();
  });

  it("keeps the user's pane when their pick and Start's answer land in the same update", async () => {
    await resumeAt(REOPENED);
    const opened: string[] = [];
    await act(async () => { hook.stepAside(); hook.finish(() => opened.push("w1:p1")); });
    expect(opened).toEqual([]);
    expect(hook.guide).toBeNull();
  });

  it("lets only the latest tab the guide opens be selected, and none once Start was pressed or it closed", async () => {
    await resumeAt(REOPENED);
    const first = hook.ticket();
    const second = hook.ticket();
    expect([first(), second()]).toEqual([false, true]);
    hook.voidTickets();
    expect(second()).toBe(false);
    const third = hook.ticket();
    expect(third()).toBe(true);
    await act(async () => { hook.close(); });
    expect(third()).toBe(false);
  });

  it("a tab asked for before the guide closed is not shown after it opens again", async () => {
    await resumeAt(REOPENED);
    const before = hook.ticket();
    await act(async () => { hook.close(); });
    await act(async () => { page.window.dispatchEvent(new page.window.Event("ovis:open-setup-guide")); });
    expect(hook.guide).not.toBeNull();
    expect(before()).toBe(false);
  });

  it("closes here when the other tab closes it", async () => {
    await resumeAt(REOPENED);
    expect(hook.guide?.step).toBe("setup");
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    expect(hook.guide).toBeNull();
    expect(JSON.parse(page.window.localStorage.getItem(GUIDE_STORAGE_KEY)!)).toEqual({ status: "closed" });
  });

  it("does not reopen it with a step taken here before the close event arrived", async () => {
    await resumeAt({ ...REOPENED, at: "theme" });
    page.window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ status: "closed" }));
    await act(async () => { hook.dispatch({ type: "moved" }); });
    expect(hook.guide).toBeNull();
    expect(JSON.parse(page.window.localStorage.getItem(GUIDE_STORAGE_KEY)!)).toEqual({ status: "closed" });
  });

  it("keeps a reopen made here when an older close event arrives after it", async () => {
    await resumeAt({ ...REOPENED, at: "theme" });
    const close = JSON.stringify({ status: "closed" });
    page.window.localStorage.setItem(GUIDE_STORAGE_KEY, close);
    await act(async () => { page.window.dispatchEvent(new page.window.Event("ovis:open-setup-guide")); });
    expect(JSON.parse(page.window.localStorage.getItem(GUIDE_STORAGE_KEY)!).status).toBe("open");
    const event = new page.window.StorageEvent("storage", { key: GUIDE_STORAGE_KEY, newValue: close });
    await act(async () => { page.window.dispatchEvent(event); });
    expect(hook.guide?.step).toBe("setup");
  });

  it("closes here when the other tab closes right after this tab's own write", async () => {
    await resumeAt({ ...REOPENED, at: "theme" });
    const close = JSON.stringify({ status: "closed" });
    const storage = page.window.localStorage;
    const write = storage.setItem;
    Object.defineProperty(storage, "setItem", { configurable: true, value: (key: string, value: string) => { write(key, value); write(key, close); } });
    await act(async () => { hook.dispatch({ type: "moved" }); });
    Object.defineProperty(storage, "setItem", { configurable: true, value: write });
    const event = new page.window.StorageEvent("storage", { key: GUIDE_STORAGE_KEY, newValue: close });
    await act(async () => { page.window.dispatchEvent(event); });
    expect(hook.guide).toBeNull();
  });

  it("opens again here when Settings asks, over a close made elsewhere", async () => {
    await resumeAt(REOPENED);
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    await act(async () => { page.window.dispatchEvent(new page.window.Event("ovis:open-setup-guide")); });
    expect(hook.guide?.step).toBe("setup");
    expect(JSON.parse(page.window.localStorage.getItem(GUIDE_STORAGE_KEY)!).status).toBe("open");
  });
});

describe("the setup guide on a watching device", () => {
  let page: Page;
  let hook: ReturnType<typeof useSetupGuide>;

  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  function Probe({ watching }: { watching: boolean }) {
    hook = useSetupGuide({ enabled: true, workspaces: 0, pairingGate: "open", watching });
    return null;
  }

  async function mount(watching: boolean, saved: GuideState | null): Promise<void> {
    if (saved !== null) page.window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ status: "open", state: saved }));
    await page.render(createElement(Probe, { watching }));
  }

  it("does not resume a saved guide", async () => {
    await mount(true, REOPENED);
    expect(hook.guide).toBeNull();
  });

  it("does not open it again when Settings asks", async () => {
    await mount(true, null);
    await act(async () => { page.window.dispatchEvent(new page.window.Event("ovis:open-setup-guide")); });
    expect(hook.guide).toBeNull();
  });

  it("drops an open guide when the device turns into a watching one", async () => {
    await mount(false, REOPENED);
    expect(hook.guide?.step).toBe("setup");
    await page.render(createElement(Probe, { watching: true }));
    expect(hook.guide).toBeNull();
  });

  async function mountFacts(facts: SetupGuideFacts): Promise<(next: SetupGuideFacts) => Promise<void>> {
    let current = facts;
    function Probe() { hook = useSetupGuide(current); return null; }
    await page.render(createElement(Probe));
    return async (next) => { current = next; await page.render(createElement(Probe)); };
  }

  it("is settled at once where the guide cannot open by itself: a record of it, saved settings, a watching device", async () => {
    page.window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ status: "closed" }));
    await mountFacts({ enabled: true, workspaces: null, pairingGate: undefined, watching: false });
    expect(hook.settled).toBe(true);
    await page.render(null);
    page.window.localStorage.clear();
    page.window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{}");
    await mountFacts({ enabled: true, workspaces: null, pairingGate: undefined, watching: false });
    expect(hook.settled).toBe(true);
    await page.render(null);
    page.window.localStorage.clear();
    await mountFacts({ enabled: true, workspaces: null, pairingGate: undefined, watching: true });
    expect(hook.settled).toBe(true);
  });

  it("is not settled on a fresh browser until the first-run decision is made", async () => {
    const update = await mountFacts({ enabled: true, workspaces: null, pairingGate: undefined, watching: false });
    expect(hook.settled).toBe(false);
    await update({ enabled: true, workspaces: 0, pairingGate: "open", watching: false });
    await act(async () => { await Promise.resolve(); });
    expect(hook.settled).toBe(true);
  });
});

describe("useOtherDevice", () => {
  const fetchBefore = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let reads = 0;
  let page: Page;
  let name: string | null = null;
  beforeEach(() => {
    reads = 0;
    page = openPage();
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/devices")) reads += 1;
      return new Response(JSON.stringify({ devices: [{ id: "phone", label: "Pixel 9", role: "drive", created_at: "2026-11-15T00:00:00Z", last_seen_at: null, current: false }] }), { headers: { "content-type": "application/json" } });
    } });
  });
  afterEach(async () => {
    await page.close();
    if (fetchBefore) Object.defineProperty(globalThis, "fetch", fetchBefore); else delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("with pending, is undefined until the list answers, and null after a failed read", async () => {
    let seen: (string | null | undefined)[] = [];
    function Probe() { seen.push(useOtherDevice(true, "x", true)); return null; }
    await page.render(createElement(Probe));
    expect(seen[0]).toBeUndefined();
    expect(seen.at(-1)).toBe("Pixel 9");
    await page.render(null);
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async () => { throw new TypeError("Failed to fetch"); } });
    seen = [];
    await page.render(createElement(Probe));
    expect(seen[0]).toBeUndefined();
    expect(seen.at(-1)).toBeNull();
  });

  it("reads the devices again when the step changes, and when it is enabled again", async () => {
    function Probe({ enabled, again }: { enabled: boolean; again: string }) { name = useOtherDevice(enabled, again); return null; }
    await page.render(createElement(Probe, { enabled: true, again: "phone" }));
    expect(reads).toBe(1);
    expect(name).toBe("Pixel 9");
    await page.render(createElement(Probe, { enabled: true, again: "done" }));
    expect(reads).toBe(2);
    await page.render(createElement(Probe, { enabled: false, again: "done" }));
    expect(reads).toBe(2);
    await page.render(createElement(Probe, { enabled: true, again: "done" }));
    expect(reads).toBe(3);
  });
});
