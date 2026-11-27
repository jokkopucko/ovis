import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { adjacentWorkspacePane, drawnWorkspaceRows } from "../lib/adjacentTarget.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { inactiveSidebarFilter, sidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { Sidebar } from "./Sidebar.tsx";

const worktree = (linked: boolean) => ({ is_linked_worktree: linked, repo_key: "r", repo_name: "r", checkout_path: "/test-project" }) as WorkspaceInfo["worktree"];
const workspace = (id: string, tree: WorkspaceInfo["worktree"] = null): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t`, number: 1, tab_count: 1, pane_count: 1, focused: false, agent_status: "idle", worktree: tree });
const roster = (workspaces: WorkspaceInfo[]): SessionSnapshot => ({
  protocol: 22, version: "test", workspaces, layouts: [], agents: [],
  tabs: workspaces.map((w) => ({ tab_id: w.active_tab_id, workspace_id: w.workspace_id, label: w.label, number: 1, pane_count: 1, focused: false, agent_status: "idle" })),
  panes: workspaces.map((w) => ({ pane_id: `${w.workspace_id}:p`, workspace_id: w.workspace_id, tab_id: w.active_tab_id, terminal_id: `${w.workspace_id}:term`, revision: 1, focused: false, agent_status: "idle" })),
});
const actions = new Proxy({}, { get: () => () => {} }) as AppActions;

describe("the workspace steps follow the sidebar's drawn rows", () => {
  let failWrites = false;
  let page: Page;
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  beforeEach(() => {
    page = openPage();
    failWrites = false;
    const storage = page.window.localStorage;
    for (const method of ["setItem", "removeItem"] as const) {
      const write = storage[method].bind(storage);
      Object.defineProperty(storage, method, { configurable: true, value: (key: string, value: string) => {
        if (failWrites) throw new Error("quota");
        write(key, value);
      } });
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  });

  afterEach(async () => {
    await page.close();
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  async function draw(snapshot: SessionSnapshot, selected: string, filter = inactiveSidebarFilter()): Promise<void> {
    await page.render(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter, reportBranches: () => {} } },
        createElement(Sidebar, { snapshot, online: false, selectedPaneId: selected, actions }))));
  }
  const shownRows = () => [...page.container.querySelectorAll('[data-workspace]')].map((node) => node.getAttribute('data-workspace'));
  const next = (snapshot: SessionSnapshot, selected: string) => adjacentWorkspacePane(snapshot, drawnWorkspaceRows("local") ?? [], selected, 1, () => undefined);

  it("never lands on a row a filter leaves out", async () => {
    const snapshot = roster([workspace("a"), workspace("b"), workspace("c")]);
    await draw(snapshot, "a:p", sidebarFilter("c", [{ id: "local", name: "Host", snapshot }], { machineId: "local", paneId: "a:p" }, (text) => text));
    expect(shownRows()).toEqual(["a", "c"]);
    expect(next(snapshot, "a:p")).toBe("c:p");
  });

  it("lands on a folded worktree a filter shows", async () => {
    const snapshot = roster([workspace("root", worktree(false)), workspace("child", worktree(true)), workspace("tail")]);
    page.window.localStorage.setItem("ovis:worktree-group-collapsed:local:r", "1");
    await draw(snapshot, "root:p", sidebarFilter("child", [{ id: "local", name: "Host", snapshot }], { machineId: "local", paneId: "root:p" }, (text) => text));
    expect(shownRows()).toEqual(["root", "child"]);
    expect(next(snapshot, "root:p")).toBe("child:p");
  });

  it("passes over a group folded where storage refuses the write", async () => {
    const snapshot = roster([workspace("root", worktree(false)), workspace("child", worktree(true)), workspace("tail")]);
    await draw(snapshot, "root:p");
    expect(shownRows()).toEqual(["root", "child", "tail"]);
    failWrites = true;
    await act(async () => page.one<HTMLButtonElement>('button[class="sidebar-row-action workspace-toggle"]').click());
    expect(shownRows()).toEqual(["root", "tail"]);
    expect(next(snapshot, "root:p")).toBe("tail:p");
  });

  it("takes its rows back when the sidebar goes", async () => {
    await draw(roster([workspace("a"), workspace("b")]), "a:p");
    expect(drawnWorkspaceRows("local")).toEqual(["a", "b"]);
    await page.render(null);
    expect(drawnWorkspaceRows("local")).toBeNull();
  });
});
