import type { AgentIntegration } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

export type IntegrationsOutcome =
  | { kind: "list"; integrations: AgentIntegration[] }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export interface IntegrationsResult {
  machineId: string;
  outcome: IntegrationsOutcome;
}

export async function loadIntegrations(fetchList: () => Promise<AgentIntegration[]>): Promise<IntegrationsOutcome> {
  try {
    return { kind: "list", integrations: await fetchList() };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { kind: "unsupported" };
    return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function outcomeFor(result: IntegrationsResult | null, machineId: string): IntegrationsOutcome | null {
  return result !== null && result.machineId === machineId ? result.outcome : null;
}
