/**
 * A device and a pinned PC say where their account's signed list stands over the app's own session
 * (account/listGossip.ts), end to end: the app's channel and relay transport on one side; a real PC with its copy of the
 * list and its two session routes on the other; the account service in memory with a tamper mode between them. A
 * removal the service withholds from the PC reaches it from the device, and two histories members signed raise the
 * alarm on both sides. A PC that follows no list is asked nothing.
 */
import { afterEach, describe, expect, it, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { listMember, TestList, type ListMember } from "../../../server/account/list.test-helpers.ts";
import { pairingPc, type Pc } from "../../../server/account/pairing.test-helpers.ts";
import { RelaySession } from "../../../server/relay/session.ts";
import { bounded } from "../../../server/relay/test-helpers.ts";
import type { RelayChannelOptions } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair, importPublicKey, openDaemonSecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { accountList, type AccountList } from "../account/accountList.ts";
import { deliverOnce, gossipBudget, gossipWithPc, keepListGossip, type GossipSession } from "../account/listGossip.ts";
import { kindBody } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import { admitsSession, ATTEMPT_ENTRIES_MAX, compareHeads, gossipHead, pinList, readSave, servePage, startRead, takePage, type FollowerCopy, type FollowRead, type ListPage } from "../../../shared/account-list-follower.ts";
import { addListPc, listWorld, type WorldDevice } from "../account/accountList.test-helpers.ts";
import { allowDevice } from "../account/listAllow.ts";
import { removeListPc } from "../account/listRemove.ts";
import type { PcFetch } from "../account/join.ts";
import { deviceListKeys } from "../account/listKeys.ts";
import { memoryListLock, memoryListStore } from "../account/listStore.ts";
import { signedOn, writeToList } from "../account/listWrite.ts";
import { AccountService } from "../account/service.ts";
import { memoryAccountStore, memoryLock } from "../account/store.ts";
import { openRelayChannel, type RelaySocket } from "./channel.ts";
import { MemoryDeviceStore } from "./device.test.ts";
import { openRelayTransport } from "./transport.ts";

const ACCOUNT = "acct_1";
const TOKEN = "list-gossip-token";
const own = { authorization: `Bearer ${TOKEN}` };
const noWait = { wait: async () => {} };

const pcs: Pc[] = [];
const closes: (() => void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) close();
  for (const pc of pcs.splice(0)) await pc.close();
});

/** The carrier between the app's channel and the PC's session: what one sends, the other hears. */
class Carrier implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  closed = false;
  get readyState(): number { return this.closed ? 3 : 1; }
  constructor(readonly daemon: Transport) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.closed) throw new Error("Socket closed");
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) throw new Error("Unexpected carrier type");
    this.daemon.onmessage?.({ data, isBinary: typeof data !== "string" });
  }
  deliver(data: string | ArrayBuffer): void {
    if (!this.closed) this.onmessage?.(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.daemon.onclose?.(code, reason);
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

/**
 * A PC a person added to the account, pinned to its list unless `pin` is false, and an app that is a device of that
 * list (with a laptop beside it), signed in to the PC with the key the list holds for it.
 */
async function rig(options: { pin?: boolean } = {}) {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  pcs.push(made);
  const local = (path: string, body: unknown, header: string) => made.local(path, { method: "POST", headers: { ...own, [header]: "1" }, body });
  if ((await local("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  const { services } = made.app.context;
  const identity = services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  if ((await local("/api/account/relay-account", { account: ACCOUNT }, "x-herdr-machine")).status !== 204) throw new Error("The account was not named");
  const token = made.account.issueToken(ACCOUNT, { twoStep: true });
  const call = (path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" } : {}) }));
  await call(`/v1/pcs/${identity.server_id}`, "PUT");
  await call(`/v1/pcs/${identity.server_id}/admit`, "POST");
  const pressed = await local("/api/account/one-press", { account: ACCOUNT }, "x-herdr-machine");
  if (pressed.status !== 200) throw new Error(`The PC was not added: ${pressed.status} ${JSON.stringify(pressed.body)}`);
  const list = services.accountList!;
  const pull = async (): Promise<void> => { await services.accountMailbox.pull(); await list.settled(); };
  const account = await TestList.start(made.account, ACCOUNT);

  // the app: its own copy of the account's list, and its keys, in the list before the PC pins it, with a laptop beside it
  const store = memoryAccountStore();
  await store.set("session", { service: "https://account.test", account: ACCOUNT, provider: "github", access_token: made.account.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "r", expires_at: Date.now() + 3_600_000, sign_in_id: "member", signed_in_at: Date.now() });
  const service = new AccountService({ store, fetch: made.account.fetch, lock: memoryLock() });
  const member: AccountList = accountList({ service, accountStore: store, listStore: memoryListStore(), lock: memoryListLock(), genesis: () => "never", durable: async () => true, names: () => ({ label: "Member", os: "ios" }) });
  const keys = await deviceListKeys(store);
  await account.addDevice({ key: keys.key, enc: keys.enc.key, keys: { privateKey: keys.signs } } as unknown as ListMember);
  const laptop = await listMember();
  await account.addDevice(laptop);
  expect((await member.adopt({ list: account.id, ...account.place })).status).toMatchObject({ at: "following", standing: "in" });

  await pull();
  if (options.pin !== false) {
    await list.wantList(account.id);
    await account.addPostedPc(endpoint);
    await pull();
    expect(list.status()).toMatchObject({ pinned: true, standing: "in" });
    await member.sync();
  }

  const serverId = identity.server_id;
  const e2ee = generateKeyPair();
  const offer = { v: 1 as const, server_id: serverId, server_public_key: exportPublicKey(e2ee.publicKey), relay: "wss://relay.example" };
  /** The app opens a channel to the PC, as shell.tsx does for a sign-in. */
  const open = (channel: Omit<RelayChannelOptions, "socket">) => {
    let session: RelaySession | undefined;
    let carrier: Carrier;
    const daemon: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => carrier.deliver(data),
      close: (code, reason) => { setImmediate(() => carrier.close(code, reason)); },
    };
    carrier = new Carrier(daemon);
    closes.push(() => carrier.close());
    const early: (string | ArrayBuffer)[] = [];
    void openDaemonSecureChannel(daemon, { daemonKeyPair: e2ee, events: { onmessage: (data) => { if (session) session.receive(data); else early.push(data); } } }).then((secure) => {
      session = new RelaySession({ channel: secure, services, port: made.app.port, serverId, serverVersion: "0.4.20", minSupportedClient: "0.4.20", routingOverhead: 0, maxWireMessageBytes: 64 * 1024 });
      for (const data of early.splice(0)) session.receive(data);
    }, () => {});
    const opening = openRelayChannel(offer, { ...channel, socket: () => { queueMicrotask(() => carrier.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return carrier; } });
    void opening.catch(() => {});
    return opening;
  };
  /**
   * A device of the list signs in to the PC with its list key, as the app does, over a relay transport: through the
   * account on a pinned PC, and by a pairing the PC made itself (`ovis pair`) on one that follows no list.
   */
  const signIn = async (signs: CryptoKey, key: string) => {
    let device = accountDevice(offer, { private_key: signs, public_spki: key });
    if (options.pin === false) {
      const paired = services.devices.pairRelay(services.devices.startPairing().code, "Member", key);
      if (paired === null) throw new Error("The PC did not pair the device");
      device = { ...device, device_id: paired.device.id };
    }
    const transport = await bounded(openRelayTransport(offer, {
      store: withAccountDevice(new MemoryDeviceStore(), device), accountListKey: options.pin !== false,
      openChannel: (_offer, config) => { const { socket: _carrier, ...rest } = config as RelayChannelOptions; return open(rest); },
    }), 10_000);
    closes.push(() => transport.close());
    return transport;
  };
  const app = await signIn(keys.signs, keys.key);
  /** Every request the app's session sends the PC, by path. */
  const sent: string[] = [];
  const session = {
    get followsList() { return app.followsList; },
    get route() { return app.route; },
    fetch: (input: string, init?: RequestInit) => { sent.push(input); return app.fetch(input, init); },
    onRouteChange: (listener: () => void) => app.onRouteChange(listener),
  };
  return { made, services, account, member, keys, laptop, serverId, pull, open, signIn, app, session, sent };
}

/** Polls `done` to a deadline: the exchanges run on their own. */
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}


test("R1: a loose entry the service shows the PC above the place the device removed at keeps the removal from it", async () => {
  const { made, services, account, member, laptop, serverId, pull, signIn, session, sent } = await rig();
  const list = services.accountList!;
  const held = list.status().head!;
  const before = await signIn(laptop.keys.privateKey, laptop.key);
  expect(before.followsList).toBe(true);
  before.close();
  // the service withholds what follows `held` from the PC, and shows it one entry of a key that is no member (loose)
  const stranger = await listMember();
  const loose = await account.sign({ kind: "remove", ends: laptop.key }, stranger, held);
  made.account.tamperList(account.id, { reader: { server_id: serverId }, withholdAfter: held.seq, inject: [loose] });
  await pull();
  // the PC's footing is where it was: the loose entry lets nobody in or out
  expect(list.status().head).toEqual(held);
  const stop = keepListGossip(session, { list: () => member, pc: serverId });
  closes.push(stop);
  await until(() => sent.length >= 1);
  const removed = await writeToList(member, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: laptop.key }]) }), noWait);
  expect(removed.written).toBe(true);
  await pull();
  // give the exchange that the head move starts every chance to finish
  const was = sent.length;
  await until(() => sent.length > was).catch(() => undefined);
  // the exchange the head move started hands the PC the removal: its footing moves past `held`
  await until(() => (list.status().head?.seq ?? 0) > held.seq);
  // the PC's own head answer: its footing is `held`, and it asks for what follows the loose entry above it
  // RIGHT: the device hands the PC its removal (from the PC's footing), and the PC lets the laptop in no more
  await pull();
  await expect(signIn(laptop.keys.privateKey, laptop.key)).rejects.toThrow();
  expect(list.status().head).toEqual(member.gossip()!.place);
}, 40_000);

// ---------------------------------------------------------------------------------------------------------------
// Unit sequences (the app's own pieces against a PC in memory that answers as server/account/list-follow.ts does)
// ---------------------------------------------------------------------------------------------------------------

type World = ReturnType<typeof listWorld>;
const seconds = (w: World): number => Math.floor(w.clock.now / 1000);
const hashOf = (text: string): string => entryHash(entryFromText(text).body);
const always = (): boolean => true;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers });

/** An account with two devices in its list and a PC the first one added (as listGossip.test.ts builds it). */
async function world(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const outcome = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, noWait);
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  await second.list.adopt(outcome.offer);
  const desk = await addListPc(w, first, "Desk");
  await second.list.sync();
  return { w, first, second, desk };
}

/** Another history from entry 1 that `by` signed and that is no post left behind (more entries than one post holds). */
async function otherHistory(w: World, by: WorldDevice): Promise<string[]> {
  const keys = await by.keys();
  const { id } = w.held();
  const texts: string[] = [];
  let head = { seq: 0, hash: id };
  for (let index = 0; index <= ATTEMPT_ENTRIES_MAX; index += 1) {
    const endpoint = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const body = kindBody({ issued_at: seconds(w), list: id, prev: head.hash, seq: head.seq + 1, signer: keys.key }, { kind: "carried", endpoint, sealed: null });
    const text = entryToText(await signEntry(body, keys.signs));
    texts.push(text);
    head = { seq: head.seq + 1, hash: hashOf(text) };
  }
  return texts;
}

/** A PC in memory that holds `texts` and answers /head and /page as a pinned PC does (peerHeads, takePeerPage). */
async function memoryPc(w: World, texts: readonly string[]) {
  const list = hashOf(texts[0]!);
  const pinned = pinList(null, { account: w.account, list, me: { key: readBody(entryFromText(texts[0]!).body).signer, endpoint: null }, pin: { how: "genesis" } });
  if (!pinned.pinned) throw new Error("the PC could not pin the list");
  const top = texts.length - 1;
  let copy: FollowerCopy = (await takePage(pinned.copy, startRead(pinned.copy, "service"), { entries: texts, head: { seq: top, hash: top === 0 ? list : hashOf(texts[top]!) } }, seconds(w))).copy;
  let kept: FollowRead | null = null;
  const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const pc = {
    calls,
    copy: () => copy,
    fetch: (async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
      calls.push({ path, body });
      const own = gossipHead(copy);
      if (path === "/api/account/list/head") {
        const compared = compareHeads(copy, { list: body.list as string, place: body.place as never });
        if (compared.verdict === "not_my_list") return json(own);
        const asks = body.asks as { list: string; after: number | null } | undefined;
        const served = asks !== undefined && asks.list === copy.list ? servePage(copy, asks, 256) : null;
        if (compared.verdict === "ahead") {
          const page = served ?? servePage(copy, { list: copy.list, after: (body.place as { seq: number } | null)?.seq ?? null }, 256);
          return json(page === null ? own : { ...own, page });
        }
        const answered = served === null ? own : { ...own, page: served };
        if (compared.read === null) return json(answered);
        kept = compared.read;
        return json({ ...answered, asks: { list: compared.read.list, after: compared.read.after } });
      }
      if (path === "/api/account/list/page") {
        const after = body.after as number | null;
        const read: FollowRead = kept !== null && kept.after === after ? kept : { ...startRead(copy, "peer"), after };
        const took = await takePage(copy, read, body as unknown as ListPage, seconds(w));
        copy = took.copy;
        kept = took.read;
        return json({ verdict: took.verdict, ...(took.read === null ? {} : { asks: { list: took.read.list, after: took.read.after } }), ...gossipHead(copy) });
      }
      return json({ error: { code: "not_found" } }, 404);
    }) as PcFetch,
  };
  return pc;
}

/** A session with `pc` as the relay transport gives it. */
function sessionOf(pc: { fetch: PcFetch }, route: "relay" | undefined = "relay"): GossipSession & { up(on: boolean): void } {
  const listeners = new Set<() => void>();
  const session = {
    followsList: true,
    route: route as "relay" | "direct" | undefined,
    fetch: (input: string, init?: RequestInit) => pc.fetch(input, init),
    onRouteChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    up(on: boolean) { session.route = on ? "relay" : undefined; for (const listener of [...listeners]) listener(); },
  };
  return session;
}

/** Another tab of the same browser over the same stores and sign-in. */
function otherTab(w: World, of: WorldDevice): AccountList {
  return accountList({
    service: of.service, accountStore: of.store, listStore: of.lists, lock: memoryListLock(), now: () => w.clock.now,
    names: () => ({ label: "Other tab", os: "ios" }), linkedPcs: async () => 0, genesis: () => "first-device", durable: async () => true,
  });
}

describe("R2: the one attempt to hand the open PC its removal (deliverOnce)", () => {
  it("is made over a session whose carrier comes back within its 3 s, as after the phone wakes", async () => {
    const { w, first, desk } = await world();
    const pc = await memoryPc(w, w.held().entries);
    // the device learns the PC is out while the session's carrier is down (the list's read answered before the relay)
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const session = sessionOf(pc);
    session.up(false);
    setTimeout(() => { session.up(true); }, 200);
    await deliverOnce(session, first.list, gossipBudget("r2", { storage: null }), 3_000);
    // RIGHT: the PC is handed the removal over the session that came back
    expect(pc.calls.map((call) => call.path)).toContain("/api/account/list/page");
    expect(gossipHead(pc.copy())).toEqual(first.list.gossip()!);
  });
});

describe("R4: the one attempt and the minute's budget", () => {
  it("is not skipped because the session's 24 calls of the minute are spent: the PC takes 30", async () => {
    const { w, first, desk } = await world();
    const pc = await memoryPc(w, w.held().entries);
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    let clock = 1_000_000;
    const budget = gossipBudget("r4", { storage: null, now: () => clock });
    for (let call = 0; call < 24; call += 1) expect(budget.spend()).toBe(true);
    await deliverOnce(sessionOf(pc), first.list, budget, 3_000);
    // RIGHT: the removal goes out within the PC's own 30 (or the attempt waits for a call inside its 3 s)
    expect(pc.calls.map((call) => call.path)).toContain("/api/account/list/page");
  });
});

describe("R5: a 429's wait and the wall clock", () => {
  it("a wall clock set back does not stretch a 60 s wait to hours, for every tab and reopening of that PC", () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
    let clock = 1_800_000_000_000;
    const budget = gossipBudget("desk:key", { storage, now: () => clock });
    budget.pause(60_000);
    // the wall clock is set back six hours (a clock that ran ahead is corrected)
    clock -= 6 * 3_600_000;
    // RIGHT: no longer than the PC asked for
    expect(budget.wait()).toBeLessThanOrEqual(60_000);
    expect(gossipBudget("desk:key", { storage, now: () => clock }).spend()).toBe(true);
  });
});

describe("R3: an alarm another tab of this device saved", () => {
  it("ends a writer this tab handed out before it: an Allow that waited for its claim signs and sends nothing", async () => {
    const { w, first } = await world();
    const fork = await otherHistory(w, first);
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const tab = otherTab(w, first);
    await tab.sync();
    const newcomer = await w.device({ label: "Dana's laptop" });
    await newcomer.list.sync();
    const claims = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    first.wire.answer = async (request) => {
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/claims")) { asked.resolve(); await claims.promise; }
      return null;
    };
    const allow = allowDevice(first.list, { key: (await newcomer.keys()).key, label: "Dana's laptop", os: "macos" }, noWait);
    await asked.promise;
    // the other tab (the one with the PC open) meets the PC, raises the alarm and saves it: this device stands alarmed
    expect((await gossipWithPc(pc.fetch, tab, null, always, { hands: true })).end).toBe("alarm");
    expect(tab.view().status).toMatchObject({ trouble: "fork" });
    const placed = first.sent.filter((each) => each.route.endsWith("/entries")).length;
    claims.resolve();
    const outcome = await allow;
    // RIGHT: nothing is signed or sent by this device after its alarm
    expect(first.sent.filter((each) => each.route.endsWith("/entries")).length).toBe(placed);
    expect(outcome).toMatchObject({ allowed: false });
  });
});

describe("R6: a PC that the device's list does not hold", () => {
  it("is not handed the device's list from entry 0 because it echoes the list's id", async () => {
    const { first } = await world();
    const mine = first.list.gossip()!;
    const handed: number[] = [];
    // a PC paired with this device, in no list of the account (or in another), that selects the list feature
    const stranger: PcFetch = async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as { list: string; entries?: string[] };
      if (path === "/api/account/list/head") return json({ list: body.list, place: null, asks: { list: body.list, after: null } });
      handed.push(...(body.entries ?? []).map((_, index) => index));
      return json({ verdict: "caught_up", list: body.list, place: mine.place });
    };
    await gossipWithPc(stranger, first.list, null, always);
    // RIGHT: entries go only to a PC the device's own copy holds (or held), never to whoever names the list's id
    expect(handed.length).toBe(0);
  });
});

describe("R7: the PC the device just learned is out", () => {
  it("cannot raise the fork alarm on the device through the exchange that hands it its removal", async () => {
    const { w, first, desk } = await world();
    const before = first.list.gossip()!.place!;
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    // the removal is the entry right after `before` (an epoch follows it in the same post)
    const removal = first.list.placeAt(before.seq + 1)!;
    expect(first.list.gossip()!.place!.seq).toBeGreaterThanOrEqual(removal.seq);
    // the PC that was put out signs another entry at the place of its own removal, where its key was still a signer
    const { id } = w.held();
    const endpoint = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const other = entryToText(await signEntry(kindBody({ issued_at: seconds(w), list: id, prev: before.hash, seq: removal.seq, signer: desk.key }, { kind: "carried", endpoint, sealed: null }), desk.signs));
    const out: PcFetch = async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as { list: string };
      if (path === "/api/account/list/head") {
        return json({ list: body.list, place: { seq: removal.seq, hash: hashOf(other) }, page: { list: body.list, after: before.seq, entries: [other], head: { seq: removal.seq, hash: hashOf(other) } } });
      }
      return json({ verdict: "caught_up", list: body.list, place: before });
    };
    const session = { followsList: true, route: "relay" as const, fetch: (input: string, init?: RequestInit) => out(input, init) };
    await deliverOnce(session, first.list, gossipBudget("r7", { storage: null }), 3_000);
    // RIGHT: the device still writes: a PC it already knows to be out is handed its removal, and no page of it is taken
    expect(first.list.view().status).not.toMatchObject({ trouble: "fork" });
    expect(first.list.writer()).not.toBeNull();
  });
});

describe("R8: a session opened for one account, after this browser signs in to another", () => {
  it("tells the PC nothing of the other account's list, and goes on comparing once the first account is back", async () => {
    const { w, first, second } = await world();
    const pc = await memoryPc(w, w.held().entries);
    // another account with a list of its own, signed in on this browser by another tab (the page's list is now its)
    const other = listWorld("acct_other");
    const elsewhere = await other.device({ label: "Same phone, other account" });
    await elsewhere.list.sync();
    expect(elsewhere.list.gossip()).not.toBeNull();
    let current: AccountList = first.list;
    const session = sessionOf(pc);
    const timers: (() => void)[] = [];
    const stop = keepListGossip(session, { list: () => current, pc: first.list.view().pcs[0]!.server_id, setTimer: (run) => { timers.push(run); return run; }, clearTimer: (timer) => { const at = timers.indexOf(timer as () => void); if (at >= 0) timers.splice(at, 1); } });
    const settle = async (done: () => boolean) => { const end = performance.now() + 5_000; while (!done()) { if (performance.now() > end) throw new Error("timed out"); await new Promise((r) => setImmediate(r)); } };
    try {
      await settle(() => pc.calls.length === 1);
      current = elsewhere.list;
      // the 300 s timer runs: the keeper reads the page's list again
      await settle(() => timers.length > 0);
      timers.shift()!();
      // that turn is over once it set its next timer: it asks nothing for another account's list
      await settle(() => timers.length > 0);
      const told = pc.calls.map((call) => call.body.list);
      // the first account is signed in again, and this device removes its tablet: the PC must be handed it
      current = first.list;
      const removed = (await second.keys()).key;
      const outcome = await writeToList(first.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: removed }]) }), noWait);
      expect(outcome.written).toBe(true);
      await settle(() => timers.length > 0);
      timers.shift()!();
      await settle(() => admitsSession(pc.copy(), removed, seconds(w)).why === "removed");
      // RIGHT: the PC this session was opened for is told nothing of the other account's list ...
      expect(told).not.toContain(elsewhere.list.gossip()!.list);
      // ... and, the first account back, the removal reaches it over the same session
      expect(admitsSession(pc.copy(), removed, seconds(w)).why).toBe("removed");
    } finally { stop(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// PIN: guards verified sound on the head, which no test of the step kills when they are taken out (surviving mutants)
// ---------------------------------------------------------------------------------------------------------------

/** A spend that allows `n` calls and counts them. */
const allowing = (n: number) => { let left = n; return () => left-- > 0; };

describe("PIN: one exchange's guards", () => {
  it("(A1) a hand-over ends where the PC asks again for a place it was handed in that hand-over", async () => {
    const { first } = await world();
    const mine = first.list.gossip()!;
    let pages = 0;
    const asksAgain: PcFetch = async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as { list: string };
      if (path === "/api/account/list/head") return json({ list: body.list, place: { seq: 0, hash: body.list }, asks: { list: body.list, after: 0 } });
      pages += 1;
      return json({ verdict: "more", list: body.list, place: { seq: 0, hash: body.list }, asks: { list: body.list, after: 0 } });
    };
    expect(mine.place!.seq).toBeGreaterThan(0);
    await gossipWithPc(asksAgain, first.list, null, allowing(10), { hands: true });
    expect(pages).toBe(1);
  });

  it("(A2) a PC that follows another list ends the exchange as not_my_list, so the session asks it nothing more", async () => {
    const { first } = await world();
    const otherList = "ab".repeat(32);
    const elsewhere: PcFetch = async () => json({ list: otherList, place: { seq: 3, hash: "cd".repeat(32) } });
    expect((await gossipWithPc(elsewhere, first.list, null, always)).end).toBe("not_my_list");
  });

  it("(A3) a page whose save failed is not read on from in the same exchange", async () => {
    const { w, first, second, desk } = await world();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    // two entries the device does not hold: the PC hands them one at a time (`more` after the first)
    await addListPc(w, first, "Laptop");
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const pc = await memoryPc(w, w.held().entries);
    const oneAtATime: PcFetch = async (path, init) => {
      const answer = await pc.fetch(path, init);
      if (path !== "/api/account/list/head") return answer;
      const body = await answer.json() as { page?: { entries: string[] } };
      if (body.page !== undefined) body.page.entries = body.page.entries.slice(0, 1);
      return json(body);
    };
    const failing = spyOn(second.lists, "swap").mockImplementation(async () => { throw new DOMException("The disk is full", "QuotaExceededError"); });
    try {
      await gossipWithPc(oneAtATime, second.list, null, always, { hands: true });
    } finally { failing.mockRestore(); }
    expect(pc.calls.filter((call) => call.path === "/api/account/list/head").length).toBe(1);
  });

  it("(A4) one exchange hands the PC over once, however often its answers ask", async () => {
    const { first } = await world();
    const top = first.list.gossip()!.place!;
    const entry1 = first.list.pageAfter(0, 1)!.entries[0]!;
    let pages = 0;
    const both: PcFetch = async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as { list: string };
      if (path === "/api/account/list/head") {
        return json({ list: body.list, place: { seq: 1, hash: hashOf(entry1) }, asks: { list: body.list, after: 1 },
          page: { list: body.list, after: 0, entries: [entry1], head: { seq: top.seq + 5, hash: "ef".repeat(32) } } });
      }
      pages += 1;
      return json({ verdict: "caught_up", list: body.list, place: top });
    };
    await gossipWithPc(both, first.list, null, allowing(12), { hands: true });
    expect(pages).toBe(1);
  });
});

describe("PIN: a session's guards", () => {
  it("(A7) a PC that followed another list on one carrier is asked again on the next (it may have pinned meanwhile)", async () => {
    const { w, first } = await world();
    const pc = await memoryPc(w, w.held().entries);
    let elsewhere = true;
    const heads: string[] = [];
    const session = sessionOf({ fetch: (async (path, init) => {
      heads.push(path);
      if (elsewhere) return json({ list: "ab".repeat(32), place: { seq: 1, hash: "cd".repeat(32) } });
      return pc.fetch(path, init);
    }) as PcFetch });
    const armed: number[] = [];
    const stop = keepListGossip(session, { list: () => first.list, pc: first.list.view().pcs[0]!.server_id, setTimer: (_run, ms) => { armed.push(ms); return armed.length; }, clearTimer: () => {} });
    const settle = async (done: () => boolean) => { const end = performance.now() + 5_000; while (!done()) { if (performance.now() > end) throw new Error("timed out"); await new Promise((r) => setImmediate(r)); } };
    try {
      await settle(() => heads.length === 1);
      // the exchange is over (it said not_my_list) once the keeper set its next timer
      await settle(() => armed.length > 0);
      elsewhere = false;
      session.up(false);
      session.up(true);
      await settle(() => heads.length === 2);
    } finally { stop(); }
  });
});

describe("PIN: the budget", () => {
  it("(A9) a 429's wait holds every call back, the one attempt of a PC put out included, until it is over", () => {
    let clock = 1_800_000_000_000;
    const budget = gossipBudget("a9", { storage: null, now: () => clock });
    budget.pause(60_000);
    expect(budget.spend()).toBe(false);
    clock += 60_001;
    expect(budget.spend()).toBe(true);
  });
});

describe("PIN: the one attempt's bound", () => {
  it("(A10) is over within its time whatever the PC does, so the session it holds is closed", async () => {
    const { w, first, desk } = await world();
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    void w;
    const silent = { followsList: true, route: "relay" as const, fetch: () => new Promise<Response>(() => {}) };
    const began = performance.now();
    await deliverOnce(silent, first.list, gossipBudget("a10", { storage: null }), 100);
    expect(performance.now() - began).toBeLessThan(2_000);
  });
});

describe("PIN: what a page of a PC does to this device's copy", () => {
  it("(A13) a read begun on another list than the copy holds now takes nothing, and does not throw", async () => {
    const { w, first } = await world();
    const pc = await memoryPc(w, w.held().entries);
    const page = servePage(pc.copy(), { list: pc.copy().list, after: 0 }, 256)!;
    const foreign: FollowRead = { ...startRead(pc.copy(), "peer"), list: "ab".repeat(32), after: 0 };
    expect(await first.list.takeFromPeer(page, foreign)).toBeNull();
  });

  it("(A14) a PC's page is no word of the account service: a device that did not reach it still shows so", async () => {
    const { w, first, second, desk } = await world();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const pc = await memoryPc(w, w.held().entries);
    second.wire.answer = () => { throw new TypeError("offline"); };
    w.clock.now += 60_000;
    await second.list.sync().catch(() => undefined);
    expect(second.list.view().reached).toBe(false);
    second.wire.answer = null;
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    expect(await second.list.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!, ask.read)).toMatchObject({ saved: true });
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    expect(second.list.view().reached).toBe(false);
  });
});

describe("PIN: an alarm and a write already under way", () => {
  it("(A17) a request signed while the alarm rose is never kept", async () => {
    const { w, first, second } = await world();
    const fork = await otherHistory(w, first);
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const removed = (await second.keys()).key;
    const sentBefore = await first.lists.get("sent", w.account);
    const outcome = await writeToList(first.list, async (writer) => {
      const request = await signedOn(writer, [{ kind: "remove", ends: removed }]);
      // the alarm rises while the request is being signed
      expect((await gossipWithPc(pc.fetch, first.list, null, always, { hands: true })).end).toBe("alarm");
      return { request };
    }, noWait);
    expect(outcome).toMatchObject({ written: false, why: "blocked" });
    expect(await first.lists.get("sent", w.account)).toBe(sentBefore);
  });

  it("(A18) a request kept while the alarm rose is not sent", async () => {
    const { w, first, second } = await world();
    const fork = await otherHistory(w, first);
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const removed = (await second.keys()).key;
    const placed = first.sent.filter((each) => each.route.endsWith("/entries")).length;
    const swap = first.lists.swap.bind(first.lists);
    let alarmed = false;
    // the alarm rises while the signed request is being kept
    const hook = spyOn(first.lists, "swap").mockImplementation(async (...args: Parameters<typeof swap>) => {
      if (args[0] === "sent" && !alarmed) {
        alarmed = true;
        expect((await gossipWithPc(pc.fetch, first.list, null, always, { hands: true })).end).toBe("alarm");
      }
      return swap(...args);
    });
    let outcome: Awaited<ReturnType<typeof writeToList>>;
    try {
      outcome = await writeToList(first.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: removed }]) }), noWait);
    } finally { hook.mockRestore(); }
    expect(alarmed).toBe(true);
    expect(first.sent.filter((each) => each.route.endsWith("/entries")).length).toBe(placed);
    expect(outcome.written).toBe(false);
  });
});

describe("PIN: a removal a PC handed that could not be saved", () => {
  it("(A21) is written by the next round even where that round does not reach the account service", async () => {
    const { w, first, second, desk } = await world();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const pc = await memoryPc(w, w.held().entries);
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    const failing = spyOn(second.lists, "swap").mockImplementation(async () => { throw new DOMException("The disk is full", "QuotaExceededError"); });
    try {
      expect(await second.list.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!, ask.read)).toMatchObject({ saved: false });
    } finally { failing.mockRestore(); }
    second.wire.answer = () => { throw new TypeError("offline"); };
    w.clock.now += 60_000;
    await second.list.sync().catch(() => undefined);
    const saved = String(await second.lists.get("copy", w.account));
    const read = await readSave(saved);
    expect(read.read && read.copy.entries.length).toBe(pc.copy().entries.length);
  });
});

describe("PIN: the budget and a clock set back", () => {
  it("(A30) a call dated further ahead than a minute is not counted after the wall clock went back", () => {
    let clock = 1_800_000_000_000;
    const budget = gossipBudget("a30", { storage: null, perMinute: 1, now: () => clock });
    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(false);
    clock -= 120_000;
    expect(budget.spend()).toBe(true);
  });
});

describe("PIN: more guards no test of the step kills", () => {
  it("(A31) a head that moves while an exchange runs gets an exchange of its own right after it", async () => {
    const { w, first, second } = await world();
    const pc = await memoryPc(w, w.held().entries);
    const gate = Promise.withResolvers<void>();
    let held = true;
    const session = sessionOf({ fetch: (async (path, init) => { if (held) { held = false; await gate.promise; } return pc.fetch(path, init); }) as PcFetch });
    const timers: (() => void)[] = [];
    const stop = keepListGossip(session, { list: () => first.list, pc: first.list.view().pcs[0]!.server_id, setTimer: (run) => { timers.push(run); return run; }, clearTimer: () => {} });
    const settle = async (done: () => boolean) => { const end = performance.now() + 5_000; while (!done()) { if (performance.now() > end) throw new Error("timed out"); await new Promise((r) => setImmediate(r)); } };
    try {
      const removed = (await second.keys()).key;
      const outcome = await writeToList(first.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: removed }]) }), noWait);
      expect(outcome.written).toBe(true);
      gate.resolve();
      await settle(() => admitsSession(pc.copy(), removed, seconds(w)).why === "removed");
    } finally { stop(); }
  });

  it("(A32) a PC that asks for a place of another list is handed nothing", async () => {
    const { first } = await world();
    let pages = 0;
    const askOther: PcFetch = async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as { list: string };
      if (path === "/api/account/list/head") return json({ list: body.list, place: { seq: 0, hash: body.list }, asks: { list: "ab".repeat(32), after: 0 } });
      pages += 1;
      return json({ verdict: "caught_up", list: body.list, place: { seq: 0, hash: body.list } });
    };
    await gossipWithPc(askOther, first.list, null, always, { hands: true });
    expect(pages).toBe(0);
  });

  it("(A33) the one attempt asks nothing of a PC that follows no list", async () => {
    const { w, first, desk } = await world();
    const pc = await memoryPc(w, w.held().entries);
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    await deliverOnce({ ...sessionOf(pc), followsList: false }, first.list, gossipBudget("a33", { storage: null }), 1_000);
    expect(pc.calls).toEqual([]);
  });
});

describe("PIN: what the minute cut", () => {
  it("(A8) goes on as soon as the budget has room again, not at the 300 s timer", async () => {
    const { w, first, second } = await world();
    const pc = await memoryPc(w, w.held().entries);
    await writeToList(first.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: (await second.keys()).key }]) }), noWait);
    // one call, then the minute is spent; by the time the exchange ends it has room again
    let calls = 0;
    let free = false;
    const budget = { spend: () => { calls += 1; if (calls === 1) return true; free = true; return false; }, pause: () => {}, wait: () => (calls === 0 || free ? 0 : 60_000) };
    const armed: number[] = [];
    const stop = keepListGossip(sessionOf(pc), { list: () => first.list, pc: first.list.view().pcs[0]!.server_id, budget, setTimer: (_run, ms) => { armed.push(ms); return armed.length; }, clearTimer: () => {} });
    const settle = async (done: () => boolean) => { const end = performance.now() + 5_000; while (!done()) { if (performance.now() > end) throw new Error("timed out"); await new Promise((r) => setImmediate(r)); } };
    try {
      await settle(() => armed.length > 0);
      expect(armed[0]).toBe(0);
    } finally { stop(); }
  });
});
