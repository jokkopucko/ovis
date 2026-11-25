import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime, spyOn } from "bun:test";
import { act, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

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
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

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

describe("AgentSidebar phone sheet live row", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let historyState: unknown;
  let steppedBack: Promise<void>;
  let originalTokens: ReturnType<typeof currentAgentRowTokens>;
  const anchor = { isConnected: true, focus() {}, querySelector: () => null, closest: () => null };

  beforeEach(() => {
    originalTokens = currentAgentRowTokens();
    setAgentRowTokens(null);
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    historyState = null;
    let onBack = () => {};
    steppedBack = new Promise<void>((resolve) => { onBack = resolve; });
    const events = new EventTarget();
    const media = { matches: true, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => media,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      location: { href: "http://localhost/" },
      history: {
        get state() { return historyState; },
        pushState(state: unknown) { historyState = state; },
        replaceState(state: unknown) { historyState = state; },
        back() { historyState = null; onBack(); },
      },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      // Portals use the test renderer's host container, not a DOM renderer.
      body: { nodeType: 1, children: [], createNodeMock: () => null },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (historyState !== null) await steppedBack;
    setAgentRowTokens(originalTokens);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const view = (machines: Machine[]) => <SettingsProvider>
    <Stamping machines={machines} />
    <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
  </SettingsProvider>;

  it("says how long an agent has been in its state only where this page saw the state begin, never a reload's guess", async () => {
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    // already waiting when the page opened: herdr says nothing of when it began, so the row says no time
    await act(async () => { renderer = create(view(at("blocked"))); });
    expect(since()).toEqual([]);
    await act(async () => { renderer!.update(view(at("working"))); });
    expect(since()).toEqual(["<1m"]);
    const otherChanged = at("working").map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1E:p1" ? { ...pane, agent_status: "working" as const } : pane),
    } }));
    await act(async () => { renderer!.update(view(otherChanged)); });
    expect(since()).toEqual(["<1m"]);
  });

  it("makes no wait time from a PC's return: a wait it finds there began out of sight", async () => {
    const at = (status: AgentStatus, state: Machine["state"] = "connected") => roster().map((machine) => ({ ...machine, ...(machine.id === "local" ? { state } : {}), snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    await act(async () => { renderer = create(view(at("working"))); });
    await act(async () => { renderer!.update(view(at("working", "disconnected"))); });
    await act(async () => { renderer!.update(view(at("blocked"))); });
    expect(since()).toEqual([]);
  });

  async function open() {
    await act(async () => {
      renderer = create(view(roster()), { createNodeMock: () => anchor });
    });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const row = () => mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId });
    await act(async () => { row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findByProps({ className: "row-menu-target-name" }).children).toEqual(["Idempotent payments"]);
    expect(mounted.root.findByProps({ className: "row-menu-target-place" }).children).toEqual(["checkout-api"]);
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["95%"]);
    return {
      mounted,
      row,
      update: async (machines: Machine[]) => { await act(async () => { mounted.update(view(machines)); }); },
    };
  }

  const lockSetting = (agentLocks: boolean, lockedAgents: string[] = []) => {
    (globalThis.window as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
      getItem: (key) => key === "ovis:settings" ? JSON.stringify({ agentLocks, lockedAgents }) : null, setItem() {}, removeItem() {},
    };
  };

  it("offers no lock, and holds none, until Lock pinned agents is turned on (#2432)", async () => {
    lockSetting(false, [`local:${paneId}`]);
    setSidebarPins([`local:${paneId}`]);
    try {
      const { mounted } = await open();
      expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).toEqual(["unpin"]);
      expect(mounted.root.findAllByProps({ "data-testid": "agent-locked" })).toHaveLength(0);
    } finally {
      setSidebarPins([]);
    }
  });

  it("locks only a pinned row, which keeps its pin and shows a lock until it is unlocked (#2432)", async () => {
    lockSetting(true);
    setSidebarPins([]);
    try {
      const { mounted } = await open();
      const items = () => mounted.root.findByType(RowMenu).props.items as RowMenuItem[];
      const ids = () => items().map((item) => item.id);
      const run = async (id: string) => { await act(async () => { items().find((item) => item.id === id)!.run(); }); };
      const lockIcons = () => mounted.root.findAllByProps({ "data-testid": "agent-locked" });
      expect(ids()).toEqual(["pin"]);
      await act(async () => { setSidebarPins([`local:${paneId}`]); });
      expect(ids()).toEqual(["unpin", "lock"]);
      await run("lock");
      expect(ids()).toEqual(["unlock"]);
      expect(lockIcons()).toHaveLength(1);
      await run("unlock");
      expect(ids()).toEqual(["unpin", "lock"]);
      expect(lockIcons()).toHaveLength(0);
    } finally {
      setSidebarPins([]);
    }
  });

  const groupSetting = (agentNamedGroups: boolean, agentGroupOf: Record<string, string> = {}, folded: string[] = []) => {
    (globalThis.window as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
      getItem: (key) => key === "ovis:settings" ? JSON.stringify({ agentNamedGroups, agentGroupNames: ["Agents", "Tasks"], agentGroupOf })
        : key === "ovis:agent-group-folds" ? JSON.stringify(folded) : null,
      setItem() {}, removeItem() {},
    };
  };
  const groupHeadings = (mounted: ReactTestRenderer) => mounted.root.findAllByProps({ className: "agent-named-group-name" }).map((node) => node.children.join(""));

  it("draws no named group and offers no move until Named agent groups is turned on (#2431)", async () => {
    groupSetting(false, { [`local:${paneId}`]: "Tasks" });
    const { mounted } = await open();
    expect(groupHeadings(mounted)).toEqual([]);
    expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).toEqual(["pin"]);
  });

  it("draws a row under its named group and moves it from the row's menu (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" });
    const { mounted } = await open();
    const items = () => mounted.root.findByType(RowMenu).props.items as RowMenuItem[];
    const run = async (id: string) => { await act(async () => { items().find((item) => item.id === id)!.run(); }); };
    expect(groupHeadings(mounted)).toContain("Tasks");
    expect(items().map((item) => item.id)).toEqual(["pin", "group:Agents", "ungroup"]);
    await run("group:Agents");
    expect(groupHeadings(mounted)).toContain("Agents");
    expect(groupHeadings(mounted)).not.toContain("Tasks");
    expect(items().map((item) => item.id)).toEqual(["pin", "group:Tasks", "ungroup"]);
    await run("ungroup");
    expect(groupHeadings(mounted)).toEqual([]);
  });

  it("folds a named group, keeping its count and its rows out of sight (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" });
    const { mounted, row } = await open();
    const toggle = mounted.root.findByProps({ "data-named-group": "Tasks" }).findByType("button");
    expect(toggle.props["aria-expanded"]).toBe(true);
    await act(async () => { toggle.props.onClick(); });
    expect(mounted.root.findByProps({ "data-named-group": "Tasks" }).findByType("button").props["aria-expanded"]).toBe(false);
    expect(row().props.hidden).toBe(true);
  });

  it("offers no group move for a background agent, which stays under Background agents (#2431)", async () => {
    groupSetting(true);
    await act(async () => { renderer = create(view(roster({ role: "background" })), { createNodeMock: () => anchor }); });
    const mounted = renderer!;
    await act(async () => { mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
    expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).toEqual(["pin"]);
  });

  it("opens a folded group a row is moved into, so the row stays in sight (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" }, ["Agents"]);
    const { mounted, row } = await open();
    await act(async () => { (mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).find((item) => item.id === "group:Agents")!.run(); });
    expect(mounted.root.findByProps({ "data-named-group": "Agents" }).findByType("button").props["aria-expanded"]).toBe(true);
    expect(row().props.hidden).toBeUndefined();
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
      await act(async () => { renderer = create(view(called), { createNodeMock: () => anchor }); });
      const mounted = renderer!;
      const held = (id: string) => mounted.root.findByProps({ "data-machine": "local", "data-pane": id }).findAllByProps({ className: "agent-held" }).length;
      expect([held("w1C:c1"), held("w1C:c2")]).toEqual([0, 1]);
      await act(async () => { mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
      const stop = (mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).find((item) => item.id === "stop-called");
      expect(stop?.label).toBe("Stop agents it called (1)");
      await act(async () => { stop!.run(); });
      expect(sent).toEqual([{ url: "/api/pane/turn/cancel-children", body: { pane_id: paneId } }]);
      expect(mounted.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("offers no stop for a row that called no agent", async () => {
    const { mounted } = await open();
    expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).not.toContain("stop-called");
  });

  it("updates the open sheet when a plugin value changes", async () => {
    const { mounted, update } = await open();
    await update(roster({ quota: "40%" }));
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
  });

  it("says a blocked agent's whole reason in the open sheet, which has no tooltip", async () => {
    const { mounted, update } = await open();
    await update(roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "blocked" as const, agent_kind: "permission", agent_message: "Allow bash?" } : pane),
      },
    })));
    expect(mounted.root.findByProps({ className: "row-sheet-alert" }).children).toEqual(["Needs permission: Allow bash?"]);
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["95%"]);
  });

  it("removes the sheet detail when a token is deleted", async () => {
    const { mounted, update } = await open();
    await update(roster({}));
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
  });

  it("removes the sheet detail when a new hide rule matches", async () => {
    const { mounted } = await open();
    await act(async () => { setAgentRowTokens({ rows: [{ name: "quota", rules: [{ equals: "95%", hide: true }] }], by_agent: {} }); });
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
  });

  for (const state of ["connecting", "reconnecting"] as const) {
    it(`keeps the sheet open when its PC briefly enters ${state} then recovers`, async () => {
      const { mounted, row, update } = await open();
      await update(roster().map((machine) => ({ ...machine, state })));
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
      expect(row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props["aria-expanded"]).toBe(true);
      expect(row().findAllByProps({ className: "agent-tokens" })).toHaveLength(0);
      expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
      await update(roster({ quota: "40%" }));
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
      expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
    });
  }

  for (const state of ["disconnected", "error"] as const) {
    it(`closes the sheet when its PC enters ${state} with a cached roster`, async () => {
      const { mounted, row, update } = await open();
      await update(roster().map((machine) => ({ ...machine, state })));
      expect(row().findByProps({ className: "agent-select agent-row" }).props.disabled).toBe(true);
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props["aria-expanded"]).toBe(false);
    });
  }

  it("keeps the sheet closed when a disconnected PC reconnects", async () => {
    const { mounted, update } = await open();
    await update(roster().map((machine) => ({ ...machine, state: "disconnected" })));
    await update(roster({ quota: "40%" }));
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("keeps the sheet closed when a removed row returns", async () => {
    const { mounted, update } = await open();
    await update([]);
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await update(roster());
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
});

describe("AgentSidebar fold memory", () => {
  const focusedRow = { closest: () => null };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const FOLD_KEY = "ovis:agents-collapsed";
  let renderer: ReactTestRenderer | undefined;
  let stored: Map<string, string>;
  let writes: string[];
  let phone: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    stored = new Map();
    writes = [];
    phone = false;
    const events = new EventTarget();
    const localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.push(key); stored.set(key, value); },
      removeItem: (key: string) => { writes.push(key); stored.delete(key); },
    };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage,
      matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      location: { href: "http://localhost/" },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const inactive: SidebarFilter = { query: "", active: false, machines: new Map(), matches: 0 };
  const view = (filter: SidebarFilter) => <SettingsProvider>
    <SidebarFilterProvider value={{ filter, reportBranches: () => {} }}>
      <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
    </SidebarFilterProvider>
  </SettingsProvider>;

  async function mount(filter = inactive) {
    await act(async () => { renderer = create(view(filter)); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const toggle = () => mounted.root.findByProps({ className: "agent-section-toggle sidebar-section-label" });
    return {
      expanded: (): boolean => toggle().props["aria-expanded"],
      click: async () => { await act(async () => { toggle().props.onClick(); }); },
      remount: async (next = filter) => {
        await act(async () => { mounted.unmount(); });
        return mount(next);
      },
    };
  }

  it("keeps the defaults with nothing stored: open on a desktop, folded in the phone drawer", async () => {
    expect((await mount()).expanded()).toBe(true);
    await act(async () => { renderer?.unmount(); });
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
    await act(async () => { renderer?.unmount(); });
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
    await act(async () => {
      renderer = create(<SettingsProvider><SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider></SettingsProvider>);
    });
    const line = (agent: string) => renderer!.root.find((node) => node.props["data-helpers-of"] === `local:${agent}`).findByType("button");
    expect(line("w1C:p1").props["aria-expanded"]).toBe(false);
    stored.set("ovis:agents-helpers-open", JSON.stringify(["pc2:w1:p1", "local:gone:p1", "local:w1D:p1"]));
    await act(async () => { line("w1C:p1").props.onClick(); });
    expect(JSON.parse(stored.get("ovis:agents-helpers-open")!)).toEqual(["pc2:w1:p1", "local:w1D:p1", "local:w1C:p1"]);
    expect(line("w1C:p1").props["aria-expanded"]).toBe(true);
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
  const heading = (group: string) => renderer!.root.find((node) => node.type === "li" && node.props.className === "agent-group-label" && node.props["data-group"] === group).findByType("button");
  const foldedRows = (): string[] => renderer!.root.findAll((node) => node.type === "li" && node.props["data-pane"] !== undefined && node.props.hidden === true).map((node) => node.props["data-pane"]);

  it("starts with Idle folded and the other groups open, and keeps what the reader then folds and opens (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    await act(async () => { renderer = create(groupedList(inactive)); });
    expect(heading("idle").props["aria-expanded"]).toBe(false);
    expect(heading("working").props["aria-expanded"]).toBe(true);
    expect(foldedRows()).toEqual(["w1E:p1", "w1F:p1"]);
    expect(heading("idle").findByProps({ className: "agent-group-count" }).children).toEqual(["2"]);
    await act(async () => { heading("idle").props.onClick(); });
    await act(async () => { heading("working").props.onClick(); });
    expect(foldedRows()).toEqual([paneId]);
    expect(heading("working").findByProps({ className: "agent-group-count" }).children).toEqual(["1"]);
    await act(async () => { renderer!.unmount(); });
    await act(async () => { renderer = create(groupedList(inactive)); });
    expect(heading("idle").props["aria-expanded"]).toBe(true);
    expect(foldedRows()).toEqual([paneId]);
  });

  it("keeps the fold another tab made when this one folds another group (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", "[]");
    await act(async () => { renderer = create(groupedList(inactive)); });
    stored.set("ovis:agent-state-folds", JSON.stringify(["working"]));
    await act(async () => { heading("idle").props.onClick(); });
    expect(JSON.parse(stored.get("ovis:agent-state-folds")!)).toEqual(["working", "idle"]);
    expect(heading("working").props["aria-expanded"]).toBe(false);
    expect(heading("idle").props["aria-expanded"]).toBe(false);
  });

  it("keeps the selected agent in sight under its folded group, as the list's other folds do (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    const selecting = (pane: string) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={pane} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await act(async () => { renderer = create(selecting("w1E:p1")); });
    expect(foldedRows()).toEqual(["w1F:p1"]);
    expect(heading("idle").findByProps({ className: "agent-group-count" }).children).toEqual(["2"]);
    await act(async () => { renderer!.update(selecting(paneId)); });
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
    // the menu places itself by its button's box and its own size; a portal's elements take their node from its container
    const node = { isConnected: true, offsetWidth: 220, offsetHeight: 120, focus() {}, contains: () => false, querySelector: () => null, closest: () => null, getBoundingClientRect: () => ({ top: 40, bottom: 64, left: 260, right: 284 }) };
    Object.assign(document.body, { createNodeMock: () => node });
    await act(async () => {
      renderer = create(<SettingsProvider>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={blocked} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SettingsProvider>, { createNodeMock: () => node });
    });
    await act(async () => { renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: node }); });
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    const reason = renderer!.root.findByProps({ role: "menu" }).findByProps({ className: "row-menu-alert" });
    expect(reason.children).toEqual(["Needs permission: Allow bash?"]);
    // And the menu is described by it: a screen reader inside a menu reads its items, and nothing between them.
    expect(reason.props.id).toEqual(expect.any(String));
    expect(renderer!.root.findByProps({ role: "menu" }).props["aria-describedby"]).toBe(reason.props.id);
    await act(async () => { renderer!.root.findByProps({ "data-machine": "local", "data-pane": "w1E:p1" }).findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: node }); });
    expect(renderer!.root.findByProps({ role: "menu" }).findAllByProps({ className: "row-menu-alert" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ role: "menu" }).props["aria-describedby"]).toBeUndefined();
  });

  it("opens every folded group while the filter is in use, and leaves the stored fold alone (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", JSON.stringify(["idle"]));
    const keepsIdle: SidebarFilter = { query: "backup", active: true, matches: 1, machines: new Map([["local", {
      shown: true, matched: false, workspaces: new Set(), matchedWorkspaces: new Set(), revealedWorkspaces: new Set(), panes: new Set(["w1E:p1"]), matchedPanes: new Set(["w1E:p1"]),
    }]]) };
    await act(async () => { renderer = create(groupedList(keepsIdle)); });
    expect(heading("idle").props["aria-expanded"]).toBe(true);
    expect(heading("idle").props.disabled).toBe(true);
    expect(foldedRows()).toEqual([]);
    await act(async () => { renderer!.update(groupedList(inactive)); });
    expect(foldedRows()).toEqual(["w1E:p1", "w1F:p1"]);
    expect(JSON.parse(stored.get("ovis:agent-state-folds")!)).toEqual(["idle"]);
  });

  it("lets a watching device fold its groups: the fold is the device's own, and nothing is sent for it (#3505)", async () => {
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", "[]");
    await act(async () => { renderer = create(groupedList(inactive, roster(), true)); });
    await act(async () => { heading("working").props.onClick(); });
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
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await act(async () => { renderer = create(groupedList(inactive, at("working", 50, 0))); });
      await act(async () => { renderer!.update(groupedList(inactive, at("done", 51, 1))); });
      expect(since()).toEqual(["<1m"]);
      jest.setSystemTime(new Date(start + 5 * 60_000));
      await act(async () => { jest.advanceTimersByTime(30_000); });
      expect(since()).toEqual(["5m"]);
      await act(async () => { renderer!.update(groupedList(inactive, at("idle", 51, 1))); });
      await act(async () => { renderer!.update(groupedList(inactive, at("idle", 52, 1))); });
      expect(since()).toEqual(["5m"]);
      await act(async () => { renderer!.unmount(); });
      await act(async () => { renderer = create(groupedList(inactive, at("idle", 52, 1))); });
      expect(since()).toEqual(["5m"]);
      await act(async () => { renderer!.unmount(); });
      await act(async () => { renderer = create(groupedList(inactive, at("idle", 52, 2))); });
      expect(since()).toEqual([]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("says the times as of now when the folded list is opened, not as of when it was folded (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    const section = () => renderer!.root.findByProps({ className: "agent-section-toggle sidebar-section-label" });
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-state-folds", "[]");
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await act(async () => { renderer = create(groupedList(inactive, at("working"))); });
      await act(async () => { renderer!.update(groupedList(inactive, at("done"))); });
      expect(since()).toEqual(["<1m"]);
      await act(async () => { section().props.onClick(); });
      expect(section().props["aria-expanded"]).toBe(false);
      await act(async () => { jest.setSystemTime(new Date(start + 2 * 3_600_000)); });
      await act(async () => { section().props.onClick(); });
      expect(since()).toEqual(["2h"]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
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
    const page = (machines: Machine[]) => <SettingsProvider>
      <Stamping machines={machines} />
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
      <LaidOut machines={machines} />
    </SettingsProvider>;
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      // When the page loads, as the app does with no roster yet: nothing is looked at, so nothing the device keeps is
      // touched (a look at no PC would mark every stamp as its PC's having left the roster, for other tabs to read).
      const seeded = kept();
      await act(async () => { renderer = create(page([])); });
      expect(kept()).toEqual(seeded);
      expect(writes.filter((key) => key === "ovis:agent-state-since")).toEqual([]);
      await act(async () => { renderer!.update(page(loaded)); });
      expect(beforePaint).toEqual([undefined]);
      expect(since()).toEqual([]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
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
    const page = (machines: Machine[], list: boolean) => <SettingsProvider><Stamping machines={machines} />{list && <FirstDrawn />}</SettingsProvider>;
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      stored.set("ovis:agent-state-since", unproven);
      await act(async () => { renderer = create(page([], false)); });
      await act(async () => { renderer!.update(page(withLocal("connected"), true)); });
      expect(firstRead).toEqual([null]);
      await act(async () => { renderer!.unmount(); });

      firstRead.length = 0;
      stored.set("ovis:agent-state-since", unproven);
      await act(async () => { renderer = create(page(withLocal("connecting"), false)); });
      expect(JSON.parse(stored.get("ovis:agent-state-since")!)).toEqual(JSON.parse(unproven));
      await act(async () => { renderer!.update(page(withLocal("connected"), true)); });
      expect(firstRead).toEqual([null]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("gives no time to a change that reached a page that was not running, and counts again once a roster has come (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await act(async () => { renderer = create(groupedList(inactive, at("working"))); });
      await act(async () => { stateWatch.read(stateWatch.asked()); });
      jest.setSystemTime(new Date(start + 60 * 60_000));
      await act(async () => { renderer!.update(groupedList(inactive, at("blocked"))); });
      expect(since()).toEqual([]);
      await act(async () => { stateWatch.read(stateWatch.asked()); });
      expect(since()).toEqual([]);
      await act(async () => { renderer!.update(groupedList(inactive, at("working"))); });
      expect(since()).toEqual(["<1m"]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("keeps a time through a silent stream's ten minutes, and drops it when that stream proves dead as the tab is shown again (#3505)", async () => {
    const start = 1_800_000_000_000;
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await act(async () => { renderer = create(groupedList(inactive, at("working"))); });
      await act(async () => { stateWatch.subscription("opened"); stateWatch.pushed(); });
      await act(async () => { renderer!.update(groupedList(inactive, at("blocked"))); });
      expect(since()).toEqual(["<1m"]);
      await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
      await act(async () => { stateWatch.read(stateWatch.asked()); });
      expect(since()).toEqual(["10m"]);
      await act(async () => { jest.advanceTimersByTime(6_000); stateWatch.subscription("lost"); });
      expect(since()).toEqual([]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
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
    const since = (id: string) => renderer!.root.findByProps({ "data-machine": "local", "data-pane": id }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    jest.useFakeTimers();
    jest.setSystemTime(new Date(start));
    try {
      await act(async () => { renderer = create(groupedList(inactive, at("working"))); });
      await act(async () => { stateWatch.subscription("opened"); stateWatch.pushed(); });
      await act(async () => { renderer!.update(groupedList(inactive, at("blocked"))); });
      await act(async () => { jest.advanceTimersByTime(120 * 60_000); });
      expect(since(paneId)).toEqual(["2h"]);
      await act(async () => { renderer!.update(groupedList(inactive, at("blocked", "w9:p1"))); });
      expect(since("w9:p1")).toEqual(["2h"]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("reads no time from a stamping that has ended: the page's stamps leave with it, and the device keeps them", async () => {
    const finished = roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "done" as const } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    await act(async () => { renderer = create(groupedList(inactive)); });
    await act(async () => { renderer!.update(groupedList(inactive, finished)); });
    expect(since()).toEqual(["<1m"]);
    await act(async () => { renderer!.unmount(); });
    await act(async () => { renderer = create(<SettingsProvider><AgentSidebar machines={finished} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} /></SettingsProvider>); });
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
      await act(async () => { renderer?.unmount(); });
      await act(async () => { renderer = create(<SettingsProvider><SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={filled} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider></SettingsProvider>); });
      return renderer!.root.findAll((node) => node.type === "span" && node.props["data-testid"] === "context-left")
        .map((node) => [node.props["aria-label"], node.props.className]);
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
    await act(async () => { renderer = create(grouped(blockedRoster(false))); });
    const mounted = renderer!;
    const list = () => mounted.root.findByProps({ className: "agent-list agent-list-grouped" });
    const groupOf = (pane: string): string | undefined => {
      let group: string | undefined;
      for (const child of list().children) {
        if (typeof child === "string") continue;
        if (child.props.className === "agent-group-label") group = child.props["data-group"];
        if (child.props["data-pane"] === pane) return group;
      }
      return undefined;
    };
    expect(groupOf(paneId)).toBe("working");
    await act(async () => { mounted.update(grouped(blockedRoster(true))); });
    expect(groupOf(paneId)).toBe("blocked");
    expect(mounted.root.findAllByProps({ className: "agent-list" })).toHaveLength(0);
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
    await act(async () => { renderer = create(groupedList(inactive, machines)); });
    const drawn: Record<string, { under: string | undefined; said: boolean; own: boolean }> = {};
    let under: string | undefined;
    for (const child of renderer!.root.findByProps({ className: "agent-list agent-list-grouped" }).children) {
      if (typeof child === "string") continue;
      if (child.props.className === "agent-group-label") under = child.props["data-group"];
      else if (child.props["data-pane"] !== undefined) drawn[child.props["data-pane"]] = { under, said: child.props["data-state-said"] === "", own: child.props["data-state-own"] === "" };
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
    await act(async () => { renderer = create(grouped(inState("working"))); });
    const mounted = renderer!;
    const section = () => mounted.root.findByType("section");
    const hidden = (): boolean => mounted.root.find((node) => node.type === "li" && node.props["data-pane"] === paneId).props.hidden === true;
    const idleHeading = () => mounted.root.find((node) => node.type === "li" && node.props.className === "agent-group-label" && node.props["data-group"] === "idle").findByType("button");
    const focusHeading = jest.fn();
    const heading = { focus: focusHeading, getAttribute: (name: string) => name === "aria-expanded" ? String(idleHeading().props["aria-expanded"]) : null };
    const line = { previousElementSibling: null, hasAttribute: () => false, matches: () => true, querySelector: () => heading };
    const control = { closest: () => ({ get hidden() { return hidden(); }, previousElementSibling: line }) };
    const focusIsOn = (element: unknown): void => { Object.assign(document, { activeElement: element }); };
    const composer = {};
    const becomes = async (status: AgentStatus): Promise<void> => { await act(async () => { mounted.update(grouped(inState(status))); }); };
    const rowTakesFocus = async (): Promise<void> => { await act(async () => { section().props.onFocus({ target: control }); }); };
    expect(String(idleHeading().props["aria-expanded"])).toBe("false");

    await rowTakesFocus();
    focusIsOn(document.body);
    await becomes("idle");
    expect(hidden()).toBe(true);
    expect(focusHeading).toHaveBeenCalledTimes(1);

    await becomes("working");
    await rowTakesFocus();
    focusIsOn(composer);
    await becomes("idle");
    expect(hidden()).toBe(true);
    expect(focusHeading).toHaveBeenCalledTimes(1);

    await becomes("working");
    await rowTakesFocus();
    focusIsOn(document.body);
    await becomes("blocked");
    expect(hidden()).toBe(false);
    await becomes("idle");
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
    await act(async () => { renderer = create(view(tagged(false))); });
    const mounted = renderer!;
    const row = () => mounted.root.find((node) => node.type === "li" && node.props["data-pane"] === paneId);
    const order = () => mounted.root.findAll((node) => node.type === "li" && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label")).map((node) => node.props["data-pane"] ?? "BG");
    expect(order().indexOf(paneId)).toBeGreaterThan(order().indexOf("BG"));
    const before = row();
    await act(async () => { mounted.update(view(tagged(true))); });
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
      await act(async () => { renderer?.unmount(); });
      await act(async () => { renderer = create(<SettingsProvider><SidebarActivityProvider value={activity}>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={sameNames} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SidebarActivityProvider></SettingsProvider>); });
      return renderer!.root.findAll((node) => typeof node.type === "string" && node.props["data-pane"] !== undefined).map((node) => node.props["data-pane"]);
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
    await act(async () => { renderer = create(renderList(roster())); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const section = () => mounted.root.findByType("section");
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => node.props["data-pane"] ?? "RESTING");
    const restingLabel = () => mounted.root.findByProps({ className: "agent-background-label agent-resting-label" }).findByType("span").children.join("");
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+2 resting");

    await act(async () => { section().props.onPointerEnter(); });
    await act(async () => { mounted.update(renderList(withStatuses({ "w1E:p1": "blocked" }))); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+1 resting");
    await act(async () => { section().props.onPointerLeave(); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1C:p1", "RESTING"]);

    await act(async () => { section().props.onFocus({ target: focusedRow }); });
    await act(async () => { mounted.update(renderList(withStatuses({ "w1E:p1": "blocked", "w1F:p1": "blocked" }))); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1C:p1", "RESTING"]);
    await act(async () => { section().props.onBlur({ target: focusedRow, currentTarget: { contains: () => false }, relatedTarget: null }); });
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
    await act(async () => { renderer = create(renderList(roster())); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const section = () => mounted.root.findByType("section");
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => node.props["data-pane"] ?? "RESTING");
    const restingLabel = () => mounted.root.findByProps({ className: "agent-background-label agent-resting-label" }).findByType("span").children.join("");
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+2 resting");

    await act(async () => { section().props.onPointerEnter(); section().props.onFocus({ target: focusedRow }); });
    await act(async () => { mounted.update(renderList(withStatuses({ [paneId]: "idle", "w1D:p1": "idle" }))); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+4 resting");

    await act(async () => { section().props.onPointerLeave(); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);

    await act(async () => { section().props.onBlur({ target: focusedRow, currentTarget: { contains: () => false }, relatedTarget: null }); });
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
    await act(async () => { renderer = create(renderList(family("working", "done"))); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => [node.props["data-pane"] ?? "RESTING", node.props["data-depth"] ?? 0]);
    const restingLabel = () => mounted.root.findByProps({ className: "agent-background-label agent-resting-label" }).findByType("span").children.join("");
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["w1E:p1", 1], ["RESTING", 0]]);
    expect(restingLabel()).toBe("+1 resting");

    await act(async () => { mounted.update(renderList(family("idle", "working"))); });
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
    await act(async () => { renderer = create(renderList(helped(true))); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const section = () => mounted.root.findByType("section");
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => [node.props["data-pane"] ?? "RESTING", node.props["data-depth"] ?? 0]);
    const restingLabel = () => mounted.root.findByProps({ className: "agent-background-label agent-resting-label" }).findByType("span").children.join("");
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["w1E:p1", 1], ["RESTING", 0]]);

    await act(async () => { section().props.onPointerEnter(); });
    await act(async () => { mounted.update(renderList(helped(false))); });
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["RESTING", 0]]);
    await act(async () => { section().props.onPointerLeave(); });
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["RESTING", 0]]);

    await act(async () => { mounted.update(renderList(working(false))); });
    const before = restingLabel();
    expect(drawnEntries()).toEqual([["w1C:p1", 0], ["w1D:p1", 0], ["RESTING", 0]]);
    await act(async () => { section().props.onPointerEnter(); });
    await act(async () => { mounted.update(renderList(working(true))); });
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
    await act(async () => { renderer = create(renderList(helpers(["w1D:p7", "w1D:p8"]))); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const family = () => mounted.root.findAll((node) => node.type === "li" && typeof node.props["data-pane"] === "string" && node.props["data-pane"].startsWith("w1D:"))
      .map((node) => [node.props["data-pane"], node.props["data-more"] === ""]);
    expect(family()).toEqual([["w1D:p1", false], ["w1D:p7", true], ["w1D:p8", false]]);
    await act(async () => { mounted.root.findByType("section").props.onPointerEnter(); });
    await act(async () => { mounted.update(renderList(helpers(["w1D:p7", "w1D:p8", "w1D:p9"]))); });
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
      await act(async () => { renderer = create(renderList(false)); });
      if (!renderer) throw new Error("sidebar did not mount");
      const mounted = renderer;
      const section = () => mounted.root.findByType("section");
      const order = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && node.props["data-pane"] !== undefined).map((node) => node.props["data-pane"]);
      await act(async () => { section().props.onPointerEnter(); });
      await act(async () => { section().props.onTouchEnd?.(); section().props.onPointerLeave(); });
      await act(async () => { mounted.update(renderList(true)); jest.advanceTimersByTime(999); });
      expect(order()).toEqual(["w1D:p1", paneId]);
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(order()).toEqual(["w1D:p1", "w1E:p1", paneId]);
      expect(mounted.root.findAll((node) => node.type === "li" && node.props.className.includes("is-selected")).map((node) => node.props["data-pane"])).toEqual([paneId]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
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
    await act(async () => { renderer = create(renderList(keepsWorking)); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => node.props["data-pane"] ?? "RESTING");
    expect(drawnEntries()).toEqual([paneId]);
    await act(async () => { mounted.root.findByType("section").props.onPointerEnter(); });
    await act(async () => { mounted.update(renderList(inactive)); });
    expect(drawnEntries()).toEqual(["w1D:p1", paneId, "RESTING"]);
  });
});
