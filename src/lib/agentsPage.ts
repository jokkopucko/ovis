import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { AgentIntegration, MissingCommand, ProviderUsage, UsageProviderId } from "../../shared/protocol.ts";
import { agentSections } from "./agentList.ts";

/** One installed agent on Settings → Agents, with what Ovis knows of it on the PC shown. */
export interface AgentsPageRow {
  agent: AgentCatalogRow;
  /** the usage provider its sign-in is read as; null when Ovis reads none for it, or reads it on another PC */
  provider: UsageProviderId | null;
  /** that provider's accounts, the hub's included, in the order they came */
  accounts: ProviderUsage[];
  /** the command the server lacks to look for that provider's sign-in (`secret-tool`); null when it lacks none */
  missing: string | null;
  /** herdr's integration for it, when herdr has one */
  integration: AgentIntegration | null;
}

export interface AgentsPage {
  /** the agents the PC has, in the catalog's order */
  rows: AgentsPageRow[];
  /** providers with accounts that no row lists (Cursor, an agent not on this PC), in the order they came */
  otherProviders: UsageProviderId[];
  /** herdr's integrations no row shows: agents not on the PC, or ones the catalog does not know; found ones first */
  otherIntegrations: AgentIntegration[];
  /** what the PC surely lacks and can install: one it cannot tell about offers no Install */
  installable: AgentCatalogRow[];
}

function integrationFor(agent: AgentCatalogRow, integrations: readonly AgentIntegration[]): AgentIntegration | null {
  return integrations.find((integration) => integration.target === agent.id || agent.detect.binaries.includes(integration.command)) ?? null;
}

/**
 * Settings → Agents from the PC's catalog, the usage accounts and herdr's integrations. An account
 * goes under the one installed agent that signs in to its provider (`sign_in.provider`), never under
 * two. The accounts are read on the PC Ovis's server runs on, so `accountsHere` false (another PC
 * shown) lists them all apart rather than under that PC's agents.
 */
export function agentsPage({ agents, providers, missing = [], integrations, accountsHere }: {
  agents: readonly AgentCatalogRow[];
  providers: readonly ProviderUsage[];
  /** the usage report's `missing_commands` */
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
    otherIntegrations: integrations.filter((integration) => !rows.some((entry) => entry.integration?.target === integration.target))
      .sort((a, b) => Number(b.available) - Number(a.available)),
    installable: available.filter((agent) => agent.state.installed === false && agent.install !== null),
  };
}

/** What a row says of its sign-in: only what the usage accounts show, never a guess. */
export type SignInState =
  /** no provider Ovis reads, or plan limits are off (nothing is read then) */
  | { kind: "unknown" }
  | { kind: "none" }
  /** no account, and the server could not look where one may be: `command` is not installed there */
  | { kind: "unreadable"; command: string }
  | { kind: "signed-in"; count: number; account: string | null }
  | { kind: "problem"; count: number; problems: number };

export function signInState(provider: UsageProviderId | null, accounts: readonly ProviderUsage[], read: boolean, missing: string | null = null): SignInState {
  if (provider === null || !read) return { kind: "unknown" };
  if (accounts.length === 0) return missing === null ? { kind: "none" } : { kind: "unreadable", command: missing };
  const problems = accounts.filter((usage) => usage.problem !== null).length;
  if (problems > 0) return { kind: "problem", count: accounts.length, problems };
  return { kind: "signed-in", count: accounts.length, account: accounts.length === 1 ? accounts[0]!.account : null };
}
