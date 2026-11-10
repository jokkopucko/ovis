/** The authored theme role contract. Theme values live only in src/styles.css. */
import { SUPPORTED_ENTRIES, THEME_IDS } from "./themes.generated.ts";
import type { ThemeId } from "./themes.generated.ts";
import type { LIGHT_ANSI_ROLES } from "./themeRoles.ts";

export { SUPPORTED_ENTRIES, THEME_IDS };
export { ROLES, SHADOW_GEOMETRY } from "./themeRoles.ts";
export type { ThemeId };

export type Mode = "dark" | "light";

export type ThemeEntry = (typeof SUPPORTED_ENTRIES)[number];

export type TerminalColors = { readonly background: string; readonly foreground: string; readonly cursor: string; readonly selectionBackground: string }
  & Readonly<Partial<Record<keyof typeof LIGHT_ANSI_ROLES, string>>>;

/**
 * What a row gives the page: a built-in theme's entry, or the row derived from an imported theme
 * (customThemes.ts), which carries its colours itself.
 */
export interface DrawnTheme {
  readonly id: string;
  readonly mode: Mode;
  readonly terminal: TerminalColors;
  readonly bgPanel: string;
  readonly bg: string;
  readonly preview: { readonly elevated: string; readonly border: string; readonly text: string; readonly textDim: string; readonly accent: string; readonly primary: string };
  /** an imported theme's colours by role name, set on the document as custom properties; a built-in row's are in src/styles.css */
  readonly vars?: Readonly<Record<string, string>>;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** The theme either side starts from, and falls back to for an unknown id. */
export const DEFAULT_THEME: ThemeId = "codex";
/** The default before codex (#1267 added it, then it became the default): a side still on it was never chosen either. */
const FORMER_DEFAULT: ThemeId = "amber";

const DEFAULT_ROWS: Record<Mode, ThemeEntry> = {
  dark: SUPPORTED_ENTRIES.find((entry) => entry.id === DEFAULT_THEME && entry.mode === "dark")!,
  light: SUPPORTED_ENTRIES.find((entry) => entry.id === DEFAULT_THEME && entry.mode === "light")!,
};

/** The row drawn for a side: a both-mode theme's row of that side, a single-kind theme's only row, the default's for an unknown id. */
export function rowFor(id: string, side: Mode): ThemeEntry {
  const rows = SUPPORTED_ENTRIES.filter((entry) => entry.id === id);
  return rows.find((entry) => entry.mode === side) ?? (rows.length === 1 ? rows[0] : undefined) ?? DEFAULT_ROWS[side];
}

/** `<meta name="theme-color">`: the panel surface of the row drawn for `mode`. */
export function themeColor(id: string, mode: Mode): string {
  return rowFor(id, mode).bgPanel;
}

/** The xterm colors of the row drawn for `mode`: its `--term-*` tokens. */
export function terminalColors(id: string, mode: Mode): TerminalColors {
  return rowFor(id, mode).terminal;
}

const SIBLING_PAIRS: readonly (readonly [dark: ThemeId, light: ThemeId])[] = [
  ["catppuccin", "catppuccin-latte"],
  ["tokyo-night", "tokyo-night-day"],
  ["gruvbox", "gruvbox-light"],
  ["one-dark", "one-light"],
  ["solarized", "solarized-light"],
  ["kanagawa", "kanagawa-lotus"],
  ["rose-pine", "rose-pine-dawn"],
];

/** Only a known pair's opposite side is pre-filled; same-side picks have no sibling. */
export function siblingFor(id: string, targetSide: Mode): ThemeId | undefined {
  const pair = SIBLING_PAIRS.find(([dark, light]) => targetSide === "light" ? id === dark : id === light);
  return pair?.[targetSide === "light" ? 1 : 0];
}

const SIDE_KEY = { dark: "darkTheme", light: "lightTheme" } as const;

/**
 * What picking `id` for `side` changes: that side, and the other side too when `id` has a
 * sibling and the other side was never chosen on its own - still the default (or amber, the
 * default before it), or the sibling the previous pick put there. A side the user chose keeps its theme.
 */
export function pickTheme(current: { readonly darkTheme: string; readonly lightTheme: string }, side: Mode, id: ThemeId): Partial<Record<"darkTheme" | "lightTheme", ThemeId>> {
  const other: Mode = side === "dark" ? "light" : "dark";
  const sibling = siblingFor(id, other);
  const untouched = current[SIDE_KEY[other]] === DEFAULT_THEME || current[SIDE_KEY[other]] === FORMER_DEFAULT || current[SIDE_KEY[other]] === siblingFor(current[SIDE_KEY[side]], other);
  return sibling !== undefined && untouched ? { [SIDE_KEY[side]]: id, [SIDE_KEY[other]]: sibling } : { [SIDE_KEY[side]]: id };
}

export const HERDR_SOURCE = {
  repo: "herdrdev/herdr",
  sha: "143bf5fd4781d164260c63fe28e7dc08054ad32f",
} as const;
