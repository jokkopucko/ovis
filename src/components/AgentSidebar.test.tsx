import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { currentAgentRowTokens, setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const paneId = "w1C:p1";

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
  // RowMenu asks the anchor whether it sits inside a dialog; this row is not in one.
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
    // leaveSheet schedules history cleanup; await that signal before restoring window.
    if (historyState !== null) await steppedBack;
    setAgentRowTokens(originalTokens);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const view = (machines: Machine[]) => <SettingsProvider>
    <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
  </SettingsProvider>;

  async function open() {
    await act(async () => {
      renderer = create(view(roster()), { createNodeMock: () => anchor });
    });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const row = () => mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId });
    await act(async () => { row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["95%"]);
    return {
      mounted,
      row,
      update: async (machines: Machine[]) => { await act(async () => { mounted.update(view(machines)); }); },
    };
  }

  it("updates the open sheet when a plugin value changes", async () => {
    // Given an open sheet with the original quota.
    const { mounted, update } = await open();
    // When a new roster reports a different quota.
    await update(roster({ quota: "40%" }));
    // Then the sheet shows the new value without reopening.
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
  });

  it("says a blocked agent's whole reason in the open sheet, which has no tooltip", async () => {
    const { mounted, update } = await open();
    // When herdr-core reports the agent blocked on a permission, with its message.
    await update(roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "blocked" as const, agent_kind: "permission", agent_message: "Allow bash?" } : pane),
      },
    })));
    // Then the sheet gives the reason in full before the plugin values.
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["Needs permission: Allow bash? \u00b7 95%"]);
  });

  it("removes the sheet detail when a token is deleted", async () => {
    const { mounted, update } = await open();
    // When the pane no longer reports any tokens.
    await update(roster({}));
    // Then the open sheet has no stale detail.
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
  });

  it("removes the sheet detail when a new hide rule matches", async () => {
    const { mounted } = await open();
    // When the live sidebar configuration hides the current quota.
    await act(async () => { setAgentRowTokens({ rows: [{ name: "quota", rules: [{ equals: "95%", hide: true }] }], by_agent: {} }); });
    // Then the open sheet follows the same visibility rule as its row.
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
  });

  for (const state of ["connecting", "reconnecting"] as const) {
    it(`keeps the sheet open when its PC briefly enters ${state} then recovers`, async () => {
      // Given an open sheet whose row and anchor will remain present.
      const { mounted, row, update } = await open();
      // When a transient connection state is followed by a recovered roster.
      await update(roster().map((machine) => ({ ...machine, state })));
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
      expect(row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props["aria-expanded"]).toBe(true);
      expect(row().findAllByProps({ className: "agent-tokens" })).toHaveLength(0);
      expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
      await update(roster({ quota: "40%" }));
      // Then the same open sheet resumes showing the row's current values.
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
      expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
    });
  }

  for (const state of ["disconnected", "error"] as const) {
    it(`closes the sheet when its PC enters ${state} with a cached roster`, async () => {
      // Given an open sheet and a cached row.
      const { mounted, row, update } = await open();
      // When the PC reaches a terminal connection state but retains its snapshot.
      await update(roster().map((machine) => ({ ...machine, state })));
      // Then the row remains available but its sheet is closed.
      expect(row().findByProps({ className: "agent-select agent-row" }).props.disabled).toBe(true);
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props["aria-expanded"]).toBe(false);
    });
  }

  it("keeps the sheet closed when a disconnected PC reconnects", async () => {
    const { mounted, update } = await open();
    await update(roster().map((machine) => ({ ...machine, state: "disconnected" })));
    // When the PC reconnects, a retired sheet must not reopen.
    await update(roster({ quota: "40%" }));
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("keeps the sheet closed when a removed row returns", async () => {
    const { mounted, update } = await open();
    await update([]);
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    // When a row with the same identity later returns.
    await update(roster());
    // Then removal has retired the menu state, not merely hidden the sheet.
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
});

describe("AgentSidebar fold memory", () => {
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
    // Given a desktop list the reader folds.
    const sidebar = await mount();
    await sidebar.click();
    expect(sidebar.expanded()).toBe(false);
    // When the page loads again, the fold is still there.
    const reloaded = await sidebar.remount();
    expect(reloaded.expanded()).toBe(false);
    // And opening it again is remembered too.
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

  it("never writes the filter's temporary fold", async () => {
    // Given a filter that keeps no agent rows.
    const sidebar = await mount({ query: "nothing", active: true, machines: new Map(), matches: 0 });
    const before = sidebar.expanded();
    // When the reader folds and opens the list during the filter.
    await sidebar.click();
    expect(sidebar.expanded()).toBe(!before);
    await sidebar.click();
    // Then nothing is stored, and the list comes back with the screen's default.
    expect(writes).toEqual([]);
    expect((await sidebar.remount(inactive)).expanded()).toBe(true);
  });
});
