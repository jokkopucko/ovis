import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Pencil, Terminal } from "lucide-react";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { setSidebarPins } from "../lib/sidebarPins.ts";
import { TabStrip } from "./TabStrip.tsx";
import { paneDrag } from "../lib/paneDrag.ts";

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
describe("the tab strip on a PC the Herdr app lays out", () => {
  let page: Page;
  const browserGlobals = ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "CSS", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let media: { matches: boolean; addEventListener(): void; removeEventListener(): void };
  let requested: string[];

  beforeEach(() => {
    page = openPage();
    requested = [];
    media = { matches: false, addEventListener() {}, removeEventListener() {} };
    Object.defineProperties(page.window, {
      matchMedia: { configurable: true, writable: true, value: () => media },
      innerWidth: { configurable: true, value: 1280 },
      innerHeight: { configurable: true, value: 800 },
      requestAnimationFrame: { configurable: true, value: () => 1 },
      cancelAnimationFrame: { configurable: true, value: () => {} },
    });
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
  });

  afterEach(async () => {
    paneDrag.cancel();
    await page.close();
    for (const [key, descriptor] of savedBrowserGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function draw(offer: LayoutOffer, workspace: WorkspaceInfo | null = snapshot.workspaces[0]!, beside?: WorkspaceInfo): Promise<void> {
    const strip = (shown: WorkspaceInfo) => createElement(TabStrip, { snapshot, workspace: shown, selectedPane: snapshot.panes[0]!, onSelectPane: () => {}, onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {} });
    const tree = createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
      workspace && strip(workspace), beside && strip(beside)));
    await page.render(tree);
  }
  const tab = () => page.one<HTMLButtonElement>('[data-tab-id="w1:t1"]');
  const strip = () => page.one('[role="tablist"]');
  const input = () => page.one<HTMLInputElement>('[class="input tab-strip-rename"]');
  const renameFields = () => page.container.querySelectorAll('[class="input tab-strip-rename"]').length;
  const mouse = (node: HTMLElement, type: string, init: MouseEventInit = {}) => act(async () => {
    node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
  const contextMenu = (node: HTMLElement, clientX = 0, clientY = 0, pointerType = "") => act(async () => {
    node.dispatchEvent(new window.PointerEvent("contextmenu", { clientX, clientY, pointerType, bubbles: true, cancelable: true }));
  });
  const menu = () => page.window.document.querySelector(".row-menu, .row-sheet");
  const menuButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".row-menu button[data-item], .row-sheet button[data-item]")];
  const menuIds = () => menuButtons().map((item) => item.getAttribute("data-item"));
  const pressMenu = (id: string) => act(async () => {
    const item = menuButtons().find((button) => button.getAttribute("data-item") === id);
    if (!item) throw new Error(`Missing menu item ${id}`);
    item.click();
  });
  const menuOf = async () => { await contextMenu(tab()); return menuIds(); };
  const key = (node: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) => {
    node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  };
  const keyDown = (pressed: string, modifiers: KeyboardEventInit = {}) => act(async () => {
    const active = strip().querySelector<HTMLElement>('[role="tab"][data-tab-id="w1:t1"]');
    active?.focus();
    key(strip(), pressed, modifiers);
  });
  const renameKey = (pressed: "Enter" | "Escape") => act(async () => {
    key(input(), pressed, { keyCode: pressed === "Enter" ? 13 : 27 });
  });
  const doubleClick = (node = tab()) => mouse(node, "dblclick");
  const pointer = (node: HTMLElement, type: string, init: PointerEventInit = {}) => {
    node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
  };
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
      expect(tab().getAttribute("aria-keyshortcuts")).toBe("Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight");
      await doubleClick();
      expect(renameFields()).toBe(1);
      await renameKey("Escape");
      await keyDown("F2");
      expect(renameFields()).toBe(1);
      await renameKey("Escape");
      await keyDown("ArrowRight", { altKey: true, shiftKey: true });
      expect(strip().getAttribute("aria-busy")).toBe("true");
      expect(requested).toEqual(["/api/tab/move"]);
    });
  });

  it("keeps a core PC's tab as the Herdr app names and orders it: New tab with agent and Close stay", async () => {
    await withFetch(async () => {
      await draw(APP_CORE);
      expect(await menuOf()).toEqual(["new-agent-tab", "close-tab"]);
      expect(tab().getAttribute("aria-keyshortcuts")).toBe("Shift+F10");
      await doubleClick();
      expect(renameFields()).toBe(0);
      await keyDown("F2");
      expect(renameFields()).toBe(0);
      await keyDown("ArrowRight", { altKey: true, shiftKey: true });
      expect(strip().getAttribute("aria-busy")).toBe("false");
      expect(requested).toEqual([]);
    });
  });

  it("offers no Close tab for a tab holding a locked pinned agent, and its Delete and middle click close nothing (#2432)", async () => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:w1:t1:p"] }));
    setSidebarPins(["local:w1:t1:p"]);
    try {
      await withFetch(async () => {
        await draw(TUI);
        expect(await menuOf()).toEqual(["move-right", "move-workspace", "new-agent-tab", "rename-tab"]);
        await keyDown("Delete");
        await mouse(tab(), "auxclick", { button: 1 });
        expect(requested).toEqual([]);
      });
    } finally {
      setSidebarPins([]);
    }
  });

  it("offers no Close tab for a tab whose locked pane the strip leaves out of its list, as a DAG viewer's (#2432)", async () => {
    const viewer = { pane_id: "w1:t1:dag", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "w1:t1:dag:term", revision: 1, focused: false, agent_status: "idle", label: "DAG · s" } as PaneInfo;
    snapshot.panes.push(viewer);
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:w1:t1:dag"] }));
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

      await doubleClick();
      expect(renameFields()).toBe(1);
      await page.type(input(), "Escape draft survives");
      await renameKey("Escape");
      expect(renameFields()).toBe(0);
      expect(requested).toEqual([]);

      await doubleClick();
      expect(input().value).toBe("Escape draft survives");

      await renameKey("Enter");
      expect(renameFields()).toBe(0);
      expect(requested).toEqual(["/api/tab/rename"]);
    });
  });

  it("keeps one half's unfinished name when the split view's other half opens another workspace", async () => {
    await draw(TUI);

    await doubleClick();
    await page.type(input(), "keep me");
    await renameKey("Escape");

    await draw(TUI, snapshot.workspaces[0]!, { ...snapshot.workspaces[0]!, workspace_id: "w-other" });

    await doubleClick();
    expect(input().value).toBe("keep me");
    await withFetch(async () => renameKey("Enter"));
  });

  it("keeps one half's unfinished name when the other half of a split on the same workspace opens another", async () => {
    await draw(TUI, snapshot.workspaces[0]!, snapshot.workspaces[0]!);
    const first = () => page.container.querySelectorAll<HTMLButtonElement>('[data-tab-id="w1:t1"]')[0]!;

    await doubleClick(first());
    await page.type(input(), "keep me");
    await renameKey("Escape");

    await draw(TUI, snapshot.workspaces[0]!, { ...snapshot.workspaces[0]!, workspace_id: "w-other" });

    await doubleClick(first());
    expect(input().value).toBe("keep me");
    await withFetch(async () => renameKey("Enter"));
  });

  it("keeps a workspace's unfinished name while its strip moves, and drops it once its last strip goes", async () => {
    await draw(TUI);

    await doubleClick();
    const saved = input().value;
    await page.type(input(), "moving");
    await renameKey("Escape");

    await draw(TUI, null, snapshot.workspaces[0]!);
    await doubleClick();
    expect(input().value).toBe("moving");
    await renameKey("Escape");

    await draw(TUI, null);
    await draw(TUI);
    await doubleClick();
    expect(input().value).toBe(saved);
  });

  it("reopens a field moved by a turn with the name just sent, before herdr confirms it", async () => {
    await withFetch(async () => {
      await draw(TUI);

      await doubleClick();
      await page.type(input(), "Sent name");
      await renameKey("Enter");
      await doubleClick();
      expect(input().value).toBe("Sent name");

      await draw(TUI, null);
      media.matches = true;
      await draw(TUI);

      expect(input().value).toBe("Sent name");
      await renameKey("Enter");
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
      await page.render(tree);
    };
    const picked: string[] = [];
    const chip = () => tab().querySelector('[class="tab-strip-label"]')?.textContent;
    const marks = () => tab().querySelectorAll('[class="tab-strip-agent"]').length;
    // a 700px window: one pane of a split at a time, the menu a popover rather than a phone's sheet
    const wide = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...media, matches: query.includes("(max-width: 768px)") && !query.includes("max-height") }) as unknown as MediaQueryList;

    await drawSplit(split(""));
    expect(chip()).toBe("build shell");
    expect(marks()).toBe(0);
    await mouse(tab(), "click", { detail: 1 });
    expect(menuIds())
      .toEqual(["pane:w1:t1:p", "pane:w1:t1:q", "rename", "move-right", "new-agent-tab", "rename-tab", "close-tab"]);
    await pressMenu("pane:w1:t1:p");
    await mouse(tab(), "click", { detail: 1 });
    expect(picked).toEqual(["w1:t1:p"]);

    // named from elsewhere while its menu is open: the chip and the menu take the new name
    await drawSplit(split("deploy"));
    expect(chip()).toBe("deploy");
    expect(menu()?.getAttribute("aria-label")).toBe("deploy");

    window.matchMedia = wide;
    await page.render(null);
    await drawSplit(split(""));
    expect(chip()).toBe("Tab 1");
    expect(marks()).toBe(1);
  });

  it("leaves a tab's unfinished name behind when the strip moves to another workspace", async () => {
    await draw(TUI);

    await doubleClick();
    const saved = input().value;
    await page.type(input(), "left behind");
    await renameKey("Escape");

    await draw(TUI, { ...snapshot.workspaces[0]!, workspace_id: "w-other" });
    await draw(TUI);

    await doubleClick();
    expect(input().value).toBe(saved);
  });

  it("moves a single-pane tab dropped onto another workspace row, honors Move-to-workspace guards, and cancels on Escape", async () => {
    const moved: Array<{ tabId: string; workspaceId: string }> = [];
    let pointerElement: Element | null = null;
    Object.defineProperty(page.window.document, "elementFromPoint", { configurable: true, value: () => pointerElement });

    const machine = document.createElement("div");
    machine.className = "machine-workspaces";
    machine.dataset["machine"] = "local";
    document.body.append(machine);
    const fakeWorkspaceRow = (workspaceId: string): Element => {
      const group = document.createElement("div");
      group.className = "workspace-group";
      group.dataset["workspace"] = workspaceId;
      const header = document.createElement("div");
      header.className = "workspace-header";
      group.append(header);
      machine.replaceChildren(group);
      return header;
    };
    const capture = (target: HTMLElement) => {
      Object.defineProperties(target, {
        setPointerCapture: { configurable: true, value: () => {} },
        hasPointerCapture: { configurable: true, value: () => true },
        releasePointerCapture: { configurable: true, value: () => {} },
      });
    };

    const drawForDrag = async (offer: LayoutOffer, { shown = snapshot, closable = true, splitDrag = true }: { shown?: SessionSnapshot; closable?: boolean; splitDrag?: boolean } = {}): Promise<void> => {
      const tree = createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(TabStrip, {
          snapshot: shown,
          workspace: shown.workspaces[0]!,
          selectedPane: shown.panes[0]!,
          onSelectPane: () => {},
          onNewTab: () => {},
          onNewTerminal: async () => {},
          onMoveToWorkspace: async (tabId, workspaceId) => { moved.push({ tabId, workspaceId }); },
          splitDrag,
          closable,
        })));
      await page.render(tree);
    };

    const dragTabOver = async (workspaceId: string, action: "drop" | "escape"): Promise<typeof paneDrag extends { snapshot(): infer R } ? R : never> => {
      pointerElement = fakeWorkspaceRow(workspaceId);

      await act(async () => {
        capture(tab());
        pointer(tab(), "pointerdown", { pointerType: "mouse", button: 0, ctrlKey: false, isPrimary: true, pointerId: 1, clientX: 40, clientY: 5 });
      });
      await act(async () => {
        pointer(tab(), "pointermove", { pointerId: 1, clientX: 40, clientY: 120 });
      });
      const hitWhileOver = paneDrag.snapshot();
      if (action === "escape") {
        await act(async () => {
          window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
        });
      }
      await act(async () => {
        pointer(tab(), "pointerup", { pointerId: 1, clientX: 40, clientY: 120 });
      });
      return hitWhileOver;
    };

    await drawForDrag(TUI);
    expect((await dragTabOver("w1", "drop"))?.workspaceTarget).toBeUndefined();
    expect(moved).toEqual([]);

    expect((await dragTabOver("w2", "escape"))?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });
    expect(paneDrag.snapshot()).toBeNull();
    expect(moved).toEqual([]);

    expect((await dragTabOver("w2", "drop"))?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });
    expect(moved).toEqual([{ tabId: "w1:t1", workspaceId: "w2" }]);

    moved.length = 0;
    await drawForDrag(OVIS_CORE);
    expect((await dragTabOver("w2", "drop"))?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });
    expect(moved).toEqual([{ tabId: "w1:t1", workspaceId: "w2" }]);

    moved.length = 0;
    await drawForDrag(APP_CORE);
    expect((await dragTabOver("w2", "drop"))?.workspaceTarget).toBeUndefined();
    expect(moved).toEqual([]);

    await drawForDrag(TUI, { closable: false });
    expect((await dragTabOver("w2", "drop"))?.workspaceTarget).toBeUndefined();
    expect(moved).toEqual([]);

    const splitSnapshot: SessionSnapshot = {
      ...snapshot,
      panes: [...snapshot.panes, { ...pane("w1", "w1:t1"), pane_id: "w1:t1:second", terminal_id: "w1:t1:second:term" }],
    };
    await drawForDrag(TUI, { shown: splitSnapshot });
    expect((await dragTabOver("w2", "drop"))?.workspaceTarget).toBeUndefined();
    expect(moved).toEqual([]);

    // A second pane joining mid-drag clears the sidebar target immediately and prevents moving on drop.
    await drawForDrag(TUI);
    pointerElement = fakeWorkspaceRow("w2");

    await act(async () => {
      capture(tab());
      pointer(tab(), "pointerdown", { pointerType: "mouse", button: 0, ctrlKey: false, isPrimary: true, pointerId: 2, clientX: 40, clientY: 5 });
    });
    await act(async () => {
      pointer(tab(), "pointermove", { pointerId: 2, clientX: 40, clientY: 120 });
    });
    expect(paneDrag.snapshot()?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });
    await drawForDrag(TUI, { shown: splitSnapshot });
    expect(paneDrag.snapshot()?.workspaceTarget).toBeUndefined();
    await act(async () => {
      pointer(tab(), "pointerup", { pointerId: 2, clientX: 40, clientY: 120 });
    });
    expect(moved).toEqual([]);

    // Disabling splitDrag mid-drag (e.g. viewport resize below 769px) cancels the shared drag cleanly.
    await drawForDrag(TUI);
    await act(async () => {
      capture(tab());
      pointer(tab(), "pointerdown", { pointerType: "mouse", button: 0, ctrlKey: false, isPrimary: true, pointerId: 3, clientX: 40, clientY: 5 });
    });
    await act(async () => {
      pointer(tab(), "pointermove", { pointerId: 3, clientX: 40, clientY: 120 });
    });
    expect(paneDrag.snapshot()?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });
    await drawForDrag(TUI, { splitDrag: false });
    expect(paneDrag.snapshot()).toBeNull();
    await act(async () => {
      pointer(tab(), "pointerup", { pointerId: 3, clientX: 40, clientY: 120 });
    });
    expect(moved).toEqual([]);

    // In-strip mouse drag-to-reorder still works when splitDrag is already false (e.g. below 769px).
    await drawForDrag(TUI, { splitDrag: false });
    await act(async () => {
      capture(tab());
      pointer(tab(), "pointerdown", { pointerType: "mouse", button: 0, ctrlKey: false, isPrimary: true, pointerId: 4, clientX: 40, clientY: 5 });
    });
    await act(async () => {
      pointer(tab(), "pointermove", { pointerId: 4, clientX: 80, clientY: 5 });
    });
    expect(page.container.querySelectorAll('[class*="is-dragging"]')).toHaveLength(1);
    await act(async () => {
      pointer(tab(), "pointerup", { pointerId: 4, clientX: 80, clientY: 5 });
    });
  });

  it("hands phone typing to the picked pane's visible tab field, re-selects the current pane, and keeps touch long-press handoff", async () => {
    const t1a = { ...pane("w1", "w1:t1"), pane_id: "w1:t1:a", terminal_id: "w1:t1:a:term" } as PaneInfo;
    const t1b = { ...pane("w1", "w1:t1"), pane_id: "w1:t1:b", terminal_id: "w1:t1:b:term" } as PaneInfo;
    const t2a = { ...pane("w1", "w1:t2"), pane_id: "w1:t2:a", terminal_id: "w1:t2:a:term" } as PaneInfo;
    const t2b = { ...pane("w1", "w1:t2"), pane_id: "w1:t2:b", terminal_id: "w1:t2:b:term" } as PaneInfo;
    const splitSnap = (layouts: SessionSnapshot["layouts"]): SessionSnapshot => ({
      ...snapshot,
      layouts,
      tabs: snapshot.tabs.map((entry) => entry.tab_id === "w1:t1" || entry.tab_id === "w1:t2" ? { ...entry, pane_count: 2 } : entry),
      panes: [t1a, t1b, t2a, t2b, snapshot.panes[2]!],
    });
    const picked: string[] = [];
    const focused: string[] = [];
    for (const id of [t1a.pane_id, t1b.pane_id, t2a.pane_id, t2b.pane_id]) {
      const frame = document.createElement("div");
      frame.className = "pane-frame";
      frame.dataset["layoutPane"] = id;
      const shell = document.createElement("div");
      shell.className = "terminal-input";
      const field = document.createElement("textarea");
      field.style.visibility = "visible";
      field.addEventListener("focus", () => { focused.push(id); });
      shell.append(field);
      frame.append(shell);
      document.body.append(frame);
    }
    const typingFrame = document.createElement("div");
    typingFrame.className = "pane-frame";
    const typingField = document.createElement("textarea");
    typingFrame.append(typingField);
    document.body.append(typingFrame);
    const prevMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) => ({ ...media, matches: query.includes("(max-width: 768px)") }) as unknown as MediaQueryList;

    const drawSnap = async (shown: SessionSnapshot, selected: PaneInfo): Promise<void> => {
      const tree = createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: TUI },
        createElement(TabStrip, {
          snapshot: shown,
          workspace: shown.workspaces[0]!,
          selectedPane: selected,
          onSelectPane: (paneId: string) => { picked.push(paneId); },
          onNewTab: () => {},
          onNewTerminal: async () => {},
        })));
      await page.render(tree);
    };
    const pressStripWhileTyping = () => act(async () => {
      typingField.focus();
      pointer(strip(), "pointerdown", { pointerType: "touch" });
    });

    try {
      // 1. Current pane pick while typing still calls onSelectPane (closing Terminal Peek / inbox) and focuses the field.
      await drawSnap(splitSnap([]), t1a);
      await pressStripWhileTyping();
      await mouse(tab(), "click", { detail: 1 });
      await pressMenu(`pane:${t1a.pane_id}`);
      expect(picked).toEqual([t1a.pane_id]);
      expect(focused).toEqual([t1a.pane_id]);

      // 2. Touch long-press (contextmenu) on an inactive split tab in the default under-header row keeps typing,
      //    and reads zoom from the picked pane's tab rather than the tab being left.
      picked.length = 0; focused.length = 0;
      const tab2 = () => page.one<HTMLButtonElement>('[data-tab-id="w1:t2"]');
      await drawSnap(splitSnap([
        { tab_id: "w1:t1", workspace_id: "w1", zoomed: true, focused_pane_id: t1a.pane_id, area: { x: 0, y: 0, width: 100, height: 100 }, panes: [], splits: [] },
        { tab_id: "w1:t2", workspace_id: "w1", zoomed: true, focused_pane_id: t2b.pane_id, area: { x: 0, y: 0, width: 100, height: 100 }, panes: [], splits: [] },
      ]), t1a);
      await pressStripWhileTyping();
      await contextMenu(tab2(), 120, 48, "touch");
      await pressMenu(`pane:${t2a.pane_id}`);
      expect(picked).toEqual([t2a.pane_id]);
      expect(focused).toEqual([t2b.pane_id]);

      // 3. Leaving a zoomed tab for an unzoomed inactive split tab focuses the picked pane, not the old zoomed pane.
      picked.length = 0; focused.length = 0;
      await drawSnap(splitSnap([
        { tab_id: "w1:t1", workspace_id: "w1", zoomed: true, focused_pane_id: t1a.pane_id, area: { x: 0, y: 0, width: 100, height: 100 }, panes: [], splits: [] },
      ]), t1a);
      await pressStripWhileTyping();
      await contextMenu(tab2(), 120, 48, "touch");
      await pressMenu(`pane:${t2a.pane_id}`);
      expect(picked).toEqual([t2a.pane_id]);
      expect(focused).toEqual([t2a.pane_id]);

      // 4. Keyboard contextmenu (0, 0, no touch pointerType) never reuses a stale pointer typing sample.
      picked.length = 0; focused.length = 0;
      await pressStripWhileTyping();
      await contextMenu(tab2(), 0, 0, "");
      await pressMenu(`pane:${t2a.pane_id}`);
      expect(picked).toEqual([t2a.pane_id]);
      expect(focused).toEqual([]);
    } finally {
      window.matchMedia = prevMatchMedia;
    }
  });
});
