import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AccountListView } from "./accountList.ts";
import { keepShadow, readShadowRecord, shadowOf } from "./listShadow.ts";
import { memoryListStore } from "./listStore.ts";
import type { DirectoryPc } from "./service.ts";

const ACCOUNT = "acct_owner";
const id = (n: number): string => n.toString(16).padStart(32, "0");
const listed = (n: number, seen = true): DirectoryPc =>
  ({ server_id: id(n), label: `Secret name ${n}`, added_at: "2026-11-24T00:00:00.000Z", last_seen_at: seen ? "2026-11-24T00:00:00.000Z" : null, public_key: null, relay: null, new_until: null, admitted_at: null, admitted_before_you: false });
const following = (pcs: readonly number[], standing: "in" | "out" = "in"): AccountListView => ({
  account: ACCOUNT, reached: true, devices: [],
  status: { at: "following", list: "5c".repeat(32), standing, head: 7, read_at: 1, trouble: null },
  pcs: pcs.map((n) => ({ endpoint: n.toString(16).padStart(64, "0"), server_id: id(n), how: "added" as const, allows: true, name: { label: `Secret name ${n}`, os: null }, seq: n, by: null, new_at: null })),
});

const info = spyOn(console, "info").mockImplementation(() => {});
afterEach(() => info.mockClear());

describe("what the list and the account service's directory differ in", () => {
  it("compares nothing for a device that follows no list or is not in it", () => {
    const off: AccountListView = { account: ACCOUNT, reached: true, status: { at: "off" }, devices: [], pcs: [] };
    expect(shadowOf(off, [listed(1)], 5)).toBeNull();
    expect(shadowOf({ ...off, status: { at: "not_in", list: "5c".repeat(32), why: "not_mine", claim: "claimed" } }, [listed(1)], 5)).toBeNull();
    expect(shadowOf(following([1], "out"), [listed(1)], 5)).toBeNull();
  });

  it("names the PCs only one of the two has, by id, with what the directory row would do today", () => {
    const shadow = shadowOf(following([1, 2, 3]), [listed(2), listed(3), listed(4), listed(5, false)], 99, new Set([id(4)]));
    expect(shadow).toEqual({
      at: 99, head: 7, both: 2,
      service_only: [{ server_id: id(4), seen: true, opens: true }, { server_id: id(5), seen: false, opens: false }],
      list_only: [id(1)],
    });
  });

  it("counts every comparison and each one that differed, and reads its record back strictly", async () => {
    const store = memoryListStore();
    await keepShadow(store, ACCOUNT, shadowOf(following([1]), [listed(1)], 1)!);
    await keepShadow(store, ACCOUNT, shadowOf(following([1]), [listed(1), listed(2)], 2)!);
    const record = await keepShadow(store, ACCOUNT, shadowOf(following([1]), [listed(1), listed(2)], 3)!);
    expect([record.compared, record.differed, record.last.at]).toEqual([3, 2, 3]);
    expect(readShadowRecord(await store.get("shadow", ACCOUNT))).toEqual(record);
    expect(readShadowRecord({ v: 1, compared: 1, differed: 2, last: record.last })).toBeNull();
    expect(readShadowRecord({ v: 2, compared: 3, differed: 2, last: record.last })).toBeNull();
    expect(readShadowRecord({ v: 1, compared: 3, differed: 2, last: { ...record.last, list_only: ["not an id"] } })).toBeNull();
  });

  it("says so once when the difference changes, in counts alone: no name, id or key is logged", async () => {
    const store = memoryListStore();
    const agree = shadowOf(following([1]), [listed(1)], 1)!;
    const differ = shadowOf(following([1]), [listed(1), listed(2)], 2, new Set([id(2)]))!;
    await keepShadow(store, ACCOUNT, agree);
    expect(info).toHaveBeenCalledTimes(0);
    await keepShadow(store, ACCOUNT, differ);
    await keepShadow(store, ACCOUNT, { ...differ, at: 3 });
    expect(info).toHaveBeenCalledTimes(1);
    await keepShadow(store, ACCOUNT, { ...agree, at: 4 });
    expect(info).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(info.mock.calls);
    expect(info.mock.calls[0]).toEqual(["Ovis: the account's list and the account service's directory", "differ", { both: 1, service_only: 1, service_only_opening: 1, list_only: 0 }]);
    for (const secret of ["Secret name", id(1), id(2), "5c5c"]) expect(logged).not.toContain(secret);
  });
});
