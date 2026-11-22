import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { worktreeGroups } from "../../shared/worktree-groups.ts";
import { rosterPanes } from "./dagPane.ts";
import type { ViewedScope } from "./lastViewedPane.ts";
import { splitPinnedGroups, type WorkspaceGroup } from "./sidebarPins.ts";
import { splitBackgroundGroups } from "./workspaceOrder.ts";

type Roster = Pick<SessionSnapshot, "workspaces" | "tabs" | "panes" | "layouts">;
export type ViewedPane = (scope: ViewedScope, id: string) => string | undefined;

function firstPane(panes: readonly PaneInfo[], ...ids: (string | null | undefined)[]): PaneInfo | undefined {
  for (const id of ids) {
    const pane = id ? panes.find((candidate) => candidate.pane_id === id) : undefined;
    if (pane) return pane;
  }
  return panes.find((pane) => pane.focused) ?? panes[0];
}

function step<T>(items: readonly T[], index: number, direction: -1 | 1): T | undefined {
  if (index < 0) return direction > 0 ? items[0] : items[items.length - 1];
  return items[(index + direction + items.length) % items.length];
}

export function adjacentTabPane(roster: Roster, selectedPaneId: string | null, direction: -1 | 1, viewed: ViewedPane): string | null {
  const strip = tabStrip(roster, selectedPaneId);
  if (!strip || strip.tabs.length < 2) return null;
  const next = step(strip.tabs, strip.tabs.findIndex((tab) => tab.tab_id === strip.selected.tab_id), direction);
  return next ? tabPane(roster, strip.panes, next.tab_id, viewed) : null;
}

export function numberedTabPane(roster: Roster, selectedPaneId: string | null, number: number, viewed: ViewedPane): string | null {
  const strip = tabStrip(roster, selectedPaneId);
  const tab = strip?.tabs[number - 1];
  return strip && tab ? tabPane(roster, strip.panes, tab.tab_id, viewed) : null;
}

function tabStrip(roster: Roster, selectedPaneId: string | null) {
  const selected = roster.panes.find((pane) => pane.pane_id === selectedPaneId);
  if (!selected) return null;
  const panes = rosterPanes(roster.panes.filter((pane) => pane.workspace_id === selected.workspace_id), selectedPaneId);
  const tabs = roster.tabs.filter((tab) => tab.workspace_id === selected.workspace_id && panes.some((pane) => pane.tab_id === tab.tab_id));
  return { selected, panes, tabs };
}

function tabPane(roster: Roster, panes: readonly PaneInfo[], tabId: string, viewed: ViewedPane): string | null {
  const own = panes.filter((pane) => pane.tab_id === tabId);
  return firstPane(own, viewed("tab", tabId), roster.layouts?.find((layout) => layout.tab_id === tabId)?.focused_pane_id)?.pane_id ?? null;
}

export function workspaceRows(groups: readonly WorkspaceGroup<WorkspaceInfo>[], folded: (group: WorkspaceGroup<WorkspaceInfo>) => boolean, selectedWorkspaceId: string | null): string[] {
  return groups.flatMap((group) => {
    const hidden = folded(group);
    return [group.workspace, ...group.children.filter((child) => !hidden || child.workspace_id === selectedWorkspaceId)].map((row) => row.workspace_id);
  });
}

export function sidebarWorkspaceSteps(ordered: readonly WorkspaceInfo[], pinnedIds: readonly string[], folded: (repoKey: string) => boolean, selectedWorkspaceId: string | null, backgroundFolded: boolean | null = null, blocked: ReadonlySet<string> = new Set()): string[] {
  const tree = worktreeGroups(ordered);
  const { pinned, rest } = splitPinnedGroups(tree, pinnedIds, (workspace) => workspace.workspace_id);
  const worktreeIds = new Set(tree.flatMap((group) => group.children.map((child) => child.workspace_id)));
  const { people, background } = backgroundFolded === null ? { people: rest, background: [] } : splitBackgroundGroups(rest, worktreeIds);
  const shown = backgroundFolded ? background.filter((group) => [group.workspace, ...group.children].some((member) => member.workspace_id === selectedWorkspaceId || blocked.has(member.workspace_id))) : background;
  return workspaceRows([...pinned, ...people, ...shown], (group) => folded(group.workspace.worktree?.repo_key ?? ""), selectedWorkspaceId);
}

const drawnRows = new Map<string, readonly string[]>();

export function publishWorkspaceRows(machineId: string, rows: readonly string[]): () => void {
  drawnRows.set(machineId, rows);
  return () => { if (drawnRows.get(machineId) === rows) drawnRows.delete(machineId); };
}

export function drawnWorkspaceRows(machineId: string): readonly string[] | null {
  return drawnRows.get(machineId) ?? null;
}

export function adjacentWorkspacePane(roster: Roster, order: readonly string[], selectedPaneId: string | null, direction: -1 | 1, viewed: ViewedPane): string | null {
  const panes = rosterPanes(roster.panes, selectedPaneId);
  const live = order.filter((id) => roster.workspaces.some((workspace) => workspace.workspace_id === id) && panes.some((pane) => pane.workspace_id === id));
  const current = panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id;
  const index = current === undefined ? -1 : live.indexOf(current);
  if (live.length === 0 || (index >= 0 && live.length < 2)) return null;
  const nextId = step(live, index, direction);
  const workspace = roster.workspaces.find((candidate) => candidate.workspace_id === nextId);
  if (!workspace) return null;
  const own = panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
  return firstPane(own, viewed("workspace", workspace.workspace_id), roster.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)?.pane_id ?? null;
}
