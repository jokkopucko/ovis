import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { CommandPalette } from "./CommandPalette.tsx";

/** herdr's TUI server, a herdr-core PC the Herdr app lays out, and one whose layout Ovis keeps (lib/machineContext.tsx) */
const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: false, move: true } });
const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (id: string, workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: id, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle" });
// w1's tab holds two panes (a zoom means something there); w2's tab holds one (it can move to w1)
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [], workspaces: [workspace("w1", 1), workspace("w2", 1)],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "", number: 1, pane_count: 2, focused: true, agent_status: "idle" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [pane("p1", "w1", "w1:t1"), pane("p2", "w1", "w1:t1"), pane("p3", "w2", "w2:t1")],
  layouts: [{
    tab_id: "w1:t1", workspace_id: "w1", focused_pane_id: "p1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
  }],
};
const machines: Machine[] = [{ id: "local", name: "Host", kind: "local", enabled: true, state: "connected", error: null, snapshot }];
// App's actions on each PC: split and zoom as the PC offers them (lib/layoutActions.ts, tested there)
const actionsOf = (offer: LayoutOffer) => new Proxy({ splitPane: offer.split ? () => {} : null, zoomPane: offer.arrange ? () => {} : null, enableNotifications: null, openFiles: null, lock: null }, { get: (own, key) => key in own ? own[key as keyof typeof own] : () => {} }) as unknown as AppActions;
const LAYOUT_ROWS = ["Rename tab", "Split pane right", "Split pane down", "Split pane right and open it", "Split pane down and open it", "Zoom pane"];

describe("the command palette on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  // a cramped screen's height query (CRAMPED_QUERY) holds: a lone tab draws no row there
  let phone = false;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    phone = false;
    const media = (query: string) => ({ get matches() { return phone && query.includes("max-height"); }, addEventListener() {}, removeEventListener() {} });
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    // the test renderer draws no DOM: nothing is an element, so the focus trap finds nothing to hold
    define("HTMLElement", class HTMLElement {});
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: media, innerWidth: 1280, innerHeight: 800, history: { state: null, pushState() {}, replaceState() {}, back() {} }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function rows(offer: LayoutOffer, selectedPaneId: string, initialQuery: string): Promise<string[]> {
    await act(async () => { renderer?.unmount(); });
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(CommandPalette, { open: true, initialQuery, onClose: () => {}, machines, onSelect: () => {}, snapshot, online: false, selectedPaneId, view: "chat", actions: actionsOf(offer) }))));
    });
    return renderer!.root.findAll((node) => node.props.className === "menu-item-main" && typeof node.props.children === "string").map((node) => node.props.children as string);
  }

  it("lists a TUI PC's rename, split, zoom and move rows", async () => {
    const listed = await rows(TUI, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).toContain(row);
    expect(await rows(TUI, "p3", ">move tab")).toEqual(["Move tab to w1"]);
  });

  it("keeps Rename tab where a lone tab draws no row, whose dialog stands in for the row's field", async () => {
    phone = true;
    expect(await rows(TUI, "p3", ">rename tab")).toEqual(["Rename tab"]);
  });

  it("lists none of them on a core PC, and keeps New workspace and New tab", async () => {
    const listed = await rows(APP_CORE, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).not.toContain(row);
    expect(listed).toContain("New workspace");
    expect(listed).toContain("New tab");
    expect(await rows(APP_CORE, "p3", ">move tab")).toEqual([]);
  });

  it("lists a core PC's rename and move rows where Ovis keeps its layout, but no split or zoom", async () => {
    const listed = await rows(OVIS_CORE, "p1", ">");
    expect(listed).toContain("Rename tab");
    for (const row of LAYOUT_ROWS.filter((row) => row !== "Rename tab")) expect(listed).not.toContain(row);
    expect(await rows(OVIS_CORE, "p3", ">move tab")).toEqual(["Move tab to w1"]);
  });
});
