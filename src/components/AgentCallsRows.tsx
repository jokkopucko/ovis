import { useEffect, useState } from "react";
import { Network, Users } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ACP_LAUNCH_HARNESSES, harnessToolSetting, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { savePreferences } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { ChipToggles, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

/**
 * Whether an agent Ovis starts on this PC may start other agents and give them work (docs/harness-tool.md). Off, it may
 * only look. The list offers installed agents with an ACP launch; actual starts still have to pass the server's checks.
 * The grant is this PC's own: it is written straight to this PC's server, never through the tab's preference sync,
 * which carries unsent changes to whichever PC the tab shows next.
 */
export function AgentCallsRows({ agents, watching }: { agents: readonly AgentCatalogRow[]; watching: boolean }) {
  const t = useT();
  const { settings } = useSettings();
  const [saved, setSaved] = useState<HarnessToolSetting | null>(null);
  const [failed, setFailed] = useState(false);
  const held = settings.agentHarnessTool;
  useEffect(() => { if (saved !== null && JSON.stringify(saved) === JSON.stringify(held)) setSaved(null); }, [saved, held]);
  const setting = saved ?? held;
  const on = setting.level === "start";
  const callable = agents.filter((agent) => agent.state.installed === true && ACP_LAUNCH_HARNESSES.some((id) => id === agent.id));
  const label = t("Let agents call other agents");
  const save = (next: HarnessToolSetting): void => {
    setFailed(false);
    setSaved(next);
    savePreferences({ settings: { agentHarnessTool: next } }).then(
      (answer) => setSaved(harnessToolSetting(answer.settings.agentHarnessTool)),
      () => { setSaved(null); setFailed(true); },
    );
  };
  const turn = (next: boolean): void => save(next
    ? { ...setting, level: "start", harnesses: setting.harnesses.length > 0 ? setting.harnesses : callable.map((agent) => agent.id) }
    : { ...setting, level: "view" });
  const choose = (id: string, chosen: boolean): void => save({ ...setting, harnesses: chosen ? [...setting.harnesses, id] : setting.harnesses.filter((harness) => harness !== id) });
  return (
    <SettingsGroup section="agent-calls">
      <SettingsRow icon={Network} label={label} description={t("On this PC only. Only you can approve requests.")}
        condition={failed ? <span className="settings-condition" role="alert">{t("Not saved: this PC did not answer. Try again.")}</span> : undefined}>
        <Toggle label={label} checked={on} disabled={watching} onChange={turn} />
      </SettingsRow>
      {on && callable.length > 0 && <SettingsRow icon={Users} label={t("Agents they may call")}>
        <ChipToggles label={t("Agents they may call")} disabled={watching} chips={callable.map((agent) => ({ label: agent.name, on: setting.harnesses.includes(agent.id), onChange: (chosen) => choose(agent.id, chosen) }))} />
      </SettingsRow>}
    </SettingsGroup>
  );
}
