import type { Machine } from "../../shared/machines.ts";
import { isBackgroundRole, ROLE_TOKEN } from "../../shared/pane-tokens.ts";
import { nestHelpers, sidebarAgents, type SidebarAgent } from "../../shared/agent-roster.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { knownStatus } from "./status.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";
import { nestRows } from "../../shared/attention.ts";

export { nestHelpers } from "../../shared/agent-roster.ts";

export { AGENT_GROUPS, agentGroup, groupAgentRows, type AgentGroup, type AgentGroupOptions } from "../../shared/attention.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  byActivity: boolean;
  /** Settings → Across PCs: Activity sorts all PCs' rows together, by the hub's change times (HerdrPane.changed_at) */
  acrossPcs?: boolean;
  seqs(machineId: string): ReadonlyMap<string, number>;
  pinned: readonly string[];
}

/**
 * Agent rows as the list draws them: pinned first, then workspace order, each PC's Activity order,
 * or Activity across PCs. Across PCs, rows the server has no change time for keep each PC's
 * Activity order after the dated ones, and the sort is nested again, so an agent's helpers stay
 * right under it.
 */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return nestHelpers(options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  if (!options.byActivity || !options.acrossPcs) return splitPinnedRows(rows, options.pinned, keyOf);
  // one clock for every PC: the hub's (server/agent-changes.ts), never two PCs' own counters
  const changedAt = new Map(rows.flatMap((row) => row.entry.pane.changed_at === undefined ? [] : [[keyOf(row), row.entry.pane.changed_at] as const]));
  const ordered = nestRows(activityOrder(rows, (row) => ({
    pane_id: keyOf(row), agent_status: row.entry.pane.agent_status,
  }), changedAt), keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  return splitPinnedRows(ordered, options.pinned, keyOf);
}

/**
 * Whether a launcher tagged the pane as a background agent: `herdr pane report-metadata <pane>
 * --token role=background` (any case, spaces around it ignored).
 */
export function isBackgroundAgent({ pane, agent }: SidebarAgent): boolean {
  return isBackgroundRole((pane.tokens ?? agent?.tokens)?.[ROLE_TOKEN]);
}

export function splitBackgroundRows(rows: readonly AgentRow[], status: (row: AgentRow) => AgentStatus | undefined, all: readonly AgentRow[] = rows): { people: AgentRow[]; background: AgentRow[] } {
  const byKey = new Map(all.map((row) => [sidebarPinKey(row.machine.id, row.entry.pane.pane_id), row]));
  const tagged = (row: AgentRow): boolean => {
    const passed = new Set<AgentRow>();
    for (let up: AgentRow | undefined = row; up && !passed.has(up); up = up.entry.pane.parent_pane_id === undefined ? undefined : byKey.get(sidebarPinKey(up.machine.id, up.entry.pane.parent_pane_id))) {
      if (isBackgroundAgent(up.entry)) return true;
      passed.add(up);
    }
    return false;
  };
  const people: AgentRow[] = [];
  const background: AgentRow[] = [];
  for (const row of rows) (tagged(row) && knownStatus(status(row)) !== "blocked" ? background : people).push(row);
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const nest = (part: AgentRow[]): AgentRow[] => nestRows(part, keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  return { people: nest(people), background: nest(background) };
}
