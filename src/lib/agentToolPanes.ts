import { useSyncExternalStore } from "react";
import type { AgentToolPanes } from "../../shared/harness-tool.ts";

/** This PC's panes that asked its owner for the agent tool (`agent-tool-panes`): his windows alone hear of them. */
const NONE: AgentToolPanes = { pending: [], allowed: [] };
let current = NONE;
const listeners = new Set<() => void>();

export function heardAgentToolPanes({ pending, allowed }: AgentToolPanes): void {
  current = { pending, allowed };
  for (const listener of listeners) listener();
}
export function useAgentToolPanes(): AgentToolPanes {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => current);
}
