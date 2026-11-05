/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in that PC's own Activity order when Settings asks
 * for it (lib/sidebarOrder.ts). A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts each PC's rows by that PC's own counters */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/**
 * A PC's rows with each helper right under the agent that started it (herdr-core's `parent_pane_id`),
 * after that agent's earlier helpers. An agent and its helpers stand together where the first of
 * them stands in the given order, so in Activity order a blocked helper brings its agent up with it.
 * A row whose parent is not a row stays where it is.
 */
export function nestHelpers(entries: readonly SidebarAgent[]): SidebarAgent[] {
  const byId = new Map(entries.map((entry) => [entry.pane.pane_id, entry]));
  const parentOf = (entry: SidebarAgent): SidebarAgent | undefined => {
    const parent = entry.pane.parent_pane_id;
    return parent === undefined || parent === entry.pane.pane_id ? undefined : byId.get(parent);
  };
  const helpers = new Map<SidebarAgent, SidebarAgent[]>();
  for (const entry of entries) {
    const parent = parentOf(entry);
    if (parent) helpers.set(parent, [...(helpers.get(parent) ?? []), entry]);
  }
  /** the agent at the top of a row's helpers chain; in a loop (no top), the row itself */
  const rootOf = (entry: SidebarAgent): SidebarAgent => {
    const passed = new Set<SidebarAgent>([entry]);
    let root = entry;
    for (let up = parentOf(root); up; up = parentOf(up)) {
      if (passed.has(up)) return entry;
      passed.add(up);
      root = up;
    }
    return root;
  };
  const ordered: SidebarAgent[] = [];
  const seen = new Set<SidebarAgent>();
  const add = (entry: SidebarAgent): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    ordered.push(entry);
    for (const helper of helpers.get(entry) ?? []) add(helper);
  };
  for (const entry of entries) add(rootOf(entry));
  // a loop's rows not reached from the row that stood for it keep their place
  for (const entry of entries) add(entry);
  return ordered;
}

/** Every PC's agent rows as the list draws them: the pinned ones first, then the rest in source order. */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return nestHelpers(options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  return splitPinnedRows(rows, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}
