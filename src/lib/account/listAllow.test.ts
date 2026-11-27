import { describe, expect, it } from "bun:test";
import { kindBody, listView, readKind, signListEntry, type ListKind } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import type { AccountListView } from "./accountList.ts";
import { askingPc, listWorld, postPcKeys, type WorldDevice } from "./accountList.test-helpers.ts";
import { ALLOW_RESENDS, allowDevice, type AllowOutcome } from "./listAllow.ts";
import { deviceListKeys } from "./listKeys.ts";
import { memoryAccountStore, newKey, type AccountKey } from "./store.ts";

type World = ReturnType<typeof listWorld>;

const following = (view: AccountListView) => {
  if (view.status.at !== "following") throw new Error(`the device is ${view.status.at}`);
  return view.status;
};
const allowed = (outcome: AllowOutcome) => {
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  return outcome.offer;
};
const routes = (from: WorldDevice): string[] => from.sent.map((each) => each.route);
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const noWait = { wait: async () => {} };

/** An account whose first device started its list, and a second device that signed in and waits to be let in. */
async function twoDevices(w: World = listWorld(), skew = 0): Promise<{ w: World; first: WorldDevice; second: WorldDevice; newcomer: { key: string; label: string; os: "android" } }> {
  const first = await w.device({ label: "Dana's phone", skew });
  expect(following(await first.list.sync()).standing).toBe("in");
  const second = await w.device({ label: "Dana's tablet" });
  expect((await second.list.sync()).status).toEqual({ at: "not_in", list: w.held().id, why: "not_mine", claim: "claimed" });
  return { w, first, second, newcomer: { key: (await second.keys()).key, label: "Dana's tablet", os: "android" } };
}

describe("a device that is in the list lets another in", () => {
  it("signs a device entry for the key that claimed itself, and the newcomer follows the list from the place it is handed", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const list = w.held();
    expect(offer).toEqual({ list: list.id, seq: 1, hash: list.head.hash });
    // the entry is the first device's own, a `device` of the newcomer's key with its card, and the service's rules took it
    const body = readBody(entryFromText(list.entries[1]!).body);
    expect([body.signer, body.kind, body.adds]).toEqual([(await first.keys()).key, "device", { key: newcomer.key, power: "full" }]);
    expect(listView(list.state).devices.map((row) => [row.key, row.power, row.role, row.until])).toEqual([[(await first.keys()).key, "full", "drive", null], [newcomer.key, "full", "drive", null]]);
    // one request, and the epoch key wrapped to the newcomer with it
    expect(placements(first)).toHaveLength(1);
    expect((placements(first)[0]!.body!.wraps as { member: string; epoch: number }[]).map((wrap) => [wrap.member, wrap.epoch])).toEqual([[(await second.keys()).enc.key, 0]]);
    // the newcomer follows nothing on the service's word: only the place a member handed it makes it follow
    expect((await second.list.sync()).status.at).toBe("not_in");
    const view = await second.list.adopt(offer);
    expect(following(view)).toMatchObject({ list: list.id, standing: "in", head: 1, trouble: null });
    expect(view.devices.map((row) => [row.self, row.name])).toEqual([[false, { label: "Dana's phone", os: "ios" }], [true, { label: "Dana's tablet", os: "android" }]]);
    expect(await second.lists.get("offer", w.account)).toBeUndefined();
    // and the device that let it in sees it by its name too
    expect((await first.list.sync()).devices.map((row) => row.name?.label)).toEqual(["Dana's phone", "Dana's tablet"]);
  });

  it("tells the account service nothing that names the newcomer", async () => {
    const { first, newcomer } = await twoDevices();
    allowed(await allowDevice(first.list, newcomer, noWait));
    expect(JSON.stringify(first.sent)).not.toContain("tablet");
  });

  it("lets the newcomer let a third device in: it is a member like the first", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    await second.list.adopt(allowed(await allowDevice(first.list, newcomer, noWait)));
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    const offer = allowed(await allowDevice(second.list, { key: (await third.keys()).key, label: "Laptop", os: "android" }, noWait));
    expect(following(await third.list.adopt(offer))).toMatchObject({ standing: "in", head: 2 });
    expect((await first.list.sync()).devices).toHaveLength(3);
  });

  it("lets a newcomer whose sign-in ended while it took its place follow the list once it signs in again, under the account it was handed the place for", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const signedIn = (await second.store.get("session"))!;
    // the sign-in ended in another tab, or ran out, between the PC's answer and the place being taken
    await second.store.set("session", undefined);
    await second.list.adopt(offer, w.account);
    // signed in to the same account again, the device reads its list and is in it: it waits to be let in no more
    await second.store.set("session", { ...signedIn, access_token: w.fake.issueToken(w.account), sign_in_id: "signed-in-again" });
    expect(following(await second.list.sync())).toMatchObject({ list: offer.list, standing: "in", trouble: null });
    // a place kept for one account is no place in another's list
    const other = listWorld("acct_other");
    const stranger = await other.device({ label: "Stranger" });
    await stranger.store.set("session", undefined);
    await stranger.list.adopt(offer, w.account);
    expect(await stranger.lists.get("offer", "acct_other")).toBeUndefined();
  });

  it("claims again for a new key of this device within the time a claim for its old key is kept", async () => {
    const { second } = await twoDevices();
    const claims = () => routes(second).filter((route) => route.startsWith("POST") && route.endsWith("/claims")).length;
    expect(claims()).toBe(1);
    // another page left the account and signed in again: the store all pages share holds a new account key
    const renewed = await newKey();
    (second.store as { key: () => Promise<AccountKey> }).key = async () => renewed;
    await second.list.sync();
    expect(claims()).toBe(2);
  });

  it("answers the same for a key the list already holds, and signs nothing more", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    expect(allowed(await allowDevice(first.list, newcomer, noWait))).toEqual(offer);
    expect([placements(first).length, w.held().entries.length]).toEqual([1, 2]);
    expect(following(await second.list.adopt(offer)).standing).toBe("in");
  });
});

describe("a device that may not let anybody in", () => {
  it("signs nothing for another account than the one the approval began under, and never falls back to an account with no list", async () => {
    const { w, first, newcomer } = await twoDevices();
    // the page's list is the account's, and the approval was begun under another sign-in
    expect(await allowDevice(first.list, newcomer, { ...noWait, account: "acct_other" })).toEqual({ allowed: false, why: "changed", retryAfterMs: null });
    expect([placements(first), w.held().entries.length]).toEqual([[], 1]);
    // and the other way: a page that follows no list of this account, asked for an account that is not its own
    const elsewhere = listWorld("acct_none");
    elsewhere.fake.listAccounts = "";
    const stranger = await elsewhere.device();
    expect(await allowDevice(stranger.list, newcomer, { ...noWait, account: w.account })).toEqual({ allowed: false, why: "changed", retryAfterMs: null });
    // under its own account it is in, as ever
    allowed(await allowDevice(first.list, newcomer, { ...noWait, account: w.account }));
  });

  it("gives up where the claims are not answered in time, and sends nothing", async () => {
    const { w, first, newcomer } = await twoDevices();
    first.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/claims")
      ? new Promise<Response>((_resolve, reject) => { request.signal.addEventListener("abort", () => reject(request.signal.reason as Error), { once: true }); }) : null;
    expect(await allowDevice(first.list, newcomer, { ...noWait, claimsMs: 20 })).toEqual({ allowed: false, why: "unreached", retryAfterMs: null });
    expect([placements(first), w.held().entries.length]).toEqual([[], 1]);
  });

  it("signs nothing where it follows no list, or is in none", async () => {
    const w = listWorld();
    const alone = await w.device({ genesis: "never" });
    const stranger = await deviceListKeys(memoryAccountStore());
    expect(await allowDevice(alone.list, { key: stranger.key, label: "x", os: null }, noWait)).toEqual({ allowed: false, why: "no_list", retryAfterMs: null });
    const { first, second } = await twoDevices(listWorld());
    // the one that waits to be let in lets nobody in
    expect(await allowDevice(second.list, { key: (await first.keys()).key, label: "x", os: null }, noWait)).toMatchObject({ allowed: false, why: "no_list" });
    expect(routes(second).filter((route) => route.endsWith("/entries"))).toEqual([]);
  });

  it("signs nothing for a key no sign-in of the account claimed: the account service's second lock is not asked to fail", async () => {
    const { w, first } = await twoDevices();
    const stranger = await deviceListKeys(memoryAccountStore());
    expect(await allowDevice(first.list, { key: stranger.key, label: "Stranger", os: null }, noWait)).toEqual({ allowed: false, why: "not_claimed", retryAfterMs: null });
    expect([placements(first), w.held().entries.length]).toEqual([[], 1]);
  });

  it("signs nothing for a card the account service hands over that is not that key's", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const other = await deviceListKeys(memoryAccountStore());
    const list = w.held().id;
    // the service shows the newcomer's key with another device's encryption key: whoever held that key would read every name
    first.wire.answer = async (request) => new URL(request.url).pathname === `/v2/lists/${list}/claims` && request.method === "GET"
      ? Response.json({ claims: [{ key: newcomer.key, enc: other.enc.key, card: (await second.service.listClaims(list))[0]!.card, until: 1 }] }) : null;
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "refused" });
    expect([placements(first), w.held().entries.length]).toEqual([[], 1]);
  });

  it("never brings back a key the list put out", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    await second.list.adopt(allowed(await allowDevice(first.list, newcomer, noWait)));
    const keys = await first.keys();
    const removal = await signListEntry(w.held().state, { kind: "remove", ends: newcomer.key }, { key: keys.key, privateKey: keys.signs }, Math.floor(w.clock.now / 1000));
    await first.service.placeEntries(w.held().id, [removal.text], []);
    expect(await allowDevice(first.list, newcomer, noWait)).toEqual({ allowed: false, why: "removed", retryAfterMs: null });
    expect(w.held().entries).toHaveLength(3);
  });
});

describe("a list that moves, or a service that is busy, under an Allow", () => {
  it("reads and signs again when the head moved under it, and the newcomer is let in once", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const keys = await first.keys();
    let raced = false;
    first.wire.answer = async (request) => {
      if (raced || request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      raced = true;
      // another page of this device adds a PC first: the head is no longer the one the entry was signed on
      const pc = await askingPc();
      const card = await postPcKeys(w.fake.fetch, w.origin, first.session.access_token, pc, w.held().id);
      const added = await signListEntry(w.held().state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card, sealed: null }, { key: keys.key, privateKey: keys.signs }, Math.floor(w.clock.now / 1000));
      const placed = await w.fake.fetch(`${w.origin}/v2/lists/${w.held().id}/entries`, { method: "POST", headers: { authorization: `Bearer ${first.session.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ entries: [added.text] }) });
      expect(placed.status).toBe(200);
      return null;
    };
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    expect([offer.seq, placements(first).length, kinds(w.held().entries)]).toEqual([2, 2, ["genesis", "pc", "device"]]);
    expect(following(await second.list.adopt(offer))).toMatchObject({ standing: "in", head: 2 });
  });

  it("signs no second entry where the account service says the head moved and the device's own copy shows the same head: the same request goes again, and then it gives up", async () => {
    const { w, first, newcomer } = await twoDevices();
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toEqual({ allowed: false, why: "busy", retryAfterMs: null });
    expect([placements(first).length, w.held().entries.length]).toEqual([ALLOW_RESENDS, 1]);
    expect(new Set(placements(first).map((each) => JSON.stringify(each.body!.entries))).size).toBe(1);
  });

  it("finds its entry in the log after an answer that was lost, and says that it is not known yet where the log cannot be read either", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    // the service placed the entry, and its answer never came
    first.wire.answer = async (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      first.wire.answer = null;
      await w.fake.fetch(request);
      throw new TypeError("the answer was lost");
    };
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    expect([placements(first).length, kinds(w.held().entries)]).toEqual([1, ["genesis", "device"]]);
    expect(following(await second.list.adopt(offer)).standing).toBe("in");
    // the same with the network gone after the request: nothing says "not added"
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    first.wire.answer = async (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) { await w.fake.fetch(request); first.wire.answer = () => { throw new TypeError("the network is down"); }; throw new TypeError("the answer was lost"); }
      return null;
    };
    expect(await allowDevice(first.list, { key: (await third.keys()).key, label: "Laptop", os: null }, noWait)).toEqual({ allowed: false, why: "unknown", retryAfterMs: null });
  });

  it("reads the log for every answer that does not prove that nothing was placed: a gateway's 502, an answer that does not read, and a head the service keeps showing as it was", async () => {
    const entries = (request: Request): boolean => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries");
    // the service placed the entry and a gateway answered 502 for it
    {
      const { w, first, second, newcomer } = await twoDevices();
      first.wire.answer = async (request) => {
        if (!entries(request)) return null;
        first.wire.answer = null;
        await w.fake.fetch(request);
        return Response.json({ error: { code: "bad_gateway", message: "upstream" } }, { status: 502 });
      };
      const offer = allowed(await allowDevice(first.list, newcomer, noWait));
      expect([placements(first).length, kinds(w.held().entries)]).toEqual([1, ["genesis", "device"]]);
      expect(following(await second.list.adopt(offer)).standing).toBe("in");
    }
    // the service placed the entry and its 200 was cut short on the way
    {
      const { w, first, newcomer } = await twoDevices();
      first.wire.answer = async (request) => {
        if (!entries(request)) return null;
        first.wire.answer = null;
        await w.fake.fetch(request);
        return new Response('{"list":"', { status: 200, headers: { "content-type": "application/json" } });
      };
      allowed(await allowDevice(first.list, newcomer, noWait));
      expect([placements(first).length, kinds(w.held().entries)]).toEqual([1, ["genesis", "device"]]);
    }
    // the answer was lost, and the service goes on naming the head from before: the log is read all the same
    {
      const { w, first, newcomer } = await twoDevices();
      const stale = { seq: 0, hash: w.held().id };
      let lost = false;
      first.wire.answer = async (request) => {
        if (entries(request) && !lost) { lost = true; await w.fake.fetch(request); throw new TypeError("the answer was lost"); }
        if (!lost || request.method !== "GET" || !new URL(request.url).pathname.endsWith("/mine")) return null;
        const body = await (await w.fake.fetch(request)).json() as Record<string, unknown>;
        return Response.json({ ...body, head: stale });
      };
      allowed(await allowDevice(first.list, newcomer, noWait));
      expect([placements(first).length, kinds(w.held().entries)]).toEqual([1, ["genesis", "device"]]);
    }
    // a 502 with nothing placed and a log that cannot be read: not known yet, never "not added"
    {
      const { first, newcomer } = await twoDevices();
      first.wire.answer = (request) => {
        if (!entries(request)) return null;
        first.wire.answer = () => { throw new TypeError("the network is down"); };
        return Response.json({ error: { code: "bad_gateway", message: "upstream" } }, { status: 502 });
      };
      expect(await allowDevice(first.list, newcomer, noWait)).toEqual({ allowed: false, why: "unknown", retryAfterMs: null });
    }
  });

  it("signs again on the head a read brought while the service asked for the request again, where another device wrote meanwhile", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const pc = await askingPc();
    w.fake.tamperList(w.held().id, { rebuilding: true });
    let waited = 0;
    const outcome = await allowDevice(first.list, newcomer, { wait: async () => {
      waited += 1;
      if (waited !== 1) return;
      // while this device waits, the service is done rebuilding, another entry is placed, and this device's own clock reads it
      w.fake.untamperList(w.held().id);
      const writer = first.list.writer()!;
      const card = await postPcKeys(w.fake.fetch, w.origin, first.session.access_token, pc, writer.list);
      const placed = await signListEntry(writer.state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card, sealed: null }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
      await writer.service.placeEntries(writer.list, [placed.text], []);
      await first.list.sync();
    } });
    const offer = allowed(outcome);
    // the request signed on the old head is not sent again: the next one is signed on the head this device holds now
    const sent = placements(first).filter((each) => kinds(each.body!.entries as string[]).includes("device"));
    expect(sent.map((each) => readBody(entryFromText((each.body!.entries as string[])[0]!).body).seq)).toEqual([1, 2]);
    expect([offer.seq, kinds(w.held().entries)]).toEqual([2, ["genesis", "pc", "device"]]);
    expect(following(await second.list.adopt(offer)).standing).toBe("in");
  });

  it("sends the same request again while the service rebuilds the list, the same signatures, and is let in when it is done", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    w.fake.tamperList(w.held().id, { rebuilding: true });
    const waits: number[] = [];
    let sends = 0;
    const outcome = await allowDevice(first.list, newcomer, { wait: async (ms) => { waits.push(ms); sends += 1; if (sends === 1) w.fake.untamperList(w.held().id); } });
    const sent = placements(first);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(waits).toEqual([1000]);
    expect(following(await second.list.adopt(allowed(outcome))).standing).toBe("in");
  });

  it("gives up on a service that keeps rebuilding, and on one that cannot change the list, with nobody let in", async () => {
    const { w, first, newcomer } = await twoDevices();
    w.fake.tamperList(w.held().id, { rebuilding: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
    expect(placements(first)).toHaveLength(ALLOW_RESENDS);
    w.fake.untamperList(w.held().id);
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toEqual({ allowed: false, why: "stopped", retryAfterMs: null });
    expect(w.held().entries).toHaveLength(1);
  });

  it("does not take the account service's answer for the newcomer being in: an answer with nothing placed lets nobody in", async () => {
    const { w, first, newcomer } = await twoDevices();
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ list: w.held().id, head: { seq: 1, hash: "ab".repeat(32) }, placed: 1, now: 1 }) : null;
    expect(await allowDevice(first.list, newcomer, noWait)).toEqual({ allowed: false, why: "busy", retryAfterMs: null });
    expect(w.held().entries).toHaveLength(1);
  });
});

describe("an invite whose time is over, still in the list", () => {
  /** the first device placed an invite that a PC joins with by itself, and nobody used it before its time ran out */
  async function withStaleInvite(skew = 0) {
    const made = await twoDevices(listWorld(), skew);
    const { w, first } = made;
    const keys = await first.keys();
    const invite = await deviceListKeys(memoryAccountStore());
    const at = Math.floor(w.clock.now / 1000);
    const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + 900, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
    await first.service.placeEntries(w.held().id, [placed.text], []);
    w.clock.now += 16 * 60_000;
    return { ...made, invite: invite.key };
  }

  it("is put out, and the next epoch opened, in the same request as the newcomer, whose name is sealed under the new epoch", async () => {
    const { w, first, second, newcomer, invite } = await withStaleInvite();
    // the second device signed in sixteen minutes ago: its claim is made again before anybody lets it in
    await second.list.sync();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const list = w.held();
    expect(kinds(list.entries)).toEqual(["genesis", "invite", "remove", "epoch", "device"]);
    expect(placements(first).at(-1)!.body!.entries).toHaveLength(3);
    expect(readBody(entryFromText(list.entries[2]!).body).ends).toBe(invite);
    const device = readKind(readBody(entryFromText(list.entries[4]!).body)) as Extract<ListKind, { kind: "device" }>;
    expect([list.state.epoch, device.sealed?.epoch]).toEqual([1, 1]);
    // the new key is wrapped to the two devices that are in, and not to the invite
    const wraps = placements(first).at(-1)!.body!.wraps as { member: string; epoch: number }[];
    expect(wraps.map((wrap) => [wrap.member, wrap.epoch]).sort()).toEqual([[(await first.keys()).enc.key, 1], [(await second.keys()).enc.key, 1]].sort());
    // both read every name, the first device's from the epoch before through the list's own link
    const view = await second.list.adopt(offer);
    expect(view.devices.map((row) => row.name?.label)).toEqual(["Dana's phone", "Dana's tablet"]);
    expect((await first.list.sync()).devices.map((row) => row.name?.label)).toEqual(["Dana's phone", "Dana's tablet"]);
  });

  it("builds no request the account service must refuse for its size: more keys over their time than one request holds go out first, in requests of their own", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const keys = await first.keys();
    // fifteen invites that a PC joins with by itself, none used: with the epoch and the newcomer that is seventeen entries
    const invites: string[] = [];
    for (let made = 0; made < 15; made += 1) {
      const invite = await deviceListKeys(memoryAccountStore());
      const at = Math.floor(w.clock.now / 1000);
      const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + 900, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
      await first.service.placeEntries(w.held().id, [placed.text], []);
      invites.push(invite.key);
      // the account service holds five open invites at a time: its own invite of each is revoked here, which leaves the
      // list's entry as it is (the signed-list formats, D11.5)
      const auth = { authorization: `Bearer ${first.session.access_token}` };
      const open = await (await w.fake.fetch(`${w.origin}/v1/pc-invites`, { headers: auth })).json() as { invites: { id: string }[] };
      for (const { id } of open.invites) expect((await w.fake.fetch(`${w.origin}/v1/pc-invites/${id}`, { method: "DELETE", headers: auth })).status).toBe(204);
    }
    w.clock.now += 16 * 60_000;
    await second.list.sync();
    const before = placements(first).length;
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const sent = placements(first).slice(before).map((each) => kinds(each.body!.entries as string[]));
    expect(sent.every((request) => request.length <= 16)).toBe(true);
    // every one of them is out, the epoch moved once, and the newcomer came in under it
    const list = w.held();
    expect(listView(list.state).invites.filter((row) => invites.includes(row.key)).map((row) => row.refusal)).toEqual(invites.map(() => "invite_revoked"));
    expect(sent.flat().filter((kind) => kind !== "remove")).toEqual(["epoch", "device"]);
    expect(sent.flat().filter((kind) => kind === "remove")).toHaveLength(15);
    expect([list.state.epoch, offer.seq]).toEqual([1, list.head.seq]);
    expect((await second.list.adopt(offer)).devices.map((row) => row.name?.label)).toEqual(["Dana's phone", "Dana's tablet"]);
  });

  it("is judged by this device's own clock, never the account service's: where the two differ the device signs once, and says that its clock looks wrong", async () => {
    // this device's clock is twenty minutes behind the service's, so by its own the invite still has time
    const { w, first, second, newcomer } = await withStaleInvite(-20 * 60_000);
    await second.list.sync();
    const before = w.held().entries.length;
    expect(await allowDevice(first.list, newcomer, noWait)).toEqual({ allowed: false, why: "clock", retryAfterMs: null });
    // one request, signed once, with no removal the device's own clock does not call for; nothing was placed
    const sent = placements(first).slice(-1).map((each) => kinds(each.body!.entries as string[]));
    expect([sent, w.held().entries.length]).toEqual([[["device"]], before]);
  });

  it("puts nobody out whose time is not over by this device's own clock, whatever time the account service says it is", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    // a borrowed browser with an hour left
    const browser = await w.device({ label: "A borrowed browser" });
    await browser.list.sync();
    const writer = first.list.writer()!;
    const key = (await browser.keys()).key;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === key)!;
    const until = writer.issued_at + 3600;
    const borrowed = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until, enc: claim.enc, card: claim.card, sealed: null, rotates: false }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [borrowed.text], []);
    // the service says it is two hours later than it is
    first.wire.answer = async (request) => {
      if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/mine")) return null;
      const body = await (await w.fake.fetch(request)).json() as Record<string, unknown>;
      return Response.json({ ...body, now: Math.floor(w.clock.now / 1000) + 7200 });
    };
    await second.list.sync();
    allowed(await allowDevice(first.list, newcomer, noWait));
    expect(kinds(w.held().entries).slice(2)).toEqual(["device"]);
    expect(listView(w.held().state).devices.find((row) => row.key === key)).toMatchObject({ ended: null, until });
  });
});

describe("what an Allow answers for a key the list holds no more, and what it keeps of what it signed", () => {
  it("lets nobody in whom another member put out before this device read its entry back: the copy just read says so", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    allowed(await allowDevice(first.list, newcomer, noWait));
    await second.list.adopt({ list: w.held().id, seq: w.held().head.seq, hash: w.held().head.hash });
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    const laptop = { key: (await third.keys()).key, label: "Laptop", os: null };
    // the service places the laptop's entry, and before the first device reads it back the second puts the laptop out
    first.wire.answer = async (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      first.wire.answer = null;
      const answer = await w.fake.fetch(request);
      await second.list.sync();
      const writer = second.list.writer()!;
      const removal = await signListEntry(writer.state, { kind: "remove", ends: laptop.key }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
      await writer.service.placeEntries(writer.list, [removal.text], []);
      return answer;
    };
    expect(await allowDevice(first.list, laptop, noWait)).toEqual({ allowed: false, why: "removed", retryAfterMs: null });
    expect(kinds(w.held().entries).slice(-2)).toEqual(["device", "remove"]);
  });

  it("signs once for a place, also from two pages of one device at the same head: the second sends what the first kept", async () => {
    const { w, first, newcomer } = await twoDevices();
    // two pages of one device share its stores, so its keys and the request it keeps
    const writer = first.list.writer()!;
    const signed: string[] = [];
    // both pages stand at the same head and sign before either has sent anything
    const sign = async (label: string) => {
      const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === newcomer.key)!;
      const entry = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: false }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at + (label === "second" ? 1 : 0));
      signed.push(entry.text);
      return first.list.keep(writer, { entries: [entry.text], wraps: [], place: { seq: entry.state.footing.seq, hash: entry.state.footing.hash }, for: `allow:${newcomer.key}` });
    };
    const [one, two] = [await sign("first"), await sign("second")];
    expect(signed[0]).not.toBe(signed[1]);
    // the one kept first stands for that head: the second page's own signature is never sent
    expect([one.entries, two.entries]).toEqual([[signed[0]!], [signed[0]!]]);
    expect((await first.list.kept(writer))?.entries).toEqual([signed[0]!]);
    // and the Allow that follows sends that very request
    allowed(await allowDevice(first.list, newcomer, noWait));
    expect(w.held().entries[1]).toBe(signed[0]!);
  });

  it("signs another request on the same head only after the account service proved that it placed nothing", async () => {
    const { w, first, newcomer } = await twoDevices();
    const texts = () => placements(first).map((each) => (each.body!.entries as string[])[0]!);
    // a budget: the service's own refusal, with nothing placed. The request is let go
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "entry_budget", message: "x" } }, { status: 429, headers: { "retry-after": "60" } }) : null;
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "budget" });
    first.wire.answer = null;
    w.clock.now += 1_000;
    allowed(await allowDevice(first.list, newcomer, noWait));
    // two requests went out for that place, one after the other was refused, and the list holds the second
    expect([new Set(texts()).size, w.held().entries[1]]).toEqual([2, texts().at(-1)]);
  });

  it("sends the same request again where the account service asks to try again, and says that its clock looks wrong where the service dates the entry ahead", async () => {
    const { w, first, newcomer } = await twoDevices();
    let asked = 0;
    first.wire.answer = (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      asked += 1;
      return asked === 1 ? Response.json({ error: { code: "try_again", message: "x" } }, { status: 409 }) : null;
    };
    allowed(await allowDevice(first.list, newcomer, noWait));
    const sent = placements(first);
    expect([sent.length, sent[1]!.body]).toEqual([2, sent[0]!.body]);
    // an entry the service dates ahead of its own clock: nothing else is signed, and the card says the clock looks wrong
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "entry_refused", message: "x", reason: "issued_at_ahead", outcome: "service", index: 0 } }, { status: 400 }) : null;
    const before = placements(first).length;
    expect(await allowDevice(first.list, { key: (await third.keys()).key, label: "Laptop", os: null }, noWait)).toEqual({ allowed: false, why: "clock", retryAfterMs: null });
    expect(placements(first).length).toBe(before + 1);
  });

  it("puts nobody out for a time that is over while its clock reads far under the time it last saved: the newcomer comes in with no name", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const keys = await first.keys();
    const invite = await deviceListKeys(memoryAccountStore());
    const at = Math.floor(w.clock.now / 1000);
    const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + 900, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
    await first.service.placeEntries(w.held().id, [placed.text], []);
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    // the device's clock was an hour ahead for one read, and is right again: it reads far under the time it saved
    await first.lists.set("times", w.account, { v: 1, list: w.held().id, read_at: at + 4600, seen_at: at + 4600 });
    await second.list.sync();
    allowed(await allowDevice(first.list, newcomer, noWait));
    // no removal and no epoch: one entry, with no name sealed
    expect(kinds(w.held().entries)).toEqual(["genesis", "invite", "device"]);
    expect((readKind(readBody(entryFromText(w.held().entries[2]!).body)) as Extract<ListKind, { kind: "device" }>).sealed).toBeNull();
  });
});

describe("a device whose list stands in its way", () => {
  it("says that it cannot write, and never that the account has no list", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    await second.list.adopt(allowed(await allowDevice(first.list, newcomer, noWait)));
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    // The service shows another history that a member signed from entry 0 on, longer than any one request: the device
    // raises its alarm. (A few entries by a signer that went on in the device's own history are a request it left
    // behind, and no fork.)
    const keys = await first.keys();
    const list = w.held();
    const at = Math.floor(w.clock.now / 1000);
    const other: string[] = [];
    let prev = list.id;
    for (let seq = 1; seq <= 17; seq += 1) {
      const entry = await signEntry(kindBody({ issued_at: at, list: list.id, prev, seq, signer: keys.key }, { kind: "carried", endpoint: seq.toString(16).padStart(2, "0").repeat(32), sealed: null }), keys.signs);
      other.push(entryToText(entry));
      prev = entryHash(entry.body);
    }
    w.fake.tamperList(list.id, { fork: other });
    w.clock.now += 30_000;
    expect(following(await first.list.sync()).trouble).toBe("fork");
    const before = placements(first).length;
    expect(await allowDevice(first.list, { key: (await third.keys()).key, label: "Laptop", os: null }, noWait)).toEqual({ allowed: false, why: "blocked", retryAfterMs: null });
    expect(placements(first).length).toBe(before);
  });
});

describe("a device whose copy is stopped at an entry nobody signed", () => {
  it("writes nothing while the account service shows it another history under what it holds", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    await second.list.adopt(allowed(await allowDevice(first.list, newcomer, noWait)));
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    // an entry at a place this device holds, signed by a key that is no member's: no fork, and the copy is stuck there
    const stranger = await deviceListKeys(memoryAccountStore());
    const list = w.held();
    const lie = await signEntry(kindBody({ issued_at: Math.floor(w.clock.now / 1000), list: list.id, prev: list.id, seq: 1, signer: stranger.key }, { kind: "remove", endpoint: "ab".repeat(32) }), stranger.signs);
    w.fake.tamperList(list.id, { fork: [entryToText(lie)] });
    w.clock.now += 30_000;
    expect(following(await first.list.sync()).trouble).toBe("stuck");
    const before = placements(first).length;
    expect(await allowDevice(first.list, { key: (await third.keys()).key, label: "Laptop", os: null }, noWait)).toEqual({ allowed: false, why: "blocked", retryAfterMs: null });
    expect(placements(first).length).toBe(before);
  });
});

describe("a newcomer that is handed a place", () => {
  it("follows nothing while the log does not reach that place, and nothing when another entry stands there", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const list = w.held().id;
    // the service withholds the entry that lets it in
    w.fake.tamperList(list, { withholdAfter: 0, reader: { token: second.session.access_token } });
    expect((await second.list.adopt(offer)).status.at).toBe("not_in");
    expect([await second.lists.get("copy", w.account), await second.lists.get("offer", w.account)]).toEqual([undefined, { v: 1, ...offer }]);
    // it shows it once it stops, and the device follows from its own kept offer, with nothing handed again
    w.fake.untamperList(list);
    w.clock.now += 300_000;
    expect(following(await second.list.sync())).toMatchObject({ standing: "in", head: 1 });
  });

  it("follows no list of another account, though a place in it is handed over and the service serves its log", async () => {
    const { w, second } = await twoDevices();
    const other = listWorld("acct_stranger", w.clock.now);
    const stranger = await other.device({ label: "Stranger" });
    await stranger.list.sync();
    const theirs = other.held();
    second.wire.answer = (request) => new URL(request.url).pathname === `/v2/lists/${theirs.id}/log`
      ? Response.json({ list: theirs.id, after: null, entries: theirs.entries, head: theirs.head, more: false }) : null;
    const view = await second.list.adopt({ list: theirs.id, seq: 1, hash: "ab".repeat(32) });
    expect(view.status.at).toBe("not_in");
    expect(second.sent.map((each) => each.route)).toContain(`GET /v2/lists/${theirs.id}/log`);
    expect(await second.lists.get("copy", w.account)).toBeUndefined();
  });

  it("takes no place at all once it follows a list: a pin is one-way", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    await second.list.adopt(allowed(await allowDevice(first.list, newcomer, noWait)));
    const before = await second.lists.get("copy", w.account);
    const view = await second.list.adopt({ list: "cd".repeat(32), seq: 3, hash: "ef".repeat(32) });
    expect(following(view).list).toBe(w.held().id);
    expect([await second.lists.get("copy", w.account), await second.lists.get("offer", w.account)]).toEqual([before, undefined]);
  });

  it("is not let in by an entry no member signed, though the service shows it with the newcomer's own card", async () => {
    const { w, second } = await twoDevices();
    const list = w.held();
    const stranger = await deviceListKeys(memoryAccountStore());
    const mine = await second.keys();
    const claim = (await second.service.listClaims(list.id)).find((each) => each.key === mine.key)!;
    const body = kindBody({ issued_at: Math.floor(w.clock.now / 1000), list: list.id, prev: list.head.hash, seq: 1, signer: stranger.key },
      { kind: "device", key: mine.key, power: "full", role: "drive", until: null, enc: mine.enc.key, card: claim.card, sealed: null, rotates: false });
    const forged = entryToText(await signEntry(body, stranger.signs));
    w.fake.tamperList(list.id, { inject: [forged] });
    const hash = entryHash(entryFromText(forged).body);
    const view = await second.list.adopt({ list: list.id, seq: 1, hash });
    expect(view.status.at).toBe("not_in");
    expect(await second.lists.get("copy", w.account)).toBeUndefined();
  });
});
