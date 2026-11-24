/**
 * A new device joins its account through a PC that is pinned to the account's signed list (docs/account.md, "A PC
 * allows a device into the list"), end to end between the two: the app's own channel (shared/relay-channel.ts) on one
 * side, a real PC with its account, its relay session, its own window's approval and its copy of the list on the
 * other, and the account service in memory.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { claimKey, listMember, memberCard, TestList, type ListMember } from "../../../server/account/list.test-helpers.ts";
import { pairingPc, vouchFor, type Pc } from "../../../server/account/pairing.test-helpers.ts";
import { RelaySession } from "../../../server/relay/session.ts";
import { bounded, deferred } from "../../../server/relay/test-helpers.ts";
import { entryFromText, entryHash } from "../../../shared/account-list-entry.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { ListMismatchError, type RelayChannelOptions } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair, importPublicKey, openDaemonSecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { RemotePairingRequest } from "../../../shared/protocol.ts";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { accountList, type AccountList } from "../account/accountList.ts";
import { approveForAccount, NotConfirmedError } from "../account/join.ts";
import { deviceListKeys } from "../account/listKeys.ts";
import { memoryListLock, memoryListStore } from "../account/listStore.ts";
import { AccountService } from "../account/service.ts";
import { memoryAccountStore, memoryLock } from "../account/store.ts";
import { openRelayTransport } from "./transport.ts";
import { openRelayChannel, type RelaySocket } from "./channel.ts";
import { MemoryDeviceStore } from "./device.test.ts";
import { failureOf } from "./shellState.ts";

const ACCOUNT = "acct_1";
const TOKEN = "list-join-token";
/** The PC's own window: the access token from loopback, no proxy. */
const own = { authorization: `Bearer ${TOKEN}` };

const pcs: Pc[] = [];
/** The account service of the PC being made, for what a test sets up while the PC is made (pinnedPc's `before`). */
const made0 = (): Pc["account"] => pcs.at(-1)!.account;
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
 * A PC a person added to the account and to its list, pinned to that list: its own key signs for it. `before`: what
 * the account's first device does to the list before the PC pins it (a device let in then waits no join hold there).
 */
async function pinnedPc(before?: (account: TestList) => Promise<void>) {
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
  await before?.(account);
  await pull();
  await list.wantList(account.id);
  await account.addPostedPc(endpoint);
  await pull();
  expect(list.status()).toMatchObject({ pinned: true, standing: "in" });

  const serverId = identity.server_id;
  const e2ee = generateKeyPair();
  const offer = { v: 1 as const, server_id: serverId, server_public_key: exportPublicKey(e2ee.publicKey), relay: "wss://relay.example" };
  /** The app opens a channel to the PC, as shell.tsx does for a join or for a sign-in. */
  const open = (options: Omit<RelayChannelOptions, "socket">) => {
    let session: RelaySession | undefined;
    let carrier: Carrier;
    const daemon: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => carrier.deliver(data),
      // as on a WebSocket, the PC's close reaches the phone in a later task than the frames it sent first
      close: (code, reason) => { setImmediate(() => carrier.close(code, reason)); },
    };
    carrier = new Carrier(daemon);
    closes.push(() => carrier.close());
    const early: (string | ArrayBuffer)[] = [];
    void openDaemonSecureChannel(daemon, { daemonKeyPair: e2ee, events: { onmessage: (data) => { if (session) session.receive(data); else early.push(data); } } }).then((channel) => {
      session = new RelaySession({ channel, services, port: made.app.port, serverId, serverVersion: "0.4.20", minSupportedClient: "0.4.20", routingOverhead: 0, maxWireMessageBytes: 64 * 1024 });
      for (const data of early.splice(0)) session.receive(data);
    }, () => {});
    const opening = openRelayChannel(offer, { ...options, socket: () => { queueMicrotask(() => carrier.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return carrier; } });
    void opening.catch(() => {});
    return opening;
  };
  /** The join the PC's own window shows, once it is there. */
  const ownJoin = async (): Promise<{ id: string; digits?: string; list?: boolean }> => {
    const approvals = services.relay.approvals;
    const found = deferred<void>();
    const stop = approvals.subscribe(() => { if (approvals.ownJoins().length > 0) found.resolve(); });
    if (approvals.ownJoins().length > 0) found.resolve();
    await bounded(found.promise).finally(stop);
    const listed = await (await fetch(`http://127.0.0.1:${made.app.port}/api/relay/joins`, { headers: own })).json() as { joins: { id: string; digits?: string; list?: boolean }[] };
    return listed.joins[0]!;
  };
  /** A person at the PC presses Allow in its own window. */
  const allowHere = async (id: string): Promise<number> => {
    const base = `http://127.0.0.1:${made.app.port}`;
    return (await fetch(`${base}/api/relay/join`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...own }, body: JSON.stringify({ id, decision: "approve" }) })).status;
  };
  /** A device that signed in to the account and rang at this PC, and the join it opens with its account key. */
  const join = async (device: ListMember, card: string | null) => {
    await vouchFor(made, ACCOUNT, { keys: device.keys, spki: device.key });
    const shown = deferred<string>();
    const matched = deferred<void>();
    const store = new MemoryDeviceStore();
    const opening = open({
      store, intent: "account", accountKey: { private_key: device.keys.privateKey, public_spki: device.key },
      ...(card === null ? {} : { listCard: { list: account.id, enc: device.enc, card } }),
      compare: async (digits) => { shown.resolve(digits); await matched.promise; },
    });
    return { opening, store, digits: bounded(shown.promise, 10_000), match: () => matched.resolve() };
  };
  return { made, services, serverId, offer, account, open, ownJoin, allowHere, join, pull };
}

test("a new device brings its card to a pinned PC, a person at the PC allows it, and the device is handed its place in the list and signs in with its list key", async () => {
  const { made, serverId, offer, account, open, ownJoin, allowHere, join } = await pinnedPc();
  const phone = await listMember();
  const card = await claimKey(made.account, ACCOUNT, account.id, phone);
  const asked = await join(phone, card);
  const waiting = await ownJoin();
  // both screens show the same digits, and the PC's own window is told that the list lets this join in
  expect([waiting.digits, waiting.list]).toEqual([await asked.digits, true]);
  expect(await allowHere(waiting.id)).toBe(200);
  asked.match();
  const joined = await bounded(asked.opening, 15_000);
  // the PC took the card, signed the entry itself and names its place: the very entry the log holds for this key
  expect(joined.server.features).toContain(ACCOUNT_LIST_ALLOW);
  const held = made.account.accountList(ACCOUNT)!;
  const seq = held.state.signers[phone.key]!.seq;
  expect(joined.listPlace).toEqual({ id: account.id, seq, hash: entryHash(entryFromText(held.entries[seq]!).body) });
  // no pairing of this device's own stands behind it, on the device or on the PC
  expect(await asked.store.get(serverId)).toBeUndefined();
  expect(made.devices.hasKey(phone.key)).toBe(false);
  joined.close();
  // and it signs in as any device of the list, with the key the list now holds for it
  const again = await bounded(open({
    store: withAccountDevice(new MemoryDeviceStore(), accountDevice(offer, { private_key: phone.keys.privateKey, public_spki: phone.key })), accountListKey: true,
  }), 10_000);
  expect([again.device.device_id, again.server.features?.includes(ACCOUNT_LIST_FEATURE)]).toEqual([accountDeviceId(serverId, phone.key), true]);
  again.close();
}, 30_000);

/**
 * A device of the account that is in the list from before the PC pinned it (an app with its own copy of the list),
 * signed in to the pinned PC with the key the list holds for it; `listed` reads the joins the PC shows it.
 */
async function memberOnPinnedPc() {
  // the member: an app with its own copy of the account's list, in the list before the PC pinned it
  const store = memoryAccountStore();
  const lists: { own?: AccountList; service?: AccountService } = {};
  const pc = await pinnedPc(async (started) => {
    await store.set("session", { service: "https://account.test", account: ACCOUNT, provider: "github", access_token: made0().issueToken(ACCOUNT, { twoStep: true }), refresh_token: "r", expires_at: Date.now() + 3_600_000, sign_in_id: "member", signed_in_at: Date.now() });
    lists.service = new AccountService({ store, fetch: made0().fetch, lock: memoryLock() });
    lists.own = accountList({ service: lists.service, accountStore: store, listStore: memoryListStore(), lock: memoryListLock(), genesis: () => "never", durable: async () => true, names: () => ({ label: "Member", os: "ios" }) });
    const keys = await deviceListKeys(store);
    await started.addDevice({ key: keys.key, enc: keys.enc.key, keys: { privateKey: keys.signs } } as unknown as ListMember);
    expect((await lists.own.adopt({ list: started.id, ...started.place })).status).toMatchObject({ at: "following", standing: "in" });
  });
  const { offer, open } = pc;
  const member = lists.own!;
  const service = lists.service!;
  const keys = await deviceListKeys(store);
  // it is signed in to the PC with the key the list holds for it, and the PC says that it lets devices in by the list
  const transport = await bounded(openRelayTransport(offer, {
    store: withAccountDevice(new MemoryDeviceStore(), accountDevice(offer, { private_key: keys.signs, public_spki: keys.key })), accountListKey: true,
    openChannel: (_offer, config) => { const { socket: _carrier, ...rest } = config as RelayChannelOptions; return open(rest); },
  }), 10_000);
  closes.push(() => transport.close());
  expect(transport.followsList).toBe(true);

  /** The join of `key` as the PC lists it for this device, read again until `ready` holds for it; null where it never does. */
  const listed = async (key: string, ready: (request: RemotePairingRequest) => boolean): Promise<RemotePairingRequest | null> => {
    for (let round = 0; round < 200; round += 1) {
      const { pairings } = await (await transport.fetch("/api/relay/pairings")).json() as { pairings: RemotePairingRequest[] };
      const found = pairings.find((each) => each.key === key);
      if (found !== undefined && ready(found)) return found;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    return null;
  };
  return { ...pc, store, member, service, keys, transport, listed };
}

test("a device of the account allows a new device through a pinned PC: nothing until the new device confirmed, then the approval and the entry it signs, and the PC lets the device in by that entry", async () => {
  const { made, serverId, account, join, store, member, service, keys, transport, listed: listedFor } = await memberOnPinnedPc();
  const phone = await listMember();
  const card = await claimKey(made.account, ACCOUNT, account.id, phone);
  const asked = await join(phone, card);
  const digits = await asked.digits;
  /** The join as the PC lists it for this device, read again until `ready` holds for it. */
  const listed = async (ready: (request: RemotePairingRequest) => boolean): Promise<RemotePairingRequest> => {
    const found = await listedFor(phone.key, ready);
    if (found === null) throw new Error("The PC did not list the join as expected");
    return found;
  };
  // while the new device's person has not said that the numbers match, the member approves nothing and signs nothing
  const early = await listed(() => true);
  expect([early.list, early.confirmed]).toEqual([true, undefined]);
  const decided: string[] = [];
  const approval = (request: RemotePairingRequest) => approveForAccount({
    request, digits, through: serverId, service, account: ACCOUNT, key: store.key(), list: member,
    pc: { fetch: async (path, init) => { order.push(path); return transport.fetch(path, init); }, followsList: transport.followsList },
    decide: async (decision, picked) => {
      order.push(decision);
      const answered = await transport.fetch("/api/relay/pairing", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ id: request.id, decision, digits: picked }) });
      if (!answered.ok) throw new Error(`The PC did not take the decision: ${answered.status}`);
    },
    paired: async () => [], directory: async () => [serverId], onStalled: (stalled) => { decided.push(stalled === null ? "in" : stalled.why); },
  });
  const order: string[] = [];
  const entriesBefore = made.account.requests.filter((line) => line.includes("/v2/pc/list/entries")).length;
  expect(await approval(early).catch((error: unknown) => error)).toBeInstanceOf(NotConfirmedError);
  expect([order, made.account.accountList(ACCOUNT)!.state.signers[phone.key]]).toEqual([[], undefined]);
  // its person says so: the PC tells the approver, and the approval goes through, the entry right after it
  asked.match();
  await approval(await listed((request) => request.confirmed === true));
  expect([order.slice(0, 2), decided]).toEqual([["approve", "/api/account/list/head"], ["in"]]);
  const joined = await bounded(asked.opening, 15_000);
  // the member signed the entry, the PC signed nothing, and the device is handed the place of that very entry
  const held = made.account.accountList(ACCOUNT)!;
  const row = held.state.signers[phone.key]!;
  expect([row.by, made.account.requests.filter((line) => line.includes("/v2/pc/list/entries")).length]).toEqual([keys.key, entriesBefore]);
  expect(joined.listPlace).toEqual({ id: account.id, seq: row.seq, hash: entryHash(entryFromText(held.entries[row.seq]!).body) });
  expect(await asked.store.get(serverId)).toBeUndefined();
  joined.close();
}, 40_000);

test("a join that brought no card is never shown to a device of the list as confirmed, so no member signs anybody in for it from afar", async () => {
  const { serverId, services, join, store, member, service, transport } = await memberOnPinnedPc();
  const phone = await listMember();
  // no card: its claim did not stand, or its app is from before cards; its person says that the numbers match
  const asked = await join(phone, null);
  const digits = await asked.digits;
  asked.match();
  // the PC took the confirm (its own record of the join says so) ...
  const approvals = services.relay.approvals;
  const held = approvals as unknown as { waiting: Map<string, { key: string; confirmed: boolean }> };
  for (let round = 0; round < 500 && ![...held.waiting.values()].some((each) => each.key === phone.key && each.confirmed); round += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
  expect([...held.waiting.values()].filter((each) => each.key === phone.key).map((each) => each.confirmed)).toEqual([true]);
  // ... and shows it confirmed to nobody: not to a device of the list, which is not shown the join at all, nor to a
  // device of the PC's own (remoteList), to which it is the PC's own pairing, with no mark of the list
  const { pairings } = await (await transport.fetch("/api/relay/pairings")).json() as { pairings: RemotePairingRequest[] };
  expect(pairings.filter((each) => each.key === phone.key)).toEqual([]);
  expect(approvals.remoteList().filter((each) => each.key === phone.key && (each.list !== undefined || each.confirmed !== undefined))).toEqual([]);
  // and an approval of it, as a card would send one, approves and signs nothing
  const decided: string[] = [];
  const request: RemotePairingRequest = { id: "cardless", label: "Phone", intent: "account", choices: [digits, "000000", "111111"], expires_at: "", key: phone.key };
  const refused = await approveForAccount({
    request, digits, through: serverId, service, account: ACCOUNT, key: store.key(), list: member,
    pc: { fetch: (path, init) => transport.fetch(path, init), followsList: transport.followsList },
    decide: async (decision) => { decided.push(decision); }, paired: async () => [], directory: async () => [serverId], onStalled: () => {},
  }).catch((error: unknown) => error);
  expect([refused instanceof NotConfirmedError, decided]).toEqual([true, []]);
}, 40_000);

test("a device whose key no sign-in of the account claimed is told so, in words of its own, and is in no list", async () => {
  const { made, account, ownJoin, allowHere, join } = await pinnedPc();
  const phone = await listMember();
  // a card that holds for this list, and no claim of the key at the account service
  const asked = await join(phone, await memberCard(phone, account.id));
  const waiting = await ownJoin();
  expect(await allowHere(waiting.id)).toBe(200);
  asked.match();
  const refused = await bounded(asked.opening.then(() => null, (error: unknown) => error), 15_000);
  expect(refused instanceof MuxProtocolError && [refused.code, refused.message]).toEqual(["auth_failed", "list_not_claimed"]);
  expect(failureOf(refused, { code: false, paired: false, codeless: true, compared: true })).toBe("list-not-claimed");
  expect(made.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  expect(made.devices.hasKey(phone.key)).toBe(false);
}, 30_000);

test("a device whose card is for another list stops before any digits are shown", async () => {
  const { made, open } = await pinnedPc();
  const phone = await listMember();
  const other = "6d".repeat(32);
  await vouchFor(made, ACCOUNT, { keys: phone.keys, spki: phone.key });
  let shown = false;
  const refused = await bounded(open({
    store: new MemoryDeviceStore(), intent: "account", accountKey: { private_key: phone.keys.privateKey, public_spki: phone.key },
    listCard: { list: other, enc: phone.enc, card: await memberCard(phone, other) }, compare: async () => { shown = true; },
  }).then(() => null, (error: unknown) => error), 10_000);
  expect([refused instanceof ListMismatchError, shown]).toEqual([true, false]);
}, 30_000);
