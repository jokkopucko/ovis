import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { RelayOnlyWarning } from "./RelayOnlyWarning.tsx";

describe("the relay-only warning", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    const stored = new Map<string, string>();
    const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");

  it("T70: a PC whose account opens every PC says to keep SSH or a screen, since one stolen older device could lock it", async () => {
    await act(async () => { renderer = create(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>); });
    const shown = text(renderer!.root);
    expect(shown).toContain("SSH");
    expect(shown).toContain("older device");
  });

  it("T70: the warning's only action dismisses the line", async () => {
    await act(async () => { renderer = create(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>); });
    const view = renderer;
    if (view === undefined) throw new Error("No relay warning rendered");
    const dismiss = view.root.find((node) => node.type === "button" && node.props["aria-label"] === "Dismiss");
    expect(view.root.findAllByType("button")).toEqual([dismiss]);
    await act(async () => { dismiss.props.onClick(); });
    expect(view.toJSON()).toBeNull();
  });

  it("T70: once dismissed on this device it stays dismissed when the setup screen is opened again", async () => {
    await act(async () => { renderer = create(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>); });
    const dismiss = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Dismiss");
    await act(async () => { dismiss.props.onClick(); });
    await act(async () => { renderer!.unmount(); });
    await act(async () => { renderer = create(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("T70: says nothing on a PC that other devices also reach without the relay", async () => {
    await act(async () => { renderer = create(<SettingsProvider><RelayOnlyWarning opensAll relayOnly={false} /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("G5: says nothing on a PC with the release off", async () => {
    await act(async () => { renderer = create(<SettingsProvider><RelayOnlyWarning opensAll={false} relayOnly /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
  });
});
