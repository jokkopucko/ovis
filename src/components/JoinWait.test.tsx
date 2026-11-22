import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { ItsMeButton, JoinWait } from "./JoinWait.tsx";

const NOW = Date.parse("2026-11-20T04:00:00.000Z");

describe("the new device's wait", () => {
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
    jest.useRealTimers();
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (element: React.ReactElement) => {
    await act(async () => { renderer = create(<SettingsProvider>{element}</SettingsProvider>); });
    return renderer!.toJSON() === null ? "" : text(renderer!.root);
  };

  it("T53: counts down to the PC's own deadline, in whole seconds", async () => {
    expect(await mount(<JoinWait pc="Desk" hold={{ reason: "join_hold", until: "2026-11-20T04:00:07.400Z" }} now={NOW} />)).toContain("8");
  });

  it("T53: the live wait changes seconds without a fresh refusal from the PC", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const hold = { reason: "join_hold", until: "2026-11-20T04:00:07.400Z" } as const;
    expect(await mount(<JoinWait pc="Desk" hold={hold} />)).toContain("8");
    await act(async () => { jest.advanceTimersByTime(1000); });
    if (renderer === undefined) throw new TypeError("Missing wait");
    expect(text(renderer.root)).toContain("7");
  });

  it("T53: a hold with no deadline shows no countdown", async () => {
    expect(await mount(<JoinWait pc="Desk" hold={{ reason: "catching_up" }} now={NOW} />)).not.toMatch(/\d/);
  });

  it("P17: before the PC has told the other devices, it says so and shows no number", async () => {
    const shown = await mount(<JoinWait pc="Desk" hold={{ reason: "join_hold", until: null }} now={NOW} />);
    expect(shown).toContain("telling your other devices");
    expect(shown).not.toMatch(/\d/);
  });

  it("T67: a PC that holds nothing shows no wait", async () => {
    expect(await mount(<JoinWait pc="Desk" hold={undefined} now={NOW} />)).toBe("");
  });

  it("T53/T67: dismissal leaves the same hold hidden without answering, and a new reason shows", async () => {
    const onPress = mock();
    const screen = (wait: React.ReactElement) => <SettingsProvider>{wait}<ItsMeButton sending={false} onPress={onPress} /></SettingsProvider>;
    const hold = { reason: "join_hold", until: null } as const;
    await act(async () => { renderer = create(screen(<JoinWait pc="Desk" hold={hold} now={NOW} />)); });
    const view = renderer;
    if (view === undefined) throw new Error("No wait rendered");
    const dismiss = view.root.find((node) => node.type === "button" && node.props["aria-label"] === "Dismiss");
    await act(async () => { dismiss.props.onClick(); });
    expect(view.root.findAllByProps({ role: "status" })).toEqual([]);
    expect(onPress).not.toHaveBeenCalled();
    await act(async () => { view.update(screen(<JoinWait pc="Desk" hold={{ ...hold, until: "2026-11-20T04:00:07.400Z" }} now={NOW + 1000} />)); });
    expect(view.root.findAllByProps({ role: "status" })).toEqual([]);
    await act(async () => { view.update(screen(<JoinWait pc="Desk" hold={{ reason: "catching_up" }} now={NOW} />)); });
    expect(text(view.root.findByProps({ role: "status" }))).toContain("checking your account");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("T53: It's me is one press, held while it goes to each PC", async () => {
    let presses = 0;
    await mount(<ItsMeButton sending={false} onPress={() => { presses += 1; }} />);
    await act(async () => { renderer!.root.findByType("button").props.onClick(); });
    expect(presses).toBe(1);
    await act(async () => { renderer!.update(<SettingsProvider><ItsMeButton sending onPress={() => {}} /></SettingsProvider>); });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  });
});
