import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";

export function agentSections(rows: readonly AgentCatalogRow[]): { installed: AgentCatalogRow[]; available: AgentCatalogRow[] } {
  return {
    installed: rows.filter((row) => row.state.installed === true),
    available: rows.filter((row) => row.state.installed !== true),
  };
}

export function addableAgents(rows: readonly AgentCatalogRow[]): AgentCatalogRow[] {
  return rows.filter((row) => row.state.installed === false && row.install !== null && pickerStarts(row.id));
}

export function pickerStarts(agent: string): boolean {
  return SUPPORTED_AGENT_KINDS.has(agent);
}
