import { describe, expect, it } from "bun:test";
import { signListEntry } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import { deviceListKeys } from "./listKeys.ts";
import { forgetMembership, inList, leaveList, removeOthers, tidyOnRead, watchRemoval } from "./listLeave.ts";
import { removeFromList } from "./listRemoveDevice.ts";
import { accountList } from "./accountList.ts";
import { memoryListLock } from "./listStore.ts";
import { memoryAccountStore, newKey, type AccountSession } from "./store.ts";

type World = ReturnType<typeof listWorld>;
const noWait = { wait: async () => {} };
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));

async function twoDevices(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const offer = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, noWait);
  if (!offer.allowed) throw new Error(offer.why);
  await second.list.adopt(offer.offer);
  return { w, first, second };
}

/** Waits a bounded while for what a listener started. */
async function settle(done: () => boolean): Promise<void> {
  for (let turns = 0; turns < 200 && !done(); turns += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("a device that signs out or leaves", () => {
  it("puts itself out of the list, then forgets its account key and its copy: it comes back only as a new member", async () => {
    const { w, second } = await twoDevices();
    const before = await second.keys();
    expect(await leaveList(second.list, w.account, noWait)).toEqual({ removed: true });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(readBody(entryFromText(w.held().entries[2]!).body).ends).toBe(before.key);
    await forgetMembership(second.store, second.list, second.session, null);
    expect([await second.store.get("session"), await second.lists.get("copy", w.account), await second.store.get("enc_key")]).toEqual([undefined, undefined, undefined]);
    const after = await second.keys();
    expect([after.key === before.key, after.enc.key === before.enc.key]).toEqual([false, false]);
    expect(second.list.view().status).toEqual({ at: "off" });
  });

  it("a borrowed browser, which may remove nobody else, puts itself out at sign-out", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const browser = await w.device({ label: "Library browser" });
    await browser.list.sync();
    // the first device lets it in for a day: power bound, role drive, until a day from now
    await first.list.sync();
    const writer = first.list.writer()!;
    const own = await browser.keys();
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === own.key)!;
    const placed = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: writer.issued_at + 86_400, enc: claim.enc, card: claim.card, sealed: null, rotates: false },
      { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [placed.text], []);
    await browser.list.adopt({ list: w.held().id, seq: 1, hash: w.held().head.hash });
    expect(browser.list.writer()).toBeNull();
    expect(await leaveList(browser.list, w.account, noWait)).toEqual({ removed: true });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(readBody(entryFromText(w.held().entries[2]!).body).ends).toBe(own.key);
  });

  it("asks nothing of the list for an account that has none, and keeps its key", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const device = await w.device({ label: "Phone" });
    await device.list.sync();
    const key = (await device.keys()).key;
    expect(await leaveList(device.list, w.account, noWait)).toBeNull();
    expect(placements(device)).toHaveLength(0);
    expect((await device.keys()).key).toBe(key);
  });

  it("says why when the list cannot take its removal, and is still in it", async () => {
    const { w, second } = await twoDevices();
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await leaveList(second.list, w.account, noWait)).toEqual({ removed: false, why: "stopped", retryAfterMs: null, placed: 0 });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });
});

describe("a device that another member removed", () => {
  it("hears it once from its own copy, and not for a view that shows it in", async () => {
    const { w, first, second } = await twoDevices();
    const heard: string[] = [];
    const stop = watchRemoval(second.list, (account) => heard.push(account));
    await second.list.sync();
    expect(heard).toEqual([]);
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual({ removed: true });
    await second.list.sync();
    w.clock.now += 60_000;
    await second.list.sync();
    expect(heard).toEqual([w.account]);
    stop();
    expect(inList(second.list.view(), w.account)).toBe(false);
  });
});

describe("tidying while the list is read", () => {
  it("ends an invite that is past its time after a read, once, with nobody asking", async () => {
    const { w, first } = await twoDevices();
    const keys = await first.keys();
    const invite = await deviceListKeys(memoryAccountStore());
    const at = Math.floor(w.clock.now / 1000);
    const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + 900, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
    await first.service.placeEntries(w.held().id, [placed.text], []);
    const stop = tidyOnRead(first.list);
    await first.list.sync();
    expect(kinds(w.held().entries).at(-1)).toBe("invite");
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    await settle(() => kinds(w.held().entries).at(-1) === "epoch");
    expect(kinds(w.held().entries).slice(-3)).toEqual(["invite", "remove", "epoch"]);
    const sent = placements(first).length;
    w.clock.now += 60_000;
    await first.list.sync();
    await settle(() => false);
    expect(placements(first)).toHaveLength(sent);
    stop();
  });
});

describe("what the Codex read of P13 found about leaving", () => {
  it("X3: a sign-out begun for one account signs nothing in another that another tab switched to", async () => {
    const w = listWorld();
    const device = await w.device({ label: "Dana's laptop" });
    await device.list.sync();
    const first = device.session;
    // the same browser signs in to a second account, whose list it starts with the same account key
    const other: AccountSession = { ...first, account: "acct_other", access_token: w.fake.issueToken("acct_other"), sign_in_id: "sign-in-other", signed_in_at: w.clock.now };
    const key = await newKey();
    await device.store.set("session", other);
    await device.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-other", key, no: w.fake.registerSessionKey(other.access_token, key.public_spki, "Dana's laptop") });
    expect((await device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    const theirs = w.fake.accountList("acct_other")!.entries.length;
    // back on the first account: the page shows it in that account's list
    await device.store.set("session", first);
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    // the sign-out for the first account; another tab stores the second account's sign-in as it begins
    const tab = { ...device.list, sync: async () => { await device.store.set("session", other); return device.list.sync(); } };
    const outcome = await leaveList(tab, w.account, noWait);
    expect(outcome).toMatchObject({ removed: false, why: "changed" });
    expect(w.fake.accountList("acct_other")!.entries).toHaveLength(theirs);
    expect(kinds(w.held().entries)).toEqual(["genesis"]);
  });

  it("X3: a late clean-up for a sign-in that ended forgets nothing of the one that took its place", async () => {
    const { w, second } = await twoDevices();
    const departing = (await second.keys()).key;
    // signed in again since, with a new key that a member allowed
    await second.store.clear();
    const again = { ...second.session, access_token: w.fake.issueToken(w.account), sign_in_id: "sign-in-again" };
    await second.store.set("session", again);
    const replacement = (await second.keys()).key;
    await second.lists.set("copy", w.account, "a copy of the replacement");
    await forgetMembership(second.store, second.list, second.session, departing);
    expect(await second.store.get("session")).toEqual(again);
    expect((await second.keys()).key).toBe(replacement);
    expect(await second.lists.get("copy", w.account)).toBe("a copy of the replacement");
  });

  it("X6: a page that has not read its list yet goes by the copy it keeps, and puts itself out", async () => {
    const { w, second } = await twoDevices();
    // a new start of the app: this page's list has read nothing yet, and the copy is in the store
    const page = accountList({ service: second.service, accountStore: second.store, listStore: second.lists, lock: memoryListLock(), now: () => w.clock.now });
    expect(page.view().status).toEqual({ at: "off" });
    expect(await leaveList(page, w.account, noWait)).toEqual({ removed: true });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
  });
});

describe("what the second Codex read of P13 found about leaving", () => {
  it("H2: forgetting one account's membership keeps the keys another account's saved copy is pinned to, and forgets only the leaving account's copy", async () => {
    const w = listWorld();
    const device = await w.device({ label: "Dana's laptop" });
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    const key = (await device.keys()).key;
    // the same browser signs in to a second account and is in its list with the same account key
    const other: AccountSession = { ...device.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), sign_in_id: "sign-in-other", signed_in_at: w.clock.now };
    const signInKey = await newKey();
    await device.store.set("session", other);
    await device.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-other", key: signInKey, no: w.fake.registerSessionKey(other.access_token, signInKey.public_spki, "Dana's laptop") });
    expect(inList(await device.list.sync(), "acct_other")).toBe(true);
    // it signs out of the second account: its sign-in is gone, and its membership there is forgotten
    await device.store.set("session", undefined);
    await forgetMembership(device.store, device.list, other, key);
    expect((await device.keys()).key).toBe(key);
    expect(await device.list.follows("acct_other")).toBe(false);
    expect(await device.list.follows(w.account)).toBe(true);
  });

  it("M4: forgets a copy of the account's list only where it is pinned to the key that left: a replacement member's copy stays", async () => {
    const { w, second } = await twoDevices();
    const departing = (await second.keys()).key;
    const saved = await second.lists.get("copy", w.account);
    expect(saved).toBeDefined();
    await second.list.forget(w.account, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEanotherkeyofareplacementmember");
    expect(await second.lists.get("copy", w.account)).toBe(saved);
    await second.list.forget(w.account, departing);
    expect(await second.lists.get("copy", w.account)).toBeUndefined();
  });

  it("M3: a page whose own store cannot be read takes no path of a device in no list: nothing is signed, and it says it could not read", async () => {
    const { w, second } = await twoDevices();
    const page = accountList({ service: second.service, accountStore: second.store, listStore: second.lists, lock: memoryListLock(), now: () => w.clock.now });
    const unread = { ...page, follows: async () => { throw new DOMException("The store did not open", "UnknownError"); } };
    const before = w.held().entries.length;
    expect(await leaveList(unread, w.account, noWait)).toMatchObject({ removed: false, why: "unread" });
    expect(await removeOthers(unread, w.account, [], noWait)).toMatchObject({ removed: false, why: "unread" });
    expect(w.held().entries).toHaveLength(before);
  });

  it("M1: a self-removal the account service says it took counts only once this device's own read shows it", async () => {
    const { w, second } = await twoDevices();
    // the service answers the placement as taken and appends nothing
    second.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({}) : null;
    expect(await leaveList(second.list, w.account, noWait)).toMatchObject({ removed: false, why: "refused" });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("M1: where no read follows its own removal (the sign-in ended with it), whether it counted is not known", async () => {
    const { w, second } = await twoDevices();
    let ended = false;
    second.wire.answer = (request) => {
      if (ended) return Response.json({ error: { code: "unauthorized", message: "Signed out" } }, { status: 401 });
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) ended = true;
      return null;
    };
    expect(await leaveList(second.list, w.account, noWait)).toMatchObject({ removed: false, why: "unknown" });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
  });

  it("CodeRabbit #4637: a forget begun with no member key named clears only the key it began with: a replacement made meanwhile stays", async () => {
    const { second } = await twoDevices();
    await second.store.set("session", undefined);
    let replacement: string | undefined;
    // while it looks at the other accounts' copies, another tab clears the store and makes a key of its own
    const page = { ...second.list, pinnedElsewhere: async () => {
      await second.store.clear();
      replacement = (await second.store.key()).public_spki;
      return null;
    } };
    await forgetMembership(second.store, page, second.session, null);
    expect((await second.store.key()).public_spki).toBe(replacement!);
  });
});

