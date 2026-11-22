import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, WorkspaceInfo } from "../../shared/protocol.ts";
import type { Translate } from "./i18n.ts";
import { filterPanesByStatus, scorePanes, type PaletteStatusFilter } from "./paletteSearch.ts";
import type { WorkspaceBranch } from "./worktreeBranches.ts";

export interface RecentPane { machineId: string; paneId: string }
export interface MachinePane extends RecentPane { machine: Machine; pane: HerdrPane }
export type MachineBranches = ReadonlyMap<string, ReadonlyMap<string, WorkspaceBranch>>;
export const RECENT_KEY = "ovis:recent-targets";
const LEGACY_RECENT_KEY = "ovis:recent-panes";
const RECENT_LIMIT = 8;

/** A tuple is unambiguous even when remote IDs contain separators or match a local pane ID. */
export function targetKey({ machineId, paneId }: RecentPane): string { return JSON.stringify([machineId, paneId]); }
export function workspaceKey(machineId: string, workspaceId: string): string { return JSON.stringify([machineId, workspaceId]); }

export function availableTarget(machines: readonly Machine[], target: RecentPane): MachinePane | null {
  const machine = machines.find((item) => item.id === target.machineId && item.state === "connected");
  const pane = machine?.snapshot?.panes.find((item) => item.pane_id === target.paneId);
  return machine && pane ? { ...target, machine, pane } : null;
}

export function rankMachinePanes(query: string, machines: readonly Machine[], filter: PaletteStatusFilter, branches: MachineBranches, t: Translate): MachinePane[] {
  const ranked = machines.flatMap((machine) => {
    const snapshot = machine.snapshot;
    if (machine.state !== "connected" || !snapshot) return [];
    return scorePanes(query, filterPanesByStatus(snapshot.panes, filter), snapshot.workspaces,
      { tabs: snapshot.tabs, branches: branches.get(machine.id), machineName: machine.name, t })
      .map(({ pane, score }) => ({ machineId: machine.id, paneId: pane.pane_id, machine, pane, score }));
  });
  return ranked.sort((a, b) => b.score - a.score);
}

export interface MachinePaneGroup { id: string; machine: Machine; workspaceId: string; workspace: WorkspaceInfo | undefined; panes: MachinePane[] }
export function groupMachinePanes(panes: readonly MachinePane[], machines: readonly Machine[], ranked: boolean): MachinePaneGroup[] {
  const groups = new Map<string, MachinePaneGroup>();
  for (const entry of panes) {
    const workspaceId = entry.pane.workspace_id;
    const id = workspaceKey(entry.machineId, workspaceId);
    let group = groups.get(id);
    if (!group) {
      group = { id, machine: entry.machine, workspaceId, workspace: entry.machine.snapshot?.workspaces.find((workspace) => workspace.workspace_id === workspaceId), panes: [] };
      groups.set(id, group);
    }
    group.panes.push(entry);
  }
  const list = [...groups.values()];
  if (ranked) return list;
  const order = new Map<string, number>();
  for (const machine of machines) {
    for (const workspace of machine.snapshot?.workspaces ?? []) order.set(workspaceKey(machine.id, workspace.workspace_id), order.size);
    for (const group of list) if (group.machine.id === machine.id && !order.has(group.id)) order.set(group.id, order.size);
  }
  return list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export function rememberTarget(target: RecentPane, current: readonly RecentPane[]): RecentPane[] {
  return [target, ...current.filter((item) => targetKey(item) !== targetKey(target))].slice(0, RECENT_LIMIT);
}
export function recentTargets(panes: readonly MachinePane[], recent: readonly RecentPane[], selected: RecentPane | null, limit: number): MachinePane[] {
  const byId = new Map(panes.map((pane) => [targetKey(pane), pane]));
  const selectedKey = selected && targetKey(selected);
  return recent.flatMap((target) => { const pane = byId.get(targetKey(target)); return pane && targetKey(target) !== selectedKey ? [pane] : []; }).slice(0, limit);
}

export function loadRecentTargets(read: (key: string) => string | null, machineIds: readonly string[]): RecentPane[] {
  try {
    const stored = read(RECENT_KEY);
    const rows: RecentPane[] = [];
    if (stored !== null) {
      const value: unknown = JSON.parse(stored);
      if (!Array.isArray(value)) return [];
      for (const item of value) {
        if (item && typeof item === "object" && typeof item.machineId === "string" && typeof item.paneId === "string") rows.push({ machineId: item.machineId, paneId: item.paneId });
      }
    } else {
      for (const machineId of machineIds) {
        let value: unknown;
        try { value = JSON.parse(read(machineId === "local" ? LEGACY_RECENT_KEY : `${LEGACY_RECENT_KEY}:${machineId}`) ?? "[]"); } catch { continue; }
        if (Array.isArray(value)) for (const paneId of value) if (typeof paneId === "string") rows.push({ machineId, paneId });
      }
    }
    const seen = new Set<string>();
    return rows.filter((item) => { const key = targetKey(item); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, RECENT_LIMIT);
  } catch { return []; }
}
