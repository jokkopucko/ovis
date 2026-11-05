import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { AppActions } from "./actions.ts";
import { layoutActions } from "./layoutActions.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { SettingsProvider } from "./settings.ts";
import { useShortcuts } from "./shortcuts.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

const selection = { current: { machineId: "local", paneId: "p1", generation: 0 } satisfies SelectionMark };
/** herdr's TUI server, and a herdr-core PC, which splits and zooms no pane (lib/machineContext.tsx) */
const OFFERS = { tui: { split: true, arrange: true }, core: { split: false, arrange: false } };
const layout = (pc: keyof typeof OFFERS, selectedPaneId: string | null = "p1") =>
  layoutActions({ selectedPaneId, offer: OFFERS[pc], selection, load: () => undefined, selectPane: () => {}, layoutRefused: () => {} });
const chord = (key: string) => Object.assign(new Event("keydown", { cancelable: true }), { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false });

describe("layoutActions", () => {
  it("gives the palette and the shortcuts herdr's split and zoom on a TUI PC with a pane", () => {
    const offered = layout("tui");
    expect(typeof offered.splitPane).toBe("function");
    expect(typeof offered.zoomPane).toBe("function");
  });

  it("gives neither without a pane, nor on a PC the Herdr app lays out", () => {
    expect(layout("tui", null)).toEqual({ splitPane: null, zoomPane: null });
    expect(layout("core")).toEqual({ splitPane: null, zoomPane: null });
  });
});

describe("the split shortcut", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const events = new EventTarget();
  let renderer: ReactTestRenderer | undefined;
  let requested: string[];

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    requested = [];
    // Settings gives the split its key: it has none until one is chosen there
    const stored = new Map<string, string>([[SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { "split-right": "l" } })]]);
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
  async function press(pc: keyof typeof OFFERS): Promise<void> {
    const actions = { ...layout(pc) } as AppActions;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Response.json({ pane_id: "p2", workspace_id: "w1", tab_id: "t1", terminal_id: "p2:term", revision: 1, focused: true, agent_status: "idle" });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Shortcuts, { actions }))); });
      await act(async () => { events.dispatchEvent(chord("l")); });
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
    expect(requested).toEqual([]);
  });
});
