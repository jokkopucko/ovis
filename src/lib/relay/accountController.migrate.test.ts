import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
      return said === undefined ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json(said);
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

  const controller = (list: AccountList, store: ShellDeviceStore, open?: (offer: unknown, options: Record<string, unknown>) => Promise<RelayTransport>, pcs: unknown[] = []) => {
    const made_ = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", store, accountStore, accountService: SERVICE, accountList: list,
      ...(open === undefined ? {} : { open: open as never }),
      accountFetch: async (input) => new URL(new Request(input).url).pathname === "/v1/pcs" ? Response.json({ pcs }) : Response.json({ error: { code: "not_found" } }, { status: 404 }),
      renderApp: () => ({ render() {}, unmount() {} }),
    }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
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
