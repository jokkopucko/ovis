import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseThemeBlocks, parseThemeValue, resolveEntry, ThemeValueError } from "./themeCss.ts";
import { LIGHT_ANSI_ROLES } from "./themeRoles.ts";
import baseline from "./themes.legacy-baseline.json";
import { DEFAULT_THEME, ROLES, SHADOW_GEOMETRY, SUPPORTED_ENTRIES, THEME_IDS, themeColor as tableThemeColor } from "./themes.ts";
import { DEFAULT_ID } from "../../scripts/generate-themes.ts";
import { FONT_FAMILY_MAX_CHARS } from "./fontFamily.ts";
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems } from "./keyBar.ts";
import { SHARED_SETTING_KEYS } from "../../shared/preferences.ts";
import { NOTICE_VERSION, TELEMETRY_SETTINGS_KEYS, TELEMETRY_THEME_SIDE_KEYS, telemetrySettings } from "../../shared/telemetry.ts";
import { SETTING_SCOPE, telemetrySettingsSnapshot, alertPrefs, CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_LANE_MAX_REM, CHAT_LANE_MIN, CHAT_WIDTHS, chatFontSize, chatLaneLength, chatLaneWidth, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, quickReplyButtons, sanitizeSettings, terminalTheme, forgetPaneViews, DICTATION_LANGUAGES, VOICE_BUTTONS, VOICE_ENGINES, wantsVoiceInput } from "./settings.ts";
import { applyToDocument, loadSettings, pcLoadOn, saveBootRows, saveSettings } from "./settings.ts";
import { customRow, NO_CUSTOM_THEMES, readThemeFile, withTheme } from "./customThemes.ts";
import { CUSTOM_ROWS_STORAGE_KEY, CUSTOM_THEMES_STORAGE_KEY } from "./themeBoot.ts";
import { sanitizeSettings as oldSanitizeSettings, saveSettings as oldSaveSettings } from "./settings.legacy-fixture.ts";
import { themeFor } from "./themeFor.ts";
import { readStoredAppearance, storedAppearance } from "./themeBoot.ts";

describe("saved theme migration", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let records: Map<string, string>;
  beforeEach(() => {
    records = new Map();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    } } });
  });
  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const main = "ovis:settings";
  const protectedThemes = "ovis:themes";
  const putOld = (record: object) => records.set(main, JSON.stringify(record));
  const readOld = () => oldSanitizeSettings(JSON.parse(records.get(main) ?? "{}"));

  it.each([
    [{ theme: "dark", palette: "catppuccin" }, "catppuccin", "catppuccin"],
    [{ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, "charcoal", "catppuccin"],
    [{ theme: "dark", palette: "catppuccin", paletteDark: "charcoal" }, "catppuccin", "catppuccin"],
    [{ theme: "dark", palette: "amber", paletteDark: "charcoal" }, "amber", "amber"],
  ] as const)("loads the pinned legacy appearance %j (a, b, c, F3)", (raw, dark, light) => {
    putOld(raw);
    const settings = loadSettings();
    expect(themeFor(settings, "dark").id).toBe(dark);
    expect(themeFor(settings, "light").id).toBe(light);
  });

  it("keeps every legacy look readable by the pinned old sanitizer (e)", () => {
    for (const palette of ["amber", "charcoal", "catppuccin"] as const) {
      for (const theme of ["dark", "light", "system"] as const) {
        const settings = sanitizeSettings({ theme, darkTheme: palette, lightTheme: palette });
        saveSettings(settings);
        const old = readOld();
        expect(old.palette).toBe(palette);
        expect(old.paletteDark).toBe(palette);
        expect(old.paletteLight).toBe(palette);
        expect(old).not.toHaveProperty("darkTheme");
      }
    }
    saveSettings(sanitizeSettings({ darkTheme: "tokyo-night" }));
    expect(readOld().palette).toBe("amber");
  });

  it("survives an old sanitizer and whole-record unrelated save (f)", () => {
    saveSettings(sanitizeSettings({ darkTheme: "tokyo-night" }));
    const old = readOld();
    oldSaveSettings({ ...old, terminalFontSize: 18 });
    expect(loadSettings().darkTheme).toBe("tokyo-night");
    expect(loadSettings().terminalFontSize).toBe(18);
  });

  it("keeps Return's default unchosen, and a choice, through an old tab's whole-record save", () => {
    // unchosen: the old tab reads the boolean it knows and writes it back, which is still no choice
    saveSettings(sanitizeSettings({}));
    expect(oldSanitizeSettings(readOld()).enterSends).toBe(true);
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().enterSends).toBeNull();
    expect(loadSettings().terminalFontSize).toBe(18);
    // chosen either way: the old tab's unrelated save keeps it
    for (const enterSends of [true, false]) {
      saveSettings({ ...loadSettings(), enterSends });
      oldSaveSettings({ ...readOld(), terminalFontSize: 20 });
      expect(loadSettings().enterSends).toBe(enterSends);
    }
  });

  it("keeps the interface font in its own key, out of an old tab's whole-record save", () => {
    saveSettings(sanitizeSettings({ uiFontFamily: "system-ui" }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("uiFontFamily");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().uiFontFamily).toBe("system-ui");
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings(sanitizeSettings({ uiFontFamily: "" }));
    expect(loadSettings().uiFontFamily).toBe("");
  });

  it("keeps Wrap to screen / Original width in its own key, out of an old tab's whole-record save", () => {
    saveSettings(sanitizeSettings({ terminalMirrorWrap: false }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("terminalMirrorWrap");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().terminalMirrorWrap).toBe(false);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), terminalMirrorWrap: true });
    expect(loadSettings().terminalMirrorWrap).toBe(true);
    saveSettings({ ...loadSettings(), terminalMirrorWrap: null });
    expect(loadSettings().terminalMirrorWrap).toBeNull();
    expect(sanitizeSettings({ terminalMirrorWrap: "yes" }).terminalMirrorWrap).toBeNull();
  });

  it("leaves the sidebar filter out until it is turned on, kept in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().sidebarFilter).toBe(false);
    saveSettings(sanitizeSettings({ sidebarFilter: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("sidebarFilter");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().sidebarFilter).toBe(true);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), sidebarFilter: false });
    expect(loadSettings().sidebarFilter).toBe(false);
    expect(sanitizeSettings({ sidebarFilter: "on" }).sidebarFilter).toBe(false);
    records.set("ovis:sidebar-filter-shown", "not json");
    expect(loadSettings().sidebarFilter).toBe(false);
    // the earlier key held the old default (on) on every device that saved any setting: it is not read
    records.delete("ovis:sidebar-filter-shown");
    records.set("ovis:sidebar-filter", "true");
    expect(loadSettings().sidebarFilter).toBe(false);
  });

  it("keeps the PC load choice in its own key, out of an old tab's whole-record save, and unchosen until chosen", () => {
    expect(loadSettings().pcLoad).toBeNull();
    saveSettings(sanitizeSettings({ pcLoad: false }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("pcLoad");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().pcLoad).toBe(false);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), pcLoad: null });
    expect(loadSettings().pcLoad).toBeNull();
    records.set("ovis:pc-load", "not json");
    expect(loadSettings().pcLoad).toBeNull();
  });

  it("keeps the agent groups off until chosen, in keys of their own, out of an old tab's whole-record save", () => {
    expect(loadSettings()).toMatchObject({ agentGroups: false, agentGroupSort: "wait" });
    saveSettings(sanitizeSettings({ agentGroups: true, agentGroupSort: "name" }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("agentGroups");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings()).toMatchObject({ agentGroups: true, agentGroupSort: "name", terminalFontSize: 18 });
    expect(SETTING_SCOPE.agentGroups).toBe("device");
    expect(sanitizeSettings({ agentGroups: "on", agentGroupSort: "oldest" })).toMatchObject({ agentGroups: false, agentGroupSort: "wait" });
  });

  it("keeps the speech recognition in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().voiceEngine).toBe("auto");
    saveSettings(sanitizeSettings({ voiceEngine: "browser" }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("voiceEngine");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().voiceEngine).toBe("browser");
    expect(loadSettings().terminalFontSize).toBe(18);
    records.set("ovis:voice-engine", "not json");
    expect(loadSettings().voiceEngine).toBe("auto");
  });

  it("keeps the file text size in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().fileFontSize).toBeNull();
    saveSettings(sanitizeSettings({ fileFontSize: 20 }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("fileFontSize");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().fileFontSize).toBe(20);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), fileFontSize: null });
    expect(loadSettings().fileFontSize).toBeNull();
    records.set("ovis:file-font-size", "\"20\"");
    expect(loadSettings().fileFontSize).toBeNull();
    records.set("ovis:file-font-size", "not json");
    expect(loadSettings().fileFontSize).toBeNull();
    const base = { size: 20, chat: 16, ui: 14 };
    saveSettings(sanitizeSettings({ fileFontSize: 20, fileFontBase: base }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("fileFontBase");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings()).toMatchObject({ fileFontSize: 20, fileFontBase: base });
    // a size written without its base (a build from before it) leaves the base recorded for another size unread
    records.set("ovis:file-font-size", "22");
    expect(loadSettings()).toMatchObject({ fileFontSize: 22, fileFontBase: null });
    // a save never keeps a base beside another size (a Reset over another tab's base, #2984)
    saveSettings({ ...loadSettings(), fileFontSize: null, fileFontBase: base });
    expect(records.get("ovis:file-font-base")).toBe("null");
  });

  it("keeps Pictures in the terminal in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().terminalImages).toBe(null);
    saveSettings(sanitizeSettings({ terminalImages: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("terminalImages");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().terminalImages).toBe(true);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), terminalImages: false });
    expect(loadSettings().terminalImages).toBe(false);
    records.set("ovis:terminal-pictures", "\"true\"");
    expect(loadSettings().terminalImages).toBe(null);
  });

  it("reads an earlier version's pictures key as a choice only when it says on", () => {
    records.set("ovis:terminal-images", "false");
    expect(loadSettings().terminalImages).toBe(null);
    records.set("ovis:terminal-images", "true");
    expect(loadSettings().terminalImages).toBe(true);
    records.set("ovis:terminal-pictures", "false");
    expect(loadSettings().terminalImages).toBe(false);
  });

  it("keeps a reset of pictures after an earlier version's on", () => {
    records.set("ovis:terminal-images", "true");
    expect(loadSettings().terminalImages).toBe(true);
    saveSettings({ ...loadSettings(), terminalImages: null });
    expect(loadSettings().terminalImages).toBe(null);
  });

  it("keeps the terminal's Attach files button in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().terminalAttachButton).toBe(false);
    saveSettings(sanitizeSettings({ terminalAttachButton: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("terminalAttachButton");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().terminalAttachButton).toBe(true);
    saveSettings({ ...loadSettings(), terminalAttachButton: false });
    expect(loadSettings().terminalAttachButton).toBe(false);
    records.set("ovis:terminal-attach-button", "\"true\"");
    expect(loadSettings().terminalAttachButton).toBe(false);
  });

  it("keeps Fold the key bar in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().terminalFoldKeyBar).toBe(false);
    saveSettings(sanitizeSettings({ terminalFoldKeyBar: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("terminalFoldKeyBar");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().terminalFoldKeyBar).toBe(true);
    saveSettings({ ...loadSettings(), terminalFoldKeyBar: false });
    expect(loadSettings().terminalFoldKeyBar).toBe(false);
    records.set("ovis:terminal-fold-key-bar", "\"true\"");
    expect(loadSettings().terminalFoldKeyBar).toBe(false);
  });

  it("keeps the imported themes in their own key, out of an old tab's whole-record save, and their rows for the first frame", () => {
    const read = readThemeFile(JSON.stringify({ name: "Night", dark: { base00: "#101418", base05: "#d0d8e0" } }));
    if (!("theme" in read)) throw new Error("the fixture is no theme");
    const custom = withTheme(NO_CUSTOM_THEMES, read.theme, "dark")!;
    expect(loadSettings().customThemes).toBe(NO_CUSTOM_THEMES);
    saveSettings({ ...loadSettings(), customThemes: custom });
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("customThemes");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().customThemes).toEqual(custom);
    records.set(CUSTOM_THEMES_STORAGE_KEY, "{not json");
    expect(loadSettings().customThemes).toBe(NO_CUSTOM_THEMES);

    // no record of rows while no side draws an imported theme
    saveBootRows(NO_CUSTOM_THEMES);
    expect(records.has(CUSTOM_ROWS_STORAGE_KEY)).toBe(false);
    saveBootRows(custom);
    expect(JSON.parse(records.get(CUSTOM_ROWS_STORAGE_KEY) ?? "{}")).toEqual({ dark: customRow(read.theme, "dark") });
    saveBootRows({ ...custom, dark: null });
    expect(records.has(CUSTOM_ROWS_STORAGE_KEY)).toBe(false);
  });

  it("keeps Keyboard only from the key bar in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().terminalKeyboardOnRequest).toBe(false);
    saveSettings(sanitizeSettings({ terminalKeyboardOnRequest: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("terminalKeyboardOnRequest");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().terminalKeyboardOnRequest).toBe(true);
    saveSettings({ ...loadSettings(), terminalKeyboardOnRequest: false });
    expect(loadSettings().terminalKeyboardOnRequest).toBe(false);
    records.set("ovis:terminal-keyboard-on-request", "\"true\"");
    expect(loadSettings().terminalKeyboardOnRequest).toBe(false);
  });

  it("keeps the composer's Artifacts chip in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().composerArtifacts).toBe(false);
    saveSettings(sanitizeSettings({ composerArtifacts: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("composerArtifacts");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().composerArtifacts).toBe(true);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), composerArtifacts: false });
    expect(loadSettings().composerArtifacts).toBe(false);
    records.set("ovis:composer-artifacts", "\"true\"");
    expect(loadSettings().composerArtifacts).toBe(false);
    records.set("ovis:composer-artifacts", "not json");
    expect(loadSettings().composerArtifacts).toBe(false);
  });

  it("keeps the composer's Paste and send button in its own key, out of an old tab's whole-record save (#2493)", () => {
    saveSettings(sanitizeSettings({ composerPasteSend: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("composerPasteSend");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().composerPasteSend).toBe(true);
    records.set("ovis:composer-paste-send", "\"true\"");
    expect(loadSettings().composerPasteSend).toBe(false);
  });

  it("keeps Expand thinking, Collapse work and Files beside the pane in keys of their own, out of an old tab's whole-record save", () => {
    for (const [key, stored] of [["expandThinking", "ovis:expand-thinking"], ["foldWork", "ovis:fold-work"], ["filesPanel", "ovis:files-panel"]] as const) {
      expect(loadSettings()[key]).toBe(false);
      saveSettings(sanitizeSettings({ [key]: true }));
      expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty(key);
      oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
      expect(loadSettings()[key]).toBe(true);
      expect(loadSettings().terminalFontSize).toBe(18);
      saveSettings({ ...loadSettings(), [key]: false });
      expect(loadSettings()[key]).toBe(false);
      records.set(stored, "\"true\"");
      expect(loadSettings()[key]).toBe(false);
      records.set(stored, "not json");
      expect(loadSettings()[key]).toBe(false);
    }
  });

  it("keeps Reuse tab for external links in its own key, out of an old tab's whole-record save", () => {
    expect(loadSettings().reuseExternalLinkTab).toBe(false);
    saveSettings(sanitizeSettings({ reuseExternalLinkTab: true }));
    expect(JSON.parse(records.get(main) ?? "{}")).not.toHaveProperty("reuseExternalLinkTab");
    oldSaveSettings({ ...readOld(), terminalFontSize: 18 });
    expect(loadSettings().reuseExternalLinkTab).toBe(true);
    expect(loadSettings().terminalFontSize).toBe(18);
    saveSettings({ ...loadSettings(), reuseExternalLinkTab: false });
    expect(loadSettings().reuseExternalLinkTab).toBe(false);
    records.set("ovis:reuse-external-link-tab", "\"true\"");
    expect(loadSettings().reuseExternalLinkTab).toBe(false);
  });

  it("survives repeated stale saves from an already-open old tab (f1)", () => {
    putOld({ theme: "dark", palette: "charcoal" });
    const stale = readOld();
    saveSettings(sanitizeSettings({ darkTheme: "tokyo-night" }));
    for (const terminalFontSize of [14, 15, 16]) {
      oldSaveSettings({ ...stale, terminalFontSize });
      expect(loadSettings().darkTheme).toBe("tokyo-night");
      expect(loadSettings().terminalFontSize).toBe(terminalFontSize);
    }
  });

  it.each(["amber", "charcoal"] as const)("documents that an outdated tab's explicit %s pick cannot reach new code without sync (f2, f3)", (palette) => {
    saveSettings(sanitizeSettings({ darkTheme: "tokyo-night" }));
    oldSaveSettings({ ...readOld(), palette });
    expect(loadSettings().darkTheme).toBe("tokyo-night");
  });

  it("loads and saves idempotently with a separate protected mirror (g)", () => {
    putOld({ theme: "system", palette: "amber", paletteDark: "charcoal", paletteLight: "catppuccin" });
    const first = loadSettings();
    saveSettings(first);
    expect(loadSettings()).toEqual(first);
    saveSettings(loadSettings());
    expect(loadSettings()).toEqual(first);
    expect(JSON.parse(records.get(protectedThemes) ?? "{}")).toEqual({
      darkTheme: "charcoal", lightTheme: "catppuccin",
      mirror: { palette: "charcoal", paletteDark: "charcoal", paletteLight: "catppuccin" },
    });
  });

  it("writes the row's actual mode, palette, meta and color scheme on either side (k)", () => {
    const root = { lang: "", dataset: {}, style: { colorScheme: "", setProperty() {}, removeProperty() {} } };
    let meta = "";
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: root, querySelector: () => ({ setAttribute: (_name: string, value: string) => { meta = value; } }),
    } });
    const settings = sanitizeSettings({ theme: "light", lightTheme: "dracula" });
    const entry = themeFor(settings, "light");
    withComputedBg("#282a36", () => applyToDocument(settings, entry, "en"));
    expect(root.dataset).toMatchObject({ theme: "dark", palette: "dracula" });
    expect(root.style.colorScheme).toBe("dark");
    expect(meta).toBe(entry.bgPanel);
    expect(terminalTheme(entry.mode, entry.id)).toEqual(entry.terminal);
  });

  it("holds the page's surface under an imported row until the stylesheet is there, though the row sets --bg itself", () => {
    const props = new Map<string, string>();
    const root = { lang: "", dataset: {}, style: { colorScheme: "", backgroundColor: "", setProperty: (name: string, value: string) => { props.set(name, value); }, removeProperty: (name: string) => { if (name === "background-color") root.style.backgroundColor = ""; else props.delete(name); } } };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root, querySelector: () => null } });
    const read = readThemeFile(JSON.stringify({ name: "Night", dark: { base00: "#101418", base05: "#d0d8e0" } }));
    if (!("theme" in read)) throw new Error("the fixture is no theme");
    const row = customRow(read.theme, "dark");
    const settings = sanitizeSettings({ theme: "dark" });
    // what the document answers: the row's own inline colours, and the stylesheet's tokens only once it has loaded
    const withSheet = (loaded: boolean, run: () => void): void => {
      const saved = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
      Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: (name: string) => props.get(name) ?? (loaded && name === "--pdf-page" ? "#ffffff" : "") }) });
      try { run(); } finally {
        if (saved) Object.defineProperty(globalThis, "getComputedStyle", saved);
        else Reflect.deleteProperty(globalThis, "getComputedStyle");
      }
    };
    withSheet(false, () => applyToDocument(settings, row, "en"));
    expect(props.get("--bg")).toBe("#101418");
    expect(root.style.backgroundColor).toBe("#101418");
    withSheet(true, () => applyToDocument(settings, row, "en"));
    expect(root.style.backgroundColor).toBe("");
  });

  it("scales a file's text by the chat's size until it has its own, its source only once chosen", () => {
    const props = new Map<string, string>();
    const root = { lang: "", dataset: {}, style: { colorScheme: "", setProperty: (name: string, value: string) => { props.set(name, value); }, removeProperty: (name: string) => { props.delete(name); } } };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root, querySelector: () => null } });
    const apply = (raw: Record<string, unknown>): void => {
      const settings = sanitizeSettings(raw);
      withComputedBg("#000", () => applyToDocument(settings, themeFor(settings, "dark"), "en"));
    };
    apply({ chatFontSize: 21 });
    expect(props.get("--file-scale")).toBe(props.get("--chat-scale"));
    expect(props.get("--file-scale")).toBe("1.5");
    expect(props.has("--file-source-scale")).toBe(false);
    apply({ chatFontSize: 21, fileFontSize: 28 });
    expect(props.get("--chat-scale")).toBe("1.5");
    expect(props.get("--file-scale")).toBe(String(24 / 14));
    // the source moves by the file size over the chat's, the size the stepper starts from: choosing that size changes
    // nothing, and a step moves the source the way it moves the preview
    expect(props.get("--file-source-scale")).toBe(String(24 / 21));
    apply({ chatFontSize: 21, fileFontSize: 21 });
    expect(props.get("--file-source-scale")).toBe("1");
    apply({ chatFontSize: 21, fileFontSize: 20 });
    expect(Number(props.get("--file-source-scale"))).toBeLessThan(1);
    apply({ chatFontSize: 11, fileFontSize: 12 });
    expect(Number(props.get("--file-source-scale"))).toBeGreaterThan(1);
    // the chat's size when the file size was chosen is kept with it: a later chat size leaves the source be
    const base = { size: 24, chat: 21, ui: 14 };
    apply({ chatFontSize: 21, fileFontSize: 24, fileFontBase: base });
    const chosen = props.get("--file-source-scale");
    apply({ chatFontSize: 11, fileFontSize: 24, fileFontBase: base });
    expect(props.get("--file-source-scale")).toBe(chosen);
    apply({ chatFontSize: 24, fileFontSize: 24, fileFontBase: base });
    expect(props.get("--file-source-scale")).toBe(chosen);
    // so does a later interface size: the source is --fs-xs, which moves by --ui-scale, times this scale (#2984)
    const source = (): number => Number(props.get("--ui-scale")) * Number(props.get("--file-source-scale"));
    apply({ uiFontSize: 14, chatFontSize: 21, fileFontSize: 24, fileFontBase: base });
    const kept = source();
    apply({ uiFontSize: 21, chatFontSize: 21, fileFontSize: 24, fileFontBase: base });
    expect(source()).toBeCloseTo(kept, 12);
    apply({ uiFontSize: 11, fileFontSize: 24, fileFontBase: base });
    expect(source()).toBeCloseTo(kept, 12);
    // a base recorded for another size is not this size's: the size scales from the chat's as if just chosen
    apply({ chatFontSize: 21, fileFontSize: 20, fileFontBase: base });
    expect(props.get("--file-source-scale")).toBe(String(20 / 21));
    apply({ chatFontSize: 21 });
    expect(props.has("--file-source-scale")).toBe(false);
  });

  it("keeps the row's surface on the root until a stylesheet owns it, following later themes", () => {
    const style = {
      colorScheme: "", backgroundColor: "#fffaf3", setProperty() {}, removeProperty(name: string) { if (name === "background-color") style.backgroundColor = ""; },
    };
    const root = { lang: "", dataset: {}, style };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root, querySelector: () => null } });
    const light = sanitizeSettings({ theme: "light", lightTheme: "rose-pine-dawn", darkTheme: "kanagawa" });
    // the stylesheet failed: nothing defines --bg, so the boot surface stays, on whichever row is drawn
    withComputedBg("", () => applyToDocument(light, themeFor(light, "light"), "en"));
    expect(style.backgroundColor).toBe(themeFor(light, "light").bg);
    const dark = { ...light, theme: "dark" as const };
    withComputedBg("", () => applyToDocument(dark, themeFor(dark, "dark"), "en"));
    expect(style.backgroundColor).toBe(themeFor(dark, "dark").bg);
    // a stylesheet that owns the surface takes it back
    withComputedBg(" #1f1f28", () => applyToDocument(dark, themeFor(dark, "dark"), "en"));
    expect(style.backgroundColor).toBe("");
  });

  function withComputedBg(value: string, run: () => void): void {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: (name: string) => (name === "--bg" ? value : "") }) });
    try {
      run();
    } finally {
      if (saved) Object.defineProperty(globalThis, "getComputedStyle", saved);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    }
  }
});

it("keeps a tab's pane while out of use until this device turns the pause on", () => {
  expect(DEFAULT_SETTINGS.releasePaneAway).toBe(false);
  expect(sanitizeSettings({}).releasePaneAway).toBe(false);
  expect(sanitizeSettings({ releasePaneAway: true }).releasePaneAway).toBe(true);
  expect(sanitizeSettings({ releasePaneAway: "true" }).releasePaneAway).toBe(false);
});

it("leaves herdr's focus alone until this device asks to follow it, and keeps that choice its own", () => {
  expect(DEFAULT_SETTINGS.followHerdrFocus).toBe(false);
  expect(sanitizeSettings({}).followHerdrFocus).toBe(false);
  expect(sanitizeSettings({ followHerdrFocus: true }).followHerdrFocus).toBe(true);
  expect(sanitizeSettings({ followHerdrFocus: "true" }).followHerdrFocus).toBe(false);
  expect(SETTING_SCOPE.followHerdrFocus).toBe("device");
  expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain("followHerdrFocus");
});

it("drops the rows-and-columns choice an older version stored: the split view always takes rows and columns", () => {
  expect(sanitizeSettings({ splitGrid: false })).not.toHaveProperty("splitGrid");
});

it("keeps a Codex pane's drag Ovis's until this device hands it to Codex, and keeps that choice its own", () => {
  expect(DEFAULT_SETTINGS.codexDrag).toBe(false);
  expect(sanitizeSettings({}).codexDrag).toBe(false);
  expect(sanitizeSettings({ codexDrag: true }).codexDrag).toBe(true);
  expect(sanitizeSettings({ codexDrag: "true" }).codexDrag).toBe(false);
  expect(SETTING_SCOPE.codexDrag).toBe("device");
  expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain("codexDrag");
});

it("keeps the sidebar's hover peek off until this device turns it on, and keeps that choice its own", () => {
  expect(DEFAULT_SETTINGS.sidebarPeek).toBe(false);
  expect(sanitizeSettings({}).sidebarPeek).toBe(false);
  expect(sanitizeSettings({ sidebarPeek: true }).sidebarPeek).toBe(true);
  expect(sanitizeSettings({ sidebarPeek: "true" }).sidebarPeek).toBe(false);
  expect(SETTING_SCOPE.sidebarPeek).toBe("device");
  expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain("sidebarPeek");
});

it("keeps herdr's prefix keys off until this device turns them on, and keeps that choice its own", () => {
  expect(sanitizeSettings({}).herdrPrefixKeys).toBe(false);
  expect(sanitizeSettings({ herdrPrefixKeys: true }).herdrPrefixKeys).toBe(true);
  expect(sanitizeSettings({ herdrPrefixKeys: "true" }).herdrPrefixKeys).toBe(false);
  expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain("herdrPrefixKeys");
});

it("keeps background workspaces in place until this device turns their part on, and keeps that choice its own", () => {
  expect(DEFAULT_SETTINGS.sidebarBackgroundWorkspaces).toBe(false);
  expect(sanitizeSettings({}).sidebarBackgroundWorkspaces).toBe(false);
  expect(sanitizeSettings({ sidebarBackgroundWorkspaces: true }).sidebarBackgroundWorkspaces).toBe(true);
  expect(sanitizeSettings({ sidebarBackgroundWorkspaces: "true" }).sidebarBackgroundWorkspaces).toBe(false);
  expect(SETTING_SCOPE.sidebarBackgroundWorkspaces).toBe("device");
  expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain("sidebarBackgroundWorkspaces");
});

it("ignores what was saved for the rows Settings no longer has", () => {
  const settings = sanitizeSettings({ historyPrompts: 50, composerNewTabButton: true, markdownWidth: "full", alertInApp: false });
  for (const key of ["historyPrompts", "composerNewTabButton", "markdownWidth", "alertInApp"]) expect(settings).not.toHaveProperty(key);
  expect(telemetrySettingsSnapshot(settings).markdownWidth).toBe("readable");
  // in-app alerts always drop in now: an older version's stored "off" is not reported either
  expect(telemetrySettingsSnapshot(settings).alertInApp).toBe(true);
});

it("shows the selected PC's load until this device turns it off, however many PCs are connected", () => {
  const pc = (state: string) => ({ state });
  expect(sanitizeSettings({}).pcLoad).toBeNull();
  for (const pcLoad of ["true", 1, null]) expect(sanitizeSettings({ pcLoad }).pcLoad).toBeNull();
  expect(sanitizeSettings({ pcLoad: false }).pcLoad).toBe(false);
  // unchosen: on, also with a lone PC
  expect(pcLoadOn({ pcLoad: null }, [pc("connected")])).toBe(true);
  expect(pcLoadOn({ pcLoad: null }, [pc("connected"), pc("connected")])).toBe(true);
  // a choice holds whatever the roster says
  expect(pcLoadOn({ pcLoad: true }, [pc("connected")])).toBe(true);
  expect(pcLoadOn({ pcLoad: false }, [pc("connected"), pc("connected")])).toBe(false);
  expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain("pcLoad");
});

it("keeps the composer's Artifacts chip off until this device turns it on, and keeps that choice its own", () => {
  expect(sanitizeSettings({}).composerArtifacts).toBe(false);
  expect(sanitizeSettings({ composerArtifacts: true }).composerArtifacts).toBe(true);
  expect(sanitizeSettings({ composerArtifacts: "true" }).composerArtifacts).toBe(false);
  expect(SETTING_SCOPE.composerArtifacts).toBe("device");
});

it("keeps the composer's Paste and send button off until this device turns it on, and keeps that choice its own (#2493)", () => {
  expect(sanitizeSettings({}).composerPasteSend).toBe(false);
  expect(sanitizeSettings({ composerPasteSend: true }).composerPasteSend).toBe(true);
  expect(sanitizeSettings({ composerPasteSend: "true" }).composerPasteSend).toBe(false);
  expect(SETTING_SCOPE.composerPasteSend).toBe("device");
});

it("keeps the chat's folds as they always started until this device chooses Expand thinking or Collapse work, and keeps that choice its own", () => {
  for (const key of ["expandThinking", "foldWork"] as const) {
    expect(sanitizeSettings({})[key]).toBe(false);
    expect(sanitizeSettings({ [key]: true })[key]).toBe(true);
    expect(sanitizeSettings({ [key]: "true" })[key]).toBe(false);
    expect(SETTING_SCOPE[key]).toBe("device");
    expect(SHARED_SETTING_KEYS as readonly string[]).not.toContain(key);
  }
});

it("keeps the screen wake lock off until this device explicitly enables it", () => {
  expect(DEFAULT_SETTINGS.keepScreenOn).toBe(false);
  expect(sanitizeSettings({}).keepScreenOn).toBe(false);
  expect(sanitizeSettings({ keepScreenOn: true }).keepScreenOn).toBe(true);
  expect(sanitizeSettings({ keepScreenOn: "true" }).keepScreenOn).toBe(false);
  // the terminal's wheel speed: one report per wheel event unless chosen, whole and bounded
  expect(sanitizeSettings({}).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: 3 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 2.6 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 99 }).terminalWheelSpeed).toBe(10);
  expect(sanitizeSettings({ terminalWheelSpeed: 0 }).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: "3" }).terminalWheelSpeed).toBe(1);
});

it("keeps the suggestion chip off until this device turns it on, whatever an older version stored", () => {
  expect(sanitizeSettings({}).suggestionChip).toBe(false);
  expect(sanitizeSettings({ showSuggestionChip: true }).suggestionChip).toBe(false);
  expect(sanitizeSettings({ suggestionChip: true }).suggestionChip).toBe(true);
  expect(sanitizeSettings({ suggestionChip: "true" }).suggestionChip).toBe(false);
});

it("keeps sidebar rows on one line unless two lines were chosen", () => {
  expect(sanitizeSettings({}).sidebarRows).toBe("one");
  expect(sanitizeSettings({ sidebarRows: "two" }).sidebarRows).toBe("two");
  for (const sidebarRows of [null, true, "three", 2]) {
    expect(sanitizeSettings({ sidebarRows }).sidebarRows).toBe("one");
  }
});

it("draws agent logos in their brand colors unless Mono was chosen", () => {
  expect(DEFAULT_SETTINGS.agentMarks).toBe("color");
  expect(sanitizeSettings({}).agentMarks).toBe("color");
  expect(sanitizeSettings({ agentMarks: "mono" }).agentMarks).toBe("mono");
  for (const agentMarks of [null, "Mono", "off", 1]) {
    expect(sanitizeSettings({ agentMarks }).agentMarks).toBe("color");
  }
});

describe("telemetry settings snapshot", () => {
  it("reports current enum, boolean and bounded scalar values", () => {
    const settings = sanitizeSettings({
      terminalInputMode: "direct",
      theme: "light",
      density: "compact",
      sidebarRows: "one",
      agentOrder: "activity",
      agentMarks: "mono",
      statusIndicators: "symbols",
      palette: "catppuccin",
      terminalFontSize: 22,
      terminalWheelSpeed: 10,
      chatFontSize: 11,
      chatWidth: "wide",
      autoSendQueued: false,
      language: "ko",
      alertDone: "always",
      usageCount: "left",
      usageGlance: "session",
      defaultView: "chat",
      voiceInput: "on",
      voiceLanguage: "ko-KR",
      wrapCode: true,
      paletteLight: "catppuccin",
      paletteDark: "amber",
      darkTheme: "amber",
      lightTheme: "catppuccin",
      uiFontSize: 18,
      diffStyle: "split",
    });
    const snapshot = telemetrySettingsSnapshot(settings);

    expect(NOTICE_VERSION).toBe(5);
    expect(snapshot).toMatchObject({
      terminalInputMode: "direct",
      theme: "light",
      density: "compact",
      sidebarRows: "one",
      agentOrder: "activity",
      agentMarks: "mono",
      statusIndicators: "symbols",
      palette: "catppuccin",
      terminalFontSize: 22,
      terminalWheelSpeed: 10,
      chatFontSize: 11,
      chatWidth: "wide",
      autoSendQueued: false,
      language: "ko",
      alertDone: "always",
      usageCount: "left",
      usageGlance: "session",
      defaultView: "chat",
      voiceInput: "on",
      voiceLanguage: "ko-KR",
      wrapCode: true,
      markdownWidth: "readable",
      paletteLight: "catppuccin",
      paletteDark: "amber",
      darkTheme: "amber",
      lightTheme: "catppuccin",
      uiFontSize: 18,
      diffStyle: "split",
    });
    expect(telemetrySettings(snapshot)).toEqual(snapshot);
    expect(telemetrySettingsSnapshot(DEFAULT_SETTINGS)).toMatchObject({
      statusIndicators: "classic",
      terminalFontCustom: false,
      chatFontCustom: false,
      shortcutsCustom: false,
      keyBarCustom: false,
      quickRepliesCustom: false,
      quickReplyCount: DEFAULT_SETTINGS.quickReplies.length,
      usageHiddenCount: 0,
      usageOrderCustom: false,
    });
  });

  it("summarizes custom text and account-key settings without sending their contents", () => {
    const settings = sanitizeSettings({
      terminalFontFamily: "private-terminal-font",
      chatFontFamily: "private-chat-font",
      uiFontFamily: "private-ui-font",
      shortcutOverrides: { palette: "x" },
      keyBarItems: [{ type: "key", key: "x" }],
      keyBarExtras: ["alt", "shift-tab"],
      quickReplies: ["private quick reply"],
      usageOrder: ["private-order-account-id"],
      usageHidden: ["private-hidden-account-id"],
    });
    const snapshot = telemetrySettingsSnapshot(settings);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      terminalFontCustom: true,
      chatFontCustom: true,
      shortcutsCustom: true,
      keyBarCustom: true,
      quickRepliesCustom: true,
      quickReplyCount: 1,
      usageHiddenCount: 1,
      usageOrderCustom: true,
    });
    for (const key of ["keyBarExtras", "keyBarItems", "shortcutOverrides", "terminalFontFamily", "chatFontFamily", "uiFontFamily", "quickReplies", "usageOrder", "usageHidden"]) {
      expect(snapshot).not.toHaveProperty(key);
    }
    for (const raw of ["private-terminal-font", "private-chat-font", "private-ui-font", "private quick reply", "private-order-account-id", "private-hidden-account-id"]) {
      expect(serialized).not.toContain(raw);
    }
  });

  it("reports every status indicator choice in a valid snapshot", () => {
    for (const statusIndicators of ["classic", "dots", "symbols"] as const) {
      const settings = sanitizeSettings({ statusIndicators });
      const snapshot = telemetrySettingsSnapshot(settings);

      expect(snapshot.statusIndicators).toBe(statusIndicators);
      expect(telemetrySettings(snapshot)).toEqual(snapshot);
    }
  });

  // The Worker refuses a whole snapshot over one key it does not know, and an older deployed
  // Worker refuses a key added since: a new setting is sent only once the Worker takes it.
  it("sends exactly the keys the Worker accepts", () => {
    const sent = Object.keys(telemetrySettingsSnapshot(DEFAULT_SETTINGS));
    expect([
      ...sent.filter((key) => !([...TELEMETRY_SETTINGS_KEYS, ...TELEMETRY_THEME_SIDE_KEYS] as string[]).includes(key)).map((key) =>
        `${key}: the app sends it and the Worker refuses the whole snapshot. Add it to TelemetrySettings and TELEMETRY_SETTINGS_VALIDATORS in shared/telemetry.ts and to the full snapshot in telemetry/worker.test.ts, then deploy the Worker before releasing (telemetry/README.md).`),
      ...TELEMETRY_SETTINGS_KEYS.filter((key) => !sent.includes(key)).map((key) =>
        `${key}: the Worker requires it and telemetrySettingsSnapshot in src/lib/settings.ts does not send it. Send it, or remove it from shared/telemetry.ts and deploy the Worker before releasing.`),
    ]).toEqual([]);
  });

  it("reports all supported ids on either side and rejects ids outside the schema", () => {
    for (const id of THEME_IDS) {
      for (const side of ["darkTheme", "lightTheme"] as const) {
        const snapshot = telemetrySettingsSnapshot(sanitizeSettings({ [side]: id }));
        expect(snapshot[side]).toBe(id);
        expect(telemetrySettings(snapshot)).toEqual(snapshot);
        expect(telemetrySettings({ ...snapshot, [side]: "not-a-theme" })).toBeNull();
      }
    }
  });

  it("requires a complete, valid schema and reconstructs a clean own-key snapshot", () => {
    const snapshot = telemetrySettingsSnapshot(DEFAULT_SETTINGS);
    const clean = telemetrySettings(snapshot);

    expect(clean).toEqual(snapshot);
    expect(clean).not.toBe(snapshot);
    expect(Object.getPrototypeOf(clean!)).toBe(Object.prototype);
    expect(Object.keys(clean!)).toEqual(Object.keys(snapshot));
    expect(telemetrySettings(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "theme")))).toBeNull();
    expect(telemetrySettings({ ...snapshot, unknownSetting: true })).toBeNull();
    expect(telemetrySettings({ ...snapshot, theme: "neon" })).toBeNull();
    expect(telemetrySettings({ ...snapshot, theme: null })).toBeNull();
    expect(telemetrySettings({ ...snapshot, terminalFontSize: 9 })).toBeNull();
    expect(telemetrySettings({ ...snapshot, terminalWheelSpeed: 2.5 })).toBeNull();
    expect(telemetrySettings({ ...snapshot, chatFontSize: 10 })).toBeNull();
    expect(telemetrySettings({ ...snapshot, quickReplyCount: 13 })).toBeNull();
    expect(telemetrySettings({ ...snapshot, usageHiddenCount: 65 })).toBeNull();
    expect(telemetrySettings(Object.assign(Object.create({ inherited: true }), snapshot))).toBeNull();
  });
});

describe("clipboard from a pane", () => {
  it("is on in a fresh install", () => {
    expect(DEFAULT_SETTINGS.paneClipboard).toBe(true);
    expect(sanitizeSettings({}).paneClipboard).toBe(true);
  });

  it("turns on for a 0.4.1 record, whose false was saved with any other change", () => {
    const loaded = sanitizeSettings(JSON.parse(JSON.stringify({ theme: "light", terminalOsc52: false })));
    expect(loaded.paneClipboard).toBe(true);
    expect(loaded).not.toHaveProperty("terminalOsc52");
  });

  it("stays off once turned off, across a save and a reload", () => {
    const chosen = sanitizeSettings({ ...sanitizeSettings({ terminalOsc52: false }), paneClipboard: false });
    const reloaded = sanitizeSettings(JSON.parse(JSON.stringify(chosen)));
    expect(reloaded.paneClipboard).toBe(false);
    expect(sanitizeSettings({ ...reloaded, theme: "dark" }).paneClipboard).toBe(false);
    expect(sanitizeSettings({ paneClipboard: "false" }).paneClipboard).toBe(true);
  });
});

it("leaves terminal pictures to the server until this device chooses, and keeps either choice", () => {
  expect(sanitizeSettings({}).terminalImages).toBe(null);
  expect(sanitizeSettings({ terminalImages: "true" }).terminalImages).toBe(null);
  expect(sanitizeSettings(JSON.parse(JSON.stringify(sanitizeSettings({ terminalImages: true })))).terminalImages).toBe(true);
  expect(sanitizeSettings(JSON.parse(JSON.stringify(sanitizeSettings({ terminalImages: false })))).terminalImages).toBe(false);
  expect(SETTING_SCOPE.terminalImages).toBe("device");
});

it("raises the terminal's keyboard on every tap until this device asks for it only from the key bar", () => {
  expect(sanitizeSettings({}).terminalKeyboardOnRequest).toBe(false);
  expect(sanitizeSettings({ terminalKeyboardOnRequest: "true" }).terminalKeyboardOnRequest).toBe(false);
  expect(sanitizeSettings({ terminalKeyboardOnRequest: true }).terminalKeyboardOnRequest).toBe(true);
  expect(SETTING_SCOPE.terminalKeyboardOnRequest).toBe("device");
});

it("drops a stored choice for the switches that are always on now: compaction details, Markdown outline, Files' Documents tab", () => {
  const stored = sanitizeSettings({ chatRequestDetails: false, markdownOutline: false, filesDocuments: false });
  for (const key of ["chatRequestDetails", "markdownOutline", "filesDocuments"]) expect(stored).not.toHaveProperty(key);
});

it("keeps the key bar under the input line until this device folds it", () => {
  expect(sanitizeSettings({}).terminalFoldKeyBar).toBe(false);
  expect(sanitizeSettings({ terminalFoldKeyBar: "true" }).terminalFoldKeyBar).toBe(false);
  expect(sanitizeSettings({ terminalFoldKeyBar: true }).terminalFoldKeyBar).toBe(true);
  expect(SETTING_SCOPE.terminalFoldKeyBar).toBe("device");
});

it("draws no Attach files control in the terminal until this device turns it on", () => {
  expect(sanitizeSettings({}).terminalAttachButton).toBe(false);
  expect(sanitizeSettings({ terminalAttachButton: "true" }).terminalAttachButton).toBe(false);
  expect(sanitizeSettings(JSON.parse(JSON.stringify(sanitizeSettings({ terminalAttachButton: true })))).terminalAttachButton).toBe(true);
  expect(SETTING_SCOPE.terminalAttachButton).toBe("device");
});

it("drops the folder grouping an older version stored", () => {
  expect(sanitizeSettings({ sidebarGrouping: "directory" })).not.toHaveProperty("sidebarGrouping");
});

describe("chat font size", () => {
  it("follows the density until one is chosen, and keeps a chosen one within bounds", () => {
    expect(chatFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(chatFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(chatFontSize(sanitizeSettings({ density: "compact", chatFontSize: 17 }))).toBe(17);
    expect(sanitizeSettings({ chatFontSize: 99 }).chatFontSize).toBe(CHAT_FONT_MAX);
    expect(sanitizeSettings({ chatFontSize: 2 }).chatFontSize).toBe(CHAT_FONT_MIN);
    expect(sanitizeSettings({ chatFontSize: 15.6 }).chatFontSize).toBe(16);
    expect(sanitizeSettings({ chatFontSize: "18" }).chatFontSize).toBeNull();
    expect(sanitizeSettings({ terminalFontSize: 15 }).chatFontSize).toBeNull();
  });

});

describe("queued messages", () => {
  it("sends queued messages by themselves unless that was turned off", () => {
    expect(DEFAULT_SETTINGS.autoSendQueued).toBe(true);
    expect(sanitizeSettings({}).autoSendQueued).toBe(true);
    expect(sanitizeSettings({ autoSendQueued: false }).autoSendQueued).toBe(false);
    expect(sanitizeSettings({ autoSendQueued: "yes" }).autoSendQueued).toBe(true);
  });
});

describe("chat width", () => {
  it("is the default lane until one is chosen, and accepts only the four steps", () => {
    expect(DEFAULT_SETTINGS.chatWidth).toBe("default");
    expect(sanitizeSettings({}).chatWidth).toBe("default");
    expect([...CHAT_WIDTHS]).toEqual(["narrow", "default", "wide", "full"]);
    for (const chatWidth of CHAT_WIDTHS) expect(sanitizeSettings({ chatWidth }).chatWidth).toBe(chatWidth);
    for (const chatWidth of [null, true, 960, "huge", "Wide", ["wide"]]) expect(sanitizeSettings({ chatWidth }).chatWidth).toBe("default");
  });

  it("has one lane token with an override per step, and the dialogs keep their own width", () => {
    const css = (name: string): string => readFileSync(join(import.meta.dir, "..", name), "utf8");
    const tokens = css("styles.css");
    expect(tokens).toContain("--content-w: 820px;");
    // unmeasured, the lane is the Default rule's floor; the measured one is chatLaneLength's
    expect(tokens).toContain("--chat-w: var(--content-w);");
    expect(tokens).toContain(`--content-w: ${CHAT_LANE_MIN}px;`);
    const step = (name: string): string | undefined => new RegExp(`\\[data-chat-width="${name}"\\] \\{\\s*--chat-w: ([^;]+);`).exec(tokens)?.[1];
    expect(step("narrow")).toBe("var(--content-w)");
    expect(step("wide")).toBe("72rem");
    expect(step("full")).toBe("100%");
    // the default step has no rule here: PaneTerminal writes its pane's lane on .terminal-stack, and a
    // file viewer, outside every pane, the lane of the pane that opened it on itself (lib/chatLane.ts)
    expect(step("default")).toBeUndefined();
    // a percentage in the token would resolve against each column's own box; Full is the one
    // step that means exactly that
    expect([...tokens.matchAll(/--chat-w: ([^;]+);/g)].map((match) => match[1]).filter((value) => value?.includes("%"))).toEqual(["100%"]);
    // one rule for both, so a change to it cannot miss the viewer
    expect(css("lib/chatLane.ts")).toContain(`setProperty("--chat-w", chatLaneLength(`);
    expect(css("components/PaneTerminal.tsx")).toContain("usePaneLane(stackRef)");
    expect(css("components/FileViewer.tsx")).toContain("useOpeningPaneLane(");
    for (const name of ["components/PaneTerminal.tsx", "components/FileViewer.tsx"]) expect(css(name)).not.toContain("chatLaneLength(");
    // the root font size is not read in JS: the ceiling is 60rem in the length itself
    expect(css("lib/chatLane.ts")).not.toContain("chatLaneWidth(");
    // Settings and New workspace stay on --content-w. That the chat columns share the lane is
    // measured in the browser (scripts/ui-regression.ts), not read from the stylesheets
    for (const file of ["components/SettingsDialog.css", "components/NewSessionDialog.css"]) {
      expect(css(file)).toContain("var(--content-w)");
      expect(css(file)).not.toContain("var(--chat-w)");
    }
  });
});

describe("the default chat lane", () => {
  it("is 71.43% of the pane, never under 820px or over 60rem (960px at a 16px root)", () => {
    expect(CHAT_LANE_MIN).toBe(820);
    expect(CHAT_LANE_MAX_REM).toBe(60);
    // the pane beside a 320px sidebar in a 1280, 1440, 1680 and 1920 window
    expect([960, 1120, 1360, 1600].map((pane) => chatLaneWidth(pane))).toEqual([820, 820, 960, 960]);
    // between the two ends it follows the pane, in whole px
    expect(chatLaneWidth(1148)).toBe(820);
    expect(chatLaneWidth(1149)).toBe(821);
    expect(chatLaneWidth(1200)).toBe(857);
    expect(chatLaneWidth(1300)).toBe(929);
    expect(chatLaneWidth(1343)).toBe(959);
    expect(chatLaneWidth(1344)).toBe(960);
  });

  it("is the floor for a phone, an unmeasured pane or a width that is not a number", () => {
    for (const width of [0, 390, 780, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatLaneWidth(width)).toBe(820);
  });

  it("has its ceiling in rem, so it is never wider than Wide's 72rem at a root font of 11.4px and up", () => {
    const wide = (root: number): number => 72 * root;
    // 16px: the sizes above, whether the root is passed or not
    expect([960, 1149, 1300, 1344, 1600, 4000].map((pane) => chatLaneWidth(pane, 16))).toEqual([820, 821, 929, 960, 960, 960]);
    // 20px: 60rem is 1200px, reached by a 1680px pane; Wide is 1440px
    expect([1148, 1344, 1600, 1679, 1680, 4000].map((pane) => chatLaneWidth(pane, 20))).toEqual([820, 960, 1143, 1199, 1200, 1200]);
    // 13px: 60rem is 780px, under the 820px floor. The floor wins: the lane is Narrow's at every
    // pane, and Wide (936px) is still the wider one. Before, a large pane got 960px here
    expect([960, 1149, 1344, 1600, 4000].map((pane) => chatLaneWidth(pane, 13))).toEqual([820, 820, 820, 820, 820]);
    // the two ends meet at 820 / 60 = 13.67px; a root just over it has a ceiling just over the floor
    expect(chatLaneWidth(4000, 14)).toBe(840);
    // a fractional root
    expect(chatLaneWidth(4000, 17.6)).toBe(1056);
    for (const root of [13, 14, 16, 17.6, 20, 24]) {
      for (const pane of [0, 960, 1344, 1920, 4000]) {
        const lane = chatLaneWidth(pane, root);
        expect(lane).toBeGreaterThanOrEqual(CHAT_LANE_MIN);
        expect(lane).toBeLessThanOrEqual(wide(root));
      }
    }
  });

  it("resolves the ceiling at 16px when the root font size is not a usable number", () => {
    for (const root of [0, -16, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatLaneWidth(4000, root)).toBe(960);
  });

  it("is written as one length with the ceiling left in rem, so it follows the root font size without being measured again", () => {
    expect(chatLaneLength(1600)).toBe("min(max(820px, 60rem), 1143px)");
    expect(chatLaneLength(4000)).toBe("min(max(820px, 60rem), 2857px)");
    for (const pane of [0, 390, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatLaneLength(pane)).toBe("min(max(820px, 60rem), 820px)");
    // no percentage (each column would resolve it against its own box), and no root size baked in
    // as px: the only px in it are the floor and the pane's share
    const resolve = (length: string, root: number): number => {
      const match = /^min\(max\((\d+)px, (\d+)rem\), (\d+)px\)$/.exec(length);
      if (!match) throw new Error(`not the lane's form: ${length}`);
      return Math.min(Math.max(Number(match[1]), Number(match[2]) * root), Number(match[3]));
    };
    // one length, written once at a 16px root, is right at every other root: a font size changed
    // while the tab is open needs no new measurement. A px ceiling written at 16px stayed 960px
    // at 13px, wider than Wide's 936px, until the pane was next resized
    const written = chatLaneLength(4000);
    expect([13, 14, 16, 17.6, 20].map((root) => resolve(written, root))).toEqual([820, 840, 960, 1056, 1200]);
    for (const root of [13, 14, 16, 17.6, 20, 24]) {
      for (const pane of [0, 960, 1149, 1344, 1600, 1920, 4000]) {
        expect(resolve(chatLaneLength(pane), root)).toBe(chatLaneWidth(pane, root));
        expect(resolve(chatLaneLength(pane), root)).toBeLessThanOrEqual(72 * root);
      }
    }
  });
});

describe("font families", () => {
  const family = (value: unknown): string => sanitizeSettings({ terminalFontFamily: value }).terminalFontFamily;

  it("keep today's fonts until a list is typed, and ignore anything that is not text", () => {
    expect(DEFAULT_SETTINGS.terminalFontFamily).toBe("");
    expect(DEFAULT_SETTINGS.chatFontFamily).toBe("");
    expect(sanitizeSettings({}).terminalFontFamily).toBe("");
    expect(sanitizeSettings({}).chatFontFamily).toBe("");
    for (const value of [undefined, null, 7, true, ["D2Coding"], { name: "D2Coding" }]) expect(family(value)).toBe("");
    expect(family("")).toBe("");
    expect(family("   ")).toBe("");
    expect(family(" , ,, ")).toBe("");
  });

  it("trim each name, drop empty ones and join them the CSS way", () => {
    expect(family("  D2Coding  ")).toBe("D2Coding");
    expect(family("D2Coding,,  , monospace,")).toBe("D2Coding, monospace");
    expect(family(",D2Coding")).toBe("D2Coding");
  });

  it("quote names with spaces once, and keep quoted names quoted", () => {
    expect(family("Cascadia Mono")).toBe('"Cascadia Mono"');
    expect(family("  Cascadia    Mono  ")).toBe('"Cascadia Mono"');
    expect(family('D2Coding, "Cascadia Mono", monospace')).toBe('D2Coding, "Cascadia Mono", monospace');
    expect(family("'Cascadia Mono'")).toBe('"Cascadia Mono"');
    expect(family('" Cascadia Mono "')).toBe('"Cascadia Mono"');
    // quoted, a generic name is a font by that name: the user's quotes stay
    expect(family('"monospace"')).toBe('"monospace"');
    // a stray or unbalanced quote cannot end the CSS string early
    expect(family('Cascadia"Mono')).toBe("CascadiaMono");
    expect(family('"Cascadia Mono')).toBe('"Cascadia Mono"');
    expect(family('""')).toBe("");
  });

  it("quote what CSS cannot read bare", () => {
    expect(family("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(family("1942report")).toBe('"1942report"');
    expect(family("inherit, D2Coding")).toBe('"inherit", D2Coding');
    expect(family("나눔고딕코딩")).toBe("나눔고딕코딩");
    expect(family("Sarasa-Mono-K")).toBe("Sarasa-Mono-K");
  });

  it("compose a decomposed name, so it matches the installed font", () => {
    const decomposed = "나눔고딕코딩".normalize("NFD");
    expect(decomposed).not.toBe("나눔고딕코딩");
    expect(family(decomposed)).toBe("나눔고딕코딩");
    expect(family(`D2Coding, ${"나눔 고딕".normalize("NFD")}`)).toBe('D2Coding, "나눔 고딕"');
  });

  it("strip what could leave the declaration", () => {
    expect(family("D2Coding; color: red")).toBe('"D2Coding color: red"');
    expect(family("D2Coding} body { color: red")).toBe('"D2Coding body color: red"');
    expect(family("</style><script>x</script>")).toBe('"/stylescriptx/script"');
    expect(family("D2\\Coding")).toBe("D2Coding");
    expect(family("D2\u0000Coding\nMono\t")).toBe("D2CodingMono");
    for (const unsafe of [";", "{", "}", "<", ">", "\\", "\u0000", "\u001f", "\u007f"]) expect(family(`x${unsafe}y`)).toBe("xy");
  });

  it("stay within the length limit, dropping whole names past it", () => {
    const long = Array.from({ length: 40 }, (_, index) => `Font Name ${index}`).join(", ");
    const kept = family(long);
    expect(kept.length).toBeLessThanOrEqual(FONT_FAMILY_MAX_CHARS);
    expect(kept.startsWith('"Font Name 0", "Font Name 1"')).toBe(true);
    // every name that made it is whole: its quotes pair up
    expect(kept.split(", ").every((name) => /^"Font Name \d+"$/.test(name))).toBe(true);
    expect(family("x".repeat(FONT_FAMILY_MAX_CHARS + 1))).toBe("");
    expect(family("x".repeat(FONT_FAMILY_MAX_CHARS))).toBe("x".repeat(FONT_FAMILY_MAX_CHARS));
  });

  it("are the same list after a second pass, so a saved one never drifts", () => {
    for (const typed of ['D2Coding, "Cascadia Mono", monospace', "'Fira Code' ,  Menlo", "inherit, 3270 Nerd Font"]) {
      const once = family(typed);
      expect(family(once)).toBe(once);
    }
  });

  it("sanitize the chat's list the same way, apart from the terminal's", () => {
    const both = sanitizeSettings({ terminalFontFamily: "D2Coding", chatFontFamily: " Pretendard ; , Noto Sans KR" });
    expect(both.terminalFontFamily).toBe("D2Coding");
    expect(both.chatFontFamily).toBe('Pretendard, "Noto Sans KR"');
  });
});

describe("alert choices", () => {
  it("keep alerts on unless this device turned them off with the bell", () => {
    expect(DEFAULT_SETTINGS.alertsOn).toBe(true);
    expect(sanitizeSettings({}).alertsOn).toBe(true);
    expect(sanitizeSettings({ alertsOn: false }).alertsOn).toBe(false);
    expect(sanitizeSettings({ alertsOn: "no" }).alertsOn).toBe(true);
  });

  it("keep the alert sound off until this device chooses it", () => {
    expect(DEFAULT_SETTINGS.alertSound).toBe(false);
    expect(sanitizeSettings({ alertSound: true }).alertSound).toBe(true);
    expect(sanitizeSettings({ alertSound: "yes" }).alertSound).toBe(false);
  });

  it("default to questions and long turns, and drop anything unknown to the default", () => {
    expect(alertPrefs(DEFAULT_SETTINGS)).toEqual({ input: true, done: "long" });
    expect(alertPrefs(sanitizeSettings({ alertInput: false, alertDone: "always" }))).toEqual({ input: false, done: "always" });
    expect(alertPrefs(sanitizeSettings({ alertInput: "no", alertDone: "sometimes" }))).toEqual({ input: true, done: "long" });
  });
});

describe("quick replies", () => {
  it("keep replies as typed, bounded, and show only the ones with something to send", () => {
    expect(quickReplyButtons(DEFAULT_SETTINGS)).toEqual(["continue", "yes", "no", "commit and push", "retry"]);
    // a trailing space is the next word being typed: it stays
    const typed = sanitizeSettings({ quickReplies: ["run the ", "", "  ", 7, "ship it"] });
    expect(typed.quickReplies).toEqual(["run the ", "", "  ", "ship it"]);
    expect(quickReplyButtons(typed)).toEqual(["run the ", "ship it"]);
    const many = sanitizeSettings({ quickReplies: Array.from({ length: 20 }, (_, index) => "x".repeat(300) + index) });
    expect(many.quickReplies).toHaveLength(QUICK_REPLIES_MAX);
    expect(many.quickReplies.every((reply) => reply.length === QUICK_REPLY_MAX_CHARS)).toBe(true);
    // an emptied list is a choice, not a broken record
    expect(sanitizeSettings({ quickReplies: [] }).quickReplies).toEqual([]);
    expect(sanitizeSettings({}).quickReplies).toEqual(DEFAULT_SETTINGS.quickReplies);
  });
});

describe("microphone button", () => {
  it("is automatic until chosen, and reads a record from before it had three places", () => {
    expect(DEFAULT_SETTINGS.voiceInput).toBe("auto");
    expect(sanitizeSettings({}).voiceInput).toBe("auto");
    for (const voiceInput of VOICE_BUTTONS) expect(sanitizeSettings({ voiceInput }).voiceInput).toBe(voiceInput);
    // the old toggle: on was a choice, off was also what an untouched device stored
    expect(sanitizeSettings({ voiceInput: true }).voiceInput).toBe("on");
    expect(sanitizeSettings({ voiceInput: false }).voiceInput).toBe("auto");
    for (const voiceInput of [null, 1, "yes", "ON"]) expect(sanitizeSettings({ voiceInput }).voiceInput).toBe("auto");
  });

  it("listens for the browser's language until another is chosen from the list", () => {
    expect(DEFAULT_SETTINGS.voiceLanguage).toBe("auto");
    expect(sanitizeSettings({}).voiceLanguage).toBe("auto");
    for (const voiceLanguage of DICTATION_LANGUAGES) expect(sanitizeSettings({ voiceLanguage }).voiceLanguage).toBe(voiceLanguage);
    for (const voiceLanguage of [null, 1, "", "hu", "hu-hu", "xx-XX", "auto "]) expect(sanitizeSettings({ voiceLanguage }).voiceLanguage).toBe("auto");
  });

  it("keeps the chosen speech recognition per device, auto until one is chosen", () => {
    expect(DEFAULT_SETTINGS.voiceEngine).toBe("auto");
    expect(SETTING_SCOPE.voiceEngine).toBe("device");
    for (const voiceEngine of VOICE_ENGINES) expect(sanitizeSettings({ voiceEngine }).voiceEngine).toBe(voiceEngine);
    for (const voiceEngine of [null, 1, "", "openai", "Browser"]) expect(sanitizeSettings({ voiceEngine }).voiceEngine).toBe("auto");
  });

  it("is asked for in the chat off a phone on auto, everywhere when on and nowhere when off", () => {
    expect(wantsVoiceInput("auto", "chat", false)).toBe(true);
    expect(wantsVoiceInput("auto", "chat", true)).toBe(false);
    expect(wantsVoiceInput("auto", "terminal", false)).toBe(false);
    for (const mode of ["chat", "terminal"] as const) {
      for (const phone of [false, true]) {
        expect(wantsVoiceInput("on", mode, phone)).toBe(true);
        expect(wantsVoiceInput("off", mode, phone)).toBe(false);
      }
    }
  });
});

describe("quick replies row", () => {
  it("stays hidden until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showQuickReplies).toBe(false);
    expect(sanitizeSettings({ showQuickReplies: true }).showQuickReplies).toBe(true);
    expect(sanitizeSettings({ showQuickReplies: "yes" }).showQuickReplies).toBe(false);
    expect(DEFAULT_SETTINGS.showUsage).toBe(false);
    expect(sanitizeSettings({ showUsage: true }).showUsage).toBe(true);
    expect(sanitizeSettings({ showUsage: 1 }).showUsage).toBe(false);
    expect(DEFAULT_SETTINGS.usageCount).toBe("left");
    expect(sanitizeSettings({ usageCount: "used" }).usageCount).toBe("used");
    expect(sanitizeSettings({ usageCount: "half" }).usageCount).toBe("left");
    expect(DEFAULT_SETTINGS.usageGlance).toBe("session");
    expect(sanitizeSettings({ usageGlance: "week" }).usageGlance).toBe("week");
    expect(sanitizeSettings({ usageGlance: "nearest" }).usageGlance).toBe("session");
    expect(sanitizeSettings({ usageOrder: ["codex:a", 3, "codex:a", "", "claude:b"] }).usageOrder).toEqual(["codex:a", "claude:b"]);
    expect(sanitizeSettings({ usageHidden: Array.from({ length: 100 }, (_, index) => `k${index}`) }).usageHidden).toHaveLength(64);
    expect(sanitizeSettings({ usageHidden: "codex:a" }).usageHidden).toEqual([]);
  });
});

describe("language", () => {
  it("keeps a listed language and loads a removed one (Turkish) as System", () => {
    expect(sanitizeSettings({ language: "ko" }).language).toBe("ko");
    expect(sanitizeSettings({ language: "tr" }).language).toBe("system");
  });
});

describe("palette", () => {
  it("defaults to codex, and reads a record from before palettes as amber, the look it had", () => {
    expect(DEFAULT_SETTINGS.palette).toBe("codex");
    // settings stored before palettes existed carry no palette key
    expect(sanitizeSettings({ theme: "light" }).palette).toBe("amber");
    expect(sanitizeSettings({ palette: "charcoal" }).palette).toBe("charcoal");
    expect(sanitizeSettings({ palette: "catppuccin" }).palette).toBe("catppuccin");
    expect(sanitizeSettings({ palette: "pink" }).palette).toBe("amber");
  });

  it("loads a removed palette (report, lilac, forest) as amber", () => {
    for (const removed of ["report", "lilac", "forest"]) expect(sanitizeSettings({ palette: removed }).palette).toBe("amber");
  });

  it("preserves Catppuccin through a saved settings round-trip and unrelated edits", () => {
    const saved = sanitizeSettings({ palette: "catppuccin", theme: "dark" });
    const reloaded = sanitizeSettings(JSON.parse(JSON.stringify(saved)));
    expect(reloaded.palette).toBe("catppuccin");
    expect(sanitizeSettings({ ...reloaded, theme: "light" }).palette).toBe("catppuccin");
  });

  // Every check below iterates the supported entries of src/lib/themes.generated.ts and reads each value from
  // src/styles.css through the theme parser, never from generated data, so a new theme is checked with no edit here.
  const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
  const legacy = new Set([...Object.keys(baseline.combos), "catppuccin-latte/light"]);
  const entries = SUPPORTED_ENTRIES.map(({ id, mode }) => ({ id, mode, key: `${id}/${mode}` }));
  /** Runs one entry's checks; an unreadable theme value becomes a failure naming entry and role, not a crash. */
  const checked = (failures: string[], check: () => void): void => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof ThemeValueError)) throw error;
      failures.push(error.message);
    }
  };

  it("checks exactly the theme entries src/styles.css declares", () => {
    expect(entries.map(({ key }) => key).sort()).toEqual(Object.keys(parseThemeBlocks(css)).sort());
  });

  it("gives every entry every theme role, declared in its own block for a new theme, with the mode's shadow geometry", () => {
    const failures: string[] = [];
    for (const { id, mode, key } of entries) {
      checked(failures, () => {
        const own = parseThemeBlocks(css)[key]?.declared ?? {};
        const { declared, resolved } = resolveEntry(css, id, mode);
        for (const [role, kind] of Object.entries(ROLES)) {
          if (resolved[`--${role}`] === undefined) failures.push(`${key} ${role}: missing`);
          // the legacy entries inherit from the amber blocks as they always did; a new theme falls through to nothing
          else if (!legacy.has(key) && own[`--${role}`] === undefined) failures.push(`${key} ${role}: not declared in its own block`);
          if (kind !== "shadow" || resolved[`--${role}`] === undefined) continue;
          // a whole-value alias names another shadow; any other target is not one
          let value = declared[`--${role}`] ?? "";
          for (let alias = /^var\((--[\w-]+)\)$/.exec(value); alias?.[1]; alias = /^var\((--[\w-]+)\)$/.exec(value)) value = declared[alias[1]] ?? "";
          const shadow = parseThemeValue(key, role, value);
          if (shadow.kind !== "shadow") throw new ThemeValueError(key, role, value, "not a shadow");
          const geometry = shadow.layers.map((layer) => layer.geometry);
          const fixed: readonly string[] = SHADOW_GEOMETRY[mode][role as keyof (typeof SHADOW_GEOMETRY)[typeof mode]];
          if (geometry.join(", ") !== fixed.join(", ")) failures.push(`${key} ${role}: geometry ${geometry.join(", ")} is not ${mode}'s ${fixed.join(", ")}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("parts every entry's control edges from its surfaces: --border differs from --bg-elevated, --bg-input and --border-strong", () => {
    // the herdr mapping sets --bg-elevated, --bg-input and --border from one token, which hid select wells and row
    // dividers; every legacy entry already differs, so no entry is excepted here
    const failures: string[] = [];
    for (const { id, mode, key } of entries) {
      checked(failures, () => {
        const { resolved } = resolveEntry(css, id, mode);
        for (const role of ["bg-elevated", "bg-input", "border-strong"]) {
          if (resolved[`--${role}`] === resolved["--border"]) failures.push(`${key} ${role}: equals --border ${resolved["--border"]}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  type Rgb = [number, number, number];
  const luminance = (rgb: Rgb): number => {
    const [r, g, b] = rgb.map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: Rgb, b: Rgb): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("shows every entry's chosen segment: --bg-hover parts from its track (--bg-elevated, --bg-input in Settings) or --text-strong from --text-dim", () => {
    // a segmented control fills the chosen option with --bg-hover on a track of --bg-elevated (--bg-input in Settings) and
    // writes its label in --text-strong beside --text-dim labels; the herdr mapping and the AA repair collapsed both pairs in
    // solarized-light, so no option looked chosen. The weakest pairs that still read set the floors: tokyo-night's label
    // 1.31:1 on a 1.03:1 fill, tokyo-night-day's fill 1.11:1 under a 1.00:1 label
    const failures: string[] = [];
    for (const { id, mode, key } of entries) {
      checked(failures, () => {
        const { resolved } = resolveEntry(css, id, mode);
        const hex = (role: string): Rgb => {
          const raw = resolved[`--${role}`] ?? "(missing)";
          const parsed = parseThemeValue(key, role, raw);
          const match = parsed.kind === "color" ? /^#([0-9a-f]{6})$/.exec(parsed.value) : null;
          if (!match?.[1]) throw new ThemeValueError(key, role, raw, "not an opaque color");
          return [0, 2, 4].map((i) => parseInt(match[1]!.slice(i, i + 2), 16)) as Rgb;
        };
        const fill = Math.min(ratio(hex("bg-hover"), hex("bg-elevated")), ratio(hex("bg-hover"), hex("bg-input")));
        const label = ratio(hex("text-strong"), hex("text-dim"));
        if (fill < 1.05 && label < 1.25) failures.push(`${key}: pressed fill ${fill.toFixed(2)}:1 on its track, pressed label ${label.toFixed(2)}:1 beside quiet labels`);
      });
    }
    expect(failures).toEqual([]);
  });

  it("mirrors every entry's --term-* tokens of styles.css for xterm and its --bg-panel for the title bar", () => {
    const failures: string[] = [];
    for (const { id, mode, key } of entries) {
      checked(failures, () => {
        const { resolved } = resolveEntry(css, id, mode);
        const expected = {
          background: resolved["--term-bg"], foreground: resolved["--term-fg"], cursor: resolved["--term-cursor"], selectionBackground: resolved["--term-selection"],
          ...(mode === "light" ? Object.fromEntries(Object.entries(LIGHT_ANSI_ROLES).map(([name, role]) => [name, resolved[`--${role}`]])) : {}),
        };
        let terminal: unknown;
        try {
          terminal = terminalTheme(mode, id as Parameters<typeof terminalTheme>[1]);
        } catch (error) {
          terminal = String(error);
        }
        if (JSON.stringify(terminal) !== JSON.stringify(expected)) failures.push(`${key} terminal: ${JSON.stringify(terminal)} is not ${JSON.stringify(expected)}`);
        if (tableThemeColor(id, mode) !== resolved["--bg-panel"]) failures.push(`${key} theme-color: ${tableThemeColor(id, mode)} is not ${resolved["--bg-panel"]}`);
      });
    }
    expect(failures).toEqual([]);
  });

  it("gives index.html and the web manifest the default theme's dark panel and page colors", () => {
    expect(DEFAULT_ID).toBe(DEFAULT_THEME);
    const { resolved } = resolveEntry(css, DEFAULT_THEME, "dark");
    const metas: string[] = [];
    new HTMLRewriter().on('meta[name="theme-color"]', { element: (meta) => void metas.push(meta.getAttribute("content") ?? "") })
      .transform(readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8"));
    expect(metas).toEqual([resolved["--bg-panel"]!]);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "public", "manifest.webmanifest"), "utf8"));
    expect({ theme_color: manifest.theme_color, background_color: manifest.background_color }).toEqual({ theme_color: resolved["--bg-panel"], background_color: resolved["--bg"] });
  });

  it("declares all sixteen readable ANSI colours only in light rows and passes them to xterm", () => {
    const failures: string[] = [];
    const blocks = parseThemeBlocks(css);
    const hex = (value: string): Rgb => {
      if (!/^#[0-9a-f]{6}$/.test(value)) throw new ThemeValueError("ANSI", "color", value, "not an opaque color");
      return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
    };
    expect(Object.keys(LIGHT_ANSI_ROLES)).toHaveLength(16);
    for (const { id, mode, key } of entries) {
      checked(failures, () => {
        const own = blocks[key]?.declared ?? {};
        const { resolved } = resolveEntry(blocks, id, mode);
        const terminal = terminalTheme(mode, id);
        for (const [name, role] of Object.entries(LIGHT_ANSI_ROLES)) {
          const token = `--${role}`;
          if (mode === "dark") {
            if (own[token] !== undefined || Object.hasOwn(terminal, name)) failures.push(`${key} ${role}: dark ANSI override`);
            continue;
          }
          if (own[token] === undefined) failures.push(`${key} ${role}: missing own declaration`);
          const value = resolved[token] ?? "(missing)";
          const contrast = ratio(hex(value), hex(resolved["--term-bg"] ?? "(missing)"));
          if (contrast < 4.5) failures.push(`${key} ${role}: ${contrast}:1 on term-bg`);
          if (Reflect.get(terminal, name) !== value) failures.push(`${key} ${role}: not passed to xterm`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("keeps text, agent states and code readable (WCAG AA 4.5:1) on every surface of every entry", () => {
    const over = ([rgb, alpha]: [Rgb, number], under: Rgb): Rgb => rgb.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
    const failures: string[] = [];
    for (const { id, mode, key } of entries) {
      checked(failures, () => {
        const { resolved } = resolveEntry(css, id, mode);
        // the committed value through the theme value parser: an unexpected form is named, never a null match
        const rgba = (role: string): [Rgb, number] => {
          const raw = resolved[`--${role}`] ?? "(missing)";
          const parsed = parseThemeValue(key, role, raw);
          const value = parsed.kind === "color" ? parsed.value : "";
          const hex = /^#([0-9a-f]{6})$/.exec(value);
          if (hex?.[1]) return [[0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb, 1];
          const parts = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value);
          if (!parts) throw new ThemeValueError(key, role, raw);
          return [[Number(parts[1]), Number(parts[2]), Number(parts[3])], Number(parts[4])];
        };
        const color = (role: string, under: Rgb = [0, 0, 0]): Rgb => over(rgba(role), under);
        // a field's placeholder is --text-dim on --bg-input (src/styles.css ::placeholder)
        const input = color("bg-input");
        if (ratio(color("text-dim", input), input) < 4.5) failures.push(`${key} placeholder (text-dim) on bg-input`);
        for (const surface of ["bg", "bg-panel", "bg-elevated", "bg-hover"]) {
          const ground = color(surface);
          for (const text of ["text", "text-dim"]) {
            if (ratio(color(text, ground), ground) < 4.5) failures.push(`${key} ${text} on ${surface}`);
          }
          // a status badge: its color on its tint, over a (hovered or selected) row
          for (const state of ["working", "blocked", "done"]) {
            const backdrop = over(rgba(`status-${state}-tint`), ground);
            if (ratio(color(`status-${state}`, backdrop), backdrop) < 4.5) failures.push(`${key} ${state} badge on ${surface}`);
          }
        }
        // a primary control's label on its own fill (.btn-primary)
        const fill = color("primary");
        if (ratio(color("primary-text", fill), fill) < 4.5) failures.push(`${key} primary-text on primary`);
        // highlighted code sits on the panel (a file preview) or an elevated card (a chat code block)
        for (const surface of ["bg-panel", "bg-elevated"]) {
          const ground = color(surface);
          for (const token of ["function", "keyword", "string", "number", "type", "variable", "meta"]) {
            if (ratio(color(`syntax-${token}`, ground), ground) < 4.5) failures.push(`${key} syntax-${token} on ${surface}`);
          }
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("paints amber before settings load: the base blocks are the default palette's", () => {
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    expect(root).toContain(`--term-bg: ${terminalTheme("dark").background};`);
    expect(root).toContain(`--term-cursor: ${terminalTheme("dark").cursor};`);
    expect(terminalTheme("dark")).toEqual(terminalTheme("dark", "amber"));
  });
});

describe("agent marks", () => {
  it("drops the icon choice 0.3.36 stored, so every pane shows its provider logo", () => {
    const settings = sanitizeSettings({ claudeMark: "mascot", codexMark: "app" });
    expect(settings).not.toHaveProperty("claudeMark");
    expect(settings).not.toHaveProperty("codexMark");
  });
});

it("sanitizes input modes and shortcut overrides without accepting arbitrary commands", () => {
  expect(sanitizeSettings({ terminalInputMode: "bad" }).terminalInputMode).toBe("auto");
  expect(sanitizeSettings({ terminalInputMode: "line" }).terminalInputMode).toBe("line");
  expect(sanitizeSettings({ shortcutOverrides: { palette: "p", settings: null, voice: "x", unknown: "x", "next-pane": "rm -rf" } }).shortcutOverrides).toEqual({ palette: "p", settings: null });
});

it("resets Theme to the theme a fresh device starts on, so Reset never shows on a fresh device or turns a light OS dark", () => {
  const fresh = storedAppearance(readStoredAppearance(() => ({ getItem: () => null })));
  expect(DEFAULT_SETTINGS.theme).toBe(fresh.theme);
});

describe("key bar settings", () => {
  it("uses the new default for fresh partial records and migrates explicit legacy records", () => {
    expect(DEFAULT_SETTINGS.keyBarItems).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeSettings({}).keyBarItems).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeSettings({ theme: "light" }).keyBarItems).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeSettings({ keyBarExtras: ["alt"] }).keyBarItems).toEqual(migrateKeyBarItems(["alt"]));
    expect(sanitizeSettings({ keyBarExtras: ["home-end", "slash", "unknown"] }).keyBarItems).toEqual(migrateKeyBarItems(["home-end", "slash"]));
    expect(sanitizeSettings({ keyBarExtras: [], keyBarItems: [] }).keyBarItems).toEqual([]);
    expect(sanitizeSettings({ keyBarExtras: ["alt"], keyBarItems: [] }).keyBarItems).toEqual([]);
    expect(sanitizeSettings({ keyBarExtras: [], keyBarItems: "bad" }).keyBarItems).toEqual(migrateKeyBarItems([]));
  });

  it("preserves a custom chord and new order through a saved settings round-trip and unrelated edits", () => {
    const settings = sanitizeSettings({ keyBarExtras: ["alt"], keyBarItems: [
      { type: "key", key: "ArrowLeft", modifiers: { ctrl: true, alt: true, shift: false } },
      { type: "modifier", modifier: "shift" }, { type: "key", key: "Enter" },
    ] });
    const reloaded = sanitizeSettings(JSON.parse(JSON.stringify(settings)));
    expect(reloaded.keyBarItems).toEqual(settings.keyBarItems);
    expect(sanitizeSettings({ ...reloaded, theme: "light" }).keyBarItems).toEqual(settings.keyBarItems);
    expect(settings.keyBarItems.map((item) => item.type === "modifier" ? item.modifier : item.key)).toEqual(["ArrowLeft", "shift", "Enter"]);
  });
});

describe("default lens", () => {
  it("keeps only a known choice, auto by default", () => {
    expect(DEFAULT_SETTINGS.defaultView).toBe("auto");
    expect(sanitizeSettings({ defaultView: "chat" }).defaultView).toBe("chat");
    expect(sanitizeSettings({ defaultView: "split" }).defaultView).toBe("auto");
  });
  it("forgets every pane's own lens and nothing else", () => {
    const data = new Map<string, string>([["ovis:view:local:w1:p1", "terminal"], ["ovis:view:remote:pc:w2:p1", "chat"], ["ovis:settings", "{}"]]);
    const storage = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (k: string) => { data.delete(k); } };
    expect(forgetPaneViews(storage)).toBe(2);
    expect([...data.keys()]).toEqual(["ovis:settings"]);
  });
});

it("keeps the file viewer's wrap setting only when it is a boolean", () => {
  expect(DEFAULT_SETTINGS.wrapCode).toBe(false);
  expect(sanitizeSettings({ wrapCode: true }).wrapCode).toBe(true);
  expect(sanitizeSettings({ wrapCode: "yes" }).wrapCode).toBe(false);
});

it("keeps where web links open to a tab or the panel, a tab by default", () => {
  expect(DEFAULT_SETTINGS.webLinks).toBe("tab");
  expect(DEFAULT_SETTINGS.reuseExternalLinkTab).toBe(false);
  expect(DEFAULT_SETTINGS.fileOpen).toBe("popup");
  // Files beside the pane is opt-in: the dialog stays the default
  expect(DEFAULT_SETTINGS.filesPanel).toBe(false);
  expect(sanitizeSettings({ filesPanel: true }).filesPanel).toBe(true);
  for (const bad of ["true", 1, null]) expect(sanitizeSettings({ filesPanel: bad }).filesPanel).toBe(false);
  expect(sanitizeSettings({ fileOpen: "panel" }).fileOpen).toBe("panel");
  for (const bad of ["tab", "", null, true]) expect(sanitizeSettings({ fileOpen: bad }).fileOpen).toBe("popup");
  expect(sanitizeSettings({ webLinks: "panel" }).webLinks).toBe("panel");
  for (const bad of ["popup", "", null, true]) expect(sanitizeSettings({ webLinks: bad }).webLinks).toBe("tab");
  expect(sanitizeSettings({ reuseExternalLinkTab: true }).reuseExternalLinkTab).toBe(true);
  for (const bad of ["true", 1, null]) expect(sanitizeSettings({ reuseExternalLinkTab: bad }).reuseExternalLinkTab).toBe(false);
  // an agent's start mode never widens by accident: anything unknown starts it with no flag
  expect(DEFAULT_SETTINGS.claudeLaunchMode).toBe("default");
  expect(DEFAULT_SETTINGS.codexLaunchMode).toBe("default");
  expect(sanitizeSettings({ claudeLaunchMode: "plan", codexLaunchMode: "readOnly" })).toMatchObject({ claudeLaunchMode: "plan", codexLaunchMode: "readOnly" });
  for (const bad of ["bypass", "BypassPermissions", "full-access", "", null, 1, ["auto"]]) {
    expect(sanitizeSettings({ claudeLaunchMode: bad }).claudeLaunchMode).toBe("default");
    expect(sanitizeSettings({ codexLaunchMode: bad }).codexLaunchMode).toBe("default");
  }
  // a new agent's model and effort: none set starts it on its own, and only what its launch takes is kept
  expect(DEFAULT_SETTINGS).toMatchObject({ claudeLaunchModel: "", claudeLaunchEffort: "", codexLaunchModel: "", codexLaunchEffort: "" });
  expect(sanitizeSettings({ claudeLaunchModel: "opus", claudeLaunchEffort: "max", codexLaunchModel: "gpt-5-codex", codexLaunchEffort: "ultra" }))
    .toMatchObject({ claudeLaunchModel: "opus", claudeLaunchEffort: "max", codexLaunchModel: "gpt-5-codex", codexLaunchEffort: "ultra" });
  for (const bad of ["opus --verbose", "-p", " ", 1, null, ["opus"]]) {
    expect(sanitizeSettings({ claudeLaunchModel: bad }).claudeLaunchModel).toBe("");
    expect(sanitizeSettings({ codexLaunchModel: bad }).codexLaunchModel).toBe("");
  }
  for (const bad of ["ultra", "ultracode", "High", "", null, 3]) expect(sanitizeSettings({ claudeLaunchEffort: bad }).claudeLaunchEffort).toBe("");
  for (const bad of ["minimal", "High", null]) expect(sanitizeSettings({ codexLaunchEffort: bad }).codexLaunchEffort).toBe("");
});

describe("shared settings", () => {
  it("shares exactly the settings SETTING_SCOPE marks shared", () => {
    const shared = Object.entries(SETTING_SCOPE).filter(([, scope]) => scope === "shared").map(([key]) => key).sort();
    expect([...SHARED_SETTING_KEYS].sort() as string[]).toEqual(shared);
    expect(Object.keys(SETTING_SCOPE).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("locks no agent until one is locked, and keeps only distinct pin keys (#2432)", () => {
    expect(DEFAULT_SETTINGS.agentLocks).toBe(false);
    expect(SETTING_SCOPE.agentLocks).toBe("shared");
    expect(DEFAULT_SETTINGS.lockedAgents).toEqual([]);
    expect(SETTING_SCOPE.lockedAgents).toBe("shared");
    expect(sanitizeSettings({ lockedAgents: ["local:p1", 3, "", "local:p1", "pc:w1:p2"] }).lockedAgents).toEqual(["local:p1", "pc:w1:p2"]);
    expect(sanitizeSettings({ lockedAgents: "local:p1" }).lockedAgents).toEqual([]);
  });

  it("draws no named agent group until one is turned on, shared by every browser (#2431)", () => {
    expect(DEFAULT_SETTINGS.agentNamedGroups).toBe(false);
    for (const key of ["agentNamedGroups", "agentGroupNames", "agentGroupOf"] as const) expect(SETTING_SCOPE[key]).toBe("shared");
    const kept = sanitizeSettings({ agentNamedGroups: true, agentGroupNames: ["Tasks", "", "Tasks"], agentGroupOf: { "local:p1": "Tasks", "local:p2": 1 } });
    expect([kept.agentNamedGroups, kept.agentGroupNames, kept.agentGroupOf]).toEqual([true, ["Tasks"], { "local:p1": "Tasks" }]);
  });
});

