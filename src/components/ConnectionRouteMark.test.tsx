import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { ObservedIngress } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ConnectionRouteMark } from "./ConnectionRouteMark.tsx";

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
  define("window", { location: { protocol: "https:", hostname: "pc.tail1e211e.ts.net" }, localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  define("document", { querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const routeShown = () => renderer!.root.findByProps({ className: "conn-route" }).props["data-route"] as string;
const draw = (ingress: ObservedIngress | null) => createElement(SettingsProvider, null, createElement(ConnectionRouteMark, { portal: false, ingress }));

it("keeps the server's word on the route through a failed health read, which clears it", async () => {
  // Given a page the server saw come through Funnel.
  await act(async () => { renderer = create(draw("funnel")); });
  expect(routeShown()).toBe("direct");
  // When a health read fails and the facts are gone.
  await act(async () => { renderer!.update(draw(null)); });
  // Then the mark still says what the server said, not what the name alone suggests.
  expect(routeShown()).toBe("direct");
});
