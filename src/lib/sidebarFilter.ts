/**
 * A row is matched by the palette's fuzzy matcher (lib/paletteSearch.ts), its membership alone
 * and never its rank, on the labels the row shows: the PC's name; a workspace's name and the
 * branch its row says; an agent row's title, its agent's kind and name, and the tab name its
 * context line says. A shell has no row of its own, so its title is not searched. Nothing hidden
 * is searched: no working directory, no transcript, no
 * environment, no token value, no id.
 *
 * The idea, a row that survives when it, a header over it or a row under it matches, is adapted
 * from agent-of-empires' sidebar filter (THIRD_PARTY_NOTICES.md); its substring matcher, facets
 * and sunk/trash semantics are not.
 */
import type { Machine } from "../../shared/machines.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import type { HerdrPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { worktreeGroups } from "../../shared/worktree-groups.ts";
import { rosterPanes } from "./dagPane.ts";
import type { Translate } from "./i18n.ts";
import { matchesQuery } from "./paletteSearch.ts";
import { shortPathTitle, stripPaneChrome } from "./paneName.ts";
import { agentTabName, sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import type { WorkspaceGroup } from "./sidebarPins.ts";

export interface SidebarSelection {
  machineId: string;
  paneId: string | null;
}

export type SidebarBranchLabels = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface MachineFilter {
  shown: boolean;
  matched: boolean;
  workspaces: ReadonlySet<string>;
  matchedWorkspaces: ReadonlySet<string>;
  revealedWorkspaces: ReadonlySet<string>;
  panes: ReadonlySet<string>;
  matchedPanes: ReadonlySet<string>;
}

export interface SidebarFilter {
  query: string;
  active: boolean;
  machines: ReadonlyMap<string, MachineFilter>;
  matches: number;
}

const NO_FILTER: SidebarFilter = { query: "", active: false, machines: new Map(), matches: 0 };

export function inactiveSidebarFilter(): SidebarFilter {
  return NO_FILTER;
}

type FilterMachine = Pick<Machine, "id" | "name" | "snapshot">;

function nonblank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function shownPaneTitle(pane: HerdrPane, agentTitle: string | null | undefined): string | null {
  const named = nonblank(pane.label) ?? nonblank(agentTitle) ?? nonblank(pane.title);
  if (named !== null) return named;
  const shown = shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent));
  return shown === pane.pane_id ? null : nonblank(shown);
}

export function workspaceLabels(workspace: Pick<WorkspaceInfo, "label">, branch: string | null | undefined): string[] {
  return [workspace.label, branch].flatMap((label) => {
    const text = nonblank(label);
    return text === null ? [] : [text];
  });
}

export function paneLabels(pane: HerdrPane, entry: SidebarAgent | undefined, workspaceTabs: readonly TabInfo[], t: Translate): string[] {
  const agent = entry?.agent ?? null;
  const labels = [
    shownPaneTitle(pane, agent?.title),
    entry?.canonicalAgent,
    entry?.agentLabel,
    agent?.name,
    agent?.display_agent,
    pane.display_agent,
    entry ? agentTabName(entry.tab, workspaceTabs, t) : null,
  ];
  return [...new Set(labels.flatMap((label) => {
    const text = nonblank(label);
    return text === null ? [] : [text];
  }))];
}

function filterMachine(query: string, machine: FilterMachine, selection: SidebarSelection, t: Translate, branches: ReadonlyMap<string, string> | undefined, named: boolean, count: { matches: number }): MachineFilter {
  const matched = named && matchesQuery(query, machine.name);
  if (matched) count.matches += 1;
  const onThisPc = selection.machineId === machine.id;
  const workspaces = new Set<string>();
  const matchedWorkspaces = new Set<string>();
  const revealedWorkspaces = new Set<string>();
  const panes = new Set<string>();
  const matchedPanes = new Set<string>();
  const snapshot: SessionSnapshot | null = machine.snapshot;
  if (snapshot) {
    const headOf = new Map<string, string>();
    for (const group of worktreeGroups(snapshot.workspaces)) {
      for (const child of group.children) headOf.set(child.workspace_id, group.workspace.workspace_id);
    }
    const head = (workspaceId: string): string => headOf.get(workspaceId) ?? workspaceId;
    const agentByPane = new Map(sidebarAgents(snapshot).map((entry) => [entry.pane.pane_id, entry]));
    const tabsByWorkspace = new Map<string, TabInfo[]>();
    for (const tab of snapshot.tabs) tabsByWorkspace.set(tab.workspace_id, [...(tabsByWorkspace.get(tab.workspace_id) ?? []), tab]);
    const selectedPaneId = onThisPc ? selection.paneId : null;
    const roster = rosterPanes(snapshot.panes, selectedPaneId);
    const ownWorkspaces = new Set<string>();
    for (const workspace of snapshot.workspaces) {
      if (workspaceLabels(workspace, branches?.get(workspace.workspace_id)).some((label) => matchesQuery(query, label))) ownWorkspaces.add(workspace.workspace_id);
    }
    const ownPanes = new Set<string>();
    for (const pane of roster) {
      if (!agentByPane.has(pane.pane_id)) continue;
      if (paneLabels(pane, agentByPane.get(pane.pane_id), tabsByWorkspace.get(pane.workspace_id) ?? [], t).some((label) => matchesQuery(query, label))) ownPanes.add(pane.pane_id);
    }
    count.matches += ownWorkspaces.size + ownPanes.size;
    for (const workspace of snapshot.workspaces) {
      const id = workspace.workspace_id;
      if (!(matched || ownWorkspaces.has(id) || ownWorkspaces.has(head(id)))) continue;
      matchedWorkspaces.add(id);
      revealedWorkspaces.add(id);
      workspaces.add(id);
      workspaces.add(head(id));
    }
    for (const pane of roster) {
      if (!(ownPanes.has(pane.pane_id) || matchedWorkspaces.has(pane.workspace_id))) continue;
      matchedPanes.add(pane.pane_id);
      revealedWorkspaces.add(pane.workspace_id);
      panes.add(pane.pane_id);
      workspaces.add(pane.workspace_id);
      workspaces.add(head(pane.workspace_id));
    }
    const selected = selectedPaneId === null ? undefined : snapshot.panes.find((pane) => pane.pane_id === selectedPaneId);
    if (selected) {
      panes.add(selected.pane_id);
      workspaces.add(selected.workspace_id);
      workspaces.add(head(selected.workspace_id));
    }
  }
  return { shown: matched || onThisPc || workspaces.size > 0 || panes.size > 0 || snapshot === null, matched, workspaces, matchedWorkspaces, revealedWorkspaces, panes, matchedPanes };
}

export function sidebarFilter(query: string, machines: readonly FilterMachine[], selection: SidebarSelection, t: Translate, branches: SidebarBranchLabels = new Map(), unnamed: ReadonlySet<string> = new Set()): SidebarFilter {
  if (query.trim().length === 0) return query === "" ? NO_FILTER : { ...NO_FILTER, query };
  const count = { matches: 0 };
  const byMachine = new Map<string, MachineFilter>();
  for (const machine of machines) byMachine.set(machine.id, filterMachine(query, machine, selection, t, branches.get(machine.id), !unnamed.has(machine.id), count));
  return { query, active: true, machines: byMachine, matches: count.matches };
}

/**
 * PC names, workspace names and the branches their rows say, and the title each agent row shows;
 * never a path, a transcript or an id.
 */
export function filterSuggestions(machines: readonly FilterMachine[], branches: SidebarBranchLabels = new Map(), unnamed: ReadonlySet<string> = new Set()): string[] {
  const labels = new Set<string>();
  for (const machine of machines) {
    if (!unnamed.has(machine.id)) labels.add(machine.name);
    for (const workspace of machine.snapshot?.workspaces ?? []) for (const label of workspaceLabels(workspace, branches.get(machine.id)?.get(workspace.workspace_id))) labels.add(label);
    for (const entry of sidebarAgents(machine.snapshot)) {
      const title = shownPaneTitle(entry.pane, entry.agent?.title);
      if (title !== null) labels.add(title);
    }
  }
  return [...labels].filter((label) => label.trim() !== "");
}

export function machineFilter(filter: SidebarFilter, machineId: string): MachineFilter | null {
  if (!filter.active) return null;
  return filter.machines.get(machineId) ?? { shown: false, matched: false, workspaces: new Set(), matchedWorkspaces: new Set(), revealedWorkspaces: new Set(), panes: new Set(), matchedPanes: new Set() };
}

export function filterWorkspaceGroups<W extends Pick<WorkspaceInfo, "workspace_id">>(groups: readonly WorkspaceGroup<W>[], kept: ReadonlySet<string>): WorkspaceGroup<W>[] {
  return groups.flatMap((group) => {
    const children = group.children.filter((child) => kept.has(child.workspace_id));
    return kept.has(group.workspace.workspace_id) || children.length > 0 ? [{ workspace: group.workspace, children }] : [];
  });
}
