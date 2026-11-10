import { useEffect, useRef, useState } from "react";
import { FileUp, Trash2 } from "lucide-react";
import { MAX_CUSTOM_THEMES, MAX_THEME_FILE_BYTES, nameKey, readThemeFile, withImported, withoutTheme, type CustomTheme, type ThemeFileError } from "../lib/customThemes.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import type { Mode } from "../lib/themes.ts";
import { SettingsRow } from "./SettingsControls.tsx";
import "./ThemeFiles.css";

/** What a theme file holds and how the app reads it, for whoever writes one. */
const THEME_FILE_HELP = "https://github.com/devswha/ovis/blob/main/docs/themes.md";

function refusal(t: Translate, error: ThemeFileError | "full", key = ""): string {
  switch (error) {
    case "bad-color": return t("{key} in that file is not a color. Colors are written #rrggbb.", { key });
    case "too-large": return t("That file is too large to be a theme.");
    case "not-a-theme": return t("No theme was found in that file. It needs Base16 colors, base00 to base0F.");
    case "not-json": return t("That file is not valid JSON. Look for a trailing comma or a comment.");
    case "two-sides": return t("That file holds more than one side. A YAML scheme is one side: write a dark and a light side as one JSON file.");
    case "no-colors": return t("That theme has no background (base00) and text (base05) color.");
    case "full": return t("{count} themes are imported already. Remove one first.", { count: MAX_CUSTOM_THEMES });
  }
}

/** The sides an imported theme has, in words. */
const sidesOf = (t: Translate, theme: CustomTheme): string => [theme.dark && t("Dark"), theme.light && t("Light")].filter(Boolean).join(" · ");

/**
 * What an imported theme is called where it is named alone (its card, its Remove button): its name,
 * and its sides too when another imported theme looks to have the same name (a dark file and a
 * light file nobody renamed), so the two are told apart.
 */
export function themeLabel(t: Translate, theme: CustomTheme, themes: readonly CustomTheme[]): string {
  const key = nameKey(theme.name);
  return themes.some((entry) => entry.id !== theme.id && nameKey(entry.name) === key) ? `${theme.name} · ${sidesOf(t, theme)}` : theme.name;
}

/**
 * Settings → Appearance, under the theme cards: a theme from a file of colours (lib/customThemes.ts),
 * and the imported ones with a way to remove each. An imported theme is chosen at once for the side
 * it has (both when it has both); `onImported` is told which, so the picker can show those cards.
 */
export function ThemeFiles({ onImported }: { onImported: (sides: readonly Mode[]) => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const custom = settings.customThemes;

  // an import on its way into the settings: what it came to is read off the list it made
  const [pending, setPending] = useState<{ theme: CustomTheme; sides: readonly Mode[] } | null>(null);
  useEffect(() => {
    if (pending === null) return;
    setPending(null);
    // the list filled meanwhile, in another tab of this browser
    if (!custom.themes.some((entry) => entry.id === pending.theme.id)) return setStatus({ text: refusal(t, "full"), failed: true });
    onImported(pending.sides);
    setStatus({ text: t("Imported {name}.", { name: pending.theme.name }), failed: false });
  }, [pending, custom, onImported, t]);

  const add = async (file: File): Promise<void> => {
    const fail = (error: ThemeFileError | "full", key?: string): void => setStatus({ text: refusal(t, error, key), failed: true });
    if (file.size > MAX_THEME_FILE_BYTES) return fail("too-large");
    let text: string;
    try { text = await file.text(); } catch { return fail("not-a-theme"); }
    const result = readThemeFile(text, file.name.replace(/\.[^.]+$/, ""));
    if ("error" in result) return fail(result.error, result.key);
    const { theme } = result;
    const sides: Mode[] = theme.dark && theme.light ? ["dark", "light"] : [theme.dark ? "dark" : "light"];
    // onto the list as it is now, not as it was when this was drawn: another tab may have imported since
    update((current) => {
      const next = withImported(current.customThemes, theme);
      return next === null ? {} : { customThemes: next };
    });
    setPending({ theme, sides });
  };

  return (
    <>
      <SettingsRow
        icon={FileUp}
        label={t("Theme file")}
        keywords={`${t("Import")} Base16`}
        description={t("Import a theme from a file of colors: a Base16 scheme, or a file with a dark and a light side. Only colors are read from it.")}
        condition={status !== null && <span className={status.failed ? "settings-condition" : "settings-hint"} role={status.failed ? "alert" : "status"}>{status.text}</span>}
      >
        {/* beside the button, not in the description: a page without sentences still says where the format is written down */}
        <span className="settings-actions theme-file-actions">
          <a className="settings-link" href={THEME_FILE_HELP} target="_blank" rel="noreferrer">{t("File format")}</a>
          <button type="button" className="btn" onClick={() => picker.current?.click()}>{t("Import")}</button>
        </span>
        {/* no `accept`: a phone's picker greys out a .yaml it has no type for, and what is no theme is refused with a reason anyway */}
        <input ref={picker} type="file" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          // the same file can be chosen again after a fix
          event.target.value = "";
          if (file) void add(file);
        }} />
      </SettingsRow>
      {custom.themes.length > 0 && (
        <div className="settings-item">
          <ul className="theme-files" aria-label={t("Imported themes")}>
            {custom.themes.map((theme) => (
              <li key={theme.id}>
                <span className="theme-file-name">{theme.name}</span>
                <span className="theme-file-kinds">{sidesOf(t, theme)}</span>
                <button type="button" className="icon-button" aria-label={t("Remove theme {name}", { name: themeLabel(t, theme, custom.themes) })} title={t("Remove theme {name}", { name: themeLabel(t, theme, custom.themes) })} onClick={() => {
                  update((current) => ({ customThemes: withoutTheme(current.customThemes, theme.id) }));
                  setStatus(null);
                }}>
                  <Trash2 aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
