import { afterEach, expect, it } from "bun:test";
import { MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { RelayTransport } from "./transport.ts";
import { createUpdateFlow, loadObservedVersions, observedVersions } from "./updateFlow.ts";
import type { Attempt, RelayShellState } from "./shellState.ts";
import { getTransport, nativeTransport, setTransport } from "../transport.ts";
import { isValidElement, type ReactNode } from "react";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { forgetSavedPc, mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { observedVersionOf, type RelayDevice, type RelayDeviceStore, type SavedDevice } from "./device.ts";

const storageKeys = ["localStorage", "sessionStorage"] as const;
const descriptors = [...storageKeys, "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
afterEach(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  setTransport(nativeTransport);
});

/** Both web storages, as the page sees them; the returned maps are what each holds. */
function webStorage(): { readonly local: Map<string, string>; readonly session: Map<string, string> } {
  const local = new Map<string, string>(), session = new Map<string, string>();
  for (const [key, values] of [["localStorage", local], ["sessionStorage", session]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); },
      removeItem: (name: string) => { values.delete(name); },
    } });
  }
  return { local, session };
}

function memoryStore(devices: Map<string, RelayDevice>): RelayDeviceStore {
  return {
    get: async (id) => devices.get(id), list: async () => [...devices.values()],
    remove: async (id) => { devices.delete(id); },
    update: async (id, change) => { const next = change(devices.get(id)); devices.set(id, next); return next; },
  };
}

async function savedDevice(serverId: string): Promise<RelayDevice> {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { server_id: serverId, server_public_key: "unused", relay: "wss://relay.ovis.sh", device_id: "paired", private_key: key.privateKey, public_spki: "fixture", label: "Phone" };
}

it("keeps a PC's admitted version in its saved record across a reload, never in web storage", async () => {
  const storage = webStorage();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: "unused", relay: "wss://relay.ovis.sh" };
  const devices = new Map([[offer.server_id, await savedDevice(offer.server_id)]]);
  const store = memoryStore(devices);
  class Admitted extends RelayTransport {
    version = "0.0.1";
    override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const opened = new Admitted(offer);
  const states: RelayShellState[] = [];
  const flow = createUpdateFlow("1.0.0", {
    show: (state) => states.push(state), accepted() {}, reload: async () => {},
    failed: async (error) => { throw error; },
  }, store);
  const attempt: Attempt = { offer, code: false, paired: true };
  try {
    await flow.admit(opened, attempt);
    expect(observedVersions().get(offer.server_id)).toEqual({ version: "0.0.1", outdated: true });
    expect(states.at(-1)).toMatchObject({ kind: "outdated", update: { phase: "manual" } });
    // a reload starts with nothing in memory and reads the saved records
    await loadObservedVersions(memoryStore(new Map()));
    expect(observedVersions().size).toBe(0);
    await loadObservedVersions(store);
    expect(observedVersions().get(offer.server_id)).toEqual({ version: "0.0.1", outdated: true });
    opened.version = "1.0.0";
    await flow.admit(opened, attempt);
    await loadObservedVersions(store);
    expect(observedVersions().get(offer.server_id)).toEqual({ version: "1.0.0", outdated: false });
    expect([...storage.local, ...storage.session]).toEqual([]);
  } finally { flow.cancel(); opened.close(); }
});

it("moves an old web-storage version record into the saved PCs once and deletes it", async () => {
  const storage = webStorage();
  const saved = "12".repeat(16), unsaved = "ab".repeat(16);
  const legacy = JSON.stringify([[saved, { version: "0.0.1", outdated: true }], [unsaved, { version: "0.0.2", outdated: true }]]);
  storage.local.set("ovis-relay-versions", legacy);
  storage.session.set("ovis-relay-versions", legacy);
  const devices = new Map([[saved, await savedDevice(saved)]]);
  await loadObservedVersions(memoryStore(devices));
  expect([...storage.local, ...storage.session]).toEqual([]);
  const record = devices.get(saved);
  expect(record && observedVersionOf(record)).toEqual({ version: "0.0.1", outdated: true });
  expect([...observedVersions()]).toEqual([[saved, { version: "0.0.1", outdated: true }]]);
});

it("deletes an old version record it cannot read", async () => {
  const storage = webStorage();
  storage.local.set("ovis-relay-versions", "{not json");
  storage.session.set("ovis-relay-versions", "[]");
  const session = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")?.value;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { ...session, getItem: () => { throw new DOMException("denied", "SecurityError"); } } });
  await loadObservedVersions(memoryStore(new Map()));
  expect([...storage.local, ...storage.session]).toEqual([]);
  expect(observedVersions().size).toBe(0);
});

it("never installs after cancellation while an update-status read was pending", async () => {
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: "unused", relay: "wss://relay.ovis.sh" };
  const held = Promise.withResolvers<Response>();
  const reading = Promise.withResolvers<void>();
  let reads = 0;
  const writes: string[] = [];
  class Admitted extends RelayTransport {
    override get server() { return { version: "0.0.1", relayProtocol: RELAY_PROTOCOL }; }
    override async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.method === "POST") { writes.push(String(input)); return Response.json({}); }
      if (++reads === 1) return Response.json({ managed: true });
      reading.resolve();
      return held.promise;
    }
  }
  const opened = new Admitted(offer);
  const states: RelayShellState[] = [];
  const flow = createUpdateFlow("1.0.0", { show: (state) => states.push(state), accepted() {}, reload: async () => {}, failed: async (error) => { throw error; } }, memoryStore(new Map()));
  try {
    await flow.admit(opened, { offer, paired: true, code: false });
    flow.update();
    await reading.promise;
    flow.cancel();
    const count = states.length;
    held.resolve(Response.json({ managed: true, available: true, latest_revision: "new" }));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(writes).toEqual([]);
    expect(states).toHaveLength(count);
  } finally { flow.cancel(); opened.close(); }
});

it.each([["pc-outdated", "0.0.1"], ["server-newer", "2.0.0"]] as const)("drops a %s admission cancelled while its version was being saved", async (_skew, version) => {
  webStorage();
  // the tab's reload memory lives in window.sessionStorage
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: "unused", relay: "wss://relay.ovis.sh" };
  const devices = new Map([[offer.server_id, await savedDevice(offer.server_id)]]);
  const store = memoryStore(devices);
  const writing = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const slow: RelayDeviceStore = { ...store, update: async (id, change) => { writing.resolve(); await held.promise; return store.update(id, change); } };
  class Admitted extends RelayTransport {
    override get server() { return { version, relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const opened = new Admitted(offer);
  const effects: string[] = [];
  const flow = createUpdateFlow("1.0.0", {
    show: (state) => effects.push(state.kind), accepted: () => effects.push("accepted"),
    reload: async () => { effects.push("reload"); }, failed: async (error) => { throw error; },
  }, slow);
  try {
    const admitted = flow.admit(opened, { offer, code: false, paired: true });
    await writing.promise;
    flow.cancel();
    held.resolve();
    await admitted;
    expect(effects).toEqual([]);
    expect(getTransport()).toBe(nativeTransport);
  } finally { flow.cancel(); opened.close(); }
});

/** Captures the actual controller/view boundary; transports below supply only PC responses. */
function shellFixture() {
  const browser = createShellTestPage();
  const devices = new Map<string, RelayDevice>();
  const pair = generateKeyPair();
  const offer = { v: 1 as const, server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey), relay: "wss://relay.ovis.sh" };
  let shown: RelayShellProps | undefined;
  let apps = 0;
  const mount: RelayShellMount = {
    container: document.documentElement, entryUrl: encodeOffer(offer, "https://app.ovis.sh"), shellVersion: "1.0.0", label: "Phone",
    accountService: null, pendingPush: { get: async () => undefined, clear: async () => {} },
    store: {
      get: async (id) => devices.get(id), list: async () => [...devices.values()],
      remove: async (id) => { devices.delete(id); },
      update: async (id, change) => { const next = change(devices.get(id)); devices.set(id, next); return next; },
    },
    renderApp: () => { apps++; return { render() {}, unmount() {} }; },
    createRoot: () => ({ render(node: ReactNode) {
      let element = node;
      while (isValidElement<{ children: ReactNode }>(element) && element.type !== RelayShell) element = element.props.children;
      if (!isValidElement<RelayShellProps>(element) || element.type !== RelayShell) throw new Error("Expected the relay shell view");
      shown = element.props;
    }, unmount() {} }),
  };
  return { browser, offer, mount, devices, apps: () => apps, view: () => {
    if (shown === undefined) throw new Error("The shell has not rendered");
    return shown;
  } };
}

it.each(["retry", "disconnect"] as const)("enters the PC once %s gets past a fresh outdated admission, with no Ready checkpoint", async (recovery) => {
  const fixture = shellFixture();
  class Admitted extends RelayTransport {
    version = "0.0.1";
    override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const first = new Admitted(fixture.offer), next = new Admitted(fixture.offer);
  next.version = "1.0.0";
  let attempts = 0;
  let fatal: ((error: Error) => void) | undefined;
  try {
    await mountRelayShell({ ...fixture.mount, open: async (_offer, options) => { fatal = options?.onFatal; return ++attempts === 1 ? first : next; } });
    fixture.view().onPair();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(fixture.view().state).toMatchObject({ kind: "outdated", update: { phase: "manual" } });
    if (recovery === "disconnect") fatal?.(new MuxProtocolError("timeout", "fixture disconnected"));
    fixture.view().onRetry();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(fixture.apps()).toBe(1);
    expect(fixture.view().state.kind).not.toBe("ready");
    fatal?.(new MuxProtocolError("timeout", "fixture disconnected"));
    fixture.view().onRetry();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(fixture.apps()).toBe(2);
  } finally { first.close(); next.close(); fixture.browser.dispose(); }
});

it.each(["settings", "shell"] as const)("clears only the forgotten PC's admitted version through %s", async (path) => {
  const fixture = shellFixture();
  const otherId = "ab".repeat(16);
  class Outdated extends RelayTransport {
    override get server() { return { version: "0.0.1", relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const opened = new Outdated(fixture.offer);
  try {
    const other: SavedDevice = { ...await savedDevice(otherId), observed_version: { version: "0.0.2", outdated: true } };
    fixture.devices.set(otherId, other);
    fixture.devices.set(fixture.offer.server_id, { ...await savedDevice(fixture.offer.server_id), ...fixture.offer });
    await mountRelayShell({ ...fixture.mount, entryUrl: `https://app.ovis.sh/s/${fixture.offer.server_id}/`, open: async () => opened });
    expect(observedVersions().has(fixture.offer.server_id)).toBe(true);
    switch (path) {
      case "settings": await forgetSavedPc(fixture.offer.server_id, fixture.mount.store); break;
      case "shell":
        fixture.view().onForget();
        for (let i = 0; i < 500; i++) await Promise.resolve();
        expect(fixture.view().state.kind).toBe("forgotten");
        break;
    }
    expect(fixture.devices.has(fixture.offer.server_id)).toBe(false);
    expect(observedVersions().has(fixture.offer.server_id)).toBe(false);
    expect(observedVersions().get(otherId)).toEqual({ version: "0.0.2", outdated: true });
    const kept = fixture.devices.get(otherId);
    expect(kept && observedVersionOf(kept)).toEqual({ version: "0.0.2", outdated: true });
  } finally { opened.close(); fixture.browser.dispose(); }
});
