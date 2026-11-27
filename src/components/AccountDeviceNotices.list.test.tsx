import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { AccountList, AccountListView } from "../lib/account/accountList.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { DeviceNoticeWire, deviceNotice } from "../lib/deviceNoticeWire.fixture.ts";
import { MachineSession, MachineSessionRegistry } from "../lib/machineSession.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { useAccountDeviceNotices } from "./AccountDeviceNotices.tsx";

let page: Page;
let socketDescriptor: PropertyDescriptor | undefined;
afterEach(async () => {
  await page.close();
  setPageAccountList(null);
  if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
  else Reflect.deleteProperty(globalThis, "WebSocket");
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
  page = openPage();
  Object.defineProperty(page.window.document, "hasFocus", { configurable: true, value: () => true });
  socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class { constructor() { return wire; } } });
  setPageAccountList(list);
  const machines: readonly Machine[] = [{ id: LOCAL_MACHINE, name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null }];
  const socket = new HerdrSocket(wire.url);
  const sessions = new MachineSessionRegistry((id) => new MachineSession(id, { socket }));
  sessions.get(LOCAL_MACHINE);
  function Probe() {
    return useAccountDeviceNotices({ machines, machineSessions: sessions, selectedMachineId: LOCAL_MACHINE, pageServerId: "a".repeat(32) });
  }
  await page.render(<SettingsProvider><Probe /></SettingsProvider>);
  socket.connect();
  wire.open();
  await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: deviceNotice({ account: "acct", key: "member-key" }) }); });
  const count = page.container.querySelectorAll('[data-testid="device-notice"]').length;
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
