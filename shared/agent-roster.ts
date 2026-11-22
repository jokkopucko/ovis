/**
 * The agent rows of one PC as the browser's roster lists them, before any grouping: which panes are agents, in the
 * server's workspace, tab and pane order (src/lib/sidebarAgents.ts), and each helper right under the agent that
 * started it (src/lib/agentRoster.ts). A terminal screen builds its list from the same rows.
 */
import type { AgentInfo, HerdrPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "./protocol.ts";
import { nestRows } from "./attention.ts";

export interface SidebarAgent {
  pane: HerdrPane;
  workspace: WorkspaceInfo;
  tab: TabInfo | null;
  agent: AgentInfo | null;
  canonicalAgent: string | null;
  agentLabel: string | null;
}

export function nonblank(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * The API's live agent roster, joined to the pane that owns its current state. OmO is also
 * recognized by the bridge's process-tree lookup, before herdr necessarily lists it as an
 * agent. A shell is never included just because it reports a working or blocked state.
 * Order follows the server's workspace, tab and pane order, independently of UI folds.
 */
export function sidebarAgents(snapshot: SessionSnapshot | null): SidebarAgent[] {
  if (!snapshot) return [];
  const agentByPane = new Map<string, AgentInfo>();
  for (const agent of snapshot.agents) {
    if (!agentByPane.has(agent.pane_id)) agentByPane.set(agent.pane_id, agent);
  }
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  const workspaceOrder = new Map(snapshot.workspaces.map((workspace, index) => [workspace.workspace_id, index]));
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const tabOrder = new Map(snapshot.tabs.map((tab, index) => [tab.tab_id, index]));
  const seen = new Set<string>();
  const rows: Array<{ row: SidebarAgent; paneOrder: number }> = [];
  snapshot.panes.forEach((pane, paneOrder) => {
    if (seen.has(pane.pane_id)) return;
    seen.add(pane.pane_id);
    const agent = agentByPane.get(pane.pane_id) ?? null;
    const workspace = workspaceById.get(pane.workspace_id);
    if (!workspace || (!agent && !nonblank(pane.agent))) return;
    const canonicalAgent = nonblank(pane.agent) ?? nonblank(agent?.agent);
    const tab = tabById.get(pane.tab_id);
    rows.push({
      paneOrder,
      row: {
        pane,
        workspace,
        tab: tab?.workspace_id === pane.workspace_id ? tab : null,
        agent,
        canonicalAgent,
        agentLabel: nonblank(agent?.display_agent) ?? nonblank(agent?.name)
          ?? nonblank(pane.display_agent) ?? canonicalAgent ?? nonblank(agent?.title),
      },
    });
  });
  return rows.sort((left, right) =>
    workspaceOrder.get(left.row.workspace.workspace_id)! - workspaceOrder.get(right.row.workspace.workspace_id)!
    || (tabOrder.get(left.row.tab?.tab_id ?? "") ?? snapshot.tabs.length) - (tabOrder.get(right.row.tab?.tab_id ?? "") ?? snapshot.tabs.length)
    || left.paneOrder - right.paneOrder,
  ).map(({ row }) => row);
}

/**
 * A PC's rows with each helper right under the agent that started it (herdr-core's `parent_pane_id`),
 * after that agent's earlier helpers.
 */
export function nestHelpers(entries: readonly SidebarAgent[]): SidebarAgent[] {
  return nestRows(entries, (entry) => entry.pane.pane_id, (entry) => entry.pane.parent_pane_id);
}
