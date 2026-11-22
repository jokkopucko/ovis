import { useState } from "react";
import { Plus, X } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { MAX_AGENT_GROUP_NAME, MAX_AGENT_GROUPS, removeAgentGroup, renameAgentGroup, renameDeviceAgentGroup } from "../lib/namedAgentGroups.ts";
import { useSettings } from "../lib/settings.ts";

export function AgentGroupNames() {
  const t = useT();
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState("");
  const names = settings.agentGroupNames;
  const add = (): void => {
    const name = draft.trim().slice(0, MAX_AGENT_GROUP_NAME);
    if (name === "" || names.includes(name) || names.length >= MAX_AGENT_GROUPS) return;
    update({ agentGroupNames: [...names, name] });
    setDraft("");
  };
  return <div className="settings-item">
    <ol className="quick-replies-list">
      {names.map((name) => (
        <li key={name}>
          <input
            className="input"
            defaultValue={name}
            maxLength={MAX_AGENT_GROUP_NAME}
            aria-label={t("Group name")}
            autoComplete="off"
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            onBlur={(event) => {
              const renamed = renameAgentGroup(names, settings.agentGroupOf, name, event.currentTarget.value);
              if (renamed === null) event.currentTarget.value = name;
              else if (renamed.names.some((held, index) => held !== names[index])) {
                update({ agentGroupNames: renamed.names, agentGroupOf: renamed.groupOf });
                renameDeviceAgentGroup(name, event.currentTarget.value.trim().slice(0, MAX_AGENT_GROUP_NAME));
              }
            }}
          />
          <button type="button" className="icon-button" aria-label={t("Remove group {group}", { group: name })} onClick={() => {
            const removed = removeAgentGroup(names, settings.agentGroupOf, name);
            update({ agentGroupNames: removed.names, agentGroupOf: removed.groupOf });
            renameDeviceAgentGroup(name, null);
          }}>
            <X aria-hidden="true" />
          </button>
        </li>
      ))}
    </ol>
    <form className="agent-group-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <input className="input" value={draft} maxLength={MAX_AGENT_GROUP_NAME} placeholder={t("New group")} aria-label={t("New group")} autoComplete="off" onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className="btn" disabled={draft.trim() === "" || names.length >= MAX_AGENT_GROUPS}><Plus aria-hidden="true" />{t("Add group")}</button>
    </form>
  </div>;
}
