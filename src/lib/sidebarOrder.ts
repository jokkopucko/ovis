import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { knownStatus, paneStatus } from "./status.ts";

export { activityOrder, liveSeqs, newSeqMemory, stateSeqs, type SeqMemory } from "../../shared/attention.ts";

export type SeenRecord = Readonly<Record<string, number>>;

type FinishPane = Pick<HerdrPane, "pane_id" | "agent_status" | "finish_id" | "background_wait">;
export function isSeenDone(pane: FinishPane, seen: SeenRecord): boolean {
  return knownStatus(pane.agent_status) === "done" && pane.finish_id !== undefined
    && pane.finish_id > 0 && (seen[pane.pane_id] ?? 0) >= pane.finish_id;
}

export function shownStatus(pane: FinishPane, seen: SeenRecord | null): AgentStatus | undefined {
  if (pane.background_wait) return paneStatus(pane);
  return seen && isSeenDone(pane, seen) ? "idle" : pane.agent_status;
}
