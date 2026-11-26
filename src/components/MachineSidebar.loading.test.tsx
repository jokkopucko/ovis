import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { Machine } from "../../shared/machines.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar } from "./MachineSidebar.tsx";

const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
const activity = { seqs: () => new Map<string, number>(), status: () => undefined };
const connectedNoRoster = (id: string, kind: Machine["kind"], name: string): Machine =>
  ({ id, kind, name, state: "connected", snapshot: null, error: null, action_required: null, remote_ovis: null }) as unknown as Machine;

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let page: Page;

beforeEach(() => {
  page = openPage();
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
  Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "test" });
  Object.defineProperty(page.window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(page.window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: (run: FrameRequestCallback) => { run(0); return 1; } });
  Object.defineProperty(page.window, "cancelAnimationFrame", { configurable: true, value: () => {} });
  Object.defineProperty(page.window.HTMLElement.prototype, "offsetWidth", { configurable: true, value: 200 });
  Object.defineProperty(page.window.HTMLElement.prototype, "offsetHeight", { configurable: true, value: 100 });
  for (const [key, value] of Object.entries({ localStorage: page.window.localStorage, HTMLElement: page.window.HTMLElement })) {
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

const loadingWords = (): number => [...page.container.querySelectorAll('[role="status"]')].filter((element) => element.textContent === "Loading workspaces…").length;

it("says a connected PC's roster is loading until it comes, for a lone Host and for each of two PCs", async () => {
  for (const machines of [[connectedNoRoster("local", "local", "Laptop")], [connectedNoRoster("local", "local", "Laptop"), connectedNoRoster("work", "ssh", "Work")]]) {
    await page.render(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines, selectedMachineId: "local", selectedPaneId: null, activity, actions,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    })));
    expect(loadingWords()).toBe(machines.length);
    await page.render(null);
  }
});

it("counts its Settings gear as a button, and opens Settings even when the count fails", async () => {
  for (const failing of [false, true]) {
    const told: string[] = [];
    const opened: string[] = [];
    const counting = new Proxy({}, { get: (_, name) => name === "counted" ? (action: string, source: string) => { if (failing) throw new Error("storage full"); told.push(`${action}:${source}`); }
      : name === "openSettings" ? () => opened.push("settings") : () => {} }) as AppActions;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await page.render(createElement(SettingsProvider, null, createElement(MachineSidebar, {
        machines: [connectedNoRoster("local", "local", "Laptop")], selectedMachineId: "local", selectedPaneId: null, activity, actions: counting,
        onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
      })));
      const gear = page.one("button.sidebar-footer-settings");
      await act(async () => { gear.click(); });
    } finally { logged.mockRestore(); }
    expect([told, opened]).toEqual([failing ? [] : ["settings:button"], ["settings"]]);
    await page.render(null);
  }
});

it("draws Inbox beside the Settings gear, which opens the inbox and shows the sessions waiting as its badge", async () => {
  for (const inbox of [{ waiting: 3 }, { waiting: 0 }, null]) {
    const opened: string[] = [];
    await page.render(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines: [connectedNoRoster("local", "local", "Laptop")], selectedMachineId: "local", selectedPaneId: null, activity, actions,
      inbox: inbox === null ? null : { waiting: inbox.waiting, open: () => opened.push("inbox") },
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    })));
    const row = page.one('div[class="sidebar-footer-row"]');
    const buttons = [...row.querySelectorAll("button")].map((found) => found.className);
    const entry = row.querySelector<HTMLButtonElement>("button.sidebar-footer-inbox");
    if (inbox === null) {
      expect(entry).toBeNull();
    } else {
      expect(buttons.findIndex((name) => name.includes("sidebar-footer-inbox"))).toBe(buttons.findIndex((name) => name.includes("sidebar-footer-settings")) + 1);
      expect([entry!.getAttribute("type"), entry!.title, entry!.getAttribute("aria-label")]).toEqual(["button", "Inbox", inbox.waiting > 0 ? "Inbox · 3 waiting for you" : "Inbox"]);
      expect([...entry!.querySelectorAll('[class="header-more-dot is-waiting"]')].map((found) => found.getAttribute("data-count"))).toEqual(inbox.waiting > 0 ? ["3"] : []);
      await act(async () => { entry!.click(); });
      expect(opened).toEqual(["inbox"]);
    }
    await page.render(null);
  }
});
