import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";

import type { SessionSnapshot } from "../shared/protocol.ts";
import { App } from "./App.tsx";
import { indexedAccountStore } from "./lib/account/store.ts";
import { DeviceNoticeWire, NOTICE_SNAPSHOT } from "./lib/deviceNoticeWire.fixture.ts";
import { openPage, type Page } from "./lib/page.fixture.ts";
import { CRAMPED_QUERY } from "./lib/paneCanvas.ts";
import { PHONE_INBOX_STORAGE_KEY, SettingsProvider } from "./lib/settings.ts";
import { SHEET_QUERY } from "./lib/sheets.ts";
import { storeSelection } from "./lib/useSplitView.ts";

const snapshot: SessionSnapshot = {
  ...NOTICE_SNAPSHOT,
  workspaces: [{ workspace_id: "w1", label: "Test workspace", active_tab_id: "t1", number: 1, tab_count: 1, pane_count: 1, focused: true, agent_status: "idle", worktree: null }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "Test tab", number: 1, pane_count: 1, focused: true, agent_status: "idle" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", terminal_id: "term", revision: 1, focused: true, agent_status: "idle", restore_error: "No test terminal" }],
};

let page: Page;
beforeEach(() => { page = openPage("http://localhost:4880/"); });
afterEach(async () => { await page.close(); });

async function withPhoneMore(check: (page: Page, dismissKeyboard: () => Promise<void>) => Promise<void>): Promise<void> {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const { window } = page;
  window.localStorage.setItem(PHONE_INBOX_STORAGE_KEY, "false");
  const cramped = Object.assign(new EventTarget(), { matches: true });
  const matchMedia = (query: string) => query === CRAMPED_QUERY ? cramped : Object.assign(new EventTarget(), { matches: query === SHEET_QUERY });
  Object.defineProperties(window, {
    matchMedia: { configurable: true, value: matchMedia },
    innerWidth: { configurable: true, value: 390 },
    innerHeight: { configurable: true, value: 610 },
  });
  Object.defineProperty(window.document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Linux" });
  install("localStorage", window.localStorage);
  install("sessionStorage", window.sessionStorage);
  install("location", window.location);
  install("history", window.history);
  install("HTMLElement", window.HTMLElement);
  install("Element", window.Element);
  install("Node", window.Node);
  install("requestAnimationFrame", window.requestAnimationFrame.bind(window));
  install("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));
  install("MutationObserver", class { observe() {} disconnect() {} });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("WebSocket", DeviceNoticeWire);
  install("EventSource", class extends EventTarget { close() {} });
  install("__HERDR_TEST_HOOKS__", false);
  const account = spyOn(indexedAccountStore, "get").mockResolvedValue(undefined);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), window.location.href);
    if (pathname === "/api/health") return Response.json({ auth: { required: false, authenticated: true, role: "drive" }, herdr: { version: "0.9.5", protocol: 22 } });
    if (pathname === "/api/machines") return Response.json({ machines: [
      { id: "local", name: "Test PC", kind: "local", enabled: true, state: "connected", error: null, snapshot },
    ] });
    return new Response(null, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    storeSelection("local", "p1");
    await page.render(<SettingsProvider><App /></SettingsProvider>);
    await act(async () => { page.one<HTMLButtonElement>('button[class="icon-button header-more-button"]').click(); });
    const dismissKeyboard = async (): Promise<void> => {
      await act(async () => { cramped.matches = false; cramped.dispatchEvent(new Event("change")); });
      // Let App read the action provider again after PaneCanvas has rendered at the new height.
      await page.render(<SettingsProvider><App /></SettingsProvider>);
    };
    await check(page, dismissKeyboard);
  } finally {
    await page.render(null);
    account.mockRestore();
    fetch.mockRestore();
    for (const [key, previous] of originals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

it.each([
  ["rename-tab", "group", "Rename tab · Test tab"],
  ["close-tab", "group", "Close tab Test tab?"],
  ["rename-tab", "more", "Rename tab · Test tab"],
] as const)("runs %s after the tab row comes back with %s open (#4392)", async (command, open, title) => {
  await withPhoneMore(async (page, dismissKeyboard) => {
    const press = (id: string) => act(async () => {
      const items = page.window.document.body.querySelectorAll(`button[data-item="${id}"]`);
      const [item] = items;
      if (items.length !== 1 || !(item instanceof page.window.HTMLButtonElement)) throw new Error(`Expected one menu item ${id}, found ${items.length}`);
      item.click();
    });
    const tabRow = () => page.container.querySelectorAll('[role="tablist"][aria-label="Tabs of Test workspace"]');
    expect(tabRow()).toHaveLength(0);
    if (open === "group") await press("pane-group");
    await dismissKeyboard();
    expect(tabRow()).toHaveLength(1);
    if (open === "more") await press("pane-group");
    await press(command);
    expect([...page.window.document.body.querySelectorAll("h2")].map((heading) => heading.textContent)).toContain(title);
  });
});
