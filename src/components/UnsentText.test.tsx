import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { UnsentTextDialog } = await import("./UnsentText.tsx");

describe("UnsentTextDialog", () => {
  let renderer: ReactTestRenderer | undefined;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; }, clear: () => values.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class HTMLElement {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "http://ovis.test/" }, localStorage: storage, matchMedia, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setTimeout, clearTimeout } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, activeElement: null, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), body: {} } });
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

  it("renders the selected PC, workspace, and pane before recovery", async () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1", label: "  chat  ", title: "Pi" } as HerdrPane;
    const machine: Machine = { id: "target-pc", name: "Build PC", kind: "local", enabled: true, state: "connected", error: null, snapshot: { protocol: 22, version: "test", workspaces: [{ workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false }], panes: [pane], tabs: [], agents: [], layouts: [] } };
    localStorage.setItem("ovis:unsent:test", JSON.stringify({ id: "test", machine_id: "old-pc", pane_id: "old:p1", pane_title: "old", kind: "message", text: "draft", at: 1 }));
    await act(async () => {
      renderer = create(<SettingsProvider><UnsentTextDialog machines={[machine]} target={{ machineId: "target-pc", pane }} canRecover onRecover={() => true} onClose={() => undefined} /></SettingsProvider>);
    });
    const output = JSON.stringify(renderer?.toJSON());
    expect(output).toContain("Build PC · release · chat");
    expect(output).toContain("Put in message box adds this text to Build PC · release · chat");
  });

  it("does not point to a message box when the pane has none", async () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1", label: "shell", title: "zsh" } as HerdrPane;
    const machine: Machine = { id: "target-pc", name: "Build PC", kind: "local", enabled: true, state: "connected", error: null, snapshot: { protocol: 22, version: "test", workspaces: [{ workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false }], panes: [pane], tabs: [], agents: [], layouts: [] } };
    localStorage.setItem("ovis:unsent:test", JSON.stringify({ id: "test", machine_id: "old-pc", pane_id: "old:p1", pane_title: "old", kind: "line", text: "draft", at: 1 }));
    await act(async () => {
      renderer = create(<SettingsProvider><UnsentTextDialog machines={[machine]} target={{ machineId: "target-pc", pane }} canRecover={false} onRecover={() => true} onClose={() => undefined} /></SettingsProvider>);
    });
    const lead = renderer?.root.findByProps({ className: "unsent-lead" });
    const item = renderer?.root.findByProps({ className: "unsent-item" });
    expect(item?.findByProps({ className: "unsent-text" }).children).toEqual(["draft"]);
    const actions = item?.findAllByType("button").map((button) => button.children.join(""));
    expect(actions).toEqual(["Copy", "Discard"]);
    expect(lead?.children.join("")).not.toMatch(/message box/i);
    expect(lead?.children.join("")).toContain("Nothing here is sent.");
  });
});
