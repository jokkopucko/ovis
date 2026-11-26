import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

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
import { RowMenu } from "./RowMenu.tsx";
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
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;
const keyPress = (key: string, altKey: boolean) => ({ key, altKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

describe("the sidebar on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  let pinsBefore: string[];
  let requested: string[];

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    requested = [];
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, querySelectorAll: () => [], body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    pinsBefore = currentSidebarPins();
    setSidebarPins([]);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    setSidebarPins(pinsBefore);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function draw(snapshot: SessionSnapshot, offer: LayoutOffer, online = false, given: { actions?: AppActions; watching?: boolean; filter?: SidebarFilter } = {}): Promise<ReorderCoordinator> {
    const coordinator = new ReorderCoordinator();
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: given.filter ?? inactiveSidebarFilter(), reportBranches: () => {} } },
        createElement(AppLayoutContext.Provider, { value: offer }, createElement(ReorderContext.Provider, { value: coordinator },
          createElement(Sidebar, { snapshot, online, selectedPaneId: `${snapshot.workspaces[0]!.workspace_id}:p`, actions: given.actions ?? actions, watching: given.watching }))))), { createNodeMock: node });
    });
    return coordinator;
  }
  const menuOf = async (label: string): Promise<string[]> => {
    await act(async () => renderer!.root.findByProps({ "aria-label": `More for ${label}` }).props.onClick({ currentTarget: node() }));
    return (renderer!.root.findByType(RowMenu).props.items as { id: string }[]).map((item) => item.id);
  };
  const row = (id: string) => renderer!.root.findByProps({ "data-pane": `${id}:p` });

  it("offers a TUI PC's rows their rename, worktree and delete items", async () => {
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), TUI);
    expect(await menuOf("root")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "new-worktree", "open-worktree", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "delete-worktree"]);
  });

  it("offers no close or delete for a workspace, or its repository's group, holding a locked pinned agent (#2432)", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:child:p"] }));
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
      await act(async () => (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "close")!.run());
      await act(async () => renderer!.update(view(shown)));
      const dialog = renderer!.root.findAll((node) => node.props.confirmLabel !== undefined && typeof node.props.onConfirm === "function")[0];
      if (dialog) await act(async () => { await dialog.props.onConfirm(); });
      await act(async () => renderer?.unmount());
    };
    try {
      await confirmAfter(roster(group));
      expect(closes).toEqual([{ workspace_id: "root", close_group: true }]);
      closes.length = 0;
      stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:late:p"] }));
      setSidebarPins(["local:late:p"]);
      await confirmAfter(roster([...group, workspace("late", worktree(true))]));
      stored.set("ovis:settings", JSON.stringify({}));
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
      await act(async () => (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "delete-worktree")!.run());
      await act(async () => renderer!.update(view(roster([workspace("root", worktree(false)), workspace("child", at("/checkouts/b", "1:2:4"))]))));
      const dialog = () => renderer!.root.findAll((node) => node.props.confirmLabel !== undefined && typeof node.props.onConfirm === "function")[0]!;
      await act(async () => { await expect(dialog().props.onConfirm()).rejects.toMatchObject({ code: "dirty_worktree_requires_force" }); });
      // git refused a dirty checkout: Delete anyway names the same folder
      await act(async () => { await expect(dialog().props.escalation.run()).rejects.toMatchObject({ code: "dirty_worktree_requires_force" }); });
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
        await act(async () => {
          renderer = create(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: inactiveSidebarFilter(), reportBranches: () => {} } },
            createElement(AppLayoutContext.Provider, { value: TUI }, createElement(ReorderContext.Provider, { value: new ReorderCoordinator() },
              createElement(Sidebar, { snapshot: roster([]), online: true, selectedPaneId: null, actions: counting }))))), { createNodeMock: node });
        });
        const button = renderer!.root.findAll((found) => found.type === "button" && found.props.className === "btn")[0]!;
        await act(async () => { button.props.onClick(); });
      } finally { logged.mockRestore(); }
      expect([told, started]).toEqual([failing ? [] : ["new_workspace:button"], ["new"]]);
      await act(async () => renderer!.unmount());
      renderer = undefined;
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
        await act(async () => (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "new-tab")!.run());
      } finally { counting.mockRestore(); }
      expect(opened).toEqual([{ machineId: "local", workspaceId: "b" }]);
      expect(told).toEqual(["new_tab_by_menu@local"]);
      await act(async () => renderer!.unmount());
      renderer = undefined;
      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying, watching: true });
      expect(await menuOf("b")).not.toContain("new-tab");
    } finally {
      fetch.mockRestore();
    }
  });

  it("leaves a folded repository's saved fold alone when New tab with agent… runs while Agents under workspaces is off", async () => {
    stored.set("ovis:worktree-group-collapsed:local:r", "1");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), TUI, true, { actions: spying });
      expect(await menuOf("root")).toContain("new-tab");
      await act(async () => { (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "new-tab")!.run(); renderer!.root.findByType(RowMenu).props.onClose(); });
      expect(opened).toEqual([{ machineId: "local", workspaceId: "root" }]);
      expect(stored.get("ovis:worktree-group-collapsed:local:r")).toBe("1");
      expect(await menuOf("root")).toContain("fold");
      expect((renderer!.root.findByType(RowMenu).props.items as { id: string; label: string }[]).find((item) => item.id === "fold")?.label).toBe("Expand");
    } finally {
      fetch.mockRestore();
    }
  });

  it("unfolds a workspace whose fold outlived its agents when New tab with agent… makes a new one there", async () => {
    stored.set("ovis:sidebar-agent-tree", "true");
    stored.set("ovis:workspace-agents-folded:local", JSON.stringify(["a"]));
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying });
      await menuOf("a");
      await act(async () => { (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "new-tab")!.run(); renderer!.root.findByType(RowMenu).props.onClose(); });
      expect(opened).toEqual([{ machineId: "local", workspaceId: "a" }]);
      expect(stored.get("ovis:workspace-agents-folded:local")).toBe(JSON.stringify([]));
    } finally {
      fetch.mockRestore();
    }
  });

  it("drops a workspace's saved fold when New tab with agent… makes an agent there while the sidebar filter is on", async () => {
    stored.set("ovis:sidebar-agent-tree", "true");
    stored.set("ovis:workspace-agents-folded:local", JSON.stringify(["a"]));
    const kept = new Set(["a"]);
    const filter: SidebarFilter = { query: "a", active: true, matches: 1, machines: new Map([["local", { shown: true, matched: false, workspaces: kept, matchedWorkspaces: kept, revealedWorkspaces: kept, panes: new Set(["a:p"]), matchedPanes: new Set() }]]) };
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    try {
      const opened: unknown[] = [];
      const spying = new Proxy({}, { get: (_, name) => name === "openNewTab" ? (target: unknown) => opened.push(target) : () => {} }) as AppActions;
      await draw(roster([workspace("a"), workspace("b")]), TUI, true, { actions: spying, filter });
      await menuOf("a");
      await act(async () => { (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "new-tab")!.run(); renderer!.root.findByType(RowMenu).props.onClose(); });
      expect(opened).toEqual([{ machineId: "local", workspaceId: "a" }]);
      expect(stored.get("ovis:workspace-agents-folded:local")).toBe(JSON.stringify([]));
    } finally {
      fetch.mockRestore();
    }
  });

  it("offers Collapse and Expand for a row's agents while Agents under workspaces is on, one fold per row (#3771)", async () => {
    stored.set("ovis:sidebar-agent-tree", "true");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    const withAgents = (shown: SessionSnapshot): SessionSnapshot => ({ ...shown, panes: shown.panes.map((entry) => ({ ...entry, agent: "claude" })) });
    await draw(withAgents(roster([workspace("a"), workspace("root", worktree(false)), workspace("child", worktree(true))])), TUI, true);
    expect((await menuOf("a")).filter((id) => id === "fold")).toEqual(["fold"]);
    const fold = () => (renderer!.root.findByType(RowMenu).props.items as { id: string; label: string; run: () => void }[]).find((item) => item.id === "fold")!;
    expect(fold().label).toBe("Collapse");
    await act(async () => { fold().run(); renderer!.root.findByType(RowMenu).props.onClose(); });
    expect(stored.get("ovis:workspace-agents-folded:local")).toBe(JSON.stringify(["a"]));
    expect((await menuOf("a")).filter((id) => id === "fold")).toEqual(["fold"]);
    expect(fold().label).toBe("Expand");
    await act(async () => { (renderer!.root.findByType(RowMenu).props.items as { id: string; run: () => void }[]).find((item) => item.id === "new-tab")!.run(); renderer!.root.findByType(RowMenu).props.onClose(); });
    expect(stored.get("ovis:workspace-agents-folded:local")).toBe(JSON.stringify([]));
    expect((await menuOf("root")).filter((id) => id === "fold")).toEqual(["fold"]);
    fetch.mockRestore();
  });

  it("lets a TUI PC's rows be dragged and moved with Alt+arrows", async () => {
    const coordinator = await draw(roster([workspace("a"), workspace("b")]), TUI);
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(row("a").props.draggable).toBe(true);
    expect(row("a").props["aria-keyshortcuts"]).toBe("Alt+ArrowUp Alt+ArrowDown");
    await act(async () => row("a").props.onKeyDown(keyPress("ArrowDown", true)));
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder.mock.calls[0]![2]).toEqual(["b", "a"]);
  });

  it("keeps a core PC's rows where the Herdr app put them, still draggable into half of the pane area", async () => {
    const coordinator = await draw(roster([workspace("a"), workspace("b")]), APP_CORE);
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(row("a").props.draggable).toBe(true);
    expect(row("a").props["aria-keyshortcuts"]).toBeUndefined();
    await act(async () => row("a").props.onKeyDown(keyPress("ArrowDown", true)));
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
      await act(async () => renderer!.unmount());
      renderer = undefined;
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
