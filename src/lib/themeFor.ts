import { rowFor, type ThemeId, type Mode, type ThemeEntry } from "./themes.ts";

export function themeFor(settings: { darkTheme: ThemeId; lightTheme: ThemeId }, resolved: Mode): ThemeEntry {
  return rowFor(resolved === "dark" ? settings.darkTheme : settings.lightTheme, resolved);
}
