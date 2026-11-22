import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { AppLink, LinkNote } from "./deepLink.ts";
import { linkTarget, type NotificationTarget } from "./notificationTarget.ts";
import { getTransport, setTransport } from "./transport.ts";
import { useNotificationTargets, useSelectTarget } from "./useSelection.ts";

describe("a desktop link's landing", () => {
  let saved: PropertyDescriptor | undefined;
  let renderer: ReactTestRenderer | undefined;
  let take: (target: NotificationTarget) => void;
  let pending: { current: AppLink | null };
  let selected: [string, string | null, string | undefined][];
  let waits: number;

  const roster = [{
    id: "local",
    state: "connected",
    snapshot: {
      workspaces: [{ workspace_id: "3", label: "alpha", active_tab_id: "3:1" }, { workspace_id: "4", label: "beta", active_tab_id: "4:1" }],
      panes: [{ pane_id: "t1", workspace_id: "3", focused: true }, { pane_id: "t3", workspace_id: "4", focused: true }],
      layouts: [],
    },
  }] as unknown as Machine[];

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    selected = [];
    waits = 0;
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function mount(machines: Machine[]): Promise<void> {
    function Probe() {
      const machinesRef = useRef(machines);
      const pendingLink = useRef<AppLink | null>(null);
      pending = pendingLink;
      const pendingFile = useRef<string | null>(null);
      const selectionHint = useRef(null);
      const linkSince = useRef(0);
      const rosterSeq = useRef(0);
      const [, setLinkLanded] = useState(true);
      const [, setLinkTick] = useState(0);
      const selectTargetRef = useRef((machineId: string, paneId: string | null, view?: string) => { selected.push([machineId, paneId, view]); pendingLink.current = null; });
      take = useNotificationTargets({
        machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick,
        load: async () => {}, onLinkWait: () => { waits += 1; },
      } as Parameters<typeof useNotificationTargets>[0]).takeNotificationTarget;
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  it("selects a pane the roster lists in the link's workspace", async () => {
    await mount(roster);
    await act(async () => { take(linkTarget("?ws=4-beta&pane=t3&view=terminal")!); });
    expect(selected).toEqual([["local", "t3", "terminal"]]);
    expect(pending.current).toBeNull();
  });

  it("never selects a pane of another workspace than the link names: it waits with no pane", async () => {
    await mount(roster);
    await act(async () => { take(linkTarget("?ws=3&pane=t3&view=terminal")!); });
    expect(selected).toEqual([["local", null, undefined]]);
    expect(pending.current).toMatchObject({ machine: "local", workspace: "3", pane: "t3" });
    expect(waits).toBe(1);
  });

  it("selects nothing but the PC before the roster is in", async () => {
    await mount([]);
    await act(async () => { take(linkTarget("?ws=4-beta&pane=t3")!); });
    expect(selected).toEqual([["local", null, undefined]]);
    expect(pending.current).toMatchObject({ workspace: "4", workspaceSlug: "beta", pane: "t3" });
  });

  it("selects nothing but the PC from an offline PC's cached roster", async () => {
    await mount([{ ...roster[0]!, state: "disconnected" }] as Machine[]);
    await act(async () => { take(linkTarget("?ws=4-beta&pane=t3")!); });
    expect(selected).toEqual([["local", null, undefined]]);
    expect(pending.current).toMatchObject({ workspace: "4", workspaceSlug: "beta", pane: "t3" });
  });

  it("takes a link to the same pane id under another slug as a new place, and the same link once", async () => {
    await mount([]);
    await act(async () => { take(linkTarget("?ws=3-alpha&pane=t3")!); });
    await act(async () => { take(linkTarget("?ws=3-alpha&pane=t3")!); });
    expect(selected).toHaveLength(1);
    await act(async () => { take(linkTarget("?ws=3-beta&pane=t3")!); });
    expect(selected).toHaveLength(2);
    expect(pending.current?.workspaceSlug).toBe("beta");
  });

  it("lands a tapped notification as before: a listed pane by its id", async () => {
    await mount(roster);
    await act(async () => { take({ machine_id: "local", pane_id: "t3", view: "chat", workspace_id: "3" }); });
    expect(selected).toEqual([["local", "t3", "chat"]]);
    expect(waits).toBe(0);
  });
});

describe("a desktop link to a pane the cached roster lacks", () => {
  const transport = getTransport();
  let saved: PropertyDescriptor | undefined;
  let renderer: ReactTestRenderer | undefined;
  let take: (target: NotificationTarget) => void;
  let pick: (machineId: string, paneId: string | null) => void;
  let shown: { pane: string | null; note: LinkNote | "copied" | null };
  let misses: number;
  let reads = 0;
  let landed: Promise<void>;

  // workspace 3 "alpha" (t1 selected, t2 in front), workspace 4 "beta" (t4, herdr's focus), and
  // "gamma" (t5) with an id as herdr-core gives them, hyphens included
  const gamma = "ovis-367b423f-b9d6-4055-8a21-95d49868783e";
  const snapshot = {
    workspaces: [{ workspace_id: "3", label: "alpha", active_tab_id: "3:1" }, { workspace_id: "4", label: "beta", active_tab_id: "4:1" }, { workspace_id: gamma, label: "gamma", active_tab_id: `${gamma}:1` }],
    panes: [{ pane_id: "t1", workspace_id: "3", focused: false }, { pane_id: "t2", workspace_id: "3", focused: true }, { pane_id: "t4", workspace_id: "4", focused: true }, { pane_id: "t5", workspace_id: gamma, focused: true }],
    layouts: [],
    focused_pane_id: "t4",
  };
  const machines = [{ id: "local", name: "This PC", kind: "local", enabled: true, state: "connected", error: null, snapshot }] as unknown as Machine[];

  function answer(read: "roster" | "fails"): void {
    setTransport({ ...transport, async fetch() {
      reads += 1;
      if (read === "fails") throw new TypeError("network error");
      return Response.json({ snapshot });
    } });
  }

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    misses = 0;
    reads = 0;
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    setTransport(transport);
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function mount(): Promise<void> {
    let settle = () => {};
    landed = new Promise((resolve) => { settle = resolve; });
    let waiting = false;
    const noop = () => {};
    function Probe() {
      const [selectedMachineId, setSelectedMachineId] = useState("local");
      const [selectedPaneId, setSelectedPaneId] = useState<string | null>("t1");
      const [headerNote, setHeaderNote] = useState<LinkNote | "copied" | null>(null);
      const [linkTick, setLinkTick] = useState(0);
      const [, setLinkLandedState] = useState(true);
      const setLinkLanded = (value: boolean) => {
        setLinkLandedState(value);
        if (!value) waiting = true;
        else if (waiting) settle();
      };
      const machinesRef = useRef(machines);
      const pendingLink = useRef<AppLink | null>(null);
      const pendingFile = useRef<string | null>(null);
      const selectionHint = useRef(null);
      const linkSince = useRef(0);
      const rosterSeq = useRef(0);
      const selectionSince = useRef(0);
      const movingPanes = useRef(new Set<string>());
      const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);
      const { selectTargetRef, selectTarget } = useSelectTarget({
        selectedMachineId, setConnected: noop, setConnectedBefore: noop, setSelectedMachineId, setSelectedPaneId, setAutoSelected: noop,
        setDrawerOpen: noop, setOutputStopped: noop, setNotificationViewTarget: noop, setTerminalPeek: noop, pendingLink, pendingFile,
        setLinkLanded, selectionHint, selectionSince, rosterSeq, snapshot: selectedMachine?.snapshot ?? null, selectedMachine, selectedPaneId,
        setHeaderNote, linkTick, movingPanes, onLinkMiss: () => { misses += 1; },
      } as Parameters<typeof useSelectTarget>[0]);
      take = useNotificationTargets({
        machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick, load: async () => {},
      } as Parameters<typeof useNotificationTargets>[0]).takeNotificationTarget;
      pick = selectTarget;
      shown = { pane: selectedPaneId, note: headerNote };
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  async function open(query: string): Promise<void> {
    await act(async () => { take(linkTarget(query)!); });
    await act(async () => { await landed; });
  }

  it("selects the fallback pane without a word when this PC cannot be asked", async () => {
    answer("fails");
    await mount();
    await open("?ws=9-gone&pane=t99");
    expect(reads).toBeGreaterThan(0);
    expect(shown).toEqual({ pane: "t4", note: null });
    expect(misses).toBe(0);
  });

  it("opens the link's workspace without a word when this PC cannot be asked", async () => {
    answer("fails");
    await mount();
    await open("?ws=3-alpha&pane=t99");
    expect(shown).toEqual({ pane: "t2", note: null });
    expect(misses).toBe(0);
  });

  it("selects the fallback pane with the not-found note when this PC answers without the pane", async () => {
    answer("roster");
    await mount();
    await open("?ws=9-gone&pane=t99");
    expect(reads).toBeGreaterThan(0);
    expect(shown).toEqual({ pane: "t4", note: "workspace-closed" });
    expect(misses).toBe(1);
  });

  it("opens the link's workspace when its id holds hyphens, as the address writes it, with the pane's note", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}-gamma&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    expect(misses).toBe(1);
  });

  it("opens the link's workspace when its hyphenated id comes with no slug, with the pane's note", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
  });

  it("selects a live pane by its hyphenated workspace id when that workspace was renamed and its old name given to another", async () => {
    answer("roster");
    await mount();
    await act(async () => { take(linkTarget(`?ws=${gamma}-alpha&pane=t5`)!); });
    expect(shown).toEqual({ pane: "t5", note: null });
    expect(misses).toBe(0);
  });

  it("keeps the workspace-closed note and the fallback for a hyphenated id no workspace has", async () => {
    answer("roster");
    await mount();
    await open("?ws=ovis-00000000-0000-4000-8000-000000000000-gone&pane=t99");
    expect(shown).toEqual({ pane: "t4", note: "workspace-closed" });
  });

  it("selects a listed pane at once, asking nothing and saying nothing", async () => {
    answer("fails");
    await mount();
    await act(async () => { take(linkTarget("?ws=3-alpha&pane=t2")!); });
    expect(shown).toEqual({ pane: "t2", note: null });
    expect(reads).toBe(0);
    expect(misses).toBe(0);
  });

  it("keeps a landing's note while the same link comes again, as a tapped notification's second delivery does, though its own read fails", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}-gamma&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    const asked = reads;
    answer("fails");
    await act(async () => { take(linkTarget(`?ws=${gamma}-gamma&pane=t99`)!); });
    expect(reads).toBeGreaterThan(asked);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
  });

  it("keeps a landing's note when a link the roster lists selects another pane: a link selects, not the user", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}-gamma&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    await act(async () => { take(linkTarget("?ws=3-alpha&pane=t2")!); });
    expect(shown).toEqual({ pane: "t2", note: "pane-closed" });
  });

  it("keeps a landing's note through a tapped notification's second delivery, though that delivery's read fails", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}-gamma&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    answer("fails");
    await act(async () => { take({ machine_id: "local", pane_id: "t99", view: "chat", workspace_id: gamma }); });
    expect(shown.note).toBe("pane-closed");
  });

  it("keeps a landing's note when a tapped notification names a pane the roster lists: a notification selects, not the user", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}-gamma&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    await act(async () => { take({ machine_id: "local", pane_id: "t2", view: "chat", workspace_id: "3" }); });
    expect(shown).toEqual({ pane: "t2", note: "pane-closed" });
  });

  it("keeps a landing's note when the user picks the pane already shown, and takes it away when they pick another", async () => {
    answer("roster");
    await mount();
    await open(`?ws=${gamma}-gamma&pane=t99`);
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    await act(async () => { pick("local", "t5"); });
    expect(shown).toEqual({ pane: "t5", note: "pane-closed" });
    await act(async () => { pick("local", "t2"); });
    expect(shown).toEqual({ pane: "t2", note: null });
  });
});
