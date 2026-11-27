import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { COMPOSER_ARTIFACTS_STORAGE_KEY, DEFAULT_SETTINGS, ENTER_SENDS_STORAGE_KEY, enterSendsOn, PHONE_TABS_STORAGE_KEY, SettingsProvider, useSettings, VOICE_ENGINE_STORAGE_KEY, type Settings } from "./settings.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("settings across tabs", () => {
  let page: Page;
  let readRecord: Storage["getItem"];
  let writeRecord: Storage["setItem"];
  let settings: Settings;
  let update: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => void;
  let writes: number;
  let full: boolean;
  let unreadable: boolean;

  beforeEach(() => {
    page = openPage();
    settings = DEFAULT_SETTINGS;
    writes = 0;
    full = false;
    unreadable = false;
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en-US"] });
    page.window.document.documentElement.style.setProperty("--bg", "#12100e");
    const { getItem, setItem } = page.window.localStorage;
    // Fixture writes still use the real storage even while the app's access throws.
    readRecord = getItem;
    writeRecord = setItem;
    Object.defineProperties(page.window.localStorage, {
      getItem: { configurable: true, value: (key: string) => { if (unreadable) throw new Error("SecurityError"); return getItem(key); } },
      setItem: { configurable: true, value: (key: string, value: string) => { if (full) throw new Error("QuotaExceededError"); writes++; setItem(key, value); } },
    });
  });

  afterEach(async () => { await page.close(); });

  async function open(strict = false): Promise<void> {
    function Probe() {
      ({ settings, update } = useSettings());
      return null;
    }
    const tree = createElement(SettingsProvider, null, createElement(Probe));
    await page.render(strict ? createElement(StrictMode, null, tree) : tree);
  }

  async function storage(key: string | null): Promise<void> {
    const event = new page.window.StorageEvent("storage", { key: key ?? undefined, storageArea: page.window.localStorage });
    await act(async () => { page.window.dispatchEvent(event); });
  }

  it("updates a mounted consumer when another tab saves an override", async () => {
    await open();
    expect(settings.shortcutOverrides).toEqual({});
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" }, terminalFontSize: 22 }));

    await storage(SETTINGS_STORAGE_KEY);

    expect(settings.shortcutOverrides).toEqual({ palette: "ctrl+k" });
    expect(settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(writes).toBe(0);
  });

  it.each([SETTINGS_STORAGE_KEY, null])("restores defaults when storage is removed with key %j", async (key) => {
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));
    await open();
    page.window.localStorage.clear();

    await storage(key);

    expect(settings.shortcutOverrides).toEqual({});
  });

  it("keeps another tab's change when this tab saves an unrelated setting", async () => {
    await open();
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "en", chatWidth: "wide" }));
    writeRecord(COMPOSER_ARTIFACTS_STORAGE_KEY, "true");

    await act(async () => { update({ terminalFontSize: 20 }); });

    const stored = JSON.parse(readRecord(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.chatWidth, stored.language, stored.terminalFontSize]).toEqual(["wide", "en", 20]);
    expect(readRecord(COMPOSER_ARTIFACTS_STORAGE_KEY)).toBe("true");
    expect(settings.terminalFontSize).toBe(20);
  });

  it("leaves another tab's change when this tab is handed a value it already holds", async () => {
    await open();
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "ko" }));

    await act(async () => { update({ language: DEFAULT_SETTINGS.language, terminalFontSize: 20 }); });

    const stored = JSON.parse(readRecord(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.language, stored.terminalFontSize]).toEqual(["ko", 20]);
  });

  it("stores a change whose save failed with this tab's next save", async () => {
    await open();
    full = true;
    await act(async () => { update({ terminalFontSize: 20 }); });
    full = false;

    await act(async () => { update({ chatWidth: "wide" }); });

    const stored = JSON.parse(readRecord(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
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
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ lockedAgents: ["pc:w1:p1", "pc:w1:p2"] }));

    await act(async () => { update(move); });

    expect(settings.lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
    expect((JSON.parse(readRecord(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>).lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
  });

  it("keeps what this tab holds when storage stops reading after it loaded (#2977)", async () => {
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ lockedAgents: ["pc:w1:p1", "pc:w1:p2"] }));
    await open();
    unreadable = true;
    full = true;

    await act(async () => { update(move); });

    expect(settings.lockedAgents).toEqual(["pc:w2:p1", "pc:w1:p2"]);
  });

  it("keeps what this tab holds when the stored record is broken", async () => {
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ lockedAgents: ["pc:w1:p1", "pc:w1:p2"] }));
    await open();
    writeRecord(SETTINGS_STORAGE_KEY, "{broken");

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
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: true, terminalFontSize: 20 }));

    await open();

    expect(settings.enterSends).toBeNull();
    expect([enterSendsOn(settings, true), enterSendsOn(settings, false)]).toEqual([false, true]);

    await act(async () => { update({ chatWidth: "wide" }); });
    expect(readRecord(ENTER_SENDS_STORAGE_KEY)).toBe("null");
    expect((JSON.parse(readRecord(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>).enterSends).toBe(true);
  });

  it("keeps this device's choice when an older tab rewrites the record it loaded before", async () => {
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: true }));
    const stale = readRecord(SETTINGS_STORAGE_KEY)!;

    await open();
    await act(async () => { update({ enterSends: false }); });
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stale), terminalFontSize: 18 }));
    await page.render(null);
    await open();

    expect(settings.enterSends).toBe(false);
    expect(settings.terminalFontSize).toBe(18);
  });

  it("keeps a choice made before: the old record's false, and this key's own true or false", async () => {
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ enterSends: false }));
    await open();

    expect([enterSendsOn(settings, true), enterSendsOn(settings, false)]).toEqual([false, false]);

    await act(async () => { update({ enterSends: true }); });

    expect(readRecord(ENTER_SENDS_STORAGE_KEY)).toBe("true");
    await page.render(null);
    await open();
    expect(settings.enterSends).toBe(true);
    expect(enterSendsOn(settings, true)).toBe(true);
  });

  it("follows Return's choice made in another tab", async () => {
    await open();
    expect(settings.enterSends).toBeNull();

    writeRecord(ENTER_SENDS_STORAGE_KEY, "false");
    await storage(ENTER_SENDS_STORAGE_KEY);

    expect(settings.enterSends).toBe(false);
    expect(writes).toBe(0);
  });

  it("follows the speech recognition chosen in another tab", async () => {
    await open();
    expect(settings.voiceEngine).toBe("auto");

    writeRecord(VOICE_ENGINE_STORAGE_KEY, JSON.stringify("browser"));
    await storage(VOICE_ENGINE_STORAGE_KEY);

    expect(settings.voiceEngine).toBe("browser");
    expect(writes).toBe(0);
  });

  it("moves a phone's tabs where another tab placed them", async () => {
    await open();
    expect(settings.phoneTabs).toBe("row");

    writeRecord(PHONE_TABS_STORAGE_KEY, JSON.stringify("header"));
    await storage(PHONE_TABS_STORAGE_KEY);

    expect(settings.phoneTabs).toBe("header");
    expect(writes).toBe(0);
  });

  it("ignores storage events for unrelated keys", async () => {
    await open();
    writeRecord(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));

    await storage("ovis:unrelated");

    expect(settings.shortcutOverrides).toEqual({});
  });
});
