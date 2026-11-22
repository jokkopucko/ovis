import { nonblank, type SidebarAgent } from "../../shared/agent-roster.ts";
import type { TabInfo } from "../../shared/protocol.ts";
import { customTabLabel, tabLabel } from "./tabName.ts";

export { sidebarAgents, type SidebarAgent } from "../../shared/agent-roster.ts";

export function paneMark(entry: SidebarAgent | undefined): string | null {
  if (!entry) return null;
  return entry.canonicalAgent ?? entry.agentLabel ?? "";
}

export function titleOnlyNamesAgent(title: string, names: readonly (string | null | undefined)[]): boolean {
  const plain = (text: string): string => text.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase();
  const said = plain(title);
  return said !== "" && names.some((name) => typeof name === "string" && plain(name) === said);
}

export function workspaceAgentLabels(agents: readonly SidebarAgent[]): Map<string, string[]> {
  const byWorkspace = new Map<string, string[]>();
  for (const { workspace, agentLabel, canonicalAgent } of agents) {
    const label = agentLabel ?? canonicalAgent;
    if (!label) continue;
    const labels = byWorkspace.get(workspace.workspace_id) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byWorkspace.set(workspace.workspace_id, labels);
  }
  return byWorkspace;
}

/**
 * The tab an agent row names, as herdr's agents panel does: only when its workspace has two or
 * more tabs or the tab was renamed. A tab is judged by its place in the row, not its number:
 * herdr relabels the tab that moves up when the one before it closes, and keeps its number.
 */
export function agentTabName(tab: TabInfo | null | undefined, workspaceTabs: readonly TabInfo[], t: Parameters<typeof tabLabel>[1]): string | null {
  if (!tab) return null;
  const place = workspaceTabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1 || tab.number;
  return workspaceTabs.length > 1 || customTabLabel(tab, place) ? tabLabel(tab, t, place) : null;
}

export interface AgentContextParts {
  agentLabel: string | null;
  title: string;
  markAgent: string | null;
  /** null with a single PC: herdr does not name a lone machine either */
  machineName: string | null;
  workspaceLabel: string;
  tabName: string | null;
}

export function agentContext({ agentLabel, title, markAgent, machineName, workspaceLabel, tabName }: AgentContextParts): string[] {
  const agent = nonblank(agentLabel);
  const tab = nonblank(tabName);
  return [
    agent && agent !== title.trim() && agent.toLowerCase() !== markAgent?.toLowerCase() ? agent : null,
    nonblank(machineName),
    workspaceLabel,
    tab && tab !== workspaceLabel ? tab : null,
  ].filter((part): part is string => Boolean(part));
}
