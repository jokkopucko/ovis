import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar } from "./MachineSidebar.tsx";
import { RECHECK_HOLD_MS } from "./MachineOffLine.tsx";

const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
const activity = { seqs: () => new Map<string, number>(), status: () => undefined };
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {}, style: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;
const local = { id: "local", kind: "local", name: "Desk", enabled: true, state: "connected", snapshot: null, error: null, action_required: null, remote_ovis: null } as unknown as Machine;
const relayPc = (patch: Partial<Machine>): Machine =>
  ({ id: "hh", kind: "relay", name: "HostHatch", enabled: true, state: "reconnecting", snapshot: null, error: "The PC did not answer through the relay", action_required: null, remote_ovis: null, ...patch }) as unknown as Machine;

// a PC this server reaches over SSH that refused: Check again asks it now; a relay PC is retried by the server alone
const sshPc = (patch: Partial<Machine>): Machine =>
  ({ id: "hh", kind: "ssh", name: "HostHatch", enabled: true, state: "reconnecting", snapshot: null, error: "ssh: connect to host hh.example port 22: Connection refused", action_required: null, remote_ovis: null, ...patch }) as unknown as Machine;

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  const events = new EventTarget();
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("HTMLElement", class HTMLElement {});
  define("localStorage", storage);
  define("navigator", { languages: ["en-US"], platform: "Linux", userAgent: "test" });
  define("window", { localStorage: storage, sessionStorage: storage, location: { pathname: "/", search: "", hash: "", origin: "http://localhost" }, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: (run: FrameRequestCallback) => { run(0); return 1; }, cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval, clearInterval });
  define("document", { visibilityState: "visible", activeElement: null, querySelectorAll: () => [], body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, getElementById: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const mount = async (machines: Machine[], watching = false) => {
  await act(async () => {
    renderer = create(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines, selectedMachineId: "local", selectedPaneId: null, activity, actions, watching,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    })), { createNodeMock: node });
  });
};
const textOf = (element: ReactTestInstance): string => element.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
const recheckButtons = () => renderer!.root.findAll((element) => element.type === "button" && typeof element.props.className === "string" && element.props.className.includes("machine-recheck"));

it("asks the server to try an off PC now on Check again, once per hold however often it is pressed or drawn again", async () => {
  jest.useFakeTimers();
  const asked: { url: string; method: string | undefined }[] = [];
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ error: { code: "machine_offline", message: "This PC is disconnected" } }), { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  try {
    await mount([local, sshPc({})]);
    const line = renderer!.root.find((element) => element.props.className === "machine-off");
    expect(textOf(line)).toContain("hh.example:22 refused the SSH connection");
    const [button] = recheckButtons();
    expect(textOf(button!)).toBe("Check again");
    await act(async () => { button!.props.onClick(); });
    await act(async () => { recheckButtons()[0]!.props.onClick(); });
    expect(asked).toEqual([{ url: expect.stringContaining("/api/machines/hh/session"), method: undefined }]);
    expect([textOf(recheckButtons()[0]!), recheckButtons()[0]!.props["aria-disabled"]]).toEqual(["Checking…", true]);
    expect(renderer!.root.findAll((element) => element.props.className === "machine-error")).toHaveLength(0);
    await act(async () => renderer?.unmount());
    await mount([local, sshPc({})]);
    await act(async () => { recheckButtons()[0]!.props.onClick(); });
    expect(asked).toHaveLength(1);
    await act(async () => { jest.advanceTimersByTime(RECHECK_HOLD_MS - 1); });
    expect(recheckButtons()[0]!.props["aria-disabled"]).toBe(true);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect([textOf(recheckButtons()[0]!), recheckButtons()[0]!.props["aria-disabled"]]).toEqual(["Check again", undefined]);
    await act(async () => { recheckButtons()[0]!.props.onClick(); });
    expect(asked).toHaveLength(2);
  } finally {
    fetched.mockRestore();
  }
});

it("tells a failed ask on the off row, and drops it for good when the PC answers", async () => {
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ error: { code: "remote_unavailable", message: "Temporary gateway error" } }), { status: 502, headers: { "content-type": "application/json" } })) as typeof fetch);
  const failures = () => renderer!.root.findAll((element) => element.type === "p" && element.props.role === "alert").map(textOf);
  try {
    await mount([local, sshPc({ id: "gw" })]);
    await act(async () => { recheckButtons()[0]!.props.onClick(); });
    expect(failures()).toEqual([expect.stringContaining("Temporary gateway error")]);
    await act(async () => renderer!.update(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines: [local, sshPc({ id: "gw", state: "connected", error: null })], selectedMachineId: "local", selectedPaneId: null, activity, actions,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    }))));
    expect(failures()).toEqual([]);
    await act(async () => renderer!.update(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines: [local, sshPc({ id: "gw" })], selectedMachineId: "local", selectedPaneId: null, activity, actions,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
    }))));
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
    await act(async () => { recheckButtons()[0]!.props.onClick(); });
    await act(async () => { jest.advanceTimersByTime(RECHECK_HOLD_MS); });
    await act(async () => { recheckButtons()[0]!.props.onClick(); });
    await act(async () => { first.resolve(new Response(JSON.stringify({ error: { code: "remote_unavailable", message: "Temporary gateway error" } }), { status: 502, headers: { "content-type": "application/json" } })); });
    expect(calls).toBe(2);
    expect(renderer!.root.findAll((element) => element.type === "p" && element.props.role === "alert")).toHaveLength(0);
  } finally {
    fetched.mockRestore();
  }
});

it("offers no Check again for a connected PC or an off PC of the relay, and to a device that only watches says why without it", async () => {
  await mount([local, relayPc({ state: "connected", error: null })]);
  expect(recheckButtons()).toHaveLength(0);
  await act(async () => renderer?.unmount());
  // the server keeps trying a relay PC by itself: the dot beside its name says it is off, with nothing under it
  await mount([local, relayPc({})]);
  expect(recheckButtons()).toHaveLength(0);
  expect(renderer!.root.findAll((element) => element.props.className === "machine-off")).toHaveLength(0);
  // the relay took the connection and nothing answered in time: it cannot be reached, and may be off, no more
  expect(renderer!.root.find((element) => typeof element.props.className === "string" && element.props.className.startsWith("machine-dot")).props.title).toBe("Can't reach the PC: it may be off");
  expect(textOf(renderer!.root.find((element) => element.props.className === "machine-state visually-hidden"))).toBe("Can't reach the PC: it may be off");
  await act(async () => renderer?.unmount());
  await mount([local, sshPc({})], true);
  expect(recheckButtons()).toHaveLength(0);
  expect(textOf(renderer!.root.find((element) => element.props.className === "machine-off"))).toContain("refused the SSH connection");
});

it("draws a PC this one only watches there as view only: it says so and offers no new workspace", async () => {
  await mount([local, relayPc({ state: "connected", error: null, view_only: true })]);
  const group = renderer!.root.find((element) => element.type === "section" && element.props["aria-label"] === "PC HostHatch");
  expect(textOf(group)).toContain("View only");
  const create = group.find((element) => element.type === "button" && typeof element.props.className === "string" && element.props.className.includes("machine-new"));
  expect(create.props.disabled).toBe(true);
});
