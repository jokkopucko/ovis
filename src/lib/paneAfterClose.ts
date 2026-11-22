import type { SessionSnapshot } from "../../shared/protocol.ts";
import { workspacePane } from "./deepLink.ts";

type Roster = Pick<SessionSnapshot, "workspaces" | "tabs" | "panes" | "layouts">;
type Viewed = (scope: "tab" | "workspace", id: string) => string | null | undefined;

function nearest(ids: string[], at: number, alive: (id: string) => boolean, before = false): string | null {
  const after = ids.slice(at + 1);
  const earlier = ids.slice(0, Math.max(at, 0)).reverse();
  return (before ? [...earlier, ...after] : [...after, ...earlier]).find(alive) ?? null;
}

function tabPane(roster: Roster, tabId: string, viewed?: Viewed): string | null {
  const front = roster.layouts?.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
  const panes = roster.panes.filter((pane) => pane.tab_id === tabId);
  const pick = (id: string | null | undefined) => (id ? panes.find((pane) => pane.pane_id === id) : undefined);
  return (pick(viewed?.("tab", tabId)) ?? pick(front) ?? panes[0])?.pane_id ?? null;
}

/**
 * Where the selection goes when its pane closes, by the rules herdr's TUI follows when its focused
 * pane closes (herdr 0.9.5: `close_focused` in src/layout.rs, `close_tab` in src/workspace.rs,
 * `close_workspaces` in src/app/actions.rs). This browser's selection is its focus: `previous`, the
 * pane selected before, is the TUI's previous focus. In the closed pane's tab: `previous`, else the
 * next pane in layout order, else the one before, else any pane the tab still has. With its tab
 * gone: the tab before it, else the one after, and the pane it shows. With its workspace gone: the
 * workspace after it, else the one before, and the pane its row opens. A tab or workspace opens at
 * the pane this browser last viewed there (`viewed`), as clicking it would. Null when `before` does
 * not hold the pane, or nothing is left.
 */
export function paneAfterClose(before: Roster, after: Roster, closed: string, previous: string | null, viewed?: Viewed): string | null {
  const pane = before.panes.find((candidate) => candidate.pane_id === closed);
  if (!pane) return null;
  const inTab = (id: string) => after.panes.some((candidate) => candidate.pane_id === id && candidate.tab_id === pane.tab_id);
  if (previous !== null && previous !== closed && inTab(previous)) return previous;
  const order = before.layouts?.find((layout) => layout.tab_id === pane.tab_id)?.panes.map((entry) => entry.pane_id)
    ?? before.panes.filter((candidate) => candidate.tab_id === pane.tab_id).map((candidate) => candidate.pane_id);
  const sibling = nearest(order, order.indexOf(closed), inTab);
  if (sibling) return sibling;
  const survivor = tabPane(after, pane.tab_id, viewed);
  if (survivor) return survivor;
  const tabs = before.tabs.filter((tab) => tab.workspace_id === pane.workspace_id).map((tab) => tab.tab_id);
  const tab = nearest(tabs, tabs.indexOf(pane.tab_id), (id) => after.tabs.some((candidate) => candidate.tab_id === id), true);
  if (tab) return tabPane(after, tab, viewed);
  const made = after.tabs.filter((candidate) => candidate.workspace_id === pane.workspace_id)
    .map((candidate) => tabPane(after, candidate.tab_id, viewed)).find((id) => id !== null);
  if (made) return made;
  const workspaces = before.workspaces.map((workspace) => workspace.workspace_id);
  const workspace = nearest(workspaces, workspaces.indexOf(pane.workspace_id), (id) => after.workspaces.some((candidate) => candidate.workspace_id === id));
  if (!workspace) return null;
  const remembered = viewed?.("workspace", workspace);
  return after.panes.some((candidate) => candidate.pane_id === remembered && candidate.workspace_id === workspace) ? remembered! : workspacePane(after, workspace);
}
