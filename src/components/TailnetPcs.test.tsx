import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { TailnetPcs } from "./TailnetPcs.tsx";

// Connect a device → PCs on your Tailscale: the PCs this PC's server found, one tap each to add through the relay.
describe("PCs on your Tailscale", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { method: string; path: string; body: unknown }[];
  let found: { name: string; url: string; relay: string | null }[];

  beforeEach(() => {
    requests = [];
    found = [{ name: "lab", url: "https://lab.tail.ts.net", relay: "online" }, { name: "nas", url: "https://nas.tail.ts.net", relay: "off" }];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
      const method = init?.method ?? "GET";
      requests.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (path === "/api/machines/tailnet" && method === "GET") return Response.json({ pcs: found });
      if (path === "/api/machines/tailnet") return Response.json({ machine: { id: "m1", name: "lab", kind: "relay" } }, { status: 201 });
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async () => {
    await act(async () => { renderer = create(<SettingsProvider><TailnetPcs /></SettingsProvider>); });
  };
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const addButton = (name: string) => renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === `Add ${name} through the relay`);

  it("adds a found PC with one tap and takes it off the list", async () => {
    await mount();
    expect(addButton("nas").props.disabled).toBe(true);
    await act(async () => { addButton("lab").props.onClick(); });
    expect(requests.at(-1)).toEqual({ method: "POST", path: "/api/machines/tailnet", body: { url: "https://lab.tail.ts.net" } });
    expect(text(renderer!.root.find((node) => node.props.role === "status"))).toContain("lab was added");
    expect(renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Add lab through the relay")).toHaveLength(0);
  });

  it("shows nothing when no PC was found", async () => {
    found = [];
    await mount();
    expect(renderer!.toJSON()).toBeNull();
  });
});
