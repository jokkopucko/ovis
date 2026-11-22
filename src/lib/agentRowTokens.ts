import type { AgentRowTokens } from "../../shared/pane-tokens.ts";

/**
 * The `$name` tokens herdr's `[ui.sidebar.agents]` rows draw, as the server reads them from the
 * herdr config of its PC (server/herdr-sidebar.ts) and tells them on the machine events.
 */
let current: AgentRowTokens | null = null;
const listeners = new Set<() => void>();

export function currentAgentRowTokens(): AgentRowTokens | null {
  return current;
}

export function setAgentRowTokens(next: AgentRowTokens | null): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeAgentRowTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
