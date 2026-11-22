import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { AlertWebhookView } from "../../shared/alert-webhook.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AlertWebhookGroup } from "./AlertWebhookGroup.tsx";


const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let held: AlertWebhookView;
let puts: unknown[];
let refuse: boolean;

beforeEach(() => {
  puts = [];
  refuse = false;
  held = { configured: true, preset: "ntfy", target: "https://ntfy.sh/…pic", chat_id: null, alerts: { input: false, done: "long" }, reachable_link: true, last_success_at: null, last_failure_at: null, last_error: null };
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    history: { state: null, replaceState() {} },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null,
  } });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
    if (path !== "/api/alerts/webhook") return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    if ((init?.method ?? "GET") === "GET") return Response.json(held);
    puts.push(JSON.parse(String(init?.body)));
    if (refuse) return Response.json({ error: { code: "webhook_failed", message: "the destination answered 500" } }, { status: 500 });
    held = { ...held, alerts: (JSON.parse(String(init?.body)) as { alerts: AlertWebhookView["alerts"] }).alerts };
    return Response.json(held);
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

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });

async function open(): Promise<{ switchOf: (name: string) => ReactTestInstance; text: () => string }> {
  await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(AlertWebhookGroup))); });
  await settle();
  const root = renderer!.root;
  return {
    switchOf: (name) => root.findAll((node) => node.type === "button" && node.props["role"] === "switch" && node.props["aria-label"] === name)[0]!,
    text: () => JSON.stringify(renderer!.toJSON()),
  };
}

describe("a saved destination's alert switch", () => {
  it("keeps a choice the server took", async () => {
    const view = await open();
    expect(view.switchOf("Needs input").props["aria-checked"]).toBe(false);
    await act(async () => { view.switchOf("Needs input").props.onClick(); });
    await settle();
    expect(puts).toEqual([{ preset: "ntfy", alerts: { input: true, done: "long" } }]);
    expect(view.switchOf("Needs input").props["aria-checked"]).toBe(true);
    expect(view.text()).toContain("Saved on this PC");
  });

  it("goes back to the value the server holds when it refuses the save, and says why (G-010)", async () => {
    refuse = true;
    const view = await open();
    await act(async () => { view.switchOf("Needs input").props.onClick(); });
    await settle();
    expect(puts).toHaveLength(1);
    expect(view.switchOf("Needs input").props["aria-checked"]).toBe(false);
    expect(view.text()).toContain("the destination answered 500");
    expect(view.text()).not.toContain("Saved on this PC");
    expect(view.text()).toContain("\"role\":\"alert\"");
  });
});
