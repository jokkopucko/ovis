import { FoldVertical } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

export function FoldHelpersRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow icon={FoldVertical} label={t("Fold helpers under their agent")} description={t("On this device, an agent's helpers fold into one line under it in the Agents list, with their count. A helper that needs you and the one you selected stay in sight.")}>
      <Toggle label={t("Fold helpers under their agent")} checked={settings.foldHelpers} onChange={(foldHelpers) => update({ foldHelpers })} />
    </SettingsRow>
  );
}
