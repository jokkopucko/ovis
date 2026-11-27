import { useContext, type RefObject } from "react";
import { AppWindow, ClipboardCopy, Image as ImageIcon, Keyboard, Mouse, TextCursorInput } from "lucide-react";

import { TERMINAL_WHEEL_SPEED_MAX, TERMINAL_WHEEL_SPEED_MIN, useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { KeyBarToggles } from "./KeyBarSettings.tsx";
import { SettingsBare, Segmented, SettingsFold, SettingsGroup, SettingsQuery, SettingsRow, SettingsSelect, Stepper, Toggle } from "./SettingsControls.tsx";
import { HERDR_WINDOW_CHOICES, type HerdrWindowChoice } from "../lib/herdrWindow.ts";

export function TerminalPage({ keyBarButtonRef, onEditKeyBar, picturesByDefault }: { keyBarButtonRef: RefObject<HTMLButtonElement | null>; onEditKeyBar: () => void; picturesByDefault: boolean }) {
  const { settings, update } = useSettings();
  const t = useT();
  const searching = useContext(SettingsQuery).length > 0;
  const herdrWindow: HerdrWindowChoice = settings.followHerdrFocus ? "follow" : settings.releasePaneAway ? "alongside" : "separate";
  return (
    <SettingsBare.Provider value={true}>
    <SettingsGroup>
      <SettingsRow label={t("Terminal input mode")} description={t("How you type into a terminal pane on this device: Direct typing sends each key straight to the terminal, and Input line puts a text box under it, where a line is written first and then sent.")} icon={TextCursorInput} htmlFor="terminal-input-mode" reset={["terminalInputMode"]}>
        {/* "auto", the stored default, types straight into the grid on every device: it reads as Direct typing */}
        <SettingsSelect id="terminal-input-mode" value={settings.terminalInputMode === "line" ? "line" : "direct"} onChange={(event) => update({ terminalInputMode: event.target.value as "line" | "direct" })}>
          <option value="direct">{t("Direct typing")}</option><option value="line">{t("Input line")}</option>
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label={t("Wheel scroll speed")} description={t("How far one turn of the mouse wheel scrolls a terminal pane on this device: 1× is the terminal's own step, and a higher number scrolls that many times as far.")} icon={Mouse} reset={["terminalWheelSpeed"]}>
        <Stepper label={t("Wheel scroll speed")} value={settings.terminalWheelSpeed} text={`${settings.terminalWheelSpeed}×`} min={TERMINAL_WHEEL_SPEED_MIN} max={TERMINAL_WHEEL_SPEED_MAX} decreaseLabel={t("Slower wheel scrolling")} increaseLabel={t("Faster wheel scrolling")} onChange={(terminalWheelSpeed) => update({ terminalWheelSpeed })} />
      </SettingsRow>
      <SettingsRow label={t("Key bar")} description={t("The row of terminal keys (Esc, Tab, Ctrl, arrows) shown with a terminal pane on a touch screen or a narrow window. Edit key bar chooses its keys and their order, for this device.")} icon={Keyboard} reset={["terminalKeyboardOnRequest", "terminalFoldKeyBar", "terminalAttachButton"]}>
        <button type="button" ref={keyBarButtonRef} className="btn" onClick={onEditKeyBar}>{t("Edit key bar")}</button>
      </SettingsRow>
      {/* the three choices fold two settings: each choice's effect is said on the row (G-095) */}
      <SettingsRow label={t("herdr window")} description={t("For when you also use herdr's own window on this PC. Separate keeps a pane attached to Ovis, at its size here, when you leave Ovis; Use alongside gives a pane you are not using back to herdr after a short delay; Follow its focus does that and also shows in Ovis the pane you select in herdr.")} icon={AppWindow} wide reset={["releasePaneAway", "followHerdrFocus"]} keywords={`${t("Use alongside herdr's own window")} ${t("Follow herdr's focus")}`}
        condition={<span className="settings-condition">{t(HERDR_WINDOW_CHOICES[herdrWindow].descriptionKey)}</span>}>
        <Segmented<HerdrWindowChoice> label={t("herdr window")} value={herdrWindow} onChange={(choice) => {
          if (choice !== herdrWindow) {
            const { releasePaneAway, followHerdrFocus } = HERDR_WINDOW_CHOICES[choice];
            update({ releasePaneAway, followHerdrFocus });
          }
        }} options={[{ value: "separate", label: t("Separate") }, { value: "alongside", label: t("Use alongside") }, { value: "follow", label: t("Follow its focus") }]} />
      </SettingsRow>
    </SettingsGroup>
    {/* the key bar's own rows live in its editor; a search here still finds them */}
    {searching && <KeyBarToggles />}
    <SettingsFold kind="more" keys={["paneClipboard", "terminalImages"]}>
      <SettingsGroup section="terminal-more">
        <SettingsRow label={t("Clipboard from a pane")} description={t("Lets a program in a pane put text on this device's clipboard, which is how vim, tmux and Claude Code copy; when off, such a copy does not arrive. Any program in a pane can use it, so turn it off before running something you do not trust.")} icon={ClipboardCopy} reset={["paneClipboard"]}>
          <Toggle label={t("Clipboard from a pane")} checked={settings.paneClipboard} onChange={(paneClipboard) => update({ paneClipboard })} />
        </SettingsRow>
        <SettingsRow label={t("Show pictures in the terminal")} description={t("Draws the pictures a program prints in a terminal pane on this device, as imgcat or yazi do. They only arrive where this PC's terminals come from herdr-core, the Herdr app's core: herdr's TUI does not pass them on.")} icon={ImageIcon} reset={["terminalImages"]}>
          <Toggle label={t("Show pictures in the terminal")} checked={settings.terminalImages ?? picturesByDefault} onChange={(terminalImages) => update({ terminalImages })} />
        </SettingsRow>
      </SettingsGroup>
    </SettingsFold>
    </SettingsBare.Provider>
  );
}