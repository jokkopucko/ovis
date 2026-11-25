/**
 * A device and a pinned PC say where their account's signed list stands over the app's own session
 * (account/listGossip.ts), end to end: the app's channel and relay transport on one side; a real PC with its copy of the
 * list and its two session routes on the other; the account service in memory with a tamper mode between them. A
 * removal the service withholds from the PC reaches it from the device, and two histories members signed raise the
 * alarm on both sides. A PC that follows no list is asked nothing.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { listMember, TestList, type ListMember } from "../../../server/account/list.test-helpers.ts";
import { pairingPc, type Pc } from "../../../server/account/pairing.test-helpers.ts";
import { RelaySession } from "../../../server/relay/session.ts";
import { bounded } from "../../../server/relay/test-helpers.ts";
import type { RelayChannelOptions } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair, importPublicKey, openDaemonSecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { accountList, type AccountList } from "../account/accountList.ts";
import { keepListGossip } from "../account/listGossip.ts";
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

test("a removal the account service withholds from the PC reaches it from the device that placed it, at once, over its session", async () => {
  const { made, services, account, member, laptop, serverId, pull, signIn, session, sent } = await rig();
  const list = services.accountList!;
  const held = list.status().head!;
  // the laptop is let in now
  const before = await signIn(laptop.keys.privateKey, laptop.key);
  expect(before.followsList).toBe(true);
  before.close();
  made.account.tamperList(account.id, { reader: { server_id: serverId }, withholdAfter: held.seq });
  const stop = keepListGossip(session, { list: () => member, pc: serverId });
  closes.push(stop);
  await until(() => sent.length >= 1);
  // the device puts the laptop out; the account service shows the PC nothing of it
  const removed = await writeToList(member, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: laptop.key }]) }), noWait);
  expect(removed.written).toBe(true);
  await pull();
  // the device's copy moved its head, so it said so to the PC at once and handed it the removal
  await until(() => list.status().head?.seq === held.seq + 1);
  expect(list.status().head).toEqual(member.gossip()!.place);
  expect(sent).toContain("/api/account/list/page");
  // and the PC lets the laptop in no more, though the service still withholds the removal
  await pull();
  await expect(signIn(laptop.keys.privateKey, laptop.key)).rejects.toThrow();
}, 40_000);

test("two histories that members signed raise the alarm on the device and on the PC once they meet, and neither lets anybody new in", async () => {
  const { made, services, account, member, laptop, serverId, pull, session } = await rig();
  const list = services.accountList!;
  const at = list.status().head!;
  // the account service shows the PC another continuation: an entry the first device signed and nobody placed
  const other = await account.sign({ kind: "remove", ends: laptop.key }, account.first, at);
  made.account.tamperList(account.id, { reader: { server_id: serverId }, fork: [other] });
  // while the device places its own at that very place
  const placed = await writeToList(member, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: laptop.key }]) }), noWait);
  expect(placed.written).toBe(true);
  await pull();
  // each holds one history, and neither has seen the other yet
  expect(list.status()).toMatchObject({ alarm: null, head: { seq: at.seq + 1 } });
  expect(list.status().head).not.toEqual(member.gossip()!.place);
  expect(member.view().status).toMatchObject({ trouble: null });
  const stop = keepListGossip(session, { list: () => member, pc: serverId });
  closes.push(stop);
  await until(() => member.view().status.at === "following" && (member.view().status as { trouble: string | null }).trouble === "fork" && list.status().alarm === "fork");
  // the device signs nothing from now on; the PC lets nobody new in and signs no Allow
  expect(member.writer()).toBeNull();
  expect(list.status()).toMatchObject({ alarm: "fork", pinned: true });
  expect(list.status().reason).toContain("two versions of your account's list");
}, 40_000);

test("a PC that follows no list is asked nothing over the session, and neither is a PC by a device that follows none", async () => {
  const { member, serverId, session, sent } = await rig({ pin: false });
  expect(session.followsList).toBe(false);
  expect(member.gossip()).not.toBeNull();
  const stop = keepListGossip(session, { list: () => member, pc: serverId });
  // an exchange makes its first call before keepListGossip returns: none was made
  stop();
  expect(sent).toEqual([]);
  // the session itself works as ever
  expect((await session.fetch("/api/health")).ok).toBe(true);
  expect(sent).toEqual(["/api/health"]);
}, 40_000);
