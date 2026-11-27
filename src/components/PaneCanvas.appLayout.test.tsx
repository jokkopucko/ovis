import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { setSidebarPins } from "../lib/sidebarPins.ts";
import { usageCounters } from "../lib/usageCounters.ts";
import type { RowMenuItem } from "./RowMenu.tsx";

import { PaneCanvas } from "./PaneCanvas.tsx";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });

const pane = (id: string, label?: string): HerdrPane =>
  ({ pane_id: id, workspace_id: "w1", tab_id: "t1", terminal_id: `${id}:term`, revision: 1, focused: id === "p1", agent_status: "idle", label }) as HerdrPane;
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
  let page: Page;
  let phone = false;

  beforeEach(() => {
    page = openPage();
    phone = false;
    const media = { get matches() { return phone; }, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: () => media });
    Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: () => 1 });
    Object.defineProperty(page.window, "cancelAnimationFrame", { configurable: true, value: () => {} });
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    for (const [key, value] of Object.entries({ localStorage: page.window.localStorage, HTMLElement: page.window.HTMLElement })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });

  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  let actions: (target: HerdrPane) => RowMenuItem[] = () => [];
  let actionsRef: { current: ((target: HerdrPane, options?: { counted?: boolean }) => RowMenuItem[]) | null } = { current: null };
  async function draw(offer: LayoutOffer, drawn: SessionSnapshot = snapshot, watching = false, renderPane: Parameters<typeof PaneCanvas>[0]["renderPane"] = () => null): Promise<(target: HerdrPane) => string[]> {
    actionsRef = { current: null };
    actions = (target) => actionsRef.current!(target);
    await page.render(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(PaneCanvas, { snapshot: drawn, pane: drawn.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane, actionsRef,
          onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {}, watching }))));
    return (target) => actionsRef.current!(target).map((item) => item.id);
  }
  const dividers = () => page.container.querySelectorAll('[role="separator"]').length;

  it("offers a TUI PC's panes their name, swap, split and zoom items, and a divider to drag", async () => {
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "split-right", "split-down", "zoom", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["rename", "swap-focused", "split-right", "split-down", "zoom", "close"]);
    expect(dividers()).toBe(1);
  });

  it("offers no split on a core whose layout Ovis keeps for a pane in a tab of its own terminal (#2806)", async () => {
    const own: SessionSnapshot = { ...snapshot, panes: [{ ...pane("p1", "named"), own_tab: true }, pane("p2")] };
    const itemsOf = await draw(OVIS_CORE, own);
    expect(itemsOf(own.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "zoom", "close"]);
    expect(itemsOf(own.panes[1] as HerdrPane)).toEqual(["rename", "swap-focused", "split-right", "split-down", "zoom", "close"]);
  });

  it("gives a lone tab with no row (a cramped phone) the row's menu, for the header's More menu, and no pane ellipsis", async () => {
    phone = true;
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["pane:p1", "pane:p2", "rename", "clear-name", "close", "new-terminal", "new-agent-tab", "rename-tab", "close-tab"]);
    const heads = [...page.container.querySelectorAll('[class="pane-frame-head"]')];
    expect(heads.map((head) => head.parentElement?.getAttribute("data-layout-pane"))).toEqual(["p2"]);
  });

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

  it("gives a lone tab with no row on a core whose layout Ovis keeps the same menu as herdr's TUI", async () => {
    phone = true;
    const itemsOf = await draw(OVIS_CORE, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["rename", "close", "new-terminal", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
  });

  it("leaves no actions behind for the header's menu once the canvas is gone", async () => {
    const actionsRef: { current: ((target: HerdrPane) => RowMenuItem[]) | null } = { current: null };
    await page.render(createElement(SettingsProvider, null, createElement(PaneCanvas, { snapshot, pane: snapshot.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef })));
    expect(actionsRef.current).not.toBeNull();
    await page.render(null);
    expect(actionsRef.current).toBeNull();
  });

  it("keeps the row's own menu where a lone tab's row is drawn", async () => {
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).not.toContain("new-terminal");
    expect([...page.container.querySelectorAll('[class="pane-frame-head"]')]).toHaveLength(2);
  });

  const click = (button: HTMLButtonElement, detail: number) => act(async () => {
    button.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail }) as unknown as MouseEvent);
  });
  const zoomButtons = () => [...page.container.querySelectorAll<HTMLButtonElement>('button[class="icon-button pane-frame-zoom"]')];
  const frameOf = (id: string) => page.one(`section[data-layout-pane="${id}"]`);
  const zoomed: SessionSnapshot = { ...snapshot, layouts: [{ ...snapshot.layouts[0]!, zoomed: true }] };

  it("draws a Zoom pane button on each split pane's title, which zooms that pane (#2037)", async () => {
    await draw(TUI);
    expect(zoomButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["Zoom pane", "Zoom pane"]);
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Response.json({ zoomed: true });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await click(zoomButtons()[1]!, 0);
    } finally {
      fetch.mockRestore();
    }
    expect(bodies).toEqual([{ pane_id: "p2", mode: "on" }]);
  });

  it("moves the typing into the pane whose zoom a mouse clicked, never leaving it in another pane (#2037)", async () => {
    const focused: string[] = [];
    await draw(TUI, snapshot, false, (target) => target === null ? null : createElement("textarea", {
      className: "xterm-helper-textarea", onFocus: () => focused.push(`${target.pane_id} terminal`),
    }));
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ zoomed: true }), { preconnect: globalThis.fetch.preconnect }));
    try {
      await click(zoomButtons()[1]!, 1);
      await act(async () => { page.one('[data-layout-pane="p2"] textarea').blur(); });
      await click(zoomButtons()[1]!, 0);
    } finally {
      fetch.mockRestore();
    }
    expect(focused).toEqual(["p2 terminal"]);
  });

  it("keeps a zoomed pane's title row, with Unzoom pane, so the hidden panes are one click away (#2037)", async () => {
    await draw(TUI, zoomed);
    expect(frameOf("p1").className).not.toContain("is-single");
    expect(zoomButtons().filter((button) => button.getAttribute("aria-label") === "Unzoom pane")).toHaveLength(1);
  });

  it("draws no zoom button where panes are shown one at a time, or the Herdr app lays them out", async () => {
    phone = true;
    await draw(TUI);
    expect(zoomButtons()).toHaveLength(0);
    expect(closeButtons()).toHaveLength(0);
    phone = false;
    await page.render(null);
    await draw(APP_CORE);
    expect(zoomButtons()).toHaveLength(0);
    expect(closeButtons()).toHaveLength(0);
  });

  const closeButtons = () => [...page.container.querySelectorAll<HTMLButtonElement>('button[class="icon-button pane-frame-close"]')];
  const headButtons = (id: string) => [...frameOf(id).querySelectorAll("button")].map((button) => button.className);
  let pressedFocus = 0;
  async function pressClose(drawn: SessionSnapshot, id: string, detail = 1): Promise<unknown[]> {
    await draw(TUI, drawn);
    pressedFocus = 0;
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/pane/close") && typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Response.json({});
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      const button = closeButtons()[drawn.panes.findIndex((item) => item.pane_id === id)]!;
      const focus = spyOn(button, "focus");
      try { await click(button, detail); } finally {
        pressedFocus = focus.mock.calls.length;
        focus.mockRestore();
      }
    } finally {
      fetch.mockRestore();
    }
    return bodies;
  }
  const asking = () => document.querySelectorAll('[class="modal confirm-dialog"]');

  it("ends each split pane's title with Close pane, Zoom pane just left of it, zoomed or not", async () => {
    await draw(TUI);
    for (const id of ["p1", "p2"]) expect(headButtons(id)).toEqual(["icon-button pane-frame-menu", "icon-button pane-frame-zoom", "icon-button pane-frame-close"]);
    expect(closeButtons().map((button) => [button.getAttribute("aria-label"), button.title])).toEqual([["Close pane", "Close pane"], ["Close pane", "Close pane"]]);
    await page.render(null);
    await draw(TUI, zoomed);
    expect(headButtons("p1")).toEqual(["icon-button pane-frame-menu", "icon-button pane-frame-zoom", "icon-button pane-frame-close"]);
  });

  it("closes an idle pane from its title's Close at once, as the menu's Close does", async () => {
    expect(await pressClose(snapshot, "p2")).toEqual([{ pane_id: "p2" }]);
    expect(asking()).toHaveLength(0);
  });

  it("asks before the title's Close stops a working or blocked agent, as the menu's Close does", async () => {
    for (const agent_status of ["working", "blocked"] as const) {
      const busy: SessionSnapshot = { ...snapshot, panes: [snapshot.panes[0]!, { ...snapshot.panes[1]!, agent_status }] };
      expect(await pressClose(busy, "p2")).toEqual([]);
      expect(asking()).toHaveLength(1);
      // the pressed Close holds the focus before the confirmation opens, so Cancel hands it back there (Safari focuses no clicked button)
      expect(pressedFocus).toBe(1);
      await page.render(null);
    }
  });

  it("closes nothing on a double click's second press, which may land on the neighbour that took the corner", async () => {
    expect(await pressClose(snapshot, "p2", 2)).toEqual([]);
    expect(asking()).toHaveLength(0);
  });

  it("closes no second pane of a workspace until the roster has dropped the first, then asks for its last one (#3286)", async () => {
    await draw(TUI);
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/pane/close") && typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Response.json({});
    }, { preconnect: globalThis.fetch.preconnect }));
    const closeOf = (id: string) => actions(snapshot.panes.find((item) => item.pane_id === id)!).find((item) => item.id === "close")!;
    try {
      await act(async () => { closeOf("p2").run(); });
      await act(async () => { closeOf("p1").run(); });
      await act(async () => { closeOf("p2").run(); });
      expect(bodies).toEqual([{ pane_id: "p2" }]);
      expect(asking()).toHaveLength(0);
      const after: SessionSnapshot = { ...snapshot, panes: [snapshot.panes[0]!] };
      await page.render(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: TUI },
        createElement(PaneCanvas, { snapshot: after, pane: after.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef }))));
      await act(async () => { actions(after.panes[0]!).find((item) => item.id === "close")!.run(); });
      expect(bodies).toEqual([{ pane_id: "p2" }]);
      expect(asking()).toHaveLength(1);
    } finally {
      fetch.mockRestore();
    }
  });

  it("shows a watching device the title's Close, which it cannot use", async () => {
    await draw(TUI, snapshot, true);
    expect(closeButtons().map((button) => button.disabled)).toEqual([true, true]);
  });

  it("offers no Close for a locked pinned agent, nor Close tab for the tab it is in (#2432)", async () => {
    phone = true;
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1"] }));
    setSidebarPins(["local:p1"]);
    try {
      const itemsOf = await draw(TUI);
      expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["pane:p1", "pane:p2", "rename", "clear-name", "unlock", "new-terminal", "new-agent-tab", "rename-tab"]);
      expect(itemsOf(snapshot.panes[1] as HerdrPane)).toContain("close");
      expect(itemsOf(snapshot.panes[1] as HerdrPane)).not.toContain("close-tab");
      phone = false;
      await page.render(null);
      await draw(TUI);
      expect(headButtons("p1")).toEqual(["icon-button pane-frame-menu", "icon-button pane-frame-zoom"]);
      expect(headButtons("p2")).toContain("icon-button pane-frame-close");
    } finally {
      setSidebarPins([]);
    }
  });

  it("unlocks a locked pane from its own menu, which stays when its agent left the Agents list (#2977)", async () => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1", "local:p9"] }));
    setSidebarPins(["local:p1", "local:p9"]);
    try {
      const itemsOf = await draw(TUI);
      const unlock = actions(snapshot.panes[0] as HerdrPane).find((item) => item.id === "unlock");
      expect(unlock?.disabled).toBeFalsy();
      await act(async () => unlock!.run());
      expect(itemsOf(snapshot.panes[0] as HerdrPane)).toContain("close");
      expect(JSON.parse(page.window.localStorage.getItem("ovis:settings") ?? "{}").lockedAgents).toEqual(["local:p9"]);
    } finally {
      setSidebarPins([]);
    }
  });

  it("shows a watching device the pane's Unlock, which it cannot use", async () => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1"] }));
    setSidebarPins(["local:p1"]);
    try {
      await draw(TUI, snapshot, true);
      expect(actions(snapshot.panes[0] as HerdrPane).find((item) => item.id === "unlock")?.disabled).toBe(true);
    } finally {
      setSidebarPins([]);
    }
  });

  it("leaves a core PC's panes to the Herdr app: Close pane stays, no divider is drawn", async () => {
    const itemsOf = await draw(APP_CORE);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["close"]);
    expect(dividers()).toBe(0);
  });

  it("counts its Close pane as the menu's only when the menu was pressed, and closes even when the count fails", async () => {
    await draw(OVIS_CORE);
    const told: string[] = [];
    const counting = spyOn(usageCounters, "paneUse").mockImplementation((name) => { told.push(name); });
    const close = (options?: { counted?: boolean }) => actionsRef.current!(snapshot.panes[1] as HerdrPane, options).find((item) => item.id === "close")!;
    try {
      await act(async () => { close({ counted: false }).run(); });
      expect(told).toEqual([]);
      counting.mockImplementation(() => { throw new Error("storage full"); });
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try { await act(async () => { expect(() => close().run()).not.toThrow(); }); } finally { logged.mockRestore(); }
      counting.mockImplementation((name) => { told.push(name); });
      await act(async () => { close().run(); });
      expect(told).toEqual(["close_pane_by_menu"]);
    } finally { counting.mockRestore(); }
  });
});
