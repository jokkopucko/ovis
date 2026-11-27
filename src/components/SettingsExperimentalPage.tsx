import { Bot, Lock, MessageSquare, MessagesSquare, MousePointer2, Server, Tags } from "lucide-react";

import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsBare, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import { AgentGroupNames } from "./AgentGroupNames.tsx";

export function ExperimentalPage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsBare.Provider value={true}>
    {/* each row names what the reader gets, and one line says what changes: the long sentences stay for search (G-098) */}
    <SettingsGroup>
      <SettingsRow label={t("Named agent groups")} icon={Tags} description={t("Splits the Agents list into groups you name, such as Agents, Replies or Tasks, on every device. New workspace and New tab let you pick a group, and an agent's menu moves it to another.")} condition={<span className="settings-condition">{t("Groups you name in the Agents list, in every browser.")}</span>} reset={["agentNamedGroups"]}>
        <Toggle label={t("Named agent groups")} checked={settings.agentNamedGroups} onChange={(agentNamedGroups) => update({ agentNamedGroups })} />
      </SettingsRow>
      {settings.agentNamedGroups && <AgentGroupNames />}
      <SettingsRow label={t("Lock pinned agents")} icon={Lock} description={t("Adds Lock agent to a pinned agent's menu. Ovis then offers no way to close a locked agent's pane, tab or workspace, on any device; herdr itself or a script can still close it.")} condition={<span className="settings-condition">{t("Each lock is turned on from the pinned agent's own menu.")}</span>} reset={["agentLocks"]}>
        <Toggle label={t("Lock pinned agents")} checked={settings.agentLocks} onChange={(agentLocks) => update({ agentLocks })} />
      </SettingsRow>
        <SettingsRow label={t("Codex panes: let Codex select and scroll")} icon={MousePointer2} reset={["codexDrag"]} description={t("On this device, a drag in a Codex pane goes to Codex, which selects through its whole history and scrolls while the drag is held past the edge. On herdr's TUI, Codex's own copy does not reach this device's clipboard; Shift+drag (Option+drag on a Mac) still selects and copies in Ovis.")} condition={<span className="settings-condition">{t("A drag in a Codex pane selects through its whole history; Shift+drag still copies in Ovis.")}</span>}>
          <Toggle label={t("Codex panes: let Codex select and scroll")} checked={settings.codexDrag} onChange={(codexDrag) => update({ codexDrag })} />
        </SettingsRow>
    </SettingsGroup>
    {/* one agent's own experiments, moved here from its row on Agents */}
    <SettingsGroup title={t("Agents")} section="experimental-agents" heading>
      <SettingsRow label={t("OMP: side conversations chip")} icon={MessagesSquare} description={t("On this device, adds a chip to an OMP pane's message box that lists the side conversations its session saved with /btw.")} condition={<span className="settings-condition">{t("Opens the side conversations an OMP session saved with /btw.")}</span>} reset={["composerBtw"]}>
        <Toggle label={t("OMP: side conversations chip")} checked={settings.composerBtw} onChange={(composerBtw) => update({ composerBtw })} />
      </SettingsRow>
      <SettingsRow label={t("OpenCode: subagent ends from their session")} icon={Bot} description={t("On every device, an OpenCode subagent counts as running until the session that started it is told it has ended, not just until it goes idle. When off, the subagent's own state decides.")} condition={<span className="settings-condition">{t("A subagent counts as running until the session that started it is told it ended.")}</span>} reset={["opencodeParentEnds"]}>
        <Toggle label={t("OpenCode: subagent ends from their session")} checked={settings.opencodeParentEnds} onChange={(opencodeParentEnds) => update({ opencodeParentEnds })} />
      </SettingsRow>
      <SettingsRow label={t("OMP on macOS herdr-core: chat from the session it holds open")} icon={MessageSquare} description={t("On a Mac running herdr-core, the Herdr app's core, an OMP pane's chat is read from the session file its omp has open, so omp -c and resumed sessions show their chat. When off, such a pane shows the terminal instead.")} reset={["ompHeldFiles"]}>
        <Toggle label={t("OMP on macOS herdr-core: chat from the session it holds open")} checked={settings.ompHeldFiles} onChange={(ompHeldFiles) => update({ ompHeldFiles })} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title={t("PCs")} section="experimental-pcs" heading>
      <SettingsRow label={t("Start a replaced server again")} icon={Server} description={t("When Ovis is installed on another PC over SSH in place of one started by hand, and that install fails or is cancelled, the old one is started again as it was. When off, it stays stopped.")} reset={["restoreReplacedServer"]}>
        <Toggle label={t("Start a replaced server again")} checked={settings.restoreReplacedServer} onChange={(restoreReplacedServer) => update({ restoreReplacedServer })} />
      </SettingsRow>
    </SettingsGroup>
    </SettingsBare.Provider>
  );
}