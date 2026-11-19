import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar } from "./MachineSidebar.tsx";

const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
const activity = { seqs: () => new Map<string, number>(), status: () => undefined };
// the test renderer draws no DOM: a node stands in for every element its refs read
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {}, style: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;
/** a PC that answered, whose roster has not come yet (server/machines-refresh.contract.test.ts's slow fixture) */
const connectedNoRoster = (id: string, kind: Machine["kind"], name: string): Machine =>
  ({ id, kind, name, state: "connected", snapshot: null, error: null, action_required: null, remote_ovis: null }) as unknown as Machine;

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
  // a frame comes at once: the loading words are filled one frame after their region (lib/useAnnouncedText.ts)
  define("window", { localStorage: storage, sessionStorage: storage, location: { pathname: "/", search: "", hash: "" }, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: (run: FrameRequestCallback) => { run(0); return 1; }, cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval, clearInterval });
  define("document", { visibilityState: "visible", activeElement: null, querySelectorAll: () => [], body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, getElementById: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

const loadingWords = (): number => renderer!.root.findAll((element) => element.props.role === "status" && element.children.includes("Loading workspaces…")).length;

it("says a connected PC's roster is loading until it comes, for a lone Host and for each of two PCs", async () => {
  for (const machines of [[connectedNoRoster("local", "local", "Laptop")], [connectedNoRoster("local", "local", "Laptop"), connectedNoRoster("work", "ssh", "Work")]]) {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(MachineSidebar, {
        machines, selectedMachineId: "local", selectedPaneId: null, activity, actions,
        onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {},
      })), { createNodeMock: node });
    });
    expect(loadingWords()).toBe(machines.length);
    await act(async () => renderer?.unmount());
    renderer = undefined;
  }
});
