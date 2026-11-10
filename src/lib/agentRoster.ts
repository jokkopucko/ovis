/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in Activity order across PCs when Settings asks
 * for it. A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts all PCs' rows together. */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** Observed cross-PC recency, keyed by sidebarPinKey; native counters are PC-local. */
  recent: ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/** Agent rows as the list draws them: pinned first, then workspace or cross-PC Activity order. */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  const ordered = options.byActivity ? activityOrder(rows, ({ machine, entry }) => ({
    pane_id: sidebarPinKey(machine.id, entry.pane.pane_id), agent_status: entry.pane.agent_status,
  }), options.recent) : rows;
  return splitPinnedRows(ordered, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}
