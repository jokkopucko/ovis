/**
 * Independent review of client step 13 (the account's devices from the signed list), read at 1017d8662.
 *
 * Lives in `src/lib/account/` of the reviewed head, as `src/lib/account/review-client-p13.test.ts`. Each `F-…` test
 * FAILS on 1017d8662 and shows one finding of `review-client-p13.md` (7: F-H1, F-M1 to F-M5, F-L1); each `G…` test
 * passes there and pins a guard that was checked and found sound (18: G1 to G18), most of them killing a mutant the
 * step's own tests let live. To run this file alone:
 * `TMPDIR=<short dir> bun test src/lib/account/review-client-p13.test.ts`; only the guards: add `-t 'G[0-9]+:'`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { ListDevices, RemoveDialog, showsListDevices } from "../../components/ListDevices.tsx";
import { openPage, type Page } from "../page.fixture.ts";

import { listView, signListEntry } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { accountList, type AccountList, type AccountListView } from "./accountList.ts";
import { deleteAccount } from "./deleteAccount.ts";
import { leaveAccount } from "./leave.ts";
import { allowDevice } from "./listAllow.ts";
import { forgetMembership, inList, leaveList, removeOthers, tidyOnRead } from "./listLeave.ts";
import { listNewcomers } from "./listNotices.ts";
import { cameInThrough, removeFromList } from "./listRemoveDevice.ts";
import { memoryListLock } from "./listStore.ts";
import { SignedOutError, type AccountService } from "./service.ts";
import { memoryAccountStore, newKey, type AccountSession } from "./store.ts";
import { createAccountController } from "../relay/accountController.ts";
import type { ShellDeviceStore } from "../relay/device.ts";
import { SettingsProvider } from "../settings.ts";

type World = ReturnType<typeof listWorld>;
const noWait = { wait: async () => {} };
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const isIn = (w: World, key: string): boolean => listView(w.held().state).devices.some((row) => row.key === key && row.ended === null);

/** A device of the world let into the list by `by`, which then follows it. */
async function letIn(w: World, by: WorldDevice, label: string): Promise<WorldDevice> {
  const device = await w.device({ label });
  await device.list.sync();
  const offer = await allowDevice(by.list, { key: (await device.keys()).key, label, os: "android" }, noWait);
  if (!offer.allowed) throw new Error(`not let in: ${offer.why}`);
  await device.list.adopt(offer.offer);
  return device;
}

/**
 * `from` hands its place in the list to a new key of its own (a `device` entry with `rotates`, signed by its key):
 * the same device, in by another key, as at migration (account-list-migrate.ts, signRotation) or by any full device.
 * Answers the device that holds the new key.
 */
async function handOver(w: World, from: WorldDevice, label: string): Promise<WorldDevice> {
  const heir = await w.device({ label });
  await heir.list.sync();
  const next = (await heir.keys()).key;
  const claim = (await from.service.listClaims(w.held().id)).find((each) => each.key === next);
  if (claim === undefined) throw new Error("the new key was not claimed");
  const old = await from.keys();
  const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
    { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
  await from.service.placeEntries(w.held().id, [rotation.text], []);
  return heir;
}

describe("G: guards checked and found sound on 1017d8662 (these pass)", () => {
  it("G1: a self-removal whose answer was lost, on a device the removal signed out (D11.4), ends 'unknown', never thrown or counted", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const own = (await tablet.keys()).key;
    // the placement reaches the service and is placed; its answer is lost on the way back; the service ended this
    // linked device's sign-in in the same transaction (D11.4), so every later call is 401
    let ended = false;
    tablet.wire.answer = async (request) => {
      if (ended) return Response.json({ error: { code: "unauthorized", message: "Signed out" } }, { status: 401 });
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) {
        await w.fake.fetch(request);
        ended = true;
        throw new TypeError("the connection dropped before the answer");
      }
      return null;
    };
    let outcome: unknown;
    try { outcome = await leaveList(tablet.list, w.account, noWait); } catch (error) { outcome = { threw: error instanceof Error ? error.name : String(error) }; }
    // the device IS out of the list
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(isIn(w, own)).toBe(false);
    // what the read after it cannot show is not known (M1 ruling), and is not a thrown SignedOutError
    expect(outcome).toMatchObject({ removed: false, why: "unknown" });
  });

  it("G2: a Remove whose question was drawn for another member key of the same account and list signs nothing (X3, the member key)", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const gone = (await tablet.keys()).key;
    const writer = phone.list.writer()!;
    const before = w.held().entries.length;
    const shown = { account: writer.account, list: writer.list, member: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEanotherkeythequestionwasdrawnfor" };
    expect(await removeFromList(phone.list, { keys: [gone], pcs: [] }, { ...noWait, scope: shown })).toMatchObject({ removed: false, why: "changed" });
    expect([w.held().entries.length, isIn(w, gone)]).toEqual([before, true]);
  });

  it("G3: a self-removal whose read after the placement throws SignedOutError (the sign-in ended with it) is 'unknown', not counted", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    let posted = false;
    tablet.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) posted = true;
      return null;
    };
    const page: AccountList = { ...tablet.list, sync: async (options) => { if (posted) throw new SignedOutError(); return tablet.list.sync(options); } };
    expect(await leaveList(page, w.account, noWait)).toMatchObject({ removed: false, why: "unknown" });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
  });

  it("G4: a store that says it keeps a copy but whose read shows no copy of that account is 'unread', never the path of a device in no list (X6)", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const cold = accountList({ service: tablet.service, accountStore: tablet.store, listStore: tablet.lists, lock: memoryListLock(), now: () => w.clock.now });
    const none: AccountListView = { account: null, reached: false, status: { at: "off" }, devices: [], pcs: [] } as unknown as AccountListView;
    const page: AccountList = { ...cold, follows: async () => true, sync: async () => none };
    const before = w.held().entries.length;
    expect(await leaveList(page, w.account, noWait)).toMatchObject({ removed: false, why: "unread" });
    expect(await removeOthers(page, w.account, [], noWait)).toMatchObject({ removed: false, why: "unread" });
    expect(w.held().entries).toHaveLength(before);
  });

  it("G5: a device another member already put out leaves as removed, and signs nothing more", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    expect(await removeFromList(phone.list, { keys: [(await tablet.keys()).key], pcs: [] }, noWait)).toEqual({ removed: true });
    await tablet.list.sync();
    const before = w.held().entries.length;
    expect(await leaveList(tablet.list, w.account, noWait)).toEqual({ removed: true });
    expect(w.held().entries).toHaveLength(before);
  });

  it("G6: a sign-out or Sign out every device drawn for another member key of the same list signs nothing (leaveList and removeOthers compare the shown scope)", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const writer = phone.list.writer()!;
    const shown = { account: writer.account, list: writer.list, member: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEanotherkeythequestionwasdrawnfor" };
    const before = w.held().entries.length;
    expect(await leaveList(phone.list, w.account, { ...noWait, scope: shown })).toMatchObject({ removed: false, why: "changed" });
    expect(await removeOthers(phone.list, w.account, [(await tablet.keys()).key], { ...noWait, scope: shown })).toMatchObject({ removed: false, why: "changed" });
    expect(w.held().entries).toHaveLength(before);
  });

  /** A browser in the world's account list and in a second account's list, by one account key. */
  async function inTwoLists() {
    const w = listWorld();
    const device = await w.device({ label: "Dana's laptop" });
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    const key = (await device.keys()).key;
    const other: AccountSession = { ...device.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), refresh_token: "refresh-other", sign_in_id: "sign-in-other", signed_in_at: w.clock.now };
    const signInKey = await newKey();
    await device.store.set("session", other);
    await device.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-other", key: signInKey, no: w.fake.registerSessionKey(other.access_token, signInKey.public_spki, "Dana's laptop") });
    expect(inList(await device.list.sync(), "acct_other")).toBe(true);
    await device.store.set("session", device.session);
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    return { w, device, key };
  }

  it("G7: a look at the other copies that fails keeps the keys (forgetMembership)", async () => {
    const w = listWorld();
    const device = await w.device({ label: "Dana's laptop" });
    await device.list.sync();
    const key = (await device.keys()).key;
    const page: AccountList = { ...device.list, pinnedElsewhere: async () => { throw new DOMException("The store did not open", "UnknownError"); } };
    await device.store.set("session", undefined);
    await forgetMembership(device.store, page, device.session, key);
    expect((await device.keys()).key).toBe(key);
  });

  it("G8: where another account's copy holds the key, a late forget for a sign-in that another tab replaced (same account) keeps that sign-in's copy", async () => {
    const { w, device, key } = await inTwoLists();
    // another tab signed in to the first account again (same key: one key per device) and follows its list
    const again: AccountSession = { ...device.session, access_token: w.fake.issueToken(w.account), refresh_token: "refresh-again", sign_in_id: "sign-in-again", signed_in_at: w.clock.now };
    await device.store.set("session", again);
    expect(await device.list.follows(w.account)).toBe(true);
    // the old sign-in's late clean-up
    await forgetMembership(device.store, device.list, device.session, key);
    expect(await device.store.get("session")).toEqual(again);
    expect(await device.list.follows(w.account)).toBe(true);
  });

  it("G9: another account's copy that does not read, or is out of form, counts as holding the key", async () => {
    for (const junk of ["not a copy", 42]) {
      const w = listWorld();
      const device = await w.device({ label: "Dana's laptop" });
      await device.list.sync();
      const key = (await device.keys()).key;
      await device.lists.set("copy", "acct_other", junk);
      await device.store.set("session", undefined);
      await forgetMembership(device.store, device.list, device.session, key);
      expect((await device.keys()).key).toBe(key);
    }
  });

  it("G10: another account's copy pinned to another key does not keep this key: a sign-out forgets it", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const device = await w.device({ label: "Dana's laptop" });
    // first in the second account's list by an older key, which this device no longer holds
    const other: AccountSession = { ...device.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), refresh_token: "refresh-other", sign_in_id: "sign-in-other", signed_in_at: w.clock.now };
    const otherKey = await newKey();
    await device.store.set("session", other);
    await device.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-other", key: otherKey, no: w.fake.registerSessionKey(other.access_token, otherKey.public_spki, "Dana's laptop") });
    expect(inList(await device.list.sync(), "acct_other")).toBe(true);
    await device.store.clear();
    // then let into the first account's list by a new key
    await device.store.set("session", device.session);
    const signInKey = await newKey();
    await device.store.set("signin_key", { account: w.account, sign_in_id: device.session.sign_in_id!, key: signInKey, no: w.fake.registerSessionKey(device.session.access_token, signInKey.public_spki, "Dana's laptop") });
    await device.list.sync();
    const key = (await device.keys()).key;
    const offer = await allowDevice(phone.list, { key, label: "Dana's laptop", os: "linux" }, noWait);
    if (!offer.allowed) throw new Error(offer.why);
    expect(inList(await device.list.adopt(offer.offer), w.account)).toBe(true);
    await device.store.set("session", undefined);
    await forgetMembership(device.store, device.list, device.session, key);
    expect((await device.keys()).key).not.toBe(key);
  });

  it("G18: another account's copy that shows this key out does not keep it: a sign-out forgets it", async () => {
    const { w, device, key } = await inTwoLists();
    // a second member of the other account puts this browser out of that account's list
    const member = await w.device({ label: "Other phone" });
    const theirs: AccountSession = { ...member.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), refresh_token: "refresh-member", sign_in_id: "sign-in-member", signed_in_at: w.clock.now };
    const theirKey = await newKey();
    await member.store.set("session", theirs);
    await member.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-member", key: theirKey, no: w.fake.registerSessionKey(theirs.access_token, theirKey.public_spki, "Other phone") });
    await member.list.sync();
    const other: AccountSession = { ...device.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), refresh_token: "refresh-other-2", sign_in_id: "sign-in-other-2", signed_in_at: w.clock.now };
    await device.store.set("session", other);
    await device.list.sync();
    const offer = await allowDevice(device.list, { key: (await member.keys()).key, label: "Other phone", os: "android" }, noWait);
    if (!offer.allowed) throw new Error(offer.why);
    await member.list.adopt(offer.offer);
    expect(await removeFromList(member.list, { keys: [key], pcs: [] }, noWait)).toEqual({ removed: true });
    const out = await device.list.sync();
    expect(out.status).toMatchObject({ at: "following", standing: "out" });
    // back on the first account, the browser signs out of it
    await device.store.set("session", device.session);
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    await device.store.set("session", undefined);
    await forgetMembership(device.store, device.list, device.session, key);
    expect((await device.keys()).key).not.toBe(key);
  });

  it("G11: leaveAccount keeps the key where the look at other accounts' copies fails", async () => {
    const accountStore = memoryAccountStore();
    const key = (await accountStore.key()).public_spki;
    const from: AccountSession = { service: "https://account.example", account: "acct_owner", provider: "github", access_token: "access-a", refresh_token: "refresh-a", expires_at: Date.now() + 3600_000, sign_in_id: "sign-in-a" };
    await accountStore.set("session", from);
    const forSignIn = { listPcs: async () => [], postRecord: async () => {}, signOut: async () => {} };
    const service = { forSignIn: () => forSignIn } as unknown as AccountService;
    const relayStore: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async () => { throw new Error("no pairing here"); } };
    await leaveAccount({ service, accountStore, relayStore, session: from, keeps: async () => { throw new DOMException("The store did not open", "UnknownError"); } });
    expect((await accountStore.key()).public_spki).toBe(key);
  });

  it("G12: the quiet tidy-up is not used up by a read that did not reach the account service", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    const view = await first.list.sync();
    // the tidy-up looks at the list (its writer) before its first wait: whether a read starts it shows at once
    let heard: ((view: AccountListView) => void) | null = null;
    let looked = 0;
    const page: AccountList = { ...first.list, subscribe: (listener) => { heard = listener; return () => {}; }, writer: (options) => { looked += 1; return first.list.writer(options); } };
    const stop = tidyOnRead(page);
    try {
      // a read that did not reach the account service starts nothing, so it uses up no try
      heard!({ ...view, reached: false });
      expect(looked).toBe(0);
      // one that did starts the tidy-up
      heard!(view);
      expect(looked).toBe(1);
    } finally { stop(); }
  });
});

describe("G: the controller's own guards (accountController.ts), on 1017d8662", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  beforeEach(() => {
    page = openPage("https://app.ovis.sh/");
    page.window.sessionStorage.setItem("ovis-launched", "1");
    Object.defineProperties(page.window.navigator, {
      languages: { configurable: true, value: ["en"] },
      userAgent: { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64)" },
      maxTouchPoints: { configurable: true, value: 0 },
    });
    Object.defineProperty(page.window, "innerWidth", { configurable: true, value: 1440 });
    for (const [key, value] of Object.entries({ localStorage: page.window.localStorage, sessionStorage: page.window.sessionStorage, matchMedia: page.window.matchMedia.bind(page.window) })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });
  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });
  const empty: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async () => { throw new Error("No pairing is made here"); } };
  const shellOf = (device: WorldDevice) => createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: empty, accountStore: device.store, accountService: device.session.service,
    accountFetch: async (input, init) => {
      const { pathname } = new URL(new Request(input, init).url);
      if (pathname === "/v1/pcs") return Response.json({ pcs: [] });
      if (pathname === "/v1/signout" || pathname === "/v1/signout/all") return new Response(null, { status: 204 });
      return Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
    },
    renderApp: () => ({ render() {}, unmount() {} }),
    accountList: device.list,
  }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
  async function until(done: () => boolean | Promise<boolean>): Promise<void> {
    for (let turns = 0; turns < 400; turns += 1) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("it did not happen");
  }

  it("G13: Sign out drawn for an account with no list ends nothing where another account's sign-in is stored now", async () => {
    const w = listWorld("acct_owner", Date.now());
    w.fake.listAccounts = "";
    const device = await w.device({ label: "Dana's laptop" });
    const shell = shellOf(device);
    await shell.refresh(true);
    shell.signOut({ account: "acct_shown_before", scope: null });
    await until(() => shell.state?.kind === "signed-in");
    expect(await device.store.get("session")).toEqual(device.session);
  });

  it("G14: Disconnect drawn for an account with no list leaves nothing where another account's sign-in is stored now", async () => {
    const w = listWorld("acct_owner", Date.now());
    w.fake.listAccounts = "";
    const device = await w.device({ label: "Dana's laptop" });
    const shell = shellOf(device);
    await shell.refresh(true);
    expect(await shell.leave({ account: "acct_shown_before", scope: null })).toEqual({ left: false, message: "Your sign-in changed while this was asked. Nothing was removed." });
    expect(await device.store.get("session")).toEqual(device.session);
  });

  it("G15: Sign out drawn for another member key of the same list ends nothing: not the sign-in, not the membership", async () => {
    const w = listWorld("acct_owner", Date.now());
    const device = await w.device({ label: "Dana's laptop" });
    await device.list.sync();
    const shell = shellOf(device);
    await shell.refresh(true);
    const writer = device.list.writer()!;
    const before = w.held().entries.length;
    shell.signOut({ account: w.account, scope: { account: w.account, list: writer.list, member: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEanotherkeythequestionwasdrawnfor" } });
    await until(() => shell.state?.kind === "signed-in");
    expect(await device.store.get("session")).toEqual(device.session);
    expect(w.held().entries).toHaveLength(before);
  });
});

describe("F: findings that fail on 1017d8662", () => {
  it("F-L1: a write whose shown scope no longer matches sends nothing, not the request kept for the same operation on the head it now holds", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const gone = (await tablet.keys()).key;
    // an earlier Remove of the tablet signed and kept its request; the answer was lost and the log could not be read
    let away = false;
    phone.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) away = true;
      return away ? Promise.reject(new TypeError("offline")) : null;
    };
    expect(await removeFromList(phone.list, { keys: [gone], pcs: [] }, { ...noWait, operation: `remove:${gone}` })).toMatchObject({ removed: false, why: "unknown" });
    phone.wire.answer = null;
    expect(isIn(w, gone)).toBe(true);
    // a question drawn for another member key than the one this page writes by now (another tab signed in again: X3)
    const writer = phone.list.writer()!;
    const shown = { account: writer.account, list: writer.list, member: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEanotherkeythequestionwasdrawnfor" };
    const outcome = await removeFromList(phone.list, { keys: [gone], pcs: [] }, { ...noWait, operation: `remove:${gone}`, scope: shown });
    // it ends `changed` ("Nothing was removed")…
    expect(outcome).toMatchObject({ removed: false, why: "changed" });
    // …and nothing went out for it: on 1017d8662 the kept request went out first, unchecked, and the tablet is out
    expect(isIn(w, gone)).toBe(true);
  });

  it("F-M1: Remove with nothing ticked does not place what an earlier press of Remove on the same device ticked (the operation name is the device's key alone)", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const lost = await letIn(w, phone, "Lost phone");
    const laptop = await letIn(w, lost, "Laptop");
    const [d, e] = [(await lost.keys()).key, (await laptop.keys()).key];
    // first press: Remove Lost phone with Laptop ticked; the request goes out, no answer comes, and the log cannot be
    // read: "Whether Lost phone was removed is not known yet"
    let away = false;
    phone.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) away = true;
      return away ? Promise.reject(new TypeError("offline")) : null;
    };
    expect(await removeFromList(phone.list, { keys: [d, e], pcs: [] }, { ...noWait, operation: `remove:${d}` })).toMatchObject({ removed: false, why: "unknown" });
    phone.wire.answer = null;
    expect([isIn(w, d), isIn(w, e)]).toEqual([true, true]);
    // second press, a new question: Remove Lost phone, nothing ticked (ListDevices.tsx passes `remove:<key>` again)
    await removeFromList(phone.list, { keys: [d], pcs: [] }, { ...noWait, operation: `remove:${d}` });
    // the laptop the second question left unticked is still in
    expect(isIn(w, e)).toBe(true);
  });

  it("F-M3: a device that hands its place to a new key raises no new-device notice ('allowed into your account by Unknown key', with Not me)", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const self = (await phone.keys()).key;
    await phone.list.sync();
    // the phone has looked up to here: nothing before is news
    const seen = { list: w.held().id, member: self, floor: phone.list.writer()!.state.footing.seq, closed: [] as string[] };
    const heir = await handOver(w, tablet, "Dana's tablet");
    await phone.list.sync();
    const state = phone.list.writer()!.state;
    // the library says the tablet is in by its new key: the same device, not a new one (shared/account-list-migrate.ts, rekeys)
    const next = (await heir.keys()).key;
    expect(listView(state).devices.some((row) => row.key === next && row.ended === null)).toBe(true);
    expect(listNewcomers(state, self, seen)).toEqual([]);
  });

  it("F-M4: what came in through a device includes what it let in under the key it handed on", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const lost = await letIn(w, phone, "Lost phone");
    const thief = await letIn(w, lost, "Thief's laptop");
    // the lost phone hands its place to a new key; its row in Settings is that key now
    const heir = await handOver(w, lost, "Lost phone");
    await phone.list.sync();
    const writer = phone.list.writer()!;
    const arrivals = cameInThrough(writer.state, (await heir.keys()).key, writer.keys.key);
    expect(arrivals.map((arrival) => arrival.kind === "pc" ? arrival.endpoint : arrival.key)).toContain((await thief.keys()).key);
  });

  it("F-M5 (ruled: words only; one key per account is a follow-up): a browser in two accounts' lists that signed out of one is out there for good, and no Allow of it is offered", async () => {
    const w = listWorld();
    const laptop = await w.device({ label: "Dana's laptop" });
    expect(inList(await laptop.list.sync(), w.account)).toBe(true);
    const phone = await letIn(w, laptop, "Dana's phone");
    const key = (await laptop.keys()).key;
    // the same browser is in a second account's list by the same account key
    const other: AccountSession = { ...laptop.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), refresh_token: "refresh-other", sign_in_id: "sign-in-other", signed_in_at: w.clock.now };
    const otherKey = await newKey();
    await laptop.store.set("session", other);
    await laptop.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-other", key: otherKey, no: w.fake.registerSessionKey(other.access_token, otherKey.public_spki, "Dana's laptop") });
    expect(inList(await laptop.list.sync(), "acct_other")).toBe(true);
    // back on the first account, it signs out: its own removal, then what made it a member there is forgotten
    await laptop.store.set("session", laptop.session);
    expect(inList(await laptop.list.sync(), w.account)).toBe(true);
    expect(await leaveList(laptop.list, w.account, noWait)).toEqual({ removed: true });
    await laptop.store.set("session", undefined);
    const { forgetMembership } = await import("./listLeave.ts");
    await forgetMembership(laptop.store, laptop.list, laptop.session, key);
    // signing in again: "Signing in again is a new device and needs an Allow" (plan 3.1)
    const again: AccountSession = { ...laptop.session, access_token: w.fake.issueToken(w.account), refresh_token: "refresh-again", sign_in_id: "sign-in-again", signed_in_at: w.clock.now };
    const againKey = await newKey();
    await laptop.store.set("session", again);
    await laptop.store.set("signin_key", { account: w.account, sign_in_id: "sign-in-again", key: againKey, no: w.fake.registerSessionKey(again.access_token, againKey.public_spki, "Dana's laptop") });
    await laptop.list.sync();
    // the key is kept for the other account's list, and this list put it out for good: the browser reads itself out,
    // asks to be let in nowhere, and an Allow of it is refused (the controller's words say how to come back: F-M5 in
    // accountController.listLeave.test.ts)
    expect((await laptop.keys()).key).toBe(key);
    expect((await laptop.list.sync()).status).toMatchObject({ at: "following", standing: "out" });
    expect((await phone.service.listClaims(w.held().id)).some((claim) => claim.key === key)).toBe(false);
    const allowed = await allowDevice(phone.list, { key, label: "Dana's laptop", os: "linux" }, noWait);
    expect(allowed).toMatchObject({ allowed: false, why: "removed" });
  });

  it("F-H1: Delete account keeps the account key where another account's saved list still holds this device by it (the H2 rule, not applied in deleteAccount.ts)", async () => {
    const w = listWorld();
    const device = await w.device({ label: "Dana's laptop" });
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    const key = (await device.keys()).key;
    // the same browser signs in to a second account and starts its list by the same account key (its only full member)
    const other: AccountSession = { ...device.session, account: "acct_other", access_token: w.fake.issueToken("acct_other"), refresh_token: "refresh-other", sign_in_id: "sign-in-other", signed_in_at: w.clock.now };
    const signInKey = await newKey();
    await device.store.set("session", other);
    await device.store.set("signin_key", { account: "acct_other", sign_in_id: "sign-in-other", key: signInKey, no: w.fake.registerSessionKey(other.access_token, signInKey.public_spki, "Dana's laptop") });
    expect(inList(await device.list.sync(), "acct_other")).toBe(true);
    expect(w.fake.accountList("acct_other")!.state.signers[key]?.ended).toBeNull();
    // back on the first account, the person deletes it, as the controller does (accountController.ts deleteAccount)
    await device.store.set("session", device.session);
    expect(inList(await device.list.sync(), w.account)).toBe(true);
    // with the look at the other accounts' copies the controller passes (keeps), as sign-out and leave do (H2)
    await deleteAccount({ service: device.service, accountStore: device.store, session: device.session, keeps: (held) => device.list.pinnedElsewhere(w.account, held).then((other) => other !== null) });
    await device.list.forget(w.account);
    // the second account's list still holds this device by that key, and nobody else: the key must stay
    expect(await device.list.follows("acct_other")).toBe(true);
    expect((await device.keys()).key).toBe(key);
  });
});

describe("Remove's question (ListDevices.tsx): F-M2, and the guards G16, G17", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    page = openPage("https://app.example/");
    Object.defineProperties(page.window.navigator, {
      languages: { configurable: true, value: ["en"] },
      userAgent: { configurable: true, value: "Test" },
      maxTouchPoints: { configurable: true, value: 0 },
    });
    Object.defineProperties(page.window, {
      innerWidth: { configurable: true, value: 1440 },
      innerHeight: { configurable: true, value: 900 },
    });
    for (const [key, value] of Object.entries({ Event: page.window.Event, HTMLElement: page.window.HTMLElement, matchMedia: page.window.matchMedia.bind(page.window) })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });

  afterEach(async () => {
    await page.close();
    console.warn = warn;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  /** Lets the work a press started run until `done`, for ten seconds at most. */
  async function waitFor(done: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("what the press started did not end");
      await Bun.sleep(25);
      await act(async () => {});
    }
  }
  const mount = async (device: WorldDevice): Promise<void> => {
    const view = await device.list.sync();
    if (!showsListDevices(view, device.session.account)) throw new Error("the device does not show the list");
    await page.render(createElement(SettingsProvider, { children: createElement(ListDevices, { list: device.list, view }) }));
  };
  const dialogs = () => [...page.window.document.body.querySelectorAll('[role="alertdialog"]')];
  function only<T>(nodes: readonly T[], label: string): T {
    const [node] = nodes;
    if (nodes.length !== 1 || !node) throw new Error(`Expected one ${label}, found ${nodes.length}`);
    return node;
  }
  const confirm = async (): Promise<void> => {
    const dialog = only(dialogs(), "removal dialog");
    const button = only([...dialog.querySelectorAll("button")].filter((node) => node.textContent === "Remove"), "Remove button");
    await act(async () => { button.click(); });
    await waitFor(() => {
      const [open] = dialogs();
      return !open || open.querySelector('[role="alert"]') !== null;
    });
  };
  const said = (): string | null => {
    const [open] = dialogs();
    return open ? only([...open.querySelectorAll('[role="alert"]')], "removal alert").textContent : null;
  };

  it("G16: Remove acts for the member key its question was drawn for: a page that writes by another key now removes nothing", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const view = await phone.list.sync();
    // the page drew its devices when this device was in by another key (another tab signed in again since)
    const drawn = { ...view, devices: view.devices.map((row) => (row.self ? { ...row, key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEthekeythequestionwasdrawnfor" } : row)) };
    await page.render(createElement(SettingsProvider, { children: createElement(ListDevices, { list: phone.list, view: drawn }) }));
    await act(async () => { page.one<HTMLButtonElement>('button[data-action="remove-device"]').click(); });
    await confirm();
    expect(said()).toBe("Your sign-in changed while this was asked. Nothing was removed.");
    expect(isIn(w, (await tablet.keys()).key)).toBe(true);
  });

  it("G17: Remove after a Not me whose outcome is not known waits for that change: it does not place what Not me ticked", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const stranger = await letIn(w, phone, "Stranger's phone");
    const added = await letIn(w, stranger, "Stranger's laptop");
    const view = await phone.list.sync();
    const key = (await stranger.keys()).key;
    const dialog = (ticked: boolean) => createElement(SettingsProvider, { children: createElement(RemoveDialog, { list: phone.list, view, removing: key, name: "Stranger's phone", ticked, onClose: () => {}, onRemoved: () => {} }) });
    // Not me, everything ticked: the request goes out and nothing is known of it
    let away = false;
    phone.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) away = true;
      return away ? Promise.reject(new TypeError("offline")) : null;
    };
    await page.render(dialog(true));
    await confirm();
    expect(said()).toBe("Whether Stranger's phone was removed is not known yet. Look at the list again in a moment.");
    await page.render(null);
    phone.wire.answer = null;
    // a Remove of the same device, nothing ticked
    await page.render(dialog(false));
    await confirm();
    expect(said()).toBe("An earlier change is still waiting: try it again or cancel it first.");
    expect([isIn(w, key), isIn(w, (await added.keys()).key)]).toEqual([true, true]);
  });

  it("F-M2: removes the device on the press after a second handover, instead of asking again for the same old key forever", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Stolen tablet");
    await mount(phone);
    await act(async () => { page.one<HTMLButtonElement>('button[data-action="remove-device"]').click(); });
    // whoever holds the tablet hands its place to a new key as the question opens
    const first = await handOver(w, tablet, "Stolen tablet");
    await confirm();
    expect(said()).toBe("Stolen tablet moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
    // and once more before the second press
    const second = await handOver(w, first, "Stolen tablet");
    await confirm();
    expect(said()).toBe("Stolen tablet moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
    // nothing moves any more: the third press removes the key that stands for the tablet now
    await confirm();
    expect(said()).toBeNull();
    expect(isIn(w, (await second.keys()).key)).toBe(false);
  });
});
