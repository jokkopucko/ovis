import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { listView } from "../../shared/account-list.ts";
import { moved } from "../lib/account/listMigrate.test-helpers.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the notice and the confirmation are portals into document.body: drawn in place here, so the test renderer holds them
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { ListMoveNotices } = await import("./ListMoveNotice.tsx");

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

/** Lets the work a press started run until `done`, for ten seconds at most. */
async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("what the press started did not end");
    await Bun.sleep(25);
    // what settled meanwhile is drawn
    await act(async () => {});
  }
}

beforeEach(() => {
  const events = new EventTarget();
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  class HTMLElement { isConnected = true; focus(): void {} }
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true, HTMLElement, matchMedia,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      location: { href: "https://app.example/", search: "", origin: "https://app.example", pathname: "/", protocol: "https:" },
      history: { state: null, replaceState() {}, pushState() {} }, matchMedia, innerWidth: 1440, innerHeight: 900,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    },
    document: {
      visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: new HTMLElement(), body: { nodeType: 1, children: [] },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    },
  };
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

it("Not me on a device the move carried in asks the devices list's Remove with everything ticked, and signs its removal", async () => {
  const { phone, laptop, world } = await moved();
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(ListMoveNotices, { list: phone.device.list }) }), {
      createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
    });
  });
  const root = renderer!.root;
  await waitFor(() => root.findAll((node) => node.props["data-testid"] === "list-move-notice").length > 0);
  const row = root.findAll((node) => node.type === "li" && textOf(node).startsWith("Laptop"));
  expect(row).toHaveLength(1);
  await act(async () => { row[0]!.find((node) => node.type === "button" && textOf(node) === "Not me").props.onClick(); });
  const dialog = () => root.find((node) => node.props.role === "alertdialog" && textOf(node).includes("Remove Laptop from your account?"));
  expect(dialog().findAll((node) => node.type === "input" && node.props.type === "checkbox").every((box) => box.props.checked === true)).toBe(true);
  await act(async () => { dialog().find((node) => node.type === "button" && textOf(node) === "Remove").props.onClick(); });
  await waitFor(() => root.findAll((node) => node.props.role === "alertdialog" && textOf(node).includes("Remove Laptop")).length === 0);
  expect(listView(world.held().state).devices.find((device) => device.key === laptop.signIn)?.ended).not.toBeNull();
});
