import { FileText } from "lucide-react";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, fileFontSize, uiFontSize, useSettings, type FileFontBase } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, Stepper } from "./SettingsControls.tsx";

export function FileTextSizeRow() {
  const { settings, update } = useSettings();
  const t = useT();
  const size = fileFontSize(settings);
  const base = settings.fileFontSize !== null && settings.fileFontBase?.size === settings.fileFontSize ? settings.fileFontBase : null;
  const choose = (next: number): FileFontBase => ({ size: next, chat: base?.chat ?? chatFontSize(settings), ui: base?.ui ?? uiFontSize(settings) });
  return (
    <SettingsRow icon={FileText} label={t("File text size")} description={t("The text size of a file you open, in its preview and its source. It follows the chat font size until you set one here.")} wide>
      <span className="settings-file-size">
        {settings.fileFontSize !== null && <button type="button" className="btn btn-ghost" onClick={() => update({ fileFontSize: null, fileFontBase: null })}>{t("Reset")}</button>}
        <Stepper label={t("File text size")} value={size} text={`${size}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease file text size")} increaseLabel={t("Increase file text size")} onChange={(next) => update({ fileFontSize: next, fileFontBase: choose(next) })} />
      </span>
    </SettingsRow>
  );
}
