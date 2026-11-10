/**
 * The saved appearance without React: the one reading of the two stored records that both the
 * page's boot script (src/theme-bootstrap.ts, run before the first paint) and loadSettings use, so
 * the theme the page is first drawn in is the one the app goes on drawing.
 */
import { shellMode } from "./shellMode.ts";
import { INDICATOR_ROLES, LIGHT_ANSI_ROLES, ROLES } from "./themeRoles.ts";
import { DEFAULT_THEME, isThemeId, type DrawnTheme, type Mode, type ThemeId } from "./themes.ts";
import { themeFor } from "./themeFor.ts";

export type ThemeSetting = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

/** The part of the settings that picks the row the page is drawn in. */
export interface Appearance {
  theme: ThemeSetting;
  darkTheme: ThemeId;
  lightTheme: ThemeId;
}

export const SETTINGS_STORAGE_KEY = "ovis:settings";
/** The theme choice kept apart from the main record, so a damaged main record does not lose it. */
export const THEMES_STORAGE_KEY = "ovis:themes";

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", darkTheme: DEFAULT_THEME, lightTheme: DEFAULT_THEME };

/** In the hosted shell build only, a first visit with no saved theme follows prefers-color-scheme (system). */
export function defaultThemeSetting(): ThemeSetting {
  return shellMode() === "relay" ? "system" : DEFAULT_APPEARANCE.theme;
}

/** The appearance of a stored record, with the migration of the records from before the two theme sides. */
export function sanitizeAppearance(raw: unknown): Appearance {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // A record without a theme choice: one that carries a palette is from the dark-only app (every
  // record saved since has its theme), so it stays dark; anything else is a fresh device, on the OS scheme.
  const beforeThemes = "palette" in record || "paletteDark" in record || "paletteLight" in record;
  const theme = record["theme"] === "dark" || record["theme"] === "light" || record["theme"] === "system" ? record["theme"] : beforeThemes ? "dark" : defaultThemeSetting();
  const palette = isThemeId(record["palette"]) ? record["palette"] : "amber";
  // Absence migrates (a record from before themes wore amber, so it keeps amber); an explicitly
  // unknown id falls back to the default, not a stale pair.
  const darkTheme = "darkTheme" in record
    ? (isThemeId(record["darkTheme"]) ? record["darkTheme"] : DEFAULT_THEME)
    : theme === "dark" ? palette : isThemeId(record["paletteDark"]) ? record["paletteDark"] : theme === "system" && record["paletteDark"] !== undefined ? "amber" : palette;
  const lightTheme = "lightTheme" in record
    ? (isThemeId(record["lightTheme"]) ? record["lightTheme"] : DEFAULT_THEME)
    : theme === "light" ? palette : isThemeId(record["paletteLight"]) ? record["paletteLight"] : theme === "system" && record["paletteLight"] !== undefined ? "amber" : palette;
  return { theme, darkTheme, lightTheme };
}

/** The two records as stored: each read on its own, a missing, damaged or unreadable one left out. */
export interface StoredAppearance {
  /** the parsed main record, when there is one that parses */
  main: { value: unknown } | null;
  /** the protected theme sides, when that record parses and holds both */
  themes: { darkTheme: unknown; lightTheme: unknown } | null;
}

/** Reads both records; `storage` is a getter because reading localStorage itself throws where storage is blocked. */
export function readStoredAppearance(storage: () => Pick<Storage, "getItem">): StoredAppearance {
  const stored: StoredAppearance = { main: { value: DEFAULT_APPEARANCE }, themes: null };
  try {
    const raw = storage().getItem(SETTINGS_STORAGE_KEY);
    if (raw !== null) stored.main = { value: JSON.parse(raw) };
  } catch {
    /* a damaged main record does not hide the protected theme choice */
  }
  try {
    const raw = storage().getItem(THEMES_STORAGE_KEY);
    const themes: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof themes === "object" && themes !== null && "darkTheme" in themes && "lightTheme" in themes) {
      stored.themes = { darkTheme: themes.darkTheme, lightTheme: themes.lightTheme };
    }
  } catch { /* denied or damaged storage: keep the main record */ }
  return stored;
}

/** The appearance the records hold: the main record's (or the default), with the protected sides over it. */
export function storedAppearance(stored: StoredAppearance): Appearance {
  const main = stored.main === null ? { ...DEFAULT_APPEARANCE, theme: defaultThemeSetting() } : sanitizeAppearance(stored.main.value);
  return stored.themes === null ? main : sanitizeAppearance({ ...main, ...stored.themes });
}

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "system") return setting;
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

/**
 * The imported themes and the one chosen for either side (customThemes.ts), in a key of their own:
 * an older tab of this browser saving the whole main record does not drop them.
 */
export const CUSTOM_THEMES_STORAGE_KEY = "ovis:custom-themes";

/**
 * The rows of the imported themes chosen for either side (customThemes.ts), as the app last
 * derived them: the boot script draws a saved one from here, so it carries no derivation and a
 * cold launch still opens in the imported colours.
 */
export const CUSTOM_ROWS_STORAGE_KEY = "ovis:custom-theme-rows";

/** The custom properties a row may set on the document: every role, the notice tint, the state colours and a light row's ANSI colours. */
export const THEME_VARS: readonly string[] = [...Object.keys(ROLES), "notice-tint", ...INDICATOR_ROLES, ...Object.values(LIGHT_ANSI_ROLES)];

/** A stored colour or shadow as the derivation writes them: hex, rgba(), lengths and var(--border), and nothing that fetches. */
const SAFE_VALUE = /^[#a-z0-9(),.\s-]{1,120}$/i;
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);

/** A stored row as the app wrote it; null for anything else, which the built-in theme then stands in for. */
function storedRow(value: unknown, id: string): DrawnTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const { vars, terminal, preview } = row as { vars?: unknown; terminal?: unknown; preview?: unknown };
  if (row["id"] !== id || (row["mode"] !== "dark" && row["mode"] !== "light") || !isColor(row["bg"]) || !isColor(row["bgPanel"])) return null;
  if (typeof vars !== "object" || vars === null || typeof terminal !== "object" || terminal === null || typeof preview !== "object" || preview === null) return null;
  const names = Object.keys(vars);
  if (!names.every((name) => THEME_VARS.includes(name)) || !Object.values(vars).every((entry) => typeof entry === "string" && SAFE_VALUE.test(entry) && !/url/i.test(entry))) return null;
  if (!Object.values(terminal).every(isColor) || !Object.values(preview).every(isColor)) return null;
  return value as DrawnTheme;
}

/** The imported theme the stored list draws on `side`, as the id its row is stored under; null when that side draws a built-in theme. */
function customChoice(storage: () => Pick<Storage, "getItem">, side: Mode): string | null {
  try {
    const custom: unknown = JSON.parse(storage().getItem(CUSTOM_THEMES_STORAGE_KEY) ?? "null");
    const id = typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>)[side] : null;
    return typeof id === "string" && /^[0-9a-f]{8}$/.test(id) ? `custom:${id}` : null;
  } catch {
    return null;
  }
}

/** The row the saved appearance draws now. */
export function savedThemeEntry(storage: () => Pick<Storage, "getItem">): DrawnTheme {
  const stored = readStoredAppearance(storage);
  const appearance = storedAppearance(stored);
  const side = resolveTheme(appearance.theme);
  const custom = customChoice(storage, side);
  if (custom !== null) {
    try {
      const rows: unknown = JSON.parse(storage().getItem(CUSTOM_ROWS_STORAGE_KEY) ?? "null");
      const row = typeof rows === "object" && rows !== null ? storedRow((rows as Record<string, unknown>)[side], custom) : null;
      if (row) return row;
    } catch { /* denied or damaged storage: the side's built-in theme */ }
  }
  return themeFor(appearance, side);
}

/** Puts a row on the document: the attributes src/styles.css keys its tokens on, an imported row's own colours, and the browser's own colors. */
export function applyThemeEntry(root: HTMLElement, entry: DrawnTheme): void {
  root.dataset["theme"] = entry.mode;
  // an imported row has no block in the stylesheet: its side's base block is under the colours it sets itself
  root.dataset["palette"] = entry.vars === undefined ? entry.id : "custom";
  root.style.colorScheme = entry.mode;
  for (const name of THEME_VARS) {
    const value = entry.vars?.[name];
    if (value === undefined) root.style.removeProperty(`--${name}`);
    else root.style.setProperty(`--${name}`, value);
  }
  // `<meta name="theme-color">` follows the panel surface so the PWA title bar matches
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", entry.bgPanel);
}
