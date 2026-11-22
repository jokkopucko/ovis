import type { HerdrPane, PluginAction, PluginActions, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { t as moduleT, type Translate } from "./i18n.ts";
import { paneStatus, type KnownStatus } from "./status.ts";
import { tabLabel } from "./tabName.ts";

export type PaletteStatusFilter = "all" | Exclude<KnownStatus, "unknown">;

export const STATUS_FILTERS: readonly PaletteStatusFilter[] = ["all", "blocked", "working", "idle", "done", "waiting"];

/**
 * herdr's picker keys as they are: b blocked, w working, i idle, d done, a all. The palette
 * listens for them only while the focus is outside its search field, so a query never loses a
 * letter to them. BG has no key in herdr and gets none here.
 */
export const FILTER_KEYS: Readonly<Record<string, PaletteStatusFilter>> = { a: "all", b: "blocked", w: "working", i: "idle", d: "done" };

export function filterKeyOf(filter: PaletteStatusFilter): string | null {
  return Object.entries(FILTER_KEYS).find(([, value]) => value === filter)?.[0] ?? null;
}

export interface PaletteQuery {
  actionsOnly: boolean;
  text: string;
}

/** A query that starts with `>` searches the actions alone, as T3 Code's palette reads that prefix. */
export function parseQuery(query: string): PaletteQuery {
  const trimmed = query.trimStart();
  if (trimmed.startsWith(">")) return { actionsOnly: true, text: trimmed.slice(1).trim() };
  return { actionsOnly: false, text: query.trim() };
}

export function filterPanesByStatus(panes: readonly HerdrPane[], filter: PaletteStatusFilter): HerdrPane[] {
  if (filter === "all") return [...panes];
  return panes.filter((pane) => paneStatus(pane) === filter);
}

export function statusCounts(panes: readonly HerdrPane[]): Record<PaletteStatusFilter, number> {
  const counts: Record<PaletteStatusFilter, number> = { all: panes.length, blocked: 0, working: 0, idle: 0, done: 0, waiting: 0 };
  for (const pane of panes) {
    const status = paneStatus(pane);
    if (status !== "unknown") counts[status] += 1;
  }
  return counts;
}

export interface PaletteSearchContext {
  tabs?: readonly TabInfo[];
  machineName?: string;
  branches?: ReadonlyMap<string, { branch: string | null }>;
  t?: Translate;
}

/**
 * What a tab can be found by: its label as herdr holds it, and the name the UI shows for it
 * ("Tab 2" for a tab herdr still names by its place), when the two differ.
 */
function tabNames(tabs: readonly TabInfo[], t: Translate): Map<string, string[]> {
  const names = new Map<string, string[]>();
  const placed = new Map<string, number>();
  for (const tab of tabs) {
    const place = (placed.get(tab.workspace_id) ?? 0) + 1;
    placed.set(tab.workspace_id, place);
    const shown = tabLabel(tab, t, place);
    names.set(tab.tab_id, shown === tab.label ? [tab.label] : [tab.label, shown]);
  }
  return names;
}

export interface OfferedPluginAction {
  plugin: PluginActions;
  action: PluginAction;
}

/**
 * The plugin actions the palette can run now. A disabled plugin's are left out (herdr refuses
 * them), as is one that only applies to selected text, which the web has none of to hand over.
 * Without a selected pane only an action that needs no place is offered: herdr would otherwise
 * run it against its own focus, a pane the user is not looking at here.
 */
export function offeredPluginActions(plugins: readonly PluginActions[], hasPane: boolean, query: string): OfferedPluginAction[] {
  const needle = query.trim().toLocaleLowerCase();
  const offered: OfferedPluginAction[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const action of plugin.actions) {
      const anywhere = action.contexts.length === 0 || action.contexts.includes("global");
      const placed = action.contexts.some((context) => context === "workspace" || context === "tab" || context === "pane");
      if (!anywhere && !(hasPane && placed)) continue;
      if (needle && !action.title.toLocaleLowerCase().includes(needle) && !plugin.name.toLocaleLowerCase().includes(needle)) continue;
      offered.push({ plugin, action });
    }
  }
  return offered;
}

function fuzzyScore(query: string, candidate: string): number | null {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return 0;
  const haystack = candidate.toLocaleLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 1000 - direct * 2 - (haystack.length - needle.length);

  let queryIndex = 0;
  let first = -1;
  let previous = -2;
  let runs = 0;
  for (let index = 0; index < haystack.length && queryIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[queryIndex]) continue;
    if (first < 0) first = index;
    if (index !== previous + 1) runs += 1;
    previous = index;
    queryIndex += 1;
  }
  if (queryIndex !== needle.length) return null;
  return 500 - first * 2 - (previous - first) - runs * 12;
}

export function matchesQuery(query: string, candidate: string): boolean {
  return fuzzyScore(query, candidate) !== null;
}

function searchableText(pane: HerdrPane, workspaceLabel: string, tabNames: readonly string[], branch: string): string[] {
  return [
    pane.label ?? "",
    pane.title ?? "",
    pane.terminal_title_stripped ?? "",
    pane.terminal_title ?? "",
    pane.cwd ?? "",
    pane.foreground_cwd ?? "",
    workspaceLabel,
    ...tabNames,
    branch,
    pane.agent ?? "",
    pane.display_agent ?? "",
  ];
}

export function scorePanes(query: string, panes: readonly HerdrPane[], workspaces: readonly WorkspaceInfo[], context: PaletteSearchContext = {}): { pane: HerdrPane; score: number }[] {
  if (query.trim().length === 0) return panes.map((pane) => ({ pane, score: 0 }));
  const workspaceLabels = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
  const tabsByName = tabNames(context.tabs ?? [], context.t ?? moduleT);
  return panes
    .map((pane, index) => {
      let score: number | null = null;
      const branch = context.branches?.get(pane.workspace_id)?.branch ?? "";
      for (const candidate of [...searchableText(pane, workspaceLabels.get(pane.workspace_id) ?? "", tabsByName.get(pane.tab_id) ?? [], branch), context.machineName ?? ""]) {
        const candidateScore = fuzzyScore(query, candidate);
        if (candidateScore !== null && (score === null || candidateScore > score)) score = candidateScore;
      }
      return { pane, index, score };
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ pane, score }) => ({ pane, score }));
}

export function rankPanes(query: string, panes: readonly HerdrPane[], workspaces: readonly WorkspaceInfo[], context: PaletteSearchContext = {}): HerdrPane[] {
  return scorePanes(query, panes, workspaces, context).map(({ pane }) => pane);
}

export interface PaletteSection {
  workspaceId: string;
  workspace: WorkspaceInfo | undefined;
  panes: HerdrPane[];
}

/** One section per workspace, as herdr's Goto picker lists its rows. */
export function groupByWorkspace(panes: readonly HerdrPane[], workspaces: readonly WorkspaceInfo[], ranked = false): PaletteSection[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  const sections = new Map<string, PaletteSection>();
  for (const pane of panes) {
    let section = sections.get(pane.workspace_id);
    if (!section) {
      section = { workspaceId: pane.workspace_id, workspace: byId.get(pane.workspace_id), panes: [] };
      sections.set(pane.workspace_id, section);
    }
    section.panes.push(pane);
  }
  const list = [...sections.values()];
  if (ranked) return list;
  const order = new Map(workspaces.map((workspace, index) => [workspace.workspace_id, index]));
  return list.sort((a, b) => (order.get(a.workspaceId) ?? workspaces.length) - (order.get(b.workspaceId) ?? workspaces.length));
}

export function recentPanes(panes: readonly HerdrPane[], recentIds: readonly string[], selectedPaneId: string | null, limit: number): HerdrPane[] {
  const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
  const recent: HerdrPane[] = [];
  for (const id of recentIds) {
    const pane = byId.get(id);
    if (pane && id !== selectedPaneId) recent.push(pane);
    if (recent.length === limit) break;
  }
  return recent;
}
