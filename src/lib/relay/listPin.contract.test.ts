/**
 * The app's sign-in and a PC that pins its account's signed list (docs/account-list.md, "What a pinned PC asks of
 * the app"), end to end between the two: the app's own channel (shared/relay-channel.ts) on one side, a real PC
 * session with its account, its mailbox and its copy of the list on the other, and the account service in memory.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { JOIN_HOLD_MS } from "../../../server/account/join-hold.ts";
import { listMember, TestList, type ListMember } from "../../../server/account/list.test-helpers.ts";
import { ACCOUNT, registerSnapshotPc } from "../../../server/account/listed-pc.test-helpers.ts";
import { RelaySession } from "../../../server/relay/session.ts";
import { bounded, relayAccountFixture, TestClock } from "../../../server/relay/test-helpers.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { AccountListUnsupportedError, type RelayChannelOptions } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair, importPublicKey, openDaemonSecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_FEATURE, MuxProtocolError } from "../../../shared/relay-mux.ts";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { openRelayChannel, type RelaySocket } from "./channel.ts";
import { MemoryDeviceStore } from "./device.test.ts";
import { isFatalRelayError } from "./transport.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

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
 * A PC in an account that reads the account's list and is not pinned to it, and one phone as an app holds it: the key
 * of its sign-in, which the account service's snapshot names, and its member key, which the list holds.
 */
async function pcAndPhone() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  const advance = (ms: number): void => { now += ms; waits.advance(ms); };
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: (request) => service.fetch(request) } });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const signIn = await listMember();
  service.registerDevice(ACCOUNT, signIn.key, "Phone");
  const { services } = fixture.app.context;
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  services.devices.useClock(waits);
  const list = services.accountList!;
  const pull = async (): Promise<void> => { await services.accountMailbox.pull(); await list.settled(); };
  const account = await TestList.start(service, ACCOUNT, undefined, () => Math.floor(now / 1000));
  const member = await listMember();
  await account.addDevice(member);
  await pull();
  advance(JOIN_HOLD_MS + 1_000);

  const e2ee = generateKeyPair();
  const offer = { v: 1 as const, server_id: serverId, server_public_key: exportPublicKey(e2ee.publicKey), relay: "wss://relay.example" };
  /** The app opens the PC as the account's device with `key`, the way shell.tsx does for each of its two keys. */
  const open = (key: ListMember, options: Pick<RelayChannelOptions, "accountOpensAll" | "accountListKey" | "onClose">) => {
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
      session = new RelaySession({ channel, services, port: fixture.app.port, serverId, serverVersion: "0.4.20", minSupportedClient: "0.4.20", routingOverhead: 0, maxWireMessageBytes: 64 * 1024 });
      for (const data of early.splice(0)) session.receive(data);
    }, () => {});
    const opening = openRelayChannel(offer, {
      ...options,
      store: withAccountDevice(new MemoryDeviceStore(), accountDevice(offer, { private_key: key.keys.privateKey, public_spki: key.key })),
      socket: () => { queueMicrotask(() => carrier.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return carrier; },
    });
    void opening.catch(() => {});
    return bounded(opening, 5_000);
  };
  const refusal = async (opening: Promise<unknown>): Promise<unknown> => opening.then(() => null, (error: unknown) => error);
  const pin = async (): Promise<void> => {
    await list.wantList(account.id);
    await account.addPostedPc(bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key)));
    await pull();
    expect(list.status()).toMatchObject({ pinned: true, standing: "in" });
  };
  return { serverId, signIn, member, open, refusal, pin };
}

test("a PC that follows no list is opened with the key of the sign-in, and tells an app that comes with its list key so", async () => {
  const { serverId, signIn, member, open, refusal } = await pcAndPhone();
  const opened = await open(signIn, { accountOpensAll: true });
  expect(opened.device.device_id).toBe(accountDeviceId(serverId, signIn.key));
  expect(opened.server.features).not.toContain(ACCOUNT_LIST_FEATURE);
  // the app then comes the way from before, once (shell.tsx)
  expect(await refusal(open(member, { accountListKey: true }))).toBeInstanceOf(AccountListUnsupportedError);
});

test("at the moment a PC pins, an open session ends with no refusal of the device, the same key is told which key to come with, and the list key opens the PC at once", async () => {
  const { serverId, signIn, member, open, refusal, pin } = await pcAndPhone();
  const ended = Promise.withResolvers<Error>();
  await open(signIn, { accountOpensAll: true, onClose: ended.resolve });
  await pin();
  // The app hears the end of an admitted session as its carrier closing, whatever the PC called it: no refusal of the
  // device, so the transport comes back by itself, and the sign-in that follows is what tells
  expect(isFatalRelayError(await bounded(ended.promise, 5_000), true)).toBe(false);
  // with the key of its sign-in it is told to come by its list key, and nothing more is tried with that key
  const told = await refusal(open(signIn, { accountOpensAll: true }));
  expect([told instanceof MuxProtocolError && told.code, isFatalRelayError(told, true)]).toEqual(["account_list_required", true]);
  // the key the list holds for the device opens the PC, under the device id that key gives there, with no wait
  const again = await open(member, { accountListKey: true });
  expect(again.device.device_id).toBe(accountDeviceId(serverId, member.key));
  expect(again.server.features).toContain(ACCOUNT_LIST_FEATURE);
  // a device that is in no list is not let in: the app leads it to the join
  const stranger = await refusal(open(await listMember(), { accountListKey: true }));
  expect(stranger instanceof MuxProtocolError && stranger.code).toBe("auth_failed");
});
