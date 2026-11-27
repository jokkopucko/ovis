import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime, spyOn } from "bun:test";
import { act, useLayoutEffect, useState } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { currentAgentRowTokens, setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SidebarActivityProvider, useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { stateWatch } from "../lib/agentStateWatch.ts";
import { stateSince, type StateStamps } from "../lib/agentStateSince.ts";
import { useAgentStateStamping, useAgentStateStamps } from "../lib/useAgentStateSince.ts";
import type { SidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { setSidebarPins } from "../lib/sidebarPins.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const paneId = "w1C:p1";

function Stamping({ machines }: { machines: Machine[] }) {
  useAgentStateStamping(machines, useSidebarActivity());
  return null;
}

function roster(tokens: Record<string, string> = { quota: "95%" }): Machine[] {
  return structuredClone(fixture).map((machine) => ({
    ...machine,
    snapshot: machine.snapshot === null ? null : {
      ...machine.snapshot,
      panes: machine.snapshot.panes.map((pane) => ({ ...pane, tokens: pane.pane_id === paneId ? tokens : {} })),
    },
  }));
}

const all = (selector: string) => [...page.window.document.body.querySelectorAll(selector)];
const one = (selector: string) => {
  const [element, ...others] = all(selector);
  if (!element || others.length) throw new Error(`Expected one element matching ${selector}`);
  return element;
};
const rowOf = (id: string) => one(`[data-machine="local"][data-pane="${id}"]`);
const label = (element: { textContent: string | null }) => element.textContent ?? "";
const pointer = (element: ReturnType<typeof one>, type: "pointerover" | "pointerout") => element.dispatchEvent(new page.window.PointerEvent(type, { bubbles: true }));
const menuItems = () => all('.row-sheet button[data-item]');
const menuItem = (id: string) => one(`.row-sheet button[data-item="${id}"]`);
const openRowMenu = () => act(async () => { one(`[data-machine="local"][data-pane="${paneId}"] .row-menu-toggle`).click(); });
const expanded = (element: { getAttribute(name: string): string | null }): boolean => {
  const value = element.getAttribute("aria-expanded");
  if (value !== "true" && value !== "false") throw new Error("Expected aria-expanded");
  return value === "true";
};
let page: Page;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
function installPage() {
  page = openPage();
  for (const [key, value] of Object.entries({ HTMLElement: page.window.HTMLElement, Element: page.window.Element, Node: page.window.Node, Event: page.window.Event, CustomEvent: page.window.CustomEvent, ResizeObserver: page.window.ResizeObserver })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(page.window, { requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
}
async function closePage() {
  jest.useRealTimers();
  await page.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
}

describe("AgentSidebar phone sheet live row", () => {
  let historyState: unknown;
  let steppedBack: Promise<void>;
  let originalTokens: ReturnType<typeof currentAgentRowTokens>;

  beforeEach(() => {
    originalTokens = currentAgentRowTokens();
    setAgentRowTokens(null);
    installPage();
    historyState = null;
    let onBack = () => {};
    steppedBack = new Promise<void>((resolve) => { onBack = resolve; });
    const media = { matches: true, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: () => media });
    Object.defineProperty(page.window, "history", { configurable: true, value: {
      get state() { return historyState; },
      pushState(state: unknown) { historyState = state; },
      replaceState(state: unknown) { historyState = state; },
      back() { historyState = null; onBack(); },
    } });
  });

  afterEach(async () => {
    await closePage();
    if (historyState !== null) await steppedBack;
    setAgentRowTokens(originalTokens);
  });

  const view = (machines: Machine[]) => <SettingsProvider>
    <Stamping machines={machines} />
    <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
  </SettingsProvider>;

  it("says how long an agent has been in its state only where this page saw the state begin, never a reload's guess", async () => {
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    // already waiting when the page opened: herdr says nothing of when it began, so the row says no time
    await page.render(view(at("blocked")));
    expect(since()).toEqual([]);
    await page.render(view(at("working")));
    expect(since()).toEqual(["<1m"]);
    const otherChanged = at("working").map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1E:p1" ? { ...pane, agent_status: "working" as const } : pane),
    } }));
    await page.render(view(otherChanged));
    expect(since()).toEqual(["<1m"]);
  });

  it("makes no wait time from a PC's return: a wait it finds there began out of sight", async () => {
    const at = (status: AgentStatus, state: Machine["state"] = "connected") => roster().map((machine) => ({ ...machine, ...(machine.id === "local" ? { state } : {}), snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    await page.render(view(at("working")));
    await page.render(view(at("working", "disconnected")));
    await page.render(view(at("blocked")));
    expect(since()).toEqual([]);
  });

  async function open() {
    await page.render(view(roster()));
    const row = () => rowOf(paneId);
    await act(async () => { row().querySelector('[class="sidebar-row-action row-menu-toggle"]')!.click(); });
    expect(all('[role="dialog"]')).toHaveLength(1);
    expect(label(one('[class="row-menu-target-name"]'))).toBe("Idempotent payments");
    expect(label(one('[class="row-menu-target-place"]'))).toBe("checkout-api");
    expect(label(one('[class="row-sheet-detail"]'))).toBe("95%");
    return {
      row,
      update: async (machines: Machine[]) => { await page.render(view(machines)); },
    };
  }

  const lockSetting = (agentLocks: boolean, lockedAgents: string[] = []) => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentLocks, lockedAgents }));
  };

  it("offers no lock, and holds none, until Lock pinned agents is turned on (#2432)", async () => {
    lockSetting(false, [`local:${paneId}`]);
    setSidebarPins([`local:${paneId}`]);
    try {
      await open();
      expect(menuItems().map((item) => item.dataset.item)).toEqual(["unpin"]);
      expect(all('[data-testid="agent-locked"]')).toHaveLength(0);
    } finally {
      await act(async () => { setSidebarPins([]); });
    }
  });

  it("locks only a pinned row, which keeps its pin and shows a lock until it is unlocked (#2432)", async () => {
    lockSetting(true);
    setSidebarPins([]);
    try {
      await open();
      const ids = () => menuItems().map((item) => item.dataset.item);
      const run = async (id: string) => {
        await act(async () => { menuItem(id).click(); });
        await openRowMenu();
      };
      const lockIcons = () => all('[data-testid="agent-locked"]');
      expect(ids()).toEqual(["pin"]);
      await act(async () => { setSidebarPins([`local:${paneId}`]); });
      if (!menuItems().length) await openRowMenu();
      expect(ids()).toEqual(["unpin", "lock"]);
      await run("lock");
      expect(ids()).toEqual(["unlock"]);
      expect(lockIcons()).toHaveLength(1);
      await run("unlock");
      expect(ids()).toEqual(["unpin", "lock"]);
      expect(lockIcons()).toHaveLength(0);
    } finally {
      await act(async () => { setSidebarPins([]); });
    }
  });

  const groupSetting = (agentNamedGroups: boolean, agentGroupOf: Record<string, string> = {}, folded: string[] = []) => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups, agentGroupNames: ["Agents", "Tasks"], agentGroupOf }));
    page.window.localStorage.setItem("ovis:agent-group-folds", JSON.stringify(folded));
  };
  const groupHeadings = () => all('[class="agent-named-group-name"]').map(label);

  it("draws no named group and offers no move until Named agent groups is turned on (#2431)", async () => {
    groupSetting(false, { [`local:${paneId}`]: "Tasks" });
    await open();
    expect(groupHeadings()).toEqual([]);
    expect(menuItems().map((item) => item.dataset.item)).toEqual(["pin"]);
  });

  it("draws a row under its named group and moves it from the row's menu (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" });
    await open();
    const run = async (id: string) => {
      await act(async () => { menuItem(id).click(); });
      await openRowMenu();
    };
    expect(groupHeadings()).toContain("Tasks");
    expect(menuItems().map((item) => item.dataset.item)).toEqual(["pin", "group:Agents", "ungroup"]);
    await run("group:Agents");
    expect(groupHeadings()).toContain("Agents");
    expect(groupHeadings()).not.toContain("Tasks");
    expect(menuItems().map((item) => item.dataset.item)).toEqual(["pin", "group:Tasks", "ungroup"]);
    await run("ungroup");
    expect(groupHeadings()).toEqual([]);
  });

  it("folds a named group, keeping its count and its rows out of sight (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" });
    const { row } = await open();
    const toggle = one('[data-named-group="Tasks"] button');
    expect(expanded(toggle)).toBe(true);
    await act(async () => { toggle.click(); });
    expect(expanded(one('[data-named-group="Tasks"] button'))).toBe(false);
    expect(row().hidden).toBe(true);
  });

  it("offers no group move for a background agent, which stays under Background agents (#2431)", async () => {
    groupSetting(true);
    await page.render(view(roster({ role: "background" })));
    await act(async () => { rowOf(paneId).querySelector('[class="sidebar-row-action row-menu-toggle"]')!.click(); });
    expect(menuItems().map((item) => item.dataset.item)).toEqual(["pin"]);
  });

  it("opens a folded group a row is moved into, so the row stays in sight (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" }, ["Agents"]);
    const { row } = await open();
    await act(async () => { menuItem("group:Agents").click(); });
    expect(expanded(one('[data-named-group="Agents"] button'))).toBe(true);
    expect(row().hidden).toBe(false);
  });

  it("stops the agents a row called from its menu, counting those still taking its work, and marks a stopped one", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, held: [], failed: [] });
    }, { preconnect: globalThis.fetch.preconnect }));
    const called = roster().map((machine) => {
      const parent = machine.snapshot?.panes.find((pane) => pane.pane_id === paneId);
      if (!machine.snapshot || !parent) return machine;
      const child = (id: string, held: boolean) => ({ ...parent, pane_id: id, terminal_id: id, agent: "opencode", label: "OpenCode", tokens: {}, acp_child: true as const, parent_pane_id: paneId,
        ...(held ? { acp_hold: { child_id: "aaaaaaaaaaaa", generation: 2 } } : {}) });
      return { ...machine, snapshot: { ...machine.snapshot, panes: [...machine.snapshot.panes, child("w1C:c1", false), child("w1C:c2", true)] } };
    });
    try {
      await page.render(view(called));
      const held = (id: string) => rowOf(id).querySelectorAll('[class="agent-held"]').length;
      expect([held("w1C:c1"), held("w1C:c2")]).toEqual([0, 1]);
      await act(async () => { rowOf(paneId).querySelector('[class="sidebar-row-action row-menu-toggle"]')!.click(); });
      const stop = menuItem("stop-called");
      expect(stop.querySelector(".row-sheet-label")?.textContent).toBe("Stop agents it called (1)");
      await act(async () => { stop.click(); });
      expect(sent).toEqual([{ url: "/api/pane/turn/cancel-children", body: { pane_id: paneId } }]);
      expect(all('[role="alert"]')).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("offers no stop for a row that called no agent", async () => {
    await open();
    expect(menuItems().map((item) => item.dataset.item)).not.toContain("stop-called");
  });

  it("updates the open sheet when a plugin value changes", async () => {
    const { update } = await open();
    await update(roster({ quota: "40%" }));
    expect(label(one('[class="row-sheet-detail"]'))).toBe("40%");
  });

  it("says a blocked agent's whole reason in the open sheet, which has no tooltip", async () => {
    const { update } = await open();
    await update(roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "blocked" as const, agent_kind: "permission", agent_message: "Allow bash?" } : pane),
      },
    })));
    expect(label(one('[class="row-sheet-alert"]'))).toBe("Needs permission: Allow bash?");
    expect(label(one('[class="row-sheet-detail"]'))).toBe("95%");
  });

  it("removes the sheet detail when a token is deleted", async () => {
    const { update } = await open();
    await update(roster({}));
    expect(all('[role="dialog"]')).toHaveLength(1);
    expect(all('[class="row-sheet-detail"]')).toHaveLength(0);
  });

  it("removes the sheet detail when a new hide rule matches", async () => {
    await open();
    await act(async () => { setAgentRowTokens({ rows: [{ name: "quota", rules: [{ equals: "95%", hide: true }] }], by_agent: {} }); });
    expect(all('[role="dialog"]')).toHaveLength(1);
    expect(all('[class="row-sheet-detail"]')).toHaveLength(0);
  });

  for (const state of ["connecting", "reconnecting"] as const) {
    it(`keeps the sheet open when its PC briefly enters ${state} then recovers`, async () => {
      const { row, update } = await open();
      await update(roster().map((machine) => ({ ...machine, state })));
      expect(all('[role="dialog"]')).toHaveLength(1);
      expect(expanded(row().querySelector('[class="sidebar-row-action row-menu-toggle"]')!)).toBe(true);
      expect(row().querySelectorAll('[class="agent-tokens"]')).toHaveLength(0);
      expect(all('[class="row-sheet-detail"]')).toHaveLength(0);
      await update(roster({ quota: "40%" }));
      expect(all('[role="dialog"]')).toHaveLength(1);
      expect(label(one('[class="row-sheet-detail"]'))).toBe("40%");
    });
  }

  for (const state of ["disconnected", "error"] as const) {
    it(`closes the sheet when its PC enters ${state} with a cached roster`, async () => {
      const { row, update } = await open();
      await update(roster().map((machine) => ({ ...machine, state })));
      expect(row().querySelector('[class="agent-select agent-row"]')!.hasAttribute("disabled")).toBe(true);
      expect(all('[role="dialog"]')).toHaveLength(0);
      expect(expanded(row().querySelector('[class="sidebar-row-action row-menu-toggle"]')!)).toBe(false);
    });
  }

  it("keeps the sheet closed when a disconnected PC reconnects", async () => {
    const { update } = await open();
    await update(roster().map((machine) => ({ ...machine, state: "disconnected" })));
    await update(roster({ quota: "40%" }));
    expect(all('[role="dialog"]')).toHaveLength(0);
  });

  it("keeps the sheet closed when a removed row returns", async () => {
    const { update } = await open();
    await update([]);
    expect(all('[role="dialog"]')).toHaveLength(0);
    await update(roster());
    expect(all('[role="dialog"]')).toHaveLength(0);
  });
});

describe("AgentSidebar fold memory", () => {
  const FOLD_KEY = "ovis:agents-collapsed";
  let stored: { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
  let writes: string[];
  let phone: boolean;

  beforeEach(() => {
    installPage();
    const storage = page.window.localStorage;
    writes = [];
    phone = false;
    const setItem = storage.setItem.bind(storage);
    const removeItem = storage.removeItem.bind(storage);
    stored = { get: (key: string) => storage.getItem(key), set: setItem, delete: removeItem };
    Object.defineProperties(storage, {
      setItem: { configurable: true, value: (key: string, value: string) => { writes.push(key); setItem(key, value); } },
      removeItem: { configurable: true, value: (key: string) => { writes.push(key); removeItem(key); } },
    });
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }) });
  });

  afterEach(closePage);

  const inactive: SidebarFilter = { query: "", active: false, machines: new Map(), matches: 0 };
  const view = (filter: SidebarFilter) => <SettingsProvider>
    <SidebarFilterProvider value={{ filter, reportBranches: () => {} }}>
      <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
    </SidebarFilterProvider>
  </SettingsProvider>;

  async function mount(filter = inactive) {
    await page.render(view(filter));
    const toggle = () => one('[class="agent-section-toggle sidebar-section-label"]');
    return {
      expanded: (): boolean => expanded(toggle()),
      click: async () => { await act(async () => { toggle().click(); }); },
      remount: async (next = filter) => {
        await page.render(null);
        return mount(next);
      },
    };
  }

  it("keeps the defaults with nothing stored: open on a desktop, folded in the phone drawer", async () => {
    expect((await mount()).expanded()).toBe(true);
    await page.render(null);
    phone = true;
    expect((await mount()).expanded()).toBe(false);
    expect(writes).toEqual([]);
  });

  it("remembers the reader's fold across a reload", async () => {
    const sidebar = await mount();
    await sidebar.click();
    expect(sidebar.expanded()).toBe(false);
    const reloaded = await sidebar.remount();
    expect(reloaded.expanded()).toBe(false);
    await reloaded.click();
    expect((await reloaded.remount()).expanded()).toBe(true);
  });

  it("lets a stored choice win over the screen's default", async () => {
    phone = true;
    stored.set(FOLD_KEY, "0");
    expect((await mount()).expanded()).toBe(true);
    await page.render(null);
    phone = false;
    stored.set(FOLD_KEY, "1");
    expect((await mount()).expanded()).toBe(false);
  });

  it("opening an agent's helpers keeps another tab's choices and a loading PC's, and drops a gone pane's (#772)", async () => {
    stored.set("ovis:fold-helpers", "true");
    stored.set("ovis:agents-helpers-open", JSON.stringify(["pc2:w1:p1", "local:gone:p1"]));
    const parents: Record<string, string> = { "w1E:p1": "w1C:p1", "w1F:p1": "w1D:p1" };
    const machines = roster().map((machine) => machine.snapshot === null ? machine : { ...machine, snapshot: { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => parents[pane.pane_id] ? { ...pane, parent_pane_id: parents[pane.pane_id] } : pane) } });
    machines.push({ id: "pc2", name: "laptop", kind: "ssh", enabled: true, state: "connecting", error: null, snapshot: null } as Machine);
    await page.render(<SettingsProvider><SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider></SettingsProvider>);
    const line = (agent: string) => one(`li[data-helpers-of="local:${agent}"] button`);
    expect(expanded(line("w1C:p1"))).toBe(false);
    stored.set("ovis:agents-helpers-open", JSON.stringify(["pc2:w1:p1", "local:gone:p1", "local:w1D:p1"]));
    await act(async () => { line("w1C:p1").click(); });
    expect(JSON.parse(stored.get("ovis:agents-helpers-open")!)).toEqual(["pc2:w1:p1", "local:w1D:p1", "local:w1C:p1"]);
    expect(expanded(line("w1C:p1"))).toBe(true);
  });

  it("never writes the filter's temporary fold", async () => {
    const sidebar = await mount({ query: "nothing", active: true, machines: new Map(), matches: 0 });
    const before = sidebar.expanded();
    await sidebar.click();
    expect(sidebar.expanded()).toBe(!before);
    await sidebar.click();
    expect(writes).toEqual([]);
    expect((await sidebar.remount(inactive)).expanded()).toBe(true);
  });

  const groupedList = (filter: SidebarFilter, machines: Machine[] = roster(), watching = false) => <SettingsProvider>
    <Stamping machines={machines} />
    <SidebarFilterProvider value={{ filter, reportBranches: () => {} }}>
      <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} watching={watching} stateWord={(machine) => machine.state} onSelect={() => {}} />
    </SidebarFilterProvider>
  </SettingsProvider>;
  const heading = (group: string) => one(`li[class="agent-group-label"][data-group="${group}"] button`);
  const foldedRows = (): string[] => all('li[data-pane][hidden]').map((node) => node.dataset.pane ?? "");

  it("starts with Idle folded and the other groups open, and keeps what the reader then folds and opens (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    await page.render(groupedList(inactive));
    expect(expanded(heading("idle"))).toBe(false);
    expect(expanded(heading("working"))).toBe(true);
    expect(foldedRows()).toEqual(["w1E:p1", "w1F:p1"]);
    expect(label(one('li[data-group="idle"] [class="agent-group-count"]'))).toBe("2");
    await act(async () => { heading("idle").click(); });
    await act(async () => { heading("working").click(); });
    expect(foldedRows()).toEqual([paneId]);
    expect(label(one('li[data-group="working"] [class="agent-group-count"]'))).toBe("1");
    await page.render(null);
    await page.render(groupedList(inactive));
    expect(expanded(heading("idle"))).toBe(true);
    expect(foldedRows()).toEqual([paneId]);
  });

  it("keeps the fold another tab made when this one folds another group (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", "[]");
    await page.render(groupedList(inactive));
    stored.set("ovis:agent-state-folds", JSON.stringify(["working"]));
    await act(async () => { heading("idle").click(); });
    expect(JSON.parse(stored.get("ovis:agent-state-folds")!)).toEqual(["working", "idle"]);
    expect(expanded(heading("working"))).toBe(false);
    expect(expanded(heading("idle"))).toBe(false);
  });

  it("keeps the selected agent in sight under its folded group, as the list's other folds do (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    const selecting = (pane: string) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={pane} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(selecting("w1E:p1"));
    expect(foldedRows()).toEqual(["w1F:p1"]);
    expect(label(one('li[data-group="idle"] [class="agent-group-count"]'))).toBe("2");
    await page.render(selecting(paneId));
    expect(foldedRows()).toEqual(["w1E:p1", "w1F:p1"]);
  });

  it("says a waiting agent's whole reason in the menu's popover, where no sheet is drawn and a touch screen has no tooltip (#3505)", async () => {
    const blocked = roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "blocked" as const, agent_kind: "permission", agent_message: "Allow bash?" } : pane),
      },
    }));
    await page.render(<SettingsProvider>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={blocked} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SettingsProvider>);
    await act(async () => { rowOf(paneId).querySelector('[class="sidebar-row-action row-menu-toggle"]')!.click(); });
    expect(all('[role="dialog"]')).toHaveLength(0);
    const reason = one('[role="menu"] [class="row-menu-alert"]');
    expect(label(reason)).toBe("Needs permission: Allow bash?");
    // And the menu is described by it: a screen reader inside a menu reads its items, and nothing between them.
    expect(reason.getAttribute("id")).toEqual(expect.any(String));
    expect(one('[role="menu"]').getAttribute("aria-describedby")).toBe(reason.getAttribute("id"));
    await act(async () => { one('[data-machine="local"][data-pane="w1E:p1"]').querySelector('[class="sidebar-row-action row-menu-toggle"]')!.click(); });
    expect(all('[role="menu"] [class="row-menu-alert"]')).toHaveLength(0);
    expect(one('[role="menu"]').getAttribute("aria-describedby")).toBeNull();
  });

  it("opens every folded group while the filter is in use, and leaves the stored fold alone (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", JSON.stringify(["idle"]));
    const keepsIdle: SidebarFilter = { query: "backup", active: true, matches: 1, machines: new Map([["local", {
      shown: true, matched: false, workspaces: new Set(), matchedWorkspaces: new Set(), revealedWorkspaces: new Set(), panes: new Set(["w1E:p1"]), matchedPanes: new Set(["w1E:p1"]),
    }]]) };
    await page.render(groupedList(keepsIdle));
    expect(expanded(heading("idle"))).toBe(true);
    expect(heading("idle").hasAttribute("disabled")).toBe(true);
    expect(foldedRows()).toEqual([]);
    await page.render(groupedList(inactive));
    expect(foldedRows()).toEqual(["w1E:p1", "w1F:p1"]);
    expect(JSON.parse(stored.get("ovis:agent-state-folds")!)).toEqual(["idle"]);
  });

  it("lets a watching device fold its groups: the fold is the device's own, and nothing is sent for it (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", "[]");
    await page.render(groupedList(inactive, roster(), true));
    await act(async () => { heading("working").click(); });
    expect(foldedRows()).toEqual([paneId]);
    expect(JSON.parse(stored.get("ovis:agent-state-folds")!)).toEqual(["working"]);
  });

  it("counts an agent's time in its state from the change this device saw, through a read finish and a reload (#3505)", async () => {
    const start = 1_800_000_000_000;
    // the roster as the server sends it: herdr's counter moves with each state of its own, and the server counts the finish
    const at = (status: AgentStatus, seq: number, finishes: number) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, finish_epoch: "server-1",
      panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status, finish_id: finishes } : pane),
      agents: machine.snapshot.agents.map((agent) => agent.pane_id === paneId ? { ...agent, agent_status: status, state_change_seq: seq } : agent),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await page.render(groupedList(inactive, at("working", 50, 0)));
      await page.render(groupedList(inactive, at("done", 51, 1)));
      expect(since()).toEqual(["<1m"]);
      jest.setSystemTime(new Date(start + 5 * 60_000));
      await act(async () => { jest.advanceTimersByTime(30_000); });
      expect(since()).toEqual(["5m"]);
      await page.render(groupedList(inactive, at("idle", 51, 1)));
      await page.render(groupedList(inactive, at("idle", 52, 1)));
      expect(since()).toEqual(["5m"]);
      await page.render(null);
      await page.render(groupedList(inactive, at("idle", 52, 1)));
      expect(since()).toEqual(["5m"]);
      await page.render(null);
      await page.render(groupedList(inactive, at("idle", 52, 2)));
      expect(since()).toEqual([]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("says the times as of now when the folded list is opened, not as of when it was folded (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    const section = () => one('[class="agent-section-toggle sidebar-section-label"]');
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", "[]");
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await page.render(groupedList(inactive, at("working")));
      await page.render(groupedList(inactive, at("done")));
      expect(since()).toEqual(["<1m"]);
      await act(async () => { section().click(); });
      expect(expanded(section())).toBe(false);
      await act(async () => { jest.setSystemTime(new Date(start + 2 * 3_600_000)); });
      await act(async () => { section().click(); });
      expect(since()).toEqual(["2h"]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("looks at a roster in the commit that draws it, so no frame is painted with a time the look takes back (#3505)", async () => {
    const start = 1_800_000_000_000;
    const loaded = roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, finish_epoch: "server-1",
      panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "working" as const, finish_id: 0 } : pane),
      agents: machine.snapshot.agents.map((agent) => agent.pane_id === paneId ? { ...agent, agent_status: "working" as const, state_change_seq: 50 } : agent),
    } }));
    const terminal = loaded.flatMap((machine) => machine.snapshot?.panes ?? []).find((pane) => pane.pane_id === paneId)!.terminal_id;
    stored.set("ovis:agent-state-since", JSON.stringify({ version: 1, pcs: { local: { lifetime: null, epoch: "server-1", rows: { [paneId]: { state: "working", at: start - 10 * 3_600_000, terminal, seq: 40, finish: 0 } } } } }));
    const kept = (): unknown => JSON.parse(stored.get("ovis:agent-state-since") ?? "{}").pcs?.local?.rows?.[paneId];
    const beforePaint: unknown[] = [];
    function LaidOut({ machines }: { machines: Machine[] }) {
      useLayoutEffect(() => { if (machines.length > 0) beforePaint.push(kept()); });
      return null;
    }
    const view = (machines: Machine[]) => <SettingsProvider>
      <Stamping machines={machines} />
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
      <LaidOut machines={machines} />
    </SettingsProvider>;
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      // When the page loads, as the app does with no roster yet: nothing is looked at, so nothing the device keeps is
      // touched (a look at no PC would mark every stamp as its PC's having left the roster, for other tabs to read).
      const seeded = kept();
      await page.render(view([]));
      expect(kept()).toEqual(seeded);
      expect(writes.filter((key) => key === "ovis:agent-state-since")).toEqual([]);
      await page.render(view(loaded));
      expect(beforePaint).toEqual([undefined]);
      expect(since()).toEqual([]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("tells a list only the times of PCs the page has looked at: one first drawn with its roster reads none that is not judged (#3505)", async () => {
    const start = 1_800_000_000_000;
    const withLocal = (state: Machine["state"]) => roster().map((machine) => ({ ...machine, state: machine.id === "local" ? state : machine.state, snapshot: machine.snapshot && {
      ...machine.snapshot, finish_epoch: "server-1",
      panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "working" as const, finish_id: 0 } : pane),
      agents: machine.snapshot.agents.map((agent) => agent.pane_id === paneId ? { ...agent, agent_status: "working" as const, state_change_seq: 50 } : agent),
    } }));
    const terminal = withLocal("connected").flatMap((machine) => machine.snapshot?.panes ?? []).find((pane) => pane.pane_id === paneId)!.terminal_id;
    const unproven = JSON.stringify({ version: 1, pcs: { local: { lifetime: null, epoch: "server-1", rows: { [paneId]: { state: "working", at: start - 10 * 3_600_000, terminal, seq: 40, finish: 0 } } } } });
    const firstRead: Array<number | null> = [];
    function FirstDrawn() {
      const stamps: StateStamps = useAgentStateStamps();
      const [read] = useState(() => stateSince(stamps, "local", paneId, terminal, "working"));
      useLayoutEffect(() => { firstRead.push(read); }, [read]);
      return null;
    }
    const view = (machines: Machine[], list: boolean) => <SettingsProvider><Stamping machines={machines} />{list && <FirstDrawn />}</SettingsProvider>;
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      stored.set("ovis:agent-state-since", unproven);
      await page.render(view([], false));
      await page.render(view(withLocal("connected"), true));
      expect(firstRead).toEqual([null]);
      await page.render(null);

      firstRead.length = 0;
      stored.set("ovis:agent-state-since", unproven);
      await page.render(view(withLocal("connecting"), false));
      expect(JSON.parse(stored.get("ovis:agent-state-since")!)).toEqual(JSON.parse(unproven));
      await page.render(view(withLocal("connected"), true));
      expect(firstRead).toEqual([null]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("gives no time to a change that reached a page that was not running, and counts again once a roster has come (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await page.render(groupedList(inactive, at("working")));
      await act(async () => { stateWatch.read(stateWatch.asked()); });
      jest.setSystemTime(new Date(start + 60 * 60_000));
      await page.render(groupedList(inactive, at("blocked")));
      expect(since()).toEqual([]);
      await act(async () => { stateWatch.read(stateWatch.asked()); });
      expect(since()).toEqual([]);
      await page.render(groupedList(inactive, at("working")));
      expect(since()).toEqual(["<1m"]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("keeps a time through a silent stream's ten minutes, and drops it when that stream proves dead as the tab is shown again (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await page.render(groupedList(inactive, at("working")));
      await act(async () => { stateWatch.subscription("opened"); stateWatch.pushed(); });
      await page.render(groupedList(inactive, at("blocked")));
      expect(since()).toEqual(["<1m"]);
      await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
      await act(async () => { stateWatch.read(stateWatch.asked()); });
      expect(since()).toEqual(["10m"]);
      await act(async () => { jest.advanceTimersByTime(6_000); stateWatch.subscription("lost"); });
      expect(since()).toEqual([]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("keeps an agent's time when herdr moves its pane to another workspace, under a new ID (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus, id = paneId) => roster().map((machine) => {
      if (machine.snapshot === null) return machine;
      const snapshot = { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane) };
      // herdr names the moved pane anew wherever it names it (the panes, the agents, the layouts) and leaves it its terminal
      return { ...machine, snapshot: JSON.parse(JSON.stringify(snapshot).replaceAll(JSON.stringify(paneId), JSON.stringify(id))) as typeof snapshot };
    });
    const since = (id: string) => [...rowOf(id).querySelectorAll('[class="agent-since"]')].map(label);
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await page.render(groupedList(inactive, at("working")));
      await act(async () => { stateWatch.subscription("opened"); stateWatch.pushed(); });
      await page.render(groupedList(inactive, at("blocked")));
      await act(async () => { jest.advanceTimersByTime(120 * 60_000); });
      expect(since(paneId)).toEqual(["2h"]);
      await page.render(groupedList(inactive, at("blocked", "w9:p1")));
      expect(since("w9:p1")).toEqual(["2h"]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("reads no time from a stamping that has ended: the page's stamps leave with it, and the device keeps them", async () => {
    const finished = roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "done" as const } : pane),
    } }));
    const since = () => [...rowOf(paneId).querySelectorAll('[class="agent-since"]')].map(label);
    await page.render(groupedList(inactive));
    await page.render(groupedList(inactive, finished));
    expect(since()).toEqual(["<1m"]);
    await page.render(null);
    await page.render(<SettingsProvider><AgentSidebar machines={finished} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} /></SettingsProvider>);
    expect(since()).toEqual([]);
    expect(JSON.parse(stored.get("ovis:agent-state-since")!).pcs.local.rows[paneId].state).toBe("idle");
  });

  it("draws the composer's context ring on agent rows only while Context left on agent rows is on", async () => {
    const contexts: Record<string, { used: number; window: number | null }> = {
      [paneId]: { used: 120_000, window: 200_000 },
      "w1E:p1": { used: 170_000, window: 200_000 },
      "w1F:p1": { used: 30_000, window: null },
    };
    const filled = roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => contexts[pane.pane_id] ? { ...pane, context: contexts[pane.pane_id] } : pane) },
    }));
    const rings = async () => {
      await page.render(null);
      await page.render(<SettingsProvider><SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={filled} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider></SettingsProvider>);
      return all('span[data-testid="context-left"]')
        .map((node) => [node.getAttribute("aria-label"), node.className]);
    };
    expect(await rings()).toEqual([]);
    stored.set("ovis:sidebar-context", "true");
    expect(await rings()).toEqual([
      ["Context 40% left · 120k of 200k tokens", "context-count"],
      ["Context 15% left · 170k of 200k tokens", "context-count is-low"],
    ]);
  });

  it("draws the groups in one list, so a row whose state changes moves to its new group instead of being drawn anew", async () => {
    stored.set("ovis:agent-groups", "true");
    const blockedRoster = (blocked: boolean) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: blocked ? "blocked" as const : "working" as const } : pane) },
    }));
    const grouped = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(grouped(blockedRoster(false)));
    const list = () => one('[class="agent-list agent-list-grouped"]');
    const groupOf = (pane: string): string | undefined => {
      let group: string | undefined;
      for (const child of [...list().children]) {
        if (child.className === "agent-group-label") group = child.getAttribute("data-group") ?? "";
        if (child.getAttribute("data-pane") === pane) return group;
      }
      return undefined;
    };
    expect(groupOf(paneId)).toBe("working");
    await page.render(grouped(blockedRoster(true)));
    expect(groupOf(paneId)).toBe("blocked");
    expect(all('[class="agent-list"]')).toHaveLength(0);
  });

  it("keeps a row's own mark where its heading says another state than its own: BG under Working, a state nobody knows under Idle (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    const machines = roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) =>
        pane.pane_id === "w1D:p1" ? { ...pane, agent_status: "idle" as const, background_wait: true as const }
          : pane.pane_id === "w1E:p1" ? { ...pane, agent_status: "unknown" as const }
            : pane) },
    }));
    await page.render(groupedList(inactive, machines));
    const drawn: Record<string, { under: string | undefined; said: boolean; own: boolean }> = {};
    let under: string | undefined;
    for (const child of [...one('[class="agent-list agent-list-grouped"]').children]) {
      if (child.className === "agent-group-label") under = child.getAttribute("data-group") ?? "";
      else {
        const pane = child.getAttribute("data-pane");
        if (pane !== null) drawn[pane] = { under, said: child.getAttribute("data-state-said") === "", own: child.getAttribute("data-state-own") === "" };
      }
    }
    expect(drawn).toEqual({
      [paneId]: { under: "working", said: true, own: false },
      "w1D:p1": { under: "working", said: false, own: true },
      "w1F:p1": { under: "idle", said: true, own: false },
      "w1E:p1": { under: "idle", said: false, own: true },
    });
  });

  it("hands a row's focus to its group's heading when its new state files it under a folded group, and takes no focus the reader has put elsewhere (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    const inState = (status: AgentStatus) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane) },
    }));
    const grouped = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(grouped(inState("working")));
    const hidden = (): boolean => rowOf(paneId).hidden;
    const idleHeading = () => one('li[class="agent-group-label"][data-group="idle"] button');
    const focusHeading = spyOn(idleHeading(), "focus");
    const composer = page.window.document.createElement("textarea");
    page.window.document.body.append(composer);
    const control = () => rowOf(paneId).querySelector<HTMLButtonElement>(".agent-select")!;
    const becomes = (status: AgentStatus) => page.render(grouped(inState(status)));
    const rowTakesFocus = () => act(async () => { control().focus(); });
    expect(idleHeading().getAttribute("aria-expanded")).toBe("false");

    await rowTakesFocus();
    // A browser can return focus to the body when the focused row moves.
    const document = page.window.document;
    const focusReturnsToBody = async (update: () => Promise<void>) => {
      Object.defineProperty(document, "activeElement", { configurable: true, value: document.body });
      try { await update(); }
      finally { Reflect.deleteProperty(document, "activeElement"); }
    };
    await focusReturnsToBody(() => becomes("idle"));
    expect(hidden()).toBe(true);
    expect(focusHeading).toHaveBeenCalledTimes(1);

    await act(async () => { composer.focus(); });
    await becomes("working");
    await rowTakesFocus();
    await act(async () => { composer.focus(); });
    await becomes("idle");
    expect(hidden()).toBe(true);
    expect(focusHeading).toHaveBeenCalledTimes(1);

    await becomes("working");
    await rowTakesFocus();
    await focusReturnsToBody(async () => {
      await becomes("blocked");
      expect(hidden()).toBe(false);
      await becomes("idle");
    });
    expect(hidden()).toBe(true);
    expect(focusHeading).toHaveBeenCalledTimes(1);
  });

  it("keeps a background row's element when it becomes blocked and moves up, so its focus and open menu stay", async () => {
    stored.set("ovis:agents-background-collapsed", "0");
    const tagged = (blocked: boolean) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) =>
        pane.pane_id === paneId ? { ...pane, tokens: { role: "background" }, agent_status: blocked ? "blocked" as const : "working" as const }
        : pane.pane_id === "w1E:p1" ? { ...pane, tokens: { role: "background" } } : pane) },
    }));
    const view = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(view(tagged(false)));
    const row = () => one(`li[data-pane="${paneId}"]`);
    const order = () => all('li[data-pane], li[class="agent-background-label"]').map((node) => node.getAttribute("data-pane") ?? "BG");
    expect(order().indexOf(paneId)).toBeGreaterThan(order().indexOf("BG"));
    const before = row();
    await page.render(view(tagged(true)));
    expect(order().indexOf(paneId)).toBeLessThan(order().indexOf("BG"));
    expect(row()).toBe(before);
  });

  it("orders the groups the same whichever Agents order is chosen: ties keep herdr's order, not Activity's", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-group-sort", JSON.stringify("name"));
    const sameNames = roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1E:p1" || pane.pane_id === "w1F:p1" ? { ...pane, label: "Same" } : pane) },
    }));
    const seqs = new Map([["w1E:p1", 43], ["w1F:p1", 44]]);
    const activity = { seqs: () => seqs, status: (_machineId: string, pane: { agent_status?: AgentStatus }) => pane.agent_status };
    const order = async (agentOrder: string): Promise<string[]> => {
      stored.set("ovis:settings", JSON.stringify({ agentOrder }));
      await page.render(null);
      await page.render(<SettingsProvider><SidebarActivityProvider value={activity}>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={sameNames} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SidebarActivityProvider></SettingsProvider>);
      return all('[data-pane]').map((node) => node.dataset.pane ?? "");
    };
    expect(await order("activity")).toEqual(await order("workspace"));
  });

  it("a resting row turning blocked while the pointer or focus is in the list does not enter until it leaves", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    const withStatuses = (overrides: Record<string, AgentStatus>) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => overrides[pane.pane_id] ? { ...pane, agent_status: overrides[pane.pane_id] } : pane),
      },
    }));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(renderList(roster()));
    const section = () => { const section = one("section"); section.tabIndex = -1; return section; };
    const drawnEntries = () => all('li[data-pane]:not([hidden]), li[class="agent-background-label agent-resting-label"]:not([hidden])')
      .map((node) => node.getAttribute("data-pane") ?? "RESTING");
    const restingLabel = () => label(one('[class="agent-background-label agent-resting-label"] span'));
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+2 resting");

    await act(async () => { pointer(section(), "pointerover"); });
    await page.render(renderList(withStatuses({ "w1E:p1": "blocked" })));
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+1 resting");
    await act(async () => { pointer(section(), "pointerout"); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1C:p1", "RESTING"]);

    await act(async () => { section().focus(); });
    await page.render(renderList(withStatuses({ "w1E:p1": "blocked", "w1F:p1": "blocked" })));
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1C:p1", "RESTING"]);
    await act(async () => { section().blur(); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1F:p1", "w1C:p1"]);
  });

  it("an active row turning idle while the pointer or focus is in the list keeps its place above the resting line until both leave", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    const withStatuses = (overrides: Record<string, AgentStatus>) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => overrides[pane.pane_id] ? { ...pane, agent_status: overrides[pane.pane_id] } : pane),
      },
    }));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(renderList(roster()));
    const section = () => { const section = one("section"); section.tabIndex = -1; return section; };
    const drawnEntries = () => all('li[data-pane]:not([hidden]), li[class="agent-background-label agent-resting-label"]:not([hidden])')
      .map((node) => node.getAttribute("data-pane") ?? "RESTING");
    const restingLabel = () => label(one('[class="agent-background-label agent-resting-label"] span'));
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+2 resting");

    await act(async () => { pointer(section(), "pointerover"); section().focus(); });
    await page.render(renderList(withStatuses({ [paneId]: "idle", "w1D:p1": "idle" })));
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+4 resting");

    await act(async () => { pointer(section(), "pointerout"); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);

    await act(async () => { section().blur(); });
    expect(drawnEntries()).toEqual(["RESTING", "w1C:p1"]);
  });

  it("keeps a helper with the agent that started it across the resting line, whichever of the two is resting", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    // an ACP child that finished while the agent that asked it still works, then one still working under a resting agent
    const family = (parent: AgentStatus, helper: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1D:p1" ? { ...pane, agent_status: parent }
        : pane.pane_id === "w1E:p1" ? { ...pane, agent_status: helper, parent_pane_id: "w1D:p1", acp_child: true as const } : pane),
    } }));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(renderList(family("working", "done")));
    const drawnEntries = () => all('li[data-pane]:not([hidden]), li[class="agent-background-label agent-resting-label"]:not([hidden])')
      .map((node) => [node.getAttribute("data-pane") ?? "RESTING", Number(node.getAttribute("data-depth"))]);
    const restingLabel = () => label(one('[class="agent-background-label agent-resting-label"] span'));
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["w1E:p1", 1], ["RESTING", 0]]);
    expect(restingLabel()).toBe("+1 resting");

    await page.render(renderList(family("idle", "working")));
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["w1E:p1", 1], ["RESTING", 0]]);
    expect(restingLabel()).toBe("+1 resting");
  });

  it("while the pointer is in the list, an agent kept above the resting line by its busy helper stays when the helper leaves, and a new helper stands with its agent", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    type Panes = NonNullable<Machine["snapshot"]>["panes"];
    const scene = (edit: (panes: Panes) => Panes) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: edit(machine.snapshot.panes) } }));
    const helped = (helper: boolean) => scene((panes: Panes) => panes.flatMap((pane) => pane.pane_id === "w1D:p1" ? [{ ...pane, agent_status: "idle" as const }]
      : pane.pane_id === "w1E:p1" ? helper ? [{ ...pane, agent_status: "working" as const, parent_pane_id: "w1D:p1" }] : [] : [pane]));
    const working = (newHelper: boolean) => scene((panes: Panes) => panes.flatMap((pane) => pane.pane_id !== "w1D:p1" ? [pane]
      : [{ ...pane, agent_status: "working" as const }, ...newHelper ? [{ ...pane, pane_id: "w1D:p9", terminal_id: "w1D:p9", agent_status: "done" as const, parent_pane_id: "w1D:p1", acp_child: true as const }] : []]));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(renderList(helped(true)));
    const section = () => { const section = one("section"); section.tabIndex = -1; return section; };
    const drawnEntries = () => all('li[data-pane]:not([hidden]), li[class="agent-background-label agent-resting-label"]:not([hidden])')
      .map((node) => [node.getAttribute("data-pane") ?? "RESTING", Number(node.getAttribute("data-depth"))]);
    const restingLabel = () => label(one('[class="agent-background-label agent-resting-label"] span'));
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["w1E:p1", 1], ["RESTING", 0]]);

    await act(async () => { pointer(section(), "pointerover"); });
    await page.render(renderList(helped(false)));
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["RESTING", 0]]);
    await act(async () => { pointer(section(), "pointerout"); });
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["RESTING", 0]]);

    await page.render(renderList(working(false)));
    const before = restingLabel();
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["RESTING", 0]]);
    await act(async () => { pointer(section(), "pointerover"); });
    await page.render(renderList(working(true)));
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["w1D:p9", 1], ["RESTING", 0]]);
    expect(restingLabel()).toBe(before);
  });

  it("draws the tree lines of the order it shows while the pointer is in the list, a helper that came meanwhile included", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "workspace" }));
    type Panes = NonNullable<Machine["snapshot"]>["panes"];
    const helpers = (ids: string[]) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: machine.snapshot.panes.flatMap((pane): Panes => pane.pane_id !== "w1D:p1" ? [pane]
      : [pane, ...ids.map((id) => ({ ...pane, pane_id: id, terminal_id: id, agent_status: "working" as const, parent_pane_id: "w1D:p1" }))]) } }));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(renderList(helpers(["w1D:p7", "w1D:p8"])));
    const family = () => all('li[data-pane^="w1D:"]')
      .map((node) => [node.getAttribute("data-pane"), node.getAttribute("data-more") === ""]);
    expect(family()).toEqual([["w1D:p1", false], ["w1D:p7", true], ["w1D:p8", false]]);
    await act(async () => { pointer(one("section"), "pointerover"); });
    await page.render(renderList(helpers(["w1D:p7", "w1D:p8", "w1D:p9"])));
    expect(family()).toEqual([["w1D:p1", false], ["w1D:p9", true], ["w1D:p7", true], ["w1D:p8", false]]);
  });

  it("keeps rows still for one second after a touch ends, then applies the new order without changing selection", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    jest.useFakeTimers();
    try {
      const renderList = (blocked: boolean) => <SettingsProvider>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
            ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1E:p1" && blocked ? { ...pane, agent_status: "blocked" } : pane),
          } }))} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SettingsProvider>;
      await page.render(renderList(false));
      const section = () => one("section");
      const order = () => all('li[data-pane]:not([hidden])').map((node) => node.dataset.pane ?? "");
      await act(async () => { pointer(section(), "pointerover"); });
      await act(async () => { section().dispatchEvent(new page.window.Event("touchend", { bubbles: true })); pointer(section(), "pointerout"); });
      await page.render(renderList(true)); jest.advanceTimersByTime(999);
      expect(order()).toEqual(["w1D:p1", paneId]);
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(order()).toEqual(["w1D:p1", "w1E:p1", paneId]);
      expect(all('li[class*="is-selected"]').map((node) => node.getAttribute("data-pane"))).toEqual([paneId]);
    } finally {
      await page.render(null);
      jest.useRealTimers();
    }
  });

  it("clearing the filter while the pointer is in the list shows the rows in their normal order", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    const keepsWorking: SidebarFilter = { query: "pay", active: true, matches: 1, machines: new Map([["local", {
      shown: true, matched: false, workspaces: new Set(), matchedWorkspaces: new Set(), revealedWorkspaces: new Set(), panes: new Set([paneId]), matchedPanes: new Set([paneId]),
    }]]) };
    const renderList = (filter: SidebarFilter) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter, reportBranches: () => {} }}>
        <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await page.render(renderList(keepsWorking));
    const drawnEntries = () => all('li[data-pane]:not([hidden]), li[class="agent-background-label agent-resting-label"]:not([hidden])')
      .map((node) => node.getAttribute("data-pane") ?? "RESTING");
    expect(drawnEntries()).toEqual([paneId]);
    await act(async () => { pointer(one("section"), "pointerover"); });
    await page.render(renderList(inactive));
    expect(drawnEntries()).toEqual(["w1D:p1", paneId, "RESTING"]);
  });
});
