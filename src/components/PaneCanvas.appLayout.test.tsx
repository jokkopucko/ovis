import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import type { RowMenuItem } from "./RowMenu.tsx";
import { PaneCanvas } from "./PaneCanvas.tsx";

/** herdr's TUI server, a herdr-core PC the Herdr app lays out, and one whose layout Ovis keeps (lib/machineContext.tsx) */
const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: false, move: true } });

const pane = (id: string, label?: string): HerdrPane =>
  ({ pane_id: id, workspace_id: "w1", tab_id: "t1", terminal_id: `${id}:term`, revision: 1, focused: id === "p1", agent_status: "idle", label }) as HerdrPane;
// one tab, split in two side by side: a divider stands between p1 and p2
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [],
  workspaces: [{ workspace_id: "w1", label: "w1", active_tab_id: "t1", number: 1, tab_count: 1, pane_count: 2, focused: true, agent_status: "idle", worktree: null }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "", number: 1, pane_count: 2, focused: true, agent_status: "idle" }],
  panes: [pane("p1", "named"), pane("p2")],
  layouts: [{
    tab_id: "t1", workspace_id: "w1", focused_pane_id: "p1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
  }],
};

describe("the pane canvas on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  // every media query answers alike: true is a cramped phone (SOLO_PANE_QUERY and CRAMPED_QUERY both hold)
  let phone = false;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    phone = false;
    const media = { get matches() { return phone; }, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

  async function draw(offer: LayoutOffer, drawn: SessionSnapshot = snapshot): Promise<(target: HerdrPane) => string[]> {
    const actionsRef: { current: ((target: HerdrPane) => RowMenuItem[]) | null } = { current: null };
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(PaneCanvas, { snapshot: drawn, pane: drawn.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef,
          onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {} }))));
    });
    return (target) => actionsRef.current!(target).map((item) => item.id);
  }
  const dividers = () => renderer!.root.findAllByProps({ role: "separator" }).length;

  it("offers a TUI PC's panes their name, swap, split and zoom items, and a divider to drag", async () => {
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "split-right", "split-down", "zoom", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["rename", "swap-focused", "split-right", "split-down", "zoom", "close"]);
    expect(dividers()).toBe(1);
  });

  it("gives a lone tab with no row (a cramped phone) the row's menu, for the header's More menu, and no pane ellipsis", async () => {
    phone = true;
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["pane:p1", "pane:p2", "rename", "clear-name", "close", "new-terminal", "new-agent-tab", "rename-tab", "close-tab"]);
    const heads = renderer!.root.findAll((node) => node.props.className === "pane-frame-head");
    expect(heads.map((head) => head.parent?.props["data-layout-pane"])).toEqual(["p2"]);
  });

  // a one-pane lone tab beside another workspace: herdr moves it there, as the row's menu offers
  const movable: SessionSnapshot = {
    ...snapshot,
    workspaces: [{ ...snapshot.workspaces[0]!, pane_count: 1 }, { ...snapshot.workspaces[0]!, workspace_id: "w2", label: "w2", active_tab_id: "t2", number: 2, focused: false }],
    tabs: [{ ...snapshot.tabs[0]!, pane_count: 1 }, { ...snapshot.tabs[0]!, tab_id: "t2", workspace_id: "w2", focused: false }],
    panes: [pane("p1"), { ...pane("p3"), workspace_id: "w2", tab_id: "t2" } as HerdrPane],
    layouts: [],
  };

  it("gives a lone one-pane tab with no row Move to workspace and Close tab, as the row's menu does", async () => {
    phone = true;
    const itemsOf = await draw(TUI, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["rename", "close", "new-terminal", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
  });

  it("keeps a lone tab with no row on a PC the Herdr app lays out to Close tab, with no move or rename", async () => {
    phone = true;
    const itemsOf = await draw(APP_CORE, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["close", "new-terminal", "new-agent-tab", "close-tab"]);
  });

  it("gives a lone tab with no row on a core whose layout Ovis keeps its move and rename, but no pane name", async () => {
    phone = true;
    const itemsOf = await draw(OVIS_CORE, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["close", "new-terminal", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
  });

  it("leaves no actions behind for the header's menu once the canvas is gone", async () => {
    const actionsRef: { current: ((target: HerdrPane) => RowMenuItem[]) | null } = { current: null };
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(PaneCanvas, { snapshot, pane: snapshot.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef })));
    });
    expect(actionsRef.current).not.toBeNull();
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect(actionsRef.current).toBeNull();
  });

  it("keeps the row's own menu where a lone tab's row is drawn", async () => {
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).not.toContain("new-terminal");
    expect(renderer!.root.findAll((node) => node.props.className === "pane-frame-head")).toHaveLength(2);
  });

  it("leaves a core PC's panes to the Herdr app: Close pane stays, no divider is drawn", async () => {
    const itemsOf = await draw(APP_CORE);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["close"]);
    expect(dividers()).toBe(0);
  });
});
