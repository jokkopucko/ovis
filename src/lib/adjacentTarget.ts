/**
 * The previous/next tab and workspace shortcuts: each step opens the pane a click on that tab or
 * sidebar row opens, so the keys and the pointer land in the same place.
 */

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { rosterPanes } from "./dagPane.ts";
import type { ViewedScope } from "./lastViewedPane.ts";
import { splitPinnedGroups, type WorkspaceGroup } from "./sidebarPins.ts";
import { worktreeGroups } from "./workspaceOrder.ts";

type Roster = Pick<SessionSnapshot, "workspaces" | "tabs" | "panes" | "layouts">;
/** the pane last seen here in a tab or a workspace (lib/lastViewedPane.ts), for the PC stepped on */
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

/**
 * The pane the tab before or after the selected pane's opens, in the tab strip's order (herdr's),
 * wrapping around: the one last viewed in it here, else herdr's focused one in it, as TabStrip's
 * click. Null without a selected pane or another tab with a pane.
 */
export function adjacentTabPane(roster: Roster, selectedPaneId: string | null, direction: -1 | 1, viewed: ViewedPane): string | null {
  const selected = roster.panes.find((pane) => pane.pane_id === selectedPaneId);
  if (!selected) return null;
  const panes = rosterPanes(roster.panes.filter((pane) => pane.workspace_id === selected.workspace_id), selectedPaneId);
  const tabs = roster.tabs.filter((tab) => tab.workspace_id === selected.workspace_id && panes.some((pane) => pane.tab_id === tab.tab_id));
  if (tabs.length < 2) return null;
  const next = step(tabs, tabs.findIndex((tab) => tab.tab_id === selected.tab_id), direction);
  if (!next) return null;
  const own = panes.filter((pane) => pane.tab_id === next.tab_id);
  return firstPane(own, viewed("tab", next.tab_id), roster.layouts?.find((layout) => layout.tab_id === next.tab_id)?.focused_pane_id)?.pane_id ?? null;
}

/**
 * The workspace rows of the sidebar's groups top to bottom, each row with the worktrees under it. A
 * folded group's worktrees are left out, as the sidebar leaves them out, unless the selection is in one.
 */
export function workspaceRows(groups: readonly WorkspaceGroup<WorkspaceInfo>[], folded: (group: WorkspaceGroup<WorkspaceInfo>) => boolean, selectedWorkspaceId: string | null): string[] {
  return groups.flatMap((group) => {
    const hidden = folded(group);
    return [group.workspace, ...group.children.filter((child) => !hidden || child.workspace_id === selectedWorkspaceId)].map((row) => row.workspace_id);
  });
}

/**
 * The rows a PC's sidebar would draw with no filter, from the order it draws (`ordered`, herdr's or a
 * drag's): pinned rows first in pin order, then the rest. For a PC whose roster is not drawn (folded).
 */
export function sidebarWorkspaceSteps(ordered: readonly WorkspaceInfo[], pinnedIds: readonly string[], folded: (repoKey: string) => boolean, selectedWorkspaceId: string | null): string[] {
  const { pinned, rest } = splitPinnedGroups(worktreeGroups(ordered), pinnedIds, (workspace) => workspace.workspace_id);
  return workspaceRows([...pinned, ...rest], (group) => folded(group.workspace.worktree?.repo_key ?? ""), selectedWorkspaceId);
}

/** each drawn sidebar's rows as it last drew them, by PC: its filter and its folds as shown */
const drawnRows = new Map<string, readonly string[]>();

/** a sidebar's rows, for the workspace steps; the returned function takes them back when it goes */
export function publishWorkspaceRows(machineId: string, rows: readonly string[]): () => void {
  drawnRows.set(machineId, rows);
  return () => { if (drawnRows.get(machineId) === rows) drawnRows.delete(machineId); };
}

export function drawnWorkspaceRows(machineId: string): readonly string[] | null {
  return drawnRows.get(machineId) ?? null;
}

/**
 * The pane the workspace row before or after the selected pane's opens, along `order`
 * (sidebarWorkspaceSteps), wrapping around; without a selection the first or the last. Its pane is
 * the row's: the one last viewed in it here, else the one in front in its active tab.
 */
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
