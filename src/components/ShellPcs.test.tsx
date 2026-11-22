import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { shellPcRows, ShellPcs, useShellPcs, type ShellPcsDeps } from "./ShellPcs.tsx";

const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");

describe("the hosted app's other PCs in the sidebar", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: storage, matchMedia,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });
  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("opens each on its own page; one that does not answer reads Off with Check again, which checks that PC alone", async () => {
    const checked: string[] = [];
    const pcs = [{ server_id: "b".repeat(32), name: "Work PC" }, { server_id: "c".repeat(32), name: "HostHatch" }, { server_id: "d".repeat(32), name: null }, { server_id: "e".repeat(32), name: "Laptop" }, { server_id: "f".repeat(32), name: "NAS" }];
    // a re-check of an off PC keeps it off on screen, so Check again stays where the focus is; a relay that turned this device away says nothing of the PC
    const status = new Map<string, PcStatus>([
      ["b".repeat(32), { kind: "answered", route: "relay", rttMs: 40 }],
      ["c".repeat(32), { kind: "checking", previous: { kind: "offline", reason: "pc" } }],
      ["d".repeat(32), { kind: "checking" }],
      ["e".repeat(32), { kind: "offline", reason: "refused" }],
    ]);
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SettingsProvider, { children: createElement(ShellPcs, { pcs, status, recheck: (id: string) => { checked.push(id); } }) })); });
    const rows = root!.root.findAll((node) => node.type === "li");
    expect(rows.map((row) => row.props["data-pc-state"])).toEqual(["on", "off", "checking", "unknown", "unknown"]);
    expect(rows.map((row) => row.find((node) => node.type === "a").props.href)).toEqual([`/s/${"b".repeat(32)}/`, `/s/${"c".repeat(32)}/`, `/s/${"d".repeat(32)}/`, `/s/${"e".repeat(32)}/`, `/s/${"f".repeat(32)}/`]);
    expect(textOf(rows[1]!)).toBe("HostHatchOff·Check again");
    expect(rows[1]!.find((node) => node.type === "button").props["aria-busy"]).toBe(true);
    expect(textOf(rows[2]!)).toBe("Unnamed PC");
    expect(textOf(rows[3]!)).toBe("LaptopCheck again");
    expect(rows[2]!.findAll((node) => node.type === "button")).toHaveLength(0);
    // a PC no check has settled yet (the sweep keeps no finding after a first relay failure) still offers Check again
    expect(textOf(rows[4]!)).toBe("NASCheck again");
    expect(rows[0]!.findAll((node) => node.type === "button")).toHaveLength(0);
    await act(async () => { rows[1]!.find((node) => node.type === "button").props.onClick(); });
    expect(checked).toEqual(["c".repeat(32)]);
  });

  it("draws nothing without another PC", async () => {
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SettingsProvider, { children: createElement(ShellPcs, { pcs: [], status: new Map(), recheck: () => {} }) })); });
    expect(root!.toJSON()).toBeNull();
  });
});

describe("which PCs the hosted app's sidebar lists", () => {
  const keyIdOf = (key: string) => key.startsWith("key-") ? key.slice(4) : null;
  const row = (server_id: string, over: Partial<{ device_id: string | null; server_public_key: string }> = {}) => ({ server_id, device_id: "d", server_public_key: `key-${server_id}`, ...over });

  it("lists this device's finished, keyed pairings, never this page's PC, an unfinished pairing or a key that is not its id", () => {
    const devices = [row("here"), row("work"), row("half", { device_id: null }), row("forged", { server_public_key: "key-other" }), row("laptop")];
    expect(shellPcRows(devices, "here", keyIdOf).map((device) => device.server_id)).toEqual(["work", "laptop"]);
  });
});

describe("the sidebar's list as the page uses it", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: `/s/${"a".repeat(32)}/` } } });
  });
  afterEach(() => {
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    descriptors.clear();
  });

  const fixture = () => {
    const rows = ["a", "b", "c"].map((letter) => ({ server_id: letter.repeat(32), device_id: "d", server_public_key: `key-${letter.repeat(32)}`, name: letter.toUpperCase() }));
    const saved = new Map(rows.map((device) => [device.server_id, device]));
    const calls: string[] = [];
    const deps: ShellPcsDeps = {
      store: { list: async () => [...saved.values()], get: async (id: string) => saved.get(id), remove: async () => {}, update: async () => { throw new Error("not here"); } } as unknown as ShellPcsDeps["store"],
      keyIdOf: (key) => key.slice(4),
      createPcSweep: ((_store: unknown, _view: unknown, options: { pauseOutOfSight?: boolean }) => {
        calls.push(`sweep pause=${options.pauseOutOfSight}`);
        return { status: new Map(), check: async () => { calls.push("check"); }, checkOne: async (id: string) => { calls.push(`checkOne ${id[0]}`); }, stop: () => { calls.push("stop"); } };
      }) as unknown as ShellPcsDeps["createPcSweep"],
    };
    return { saved, calls, load: async () => deps };
  };
  let seen: ReturnType<typeof useShellPcs> | undefined;
  function Probe({ shown, load }: { readonly shown: boolean; readonly load: () => Promise<ShellPcsDeps> }) {
    seen = useShellPcs(true, shown, load);
    return null;
  }
  const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

  it("lists the other PCs, checks them only while in sight, and stops its sweep when the sidebar goes", async () => {
    const { calls, load } = fixture();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(Probe, { shown: false, load })); await settle(); });
    expect(seen!.pcs.map((pc) => pc.name)).toEqual(["B", "C"]);
    expect(calls).toEqual(["sweep pause=true"]);
    await act(async () => { root!.update(createElement(Probe, { shown: true, load })); await settle(); });
    expect(calls).toEqual(["sweep pause=true", "check"]);
    await act(async () => { root!.unmount(); });
    expect(calls.at(-1)).toBe("stop");
  });

  it("drops a PC forgotten in another tab on Check again, and checks one still saved", async () => {
    const { saved, calls, load } = fixture();
    await act(async () => { create(createElement(Probe, { shown: true, load })); await settle(); });
    saved.delete("b".repeat(32));
    await act(async () => { seen!.recheck("b".repeat(32)); await settle(); });
    expect(seen!.pcs.map((pc) => pc.name)).toEqual(["C"]);
    await act(async () => { seen!.recheck("c".repeat(32)); await settle(); });
    expect(calls.filter((call) => call.startsWith("checkOne"))).toEqual(["checkOne c"]);
  });
});
