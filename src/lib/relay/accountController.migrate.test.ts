import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { AccountList, AccountListView } from "../account/accountList.ts";
import { pageAnswers } from "../account/listMigrate.ts";
import { memoryAccountStore, newKey, type AccountSession, type AccountStore } from "../account/store.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { ACCOUNT_LIST_FEATURE, MuxProtocolError } from "../../../shared/relay-mux.ts";
import { createAccountController } from "./accountController.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const DAY = 86400;
const session = (account: string): AccountSession => ({ service: SERVICE, account, provider: "github", access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${account}`, signed_in_at: Date.now() });
const settle = async (): Promise<void> => { for (let turn = 0; turn < 30; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const deferred = <T>() => Promise.withResolvers<T>();

/** A PC: its relay key as a relay offer carries it, and as a list names it (64 hex). */
function pcKeys() {
  const pair = generateKeyPair();
  return { offerKey: exportPublicKey(pair.publicKey), endpoint: Array.from(pair.publicKey, (byte) => byte.toString(16).padStart(2, "0")).join(""), serverId: deriveServerId(pair.publicKey) };
}

/** A session the shell opened: what was asked over it, and the PC's answers by `METHOD path`. */
function sessionOf(given: { readonly pinned?: boolean; readonly key?: string; readonly answers?: Record<string, unknown> }) {
  const asked: { method: string; path: string; body: unknown }[] = [];
  let closed = false;
  const opened = {
    server: { version: "1", relayProtocol: 1, features: given.pinned === true ? [ACCOUNT_LIST_FEATURE] : [] },
    deviceKey: given.key,
    fetch: async (path: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      const said = given.answers?.[`${init?.method ?? "GET"} ${path}`];
      const held = said instanceof Promise ? await said : said;
      return held === undefined ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : held instanceof Response ? held : Response.json(held);
    },
    close: () => { closed = true; },
  };
  return { opened: opened as unknown as RelayTransport, asked, closed: () => closed };
}

/** A list in the view the test sets, recording what is asked of it. */
function listIn(view: () => AccountListView, naming: AccountList["naming"] = undefined) {
  const listeners: ((view: AccountListView) => void)[] = [];
  let synced = 0;
  const list = {
    sync: async () => { synced += 1; return view(); }, follows: async () => false, view, subscribe: (listener: (view: AccountListView) => void) => { listeners.push(listener); return () => {}; },
    holdsPc: () => false, pcOfKey: () => null, due: () => null, shadow: async () => null, dropNames: async () => {}, forget: async () => {}, pinnedElsewhere: async () => null, adopt: async () => view(),
    writer: () => null, placeAt: () => null, holdsEntry: () => false, gossip: () => null, pageAfter: () => null,
    compare: () => null, knowsPc: () => false, takeFromPeer: async () => null,
    kept: async () => null, keep: async () => { throw new Error("nothing is signed here"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone" as const, shown: () => Math.floor(Date.now() / 1000),
    ...(naming === undefined ? {} : { naming }),
  } as AccountList;
  return { list, tell: () => { for (const listener of listeners) listener(view()); }, synced: () => synced };
}

describe("the shell's sessions and the move of an account onto its list", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let accountStore: AccountStore;
  const made: { dispose(): void }[] = [];
  beforeEach(() => { browser = createShellTestPage(); accountStore = memoryAccountStore(); });
  afterEach(() => { for (const each of made.splice(0)) each.dispose(); browser.dispose(); });

  /** `inApp`: a PC's app is open in the shell (its front page is not up), as `frontUp` says it */
  /** `pcs`: the account's directory, or what answers its read (one the test holds, say) */
  const controller = (list: AccountList, store: ShellDeviceStore, open?: (offer: unknown, options: Record<string, unknown>) => Promise<RelayTransport>, pcs: unknown[] | (() => Promise<unknown[]>) = [], inApp = false) => {
    const made_ = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", store, accountStore, accountService: SERVICE, accountList: list,
      ...(open === undefined ? {} : { open: open as never }),
      accountFetch: async (input) => new URL(new Request(input).url).pathname === "/v1/pcs" ? Response.json({ pcs: typeof pcs === "function" ? await pcs() : pcs }) : Response.json({ error: { code: "not_found" } }, { status: 404 }),
      renderApp: () => ({ render() {}, unmount() {} }),
    }, { active: () => !inApp, changed: async () => {}, outdated: () => new Set() });
    made.push(made_);
    return made_;
  };
  const signIn = async (account: string): Promise<string> => {
    const signedIn = session(account);
    await accountStore.set("session", signedIn);
    const key = await newKey();
    await accountStore.set("signin_key", { account, sign_in_id: signedIn.sign_in_id!, key, no: 2 });
    return key.public_spki;
  };
  const empty: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async () => { throw new Error("no pairing here"); } };

  it("a device that follows its moved list names it, with its vouch, to a PC that follows none", async () => {
    const signedIn = await signIn("acct-named");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-named", JSON.stringify({ v: 1, account: "acct-named", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const following = (): AccountListView => ({ account: "acct-named", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    let named: unknown = null;
    const { list } = listIn(following, async (given) => { named = given; return { naming: { list: "5c".repeat(32), key: "member", signature: "s".repeat(86) }, vouches: [] }; });
    const account = controller(list, empty);
    const unpinned = sessionOf({ key: signedIn });
    await account.sessionOpened(unpinned.opened, pc.offerKey);
    expect(named).toEqual({ account: "acct-named", session: signedIn, endpoint: pc.endpoint, signIn: signedIn });
    expect(unpinned.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["POST /api/account/list/name"]);
    // a PC that took account-list-1 follows a list already: it is named nothing
    const pinned = sessionOf({ key: signedIn, pinned: true });
    await account.sessionOpened(pinned.opened, pc.offerKey);
    expect(pinned.asked).toEqual([]);
  });

  it("a PC neither the account's directory nor this device's own record knows is named nothing and asked nothing (review U1)", async () => {
    const signedIn = await signIn("acct-stranger");
    const pc = pcKeys();
    const LIST = "5c".repeat(32);
    let named = 0;
    for (const status of [{ at: "following" as const, list: LIST, standing: "in" as const, head: 4, read_at: 1, trouble: null }, { at: "none" as const, why: "moving" as const, move: { why: "pcs_silent" as const, wait: 60, asks: [] } }]) {
      const { list } = listIn(() => ({ account: "acct-stranger", reached: true, status, devices: [], pcs: [] }), async () => { named += 1; return { naming: { list: LIST, key: "member", signature: "s".repeat(86) }, vouches: [] }; });
      const account = controller(list, empty);
      const one = sessionOf({ key: signedIn, answers: { "GET /api/account/list/witness": { account: "acct-other", pinned: null, admits: [], removed: [] } } });
      await account.sessionOpened(one.opened, pc.offerKey);
      expect(one.asked).toEqual([]);
    }
    expect(named).toBe(0);
    // the same PC, once the account's directory lists it, is named the list
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const { list } = listIn(() => ({ account: "acct-stranger", reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] }), async () => { named += 1; return { naming: { list: LIST, key: "member", signature: "s".repeat(86) }, vouches: [] }; });
    const account = controller(list, empty, undefined, [row]);
    await account.refresh(true);
    await settle();
    const listed = sessionOf({ key: signedIn });
    await account.sessionOpened(listed.opened, pc.offerKey);
    expect(named).toBe(1);
    expect(listed.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["POST /api/account/list/name"]);
  });

  it("a device in no moved list, and one with no list, says nothing to any PC", async () => {
    const signedIn = await signIn("acct-quiet");
    const pc = pcKeys();
    for (const status of [{ at: "off" as const }, { at: "none" as const, why: "not_new" as const }]) {
      const { list } = listIn(() => ({ account: "acct-quiet", reached: true, status, devices: [], pcs: [] }), async () => null);
      const account = controller(list, empty);
      const one = sessionOf({ key: signedIn });
      await account.sessionOpened(one.opened, pc.offerKey);
      expect(one.asked).toEqual([]);
    }
  });

  it("while it waits on its PCs, each PC its record knows is asked over a session of its own, and the list read again", async () => {
    await signIn("acct-asks");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-asks", JSON.stringify({ v: 1, account: "acct-asks", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    const said = { account: "acct-asks", pinned: null, admits: [], removed: [] };
    const asking = sessionOf({ answers: { "GET /api/account/list/witness": said } });
    const opened: unknown[] = [];
    const waiting = (): AccountListView => ({ account: "acct-asks", reached: true, status: { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [pc.endpoint] } }, devices: [], pcs: [] });
    const { list, tell, synced } = listIn(waiting);
    const account = controller(list, store, async (offer) => { opened.push(offer); return asking.opened; });
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened).toHaveLength(1);
    expect(asking.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["GET /api/account/list/witness"]);
    expect(asking.closed()).toBe(true);
    expect(pageAnswers.get("acct-asks", pc.endpoint)).toEqual(said);
    expect(synced()).toBeGreaterThan(0);
    // asked once: a second word from the list asks it no second time in this run
    tell();
    await settle();
    expect(opened).toHaveLength(1);
  });

  it("asks a PC through the account with this sign-in's key where the directory names it, before any saved pairing", async () => {
    const signedIn = await signIn("acct-through");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-through", JSON.stringify({ v: 1, account: "acct-through", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    const asking = sessionOf({ answers: { "GET /api/account/list/witness": { account: "acct-through", pinned: null, admits: [], removed: [] } } });
    const opened: { offer: { server_id: string; server_public_key: string }; options: Record<string, unknown> }[] = [];
    const waiting = (): AccountListView => ({ account: "acct-through", reached: true, status: { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [pc.endpoint] } }, devices: [], pcs: [] });
    const { list, tell } = listIn(waiting);
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const account = controller(list, store, async (offer, options) => { opened.push({ offer: offer as never, options }); return asking.opened; }, [row]);
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.offer).toMatchObject({ server_id: pc.serverId, server_public_key: pc.offerKey });
    expect(opened[0]!.options.accountOpensAll).toBe(true);
    expect(await (opened[0]!.options.store as ShellDeviceStore).get(pc.serverId)).toMatchObject({ public_spki: signedIn });
  });

  it("a carried device whose hand-over is not placed yet signs in to a PC of its list with its sign-in key, the key the list holds for it (R-E)", async () => {
    const signedIn = await signIn("acct-carried");
    const pc = pcKeys();
    const list = "5c".repeat(32);
    const row = (key: string, self: boolean) => ({ key, self, power: "full" as const, role: "drive" as const, until: null, carried: true, name: null });
    let selfKey = signedIn;
    const following = (): AccountListView => ({
      account: "acct-carried", reached: true, status: { at: "following", list, standing: "in", head: 4, read_at: 1, trouble: null },
      devices: [row(selfKey, true)], pcs: [{ endpoint: pc.endpoint, server_id: pc.serverId, how: "carried", allows: false, name: null, seq: 2, by: null, new_until: null, new_at: null } as never],
    });
    const { list: held } = listIn(following);
    const account = controller(held, empty);
    await account.refresh(true);
    await settle();
    expect(account.listKey?.public_spki).toBe(signedIn);
    expect(account.listHolds(pc.serverId)).toBe(true);
    expect(account.listSays(pc.serverId)).toBe("holds");
    // after its hand-over, the key the list holds for it is its account key
    selfKey = (await accountStore.key()).public_spki;
    expect(account.listKey?.public_spki).toBe(selfKey);
    // and a key the list holds for no device of its own opens nothing by the list
    selfKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5lhuexKpDRsxAK4WTOjTQTjBurzk0iGngvCpNGetUiwtppuB-SgVWvMwkHCQe6FNPoAzLJZntcFyjzv0sk82Bg";
    expect(account.listKey).toBeNull();
  });

  it("an ask in the background that gets no answer keeps the answer a session heard meanwhile (astra-migapp 5)", async () => {
    await signIn("acct-kept");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-kept", JSON.stringify({ v: 1, account: "acct-kept", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    const heard = { account: "acct-kept", pinned: "ab".repeat(32), admits: [], removed: [] };
    // this PC answers the background session nothing (a pairing's session), while a session of the shell heard it meanwhile
    const silent = sessionOf({});
    const waiting = (): AccountListView => ({ account: "acct-kept", reached: true, status: { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [pc.endpoint] } }, devices: [], pcs: [] });
    const { list, tell } = listIn(waiting);
    const account = controller(list, store, async () => { pageAnswers.set("acct-kept", pc.endpoint, heard); return silent.opened; });
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(silent.asked.map((one) => one.path)).toEqual(["/api/account/list/witness"]);
    expect(pageAnswers.get("acct-kept", pc.endpoint)).toEqual(heard);
  });

  it("a PC whose answer is why the move waits is asked again: an answer kept from before says nothing of now (astra-migapp, others)", async () => {
    const signedIn = await signIn("acct-again");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-again", JSON.stringify({ v: 1, account: "acct-again", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    // it answered: the device's key has been let in for less than a day there
    pageAnswers.set("acct-again", pc.endpoint, { account: "acct-again", pinned: null, admits: [], removed: [] });
    const fresh = { account: "acct-again", pinned: null, admits: [{ key: signedIn, wall: 90_000, ran: 30_000, idle: null }], removed: [] };
    const asking = sessionOf({ answers: { "GET /api/account/list/witness": fresh } });
    const waiting = (): AccountListView => ({ account: "acct-again", reached: true, status: { at: "none", why: "moving", move: { why: "too_new", wait: 600, asks: [] } }, devices: [], pcs: [] });
    const { list, tell } = listIn(waiting);
    const account = controller(list, store, async () => asking.opened);
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(asking.asked.map((one) => one.path)).toEqual(["/api/account/list/witness"]);
    expect(pageAnswers.get("acct-again", pc.endpoint)).toEqual(fresh);
  });

  /** A device with a PC it paired with in its record, a pairing saved for it, and what the background asks open. */
  const pairedPc = async (account: string) => {
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem(`ovis:seen-pcs:${account}`, JSON.stringify({ v: 1, account, pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    return { pc, store };
  };

  it("an account that waits on no PC opens no session to any in the background, whatever its PCs (review R02)", async () => {
    await signIn("acct-still");
    const { store } = await pairedPc("acct-still");
    const opened: unknown[] = [];
    for (const status of [{ at: "off" as const }, { at: "none" as const, why: "not_new" as const }, { at: "following" as const, list: "5c".repeat(32), standing: "in" as const, head: 4, read_at: 1, trouble: null }, { at: "none" as const, why: "moving" as const, move: { why: "sending" as const, wait: null, asks: [] } }]) {
      const { list, tell } = listIn(() => ({ account: "acct-still", reached: true, status, devices: [], pcs: [] }));
      const account = controller(list, store, async (offer) => { opened.push(offer); return sessionOf({}).opened; });
      await account.refresh(true);
      await settle();
      tell();
      await settle();
    }
    expect(opened).toEqual([]);
  });

  it("a PC asked again for why the device waits is asked once in ten minutes at most (review R04)", async () => {
    await signIn("acct-paced");
    const { pc, store } = await pairedPc("acct-paced");
    const opened: unknown[] = [];
    const said = { account: "acct-paced", pinned: null, admits: [], removed: [] };
    const waiting = (): AccountListView => ({ account: "acct-paced", reached: true, status: { at: "none", why: "moving", move: { why: "too_new", wait: 600, asks: [] } }, devices: [], pcs: [] });
    const { list, tell } = listIn(waiting);
    const account = controller(list, store, async (offer) => { opened.push(offer); return sessionOf({ answers: { "GET /api/account/list/witness": said } }).opened; });
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    tell();
    await settle();
    expect(opened).toHaveLength(1);
    expect(pageAnswers.get("acct-paced", pc.endpoint)).toEqual(said);
  });

  /**
   * F9 (staging): the device sits in the app of the PC it paired with. The shell opened that session before the device
   * waited on its PCs (its list not read yet, or the account then keeping none), so the session asked nothing.
   */
  const inThePcsApp = async (account: string, status: () => AccountListView["status"], said: unknown) => {
    await signIn(account);
    const { pc, store } = await pairedPc(account);
    const { list, tell, synced } = listIn(() => ({ account, reached: true, status: status(), devices: [], pcs: [] }));
    const asked: string[] = [];
    const made = controller(list, store, async () => {
      const one = sessionOf({ answers: { "GET /api/account/list/witness": said } });
      const fetch = one.opened.fetch.bind(one.opened);
      return Object.assign(one.opened, { fetch: (path: string, init?: RequestInit) => { asked.push(path); return fetch(path, init); } });
    }, [], true);
    await made.refresh(true);
    await settle();
    const app = sessionOf({ answers: { "GET /api/account/list/witness": said } });
    await made.sessionOpened(app.opened, pc.offerKey);
    expect(app.asked).toEqual([]);
    return { pc, tell, synced, asked };
  };

  it("F9: while a PC's app is open, the PCs are still asked in the background once the device waits on them", async () => {
    let status: AccountListView["status"] = { at: "none", why: "not_new" };
    const said = { account: "acct-in-app", pinned: null, admits: [], removed: [] };
    const held = await inThePcsApp("acct-in-app", () => status, said);
    status = { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [held.pc.endpoint] } };
    held.tell();
    await settle();
    expect(held.asked).toEqual(["/api/account/list/witness"]);
    expect(pageAnswers.get("acct-in-app", held.pc.endpoint)).toEqual(said);
    expect(held.synced()).toBeGreaterThan(0);
  });

  it("F9: a plan that comes out the same every round asks its PC again once the wait it told has run out, and no sooner than the re-ask gap", async () => {
    jest.useFakeTimers();
    try {
      let status: AccountListView["status"] = { at: "none", why: "not_new" };
      const held = await inThePcsApp("acct-repeats", () => status, { account: "acct-repeats", pinned: null, admits: [], removed: [] });
      // the PC answered: a key it lets in has been let in for less than a day, 15 minutes short
      status = { at: "none", why: "moving", move: { why: "too_new", wait: 900, asks: [] } };
      held.tell();
      await settle();
      expect(held.asked).toHaveLength(1);
      const read = held.synced();
      // the list's rounds come out the same: its view does not change, and nobody tells the controller
      jest.advanceTimersByTime(890_000);
      await settle();
      expect(held.asked).toHaveLength(1);
      jest.advanceTimersByTime(20_000);
      await settle();
      expect(held.asked).toHaveLength(2);
      expect(held.synced()).toBeGreaterThan(read);
      // the plan now waits with no time told (no PC it knows answered for the account): the PC just asked is asked
      // again after the ten minutes' gap, not sooner
      status = { at: "none", why: "moving", move: { why: "no_witness", wait: null, asks: [] } };
      held.tell();
      await settle();
      expect(held.asked).toHaveLength(2);
      jest.advanceTimersByTime(590_000);
      await settle();
      expect(held.asked).toHaveLength(2);
      jest.advanceTimersByTime(20_000);
      await settle();
      expect(held.asked).toHaveLength(3);
    } finally { jest.useRealTimers(); }
  });

  it("F9: the list's first round on a page comes before the directory: a PC the device also paired with is still asked through the account, not over the pairing it refuses", async () => {
    await signIn("acct-first-round");
    const { pc, store } = await pairedPc("acct-first-round");
    const waiting = (): AccountListView => ({ account: "acct-first-round", reached: true, status: { at: "none", why: "moving", move: { why: "no_witness", wait: null, asks: [pc.endpoint] } }, devices: [], pcs: [] });
    const { list, tell } = listIn(waiting);
    // the round this page's first read of the sign-in starts publishes where the device stands, as a real one does
    const round = list.sync;
    Object.assign(list, { sync: async () => { tell(); return round(); } });
    const said = { account: "acct-first-round", pinned: null, admits: [], removed: [] };
    const opened: { accountOpensAll: boolean }[] = [];
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const account = controller(list, store, async (_offer, options) => {
      opened.push({ accountOpensAll: options.accountOpensAll === true });
      // the PC answers the witness to a session of its account alone (server/account/routes.ts)
      return sessionOf(options.accountOpensAll === true ? { answers: { "GET /api/account/list/witness": said } } : {}).opened;
    }, [row], true);
    await account.refresh(true);
    await settle();
    expect(opened).toEqual([{ accountOpensAll: true }]);
    expect(pageAnswers.get("acct-first-round", pc.endpoint)).toEqual(said);
  });

  it("#4723 review T8: a controller disposed while its read of the directory is under way asks no PC when that read ends", async () => {
    await signIn("acct-disposed-read");
    const { store } = await pairedPc("acct-disposed-read");
    const waiting = (): AccountListView => ({ account: "acct-disposed-read", reached: true, status: { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [] } }, devices: [], pcs: [] });
    const { list } = listIn(waiting);
    const directory = deferred<unknown[]>();
    const opened: unknown[] = [];
    const account = controller(list, store, async (offer) => { opened.push(offer); return sessionOf({}).opened; }, () => directory.promise);
    const read = account.refresh(true);
    await settle();
    account.dispose();
    directory.resolve([]);
    await read;
    await settle();
    expect(opened).toEqual([]);
  });

  it("#4723 review T9: on the front page a refresh every minute asks the PC again only once the wait the plan told has run out", async () => {
    jest.useFakeTimers();
    try {
      await signIn("acct-front-told");
      const { store } = await pairedPc("acct-front-told");
      const said = { account: "acct-front-told", pinned: null, admits: [], removed: [] };
      // the PC answered: a key it lets in has been let in for less than a day, 15 minutes short
      const waiting = (): AccountListView => ({ account: "acct-front-told", reached: true, status: { at: "none", why: "moving", move: { why: "too_new", wait: 900, asks: [] } }, devices: [], pcs: [] });
      const { list, tell } = listIn(waiting);
      const opened: unknown[] = [];
      const account = controller(list, store, async (offer) => { opened.push(offer); return sessionOf({ answers: { "GET /api/account/list/witness": said } }).opened; });
      await account.refresh(true);
      await settle();
      tell();
      await settle();
      expect(opened).toHaveLength(1);
      // the front page reads its account again every minute; each read asks whoever is due
      for (let minute = 1; minute <= 14; minute++) { jest.advanceTimersByTime(60_000); await settle(); }
      expect(opened).toHaveLength(1);
      for (let minute = 15; minute <= 17; minute++) { jest.advanceTimersByTime(60_000); await settle(); }
      expect(opened).toHaveLength(2);
    } finally { jest.useRealTimers(); }
  });

  /** A device that waits on its PCs, asked once in the background; the fake clock is the test's to move. */
  const waitingAsked = async (name: string, inApp = false) => {
    await signIn(name);
    const { store } = await pairedPc(name);
    const { list, tell } = listIn(() => ({ account: name, reached: true, status: { at: "none", why: "moving", move: { why: "no_witness", wait: null, asks: [] } }, devices: [], pcs: [] }));
    const opened: unknown[] = [];
    const made = controller(list, store, async (offer) => { opened.push(offer); return sessionOf({ answers: { "GET /api/account/list/witness": { account: name, pinned: null, admits: [], removed: [] } } }).opened; }, [], inApp);
    await made.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened).toHaveLength(1);
    return { made, opened };
  };

  it("#4713 M3: a disposed controller asks no PC again on its clock", async () => {
    jest.useFakeTimers();
    try {
      const { made, opened } = await waitingAsked("acct-disposed");
      made.dispose();
      jest.advanceTimersByTime(3_600_000);
      await settle();
      expect(opened).toHaveLength(1);
    } finally { jest.useRealTimers(); }
  });

  it("#4713 M2: once the device signs out, its clock asks none of the old account's PCs, even while its list still shows the move", async () => {
    jest.useFakeTimers();
    try {
      const { made, opened } = await waitingAsked("acct-signed-out");
      made.signOut();
      jest.advanceTimersByTime(3_600_000);
      await settle();
      expect(opened).toHaveLength(1);
    } finally { jest.useRealTimers(); }
  });

  it("#4713 M3: on a hidden page the clock asks nothing, and asks once the page is shown again", async () => {
    jest.useFakeTimers();
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    try {
      const { opened } = await waitingAsked("acct-hidden");
      state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      jest.advanceTimersByTime(30 * 60_000);
      await settle();
      expect(opened).toHaveLength(1);
      // shown again: the page reads its account again, and the PC, due long since, is asked at once
      state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(opened).toHaveLength(2);
    } finally {
      jest.useRealTimers();
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  /**
   * F10 (staging): the device that moved the account is paired with its PC too, and the shell opens a PC it is paired
   * with by that pairing, whose naming the PC does not take (a pairing is no key it let in through the account). So the
   * device names its list over a session of its own through the account, the one way its naming counts.
   */
  const movedWithPairing = async (account: string, answers: { pinned: string | null }[], nameAnswer: unknown = { pinned: false, why: "session_new", wait: 60 }) => {
    const signedIn = await signIn(account);
    const { pc, store } = await pairedPc(account);
    const LIST = "5c".repeat(32);
    const named: unknown[] = [];
    const following = (): AccountListView => ({ account, reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    const { list, tell } = listIn(following, async (given) => { named.push(given); return { naming: { list: LIST, key: "member", signature: "s".repeat(86) }, vouches: [] }; });
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const opened: { accountOpensAll: boolean; asked: () => string[] }[] = [];
    const made = controller(list, store, async (_offer, options) => {
      const said = answers[Math.min(opened.length, answers.length - 1)]!;
      const one = sessionOf({ key: signedIn, answers: { "GET /api/account/list/witness": { account, pinned: said.pinned, admits: [], removed: [] }, "POST /api/account/list/name": nameAnswer } });
      opened.push({ accountOpensAll: options.accountOpensAll === true, asked: () => one.asked.map((call) => `${call.method} ${call.path}`) });
      return one.opened;
    }, [row], true);
    await made.refresh(true);
    await settle();
    tell();
    await settle();
    return { pc, signedIn, LIST, named, opened };
  };

  it("F10: after its move, a device names its list over a session through the account to a PC it is paired with, never over the pairing", async () => {
    const { pc, signedIn, named, opened } = await movedWithPairing("acct-name-way", [{ pinned: null }]);
    expect(opened.map((one) => one.accountOpensAll)).toEqual([true]);
    expect(opened[0]!.asked()).toEqual(["GET /api/account/list/witness", "POST /api/account/list/name"]);
    // signed for that session's key, the sign-in key the PC lets in through the account, which vouches for itself
    expect(named).toEqual([{ account: "acct-name-way", session: signedIn, endpoint: pc.endpoint, signIn: signedIn }]);
  });

  it("F10: a PC that says it follows the list is named nothing more, and asked again only on the gap", async () => {
    jest.useFakeTimers();
    try {
      const { LIST, opened } = await movedWithPairing("acct-name-done", [{ pinned: null }, { pinned: "5c".repeat(32) }]);
      expect(opened).toHaveLength(1);
      jest.advanceTimersByTime(11 * 60_000);
      await settle();
      expect(opened).toHaveLength(2);
      expect(opened[1]!.asked()).toEqual(["GET /api/account/list/witness"]);
      expect(LIST).toBe("5c".repeat(32));
      // it follows the list now: nothing more on the clock
      jest.advanceTimersByTime(60 * 60_000);
      await settle();
      expect(opened).toHaveLength(2);
    } finally { jest.useRealTimers(); }
  });

  /** How many sessions the asker opened, and how many of them named the list, after `hours` of a page left up. */
  const leftUp = async (opened: { asked: () => string[] }[], hours: number) => {
    for (let step = 0; step < hours * 6; step++) { jest.advanceTimersByTime(10 * 60_000 + 1_000); await settle(); }
    return { sessions: opened.length, named: opened.filter((one) => one.asked().includes("POST /api/account/list/name")).length };
  };

  it("#4723 naming review L1: a PC that refuses the naming for a cause no wait changes is named once in this run of the page", async () => {
    jest.useFakeTimers();
    try {
      for (const why of ["first_signer_unknown", "first_signer_removed", "named_here", "lists_full", "removed"]) {
        const { opened } = await movedWithPairing(`acct-l1-${why}`, [{ pinned: null }], { pinned: false, why, wait: null });
        expect(await leftUp(opened, 3)).toEqual({ sessions: 1, named: 1 });
      }
    } finally { jest.useRealTimers(); }
  });

  it("#4723 naming review L1: a refusal with a wait is named again only once that wait is over, and on the gap after it", async () => {
    jest.useFakeTimers();
    try {
      const { opened } = await movedWithPairing("acct-l1-wait", [{ pinned: null }], { pinned: false, why: "session_new", wait: 3_600 });
      expect(opened).toHaveLength(1);
      expect(await leftUp(opened, 0.5)).toEqual({ sessions: 1, named: 1 });
      expect(await leftUp(opened, 0.7)).toEqual({ sessions: 2, named: 2 });
    } finally { jest.useRealTimers(); }
  });

  it("#4723 naming review L1: a PC that follows another list, or answers no witness, is named nothing and not asked again in this run", async () => {
    jest.useFakeTimers();
    try {
      const other = await movedWithPairing("acct-l1-other", [{ pinned: "6d".repeat(32) }]);
      expect(await leftUp(other.opened, 2)).toEqual({ sessions: 1, named: 0 });
    } finally { jest.useRealTimers(); }
  });

  /** A moved device and its paired PC whose witness answers the first session as `first` says, and every later one at once. */
  const witnessFirst = async (account: string, first: () => Response | "lost") => {
    const signedIn = await signIn(account);
    const { pc, store } = await pairedPc(account);
    const LIST = "5c".repeat(32);
    const following = (): AccountListView => ({ account, reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    const { list, tell } = listIn(following, async () => ({ naming: { list: LIST, key: "member", signature: "s".repeat(86) }, vouches: [] }));
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const opened: { asked: () => string[] }[] = [];
    const made = controller(list, store, async () => {
      const said = opened.length === 0 ? first() : { account, pinned: null, admits: [], removed: [] };
      const one = sessionOf({ key: signedIn, answers: { ...(said === "lost" ? {} : { "GET /api/account/list/witness": said }), "POST /api/account/list/name": { pinned: true, list: LIST } } });
      opened.push({ asked: () => one.asked.map((call) => `${call.method} ${call.path}`) });
      if (said !== "lost") return one.opened;
      // the carrier drops under the witness's request
      const fetch = one.opened.fetch.bind(one.opened);
      return Object.assign(one.opened, { fetch: async (path: string, init?: RequestInit) => { await fetch(path, init); throw new TypeError("the carrier dropped"); } });
    }, [row], true);
    await made.refresh(true);
    await settle();
    tell();
    await settle();
    return opened;
  };

  it("#4723 naming review (closure): a witness that asks to be asked later, is over its budget or is lost on the way is asked again on the gap", async () => {
    jest.useFakeTimers();
    try {
      for (const [name, first] of [
        ["503", () => Response.json({ error: { code: "witness_unavailable" } }, { status: 503 })],
        ["429", () => Response.json({ error: { code: "rate_limited" } }, { status: 429 })],
        ["lost", () => "lost" as const],
      ] as const) {
        const opened = await witnessFirst(`acct-l1-again-${name}`, first);
        expect(opened.map((one) => one.asked())).toEqual([["GET /api/account/list/witness"]]);
        const after = await leftUp(opened, 0.25);
        expect(after.named).toBe(1);
      }
    } finally { jest.useRealTimers(); }
  });

  it("#4723 naming review (closure): a PC with no witness route, or one that says the session is no account's, is named nothing more in this run", async () => {
    jest.useFakeTimers();
    try {
      for (const [name, first] of [
        ["404", () => Response.json({ error: { code: "not_found" } }, { status: 404 })],
        ["403", () => Response.json({ error: { code: "account_required" } }, { status: 403 })],
      ] as const) {
        const opened = await witnessFirst(`acct-l1-final-${name}`, first);
        expect(await leftUp(opened, 2)).toEqual({ sessions: 1, named: 0 });
      }
    } finally { jest.useRealTimers(); }
  });

  /** A moved device whose naming, or whose witness ask, waits until the test lets it go. */
  const namingHeld = async (account: string, hold: "naming" | "witness") => {
    const signedIn = await signIn(account);
    const { pc, store } = await pairedPc(account);
    const LIST = "5c".repeat(32);
    const naming = Promise.withResolvers<void>();
    const witness = Promise.withResolvers<void>();
    const following = (): AccountListView => ({ account, reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    const { list, tell } = listIn(following, async () => {
      if (hold === "naming") await naming.promise;
      return { naming: { list: LIST, key: "member", signature: "s".repeat(86) }, vouches: [] };
    });
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const sessions: ReturnType<typeof sessionOf>[] = [];
    const made = controller(list, store, async () => {
      const said = { account, pinned: null, admits: [], removed: [] };
      const one = sessionOf({ key: signedIn, answers: {
        "GET /api/account/list/witness": hold === "witness" ? witness.promise.then(() => Response.json(said)) : said,
        "POST /api/account/list/name": { pinned: true, list: LIST },
      } });
      sessions.push(one);
      return one.opened;
    }, [row], true);
    await made.refresh(true);
    await settle();
    tell();
    await settle();
    return { made, sessions, release: () => { naming.resolve(); witness.resolve(); } };
  };

  it("#4735 review U12: a controller disposed while the naming is signed opens no session and names nothing", async () => {
    const { made, sessions, release } = await namingHeld("acct-u12-naming", "naming");
    made.dispose();
    release();
    await settle();
    expect(sessions).toEqual([]);
  });

  it("#4735 review U12: a controller disposed while its session asks the witness closes that session and names nothing", async () => {
    const { made, sessions, release } = await namingHeld("acct-u12-witness", "witness");
    expect(sessions).toHaveLength(1);
    made.dispose();
    expect(sessions[0]!.closed()).toBe(true);
    release();
    await settle();
    expect(sessions[0]!.asked.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/account/list/witness"]);
  });

  it("F10: a PC the directory gives no way through the account is named nothing over its pairing", async () => {
    const signedIn = await signIn("acct-name-paired-only");
    const { store } = await pairedPc("acct-name-paired-only");
    const LIST = "5c".repeat(32);
    const following = (): AccountListView => ({ account: "acct-name-paired-only", reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    const { list, tell } = listIn(following, async () => ({ naming: { list: LIST, key: "member", signature: "s".repeat(86) }, vouches: [] }));
    const opened: unknown[] = [];
    const made = controller(list, store, async (offer) => { opened.push(offer); return sessionOf({ key: signedIn }).opened; }, [], true);
    await made.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened).toEqual([]);
  });

  it("a carried device that follows its list without a doubt asks only the PCs that have not agreed yet", async () => {
    await signIn("acct-check");
    const one = pcKeys();
    const two = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-check", JSON.stringify({ v: 1, account: "acct-check", pcs: { [one.endpoint]: { since: at, last: at, how: "paired" }, [two.endpoint]: { since: at, last: at, how: "paired" } } }));
    const pairing = (pc: ReturnType<typeof pcKeys>) => ({ server_id: pc.serverId, device_id: "dev-1", private_key: null, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" }) as unknown as RelayDevice;
    const pairings = [pairing(one), pairing(two)];
    const store: ShellDeviceStore = { ...empty, get: async (id) => pairings.find((row) => row.server_id === id), list: async () => pairings };
    pageAnswers.set("acct-check", one.endpoint, { account: "acct-check", pinned: "5c".repeat(32), admits: [], removed: [] });
    pageAnswers.set("acct-check", two.endpoint, { account: "acct-check", pinned: null, admits: [], removed: [] });
    const opened: { server_public_key: string }[] = [];
    const following = (): AccountListView => ({ account: "acct-check", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 4, read_at: 1, trouble: null, asks: [two.endpoint] }, devices: [], pcs: [] });
    const { list, tell } = listIn(following);
    const account = controller(list, store, async (offer) => { opened.push(offer as never); return sessionOf({}).opened; });
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened.map((offer) => offer.server_public_key)).toEqual([two.offerKey]);
  });

  it("a PC that lets the account's devices in by the list alone is asked again in the background with the list key (#4652)", async () => {
    await signIn("acct-listed");
    const pc = pcKeys();
    const list = "5c".repeat(32);
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-listed", JSON.stringify({ v: 1, account: "acct-listed", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const member = (await accountStore.key()).public_spki;
    // a carried device after its hand-over: in its list by its account key, still asking the PC that has not agreed
    const following = (): AccountListView => ({
      account: "acct-listed", reached: true, status: { at: "following", list, standing: "in", head: 4, read_at: 1, trouble: null, asks: [pc.endpoint] },
      devices: [{ key: member, self: true, power: "full", role: "drive", until: null, carried: true, name: null }], pcs: [],
    });
    const { list: held, tell } = listIn(following);
    const said = { account: "acct-listed", pinned: list, admits: [], removed: [] };
    const opened: { listKey: boolean; key: string | undefined }[] = [];
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const account = controller(held, empty, async (offer, options) => {
      const store = options.store as ShellDeviceStore;
      opened.push({ listKey: options.accountListKey === true, key: (await store.get((offer as { server_id: string }).server_id))?.public_spki });
      // the PC follows the list: a sign-in key the list no longer holds is refused for it
      if (options.accountListKey !== true) throw new MuxProtocolError("account_list_required", "the PC lets the account's devices in by its list");
      return sessionOf({ answers: { "GET /api/account/list/witness": said } }).opened;
    }, [row]);
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened.map((one) => one.listKey)).toEqual([false, true]);
    expect(opened[1]!.key).toBe(member);
    expect(pageAnswers.get("acct-listed", pc.endpoint)).toEqual(said);
  });
});
