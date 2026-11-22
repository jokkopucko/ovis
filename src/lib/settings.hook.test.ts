import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { COMPOSER_ARTIFACTS_STORAGE_KEY, DEFAULT_SETTINGS, ENTER_SENDS_STORAGE_KEY, enterSendsOn, PHONE_TABS_STORAGE_KEY, SettingsProvider, useSettings, VOICE_ENGINE_STORAGE_KEY, type Settings } from "./settings.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("settings across tabs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let settings: Settings;
  let update: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => void;
  let writes: number;
  let full: boolean;
  let unreadable: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    records = new Map();
    events = new EventTarget();
    settings = DEFAULT_SETTINGS;
    writes = 0;
    full = false;
    unreadable = false;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => { if (unreadable) throw new Error("SecurityError"); return records.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (full) throw new Error("QuotaExceededError"); writes++; records.set(key, value); },
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
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

  async function open(strict = false): Promise<void> {
    function Probe() {
      ({ settings, update } = useSettings());
      return null;
    }
    const tree = createElement(SettingsProvider, null, createElement(Probe));
    await act(async () => { renderer = create(strict ? createElement(StrictMode, null, tree) : tree); });
  }

  async function storage(key: string | null): Promise<void> {
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      storageArea: { value: window.localStorage },
    });
    await act(async () => { events.dispatchEvent(event); });
  }

  it("updates a mounted consumer when another tab saves an override", async () => {
    await open();
    expect(settings.shortcutOverrides).toEqual({});
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" }, terminalFontSize: 22 }));

    await storage(SETTINGS_STORAGE_KEY);

    expect(settings.shortcutOverrides).toEqual({ palette: "ctrl+k" });
    expect(settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(writes).toBe(0);
  });

  it.each([SETTINGS_STORAGE_KEY, null])("restores defaults when storage is removed with key %j", async (key) => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));
    await open();
    records.clear();

    await storage(key);

    expect(settings.shortcutOverrides).toEqual({});
  });

  it("keeps another tab's change when this tab saves an unrelated setting", async () => {
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "en", chatWidth: "wide" }));
    records.set(COMPOSER_ARTIFACTS_STORAGE_KEY, "true");

    await act(async () => { update({ terminalFontSize: 20 }); });

    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.chatWidth, stored.language, stored.terminalFontSize]).toEqual(["wide", "en", 20]);
    expect(records.get(COMPOSER_ARTIFACTS_STORAGE_KEY)).toBe("true");
    expect(settings.terminalFontSize).toBe(20);
  });

  it("leaves another tab's change when this tab is handed a value it already holds", async () => {
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "ko" }));

    await act(async () => { update({ language: DEFAULT_SETTINGS.language, terminalFontSize: 20 }); });

    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.language, stored.terminalFontSize]).toEqual(["ko", 20]);
  });

  it("stores a change whose save failed with this tab's next save", async () => {
    await open();
    full = true;
    await act(async () => { update({ terminalFontSize: 20 }); });
    full = false;

    await act(async () => { update({ chatWidth: "wide" }); });

    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.terminalFontSize, stored.chatWidth]).toEqual([20, "wide"]);
  });

  it("reads what this tab holds for a change made from it, while storage refuses every write (#2977)", async () => {
    await open();
    full = true;
    await act(async () => { update({ lockedAgents: ["pc:w1:p1"] }); });

    await act(async () => {
      update((current) => ({ lockedAgents: current.lockedAgents.map((key) => key === "pc:w1:p1" ? "pc:w2:p1" : key) }));
      update((current) => ({ lockedAgents: [...current.lockedAgents, "pc:w1:p3"] }));
    });

    expect(settings.lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p3"]);
  });

  const move = (current: Settings): Partial<Settings> => ({ lockedAgents: current.lockedAgents.map((key) => key === "pc:w1:p1" ? "pc:w2:p1" : key) });

  it.each([false, true])("makes a change from what another tab saved since this one heard, keeping the rest of it (#2977), StrictMode %p", async (strict) => {
    await open(strict);
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ lockedAgents: ["pc:w1:p1", "pc:w1:p2"] }));

    await act(async () => { update(move); });

    expect(settings.lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
    expect((JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>).lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
  });

  it("keeps what this tab holds when storage stops reading after it loaded (#2977)", async () => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ lockedAgents: ["pc:w1:p1", "pc:w1:p2"] }));
    await open();
    unreadable = true;
    full = true;

    await act(async () => { update(move); });

    expect(settings.lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
  });

  it("keeps what this tab holds when the stored record is broken", async () => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ lockedAgents: ["pc:w1:p1", "pc:w1:p2"] }));
    await open();
    records.set(SETTINGS_STORAGE_KEY, "{broken");

    await act(async () => { update(move); });

    expect(settings.lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
  });

  it("keeps this tab's change that storage refused over storage's older copy", async () => {
    await open();
    await act(async () => { update({ lockedAgents: ["pc:w1:p1"] }); });
    full = true;
    await act(async () => { update({ lockedAgents: [] }); });

    await act(async () => { update(move); });

    expect(settings.lockedAgents).toEqual([]);
  });

  it("breaks the line on Return on a touch screen until this device chooses, and Enter still sends on a desk", async () => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: true, terminalFontSize: 20 }));

    await open();

    expect(settings.enterSends).toBeNull();
    expect([enterSendsOn(settings, true), enterSendsOn(settings, false)]).toEqual([false, true]);

    await act(async () => { update({ chatWidth: "wide" }); });
    expect(records.get(ENTER_SENDS_STORAGE_KEY)).toBe("null");
    expect((JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>).enterSends).toBe(true);
  });

  it("keeps this device's choice when an older tab rewrites the record it loaded before", async () => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: true }));
    const stale = records.get(SETTINGS_STORAGE_KEY)!;

    await open();
    await act(async () => { update({ enterSends: false }); });
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stale), terminalFontSize: 18 }));
    await act(async () => { renderer?.unmount(); });
    await open();

    expect(settings.enterSends).toBe(false);
    expect(settings.terminalFontSize).toBe(18);
  });

  it("keeps a choice made before: the old record's false, and this key's own true or false", async () => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: false }));
    await open();

    expect([enterSendsOn(settings, true), enterSendsOn(settings, false)]).toEqual([false, false]);

    await act(async () => { update({ enterSends: true }); });

    expect(records.get(ENTER_SENDS_STORAGE_KEY)).toBe("true");
    await act(async () => { renderer?.unmount(); });
    await open();
    expect(settings.enterSends).toBe(true);
    expect(enterSendsOn(settings, true)).toBe(true);
  });

  it("follows Return's choice made in another tab", async () => {
    await open();
    expect(settings.enterSends).toBeNull();

    records.set(ENTER_SENDS_STORAGE_KEY, "false");
    await storage(ENTER_SENDS_STORAGE_KEY);

    expect(settings.enterSends).toBe(false);
    expect(writes).toBe(0);
  });

  it("follows the speech recognition chosen in another tab", async () => {
    await open();
    expect(settings.voiceEngine).toBe("auto");

    records.set(VOICE_ENGINE_STORAGE_KEY, JSON.stringify("browser"));
    await storage(VOICE_ENGINE_STORAGE_KEY);

    expect(settings.voiceEngine).toBe("browser");
    expect(writes).toBe(0);
  });

  it("moves a phone's tabs where another tab placed them", async () => {
    await open();
    expect(settings.phoneTabs).toBe("row");

    records.set(PHONE_TABS_STORAGE_KEY, JSON.stringify("header"));
    await storage(PHONE_TABS_STORAGE_KEY);

    expect(settings.phoneTabs).toBe("header");
    expect(writes).toBe(0);
  });

  it("ignores storage events for unrelated keys", async () => {
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));

    await storage("ovis:unrelated");

    expect(settings.shortcutOverrides).toEqual({});
  });
});
