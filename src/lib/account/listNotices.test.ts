import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { signListEntry } from "../../../shared/account-list.ts";
import { listWorld } from "./accountList.test-helpers.ts";
import { deviceListKeys } from "./listKeys.ts";
import { closeNotice, closeStoredNotice, listNewcomers, readNoticesSeen, writeNoticesSeen, type ListNewcomer } from "./listNotices.ts";
import { memoryAccountStore } from "./store.ts";

describe("what the device notices have shown", () => {
  let descriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const kept = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } } });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("keeps a record per account and list, and reads none for another list", () => {
    writeNoticesSeen("acct_a", { list: "aa".repeat(32), member: "me", floor: 3, closed: ["k"] });
    writeNoticesSeen("acct_b", { list: "bb".repeat(32), member: "me", floor: 1, closed: [] });
    expect(readNoticesSeen("acct_a", "aa".repeat(32), "me")).toEqual({ list: "aa".repeat(32), member: "me", floor: 3, closed: ["k"] });
    expect(readNoticesSeen("acct_a", "cc".repeat(32), "me")).toBeNull();
    expect(readNoticesSeen("acct_c", "aa".repeat(32), "me")).toBeNull();
  });

  it("moves its floor up once every notice shown is closed, and keeps the closed ones until then", () => {
    const shown: ListNewcomer[] = [{ key: "k1", seq: 4, by: "a" }, { key: "k2", seq: 6, by: "a" }];
    const one = closeNotice({ list: "l", member: "me", floor: 2, closed: [] }, shown, "k2");
    expect(one).toEqual({ list: "l", member: "me", floor: 2, closed: ["k2"] });
    expect(closeNotice(one, shown, "k1")).toEqual({ list: "l", member: "me", floor: 6, closed: [] });
  });

  it("keeps closed a notice above the floor that a later close moves up to: a redraw that no longer shows it does not bring it back", () => {
    const shown: ListNewcomer[] = [{ key: "k1", seq: 4, by: "a" }, { key: "k2", seq: 6, by: "a" }];
    const one = closeNotice({ list: "l", member: "me", floor: 2, closed: [] }, shown, "k2");
    // drawn again: the closed notice is no longer among those shown
    const two = closeNotice(one, shown.filter((newcomer) => !one.closed.includes(newcomer.key)), "k1");
    expect(two).toEqual({ list: "l", member: "me", floor: 4, closed: ["k2"] });
  });

  it("keeps both of two notices two tabs closed from the same record", () => {
    const shown: ListNewcomer[] = [{ key: "x", seq: 4, by: "a" }, { key: "y", seq: 5, by: "a" }, { key: "z", seq: 6, by: "a" }];
    writeNoticesSeen("acct", { list: "l", member: "me", floor: 2, closed: [] });
    // each tab closes from what it read when it drew, and the store is read again as each writes
    closeStoredNotice("acct", "l", "me", shown, "x");
    closeStoredNotice("acct", "l", "me", shown, "y");
    expect(readNoticesSeen("acct", "l", "me")).toEqual({ list: "l", member: "me", floor: 2, closed: ["x", "y"] });
  });

  it("reads no record kept for another member of the same list: a device with a new key looks for the first time", () => {
    writeNoticesSeen("acct", { list: "l", member: "old key", floor: 9, closed: [] });
    expect(readNoticesSeen("acct", "l", "new key")).toBeNull();
  });

  it("N03: a device carried into the list from before it is no news, whatever the floor", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const keys = await phone.keys();
    const tablet = await deviceListKeys(memoryAccountStore());
    // carried in right after entry 0, signed here and never placed: the kinds' state is all this reads
    const carried = await signListEntry(w.held().state, { kind: "carried", key: tablet.key, role: "drive", sealed: null }, { key: keys.key, privateKey: keys.signs }, Math.floor(w.clock.now / 1000));
    expect(carried.state.devices[tablet.key]?.carried).toBe(true);
    expect(listNewcomers(carried.state, keys.key, { list: carried.state.list, member: keys.key, floor: 0, closed: [] })).toEqual([]);
  });
});
