import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { inactiveSidebarFilter, sidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { currentSidebarPins, setSidebarPins } from "../lib/sidebarPins.ts";
import { Sidebar } from "./Sidebar.tsx";

const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: 1, focused: false, agent_status: "idle", worktree: null });
const pane = (id: string, workspaceId: string, tab: string, extra: Partial<PaneInfo> = {}): PaneInfo =>
  ({ pane_id: id, workspace_id: workspaceId, tab_id: `${workspaceId}:${tab}`, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle", ...extra });
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", layouts: [], agents: [],
  workspaces: [workspace("api", 2), workspace("web", 1)],
  tabs: [
    { tab_id: "api:t1", workspace_id: "api", label: "1", number: 1, pane_count: 2, focused: false, agent_status: "idle" },
    { tab_id: "api:t2", workspace_id: "api", label: "2", number: 2, pane_count: 1, focused: false, agent_status: "idle" },
    { tab_id: "web:t1", workspace_id: "web", label: "1", number: 1, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [
    pane("api:claude", "api", "t1", { agent: "claude", title: "fix login", agent_status: "working" }),
    pane("api:shell", "api", "t1"),
    pane("api:codex", "api", "t2", { agent: "codex", label: "review", agent_status: "blocked" }),
    pane("web:pi", "web", "t1", { agent: "pi", title: "styles" }),
  ],
};
const machines = [{ id: "local", name: "Host", snapshot }];

describe("Settings > Appearance > Agents under workspaces (#773)", () => {
  let page: Page;
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let pinsBefore: string[];
  let selected: string[];
  let fetchSpy: { mockRestore(): void } | undefined;
  const actions = new Proxy({}, { get: (_, key) => key === "selectPane" ? (id: string) => { selected.push(id); } : () => {} }) as AppActions;

  beforeEach(() => {
    page = openPage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: page.window.localStorage });
    selected = [];
    pinsBefore = currentSidebarPins();
    setSidebarPins([]);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not a repository" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    setSidebarPins(pinsBefore);
    await page.close();
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  async function draw({ online = true, selectedPaneId = "web:pi", filter = inactiveSidebarFilter(), shown = snapshot } = {}): Promise<void> {
    await page.render(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter, reportBranches: () => {} } },
        createElement(Sidebar, { snapshot: shown, online, selectedPaneId, actions }))));
  }
  const tree = () => [...page.container.querySelectorAll("li[data-workspace]")].map((row) =>
    [row.getAttribute("data-workspace"), ...[...row.querySelectorAll("li[data-agent-pane]")].map((agent) => agent.getAttribute("data-agent-pane"))]);
  const agentButton = (paneId: string) => page.one<HTMLButtonElement>(`li[data-agent-pane="${paneId}"] button`);
  const text = (node: Element): string => node.textContent ?? "";

  it("lists no agent under a workspace until the setting is on", async () => {
    await draw();
    expect(tree()).toEqual([["api"], ["web"]]);
    await page.render(null);
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw();
    expect(tree()).toEqual([["api", "api:claude", "api:codex"], ["web", "web:pi"]]);
  });

  it("names each agent as the Agents list does, with its tab where the workspace has several, and opens its pane", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw();
    expect(text(agentButton("api:claude"))).toContain("fix login");
    expect([...agentButton("api:claude").querySelectorAll('[class="workspace-agent-place"]')].map(text)).toEqual(["Tab 1"]);
    expect([...agentButton("api:codex").querySelectorAll('[class="workspace-agent-title"]')].map(text)).toEqual(["review"]);
    expect([...agentButton("api:codex").querySelectorAll("[data-status]")].map((node) => node.getAttribute("data-status"))).toEqual(["blocked"]);
    expect([...agentButton("web:pi").querySelectorAll('[class="workspace-agent-place"]')]).toEqual([]);
    await act(async () => agentButton("api:codex").click());
    expect(selected).toEqual(["api:codex"]);
  });

  it("says an agent's live name, so two agents of one title and tab tell apart", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    const agent = (paneId: string, name: string) => ({ pane_id: paneId, agent: "claude", display_agent: "Claude Code", name, agent_status: "idle" as const, focused: false, revision: 1, workspace_id: "web", tab_id: "web:t1", terminal_id: `${paneId}:term` });
    const twins: SessionSnapshot = {
      ...snapshot,
      panes: [...snapshot.panes, pane("web:other", "web", "t1", { agent: "pi", title: "styles" })],
      agents: [agent("web:pi", "Maru"), agent("web:other", "Dori")],
    };
    await draw({ shown: twins });
    expect([...agentButton("web:pi").querySelectorAll('[class="workspace-agent-place"]')].map(text)).toEqual(["Maru"]);
    expect([...agentButton("web:other").querySelectorAll('[class="workspace-agent-place"]')].map(text)).toEqual(["Dori"]);
    expect(agentButton("web:pi").title).toContain("Maru");
  });

  it("says a pane herdr could not restore, and the context ring while Context left on agent rows is on, as the other rows do", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    const marked: SessionSnapshot = {
      ...snapshot,
      panes: snapshot.panes.map((entry) => entry.pane_id === "api:codex" ? { ...entry, restore_error: "session gone" }
        : entry.pane_id === "api:claude" ? { ...entry, context: { used: 120_000, window: 200_000 } } : entry),
    };
    const rings = () => [...agentButton("api:claude").querySelectorAll('[data-testid="context-left"]')].map((node) => node.getAttribute("aria-label"));
    await draw({ shown: marked });
    expect([...agentButton("api:codex").querySelectorAll("[data-status]")].map((node) => node.getAttribute("data-status"))).toEqual(["restore-error"]);
    expect(rings()).toEqual([]);
    await page.render(null);
    page.window.localStorage.setItem("ovis:sidebar-context", "true");
    await draw({ shown: marked });
    expect(rings()).toEqual(["Context 40% left · 120k of 200k tokens"]);
  });

  it("gives the selection's fill to the selected agent's row, not its workspace's", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw({ selectedPaneId: "api:codex" });
    const api = rowOf("api");
    expect(api.className).toContain("is-selected");
    expect(api.className).toContain("has-selected-agent");
    expect(agentButton("api:codex").getAttribute("aria-current")).toBe("true");
    expect(agentButton("api:claude").getAttribute("aria-current")).toBeNull();
    await page.render(null);
    await draw({ selectedPaneId: "api:shell" });
    expect(rowOf("api").className).not.toContain("has-selected-agent");
  });

  it("keeps under a filter the agents it keeps, and the selected one as context", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw({ online: false, selectedPaneId: "web:pi", filter: sidebarFilter("review", machines, { machineId: "local", paneId: "web:pi" }, (words) => words) });
    expect(tree()).toEqual([["api", "api:codex"], ["web", "web:pi"]]);
    const context = (paneId: string) => page.one(`li[data-agent-pane="${paneId}"]`).className;
    expect(context("api:codex")).not.toContain("is-filter-context");
    expect(context("web:pi")).toContain("is-filter-context");
  });

  const rowOf = (id: string) => page.one(`li[data-workspace="${id}"]`);
  const selectOf = (id: string) => page.one<HTMLButtonElement>(`li[data-workspace="${id}"] [class="pane-select workspace-select"]`);
  const key = (target: HTMLElement, name: string) => act(async () => {
    Reflect.apply(target.dispatchEvent, target, [new page.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })]);
  });

  it("folds a workspace's agents from its row, opening nothing, and keeps the fold on this device per PC (#3771)", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw({ selectedPaneId: "api:codex" });
    expect(selectOf("api").getAttribute("aria-expanded")).toBe("true");
    await act(async () => selectOf("api").click());
    expect(selected).toEqual([]);
    expect(tree()).toEqual([["api"], ["web", "web:pi"]]);
    expect(selectOf("api").getAttribute("aria-expanded")).toBe("false");
    expect(rowOf("api").className).toContain("has-selected-agent");
    expect([...selectOf("api").querySelectorAll("[data-status]")].map((node) => node.getAttribute("data-status"))).toEqual(["blocked"]);
    expect([...rowOf("api").querySelectorAll('[class="workspace-fold-count"]')].map(text)).toEqual(["+2"]);
    expect(JSON.parse(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")!)).toEqual(["api"]);
    await page.render(null);
    await draw({ selectedPaneId: "api:codex" });
    expect(tree()).toEqual([["api"], ["web", "web:pi"]]);
    await key(selectOf("api"), "ArrowLeft");
    expect(tree()).toEqual([["api"], ["web", "web:pi"]]);
    await key(selectOf("api"), "ArrowRight");
    expect(tree()).toEqual([["api", "api:claude", "api:codex"], ["web", "web:pi"]]);
    await key(selectOf("web"), "Enter");
    expect(tree()).toEqual([["api", "api:claude", "api:codex"], ["web"]]);
    await key(selectOf("web"), " ");
    expect(tree()).toEqual([["api", "api:claude", "api:codex"], ["web", "web:pi"]]);
    expect(selected).toEqual([]);
    expect(JSON.parse(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")!)).toEqual([]);
  });

  it("opens a workspace with no agent under it as today, and every row with the setting off", async () => {
    const shells: SessionSnapshot = { ...snapshot, workspaces: [...snapshot.workspaces, workspace("ops", 1)], tabs: [...snapshot.tabs, { tab_id: "ops:t1", workspace_id: "ops", label: "1", number: 1, pane_count: 1, focused: false, agent_status: "idle" }], panes: [...snapshot.panes, pane("ops:shell", "ops", "t1")] };
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw({ shown: shells });
    expect(selectOf("ops").getAttribute("aria-expanded")).toBeNull();
    await act(async () => selectOf("ops").click());
    expect(selected).toEqual(["ops:shell"]);
    await page.render(null);
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "false");
    page.window.localStorage.setItem("ovis:workspace-agents-folded:local", JSON.stringify(["api"]));
    await draw({ shown: shells });
    expect(selectOf("api").getAttribute("aria-expanded")).toBeNull();
    await act(async () => selectOf("api").click());
    expect(selected).toEqual(["ops:shell", "api:claude"]);
  });

  it("opens a folded workspace for the filter's time when it matches one of its agents", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    page.window.localStorage.setItem("ovis:workspace-agents-folded:local", JSON.stringify(["api", "gone"]));
    await draw({ online: false, selectedPaneId: "web:pi", filter: sidebarFilter("review", machines, { machineId: "local", paneId: "web:pi" }, (words) => words) });
    expect(tree()).toEqual([["api", "api:codex"], ["web", "web:pi"]]);
    await page.render(null);
    await draw();
    expect(tree()).toEqual([["api"], ["web", "web:pi"]]);
    await act(async () => selectOf("web").click());
    expect(JSON.parse(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")!).sort()).toEqual(["api", "web"]);
  });

  it("draws an offline PC's agents without a state and does not open them", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    await draw({ online: false });
    expect(agentButton("api:codex").disabled).toBe(true);
    expect([...agentButton("api:codex").querySelectorAll("[data-status]")].map((node) => node.getAttribute("data-status"))).toEqual(["unknown"]);
  });
});
