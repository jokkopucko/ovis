import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { COMPOSER_ARTIFACTS_STORAGE_KEY, DEFAULT_SETTINGS, ENTER_SENDS_STORAGE_KEY, enterSendsOn, SettingsProvider, useSettings, type Settings } from "./settings.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("settings across tabs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let settings: Settings;
  let update: (patch: Partial<Settings>) => void;
  let writes: number;
  let full: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    records = new Map();
    events = new EventTarget();
    settings = DEFAULT_SETTINGS;
    writes = 0;
    full = false;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
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

  async function open(): Promise<void> {
    function Probe() {
      ({ settings, update } = useSettings());
      return null;
    }
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Probe))); });
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
    // Given an already-open tab with the defaults.
    await open();
    expect(settings.shortcutOverrides).toEqual({});
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" }, terminalFontSize: 22 }));

    // When the browser announces another tab's settings write.
    await storage(SETTINGS_STORAGE_KEY);

    // Then the override is live without echoing the write or changing other settings.
    expect(settings.shortcutOverrides).toEqual({ palette: "ctrl+k" });
    expect(settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(writes).toBe(0);
  });

  it.each([SETTINGS_STORAGE_KEY, null])("restores defaults when storage is removed with key %j", async (key) => {
    // Given an open tab with a saved override.
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));
    await open();
    records.clear();

    // When another tab removes the settings record or clears storage.
    await storage(key);

    // Then the mounted consumer returns to the default shortcuts.
    expect(settings.shortcutOverrides).toEqual({});
  });

  it("keeps another tab's change when this tab saves an unrelated setting", async () => {
    // Given a tab opened before another tab chose a wide chat and the Artifacts chip.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "en", chatWidth: "wide" }));
    records.set(COMPOSER_ARTIFACTS_STORAGE_KEY, "true");

    // When this tab changes its terminal font size.
    await act(async () => { update({ terminalFontSize: 20 }); });

    // Then the stored settings hold both tabs' changes.
    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.chatWidth, stored.language, stored.terminalFontSize]).toEqual(["wide", "en", 20]);
    expect(records.get(COMPOSER_ARTIFACTS_STORAGE_KEY)).toBe("true");
    expect(settings.terminalFontSize).toBe(20);
  });

  it("leaves another tab's change when this tab is handed a value it already holds", async () => {
    // Given an open tab, and another tab that chose Korean since.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "ko" }));

    // When this tab is handed the language it already shows, and another setting.
    await act(async () => { update({ language: DEFAULT_SETTINGS.language, terminalFontSize: 20 }); });

    // Then the other tab's language stays stored.
    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.language, stored.terminalFontSize]).toEqual(["ko", 20]);
  });

  it("stores a change whose save failed with this tab's next save", async () => {
    // Given a tab whose font size change found storage full.
    await open();
    full = true;
    await act(async () => { update({ terminalFontSize: 20 }); });
    full = false;

    // When it saves another setting once storage has room.
    await act(async () => { update({ chatWidth: "wide" }); });

    // Then both changes are stored.
    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.terminalFontSize, stored.chatWidth]).toEqual([20, "wide"]);
  });

  it("breaks the line on Return on a touch screen until this device chooses, and Enter still sends on a desk", async () => {
    // Given a record an older version saved whole after an unrelated change: its enterSends: true was never chosen.
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: true, terminalFontSize: 20 }));

    // When the tab opens.
    await open();

    // Then nothing is chosen: a touch screen's Return breaks the line, a desk's Enter sends.
    expect(settings.enterSends).toBeNull();
    expect([enterSendsOn(settings, true), enterSendsOn(settings, false)]).toEqual([false, true]);

    // And an unrelated save stores no choice for it, and leaves the record the boolean an older tab reads.
    await act(async () => { update({ chatWidth: "wide" }); });
    expect(records.get(ENTER_SENDS_STORAGE_KEY)).toBe("null");
    expect((JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>).enterSends).toBe(true);
  });

  it("keeps this device's choice when an older tab rewrites the record it loaded before", async () => {
    // Given an older tab that loaded the unchosen record (enterSends: true).
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: true }));
    const stale = records.get(SETTINGS_STORAGE_KEY)!;

    // When this version chooses Return breaks the line, and the older tab then saves an unrelated setting whole.
    await open();
    await act(async () => { update({ enterSends: false }); });
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stale), terminalFontSize: 18 }));
    await act(async () => { renderer?.unmount(); });
    await open();

    // Then the choice holds after the reload.
    expect(settings.enterSends).toBe(false);
    expect(settings.terminalFontSize).toBe(18);
  });

  it("keeps a choice made before: the old record's false, and this key's own true or false", async () => {
    // Given Return set to break the line under the old version, which could only be chosen.
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: false }));
    await open();

    // Then it holds on a touch screen and a desk alike.
    expect([enterSendsOn(settings, true), enterSendsOn(settings, false)]).toEqual([false, false]);

    // When this device turns Enter sends back on.
    await act(async () => { update({ enterSends: true }); });

    // Then the choice is stored in its own key and survives the next load, a touch screen's included.
    expect(records.get(ENTER_SENDS_STORAGE_KEY)).toBe("true");
    await act(async () => { renderer?.unmount(); });
    await open();
    expect(settings.enterSends).toBe(true);
    expect(enterSendsOn(settings, true)).toBe(true);
  });

  it("follows Return's choice made in another tab", async () => {
    // Given an open tab with nothing chosen.
    await open();
    expect(settings.enterSends).toBeNull();

    // When another tab chooses Return breaks the line.
    records.set(ENTER_SENDS_STORAGE_KEY, "false");
    await storage(ENTER_SENDS_STORAGE_KEY);

    // Then this tab's composer follows it without writing anything.
    expect(settings.enterSends).toBe(false);
    expect(writes).toBe(0);
  });

  it("ignores storage events for unrelated keys", async () => {
    // Given an open tab and a settings record not announced by this event.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));

    // When an unrelated record changes.
    await storage("ovis:unrelated");

    // Then the shortcut state stays as it was.
    expect(settings.shortcutOverrides).toEqual({});
  });
});
