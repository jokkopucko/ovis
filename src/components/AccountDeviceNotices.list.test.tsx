import { afterEach, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { AccountList, AccountListView } from "../lib/account/accountList.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { DeviceNoticeWire, deviceNotice } from "../lib/deviceNoticeWire.fixture.ts";
import { MachineSession, MachineSessionRegistry } from "../lib/machineSession.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { useAccountDeviceNotices } from "./AccountDeviceNotices.tsx";

const replaced = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  setPageAccountList(null);
  for (const [key, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  replaced.clear();
});

/** A page's list that shows this device following `account`'s list and in it, and signs nothing (no notices of its own). */
function followingList(account: string): AccountList {
  const view: AccountListView = { account, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 1, read_at: 1, trouble: null }, reached: true, devices: [], pcs: [] };
  return {
    sync: async () => view, view: () => view, shown: () => Math.floor(Date.now() / 1000), subscribe: () => () => {}, holdsPc: () => false, pcOfKey: () => null, due: () => null,
    shadow: async () => null, dropNames: async () => {}, forget: async () => {}, pinnedElsewhere: async () => null, adopt: async () => view,
    writer: () => null, holdsEntry: () => false, gossip: () => null, pageAfter: () => null, compare: () => null, takeFromPeer: async () => null, knowsPc: () => false, follows: async () => true, placeAt: () => null,
    kept: async () => null, keep: async () => { throw new Error("nothing is signed in this test"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone",
  };
}

async function drawn(list: AccountList | null): Promise<number> {
  const wire = new DeviceNoticeWire("ws://localhost/ws");
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: class { constructor() { return wire; } },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    if (!replaced.has(key)) replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  setPageAccountList(list);
  const machines: readonly Machine[] = [{ id: LOCAL_MACHINE, name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null }];
  const socket = new HerdrSocket(wire.url);
  const sessions = new MachineSessionRegistry((id) => new MachineSession(id, { socket }));
  sessions.get(LOCAL_MACHINE);
  function Probe() {
    return useAccountDeviceNotices({ machines, machineSessions: sessions, selectedMachineId: LOCAL_MACHINE, pageServerId: "a".repeat(32) });
  }
  await act(async () => { renderer = create(<SettingsProvider><Probe /></SettingsProvider>); });
  socket.connect();
  wire.open();
  await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: deviceNotice({ account: "acct", key: "member-key" }) }); });
  const count = renderer!.root.findAllByProps({ "data-testid": "device-notice" }).length;
  sessions.retainMachines(new Set());
  return count;
}

it("draws a PC's notice of an admission for an account with no list", async () => {
  expect(await drawn(null)).toBe(1);
});

it("draws no PC's notice of an admission for an account whose list this device is in: the list's own notice tells it", async () => {
  expect(await drawn(followingList("acct"))).toBe(0);
});

it("draws a PC's notice of another account's admission as before", async () => {
  expect(await drawn(followingList("acct_other"))).toBe(1);
});
