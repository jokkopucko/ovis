import { expect, test } from "bun:test";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import type { Access } from "./access.ts";
import type { ServerContext } from "./dispatch.ts";
import type { JoinViewer } from "./join-notices.ts";
import { machinePairingEvents } from "./machine-pairing-events.ts";

const PHONE_KEY = "phone-key";
const JOINED_AT = "2026-11-20T00:00:00.000Z";

/** One PC whose registry holds `keys` (device id -> relay key), and the paired events this window's subscription hears. */
function heard(access: Access, peer: ServerContext["peer"], keys: Record<string, string>, waiting: readonly string[] = [], viewer: JoinViewer = { ownWindow: true, since: undefined }) {
  const paired = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  const joinEvent = (deviceId: string): DevicePairedEvent => ({ type: "device-paired", event_id: deviceId, device_id: deviceId, label: "Phone", enrolled_at: JOINED_AT });
  const devices = {
    onPaired: (listener: (event: DevicePairedEvent, origin: readonly string[]) => void) => { paired.add(listener); return () => paired.delete(listener); },
    onRemoved: () => () => {},
    relayKeyOf: (id: string) => keys[id],
    isAccountApproverSession: () => false,
  };
  const listed = new Set<(event: DevicePairedEvent) => void>();
  const joins = { waiting: () => waiting.map((deviceId) => ({ event: joinEvent(deviceId), origin: [] })), onSeen: () => () => {},
    onListed: (listener: (event: DevicePairedEvent) => void) => { listed.add(listener); return () => listed.delete(listener); } };
  const relay = { approvals: { subscribe: () => () => {}, subscribeRemote: () => () => {} } };
  const ctx = { services: { devices, joins, relay, pendingRedemptions: undefined }, peer } as unknown as ServerContext;
  const told: string[] = [];
  machinePairingEvents(ctx, access, [], viewer).subscribe((event) => { if (event.type === "device-paired") told.push(event.device_id); });
  const enroll = (deviceId: string) => { for (const listener of paired) listener(joinEvent(deviceId), []); };
  const admitFromList = (deviceId: string) => { for (const listener of listed) listener(joinEvent(deviceId)); };
  return { told, enroll, admitFromList };
}

test("the joining device's own session is never told of its admission, also through another row of its key; others are", () => {
  const old = { id: "phone-old-row", label: "Phone", role: "drive" as const };
  const phone = heard({ level: "full", via: "relay", role: "drive", device: old },
    { kind: "relay", device: old, sessionId: "s", serverId: "pc", key: PHONE_KEY },
    { "phone-old-row": PHONE_KEY, "phone-new-row": PHONE_KEY, tablet: "tablet-key" });
  phone.enroll("phone-old-row");
  phone.enroll("phone-new-row");
  phone.enroll("tablet");
  expect(phone.told).toEqual(["tablet"]);
});

test("a join waiting on the PC is told to a window as it opens, but never to the joined device nor a window the open LAN let in", () => {
  const waiting = ["phone-new-row"];
  const keys = { "phone-new-row": PHONE_KEY };
  const phoneRow = { id: "phone-new-row", label: "Phone", role: "drive" as const };
  const own = heard({ level: "full", via: "local", role: "drive" }, { kind: "socket" }, keys, waiting);
  const phone = heard({ level: "full", via: "relay", role: "drive", device: phoneRow }, { kind: "relay", device: phoneRow, sessionId: "s", serverId: "pc", key: PHONE_KEY }, keys, waiting, { ownWindow: false, since: "2026-11-19T00:00:00.000Z" });
  const open = heard({ level: "full", via: "open", role: "drive" }, { kind: "socket" }, keys, waiting, { ownWindow: false, since: undefined });
  expect([own.told, phone.told, open.told]).toEqual([["phone-new-row"], [], []]);
});

test("a waiting join is told to this PC's own window and to devices here before it; never to one paired after it, nor a window that is neither", () => {
  const waiting = ["phone-new-row"];
  const keys = { "phone-new-row": PHONE_KEY, older: "older-key", newer: "newer-key" };
  const window = (id: string, since: string) => {
    const device = { id, label: id, role: "drive" as const };
    return heard({ level: "full", via: "relay", role: "drive", device }, { kind: "relay", device, sessionId: id, serverId: "pc", key: keys[id as keyof typeof keys] },
      keys, waiting, { ownWindow: false, since });
  };
  const own = heard({ level: "full", via: "local", role: "drive" }, { kind: "socket" }, keys, waiting, { ownWindow: true, since: undefined });
  const older = window("older", "2026-11-19T00:00:00.000Z");
  const newer = window("newer", "2026-11-21T00:00:00.000Z");
  const tailnet = heard({ level: "full", via: "tailscale", role: "drive", login: "owner@example.com" }, { kind: "socket" }, keys, waiting, { ownWindow: false, since: undefined });
  expect([own.told, older.told, newer.told, tailnet.told]).toEqual([["phone-new-row"], ["phone-new-row"], [], []]);
  // a join that happens while it is open is told live, to the newer device too
  newer.enroll("tablet");
  expect(newer.told).toEqual(["tablet"]);
});

test("this PC's own window hears every join on it, signed in or not; a window the open LAN let in hears none", () => {
  const keys = { "phone-new-row": PHONE_KEY };
  const own = heard({ level: "full", via: "local", role: "drive" }, { kind: "socket" }, keys);
  const token = heard({ level: "full", via: "token", role: "drive" }, { kind: "socket" }, keys);
  const open = heard({ level: "full", via: "open", role: "drive" }, { kind: "socket" }, keys);
  for (const window of [own, token, open]) window.enroll("phone-new-row");
  expect([own.told, token.told, open.told]).toEqual([["phone-new-row"], ["phone-new-row"], []]);
});

test("the devices the account's list let in are told live to this PC's own window alone", () => {
  const keys = { member: "member-key", joined: "joined-key", watcher: "watcher-key" };
  const device = (id: keyof typeof keys, role: "drive" | "watch" = "drive") => {
    const row = { id, label: id, role };
    return heard({ level: "full", via: "relay", role, device: row }, { kind: "relay", device: row, sessionId: id, serverId: "pc", key: keys[id] }, keys, [], { ownWindow: false, since: "2026-11-19T00:00:00.000Z" });
  };
  const own = heard({ level: "full", via: "local", role: "drive" }, { kind: "socket" }, keys);
  const token = heard({ level: "full", via: "token", role: "drive" }, { kind: "socket" }, keys);
  const portal = heard({ level: "full", via: "portal", role: "drive" }, { kind: "socket" }, keys, [], { ownWindow: false, since: undefined });
  const windows = [own, token, device("member"), device("joined"), device("watcher", "watch"), portal];
  for (const window of windows) window.admitFromList("pixel-row");
  expect(windows.map((window) => window.told)).toEqual([["pixel-row"], ["pixel-row"], [], [], [], []]);
});

test("what a device on the relay is told of the waiting joins is asked for again at every telling: one that lost the right is told once that nothing waits, and nothing after", () => {
  const device = { id: "phone-own-pairing", label: "Phone", role: "drive" as const };
  const waiting = [{ id: "join", label: "Tablet", intent: "account", choices: ["111111", "222222", "333333"], expires_at: JOINED_AT, key: "tablet-key" }];
  for (const kind of ["member", "list"] as const) {
    // the right as this PC holds it now: its devices' word for a member, its copy of the list's for a device of the list
    let may = true;
    const remote = new Set<(pairings: typeof waiting) => void>();
    const subscribed = (listener: (pairings: typeof waiting) => void) => { remote.add(listener); listener(waiting); return () => remote.delete(listener); };
    const changed = new Set<() => void>();
    const devices = { onPaired: () => () => {}, onRemoved: () => () => {}, relayKeyOf: () => PHONE_KEY, isAccountApproverSession: () => kind === "member" && may,
      onListedChange: (listener: () => void) => { changed.add(listener); return () => changed.delete(listener); } };
    const joins = { waiting: () => [], onSeen: () => () => {}, onListed: () => () => {} };
    const relay = { approvals: { subscribe: () => () => {}, subscribeRemote: subscribed, subscribeList: subscribed, remoteList: () => waiting, listJoins: () => waiting } };
    const accountList = { allowsJoins: () => kind === "list" && may };
    const ctx = { services: { devices, joins, relay, accountList, pendingRedemptions: undefined }, peer: { kind: "relay", device, sessionId: "s", serverId: "pc", key: PHONE_KEY } } as unknown as ServerContext;
    const told: number[] = [];
    machinePairingEvents(ctx, { level: "full", via: "relay", role: "drive", device }, [], { ownWindow: false, since: undefined })
      .subscribe((event) => { if (event.type === "remote-pairings") told.push(event.pairings.length); });
    expect(told).toEqual([1]);
    // the PC pins a list that holds this key to watch, say: the subscription is older than that
    may = false;
    for (const listener of remote) listener(waiting);
    for (const listener of remote) listener(waiting);
    expect(told).toEqual([1, 0]);
    may = true;
    for (const listener of remote) listener(waiting);
    expect(told).toEqual([1, 0, 1]);
    // the list changes what it lets in while no join comes or goes: the device is told then
    may = false;
    for (const listener of changed) listener();
    for (const listener of changed) listener();
    expect(told).toEqual([1, 0, 1, 0]);
  }
});
