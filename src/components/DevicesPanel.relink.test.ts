import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { PairedDevice } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { DEVICES_CHANGED_EVENT } from "../lib/useRelay.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";

describe("reading the list again after this client's pairing joined the account (#3010)", () => {
  const row = (id: string, label: string): PairedDevice => ({ id, label, role: "drive", created_at: "", last_seen_at: "", current: id === "me" });
  const before = [row("me", "before the link")];
  const after = [row("me", "after the link")];
  let reads: Array<(devices: PairedDevice[]) => void> = [];
  let renderer: ReactTestRenderer | null = null;
  const saved = ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
      setInterval, clearInterval, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    setTransport({ ...nativeTransport, fetch: async (input, init) => {
      if ((init?.method ?? "GET") !== "GET") return Response.json({ error: "rename refused" }, { status: 500 });
      return Response.json({ devices: await new Promise<PairedDevice[]>((resolve) => reads.push(resolve)) });
    } });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    reads = [];
    setTransport(nativeTransport);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    if (languages) Object.defineProperty(navigator, "languages", languages); else Reflect.deleteProperty(navigator, "languages");
  });

  const turns = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
  const mount = async () => {
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(DevicesPanel, { auth: null }) })); });
  };
  const answer = async (read: number, devices: PairedDevice[]) => { await act(async () => { reads[read]!(devices); await turns(); }); };
  const changed = async () => { await act(async () => { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); }); };
  const text = () => JSON.stringify(renderer!.toJSON());

  it("shows a pending Not me only beside its device and keeps local Revoke available", async () => {
    const waiting = { ...row("victim", "Phone"), not_me_waiting: true as const };
    await mount();
    await answer(0, [...before, waiting]);
    expect(text()).toContain("Not me is waiting. Revoke this device to stop its access now.");
    expect(renderer!.root.findAllByProps({ "aria-label": "Revoke Phone" })).toHaveLength(1);
    await changed();
    await answer(1, before);
    expect(text()).not.toContain("Not me is waiting.");
  });

  it("shows the list read after the link, even when the read before it answers last", async () => {
    await mount();
    await changed();
    expect(reads).toHaveLength(2);
    await answer(1, after);
    await answer(0, before);
    expect(text()).toContain("after the link");
    expect(text()).not.toContain("before the link");
  });

  it("keeps a warning on screen through that read", async () => {
    await mount();
    await answer(0, before);
    const rename = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Rename before the link");
    await act(async () => { rename.props.onClick(); });
    const form = renderer!.root.find((node) => node.type === "form");
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); await turns(); });
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);
    const cancel = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Cancel");
    await act(async () => { cancel.props.onClick(); });
    await changed();
    await answer(1, after);
    expect(text()).toContain("after the link");
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);
  });
});
