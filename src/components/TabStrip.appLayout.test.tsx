import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Pencil, Terminal } from "lucide-react";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { setSidebarPins } from "../lib/sidebarPins.ts";
import { RowMenu } from "./RowMenu.tsx";
import { TabStrip } from "./TabStrip.tsx";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });

const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: `${tabId}:p`, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${tabId}:term`, revision: 1, focused: false, agent_status: "idle" });
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
  let media: { matches: boolean; addEventListener(): void; removeEventListener(): void };
  let requested: string[];
  let activeTab: { dataset: { tabId: string } };

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "CSS", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    requested = [];
    activeTab = { dataset: { tabId: "w1:t1" } };
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("CSS", { escape: (value: string) => value });
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
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

  async function draw(offer: LayoutOffer, workspace: WorkspaceInfo | null = snapshot.workspaces[0]!, beside?: WorkspaceInfo): Promise<void> {
    const strip = (shown: WorkspaceInfo) => createElement(TabStrip, { snapshot, workspace: shown, selectedPane: snapshot.panes[0]!, onSelectPane: () => {}, onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {} });
    const tree = createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
      workspace && strip(workspace), beside && strip(beside)));
    await act(async () => { if (renderer) renderer.update(tree); else renderer = create(tree, { createNodeMock: node }); });
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

  it("offers no Close tab for a tab holding a locked pinned agent, and its Delete and middle click close nothing (#2432)", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:w1:t1:p"] }));
    setSidebarPins(["local:w1:t1:p"]);
    try {
      await withFetch(async () => {
        await draw(TUI);
        expect(await menuOf()).toEqual(["move-right", "move-workspace", "new-agent-tab", "rename-tab"]);
        await keyDown("Delete");
        await act(async () => tab().props.onAuxClick({ button: 1, preventDefault() {} }));
        expect(requested).toEqual([]);
      });
    } finally {
      setSidebarPins([]);
    }
  });

  it("offers no Close tab for a tab whose locked pane the strip leaves out of its list, as a DAG viewer's (#2432)", async () => {
    const viewer = { pane_id: "w1:t1:dag", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "w1:t1:dag:term", revision: 1, focused: false, agent_status: "idle", label: "DAG · s" } as PaneInfo;
    snapshot.panes.push(viewer);
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:w1:t1:dag"] }));
    setSidebarPins(["local:w1:t1:dag"]);
    try {
      await withFetch(async () => {
        await draw(TUI);
        expect(await menuOf()).not.toContain("close-tab");
        await keyDown("Delete");
        expect(requested).toEqual([]);
      });
    } finally {
      snapshot.panes.pop();
      setSidebarPins([]);
    }
  });

  it("renames, reorders and moves a core PC's tab to another workspace where Ovis keeps its layout", async () => {
    await withFetch(async () => {
      await draw(OVIS_CORE);
      expect(await menuOf()).toEqual(["move-right", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
      await keyDown("F2");
      expect(renameFields()).toBe(1);
    });
  });

  it("keeps a tab's inline rename draft across Escape and blur until it is saved", async () => {
    await withFetch(async () => {
      await draw(TUI);
      const input = () => renderer!.root.findByProps({ className: "input tab-strip-rename" });
      await act(async () => tab().props.onDoubleClick());
      expect(renameFields()).toBe(1);
      await act(async () => input().props.onChange({ target: { value: "Escape draft survives" } }));
      await act(async () => input().props.onKeyDown({ key: "Escape", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 27 } }));
      expect(renameFields()).toBe(0);
      expect(requested).toEqual([]);

      await act(async () => tab().props.onDoubleClick());
      expect(input().props.value).toBe("Escape draft survives");

      await act(async () => input().props.onKeyDown({ key: "Enter", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 13 } }));
      expect(renameFields()).toBe(0);
      expect(requested).toEqual(["/api/tab/rename"]);
    });
  });

  it("keeps one half's unfinished name when the split view's other half opens another workspace", async () => {
    await draw(TUI);
    const input = () => renderer!.root.findByProps({ className: "input tab-strip-rename" });
    await act(async () => tab().props.onDoubleClick());
    await act(async () => input().props.onChange({ target: { value: "keep me" } }));
    await act(async () => input().props.onKeyDown({ key: "Escape", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 27 } }));

    await draw(TUI, snapshot.workspaces[0]!, { ...snapshot.workspaces[0]!, workspace_id: "w-other" });

    await act(async () => tab().props.onDoubleClick());
    expect(input().props.value).toBe("keep me");
    await withFetch(async () => act(async () => input().props.onKeyDown({ key: "Enter", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 13 } })));
  });

  it("keeps one half's unfinished name when the other half of a split on the same workspace opens another", async () => {
    await draw(TUI, snapshot.workspaces[0]!, snapshot.workspaces[0]!);
    const first = () => renderer!.root.findAllByProps({ "data-tab-id": "w1:t1" })[0]!;
    const input = () => renderer!.root.findByProps({ className: "input tab-strip-rename" });
    await act(async () => first().props.onDoubleClick());
    await act(async () => input().props.onChange({ target: { value: "keep me" } }));
    await act(async () => input().props.onKeyDown({ key: "Escape", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 27 } }));

    await draw(TUI, snapshot.workspaces[0]!, { ...snapshot.workspaces[0]!, workspace_id: "w-other" });

    await act(async () => first().props.onDoubleClick());
    expect(input().props.value).toBe("keep me");
    await withFetch(async () => act(async () => input().props.onKeyDown({ key: "Enter", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 13 } })));
  });

  it("keeps a workspace's unfinished name while its strip moves, and drops it once its last strip goes", async () => {
    await draw(TUI);
    const input = () => renderer!.root.findByProps({ className: "input tab-strip-rename" });
    await act(async () => tab().props.onDoubleClick());
    const saved = input().props.value as string;
    await act(async () => input().props.onChange({ target: { value: "moving" } }));
    await act(async () => input().props.onKeyDown({ key: "Escape", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 27 } }));

    await draw(TUI, null, snapshot.workspaces[0]!);
    await act(async () => tab().props.onDoubleClick());
    expect(input().props.value).toBe("moving");
    await act(async () => input().props.onKeyDown({ key: "Escape", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 27 } }));

    await draw(TUI, null);
    await draw(TUI);
    await act(async () => tab().props.onDoubleClick());
    expect(input().props.value).toBe(saved);
  });

  it("reopens a field moved by a turn with the name just sent, before herdr confirms it", async () => {
    await withFetch(async () => {
      await draw(TUI);
      const input = () => renderer!.root.findByProps({ className: "input tab-strip-rename" });
      await act(async () => tab().props.onDoubleClick());
      await act(async () => input().props.onChange({ target: { value: "Sent name" } }));
      await act(async () => input().props.onKeyDown({ key: "Enter", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 13 } }));
      await act(async () => tab().props.onDoubleClick());
      expect(input().props.value).toBe("Sent name");

      await draw(TUI, null);
      media.matches = true;
      await draw(TUI);

      expect(input().props.value).toBe("Sent name");
      await act(async () => input().props.onKeyDown({ key: "Enter", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 13 } }));
      expect(renameFields()).toBe(0);
    });
  });

  it("names a phone's open split tab for its open pane, and a tap on it lists the tab's panes once", async () => {
    const lead = { ...pane("w1", "w1:t1"), agent: "claude" } as PaneInfo;
    const shell = { ...pane("w1", "w1:t1"), pane_id: "w1:t1:q", terminal_id: "w1:t1:q:term", label: "build shell" } as PaneInfo;
    const split = (label: string): SessionSnapshot => ({ ...snapshot, tabs: snapshot.tabs.map((entry) => entry.tab_id === "w1:t1" ? { ...entry, label, pane_count: 2 } : entry), panes: [lead, shell, ...snapshot.panes.slice(1)] });
    // the header's tabs hand the pane's own actions over with the tab's panes in them
    const paneActions = () => [{ id: "pane:w1:t1:p", label: "lead", icon: Terminal, run() {} }, { id: "rename", label: "Rename pane", icon: Pencil, run() {} }];
    const drawSplit = async (shown: SessionSnapshot): Promise<void> => {
      const tree = createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: TUI },
        createElement(TabStrip, { snapshot: shown, workspace: shown.workspaces[0]!, selectedPane: shell, onSelectPane: (paneId: string) => { picked.push(paneId); }, onNewTab: () => {}, onNewTerminal: async () => {}, paneActions })));
      await act(async () => { if (renderer) renderer.update(tree); else renderer = create(tree, { createNodeMock: node }); });
    };
    const picked: string[] = [];
    const menu = () => renderer!.root.findByType(RowMenu).props as { title: string; items: { id: string; run: () => void }[] };
    const chip = () => tab().findByProps({ className: "tab-strip-label" }).children.join("");
    const marks = () => tab().findAll((found) => found.props.className === "tab-strip-agent").length;
    // a 700px window: one pane of a split at a time, the menu a popover rather than a phone's sheet
    const wide = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...media, matches: query.includes("(max-width: 768px)") && !query.includes("max-height") }) as unknown as MediaQueryList;

    await drawSplit(split(""));
    expect(chip()).toBe("build shell");
    expect(marks()).toBe(0);
    await act(async () => tab().props.onClick({ currentTarget: node(), detail: 1, ctrlKey: false }));
    expect(menu().items.map((item) => item.id))
      .toEqual(["pane:w1:t1:p", "pane:w1:t1:q", "rename", "move-right", "new-agent-tab", "rename-tab", "close-tab"]);
    await act(async () => menu().items[0]!.run());
    expect(picked).toEqual(["w1:t1:p"]);

    // named from elsewhere while its menu is open: the chip and the menu take the new name
    await drawSplit(split("deploy"));
    expect(chip()).toBe("deploy");
    expect(menu().title).toBe("deploy");

    window.matchMedia = wide;
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await drawSplit(split(""));
    expect(chip()).toBe("Tab 1");
    expect(marks()).toBe(1);
  });

  it("leaves a tab's unfinished name behind when the strip moves to another workspace", async () => {
    await draw(TUI);
    const input = () => renderer!.root.findByProps({ className: "input tab-strip-rename" });
    await act(async () => tab().props.onDoubleClick());
    const saved = input().props.value as string;
    await act(async () => input().props.onChange({ target: { value: "left behind" } }));
    await act(async () => input().props.onKeyDown({ key: "Escape", stopPropagation() {}, nativeEvent: { isComposing: false, keyCode: 27 } }));

    await draw(TUI, { ...snapshot.workspaces[0]!, workspace_id: "w-other" });
    await draw(TUI);

    await act(async () => tab().props.onDoubleClick());
    expect(input().props.value).toBe(saved);
  });
});
