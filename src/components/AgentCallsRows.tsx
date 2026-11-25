import { useEffect, useState } from "react";
import { Network, SquareTerminal, Users } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ASK_EVERY_TIME_HARNESSES, OWN_RULES_HARNESSES, UNASKED_SEARCH_HARNESSES, harnessToolSetting, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { removeAgentToolPane, savePreferences } from "../lib/api.ts";
import { useAgentToolPanes } from "../lib/agentToolPanes.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { ChipToggles, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

/**
 * Whether an agent Ovis starts on this PC may start other agents and give them work (docs/harness-tool.md). Off, it may
 * only look. Only the installed agents it may start are offered, and turning it on with none chosen chooses them all.
 * Of those, the ones whose own allow rules no launch turns off are named under them, and those that search the web unasked.
 * The grant is this PC's own: it is written straight to this PC's server, never through the tab's preference sync,
 * which carries unsent changes to whichever PC the tab shows next.
 */
export function AgentCallsRows({ agents, watching }: { agents: readonly AgentCatalogRow[]; watching: boolean }) {
  const t = useT();
  const { settings } = useSettings();
  const [saved, setSaved] = useState<HarnessToolSetting | null>(null);
  const [failed, setFailed] = useState(false);
  const held = settings.agentHarnessTool;
  const { allowed } = useAgentToolPanes();
  useEffect(() => { if (saved !== null && JSON.stringify(saved) === JSON.stringify(held)) setSaved(null); }, [saved, held]);
  const setting = saved ?? held;
  const on = setting.level === "start";
  const callable = agents.filter((agent) => agent.state.installed === true && agent.state.version === ASK_EVERY_TIME_HARNESSES[agent.id]);
  const named = (ids: readonly string[]) => callable.filter((agent) => ids.includes(agent.id)).map((agent) => agent.name).join(", ");
  const ownRules = named(OWN_RULES_HARNESSES), unaskedSearch = named(UNASKED_SEARCH_HARNESSES);
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
      <SettingsRow icon={Network} label={label} description={t("On this PC only. You still answer every permission request.")}
        condition={failed ? <span className="settings-condition" role="alert">{t("Not saved: this PC did not answer. Try again.")}</span> : undefined}>
        <Toggle label={label} checked={on} disabled={watching} onChange={turn} />
      </SettingsRow>
      {on && callable.length > 0 && <SettingsRow icon={Users} label={t("Agents they may call")}
        condition={ownRules === "" ? undefined : <span className="settings-condition">{t("The allow rules you set in {agents}, a project folder's included, apply when they are called too.", { agents: ownRules })}
          {unaskedSearch !== "" && <><br />{t("{agents} searches the web without asking.", { agents: unaskedSearch })}</>}</span>}>
        <ChipToggles label={t("Agents they may call")} disabled={watching} chips={callable.map((agent) => ({ label: agent.name, on: setting.harnesses.includes(agent.id), onChange: (chosen) => choose(agent.id, chosen) }))} />
      </SettingsRow>}
      {on && allowed.map((pane) => (
        <SettingsRow key={pane.id} icon={SquareTerminal} label={pane.label === pane.pane ? pane.pane : `${pane.label} (${pane.pane})`} description={t("A pane you allowed to call other agents, until it closes.")}>
          <button type="button" className="btn" disabled={watching} onClick={() => { removeAgentToolPane(pane.id).catch(() => setFailed(true)); }}>{t("Remove")}</button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
