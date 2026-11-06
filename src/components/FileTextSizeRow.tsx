import { FileText } from "lucide-react";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, fileFontSize, uiFontSize, useSettings, type FileFontBase } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, Stepper } from "./SettingsControls.tsx";

/** Settings → Appearance → File text size: a file's own reading size, from the chat's until one is chosen (#2005). */
export function FileTextSizeRow() {
  const { settings, update } = useSettings();
  const t = useT();
  const size = fileFontSize(settings);
  // the sizes the first step started from, kept through later steps and written with each (lib/settings.ts)
  const base = settings.fileFontSize !== null && settings.fileFontBase?.size === settings.fileFontSize ? settings.fileFontBase : null;
  const choose = (next: number): FileFontBase => ({ size: next, chat: base?.chat ?? chatFontSize(settings), ui: base?.ui ?? uiFontSize(settings) });
  return (
    <SettingsRow icon={FileText} label={t("File text size")} description={t("An open file's text, in its preview and its source. Follows the chat font size until you choose one.")} wide>
      <span className="settings-file-size">
        {settings.fileFontSize !== null && <button type="button" className="btn btn-ghost" onClick={() => update({ fileFontSize: null, fileFontBase: null })}>{t("Reset")}</button>}
        <Stepper label={t("File text size")} value={size} text={`${size}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease file text size")} increaseLabel={t("Increase file text size")} onChange={(next) => update({ fileFontSize: next, fileFontBase: choose(next) })} />
      </span>
    </SettingsRow>
  );
}
