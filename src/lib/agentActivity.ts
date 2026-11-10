import type { Machine } from "../../shared/machines.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

interface Observation { epoch: string | undefined; seqs: ReadonlyMap<string, number> }
export interface AgentActivityMemory {
  machines: Map<string, Observation>;
  recent: Map<string, number>;
  clock: number;
}
export const newAgentActivityMemory = (): AgentActivityMemory => ({ machines: new Map(), recent: new Map(), clock: 0 });

/** Machine counters have unrelated origins. Only changes observed here can be compared across PCs. */
export function agentActivity(machines: readonly Machine[], seqs: (id: string) => ReadonlyMap<string, number>, memory: AgentActivityMemory): ReadonlyMap<string, number> {
  const open = new Set<string>();
  for (const machine of machines) {
    const current = seqs(machine.id);
    const before = memory.machines.get(machine.id);
    const epoch = machine.snapshot?.finish_epoch;
    const reset = before && (before.epoch !== epoch || [...current].some(([id, seq]) => seq < (before.seqs.get(id) ?? seq)));
    for (const pane of machine.snapshot?.panes ?? []) open.add(sidebarPinKey(machine.id, pane.pane_id));
    if (reset) for (const id of before.seqs.keys()) memory.recent.delete(sidebarPinKey(machine.id, id));
    // Initial snapshots and reconnects supply history, not a new event for every agent.
    if (machine.state !== "connected" || !machine.snapshot) continue;
    if (before && !reset) {
      const changed = [...current].filter(([id, seq]) => before.seqs.has(id) && seq > before.seqs.get(id)!);
      // Preserve native order when several changes arrive in the same snapshot.
      changed.sort((a, b) => a[1] - b[1]);
      for (const [id] of changed) memory.recent.set(sidebarPinKey(machine.id, id), ++memory.clock);
    }
    memory.machines.set(machine.id, { epoch, seqs: new Map(current) });
  }
  const present = new Set(machines.map((machine) => machine.id));
  for (const id of memory.machines.keys()) if (!present.has(id)) memory.machines.delete(id);
  for (const key of memory.recent.keys()) if (!open.has(key)) memory.recent.delete(key);
  return new Map(memory.recent);
}
