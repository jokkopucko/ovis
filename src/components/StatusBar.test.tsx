import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { publishBranches } from "../lib/paneBranch.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { StatusBar, type StatusBarProps } from "./StatusBar.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  const events = new EventTarget();
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  define("localStorage", storage);
  define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  define("navigator", { languages: ["en-US"], platform: "Linux" });
  define("window", { location: { protocol: "https:", hostname: "pc.example" }, localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  define("document", { querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  publishBranches("pc", null);
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const base: StatusBarProps = {
  machineId: "pc", workspaceId: "w1", machine: "Laptop", place: "api", path: "/home/me/api", session: null,
  watching: false, waiting: 0, onNextWaiting: null, connection: "live", connectionWord: "Connected",
};
const draw = async (props: Partial<StatusBarProps>) => {
  await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(StatusBar, { ...base, ...props }))); });
  return renderer!.root;
};
const text = (node: { children: unknown[] }): string => node.children.map((child) => typeof child === "string" ? child : text(child as { children: unknown[] })).join("");

it("names the PC, the place, the branch the roster published, and the connection", async () => {
  publishBranches("pc", new Map([["w1", { branch: "feat/x", isDetached: false } as never]]));
  const root = await draw({});
  expect(text(root.findByProps({ className: "machine-context-name" }))).toBe("Laptop");
  expect(text(root.findByType("footer"))).toContain("feat/x");
  expect(root.findByProps({ "data-state": "live" }).props.className).not.toContain("is-lost");
  expect(root.findAllByType("button")).toHaveLength(0);
});

it("offers the next waiting session as a button, inert when there is none to open", async () => {
  let opened = 0;
  const root = await draw({ waiting: 2, onNextWaiting: () => { opened += 1; } });
  const button = root.findByType("button");
  expect(text(button)).toBe("2 waiting for you");
  await act(async () => button.props.onClick());
  expect(opened).toBe(1);
  await act(async () => renderer!.unmount());
  const inert = (await draw({ waiting: 1, onNextWaiting: null })).findByType("button");
  expect(inert.props["aria-disabled"]).toBe(true);
  expect(inert.props.disabled).toBeUndefined();
  await act(async () => inert.props.onClick());
});

it("says View only on a watching device and a lost connection in its own word", async () => {
  const root = await draw({ watching: true, connection: "reconnecting", connectionWord: "Reconnecting…" });
  expect(text(root.findByProps({ className: "status-bar-item status-bar-watch" }))).toBe("View only");
  const conn = root.findByProps({ "data-state": "reconnecting" });
  expect(conn.props.className).toContain("is-lost");
  expect(text(conn)).toBe("Reconnecting…");
});
