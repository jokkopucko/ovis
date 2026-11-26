import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { Machine } from "../../shared/machines.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar } from "./MachineSidebar.tsx";
import { RECHECK_HOLD_MS } from "./MachineOffLine.tsx";

const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
const activity = { seqs: () => new Map<string, number>(), status: () => undefined };
const local = { id: "local", kind: "local", name: "Desk", enabled: true, state: "connected", snapshot: null, error: null, action_required: null, remote_ovis: null } as unknown as Machine;
const relayPc = (patch: Partial<Machine>): Machine =>
  ({ id: "hh", kind: "relay", name: "HostHatch", enabled: true, state: "reconnecting", snapshot: null, error: "The PC did not answer through the relay", action_required: null, remote_ovis: null, ...patch }) as unknown as Machine;

// a PC this server reaches over SSH that refused: Check again asks it now; a relay PC is retried by the server alone
const sshPc = (patch: Partial<Machine>): Machine =>
  ({ id: "hh", kind: "ssh", name: "HostHatch", enabled: true, state: "reconnecting", snapshot: null, error: "ssh: connect to host hh.example port 22: Connection refused", action_required: null, remote_ovis: null, ...patch }) as unknown as Machine;

let page: Page;
let htmlElement: PropertyDescriptor | undefined;
const dimensions = { offsetWidth: 200, offsetHeight: 100 };
const savedDimensions = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  page = openPage();
  Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
  Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "test" });
  Object.defineProperty(page.window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(page.window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: (run: FrameRequestCallback) => { run(0); return 1; } });
  Object.defineProperty(page.window, "cancelAnimationFrame", { configurable: true, value: () => {} });
  for (const [key, value] of Object.entries(dimensions)) {
    savedDimensions.set(key, Object.getOwnPropertyDescriptor(page.window.HTMLElement.prototype, key));
    Object.defineProperty(page.window.HTMLElement.prototype, key, { configurable: true, value });
  }
  htmlElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  for (const [key, descriptor] of savedDimensions) {
    if (descriptor) Object.defineProperty(page.window.HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(page.window.HTMLElement.prototype, key);
  }
  savedDimensions.clear();
  if (htmlElement) Object.defineProperty(globalThis, "HTMLElement", htmlElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

const mount = async (machines: Machine[], watching = false) => {
  await page.render(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines, selectedMachineId: "local", selectedPaneId: null, activity, actions, watching,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    })));
};
const recheckButtons = () => [...page.container.querySelectorAll<HTMLButtonElement>("button.machine-recheck")];

it("asks the server to try an off PC now on Check again, once per hold however often it is pressed or drawn again", async () => {
  jest.useFakeTimers();
  const asked: { url: string; method: string | undefined }[] = [];
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ error: { code: "machine_offline", message: "This PC is disconnected" } }), { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  try {
    await mount([local, sshPc({})]);
    const line = page.one('[class="machine-off"]');
    expect(line.textContent).toContain("hh.example:22 refused the SSH connection");
    const [button] = recheckButtons();
    expect(button?.textContent).toBe("Check again");
    await act(async () => { button!.click(); });
    await act(async () => { recheckButtons()[0]!.click(); });
    expect(asked).toEqual([{ url: expect.stringContaining("/api/machines/hh/session"), method: undefined }]);
    expect([recheckButtons()[0]?.textContent, recheckButtons()[0]!.getAttribute("aria-disabled")]).toEqual(["Checking…", "true"]);
    expect(page.container.querySelectorAll('[class="machine-error"]')).toHaveLength(0);
    await page.render(null);
    await mount([local, sshPc({})]);
    await act(async () => { recheckButtons()[0]!.click(); });
    expect(asked).toHaveLength(1);
    await act(async () => { jest.advanceTimersByTime(RECHECK_HOLD_MS - 1); });
    expect(recheckButtons()[0]!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { jest.advanceTimersByTime(1); });
    expect([recheckButtons()[0]?.textContent, recheckButtons()[0]!.getAttribute("aria-disabled")]).toEqual(["Check again", null]);
    await act(async () => { recheckButtons()[0]!.click(); });
    expect(asked).toHaveLength(2);
  } finally {
    fetched.mockRestore();
  }
});

it("tells a failed ask on the off row, and drops it for good when the PC answers", async () => {
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ error: { code: "remote_unavailable", message: "Temporary gateway error" } }), { status: 502, headers: { "content-type": "application/json" } })) as typeof fetch);
  const failures = () => [...page.container.querySelectorAll('p[role="alert"]')].map((node) => node.textContent);
  try {
    await mount([local, sshPc({ id: "gw" })]);
    await act(async () => { recheckButtons()[0]!.click(); });
    expect(failures()).toEqual([expect.stringContaining("Temporary gateway error")]);
    await page.render(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines: [local, sshPc({ id: "gw", state: "connected", error: null })], selectedMachineId: "local", selectedPaneId: null, activity, actions,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    })));
    expect(failures()).toEqual([]);
    await page.render(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines: [local, sshPc({ id: "gw" })], selectedMachineId: "local", selectedPaneId: null, activity, actions,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    })));
    expect(failures()).toEqual([]);
  } finally {
    fetched.mockRestore();
  }
});

it("says nothing of an earlier ask that fails after a later one", async () => {
  jest.useFakeTimers();
  const first = Promise.withResolvers<Response>();
  let calls = 0;
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls++;
    return calls === 1 ? first.promise : new Response(JSON.stringify({ error: { code: "machine_offline", message: "This PC is disconnected" } }), { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  try {
    await mount([local, sshPc({ id: "late" })]);
    await act(async () => { recheckButtons()[0]!.click(); });
    await act(async () => { jest.advanceTimersByTime(RECHECK_HOLD_MS); });
    await act(async () => { recheckButtons()[0]!.click(); });
    await act(async () => { first.resolve(new Response(JSON.stringify({ error: { code: "remote_unavailable", message: "Temporary gateway error" } }), { status: 502, headers: { "content-type": "application/json" } })); });
    expect(calls).toBe(2);
    expect(page.container.querySelectorAll('p[role="alert"]')).toHaveLength(0);
  } finally {
    fetched.mockRestore();
  }
});

it("offers no Check again for a connected PC or an off PC of the relay, and to a device that only watches says why without it", async () => {
  await mount([local, relayPc({ state: "connected", error: null })]);
  expect(recheckButtons()).toHaveLength(0);
  await page.render(null);
  // the server keeps trying a relay PC by itself: the dot beside its name says it is off, with nothing under it
  await mount([local, relayPc({})]);
  expect(recheckButtons()).toHaveLength(0);
  expect(page.container.querySelectorAll('[class="machine-off"]')).toHaveLength(0);
  // the relay took the connection and nothing answered in time: it cannot be reached, and may be off, no more
  expect(page.one('[class^="machine-dot"]').getAttribute("title")).toBe("Can't reach the PC: it may be off");
  expect(page.one('[class="machine-state visually-hidden"]').textContent).toBe("Can't reach the PC: it may be off");
  await page.render(null);
  await mount([local, sshPc({})], true);
  expect(recheckButtons()).toHaveLength(0);
  expect(page.one('[class="machine-off"]').textContent).toContain("refused the SSH connection");
});

it("draws a PC this one only watches there as view only: it says so and offers no new workspace", async () => {
  await mount([local, relayPc({ state: "connected", error: null, view_only: true })]);
  const group = page.one('section[aria-label="PC HostHatch"]');
  expect(group.textContent).toContain("View only");
  const create = group.querySelector<HTMLButtonElement>("button.machine-new");
  expect(create?.disabled).toBe(true);
});
