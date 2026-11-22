import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { AppActions } from "./actions.ts";
import { SettingsProvider } from "./settings.ts";
import { useShortcuts } from "./shortcuts.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

const element = (within: string | null = null, expanded = false) => ({ tagName: "TEXTAREA", classList: { contains: () => false }, closest: (selector: string) => within !== null && selector.includes(within) ? {} : null, getAttribute: (name: string) => name === "aria-expanded" ? String(expanded) : null });

describe("the Close pane shortcut", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let listeners: ((event: KeyboardEvent) => void)[];
  let renderer: ReactTestRenderer | undefined;
  let closes: number;
  let tabCloses: number;
  let modalOpen: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    listeners = [];
    closes = 0;
    tabCloses = 0;
    modalOpen = false;
    const stored = new Map<string, string>([[SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { "close-pane": "ctrl+alt+x", "close-tab": "ctrl+alt+t" } })]]);
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", {
      localStorage: storage, matchMedia: () => media, setTimeout, clearTimeout,
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { if (type === "keydown") listeners.push(listener); },
      removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { listeners = listeners.filter((item) => item !== listener); },
    });
    define("document", {
      activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: (selector: string) => modalOpen && selector.includes("aria-modal") ? [{}] : [],
      addEventListener() {}, removeEventListener() {},
    });
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
  async function mount(closePane: AppActions["closePane"] = () => { closes += 1; }, closeTab: AppActions["closeTab"] = () => { tabCloses += 1; }): Promise<void> {
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Shortcuts, { actions: { closePane, closeTab } as AppActions }))); });
  }
  function press({ repeat = false, target = element() as unknown, key = "x" } = {}): boolean {
    let prevented = false;
    const event = { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, repeat, target, preventDefault: () => { prevented = true; } };
    for (const listener of listeners) listener(event as unknown as KeyboardEvent);
    return prevented;
  }

  it("closes the selected pane once per press, from the terminal or the message box", async () => {
    await mount();
    expect(press({ target: { tagName: "TEXTAREA", classList: { contains: (name: string) => name === "xterm-helper-textarea" }, closest: () => null } })).toBe(true);
    expect(press()).toBe(true);
    expect(closes).toBe(2);
  });

  it("closes one pane for a held key: its repeats are taken and close nothing", async () => {
    await mount();
    press();
    for (let repeat = 0; repeat < 5; repeat++) expect(press({ repeat: true })).toBe(true);
    expect(closes).toBe(1);
  });

  it.each(["[role='alertdialog']", "[role='dialog']", "[role='menu']", "[role='listbox']"])("leaves the key to a %s that has the focus", async (owner) => {
    await mount();
    expect(press({ target: element(owner) })).toBe(false);
    expect(press({ target: element(owner), repeat: true })).toBe(false);
    expect(closes).toBe(0);
  });

  it("leaves the key to the message box while its slash or file suggestions are open, the focus staying in the box beside its list", async () => {
    await mount();
    expect(press({ target: element(null, true) })).toBe(false);
    expect(closes).toBe(0);
    expect(press({ target: element(null, false) })).toBe(true);
    expect(closes).toBe(1);
  });

  it("does nothing while a modal is open over the page, its own confirmation included, wherever the focus is", async () => {
    await mount();
    modalOpen = true;
    expect(press({ target: null })).toBe(false);
    expect(press()).toBe(false);
    expect(closes).toBe(0);
    modalOpen = false;
    press();
    expect(closes).toBe(1);
  });

  it("does nothing for another key, nor where the app offers no close (a watching device, no pane)", async () => {
    await mount();
    expect(press({ key: "c" })).toBe(false);
    expect(closes).toBe(0);
    await act(async () => renderer?.unmount());
    await mount(null);
    expect(() => press()).not.toThrow();
    expect(closes).toBe(0);
  });

  it("closes the open tab with the Close tab binding under the same rules: once per press, never under a dialog or a modal (#3751)", async () => {
    await mount();
    expect(press({ key: "t" })).toBe(true);
    for (let repeat = 0; repeat < 3; repeat++) expect(press({ key: "t", repeat: true })).toBe(true);
    expect(press({ key: "t", target: element("[role='dialog']") })).toBe(false);
    expect(press({ key: "t", target: element(null, true) })).toBe(false);
    modalOpen = true;
    expect(press({ key: "t" })).toBe(false);
    modalOpen = false;
    expect(tabCloses).toBe(1);
    expect(closes).toBe(0);
    await act(async () => renderer?.unmount());
    await mount(undefined, null);
    expect(() => press({ key: "t" })).not.toThrow();
    expect(tabCloses).toBe(1);
  });

  it("is counted as the shortcut way to close a pane, once a press, and not when the key is passed on", async () => {
    const counted: string[] = [];
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Shortcuts, { actions: { closePane: () => { closes += 1; }, closeTab: () => { tabCloses += 1; }, counted: (action, source) => { counted.push(`${action}:${source}`); } } as AppActions }))); });
    press();
    press({ target: element("[role='dialog']") });
    expect(closes).toBe(1);
    expect(counted).toEqual(["close_pane:shortcut"]);
  });

  it("still closes the pane when its count fails", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Shortcuts, { actions: { closePane: () => { closes += 1; }, closeTab: () => { tabCloses += 1; }, counted: () => { throw new Error("storage full"); } } as Partial<AppActions> as AppActions }))); });
      press();
    } finally { logged.mockRestore(); }
    expect(closes).toBe(1);
  });
});
