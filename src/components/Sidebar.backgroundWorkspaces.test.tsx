import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { drawnWorkspaceRows } from "../lib/adjacentTarget.ts";
import { AppLayoutContext, appLayoutOf, ReorderContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { inactiveSidebarFilter, sidebarFilter, type SidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { currentSidebarPins, setSidebarPins, workspacePinKey } from "../lib/sidebarPins.ts";
import { ReorderCoordinator } from "../lib/workspaceOrder.ts";
import { Sidebar } from "./Sidebar.tsx";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });

const tagged = (id: string): WorkspaceInfo => ({ ...workspace(id), tokens: { role: "background" } });
const workspace = (id: string): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t`, number: 1, tab_count: 1, pane_count: 1, focused: false, agent_status: "idle", worktree: null });
const roster = (workspaces: WorkspaceInfo[], blocked: string[] = []): SessionSnapshot => ({
  protocol: 22, version: "test", workspaces, layouts: [], agents: [],
  tabs: workspaces.map((w) => ({ tab_id: w.active_tab_id, workspace_id: w.workspace_id, label: w.label, number: 1, pane_count: 1, focused: false, agent_status: "idle" })),
  panes: workspaces.map((w) => ({ pane_id: `${w.workspace_id}:p`, workspace_id: w.workspace_id, tab_id: w.active_tab_id, terminal_id: `${w.workspace_id}:term`, revision: 1, focused: false,
    agent: "claude", agent_status: blocked.includes(w.workspace_id) ? "blocked" : "idle" })),
});
const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
const keyPress = (key: string, altKey: boolean) => ({ key, altKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
const FOLD_KEY = "ovis:workspaces-background-collapsed:local";

describe("background workspaces in the sidebar", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  let pinsBefore: string[];
  let fetch: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not_found" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
    pinsBefore = currentSidebarPins();
    setSidebarPins([]);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    fetch?.mockRestore();
    setSidebarPins(pinsBefore);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const turnOn = () => stored.set("ovis:settings", JSON.stringify({ sidebarBackgroundWorkspaces: true }));
  async function draw(snapshot: SessionSnapshot, selected: string, filter: SidebarFilter = inactiveSidebarFilter()): Promise<ReorderCoordinator> {
    const coordinator = new ReorderCoordinator();
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter, reportBranches: () => {} } },
        createElement(AppLayoutContext.Provider, { value: TUI }, createElement(ReorderContext.Provider, { value: coordinator },
          createElement(Sidebar, { snapshot, online: true, selectedPaneId: selected, actions }))))));
    });
    return coordinator;
  }
  const shownRows = () => renderer!.root.findAll((node) => typeof node.type === "string" && typeof node.props["data-workspace"] === "string").map((node) => node.props["data-workspace"] as string);
  const heading = () => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "workspace-background-toggle");
  const row = (id: string) => renderer!.root.findByProps({ "data-pane": `${id}:p` });

  it("keeps a tagged workspace where herdr puts it while the setting is off", async () => {
    await draw(roster([tagged("bg1"), workspace("a"), tagged("bg2")]), "a:p");
    expect(shownRows()).toEqual(["bg1", "a", "bg2"]);
    expect(heading()).toHaveLength(0);
  });

  it("puts tagged workspaces after the others under a folded heading with their count, the open one and a question still shown", async () => {
    turnOn();
    await draw(roster([tagged("bg1"), workspace("a"), tagged("bg2"), tagged("bg3"), workspace("b")], ["bg1"]), "bg3:p");
    expect(shownRows()).toEqual(["a", "b", "bg1", "bg3"]);
    expect(heading()).toHaveLength(1);
    expect(heading()[0]!.props["aria-expanded"]).toBe(false);
    expect(heading()[0]!.findByProps({ className: "workspace-background-count" }).props.children).toBe(3);
    expect(drawnWorkspaceRows("local")).toEqual(["a", "b", "bg1", "bg3"]);
  });

  it("opens the part from its heading and keeps that fold for the PC on this device", async () => {
    turnOn();
    const snapshot = roster([tagged("bg1"), workspace("a"), tagged("bg2")]);
    await draw(snapshot, "a:p");
    expect(shownRows()).toEqual(["a"]);
    await act(async () => heading()[0]!.props.onClick());
    expect(shownRows()).toEqual(["a", "bg1", "bg2"]);
    expect(stored.get(FOLD_KEY)).toBe("0");
    await act(async () => renderer!.unmount());
    await draw(snapshot, "a:p");
    expect(shownRows()).toEqual(["a", "bg1", "bg2"]);
  });

  it("opens a folded part while the filter matches a row in it", async () => {
    turnOn();
    const snapshot = roster([tagged("bg1"), workspace("a"), tagged("bg2")]);
    await draw(snapshot, "a:p", sidebarFilter("bg2", [{ id: "local", name: "Host", snapshot }], { machineId: "local", paneId: "a:p" }, (text) => text));
    expect(shownRows()).toEqual(["a", "bg2"]);
    expect(heading()[0]!.props["aria-expanded"]).toBe(true);
  });

  it("moves a row with Alt+arrows only among the rows of its own part", async () => {
    turnOn();
    stored.set(FOLD_KEY, "0");
    const coordinator = await draw(roster([tagged("bg1"), workspace("a"), tagged("bg2"), workspace("b")]), "a:p");
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(shownRows()).toEqual(["a", "b", "bg1", "bg2"]);
    await act(async () => row("b").props.onKeyDown(keyPress("ArrowDown", true)));
    await act(async () => row("bg1").props.onKeyDown(keyPress("ArrowUp", true)));
    expect(reorder).not.toHaveBeenCalled();
    await act(async () => row("a").props.onKeyDown(keyPress("ArrowDown", true)));
    await act(async () => row("bg1").props.onKeyDown(keyPress("ArrowDown", true)));
    expect(reorder.mock.calls.map((call) => call[2])).toEqual([["bg1", "bg2", "b", "a"], ["a", "bg2", "bg1", "b"]]);
  });

  it("keeps a tagged worktree with its repository, also once a pin of the repository sets it apart as a row", async () => {
    turnOn();
    const repo = (linked: boolean) => ({ is_linked_worktree: linked, repo_key: "r", repo_name: "r", repo_root: "/r", checkout_path: "/r" });
    setSidebarPins([workspacePinKey("local", "root")]);
    await draw(roster([{ ...workspace("root"), worktree: repo(false) }, { ...tagged("wt"), worktree: repo(true) }, workspace("a")]), "a:p");
    expect(shownRows()).toEqual(["root", "wt", "a"]);
    expect(heading()).toHaveLength(0);
  });

  it("keeps a folded part's rows in place, so a move never passes the rows the fold hides", async () => {
    turnOn();
    const coordinator = await draw(roster([tagged("bg1"), tagged("bg2"), tagged("bg3"), workspace("a")], ["bg1", "bg3"]), "a:p");
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(shownRows()).toEqual(["a", "bg1", "bg3"]);
    expect(row("bg1").props["aria-keyshortcuts"]).toBeUndefined();
    expect(row("bg1").props.draggable).toBe(false);
    await act(async () => row("bg1").props.onKeyDown(keyPress("ArrowDown", true)));
    expect(reorder).not.toHaveBeenCalled();
  });
});
