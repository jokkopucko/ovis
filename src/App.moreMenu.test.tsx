import { expect, it, spyOn } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionSnapshot } from "../shared/protocol.ts";
import { App } from "./App.tsx";
import { indexedAccountStore } from "./lib/account/store.ts";
import { DeviceNoticeWire, NOTICE_SNAPSHOT } from "./lib/deviceNoticeWire.fixture.ts";
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

async function withPhoneMore(check: (tree: ReactTestRenderer, dismissKeyboard: () => Promise<void>) => Promise<void>): Promise<void> {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const values = new Map([[PHONE_INBOX_STORAGE_KEY, "false"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const location = new URL("http://localhost:4880/");
  const history = { replaceState() {}, pushState() {} };
  const cramped = Object.assign(new EventTarget(), { matches: true });
  const matchMedia = (query: string) => query === CRAMPED_QUERY ? cramped : Object.assign(new EventTarget(), { matches: query === SHEET_QUERY });
  const style = { setProperty() {}, removeProperty() {} };
  const body = { nodeType: 1, children: [], dataset: {}, style, classList: { toggle() {} }, createNodeMock: () => null };
  install("window", Object.assign(new EventTarget(), { location, history, matchMedia, localStorage: storage, sessionStorage: storage,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, innerWidth: 390, innerHeight: 610,
  }));
  install("document", Object.assign(new EventTarget(), { body, visibilityState: "visible", activeElement: null,
    documentElement: { dataset: {}, style, classList: { toggle() {} }, hasAttribute: () => false },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hasFocus: () => true,
  }));
  install("navigator", { language: "en-US", languages: ["en-US"], platform: "Linux", onLine: true });
  install("localStorage", storage);
  install("sessionStorage", storage);
  install("location", location);
  install("history", history);
  install("HTMLElement", class {});
  install("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  install("MutationObserver", class { observe() {} disconnect() {} });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("WebSocket", DeviceNoticeWire);
  install("EventSource", class extends EventTarget { close() {} });
  install("__HERDR_TEST_HOOKS__", false);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const account = spyOn(indexedAccountStore, "get").mockResolvedValue(undefined);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), location);
    if (pathname === "/api/health") return Response.json({ auth: { required: false, authenticated: true, role: "drive" }, herdr: { version: "0.9.5", protocol: 22 } });
    if (pathname === "/api/machines") return Response.json({ machines: [
      { id: "local", name: "Test PC", kind: "local", enabled: true, state: "connected", error: null, snapshot },
    ] });
    return new Response(null, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect }));
  let tree: ReactTestRenderer | undefined;
  try {
    storeSelection("local", "p1");
    await act(async () => { tree = create(<SettingsProvider><App /></SettingsProvider>); });
    if (!tree) throw new TypeError("App did not mount");
    const more = tree.root.find((node) => node.type === "button" && node.props.className === "icon-button header-more-button");
    const anchor = { isConnected: true, closest: () => null, focus() {} };
    await act(async () => more.props.onClick({ currentTarget: anchor }));
    const dismissKeyboard = async (): Promise<void> => {
      await act(async () => { cramped.matches = false; cramped.dispatchEvent(new Event("change")); });
      // Let App read the action provider again after PaneCanvas has rendered at the new height.
      await act(async () => tree?.update(<SettingsProvider><App /></SettingsProvider>));
    };
    await check(tree, dismissKeyboard);
  } finally {
    await act(async () => tree?.unmount());
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
  await withPhoneMore(async (tree, dismissKeyboard) => {
    const press = (id: string) => act(async () => tree.root.findByProps({ "data-item": id }).props.onClick());
    const tabRow = () => tree.root.findAllByProps({ role: "tablist", "aria-label": "Tabs of Test workspace" });
    expect(tabRow()).toHaveLength(0);
    if (open === "group") await press("pane-group");
    await dismissKeyboard();
    expect(tabRow()).toHaveLength(1);
    if (open === "more") await press("pane-group");
    await press(command);
    expect(tree.root.findAllByType("h2").map((heading) => heading.children.join(""))).toContain(title);
  });
});
