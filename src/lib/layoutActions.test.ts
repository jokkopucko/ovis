import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { PaneLayoutSnapshot, SessionSnapshot } from "../../shared/protocol.ts";
import type { AppActions } from "./actions.ts";
import { layoutActions } from "./layoutActions.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { SettingsProvider } from "./settings.ts";
import { useShortcuts } from "./shortcuts.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

const selection = { current: { machineId: "local", paneId: "p1", generation: 0 } satisfies SelectionMark };
/** herdr's TUI server, and a herdr-core PC, which splits and zooms no pane (lib/machineContext.tsx) */
const OFFERS = { tui: { split: true, arrange: true }, core: { split: false, arrange: false } };
const tabLayout = (tab: string, panes: string[], zoomed = false) => ({ tab_id: tab, workspace_id: "w1", focused_pane_id: panes[0]!, zoomed }) as PaneLayoutSnapshot;
const rosterOf = (zoomed = false) => ({ current: {
  panes: [{ pane_id: "p1", tab_id: "t1" }, { pane_id: "p2", tab_id: "t1" }, { pane_id: "p3", tab_id: "t2" }],
  layouts: [tabLayout("t1", ["p1", "p2"], zoomed), tabLayout("t2", ["p3"])],
} as unknown as SessionSnapshot });
const layout = (pc: keyof typeof OFFERS, selectedPaneId: string | null = "p1", paneSplits = true, roster = rosterOf()) =>
  layoutActions({ selectedPaneId, offer: OFFERS[pc], paneSplits, selection, roster, load: () => undefined, selectPane: () => {}, layoutRefused: () => {} });
const chord = (key: string) => Object.assign(new Event("keydown", { cancelable: true }), { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false });

describe("layoutActions", () => {
  it("gives the palette and the shortcuts herdr's split and zoom on a TUI PC with a pane", () => {
    const offered = layout("tui");
    expect(typeof offered.splitPane).toBe("function");
    expect(typeof offered.zoomPane).toBe("function");
  });

  it("gives neither without a pane, nor on a PC the Herdr app lays out", () => {
    expect(layout("tui", null)).toEqual({ splitPane: null, zoomPane: null, toggleZoom: null });
    expect(layout("core")).toEqual({ splitPane: null, zoomPane: null, toggleZoom: null });
  });

  it("gives no split for a pane in a tab of its own terminal, which herdr-core refuses to split (#2806)", () => {
    const offered = layout("tui", "p1", false);
    expect(offered.splitPane).toBeNull();
    expect(typeof offered.zoomPane).toBe("function");
  });
});

describe("the split and zoom shortcuts", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const events = new EventTarget();
  let renderer: ReactTestRenderer | undefined;
  let requested: string[];
  let bodies: unknown[];

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    requested = [];
    bodies = [];
    const stored = new Map<string, string>([[SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { "split-right": "l", "zoom-pane": "z" } })]]);
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setTimeout, clearTimeout });
    define("document", { activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

  function Shortcuts({ actions }: { actions: AppActions }) {
    useShortcuts(actions, true);
    return null;
  }
  async function press(pc: keyof typeof OFFERS, key = "l", { pane = "p1", roster = rosterOf(), times = 1 } = {}): Promise<void> {
    await act(async () => renderer?.unmount());
    selection.current = { ...selection.current, paneId: pane };
    const actions = { ...layout(pc, pane, true, roster) } as AppActions;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Response.json({ pane_id: "p2", workspace_id: "w1", tab_id: "t1", terminal_id: "p2:term", revision: 1, focused: true, agent_status: "idle" });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Shortcuts, { actions }))); });
      await act(async () => { for (let press = 0; press < times; press++) events.dispatchEvent(chord(key)); });
    } finally {
      fetch.mockRestore();
    }
  }

  it("splits the selected pane on a TUI PC", async () => {
    await press("tui");
    expect(requested).toEqual(["/api/pane/split"]);
  });

  it("does nothing on a PC the Herdr app lays out", async () => {
    await press("core");
    await press("core", "z");
    expect(requested).toEqual([]);
  });

  it("zooms the selected pane of a split tab, and unzooms the one its tab shows alone (#2037)", async () => {
    await press("tui", "z");
    await press("tui", "z", { roster: rosterOf(true) });
    expect(requested).toEqual(["/api/pane/zoom", "/api/pane/zoom"]);
    expect(bodies).toEqual([{ pane_id: "p1", mode: "on" }, { pane_id: "p1", mode: "off" }]);
  });

  it("unzooms on a second press made before herdr's answer, rather than zooming again", async () => {
    await press("tui", "z", { times: 2 });
    expect(bodies).toEqual([{ pane_id: "p1", mode: "on" }, { pane_id: "p1", mode: "off" }]);
  });

  it("zooms no pane alone in its tab, where a zoom shows nothing new", async () => {
    await press("tui", "z", { pane: "p3" });
    expect(requested).toEqual([]);
  });
});
