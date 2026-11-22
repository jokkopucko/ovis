import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { AgentIntegration, MissingCommand, ProviderUsage, UsageProviderId } from "../../shared/protocol.ts";
import { agentSections } from "./agentList.ts";
import { isSignIn } from "./usage.ts";

export interface AgentsPageRow {
  agent: AgentCatalogRow;
  provider: UsageProviderId | null;
  accounts: ProviderUsage[];
  missing: string | null;
  integration: AgentIntegration | null;
}

export interface AgentsPage {
  rows: AgentsPageRow[];
  otherProviders: UsageProviderId[];
  /**
   * herdr's integrations no row shows: agents not on the PC, or ones the catalog does not know; found
   * ones first. One with neither its agent nor its hook on the PC is left out: herdr lists every
   * built-in one, so it would only say what the PC does not have (Install another agent offers those).
   */
  otherIntegrations: AgentIntegration[];
  installable: AgentCatalogRow[];
  installsUnknown: boolean;
}

function integrationFor(agent: AgentCatalogRow, integrations: readonly AgentIntegration[]): AgentIntegration | null {
  return integrations.find((integration) => integration.target === agent.id || agent.detect.binaries.includes(integration.command)) ?? null;
}

export function agentsPage({ agents, providers, missing = [], integrations, accountsHere }: {
  agents: readonly AgentCatalogRow[];
  providers: readonly ProviderUsage[];
  missing?: readonly MissingCommand[];
  integrations: readonly AgentIntegration[];
  accountsHere: boolean;
}): AgentsPage {
  const { installed, available } = agentSections(agents);
  const claimed = new Set<UsageProviderId>();
  const rows = installed.map((agent): AgentsPageRow => {
    const wanted = accountsHere ? agent.sign_in?.provider ?? null : null;
    const provider = wanted !== null && !claimed.has(wanted) ? wanted : null;
    if (provider !== null) claimed.add(provider);
    return {
      agent, provider, accounts: provider === null ? [] : providers.filter((usage) => usage.id === provider),
      missing: missing.find((entry) => entry.provider === provider)?.command ?? null, integration: integrationFor(agent, integrations),
    };
  });
  return {
    rows,
    otherProviders: [...new Set(providers.map((usage) => usage.id))].filter((id) => !claimed.has(id)),
    otherIntegrations: integrations.filter((integration) => !rows.some((entry) => entry.integration?.target === integration.target)
      && (integration.available || integration.state !== "not_installed"))
      .sort((a, b) => Number(b.available) - Number(a.available)),
    installable: available.filter((agent) => agent.state.installed === false && agent.install !== null),
    installsUnknown: agents.length > 0 && agents.every((agent) => agent.state.installed === null),
  };
}

export type SignInState =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "unreadable"; command: string }
  | { kind: "signed-in"; count: number; account: string | null }
  | { kind: "problem"; count: number; problems: number };

export function signInState(provider: UsageProviderId | null, accounts: readonly ProviderUsage[], read: boolean, missing: string | null = null): SignInState {
  if (provider === null || !read) return { kind: "unknown" };
  const signIns = accounts.filter(isSignIn);
  if (signIns.length === 0) return missing === null ? { kind: "none" } : { kind: "unreadable", command: missing };
  const problems = signIns.filter((usage) => usage.problem !== null).length;
  if (problems > 0) return { kind: "problem", count: signIns.length, problems };
  return { kind: "signed-in", count: signIns.length, account: signIns.length === 1 ? signIns[0]!.account : null };
}
