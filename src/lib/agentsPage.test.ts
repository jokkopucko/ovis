import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, catalogRow, type AgentInstallState } from "../../shared/agent-catalog.ts";
import type { AgentIntegration, ProviderUsage } from "../../shared/protocol.ts";
import { agentsPage, signInState } from "./agentsPage.ts";

const missing: AgentInstallState = { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
const found = (version: string): AgentInstallState => ({ installed: true, binary: "/usr/bin/x", on_path: true, version, version_error: null, meets_min_version: true });
const row = (id: string, state: AgentInstallState = missing) => catalogRow(AGENT_CATALOG.find((entry) => entry.id === id)!, "linux", state);
const account = (id: ProviderUsage["id"], key: string, problem: ProviderUsage["problem"] = null): ProviderUsage =>
  ({ id, key, account: key, plan: null, windows: [], problem, checked_at: null });
const integration = (target: string, command: string, state: AgentIntegration["state"] = "current", available = true): AgentIntegration =>
  ({ target, label: target, command, available, state });

describe("agentsPage", () => {
  const agents = [row("claude", found("2.1.311")), row("codex", found("0.163.0")), row("copilot"), row("omo", found("3.4.0")), row("agy", found("1.4.4"))];
  const providers = [account("claude", "claude:a"), account("cursor", "cursor:me"), account("claude", "claude:cliproxy:team"), account("copilot", "copilot:me"), account("codex", "codex:b", "expired")];

  it("puts each account under the installed agent that signs in to its provider, hub accounts included", () => {
    const page = agentsPage({ agents, providers, integrations: [], accountsHere: true });
    expect(page.rows.map((entry) => entry.agent.id)).toEqual(["claude", "codex", "omo", "agy"]);
    expect(page.rows.map((entry) => entry.accounts.map((usage) => usage.key))).toEqual([["claude:a", "claude:cliproxy:team"], ["codex:b"], [], []]);
    expect(page.rows.map((entry) => entry.provider)).toEqual(["claude", "codex", null, "antigravity"]);
  });

  it("gives the row the command its provider's sign-in could not be read without", () => {
    const page = agentsPage({ agents, providers, missing: [{ provider: "antigravity", command: "secret-tool" }], integrations: [], accountsHere: true });
    expect(page.rows.map((entry) => entry.missing)).toEqual([null, null, null, "secret-tool"]);
  });

  it("lists under Other accounts the providers no installed agent signs in to, in the order they came", () => {
    // Cursor has no agent in the catalog; Copilot's agent is not on this PC
    expect(agentsPage({ agents, providers, integrations: [], accountsHere: true }).otherProviders).toEqual(["cursor", "copilot"]);
  });

  it("keeps every account under Other accounts when they were read on another PC than the one shown", () => {
    const page = agentsPage({ agents, providers, integrations: [], accountsHere: false });
    expect(page.rows.every((entry) => entry.provider === null && entry.accounts.length === 0)).toBe(true);
    expect(page.otherProviders).toEqual(["claude", "cursor", "copilot", "codex"]);
  });

  it("offers to install only what the PC surely lacks and has a command for", () => {
    const page = agentsPage({ agents: [...agents, row("muse")], providers: [], integrations: [], accountsHere: true });
    // muse has no install command on Linux
    expect(page.installable.map((agent) => agent.id)).toEqual(["copilot"]);
  });

  it("matches herdr's integration to the agent by its target or its executable, and keeps every other one, found ones first", () => {
    const integrations = [integration("claude", "claude"), integration("antigravity_cli", "agy", "outdated"), integration("droid", "droid", "not_installed"), integration("kimi", "kimi", "not_installed", false), integration("codex", "codex", "not_installed"), integration("copilot", "copilot", "not_installed", false)];
    const page = agentsPage({ agents, providers: [], integrations, accountsHere: true });
    expect(page.rows.map((entry) => entry.integration?.target ?? null)).toEqual(["claude", "codex", null, "antigravity_cli"]);
    // droid is on the PC without a catalog row; kimi is not on the PC at all; copilot's agent is not installed
    expect(page.otherIntegrations.map((entry) => entry.target)).toEqual(["droid", "kimi", "copilot"]);
  });
});

describe("signInState", () => {
  it("says nothing it cannot read: no provider, or plan limits off", () => {
    expect(signInState(null, [], true)).toEqual({ kind: "unknown" });
    expect(signInState("claude", [account("claude", "claude:a")], false)).toEqual({ kind: "unknown" });
  });

  it("tells signed in, not signed in, and expired accounts apart", () => {
    expect(signInState("codex", [], true)).toEqual({ kind: "none" });
    expect(signInState("claude", [account("claude", "claude:a")], true)).toEqual({ kind: "signed-in", count: 1, account: "claude:a" });
    expect(signInState("claude", [account("claude", "claude:a"), account("claude", "claude:b", "expired")], true)).toEqual({ kind: "problem", count: 2, problems: 1 });
  });

  it("names the missing command rather than no sign-in when the server could not look", () => {
    expect(signInState("antigravity", [], true, "secret-tool")).toEqual({ kind: "unreadable", command: "secret-tool" });
    expect(signInState("antigravity", [account("antigravity", "antigravity:a")], true, "secret-tool")).toEqual({ kind: "signed-in", count: 1, account: "antigravity:a" });
  });
});
