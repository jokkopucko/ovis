import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";

import type { AppActions } from "./actions.ts";
import { SettingsProvider } from "./settings.ts";
import { useShortcuts } from "./shortcuts.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("the Close pane shortcut", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let closes: number;
  let tabCloses: number;
  let modal: ReturnType<Page["window"]["document"]["createElement"]>;

  beforeEach(() => {
    page = openPage();
    closes = 0;
    tabCloses = 0;
    modal = page.window.document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    page.window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { "close-pane": "ctrl+alt+x", "close-tab": "ctrl+alt+t" } }));
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    for (const [key, value] of Object.entries({ localStorage: page.window.localStorage })) {
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
  });

  function Shortcuts({ actions }: { actions: AppActions }) {
    useShortcuts(actions, true);
    return null;
  }
  async function mount(closePane: AppActions["closePane"] = () => { closes += 1; }, closeTab: AppActions["closeTab"] = () => { tabCloses += 1; }): Promise<void> {
    await page.render(createElement(SettingsProvider, null, createElement(Shortcuts, { actions: { closePane, closeTab } as AppActions })));
  }
  async function press({ repeat = false, owner, expanded = false, terminal = false, targetOnWindow = false, key = "x" }: {
    repeat?: boolean; owner?: string; expanded?: boolean; terminal?: boolean; targetOnWindow?: boolean; key?: string;
  } = {}): Promise<boolean> {
    const wrapper = page.window.document.createElement("div");
    const field = page.window.document.createElement("textarea");
    if (owner) wrapper.setAttribute("role", owner);
    if (expanded) field.setAttribute("aria-expanded", "true");
    if (terminal) field.className = "xterm-helper-textarea";
    wrapper.append(field);
    page.window.document.body.append(wrapper);
    const event = new page.window.KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: true, repeat, bubbles: true, cancelable: true });
    try {
      await act(async () => { (targetOnWindow ? page.window : field).dispatchEvent(event); });
      return event.defaultPrevented;
    } finally { wrapper.remove(); }
  }

  it("closes the selected pane once per press, from the terminal or the message box", async () => {
    await mount();
    expect(await press({ terminal: true })).toBe(true);
    expect(await press()).toBe(true);
    expect(closes).toBe(2);
  });

  it("closes one pane for a held key: its repeats are taken and close nothing", async () => {
    await mount();
    await press();
    for (let repeat = 0; repeat < 5; repeat++) expect(await press({ repeat: true })).toBe(true);
    expect(closes).toBe(1);
  });

  it.each(["[role='alertdialog']", "[role='dialog']", "[role='menu']", "[role='listbox']"])("leaves the key to a %s that has the focus", async (owner) => {
    await mount();
    expect(await press({ owner: owner.slice(7, -2) })).toBe(false);
    expect(await press({ owner: owner.slice(7, -2), repeat: true })).toBe(false);
    expect(closes).toBe(0);
  });

  it("leaves the key to the message box while its slash or file suggestions are open, the focus staying in the box beside its list", async () => {
    await mount();
    expect(await press({ expanded: true })).toBe(false);
    expect(closes).toBe(0);
    expect(await press({ expanded: false })).toBe(true);
    expect(closes).toBe(1);
  });

  it("does nothing while a modal is open over the page, its own confirmation included, wherever the focus is", async () => {
    await mount();
    page.window.document.body.append(modal);
    expect(await press({ targetOnWindow: true })).toBe(false);
    expect(await press()).toBe(false);
    expect(closes).toBe(0);
    modal.remove();
    await press();
    expect(closes).toBe(1);
  });

  it("does nothing for another key, nor where the app offers no close (a watching device, no pane)", async () => {
    await mount();
    expect(await press({ key: "c" })).toBe(false);
    expect(closes).toBe(0);
    await page.render(null);
    await mount(null);
    await expect(press().then(() => undefined)).resolves.toBeUndefined();
    expect(closes).toBe(0);
  });

  it("closes the open tab with the Close tab binding under the same rules: once per press, never under a dialog or a modal (#3751)", async () => {
    await mount();
    expect(await press({ key: "t" })).toBe(true);
    for (let repeat = 0; repeat < 3; repeat++) expect(await press({ key: "t", repeat: true })).toBe(true);
    expect(await press({ key: "t", owner: "dialog" })).toBe(false);
    expect(await press({ key: "t", expanded: true })).toBe(false);
    page.window.document.body.append(modal);
    expect(await press({ key: "t" })).toBe(false);
    modal.remove();
    expect(tabCloses).toBe(1);
    expect(closes).toBe(0);
    await page.render(null);
    await mount(undefined, null);
    await expect(press({ key: "t" }).then(() => undefined)).resolves.toBeUndefined();
    expect(tabCloses).toBe(1);
  });

  it("is counted as the shortcut way to close a pane, once a press, and not when the key is passed on", async () => {
    const counted: string[] = [];
    await page.render(createElement(SettingsProvider, null, createElement(Shortcuts, { actions: { closePane: () => { closes += 1; }, closeTab: () => { tabCloses += 1; }, counted: (action, source) => { counted.push(`${action}:${source}`); } } as AppActions })));
    await press();
    await press({ owner: "dialog" });
    expect(closes).toBe(1);
    expect(counted).toEqual(["close_pane:shortcut"]);
  });

  it("still closes the pane when its count fails", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await page.render(createElement(SettingsProvider, null, createElement(Shortcuts, { actions: { closePane: () => { closes += 1; }, closeTab: () => { tabCloses += 1; }, counted: () => { throw new Error("storage full"); } } as Partial<AppActions> as AppActions })));
      await press();
    } finally { logged.mockRestore(); }
    expect(closes).toBe(1);
  });
});
