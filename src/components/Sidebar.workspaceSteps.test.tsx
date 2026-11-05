import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { adjacentWorkspacePane, drawnWorkspaceRows } from "../lib/adjacentTarget.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { inactiveSidebarFilter, sidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { currentSidebarPins, setSidebarPins } from "../lib/sidebarPins.ts";
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
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let failWrites = false;
  let renderer: ReactTestRenderer | undefined;
  let pinsBefore: string[];

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    failWrites = false;
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota"); stored.set(key, value); },
      removeItem: (key: string) => { if (failWrites) throw new Error("quota"); stored.delete(key); },
    };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

  async function draw(snapshot: SessionSnapshot, selected: string, filter = inactiveSidebarFilter()): Promise<void> {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter, reportBranches: () => {} } },
        createElement(Sidebar, { snapshot, online: false, selectedPaneId: selected, actions }))));
    });
  }
  const shownRows = () => renderer!.root.findAll((node) => typeof node.type === "string" && typeof node.props["data-workspace"] === "string").map((node) => node.props["data-workspace"] as string);
  const next = (snapshot: SessionSnapshot, selected: string) => adjacentWorkspacePane(snapshot, drawnWorkspaceRows("local") ?? [], selected, 1, () => undefined);

  it("never lands on a row a filter leaves out", async () => {
    const snapshot = roster([workspace("a"), workspace("b"), workspace("c")]);
    await draw(snapshot, "a:p", sidebarFilter("c", [{ id: "local", name: "Host", snapshot }], { machineId: "local", paneId: "a:p" }, (text) => text));
    expect(shownRows()).toEqual(["a", "c"]);
    expect(next(snapshot, "a:p")).toBe("c:p");
  });

  it("lands on a folded worktree a filter shows", async () => {
    const snapshot = roster([workspace("root", worktree(false)), workspace("child", worktree(true)), workspace("tail")]);
    stored.set("ovis:worktree-group-collapsed:local:r", "1");
    await draw(snapshot, "root:p", sidebarFilter("child", [{ id: "local", name: "Host", snapshot }], { machineId: "local", paneId: "root:p" }, (text) => text));
    expect(shownRows()).toEqual(["root", "child"]);
    expect(next(snapshot, "root:p")).toBe("child:p");
  });

  it("passes over a group folded where storage refuses the write", async () => {
    const snapshot = roster([workspace("root", worktree(false)), workspace("child", worktree(true)), workspace("tail")]);
    await draw(snapshot, "root:p");
    expect(shownRows()).toEqual(["root", "child", "tail"]);
    failWrites = true;
    await act(async () => renderer!.root.findByProps({ className: "sidebar-row-action workspace-toggle" }).props.onClick());
    expect(shownRows()).toEqual(["root", "tail"]);
    expect(next(snapshot, "root:p")).toBe("tail:p");
  });

  it("takes its rows back when the sidebar goes", async () => {
    await draw(roster([workspace("a"), workspace("b")]), "a:p");
    expect(drawnWorkspaceRows("local")).toEqual(["a", "b"]);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(drawnWorkspaceRows("local")).toBeNull();
  });
});
