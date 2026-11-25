import { describe, expect, it } from "bun:test";
import type { AccountListView, ListedPc } from "./accountList.ts";
import { accountList } from "./accountList.ts";
import { addListPc, listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import { NEW_LIST_PC_MS, listReading, pcsByList, postedFor } from "./listPcs.ts";
import { memoryListLock } from "./listStore.ts";
import { myPcs } from "./myPcs.ts";
import type { DirectoryPc } from "./service.ts";
import { accountOpenablePcs } from "../relay/pcPick.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { ListState } from "../../../shared/account-list.ts";

type World = ReturnType<typeof listWorld>;

/** A second device of the account that a person let in from the first. */
async function letIn(w: World, first: WorldDevice): Promise<WorldDevice> {
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const outcome = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, { wait: async () => {} });
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  await second.list.adopt(outcome.offer);
  return second;
}

const row = (pc: { server_id: string; endpoint: string }, given: Partial<DirectoryPc> = {}): DirectoryPc => ({
  server_id: pc.server_id, label: "What the service calls it", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: "2026-11-24T00:00:00.000Z",
  public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false, ...given,
});

describe("the PCs of a list, as a device that follows it holds them", () => {
  it("says where each PC came in and who signed for it, and from when a PC that somebody else added is new to this device", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const desk = await addListPc(w, first, "Desk");
    const second = await letIn(w, first);
    const laptop = await addListPc(w, first, "Laptop");
    w.clock.now += 60_000;
    const seenAt = Math.floor(w.clock.now / 1000);
    const firstKey = (await first.keys()).key;
    const pick = (pcs: readonly ListedPc[]) => pcs.map(({ endpoint, seq, by, new_at }) => ({ endpoint, seq, by, new_at }));
    // the PC that was in before the second device is not new to it; the one added since, by another device, is
    expect(pick((await second.list.sync()).pcs)).toEqual([
      { endpoint: desk.endpoint, seq: 1, by: firstKey, new_at: null },
      { endpoint: laptop.endpoint, seq: 3, by: firstKey, new_at: seenAt },
    ]);
    // nothing is new to the device that signed for it
    expect(pick((await first.list.sync()).pcs).map((pc) => pc.new_at)).toEqual([null, null]);
    // the time is when this device first held the entry, and it stays: a later read and a page loaded again say the same
    w.clock.now += 3_600_000;
    expect(pick((await second.list.sync()).pcs)[1]!.new_at).toBe(seenAt);
    const again = accountList({ service: second.service, accountStore: second.store, listStore: second.lists, lock: memoryListLock(), now: () => w.clock.now, names: () => ({ label: "Dana's tablet", os: "android" }), linkedPcs: async () => 0 });
    expect(pick((await again.sync()).pcs)[1]!.new_at).toBe(seenAt);
    // forgetting the list forgets that too
    await again.forget(w.account);
    expect(await second.lists.get("seen", w.account)).toBeUndefined();
  });
});

describe("My PCs of an account with a signed list", () => {
  const NOW = 1_795_000_000_000;
  const pc = (n: number, given: Partial<ListedPc> = {}): ListedPc => ({
    endpoint: n.toString(16).padStart(2, "0").repeat(32), server_id: deriveServerId(new Uint8Array(32).fill(n)), how: "added", allows: true,
    name: { label: `PC ${n}`, os: "linux" }, seq: n, by: "device-key", new_at: null, ...given,
  });
  const view = (pcs: readonly ListedPc[], given: Partial<AccountListView> = {}): AccountListView => ({
    account: "acct", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 9, read_at: 1, trouble: null },
    devices: [{ key: "device-key", self: false, power: "full", role: "drive", until: null, carried: false, name: { label: "Dana's phone", os: "ios" } }, { key: "own-key", self: true, power: "full", role: "drive", until: null, carried: false, name: null }],
    pcs, ...given,
  });

  it("marks a PC the move carried in with no key of its own, and no other", () => {
    const rows = pcsByList(view([pc(1, { how: "carried", allows: false }), pc(2, { how: "carried", allows: true }), pc(3, { how: "joined", allows: false })]), "acct", [row(pc(1)), row(pc(2)), row(pc(3))], NOW)!;
    expect(rows.map((one) => one.needs_keys ?? false)).toEqual([true, false, false]);
  });

  it("is the account service's directory as it is for a device that is in no list", () => {
    const directory = [row(pc(1))];
    for (const status of [
      { at: "off" }, { at: "none", why: "not_new" }, { at: "not_in", list: "5c".repeat(32), why: "not_mine", claim: "claimed" },
      { at: "following", list: "5c".repeat(32), standing: "out", head: 9, read_at: 1, trouble: null }, { at: "following", list: "5c".repeat(32), standing: "waiting", head: 9, read_at: 1, trouble: null },
    ] as const) {
      expect([pcsByList(view([pc(1)], { status }), "acct", directory, NOW), listReading(view([pc(1)], { status }), "acct")]).toEqual([null, null]);
    }
    // the list in view is another account's
    expect([pcsByList(view([pc(1)]), "another", directory, NOW), listReading(view([pc(1)]), "another")]).toEqual([null, null]);
    expect(listReading(view([pc(1)]), "acct")).toBe("in");
  });

  it("keeps every PC of the directory on the screen where this device cannot read its list, each marked, and says which kind of trouble it is", () => {
    const directory = [row(pc(1), { new_until: new Date(NOW + 3_600_000).toISOString() }), row(pc(2))];
    for (const [status, reading] of [
      [{ at: "damaged", why: "sum" }, "damaged"], [{ at: "newer_save" }, "newer"],
      [{ at: "following", list: "5c".repeat(32), standing: "stopped", head: 9, read_at: 1, trouble: "needs_newer_client" }, "newer"],
    ] as const) {
      const rows = pcsByList(view([], { status }), "acct", directory, NOW)!;
      expect(listReading(view([], { status }), "acct")).toBe(reading);
      // the directory's rows as they are, its names and its new window too, each marked as not in the list
      expect(rows).toEqual(directory.map((each) => ({ ...each, not_in_list: true })));
      // and none of them opens by itself
      expect(accountOpenablePcs(myPcs(rows, [], { now: NOW + 86_400_000, registered: true }), { account: "acct", devices: [], now: NOW + 86_400_000 })).toEqual([]);
    }
  });

  it("lists the PCs the list holds under the names the list seals, and takes from the directory only how to reach them", () => {
    const [desk, laptop, unreached, lied] = [pc(1), pc(2, { name: null }), pc(3), pc(4)];
    const stranger = pc(9);
    const rows = pcsByList(view([desk, laptop, unreached, lied]), "acct", [
      row(desk, { new_until: new Date(NOW + 3_600_000).toISOString(), admitted_at: new Date(NOW).toISOString(), admitted_before_you: true, invited_at: new Date(NOW).toISOString() }),
      row(laptop, { last_seen_at: null }),
      // a PC only the account service names stays on the screen, after the list's, marked
      row(stranger),
      // a route for another key than the one the list holds is no route to that PC
      row({ server_id: lied.server_id, endpoint: "ee".repeat(32) }),
    ], NOW)!;
    expect(rows.map((each) => each.server_id)).toEqual([desk, laptop, unreached, lied, stranger].map((each) => each.server_id));
    expect(rows[4]).toEqual({ ...row(stranger), not_in_list: true });
    expect(rows.slice(0, 4).every((each) => each.not_in_list === undefined)).toBe(true);
    expect(rows[0]).toEqual({ server_id: desk.server_id, label: "PC 1", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: "2026-11-24T00:00:00.000Z", public_key: desk.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false, by_list: true });
    // a name this device cannot open is no name: the directory's word for it is not taken
    expect(rows[1]).toMatchObject({ label: laptop.server_id.slice(0, 8), last_seen_at: null, public_key: laptop.endpoint, by_list: true });
    expect(rows[2]).toMatchObject({ label: "PC 3", public_key: null, relay: null, last_seen_at: null, by_list: true });
    expect(rows[3]).toMatchObject({ label: "PC 4", public_key: null, relay: null, by_list: true });
  });

  it("calls a PC new for a day from when this device first held its entry, and says which device added it", () => {
    const seen = Math.floor(NOW / 1000) - 3600;
    const fresh = pc(1, { new_at: seen });
    const rows = (now: number) => pcsByList(view([fresh, pc(2, { new_at: seen, by: "a-key-with-no-name" })]), "acct", [row(fresh)], now)!;
    expect(rows(NOW)[0]).toMatchObject({ new_until: new Date(seen * 1000 + NEW_LIST_PC_MS).toISOString(), added_by: "Dana's phone" });
    expect(rows(NOW)[1]!.added_by).toBeUndefined();
    expect(rows(seen * 1000 + NEW_LIST_PC_MS)[0]).toMatchObject({ new_until: null });
    expect(rows(seen * 1000 + NEW_LIST_PC_MS)[0]!.added_by).toBeUndefined();
  });

  it("gives such a row the account's own way in, whatever became of this sign-in's key, and no word that the service gave", () => {
    const [desk, away] = [pc(1), pc(2)];
    const rows = myPcs(pcsByList(view([desk, away]), "acct", [row(desk, { last_seen_at: null })], NOW)!, [], { now: NOW, registered: false });
    expect(rows.find((each) => each.server_id === desk.server_id)).toMatchObject({ name: "PC 1", listed: true, joined: true, paired: false, accountOpen: true, byList: true, join: { relay: "wss://relay.test" } });
    // no route, so nothing to open it by
    const unreached = rows.find((each) => each.server_id === away.server_id)!;
    expect([unreached.join, unreached.accountOpen, unreached.byList]).toEqual([undefined, undefined, true]);
    // a row of the directory alone gets that way only by the registered key, as before
    expect(myPcs([row(desk)], [], { now: NOW, registered: false })[0]!.accountOpen).toBeUndefined();
  });

  it("opens such a PC by itself though the account service never saw it, and not while it is new to this device", () => {
    const seen = Math.floor(NOW / 1000) - 3600;
    const [desk, fresh, away] = [pc(1), pc(2, { new_at: seen }), pc(3)];
    const directory = [row(desk, { last_seen_at: null }), row(fresh), row(pc(9))];
    const opens = (now: number) => accountOpenablePcs(myPcs(pcsByList(view([desk, fresh, away]), "acct", directory, now)!, [], { now }), { account: "acct", devices: [], now }).map((each) => each.server_id);
    expect(opens(NOW)).toEqual([desk.server_id]);
    expect(opens(seen * 1000 + NEW_LIST_PC_MS)).toEqual([desk.server_id, fresh.server_id]);
    // the PC that only the directory names is a row that a tap opens the way from before, and it never opens by itself
    const outside = myPcs(pcsByList(view([desk, fresh, away]), "acct", directory, NOW)!, [], { now: NOW, registered: true }).find((each) => each.server_id === pc(9).server_id)!;
    expect(outside).toMatchObject({ notInList: true, accountOpen: true, paired: false, listed: true });
    expect(outside.byList).toBeUndefined();
    // by the directory alone, a PC the account service never saw opens nothing by itself
    expect(accountOpenablePcs(myPcs(directory, [], { now: NOW, registered: true }), { account: "acct", devices: [], now: NOW }).map((each) => each.server_id)).toEqual([fresh.server_id, pc(9).server_id]);
  });
});

describe("what an Add with the number does for a PC that posted its keys", () => {
  const row = (key: string | null, removed: number | null = null) => ({ how: key === null ? "carried" as const : "added" as const, key, enc: key === null ? null : "enc", seq: 1, invite: null, removed });
  const state = (pcs: Record<string, ReturnType<typeof row>>, signers: Record<string, { by: string | null }> = {}) =>
    ({ pcs, signers: Object.fromEntries(Object.entries(signers).map(([key, { by }]) => [key, { power: "full", seq: 1, by, ended: null, as: "pc" }])) }) as unknown as ListState;
  const post = { endpoint: "e".repeat(64), key: "pc-key" };
  it("adds a PC the list does not hold, gives its keys to one the move carried in with none, and leaves to its signer one the list holds by these keys", () => {
    expect(postedFor(state({}), "me", post)).toEqual({ kind: "add" });
    expect(postedFor(state({ [post.endpoint]: row(null) }), "me", post)).toEqual({ kind: "keys" });
    expect(postedFor(state({ [post.endpoint]: row("pc-key") }, { "pc-key": { by: "me" } }), "me", post)).toEqual({ kind: "keys" });
    expect(postedFor(state({ [post.endpoint]: row("pc-key") }, { "pc-key": { by: "tablet" } }), "me", post)).toEqual({ kind: "signer", signer: "tablet" });
  });
  it("offers nothing for a PC the list put out, or one whose relay key the list holds another key at", () => {
    expect(postedFor(state({ [post.endpoint]: row(null, 7) }), "me", post)).toBeNull();
    expect(postedFor(state({ [post.endpoint]: row("other-key") }), "me", post)).toBeNull();
  });
});
