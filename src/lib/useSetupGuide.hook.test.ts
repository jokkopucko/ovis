import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { GUIDE_STORAGE_KEY, REOPENED, WELCOME, type GuideState } from "./setupGuideFlow.ts";
import { useSetupGuide } from "./useSetupGuide.ts";

// The real hook over a fake browser: one tab's storage, and the storage events another tab's writes send.
describe("the setup guide closed in another tab", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let hook: ReturnType<typeof useSetupGuide>;

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function resumeAt(state: GuideState): Promise<void> {
    records.set(GUIDE_STORAGE_KEY, JSON.stringify({ status: "open", state }));
    function Probe() {
      hook = useSetupGuide({ enabled: true, workspaces: 0, pairingGate: "open", watching: false });
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  /** What another tab's write looks like here: the record already in storage, then its event. */
  async function otherTabWrites(value: string): Promise<void> {
    records.set(GUIDE_STORAGE_KEY, value);
    const event = new Event("storage");
    Object.defineProperties(event, { key: { value: GUIDE_STORAGE_KEY }, newValue: { value } });
    await act(async () => { events.dispatchEvent(event); });
  }

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
    await act(async () => { window.dispatchEvent(new Event("ovis:open-setup-guide")); });
    expect(hook.guide).not.toBeNull();
    expect(before()).toBe(false);
  });

  it("closes here when the other tab closes it", async () => {
    await resumeAt(REOPENED);
    expect(hook.guide?.step).toBe("setup");
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    expect(hook.guide).toBeNull();
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!)).toEqual({ status: "closed" });
  });

  it("does not reopen it with a step taken here before the close event arrived", async () => {
    await resumeAt(WELCOME);
    // the other tab's close lands in storage, its event not yet delivered here
    records.set(GUIDE_STORAGE_KEY, JSON.stringify({ status: "closed" }));
    await act(async () => { hook.dispatch({ type: "begin" }); });
    expect(hook.guide).toBeNull();
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!)).toEqual({ status: "closed" });
  });

  it("keeps a reopen made here when an older close event arrives after it", async () => {
    await resumeAt(WELCOME);
    const close = JSON.stringify({ status: "closed" });
    // the other tab's close is in storage, then Settings reopens it here before that close's event comes
    records.set(GUIDE_STORAGE_KEY, close);
    await act(async () => { window.dispatchEvent(new Event("ovis:open-setup-guide")); });
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!).status).toBe("open");
    const event = new Event("storage");
    Object.defineProperties(event, { key: { value: GUIDE_STORAGE_KEY }, newValue: { value: close } });
    await act(async () => { events.dispatchEvent(event); });
    expect(hook.guide?.step).toBe("setup");
  });

  it("closes here when the other tab closes right after this tab's own write", async () => {
    await resumeAt(WELCOME);
    const close = JSON.stringify({ status: "closed" });
    // the other tab's close lands in storage straight after this tab writes its next step
    const write = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (key: string, value: string) => { write(key, value); records.set(key, close); };
    await act(async () => { hook.dispatch({ type: "begin" }); });
    window.localStorage.setItem = write;
    const event = new Event("storage");
    Object.defineProperties(event, { key: { value: GUIDE_STORAGE_KEY }, newValue: { value: close } });
    await act(async () => { events.dispatchEvent(event); });
    expect(hook.guide).toBeNull();
  });

  it("opens again here when Settings asks, over a close made elsewhere", async () => {
    await resumeAt(REOPENED);
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    await act(async () => { window.dispatchEvent(new Event("ovis:open-setup-guide")); });
    expect(hook.guide?.step).toBe("setup");
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!).status).toBe("open");
  });
});

describe("the setup guide on a watching device", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let hook: ReturnType<typeof useSetupGuide>;

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  function Probe({ watching }: { watching: boolean }) {
    hook = useSetupGuide({ enabled: true, workspaces: 0, pairingGate: "open", watching });
    return null;
  }

  async function mount(watching: boolean, saved: GuideState | null): Promise<void> {
    if (saved !== null) records.set(GUIDE_STORAGE_KEY, JSON.stringify({ status: "open", state: saved }));
    await act(async () => { renderer = create(createElement(Probe, { watching })); });
  }

  it("does not resume a saved guide", async () => {
    await mount(true, REOPENED);
    expect(hook.guide).toBeNull();
  });

  it("does not open it again when Settings asks", async () => {
    await mount(true, null);
    await act(async () => { window.dispatchEvent(new Event("ovis:open-setup-guide")); });
    expect(hook.guide).toBeNull();
  });

  it("drops an open guide when the device turns into a watching one", async () => {
    await mount(false, REOPENED);
    expect(hook.guide?.step).toBe("setup");
    await act(async () => { renderer!.update(createElement(Probe, { watching: true })); });
    expect(hook.guide).toBeNull();
  });
});
