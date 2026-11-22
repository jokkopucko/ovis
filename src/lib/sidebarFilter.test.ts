import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, HerdrPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import { matchesQuery } from "./paletteSearch.ts";
import { filterSuggestions, filterWorkspaceGroups, machineFilter, paneLabels, sidebarFilter, workspaceLabels } from "./sidebarFilter.ts";
import { sidebarAgents } from "./sidebarAgents.ts";
import { splitPinnedGroups, splitPinnedRows } from "./sidebarPins.ts";
import { worktreeGroups } from "./workspaceOrder.ts";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function workspace(id: string, label: string, worktree?: { repo_key: string; repo_name: string; linked: boolean }): WorkspaceInfo {
  return {
    workspace_id: id, label, active_tab_id: `${id}:t1`, agent_status: "idle", focused: false, number: 1, pane_count: 1, tab_count: 1,
    ...(worktree ? { worktree: { repo_key: worktree.repo_key, repo_name: worktree.repo_name, repo_root: `/repos/${worktree.repo_name}`, checkout_path: `/repos/${worktree.repo_name}/${id}`, is_linked_worktree: worktree.linked } } : {}),
  };
}

function tab(id: string, workspaceId: string, label = "1"): TabInfo {
  return { tab_id: id, workspace_id: workspaceId, label, number: 1, agent_status: "idle", focused: false, pane_count: 1 };
}

function pane(id: string, workspaceId: string, fields: Partial<HerdrPane> = {}): HerdrPane {
  return { pane_id: id, workspace_id: workspaceId, tab_id: `${workspaceId}:t1`, terminal_id: `term-${id}`, agent_status: "idle", focused: false, revision: 1, ...fields };
}

function agent(paneId: string, workspaceId: string, kind: string, fields: Partial<AgentInfo> = {}): AgentInfo {
  return { pane_id: paneId, workspace_id: workspaceId, tab_id: `${workspaceId}:t1`, agent: kind, agent_status: "idle", ...fields } as AgentInfo;
}

function laptop(): SessionSnapshot {
  return {
    workspaces: [
      workspace("api", "checkout-api", { repo_key: "api", repo_name: "checkout-api", linked: false }),
      workspace("guard", "export-guard", { repo_key: "api", repo_name: "checkout-api", linked: true }),
      workspace("flaky", "flaky-retry-test", { repo_key: "api", repo_name: "checkout-api", linked: true }),
      workspace("docs", "docs-site"),
    ],
    tabs: [tab("api:t1", "api"), tab("api:t2", "api", "release"), tab("guard:t1", "guard"), tab("flaky:t1", "flaky"), tab("docs:t1", "docs")],
    panes: [
      pane("api:p1", "api", { label: "Idempotent payments", agent: "claude", cwd: "/home/me/secret-api-folder" }),
      pane("api:p2", "api", { tab_id: "api:t2", terminal_title: "zsh", cwd: "/home/me/secret-api-folder" }),
      pane("guard:p1", "guard", { label: "Guard the export button", agent: "codex", cwd: "/home/me/hidden-guard" }),
      pane("flaky:p1", "flaky", { label: "Fix the flaky retry test", agent: "claude", cwd: "/home/me/hidden-flaky" }),
      pane("docs:p1", "docs", { label: "Proofread the guide", agent: "omo", cwd: "/home/me/hidden-docs" }),
    ],
    agents: [agent("api:p1", "api", "claude"), agent("guard:p1", "guard", "codex"), agent("flaky:p1", "flaky", "claude"), agent("docs:p1", "docs", "omo")],
    layouts: [],
  } as unknown as SessionSnapshot;
}

function buildPc(): SessionSnapshot {
  return {
    workspaces: [workspace("pay", "payments"), workspace("tmp", "scratch")],
    tabs: [tab("pay:t1", "pay"), tab("tmp:t1", "tmp")],
    panes: [
      pane("pay:p1", "pay", { label: "Nightly settlement", agent: "claude", cwd: "/srv/hidden-pay" }),
      pane("tmp:p1", "tmp", { cwd: "/srv/private/transcripts", terminal_title: "/srv/private/transcripts" }),
    ],
    agents: [agent("pay:p1", "pay", "claude", { name: "Maru", display_agent: "Claude Code" })],
    layouts: [],
  } as unknown as SessionSnapshot;
}

function machines(): Machine[] {
  return [
    { id: "local", name: "Laptop", kind: "local", enabled: true, state: "connected", error: null, snapshot: laptop() },
    { id: "build", name: "Build PC", kind: "ssh", enabled: true, state: "connected", error: null, snapshot: buildPc() },
  ];
}

const nobody = { machineId: "local", paneId: null };
const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("sidebarFilter", () => {
  it("matches labels with palette fuzzy semantics", () => {
    expect(matchesQuery("frt", "flaky-retry-test")).toBe(true);
    expect(matchesQuery("zzq", "flaky-retry-test")).toBe(false);
    const substring = sidebarFilter("retry", machines(), nobody, t);
    expect(substring.active).toBe(true);
    expect(sorted(machineFilter(substring, "local")!.matchedWorkspaces)).toEqual(["flaky"]);
    expect(sorted(machineFilter(substring, "local")!.matchedPanes)).toEqual(["flaky:p1"]);
    const scattered = sidebarFilter("fkrt", machines(), nobody, t);
    expect(sorted(machineFilter(scattered, "local")!.matchedWorkspaces)).toEqual(["flaky"]);
    expect(sidebarFilter("zzq", machines(), nobody, t).matches).toBe(0);
    const byBranch = sidebarFilter("main", machines(), nobody, t, new Map([["local", new Map([["api", "main"]])]]));
    expect(sorted(machineFilter(byBranch, "local")!.matchedWorkspaces)).toEqual(["api", "flaky", "guard"]);
    expect(machineFilter(sidebarFilter("main", machines(), nobody, t), "local")!.matchedWorkspaces.size).toBe(0);
    const renamedHead = machines();
    renamedHead[0]!.snapshot!.workspaces[0]!.label = "payments-service";
    expect(machineFilter(sidebarFilter("checkout", renamedHead, nobody, t), "local")!.matchedWorkspaces.size).toBe(0);
    expect(sorted(machineFilter(sidebarFilter("codex", machines(), nobody, t), "local")!.matchedPanes)).toEqual(["guard:p1"]);
    expect(sorted(machineFilter(sidebarFilter("maru", machines(), nobody, t), "build")!.matchedPanes)).toEqual(["pay:p1"]);
    expect(sorted(machineFilter(sidebarFilter("Tab 1", machines(), nobody, t), "local")!.matchedPanes)).toEqual(["api:p1"]);
    const byPc = sidebarFilter("build", machines(), nobody, t);
    expect(machineFilter(byPc, "build")!.matched).toBe(true);
    expect(sorted(machineFilter(byPc, "build")!.matchedWorkspaces)).toEqual(["pay", "tmp"]);
    expect(sorted(machineFilter(byPc, "build")!.matchedPanes)).toEqual(["pay:p1", "tmp:p1"]);
    expect(machineFilter(byPc, "local")!.shown).toBe(true);
    expect(machineFilter(byPc, "local")!.matchedWorkspaces.size).toBe(0);
    expect(sidebarFilter("   ", machines(), nobody, t).active).toBe(false);
    expect(machineFilter(sidebarFilter("", machines(), nobody, t), "local")).toBeNull();
  });

  it("keeps a match's ancestors and descendants, and reveals a folded match", () => {
    const child = machineFilter(sidebarFilter("export", machines(), nobody, t), "local")!;
    expect(sorted(child.workspaces)).toEqual(["api", "guard"]);
    expect(sorted(child.matchedWorkspaces)).toEqual(["guard"]);
    expect(sorted(child.revealedWorkspaces)).toEqual(["guard"]);
    expect(sorted(child.panes)).toEqual(["guard:p1"]);
    const head = machineFilter(sidebarFilter("checkout", machines(), nobody, t), "local")!;
    expect(sorted(head.workspaces)).toEqual(["api", "flaky", "guard"]);
    expect(sorted(head.matchedWorkspaces)).toEqual(["api", "flaky", "guard"]);
    expect(sorted(head.panes)).toEqual(["api:p1", "api:p2", "flaky:p1", "guard:p1"]);
    expect(sorted(head.revealedWorkspaces)).toEqual(["api", "flaky", "guard"]);
    const byPane = machineFilter(sidebarFilter("proofread", machines(), nobody, t), "local")!;
    expect(sorted(byPane.workspaces)).toEqual(["docs"]);
    expect(byPane.matchedWorkspaces.size).toBe(0);
    expect(sorted(byPane.revealedWorkspaces)).toEqual(["docs"]);
  });

  it("preserves pin and PC order", () => {
    const roster = machines();
    const filter = sidebarFilter("a", roster, nobody, t);
    expect(sorted(machineFilter(filter, "local")!.workspaces)).toEqual(["api", "docs", "flaky", "guard"]);
    expect(sorted(machineFilter(filter, "build")!.workspaces)).toEqual(["pay", "tmp"]);
    const groups = worktreeGroups(laptop().workspaces);
    const pinned = splitPinnedGroups(groups, ["flaky", "docs"], (workspace) => workspace.workspace_id);
    const kept = machineFilter(sidebarFilter("t", roster, nobody, t), "local")!.workspaces;
    expect(sorted(kept)).toEqual(["api", "docs", "flaky", "guard"]);
    const shown = { pinned: filterWorkspaceGroups(pinned.pinned, kept), rest: filterWorkspaceGroups(pinned.rest, kept) };
    expect(shown.pinned.map((group) => group.workspace.workspace_id)).toEqual(["flaky", "docs"]);
    expect(shown.rest.map((group) => [group.workspace.workspace_id, group.children.map((child) => child.workspace_id)])).toEqual([["api", ["guard"]]]);
    const narrower = machineFilter(sidebarFilter("guard", roster, nobody, t), "local")!.workspaces;
    expect(filterWorkspaceGroups(pinned.pinned, narrower)).toEqual([]);
    expect(filterWorkspaceGroups(pinned.rest, narrower).map((group) => [group.workspace.workspace_id, group.children.map((child) => child.workspace_id)])).toEqual([["api", ["guard"]]]);
    const rows = roster.flatMap((machine) => sidebarAgents(machine.snapshot).map((entry) => ({ machine, entry })));
    const keptRows = rows.filter(({ machine, entry }) => machineFilter(filter, machine.id)!.panes.has(entry.pane.pane_id));
    expect(keptRows.map(({ machine, entry }) => `${machine.id}:${entry.pane.pane_id}`)).toEqual(["local:api:p1", "local:guard:p1", "local:flaky:p1", "local:docs:p1", "build:pay:p1"]);
    const split = splitPinnedRows(keptRows, ["build:pay:p1", "local:flaky:p1"], ({ machine, entry }) => `${machine.id}:${entry.pane.pane_id}`);
    expect(split.pinned.map(({ entry }) => entry.pane.pane_id)).toEqual(["pay:p1", "flaky:p1"]);
    expect(split.rest.map(({ entry }) => entry.pane.pane_id)).toEqual(["api:p1", "guard:p1", "docs:p1"]);
  });

  it("retains selected nonmatch and ancestors", () => {
    const selected = { machineId: "local", paneId: "guard:p1" };
    const none = sidebarFilter("zzq", machines(), selected, t);
    expect(none.matches).toBe(0);
    const local = machineFilter(none, "local")!;
    expect(local.shown).toBe(true);
    expect(sorted(local.workspaces)).toEqual(["api", "guard"]);
    expect(local.matchedWorkspaces.size).toBe(0);
    expect(local.revealedWorkspaces.size).toBe(0);
    expect(sorted(local.panes)).toEqual(["guard:p1"]);
    expect(local.matchedPanes.size).toBe(0);
    expect(machineFilter(none, "build")!.shown).toBe(false);
    const elsewhere = sidebarFilter("settlement", machines(), selected, t);
    expect(elsewhere.matches).toBe(1);
    expect(sorted(machineFilter(elsewhere, "local")!.workspaces)).toEqual(["api", "guard"]);
    expect(machineFilter(elsewhere, "local")!.matchedWorkspaces.size).toBe(0);
    expect(sorted(machineFilter(elsewhere, "build")!.matchedPanes)).toEqual(["pay:p1"]);
    expect(machineFilter(sidebarFilter("zzq", machines(), { machineId: "build", paneId: null }, t), "build")!.shown).toBe(true);
    const pending = [...machines(), { id: "old", name: "Old PC", kind: "ssh", enabled: true, state: "connecting", error: null, snapshot: null } as Machine];
    const waiting = sidebarFilter("zzq", pending, selected, t);
    expect(machineFilter(waiting, "old")!.shown).toBe(true);
    expect(machineFilter(waiting, "old")!.matched).toBe(false);
    expect(waiting.matches).toBe(0);
  });

  it("does not search hidden cwd or transcript", () => {
    const roster = machines();
    for (const hidden of ["secret-api-folder", "hidden-guard", "private/transcripts", "/srv", "term-", "api:p1", "guard"]) {
      const filter = sidebarFilter(hidden, roster, nobody, t);
      const found = [...filter.machines.values()].flatMap((machine) => [...machine.matchedPanes]);
      if (hidden === "guard") expect(found).toEqual(["guard:p1"]);
      else expect({ hidden, found }).toEqual({ hidden, found: [] });
    }
    for (const shellTitle of ["zsh", "transcripts"]) expect(sidebarFilter(shellTitle, roster, nobody, t).matches).toBe(0);
    const snapshot = laptop();
    const entry = sidebarAgents(snapshot).find((candidate) => candidate.pane.pane_id === "api:p1")!;
    expect(paneLabels(entry.pane, entry, snapshot.tabs.filter((candidate) => candidate.workspace_id === "api"), t)).toEqual(["Idempotent payments", "claude", "Tab 1"]);
    const shell = snapshot.panes.find((candidate) => candidate.pane_id === "api:p2")!;
    expect(paneLabels(shell, undefined, [], t)).toEqual(["zsh"]);
    const nameless = buildPc().panes.find((candidate) => candidate.pane_id === "tmp:p1")!;
    expect(paneLabels(nameless, undefined, [], t)).toEqual(["transcripts"]);
    const labelled = { ...nameless, label: "Scratch shell" };
    expect(paneLabels(labelled, undefined, [], t)).toEqual(["Scratch shell"]);
    expect(workspaceLabels(snapshot.workspaces[1]!, "feat/export-guard")).toEqual(["export-guard", "feat/export-guard"]);
    expect(workspaceLabels(snapshot.workspaces[3]!, null)).toEqual(["docs-site"]);
  });

  it("filter leaves source roster unchanged", () => {
    const roster = machines();
    const before = structuredClone(roster);
    const snapshots = roster.map((machine) => machine.snapshot);
    const panes = roster.map((machine) => machine.snapshot?.panes);
    for (const query of ["a", "checkout", "zzq", "Build PC", ""]) {
      sidebarFilter(query, roster, { machineId: "local", paneId: "guard:p1" }, t, new Map([["local", new Map([["api", "main"]])]]));
    }
    expect(roster).toEqual(before);
    expect(roster.map((machine) => machine.snapshot)).toEqual(snapshots);
    roster.forEach((machine, index) => expect(machine.snapshot?.panes).toBe(panes[index]));
  });

  it("keeps a kept worktree under the head it is drawn under, whatever head the roster's order gave it", () => {
    const repo = { repo_key: "r", repo_name: "r" };
    const alpha = workspace("alpha", "alpha", { ...repo, linked: false });
    const beta = workspace("beta", "beta", { ...repo, linked: false });
    const child = workspace("child", "uniquechild", { ...repo, linked: true });
    const kept = sidebarFilter("uniquechild", [{ id: "pc", name: "PC", snapshot: { workspaces: [alpha, child, beta], panes: [], tabs: [], agents: [] } as unknown as SessionSnapshot }], { machineId: "pc", paneId: null }, t).machines.get("pc")!.workspaces;
    const drawn = filterWorkspaceGroups(worktreeGroups([alpha, beta, child]), kept);
    expect(drawn.flatMap((group) => group.children.map((c) => c.workspace_id))).toEqual(["child"]);
  });

  it("suggests the names the rows show, never a path", () => {
    const roster = machines();
    const suggested = filterSuggestions(roster, new Map([["local", new Map([["guard", "feat/export-guard"]])]]));
    expect(suggested).toEqual(["Laptop", "checkout-api", "export-guard", "feat/export-guard", "flaky-retry-test", "docs-site", "Idempotent payments", "Guard the export button", "Fix the flaky retry test", "Proofread the guide", "Build PC", "payments", "scratch", "Nightly settlement"]);
    expect(suggested.some((label) => label.includes("/home") || label.includes("/srv") || label.includes(":p"))).toBe(false);
    expect(roster).toEqual(machines());
  });

  it("neither searches nor suggests the name of a PC drawn without its header", () => {
    const lone = machines().slice(0, 1);
    const unnamed = new Set(["local"]);
    const byName = sidebarFilter("laptop", lone, nobody, t, new Map(), unnamed);
    expect(machineFilter(byName, "local")!.matched).toBe(false);
    expect(byName.matches).toBe(0);
    expect(sorted(machineFilter(sidebarFilter("docs", lone, nobody, t, new Map(), unnamed), "local")!.matchedWorkspaces)).toEqual(["docs"]);
    expect(filterSuggestions(lone, new Map(), unnamed)).not.toContain("Laptop");
    expect(filterSuggestions(lone)).toContain("Laptop");
  });
});
