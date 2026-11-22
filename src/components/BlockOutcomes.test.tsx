import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PcBlockOutcome } from "../../shared/account-devices-api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { BlockOutcomes, NotMeButton } from "./BlockOutcomes.tsx";

const id = "c".repeat(64);
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "d".repeat(32);
const D = "e".repeat(32);
const names = new Map([[A, "Desk"], [B, "Lab"], [C, "Away"], [D, "Old box"]]);

describe("a block's outcome on each PC", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
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

  it("T60, T65: only a PC's own receipt reads blocked; a refusal says why; a PC not reached promises no time", async () => {
    const outcomes: PcBlockOutcome[] = [
      { server_id: A, state: "applied", receipt: { outcome: "applied", id, n: 2 } },
      { server_id: B, state: "refused", receipt: { outcome: "refused", id, reason: "signer_not_older" } },
      { server_id: C, state: "unreachable" },
      { server_id: D, state: "waiting" },
    ];
    await act(async () => { renderer = create(<SettingsProvider><BlockOutcomes outcomes={outcomes} names={names} /></SettingsProvider>); });
    const lines = renderer!.root.findAll((node) => node.type === "li").map(text);
    expect(lines[0]).toBe("Desk: blocked");
    expect(lines[1]).toContain("Lab: not blocked");
    expect(lines.slice(1).every((line) => !line.endsWith(": blocked"))).toBe(true);
    expect(lines[2]).toContain("Away");
    expect(lines[2]).not.toMatch(/\d+ (second|minute)/);
  });

  it("T51: Not me answers once and cannot be pressed again while it is sent", async () => {
    let presses = 0;
    await act(async () => { renderer = create(<SettingsProvider><NotMeButton sending={false} onPress={() => { presses += 1; }} /></SettingsProvider>); });
    await act(async () => { renderer!.root.findByType("button").props.onClick(); });
    expect(presses).toBe(1);
    await act(async () => { renderer!.update(<SettingsProvider><NotMeButton sending onPress={() => { presses += 1; }} /></SettingsProvider>); });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  });
});
