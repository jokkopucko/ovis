import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { deviceBusy, deviceInUse, followsHerdrFocus, movingHerdrFocus, movingHerdrFocusOn, OWN_MOVE_HOLD_MS, unsentDraft, type PaneDrafts } from "./followFocus.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { writeTerminalDraft } from "./terminalDraft.ts";

const base = {
  enabled: true,
  machineId: "local",
  paneId: "w1:p2",
  selection: { machineId: "local", paneId: "w1:p1" },
  splitOthers: [],
  linkPending: false,
  busy: false,
  ownMove: false,
};

describe("following herdr's focus", () => {
  it("opens the pane herdr's focus moved to on the PC this device has open", () => {
    expect(followsHerdrFocus(base)).toBe(true);
    expect(followsHerdrFocus({ ...base, selection: { machineId: "local", paneId: null } })).toBe(true);
  });

  it("does nothing until this device turns it on", () => {
    expect(followsHerdrFocus({ ...base, enabled: false })).toBe(false);
  });

  it("leaves another PC's focus to that PC", () => {
    expect(followsHerdrFocus({ ...base, machineId: "remote" })).toBe(false);
  });

  it("leaves a pane already in front where it is", () => {
    expect(followsHerdrFocus({ ...base, paneId: "w1:p1" })).toBe(false);
    expect(followsHerdrFocus({ ...base, splitOthers: [{ machineId: "local", paneId: "w1:p2" }] })).toBe(false);
    expect(followsHerdrFocus({ ...base, splitOthers: [{ machineId: "remote", paneId: "w1:p2" }] })).toBe(true);
    expect(followsHerdrFocus({ ...base, splitOthers: [{ machineId: "remote", paneId: "w1:p2" }, { machineId: "local", paneId: "w1:p2" }] })).toBe(false);
  });

  it("lets a link that is still landing go first", () => {
    expect(followsHerdrFocus({ ...base, linkPending: true })).toBe(false);
  });

  it("keeps the pane of someone using this device (#1470)", () => {
    expect(followsHerdrFocus({ ...base, busy: true })).toBe(false);
  });

  it("leaves a move this device asked for to its own answer (#1470)", () => {
    expect(followsHerdrFocus({ ...base, ownMove: true })).toBe(false);
  });
});

describe("a focus move this device asked for", () => {
  const deferred = () => {
    let resolve!: (pane: string) => void, reject!: (cause: Error) => void;
    const promise = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
  };

  it("holds the PC's frames until its answer, which the caller sees after the hold ends", async () => {
    const split = deferred();
    const answered = movingHerdrFocus("local", split.promise).then((pane) => ({ pane, held: movingHerdrFocusOn("local") }));
    expect(movingHerdrFocusOn("local")).toBe(true);
    expect(movingHerdrFocusOn("office")).toBe(false);
    split.resolve("w1:p2");
    expect(await answered).toEqual({ pane: "w1:p2", held: false });
  });

  it("ends the hold when herdr refuses, and only once every move on that PC is answered", async () => {
    const first = deferred(), second = deferred();
    const refused = movingHerdrFocus("local", first.promise).catch(() => movingHerdrFocusOn("local"));
    const made = movingHerdrFocus("local", second.promise);
    first.reject(new Error("pane split failed"));
    expect(await refused).toBe(true);
    second.resolve("w1:p3");
    await made;
    expect(movingHerdrFocusOn("local")).toBe(false);
  });

  it("ends the hold of a request the PC never answers once its bound runs out, and only that one", async () => {
    jest.useFakeTimers();
    try {
      const stalled = deferred();
      const stalledHold = movingHerdrFocus("local", stalled.promise);
      jest.advanceTimersByTime(OWN_MOVE_HOLD_MS - 1);
      expect(movingHerdrFocusOn("local")).toBe(true);
      jest.advanceTimersByTime(1);
      expect(movingHerdrFocusOn("local")).toBe(false);
      const later = deferred();
      const answered = movingHerdrFocus("local", later.promise);
      stalled.resolve("w1:p5");
      await stalledHold;
      expect(movingHerdrFocusOn("local")).toBe(true);
      later.resolve("w1:p4");
      await answered;
      expect(movingHerdrFocusOn("local")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a device in use", () => {
  const field = (selector: string) => ({ matches: (query: string) => query.split(", ").some((part) => part.split(":")[0] === selector) });
  const page = (active: unknown, front: boolean, modal = false) => ({
    activeElement: active as Element | null, hasFocus: () => front,
    querySelector: (query: string) => (modal && query.includes("aria-modal") ? ({} as Element) : null),
  });
  const drafts = (text: string): PaneDrafts => ({ composer: () => text, line: () => "", held: () => "" });
  const here = { machineId: "local", paneId: "w1:p1" };

  it("is busy typing into a text field, or with a dialog open", () => {
    expect(deviceBusy(page(field("textarea"), true))).toBe(true);
    expect(deviceBusy(page(field("input"), true))).toBe(true);
    expect(deviceBusy(page(null, true, true))).toBe(true);
  });

  it("is not busy when the focus is on no field and no dialog is open", () => {
    expect(deviceBusy(page(field("button"), true))).toBe(false);
    expect(deviceBusy(page(null, true))).toBe(false);
  });

  it("is in use in a window in front that types, has a dialog open or holds an unsent message", () => {
    expect(deviceInUse(here, page(field("textarea"), true), drafts(""))).toBe(true);
    expect(deviceInUse(here, page(null, true, true), drafts(""))).toBe(true);
    expect(deviceInUse(here, page(null, true), drafts("half a sentence"))).toBe(true);
    expect(deviceInUse(here, page(null, true), drafts(""))).toBe(false);
  });

  it("is not in use in a window behind herdr's, whatever it has open or kept", () => {
    expect(deviceInUse(here, page(field("textarea"), false), drafts(""))).toBe(false);
    expect(deviceInUse(here, page(null, false, true), drafts(""))).toBe(false);
    expect(deviceInUse(here, page(null, false), drafts("half a sentence"))).toBe(false);
  });
});

describe("an unsent message on the pane this device has open", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let data: Map<string, string>;
  beforeEach(() => {
    for (const key of ["window", "localStorage"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    data = new Map();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
    data.set("ovis:pane-lifetime:local", "test-herdr");
    paneLifetimes.observe([{ id: "local", snapshot: { panes: [], herdr_lifetime: "test-herdr" } } as unknown as Machine], (item) => item.pane_id);
  });
  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });
  const pane = (paneId: string) => ({ machineId: "local", paneId });

  it("keeps a pane whose composer draft holds text", () => {
    data.set(`ovis:composer-draft:${paneStorageId("local", "w9:p1")}`, "half a sentence");
    expect(unsentDraft(pane("w9:p1"))).toBe(true);
  });

  it("keeps a pane whose terminal input line holds text, the phone's own draft", () => {
    writeTerminalDraft(paneStorageId("local", "w9:p2"), "git commit -m 'wip");
    expect(unsentDraft(pane("w9:p2"))).toBe(true);
  });

  it("keeps a pane whose terminal held what was typed while it was disconnected", () => {
    data.set(`ovis:terminal-draft:${paneStorageId("local", "w9:p3")}`, JSON.stringify({ text: "echo ", at: Date.now() }));
    expect(unsentDraft(pane("w9:p3"))).toBe(true);
  });

  it("does not hold a pane with blank or no drafts, or no pane", () => {
    data.set(`ovis:composer-draft:${paneStorageId("local", "w9:p4")}`, "  \n");
    expect(unsentDraft(pane("w9:p4"))).toBe(false);
    expect(unsentDraft(pane("w9:p5"))).toBe(false);
    expect(unsentDraft({ machineId: "local", paneId: null })).toBe(false);
  });
});
