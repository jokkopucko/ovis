import { useRef } from "react";
import { Bell, Monitor, Volume2 } from "lucide-react";

import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { ChipToggles, SettingsBare, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import { pcAlertKey, type Machine } from "../../shared/machines.ts";
import { alertFiltersChanged, updateAlertFilters, useAlertFilters } from "../lib/alertFilters.ts";
import { alertMeWhenChips } from "./AlertChips.tsx";
import type { PushActionResult } from "../lib/pushHealth.ts";
import { PushTestControls } from "./PushTestControls.tsx";
import { AlertWebhookGroup } from "./AlertWebhookGroup.tsx";
import { previewAlertSound, unlockAlertSound } from "../lib/alertSound.ts";

export function AlertsPage({ onEnableNotifications, machines }: { onEnableNotifications: () => Promise<PushActionResult>; machines: readonly Machine[] }) {
  const { settings, update } = useSettings();
  const t = useT();
  const filters = useAlertFilters();
  // the Sound switch as last set: the preview waits for the audio, and must not play once it is off
  const alertSoundWanted = useRef(settings.alertSound);
  return (
    <SettingsBare.Provider value={true}>
    <SettingsGroup note={t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}>
      <PushTestControls onEnable={onEnableNotifications} />
      {/* the rows these chips replaced are still found by their words */}
      <SettingsRow label={t("Alert me when")} description={t("Which events alert this device: an agent waits for your answer or your permission, a turn finishes, or a turn stops on an error. An alert waits a moment first and is not sent if the pane changes meanwhile, as when you answer at the PC.")} icon={Bell} wide
        resetAlso={{ changed: alertFiltersChanged(filters, settings.alertInput) > 0, restore: () => updateAlertFilters({ permission: undefined, error: undefined }) }}
        keywords={[t("Long turn finished"), t("Any turn finished"), t("Needs input"), t("An agent asks you something"), t("Needs permission"), t("An agent asks before it runs a command or changes a file. One that does not say so alerts as Needs input."), t("Finished"), t("Long turns: only work that took a minute or more"), t("Stopped on an error"), t("A turn that ended on an error, as OmO and GJC report it")].join(" ")}
        condition={<span className="settings-condition">{t("Long turns: only work that took a minute or more")} {t("Any turn finished takes in the long ones.")}</span>}
        reset={["alertInput", "alertDone"]}>
        <ChipToggles label={t("Alert me when")} chips={alertMeWhenChips(t, settings, filters, update, true)} />
      </SettingsRow>
      {/* a sighted reader sees where the chime plays, which the hidden sentence alone did not say (G-097) */}
      <SettingsRow label={t("Play sounds")} description={t("On this device, an open tab of the app chimes for the alerts chosen above. Turning this on plays the chime once.")} icon={Volume2} condition={<span className="settings-condition">{t("While a tab of the app is open, it chimes for these alerts, also when a Focus or Do Not Disturb silences notifications.")}</span>} reset={["alertSound"]}>
        <Toggle label={t("Play sounds")} checked={settings.alertSound} onChange={(alertSound) => {
          update({ alertSound });
          alertSoundWanted.current = alertSound;
          // this tap is the gesture the page needs to play audio
          if (alertSound) void unlockAlertSound().then((ready) => { if (ready && alertSoundWanted.current) previewAlertSound(); });
        }} />
      </SettingsRow>
    </SettingsGroup>
    <AlertPcsGroup machines={machines} />
    {/* a destination's last failed post is said in its group, so the group stays in sight */}
    <AlertWebhookGroup />
    </SettingsBare.Provider>
  );
}

function AlertPcsGroup({ machines }: { machines: readonly Machine[] }) {
  const t = useT();
  const { pcsOff } = useAlertFilters();
  if (machines.length < 2) return null;
  const listed = [...machines].sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"));
  return (
    <SettingsGroup title={t("Alerts from")} section="alert-pcs" heading>
      {listed.map((machine) => {
        const key = pcAlertKey(machine);
        return (
          <SettingsRow key={machine.id} label={machine.name} description={t("When off, this device gets no alert from this PC, on any channel. The PC stays connected, and other devices still get its alerts.")} icon={Monitor}>
            <Toggle label={t("Alerts from {name}", { name: machine.name })} checked={!pcsOff.includes(key) && !pcsOff.includes(machine.name)}
              onChange={(on) => updateAlertFilters({ pcsOff: on ? pcsOff.filter((item) => item !== key && item !== machine.name) : [...pcsOff, key] })} />
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}