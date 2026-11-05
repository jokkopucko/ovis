import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { RowMenu } from "./RowMenu.tsx";
import { TabStrip } from "./TabStrip.tsx";

/** herdr's TUI server, a herdr-core PC the Herdr app lays out, and one whose layout Ovis keeps (lib/machineContext.tsx) */
const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: false, move: true } });

const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: `${tabId}:p`, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${tabId}:term`, revision: 1, focused: false, agent_status: "idle" });
// w1 has two one-pane tabs, so t1 can move right and to w2; w2 has one
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", workspaces: [workspace("w1", 2), workspace("w2", 1)], layouts: [], agents: [],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "", number: 1, pane_count: 1, focused: true, agent_status: "idle" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "", number: 2, pane_count: 1, focused: false, agent_status: "idle" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [pane("w1", "w1:t1"), pane("w1", "w1:t2"), pane("w2", "w2:t1")],
};
// the test renderer draws no DOM: a node stands in for every element, connected and measurable, so the tab's menu can open
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {}, scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;
const noKeys = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, preventDefault() {}, stopPropagation() {} };

describe("the tab strip on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  let requested: string[];
  let activeTab: { dataset: { tabId: string } };

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    requested = [];
    activeTab = { dataset: { tabId: "w1:t1" } };
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    // the keyboard handler reads the focused tab; the portal RowMenu draws into needs an element the test renderer can append to
    define("document", { visibilityState: "visible", activeElement: activeTab, body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

  async function draw(offer: LayoutOffer): Promise<void> {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(TabStrip, { snapshot, workspace: snapshot.workspaces[0]!, selectedPane: snapshot.panes[0]!, onSelectPane: () => {}, onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {} }))), { createNodeMock: node });
    });
  }
  const tab = () => renderer!.root.findByProps({ "data-tab-id": "w1:t1" });
  const strip = () => renderer!.root.findByProps({ role: "tablist" });
  const menuOf = async (): Promise<string[]> => {
    await act(async () => tab().props.onContextMenu({ type: "contextmenu", currentTarget: node(), clientX: 0, clientY: 0, preventDefault() {} }));
    return (renderer!.root.findByType(RowMenu).props.items as { id: string }[]).map((item) => item.id);
  };
  const keyDown = async (key: string, modifiers: Partial<typeof noKeys> = {}): Promise<void> => {
    await act(async () => strip().props.onKeyDown({ ...noKeys, ...modifiers, key, currentTarget: { querySelectorAll: () => [activeTab] } }));
  };
  const renameFields = () => renderer!.root.findAllByProps({ className: "input tab-strip-rename" }).length;
  const withFetch = async (run: () => Promise<void>): Promise<void> => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Response.json({ tabs: [{ tab_id: "w1:t2" }, { tab_id: "w1:t1" }] });
    }, { preconnect: globalThis.fetch.preconnect }));
    try { await run(); } finally { fetch.mockRestore(); }
  };

  it("offers a TUI PC's tab its moves and rename, by menu, keys and a double-click", async () => {
    await withFetch(async () => {
      await draw(TUI);
      expect(await menuOf()).toEqual(["move-right", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
      expect(tab().props["aria-keyshortcuts"]).toBe("Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight");
      expect(typeof tab().props.onDoubleClick).toBe("function");
      await keyDown("F2");
      expect(renameFields()).toBe(1);
      await keyDown("ArrowRight", { altKey: true, shiftKey: true });
      expect(strip().props["aria-busy"]).toBe(true);
      expect(requested).toEqual(["/api/tab/move"]);
    });
  });

  it("keeps a core PC's tab as the Herdr app names and orders it: New tab with agent and Close stay", async () => {
    await withFetch(async () => {
      await draw(APP_CORE);
      expect(await menuOf()).toEqual(["new-agent-tab", "close-tab"]);
      expect(tab().props["aria-keyshortcuts"]).toBe("Shift+F10");
      expect(tab().props.onDoubleClick).toBeUndefined();
      await keyDown("F2");
      expect(renameFields()).toBe(0);
      await keyDown("ArrowRight", { altKey: true, shiftKey: true });
      expect(strip().props["aria-busy"]).toBe(false);
      expect(requested).toEqual([]);
    });
  });

  it("renames a core PC's tab and moves it to another workspace where Ovis keeps its layout, but keeps its order", async () => {
    await withFetch(async () => {
      await draw(OVIS_CORE);
      expect(await menuOf()).toEqual(["move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
      expect(tab().props["aria-keyshortcuts"]).toBe("Shift+F10");
      expect(typeof tab().props.onDoubleClick).toBe("function");
      await keyDown("F2");
      expect(renameFields()).toBe(1);
      await keyDown("ArrowRight", { altKey: true, shiftKey: true });
      expect(requested).toEqual([]);
    });
  });
});
