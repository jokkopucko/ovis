import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, loadSettings, resolveTheme, sanitizeSettings } from "./settings.ts";
import { applyThemeEntry, CUSTOM_ROWS_STORAGE_KEY, CUSTOM_THEMES_STORAGE_KEY, DEFAULT_APPEARANCE, readStoredAppearance, savedThemeEntry, SETTINGS_STORAGE_KEY, storedAppearance, THEME_VARS, THEMES_STORAGE_KEY } from "./themeBoot.ts";
import { bootRows, customRow, drawnTheme, NO_CUSTOM_THEMES, readThemeFile, withTheme, type CustomTheme } from "./customThemes.ts";
import { themeFor } from "./themeFor.ts";
import { rowFor, SUPPORTED_ENTRIES, THEME_IDS, type DrawnTheme } from "./themes.ts";

// The page's boot script and the app read the same two records; whatever they hold, both must draw
// the same row, or the first frame is not the one the app goes on showing.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let records: Map<string, string>;
let systemDark: boolean;
let blocked: boolean;

beforeEach(() => {
  records = new Map();
  systemDark = true;
  blocked = false;
  const storage = { getItem: (key: string) => records.get(key) ?? null };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get localStorage() {
      if (blocked) throw new DOMException("The operation is insecure.", "SecurityError");
      return storage;
    },
    matchMedia: () => ({ matches: systemDark }),
  } });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

/** The row the page's boot script draws. */
const boot = (): DrawnTheme => savedThemeEntry(() => window.localStorage);
/** The row the app draws on its first render (SettingsProvider). */
const app = (): DrawnTheme => {
  const settings = loadSettings();
  return drawnTheme(settings, resolveTheme(settings.theme));
};
const store = (main: string | object | null, themes: string | object | null): void => {
  records.clear();
  if (main !== null) records.set(SETTINGS_STORAGE_KEY, typeof main === "string" ? main : JSON.stringify(main));
  if (themes !== null) records.set(THEMES_STORAGE_KEY, typeof themes === "string" ? themes : JSON.stringify(themes));
};

const MAINS: (string | object | null)[] = [
  null, "{not json", "null", "42", "[]", "{}",
  { theme: "dark" }, { theme: "light" }, { theme: "system" }, { theme: "sepia", darkTheme: "nord" },
  { theme: "light", darkTheme: "codex", lightTheme: "one-light" },
  { theme: "dark", darkTheme: "nope", lightTheme: 7 },
  { theme: "light", lightTheme: "dracula" },
  { theme: "dark", darkTheme: "solarized-light" },
  { theme: "system", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" },
  { theme: "light", palette: "catppuccin" },
  { theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" },
  { theme: "system", palette: "report", paletteLight: "lilac", paletteDark: "forest" },
  { theme: "dark", palette: "catppuccin", paletteDark: "charcoal" },
  { palette: "charcoal", paletteLight: "pink" },
];
const THEMES: (string | object | null)[] = [
  null, "{not json", "null", "[]", { darkTheme: "gruvbox" },
  { darkTheme: "gruvbox", lightTheme: "gruvbox-light" },
  { darkTheme: "nope", lightTheme: "dracula" },
  { darkTheme: "one-light", lightTheme: 3, mirror: { palette: "amber" } },
];

describe("theme boot", () => {
  test("boot and settings resolve the same complete row", () => {
    let compared = 0;
    for (const main of MAINS) {
      for (const themes of THEMES) {
        for (const dark of [true, false]) {
          store(main, themes);
          systemDark = dark;
          const label = JSON.stringify({ main, themes, dark });
          // the very same row: mode, palette, surfaces and terminal colors together
          expect(boot(), label).toBe(app());
          const settings = loadSettings();
          expect(storedAppearance(readStoredAppearance(() => window.localStorage)), label)
            .toEqual({ theme: settings.theme, darkTheme: settings.darkTheme, lightTheme: settings.lightTheme });
          compared++;
        }
      }
    }
    expect(compared).toBe(MAINS.length * THEMES.length * 2);
    // every row a pick can draw
    for (const entry of SUPPORTED_ENTRIES) {
      for (const theme of ["dark", "light"] as const) {
        store({ theme, darkTheme: entry.id, lightTheme: entry.id }, null);
        expect(boot()).toBe(app());
        expect(boot()).toBe(rowFor(entry.id, theme));
      }
    }
  });

  test("protected themes survive a corrupt main record", () => {
    store("{not json", { darkTheme: "gruvbox", lightTheme: "gruvbox-light" });
    expect(boot()).toBe(rowFor("gruvbox", "dark"));
    expect(boot()).toBe(app());
    // and they win over a readable main record's own sides
    store({ theme: "light", darkTheme: "codex", lightTheme: "codex" }, { darkTheme: "nord", lightTheme: "solarized-light" });
    expect(boot()).toBe(rowFor("solarized-light", "light"));
    expect(boot()).toBe(app());
    // a damaged protected record leaves the main record's choice
    store({ theme: "light", lightTheme: "one-light" }, "{not json");
    expect(boot()).toBe(rowFor("one-light", "light"));
    expect(boot()).toBe(app());
  });

  test("legacy palette migration is identical at boot", () => {
    const cases = [
      [{ theme: "light", palette: "catppuccin" }, rowFor("catppuccin", "light")],
      [{ theme: "dark", palette: "catppuccin" }, rowFor("catppuccin", "dark")],
      [{ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, null],
      [{ theme: "system", palette: "report", paletteLight: "lilac", paletteDark: "forest" }, null],
      [{ theme: "dark", palette: "amber", paletteDark: "charcoal" }, rowFor("amber", "dark")],
      [{}, null],
    ] as const;
    for (const [record, expected] of cases) {
      for (const dark of [true, false]) {
        store(record, null);
        systemDark = dark;
        const settings = sanitizeSettings(record);
        expect(boot(), JSON.stringify(record)).toBe(themeFor(settings, resolveTheme(settings.theme)));
        expect(boot()).toBe(app());
        if (expected !== null) expect(boot()).toBe(expected);
      }
    }
    store({ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, null);
    systemDark = false;
    expect(boot()).toBe(rowFor("catppuccin", "light"));
    systemDark = true;
    expect(boot()).toBe(rowFor("charcoal", "dark"));
  });

  test("single-mode themes retain their actual mode", () => {
    store({ theme: "light", lightTheme: "dracula" }, null);
    expect(boot()).toBe(rowFor("dracula", "dark"));
    expect(boot().mode).toBe("dark");
    expect(boot()).toBe(app());
    store({ theme: "light", darkTheme: "codex", lightTheme: "codex" }, { darkTheme: "codex", lightTheme: "nord" });
    expect(boot().mode).toBe("dark");
    expect(boot().id).toBe("nord");
    expect(boot()).toBe(app());
    store({ theme: "dark", darkTheme: "solarized-light" }, null);
    expect(boot()).toBe(rowFor("solarized-light", "light"));
    expect(boot().mode).toBe("light");
    expect(boot()).toBe(app());
    for (const id of THEME_IDS) {
      const rows = SUPPORTED_ENTRIES.filter((entry) => entry.id === id);
      if (rows.length !== 1) continue;
      for (const theme of ["dark", "light"] as const) {
        store({ theme, darkTheme: id, lightTheme: id }, null);
        expect(boot(), `${id} on ${theme}`).toBe(rows[0]!);
      }
    }
  });

  test("blocked storage uses the normal default", () => {
    store({ theme: "light", lightTheme: "one-light" }, { darkTheme: "nord", lightTheme: "one-light" });
    blocked = true;
    expect(() => window.localStorage).toThrow("insecure");
    expect(readStoredAppearance(() => window.localStorage)).toEqual({ main: { value: DEFAULT_APPEARANCE }, themes: null });
    expect(boot()).toBe(themeFor(DEFAULT_APPEARANCE, resolveTheme(DEFAULT_APPEARANCE.theme)));
    expect(boot()).toBe(app());
    expect(DEFAULT_APPEARANCE).toEqual({ theme: "system", darkTheme: DEFAULT_SETTINGS.darkTheme, lightTheme: DEFAULT_SETTINGS.lightTheme });
    // nothing stored at all is the same default, following the OS scheme
    blocked = false;
    store(null, null);
    systemDark = false;
    expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.lightTheme, "light"));
    expect(boot()).toBe(app());
    systemDark = true;
    expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.darkTheme, "dark"));
    expect(boot()).toBe(app());
  });

  test("hosted shell build defaults to system prefers-color-scheme when no appearance is saved, while saved settings and the main app keep their defaults", () => {
    const origDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const setShellMeta = (shell: boolean) => {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          querySelector: (sel: string) =>
            sel === 'meta[name="ovis-shell"]' && shell ? { getAttribute: (n: string) => (n === "content" ? "relay" : null) } : null,
        },
      });
    };
    try {
      // In the hosted shell with no saved settings: follows prefers-color-scheme (system)
      setShellMeta(true);
      store(null, null);
      systemDark = false;
      expect(storedAppearance(readStoredAppearance(() => window.localStorage))).toEqual({
        theme: "system",
        darkTheme: DEFAULT_SETTINGS.darkTheme,
        lightTheme: DEFAULT_SETTINGS.lightTheme,
      });
      expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.lightTheme, "light"));
      // the settings SettingsProvider starts from keep following the system, as the first frame did
      expect(loadSettings().theme).toBe("system");
      expect(app()).toBe(boot());

      systemDark = true;
      expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.darkTheme, "dark"));

      // A saved record with darkTheme/lightTheme but no explicit theme field in shell mode still defaults theme to system
      store({ darkTheme: "amber", lightTheme: "amber" }, null);
      systemDark = false;
      expect(boot()).toBe(rowFor("amber", "light"));
      expect(boot()).toBe(app());

      // A saved explicit theme setting always wins in the hosted shell
      store({ theme: "dark", darkTheme: "codex", lightTheme: "codex" }, null);
      systemDark = false;
      expect(boot()).toBe(rowFor("codex", "dark"));
      expect(boot()).toBe(app());

      store({ theme: "light", darkTheme: "codex", lightTheme: "codex" }, null);
      systemDark = true;
      expect(boot()).toBe(rowFor("codex", "light"));
      expect(boot()).toBe(app());

      // Main Ovis app (no ovis-shell meta): a fresh device follows the OS scheme too
      setShellMeta(false);
      store(null, null);
      systemDark = false;
      expect(storedAppearance(readStoredAppearance(() => window.localStorage)).theme).toBe("system");
      expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.lightTheme, "light"));
      expect(boot()).toBe(app());
    } finally {
      if (origDoc) Object.defineProperty(globalThis, "document", origDoc);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("a record without a theme choice: a dark-only app's palette stays dark, a fresh device follows the OS", () => {
    systemDark = false;
    for (const record of [{ palette: "charcoal" }, { palette: "charcoal", paletteLight: "pink" }, { palette: "nope", paletteDark: "nord" }]) {
      store(record, null);
      expect(sanitizeSettings(record).theme, JSON.stringify(record)).toBe("dark");
      expect(boot().mode, JSON.stringify(record)).toBe("dark");
      expect(boot()).toBe(app());
    }
    expect(sanitizeSettings({ palette: "charcoal", paletteLight: "pink" }).lightTheme).toBe("charcoal");
    for (const record of [{}, { language: "en" }, { darkTheme: "nord", lightTheme: "one-light" }]) {
      store(record, null);
      expect(sanitizeSettings(record).theme, JSON.stringify(record)).toBe("system");
      expect(boot().mode, JSON.stringify(record)).toBe("light");
      expect(boot()).toBe(app());
    }
  });
});

describe("an imported theme at the first frame", () => {
  const read = readThemeFile(JSON.stringify({ name: "Night", dark: { base00: "#101418", base01: "#182028", base02: "#202a34", base05: "#d0d8e0", base0D: "#6aa8e0" } }));
  const theme: CustomTheme = "theme" in read ? read.theme : (() => { throw new Error("the fixture is no theme"); })();
  const custom = withTheme(NO_CUSTOM_THEMES, theme, "dark")!;
  const rows = (value: unknown): void => { records.set(CUSTOM_ROWS_STORAGE_KEY, typeof value === "string" ? value : JSON.stringify(value)); };
  /** The main record and, in its own key, the imported themes. */
  const storeWith = (main: object, list: unknown): void => {
    store(main, null);
    records.set(CUSTOM_THEMES_STORAGE_KEY, typeof list === "string" ? list : JSON.stringify(list));
  };

  test("the boot script draws the row the app stored: the one the app goes on drawing", () => {
    storeWith({ theme: "dark", darkTheme: "nord" }, custom);
    // a device that has not derived it yet (the list came from the PC): the built-in theme under it, for that launch
    expect(boot()).toBe(rowFor("nord", "dark"));
    expect(app()).toBe(customRow(theme, "dark"));
    rows(bootRows(custom));
    expect(boot()).toEqual(app());
    // the side that draws no imported theme is the built-in one's, with or without the stored row
    storeWith({ theme: "light", darkTheme: "nord", lightTheme: "one-light" }, custom);
    rows(bootRows(custom));
    expect(boot()).toBe(rowFor("one-light", "light"));
    expect(boot()).toBe(app());
  });

  test("a stored row that is another theme's, damaged, or more than colours is left for the built-in theme", () => {
    const row = customRow(theme, "dark");
    const unsafe: unknown[] = [
      "{not json", "null", "[]", {}, { dark: null }, { dark: 7 }, { light: row },
      { dark: { ...row, id: "custom:00000000" } },
      { dark: { ...row, mode: "sepia" } },
      { dark: { ...row, bg: "red" } },
      { dark: { ...row, vars: { ...row.vars, bg: "url(https://example.com/x.png)" } } },
      { dark: { ...row, vars: { ...row.vars, bg: "URL(x)" } } },
      { dark: { ...row, vars: { ...row.vars, bg: "#000; background: red" } } },
      { dark: { ...row, vars: { ...row.vars, bg: "x".repeat(121) } } },
      { dark: { ...row, vars: { ...row.vars, bg: 7 } } },
      { dark: { ...row, vars: { ...row.vars, "font-family": "#000000" } } },
      { dark: { ...row, vars: null } },
      { dark: { ...row, terminal: { ...row.terminal, background: "javascript:1" } } },
      { dark: { ...row, preview: { ...row.preview, accent: "expression(1)" } } },
    ];
    for (const value of unsafe) {
      storeWith({ theme: "dark", darkTheme: "nord" }, custom);
      rows(value);
      expect(boot(), JSON.stringify(value)).toBe(rowFor("nord", "dark"));
    }
    // a choice the stored list does not hold as an id draws nothing imported, nor does a damaged list
    for (const dark of [7, "x", "custom:1", null]) {
      storeWith({ theme: "dark", darkTheme: "nord" }, { themes: [theme], dark, light: null });
      rows(bootRows(custom));
      expect(boot(), String(dark)).toBe(rowFor("nord", "dark"));
      expect(boot()).toBe(app());
    }
    for (const list of ["{not json", "null", "[]", "7"]) {
      storeWith({ theme: "dark", darkTheme: "nord" }, list);
      rows(bootRows(custom));
      expect(boot(), list).toBe(rowFor("nord", "dark"));
      expect(boot()).toBe(app());
    }
    // the list in the main record, where an earlier build never wrote it, is not read
    store({ theme: "dark", darkTheme: "nord", customThemes: custom }, null);
    rows(bootRows(custom));
    expect(boot()).toBe(rowFor("nord", "dark"));
    expect(boot()).toBe(app());
  });

  test("an imported row's colours go on the document, and leave it for a built-in row", () => {
    const props = new Map<string, string>();
    const root = { dataset: {} as Record<string, string>, style: { colorScheme: "", setProperty: (name: string, value: string) => { props.set(name, value); }, removeProperty: (name: string) => { props.delete(name); } } };
    let meta = "";
    const origDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ setAttribute: (_name: string, value: string) => { meta = value; } }) } });
    try {
      // a property the app sets itself is not the theme's to remove
      props.set("--ui-scale", "1");
      const row = customRow(theme, "dark");
      applyThemeEntry(root as unknown as HTMLElement, row);
      expect(root.dataset).toEqual({ theme: "dark", palette: "custom" });
      expect(root.style.colorScheme).toBe("dark");
      expect(meta).toBe(row.bgPanel);
      expect(props.get("--bg")).toBe("#101418");
      expect(props.get("--text")).toBe("#d0d8e0");
      expect([...props.keys()].filter((name) => name !== "--ui-scale").sort()).toEqual(Object.keys(row.vars!).map((name) => `--${name}`).sort());
      expect(Object.keys(row.vars!).every((name) => THEME_VARS.includes(name))).toBe(true);

      const nord = rowFor("nord", "dark");
      applyThemeEntry(root as unknown as HTMLElement, nord);
      expect(root.dataset).toEqual({ theme: "dark", palette: "nord" });
      expect([...props.keys()]).toEqual(["--ui-scale"]);
      expect(meta).toBe(nord.bgPanel);
    } finally {
      if (origDoc) Object.defineProperty(globalThis, "document", origDoc);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
