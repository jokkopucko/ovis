import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer, ReorderContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { usageCounters } from "../lib/usageCounters.ts";
import { inactiveSidebarFilter, type SidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { currentSidebarPins, setSidebarPins } from "../lib/sidebarPins.ts";
import { ReorderCoordinator } from "../lib/workspaceOrder.ts";
import { Sidebar } from "./Sidebar.tsx";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });

const worktree = (linked: boolean) => ({ is_linked_worktree: linked, repo_key: "r", repo_name: "r", checkout_path: "/test-project" }) as WorkspaceInfo["worktree"];
const workspace = (id: string, tree: WorkspaceInfo["worktree"] = null): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t`, number: 1, tab_count: 1, pane_count: 1, focused: false, agent_status: "idle", worktree: tree });
const roster = (workspaces: WorkspaceInfo[]): SessionSnapshot => ({
  protocol: 22, version: "test", workspaces, layouts: [], agents: [],
  tabs: workspaces.map((w) => ({ tab_id: w.active_tab_id, workspace_id: w.workspace_id, label: w.label, number: 1, pane_count: 1, focused: false, agent_status: "idle" })),
  panes: workspaces.map((w) => ({ pane_id: `${w.workspace_id}:p`, workspace_id: w.workspace_id, tab_id: w.active_tab_id, terminal_id: `${w.workspace_id}:term`, revision: 1, focused: false, agent_status: "idle" })),
});
const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
describe("the sidebar on a PC the Herdr app lays out", () => {
  let page: Page;
  const browserGlobals = ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "localStorage"] as const;
  const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let pinsBefore: string[];
  let requested: string[];

  beforeEach(() => {
    page = openPage();
    Object.defineProperties(page.window, {
      innerWidth: { configurable: true, value: 1280 },
      innerHeight: { configurable: true, value: 800 },
      requestAnimationFrame: { configurable: true, value: () => 1 },
      cancelAnimationFrame: { configurable: true, value: () => {} },
    });
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
    requested = [];
    pinsBefore = currentSidebarPins();
    setSidebarPins([]);
  });

  afterEach(async () => {
    await page.close();
    setSidebarPins(pinsBefore);
    for (const [key, descriptor] of savedBrowserGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function draw(snapshot: SessionSnapshot, offer: LayoutOffer, online = false, given: { actions?: AppActions; watching?: boolean; filter?: SidebarFilter } = {}): Promise<ReorderCoordinator> {
    const coordinator = new ReorderCoordinator();
    await page.render(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: given.filter ?? inactiveSidebarFilter(), reportBranches: () => {} } },
        createElement(AppLayoutContext.Provider, { value: offer }, createElement(ReorderContext.Provider, { value: coordinator },
          createElement(Sidebar, { snapshot, online, selectedPaneId: `${snapshot.workspaces[0]!.workspace_id}:p`, actions: given.actions ?? actions, watching: given.watching }))))));
    return coordinator;
  }
  const menuButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".row-menu button[data-item]")];
  const menuItem = (id: string) => {
    const item = menuButtons().find((button) => button.getAttribute("data-item") === id);
    if (!item) throw new Error(`Missing menu item ${id}`);
    return item;
  };
  const pressMenu = (id: string) => act(async () => { menuItem(id).click(); });
  const menuOf = async (label: string): Promise<(string | null)[]> => {
    await act(async () => { page.one(`[aria-label="More for ${label}"]`).click(); });
    return menuButtons().map((item) => item.getAttribute("data-item"));
  };
  const row = (id: string) => page.one(`[data-pane="${id}:p"]`);
  const keyPress = (key: string, altKey: boolean) => new window.KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true });
  const confirmButton = () => document.querySelector<HTMLButtonElement>(".confirm-dialog .btn-danger");
  const confirm = () => act(async () => {
    const button = confirmButton();
    if (!button) throw new Error("Missing confirmation action");
    button.click();
  });
  const confirmError = () => document.querySelector(".confirm-dialog [role=alert]")?.textContent;

  it("offers a TUI PC's rows their rename, worktree and delete items", async () => {
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), TUI);
    expect(await menuOf("root")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "new-worktree", "open-worktree", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "delete-worktree"]);
  });

  it("offers no close or delete for a workspace, or its repository's group, holding a locked pinned agent (#2432)", async () => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:child:p"] }));
    setSidebarPins(["local:child:p"]);
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true)), workspace("other")]), TUI);
    expect(await menuOf("root")).toEqual(["pin-workspace", "rename-workspace", "session-history", "new-worktree", "open-worktree", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "rename-workspace", "session-history"]);
    expect(await menuOf("other")).toContain("close");
  });

  it("sends Close group only for the group the confirmation was opened over (#2432)", async () => {
    const view = (shown: SessionSnapshot) => createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: inactiveSidebarFilter(), reportBranches: () => {} } },
      createElement(AppLayoutContext.Provider, { value: TUI }, createElement(ReorderContext.Provider, { value: new ReorderCoordinator() },
        createElement(Sidebar, { snapshot: shown, online: false, selectedPaneId: "root:p", actions })))));
    const group = [workspace("root", worktree(false)), workspace("child", worktree(true))];
    const closes: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/workspace/close")) closes.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }, { preconnect: globalThis.fetch.preconnect }));
    const confirmAfter = async (shown: SessionSnapshot): Promise<void> => {
      await draw(roster(group), TUI);
      await menuOf("root");
      await pressMenu("close");
      await page.render(view(shown));
      if (confirmButton()) await confirm();
      await page.render(null);
    };
    try {
      await confirmAfter(roster(group));
      expect(closes).toEqual([{ workspace_id: "root", close_group: true }]);
      closes.length = 0;
      page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:late:p"] }));
      setSidebarPins(["local:late:p"]);
      await confirmAfter(roster([...group, workspace("late", worktree(true))]));
      page.window.localStorage.setItem("ovis:settings", JSON.stringify({}));
      setSidebarPins([]);
      await confirmAfter(roster([...group, workspace("late", worktree(true))]));
      expect(closes).toEqual([]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("deletes the checkout the confirmation named, even when a later snapshot draws the workspace on another (#4211)", async () => {
    const at = (path: string, git_id: string) => ({ is_linked_worktree: true, repo_key: "r", repo_name: "r", repo_root: "/repo", checkout_path: path, git_id }) as WorkspaceInfo["worktree"];
    const view = (shown: SessionSnapshot) => createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: inactiveSidebarFilter(), reportBranches: () => {} } },
      createElement(AppLayoutContext.Provider, { value: OVIS_CORE }, createElement(ReorderContext.Provider, { value: new ReorderCoordinator() },
        createElement(Sidebar, { snapshot: shown, online: false, selectedPaneId: "root:p", actions })))));
    const removes: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/worktree/remove")) {
        removes.push(JSON.parse(String(init?.body)));
        return Response.json({ error: { code: "dirty_worktree_requires_force", message: "contains modified or untracked files" } }, { status: 404 });
      }
      return Response.json({ ok: true });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await draw(roster([workspace("root", worktree(false)), workspace("child", at("/checkouts/a", "1:2:3"))]), OVIS_CORE);
      await menuOf("child");
      await pressMenu("delete-worktree");
      await page.render(view(roster([workspace("root", worktree(false)), workspace("child", at("/checkouts/b", "1:2:4"))])));
      await confirm();
      expect({ error: confirmError(), action: confirmButton()?.textContent }).toEqual({ error: "contains modified or untracked files", action: "Delete anyway" });
      // git refused a dirty checkout: Delete anyway names the same folder
      await confirm();
      expect(confirmError()).toBe("contains modified or untracked files");
      expect(removes).toEqual([{ workspace_id: "child", expected_checkout: "/checkouts/a", expected_git_id: "1:2:3" }, { workspace_id: "child", force: true, expected_checkout: "/checkouts/a", expected_git_id: "1:2:3" }]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("leaves rename, the worktree actions and the checkout's delete out on a core PC, and keeps pin, earlier sessions, close and the fold", async () => {
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), APP_CORE);
    expect(await menuOf("root")).toEqual(["pin-workspace", "session-history", "close", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "session-history", "close"]);
  });

  it("offers a core PC's rows their rename and worktree items where Ovis keeps its layout", async () => {
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), OVIS_CORE);
    expect(await menuOf("root")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "new-worktree", "open-worktree", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "delete-worktree"]);
  });

  it("offers no rename for a core's Other terminals, which has no name to change (#2806)", async () => {
    await draw(roster([workspace("root"), { ...workspace(HC_OTHER_WORKSPACE_ID), label: "Other terminals" }]), OVIS_CORE);
    expect(await menuOf("root")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close"]);
    expect(await menuOf("Other terminals")).toEqual(["pin-workspace", "session-history", "close"]);
  });

  it("counts the empty list's New workspace as a button, and starts one even when the count fails", async () => {
    for (const failing of [false, true]) {
      const told: string[] = [];
      const started: string[] = [];
      const counting = new Proxy({}, { get: (_, name) => name === "counted" ? (action: string, source: string) => { if (failing) throw new Error("storage full"); told.push(`${action}:${source}`); }
        : name === "openNewSession" ? () => started.push("new") : () => {} }) as AppActions;
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        await page.render(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: inactiveSidebarFilter(), reportBranches: () => {} } },
            createElement(AppLayoutContext.Provider, { value: TUI }, createElement(ReorderContext.Provider, { value: new ReorderCoordinator() },
              createElement(Sidebar, { snapshot: roster([]), online: true, selectedPaneId: null, actions: counting }))))));
        const button = page.container.querySelectorAll<HTMLButtonElement>('button[class="btn"]')[0]!;
        await act(async () => { button.click(); });
      } finally { logged.mockRestore(); }
      expect([told, started]).toEqual([failing ? [] : ["new_workspace:button"], ["new"]]);
      await page.render(null);

    }
  });

  it("opens a new tab in a row's workspace from its menu, on a connected PC to a device that drives (#3772)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying });
      expect(await menuOf("b")).toEqual(["pin-workspace", "new-tab", "rename-workspace", "session-history", "close"]);
      const told: string[] = [];
      const counting = spyOn(usageCounters, "paneUse").mockImplementation((name, machineId) => { told.push(`${name}@${machineId}`); });
      try {
        await pressMenu("new-tab");
      } finally { counting.mockRestore(); }
      expect(opened).toEqual([{ machineId: "local", workspaceId: "b" }]);
      expect(told).toEqual(["new_tab_by_menu@local"]);
      await page.render(null);

      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying, watching: true });
      expect(await menuOf("b")).not.toContain("new-tab");
    } finally {
      fetch.mockRestore();
    }
  });

  it("leaves a folded repository's saved fold alone when New tab with agent… runs while Agents under workspaces is off", async () => {
    page.window.localStorage.setItem("ovis:worktree-group-collapsed:local:r", "1");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), TUI, true, { actions: spying });
      expect(await menuOf("root")).toContain("new-tab");
      await pressMenu("new-tab");
      expect(opened).toEqual([{ machineId: "local", workspaceId: "root" }]);
      expect(page.window.localStorage.getItem("ovis:worktree-group-collapsed:local:r")).toBe("1");
      expect(await menuOf("root")).toContain("fold");
      expect(menuItem("fold").textContent?.trim()).toBe("Expand");
    } finally {
      fetch.mockRestore();
    }
  });

  it("unfolds a workspace whose fold outlived its agents when New tab with agent… makes a new one there", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    page.window.localStorage.setItem("ovis:workspace-agents-folded:local", JSON.stringify(["a"]));
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying });
      await menuOf("a");
      await pressMenu("new-tab");
      expect(opened).toEqual([{ machineId: "local", workspaceId: "a" }]);
      expect(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")).toBe(JSON.stringify([]));
    } finally {
      fetch.mockRestore();
    }
  });

  it("drops a workspace's saved fold when New tab with agent… makes an agent there while the sidebar filter is on", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    page.window.localStorage.setItem("ovis:workspace-agents-folded:local", JSON.stringify(["a"]));
    const kept = new Set(["a"]);
    const filter: SidebarFilter = { query: "a", active: true, matches: 1, machines: new Map([["local", { shown: true, matched: false, workspaces: kept, matchedWorkspaces: kept, revealedWorkspaces: kept, panes: new Set(["a:p"]), matchedPanes: new Set() }]]) };
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying, filter });
      await menuOf("a");
      await pressMenu("new-tab");
      expect(opened).toEqual([{ machineId: "local", workspaceId: "a" }]);
      expect(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")).toBe(JSON.stringify([]));
    } finally {
      fetch.mockRestore();
    }
  });

  it("offers Collapse and Expand for a row's agents while Agents under workspaces is on, one fold per row (#3771)", async () => {
    page.window.localStorage.setItem("ovis:sidebar-agent-tree", "true");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    const withAgents = (shown: SessionSnapshot): SessionSnapshot => ({ ...shown, panes: shown.panes.map((entry) => ({ ...entry, agent: "claude" })) });
    await draw(withAgents(roster([workspace("a"), workspace("root", worktree(false)), workspace("child", worktree(true))])), TUI, true);
    expect((await menuOf("a")).filter((id) => id === "fold")).toEqual(["fold"]);
    const fold = () => menuItem("fold");
    expect(fold().textContent?.trim()).toBe("Collapse");
    await pressMenu("fold");
    expect(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")).toBe(JSON.stringify(["a"]));
    expect((await menuOf("a")).filter((id) => id === "fold")).toEqual(["fold"]);
    expect(fold().textContent?.trim()).toBe("Expand");
    await pressMenu("new-tab");
    expect(page.window.localStorage.getItem("ovis:workspace-agents-folded:local")).toBe(JSON.stringify([]));
    expect((await menuOf("root")).filter((id) => id === "fold")).toEqual(["fold"]);
    fetch.mockRestore();
  });

  it("lets a TUI PC's rows be dragged and moved with Alt+arrows", async () => {
    const coordinator = await draw(roster([workspace("a"), workspace("b")]), TUI);
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(row("a").getAttribute("draggable")).toBe("true");
    expect(row("a").getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    await act(async () => row("a").dispatchEvent(keyPress("ArrowDown", true)));
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder.mock.calls[0]![2]).toEqual(["b", "a"]);
  });

  it("keeps a core PC's rows where the Herdr app put them, still draggable into half of the pane area", async () => {
    const coordinator = await draw(roster([workspace("a"), workspace("b")]), APP_CORE);
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(row("a").getAttribute("draggable")).toBe("true");
    expect(row("a").getAttribute("aria-keyshortcuts")).toBeNull();
    await act(async () => row("a").dispatchEvent(keyPress("ArrowDown", true)));
    expect(reorder).not.toHaveBeenCalled();
  });

  it("asks a TUI PC which unmarked rows are repositories, and a core PC not at all", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await draw(roster([workspace("a"), workspace("b")]), TUI, true);
      expect(requested.filter((url) => url.includes("/api/worktree/list?")).sort()).toEqual(["/api/worktree/list?workspace_id=a", "/api/worktree/list?workspace_id=b"]);
      await page.render(null);

      requested = [];
      await draw(roster([workspace("a"), workspace("b")]), APP_CORE, true);
      expect(requested.filter((url) => url.includes("/api/worktree/list?"))).toEqual([]);
    } finally {
      fetch.mockRestore();
    }
  });

  const answerFor = (url: string, refusal: { code: string; message: string } | null): Response => {
    const listing = { source: { repo_key: "r", source_checkout_path: "/test-project" }, worktrees: [{ path: "/test-project", branch: "main", is_detached: false, open_workspace_id: "a" }] };
    if (url.startsWith("/api/worktree/inventory?")) return Response.json({ entries: [{ workspace_id: "a", ...(refusal ? { error: { status: 404, ...refusal } } : { listing }) }] });
    return refusal ? Response.json({ error: refusal }, { status: 404 }) : Response.json(listing);
  };
  const askedAbout = (id: string) => requested.filter((url) => url === `/api/worktree/list?workspace_id=${id}` || url === `/api/worktree/inventory?workspace_id=${id}`).length;

  it("keeps asking about a checkout after herdr dropped one poll's connection (#2726)", async () => {
    let dropped = false;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return answerFor(url, dropped ? { code: "closed", message: "herdr closed the connection" } : null);
    }, { preconnect: globalThis.fetch.preconnect }));
    jest.useFakeTimers();
    const asked = () => askedAbout("a");
    const settle = async () => { for (let turn = 0; turn < 50; turn++) await act(async () => { await Promise.resolve(); }); };
    try {
      await draw(roster([workspace("a")]), TUI, true);
      await settle();
      expect(asked()).toBe(2);
      dropped = true;
      await act(async () => { jest.advanceTimersByTime(30_000); });
      await settle();
      expect(asked()).toBe(3);
      dropped = false;
      await act(async () => { jest.advanceTimersByTime(30_000); });
      await settle();
      expect(asked()).toBe(4);
    } finally {
      jest.useRealTimers();
      fetch.mockRestore();
    }
  });

  it("stops asking about a row whose folder stopped being a checkout (#2726)", async () => {
    let checkout = true;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return answerFor(url, checkout ? null : { code: "not_git_worktree", message: "not a git worktree" });
    }, { preconnect: globalThis.fetch.preconnect }));
    jest.useFakeTimers();
    const asked = () => askedAbout("a");
    const settle = async () => { for (let turn = 0; turn < 50; turn++) await act(async () => { await Promise.resolve(); }); };
    try {
      await draw(roster([workspace("a")]), TUI, true);
      await settle();
      expect(asked()).toBe(2);
      checkout = false;
      await act(async () => { jest.advanceTimersByTime(30_000); });
      await settle();
      const afterRefusal = asked();
      expect(afterRefusal).toBe(3);
      for (let poll = 0; poll < 3; poll++) {
        await act(async () => { jest.advanceTimersByTime(30_000); });
        await settle();
      }
      expect(asked()).toBe(afterRefusal);
    } finally {
      jest.useRealTimers();
      fetch.mockRestore();
    }
  });
});
