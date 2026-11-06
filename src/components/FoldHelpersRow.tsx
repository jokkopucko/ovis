import { FoldVertical } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

/** Settings → Appearance → Fold helpers under their agent: the Agents list's helpers fold (components/AgentSidebar.tsx, #772). */
export function FoldHelpersRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow icon={FoldVertical} label={t("Fold helpers under their agent")} description={t("On this device, an agent's helpers fold under one line below its row in the Agents list, with how many there are. A helper that needs you and the selected one stay in sight.")}>
      <Toggle label={t("Fold helpers under their agent")} checked={settings.foldHelpers} onChange={(foldHelpers) => update({ foldHelpers })} />
    </SettingsRow>
  );
}
