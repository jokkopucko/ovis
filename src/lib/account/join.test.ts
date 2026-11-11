import { afterEach, describe, expect, it } from "bun:test";
import { AccountMailbox } from "../../../server/account/mailbox.ts";
import { rotateRelayIdentity } from "../../../server/relay/identity.ts";
import type { RelayIdentity } from "../../../server/relay/identity.ts";
import { relayConnection, relayDevice, relayFixture } from "../../../server/relay/test-helpers.ts";
import { accountDeviceId, exportAccountKey } from "../../../shared/account-records.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { generateKeyPair, importPublicKey } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { RelayDevice } from "../relay/device.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { newRecordId, readAccountRecord, signAccountRecord } from "../../../shared/account-records.ts";
import { AdmissionChangedError, admitToAccount, approveJoin, enrollOnPc, vouchedAdmission, enrollPc, keepRemovals, linkThisDevice, rememberDevice, needsLink, pcAccountStatus, planEnroll, takeIntroduction, UnverifiedJoinError, sendQueuedAdds } from "./join.ts";
import { leaveAccount, removeFromAccount } from "./leave.ts";
import { myPcs } from "./myPcs.ts";
import { AccountService } from "./service.ts";
import { memoryAccountStore } from "./store.ts";
import type { AccountKey } from "./store.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";
const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;

type Fixture = ReturnType<typeof relayFixture>;
type Link = Awaited<ReturnType<typeof relayConnection>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** A PC with a relay identity of its own, as the relay would route to it. */
function pc(options: Parameters<typeof relayFixture>[1] = {}): { f: Fixture; identity: RelayIdentity } {
  const f = relayFixture(false, options);
  fixtures.push(f);
  return { f, identity: rotateRelayIdentity(f.stateDir) };
}

/** This client's requests to the PC, through its own signed-in relay session. */
const pcFetch = (link: Link) => async (path: string, init?: RequestInit): Promise<Response> => {
  if ((init?.method ?? "GET") === "GET") return link.open(path).response;
  const request = link.open(path, { method: "POST", headers: guard, body: "stream" });
  void request.stream.sendBody(new Response(init?.body ?? null).body ?? new ReadableStream()).catch(() => {});
  return request.response;
};

async function accountKey(): Promise<AccountKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_spki: await exportAccountKey(pair.publicKey) };
}

/** A phone paired with the PC by QR code before the account: a key of its own for that PC. */
async function qrPairing(at: ReturnType<typeof pc>, store: MemoryDeviceStore, name: string): Promise<RelayDevice> {
  const device = await relayDevice(at.f);
  return store.update(at.identity.server_id, () => ({
    server_id: at.identity.server_id, server_public_key: at.identity.public_key, relay: "wss://relay.example", name,
    device_id: device.id, private_key: device.keys.privateKey, public_spki: device.publicKey, label: "Phone",
  }));
}

/** Signs in to the PC through the relay with whatever key the saved pairing holds now. */
async function connect(at: ReturnType<typeof pc>, saved: RelayDevice): Promise<Link> {
  const link = await relayConnection(at.f, { serverId: at.identity.server_id });
  if (saved.device_id === null) throw new Error("not admitted");
  await link.auth({ keys: { privateKey: saved.private_key } as CryptoKeyPair, publicKey: saved.public_spki, id: saved.device_id });
  return link;
}

it("moves QR pairings into the account one PC at a time, and calls a PC it has not reached yet not covered", async () => {
  const [a, b] = [pc(), pc()];
  const store = new MemoryDeviceStore();
  const key = await accountKey();
  const onA = await qrPairing(a, store, "p620");
  await qrPairing(b, store, "nuc");
  const link = await connect(a, onA);
  expect(needsLink(await pcAccountStatus(pcFetch(link)), onA, ACCOUNT)).toBe(true);
  const linked = await linkThisDevice({ fetch: pcFetch(link), device: onA, key, account: ACCOUNT, store });
  expect(linked.public_spki).toBe(key.public_spki);
  expect(await pcAccountStatus(pcFetch(link))).toEqual({ account: ACCOUNT, unlinked: [], removals: [], adds: [], blocked: [], enrolling: true });
  // the linked pairing signs in with the account key from now on
  await connect(a, linked);
  const listed = [a, b].map((at) => ({ server_id: at.identity.server_id, label: "pc", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: null }));
  const rows = myPcs(listed, await store.list(), { now: Date.now(), accountKey: key.public_spki });
  expect(rows.map(({ name, linked: covered }) => [name, covered])).toEqual([["nuc", false], ["p620", true]]);
  expect(b.f.app.context.services.devices.accountRows().unlinked).toHaveLength(1);
});

it("leaves a pairing with a PC of another account as it is", () => {
  const device = { device_id: "ab".repeat(8) } as RelayDevice;
  expect(needsLink({ account: "acct_other", unlinked: ["ab".repeat(8)], removals: [], adds: [], blocked: [] }, device, ACCOUNT)).toBe(false);
});

it("brings an approved device into every PC of the account: the add waits in an offline PC's mailbox, and the introduction signs it in there", async () => {
  const [x, y] = [pc(), pc()];
  const approverKey = await accountKey();
  const phone = new MemoryDeviceStore();
  // the approving phone: already a member of both PCs
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key: approverKey, account: ACCOUNT, store: phone });
  await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key: approverKey, account: ACCOUNT, store: phone });
  const service = new FakeAccountService();
  const accountStore = memoryAccountStore();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const [at, label] of [[x, "p620"], [y, "nuc"]] as const) await account.putPc(at.identity.server_id, { label, public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  // PC X let the Mac in on this phone's remote approval
  const mac = await accountKey();
  const admitted = x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, mac.public_spki), key: mac.public_spki, label: "Mac app", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
  await admitToAccount({
    fetch: pcFetch(await connect(x, onX)), service: account, key: approverKey, account: ACCOUNT, joining: { key: mac.public_spki, label: "Mac app" },
    through: x.identity.server_id, paired: await phone.list(), directory: (await account.listPcs()).map((entry) => entry.server_id),
  });
  // PC Y was off: it finds the add in its mailbox when it comes back
  expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
  await new AccountMailbox({ devices: y.f.app.context.services.devices, identity: () => y.identity, service: SERVICE, fetch: service.fetch }).pull();
  expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(true);
  // the Mac learns PC Y from X and signs in there with the account key alone
  const macStore = new MemoryDeviceStore();
  const onXForMac = await macStore.update(x.identity.server_id, () => ({ server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: admitted.id, private_key: mac.private_key, public_spki: mac.public_spki, label: "Mac app" }));
  const introduced = await takeIntroduction({ fetch: pcFetch(await connect(x, onXForMac)), key: mac, label: "Mac app", store: macStore, relay: onXForMac.relay });
  expect(introduced.map((device) => [device.server_id, device.device_id])).toEqual([[y.identity.server_id, accountDeviceId(y.identity.server_id, mac.public_spki)]]);
  const onY = await macStore.get(y.identity.server_id);
  if (!onY) throw new Error("no introduction for Y");
  await connect(y, onY);
});

it("keeps an add the account service refused and sends it on the next try, so a PC that missed it still lets the device in", async () => {
  const [x, y] = [pc(), pc()];
  const approverKey = await accountKey();
  const phone = new MemoryDeviceStore();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key: approverKey, account: ACCOUNT, store: phone });
  await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key: approverKey, account: ACCOUNT, store: phone });
  const service = new FakeAccountService();
  const accountStore = memoryAccountStore();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  let refuse = true;
  const fetchOnce = (async (input: RequestInfo | URL, init?: RequestInit) => refuse && new URL(input instanceof Request ? input.url : String(input)).pathname === "/v1/records"
    ? Response.json({ error: "mailbox_full" }, { status: 429 }) : service.fetch(input, init)) as typeof fetch;
  const account = new AccountService({ store: accountStore, fetch: fetchOnce });
  for (const [at, label] of [[x, "p620"], [y, "nuc"]] as const) await account.putPc(at.identity.server_id, { label, public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const mac = await accountKey();
  x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, mac.public_spki), key: mac.public_spki, label: "Mac app", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
  // X let the Mac in; the service refuses the add for Y, so nothing reaches Y yet
  await admitToAccount({
    fetch: pcFetch(await connect(x, onX)), service: account, key: approverKey, account: ACCOUNT, joining: { key: mac.public_spki, label: "Mac app" },
    through: x.identity.server_id, paired: await phone.list(), directory: (await account.listPcs()).map((entry) => entry.server_id), store: accountStore,
  });
  await new AccountMailbox({ devices: y.f.app.context.services.devices, identity: () => y.identity, service: SERVICE, fetch: service.fetch }).pull();
  expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
  // the next time this device reads the account, the kept add goes out, once
  refuse = false;
  await sendQueuedAdds({ service: account, store: accountStore, account: ACCOUNT });
  await sendQueuedAdds({ service: account, store: accountStore, account: ACCOUNT });
  expect(await accountStore.get("adds")).toBeUndefined();
  await new AccountMailbox({ devices: y.f.app.context.services.devices, identity: () => y.identity, service: SERVICE, fetch: service.fetch }).pull();
  expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(true);
});

describe("enrolling a PC this device brings into the account", () => {
  /** A phone that is a member of PC X, which already belongs to the account, and has a QR pairing with PC Y, which does not. */
  async function setUp() {
    const service = new FakeAccountService();
    // Y collects its mailbox from the same service, which is when it retries records waiting on their signer
    // both PCs collect their mailboxes from the fake service, never the real one
    const [x, y] = [pc({ accountService: { url: SERVICE, fetch: service.fetch } }), pc({ accountService: { url: SERVICE, fetch: service.fetch } })];
    const phone = new MemoryDeviceStore();
    const accountStore = memoryAccountStore();
    const key = await accountStore.key();
    const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone });
    // X's first link: the app enrolls it at once, which ends X's wait for the account's devices
    expect((await pcFetch(await connect(x, onX))("/api/account/enroll", { method: "POST", body: JSON.stringify({ account: ACCOUNT, records: [] }) })).ok).toBe(true);
    await qrPairing(y, phone, "nuc");
    await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
    const account = new AccountService({ store: accountStore, fetch: service.fetch });
    await account.putPc(x.identity.server_id, { label: "p620", public_key: Array.from(importPublicKey(x.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
    /** this phone approves `label` on X, as a remote approval does */
    const approve = async (label: string): Promise<AccountKey> => {
      const joining = await accountKey();
      x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, joining.public_spki), key: joining.public_spki, label, role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
      await admitToAccount({ fetch: pcFetch(await connect(x, onX)), service: account, key, account: ACCOUNT, joining: { key: joining.public_spki, label },
        through: x.identity.server_id, paired: await phone.list(), directory: [x.identity.server_id], store: accountStore });
      return joining;
    };
    /** this phone disconnects `device` from the account, from X */
    const disconnect = async (device: AccountKey) => removeFromAccount({ service: account, accountStore, relayStore: phone, key: device.public_spki, account: ACCOUNT, hereId: x.identity.server_id, here: pcFetch(await connect(x, onX)) });
    /** links this phone on Y, which had no account: Y's enrollment is planned then */
    const linkY = async (): Promise<RelayDevice> => {
      const status = await pcAccountStatus(pcFetch(await connect(y, (await phone.get(y.identity.server_id))!)));
      expect(status.account).toBeNull();
      await planEnroll(accountStore, y.identity.server_id, ACCOUNT);
      return linkThisDevice({ fetch: pcFetch(await connect(y, (await phone.get(y.identity.server_id))!)), device: (await phone.get(y.identity.server_id))!, key, account: ACCOUNT, store: phone });
    };
    return { x, y, service, accountStore, account, key, onX, approve, disconnect, linkY };
  }

  it("tombstones on the new PC the devices this phone removed, and adds the ones it approved, but no key a PC merely lists", async () => {
    const { x, y, accountStore, onX, approve, disconnect, linkY } = await setUp();
    const mac = await approve("Mac app");
    const lost = await approve("Lost phone");
    await disconnect(lost);
    // X lists a device this phone never approved
    const stranger = await accountKey();
    x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, stranger.public_spki), key: stranger.public_spki, label: "Stranger", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });

    const onY = await linkY();
    expect((await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    const devices = y.f.app.context.services.devices;
    // this phone's own row (the fixture's label) and the Mac it approved are members there; the stranger has no signed add
    expect(devices.list(null, true).filter((row) => row.account_key !== undefined).map((row) => row.label)).toEqual(["Relay test", "Mac app"]);
    expect([devices.hasKey(mac.public_spki), devices.hasKey(stranger.public_spki), devices.hasKey(lost.public_spki)]).toEqual([true, false, false]);
    expect(devices.isTombstoned(lost.public_spki)).toBe(true);
    expect(await accountStore.get("enrolls")).toBeUndefined();
  });

  it("does not let back on the new PC a device another member removed, which this phone approved before", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    // another phone of the account removes the Mac on X; its remove never reaches Y
    const other = await accountKey();
    x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, other.public_spki), key: other.public_spki, label: "Other phone", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
    const remove = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: mac.public_spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: other.public_spki }, other.private_key);
    expect((await pcFetch(await connect(x, onX))("/api/account/records", { method: "POST", body: JSON.stringify({ records: [remove] }) })).ok).toBe(true);
    expect(x.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
    const onY = await linkY();
    // the phone reads X first: X keeps the Mac out, so its add stays home and Y holds the key
    const others = [{ serverId: x.identity.server_id, fetch: pcFetch(await connect(x, onX)) }];
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others });
    expect([enrolled.finished, enrolled.checked]).toEqual([true, 1]);
    expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
    // a copy of its add waiting in Y's mailbox is held back too
    const mailed = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: mac.public_spki, label: "Mac app", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: (await accountStore.key()).public_spki }, (await accountStore.key()).private_key);
    const [outcome] = await (await pcFetch(await connect(y, onY))("/api/account/records", { method: "POST", body: JSON.stringify({ records: [mailed] }) })).json().then((body) => (body as { results: unknown[] }).results);
    expect(outcome).toMatchObject({ outcome: "refused", code: "removal_pending" });
  });

  it("waits for the next connection when no other PC of the account answers, and sends nothing meanwhile", async () => {
    const { y, accountStore, approve, linkY } = await setUp();
    await approve("Mac app");
    const onY = await linkY();
    const away = { serverId: "f".repeat(32), fetch: async () => { throw new TypeError("offline"); } };
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [away] });
    expect([enrolled.finished, enrolled.checked, enrolled.of]).toEqual([false, 0, 1]);
    expect(((await pcAccountStatus(pcFetch(await connect(y, onY)))) as unknown as { enrolling?: boolean })).toBeDefined();
    expect((await (await pcFetch(await connect(y, onY))("/api/account/status")).json() as { enrolling: boolean }).enrolling).toBe(true);
  });

  it("sends no add and keeps the new PC's wait, without a lasting hold, while the only PC it read could not read its mailbox", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    await approve("Mac app");
    const onY = await linkY();
    const link = await connect(x, onX);
    const stale = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      return path.startsWith("/api/account/status") ? Response.json({ ...await answer.json() as object, fresh: false }) : answer;
    };
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [{ serverId: x.identity.server_id, fetch: stale }] });
    expect([enrolled.finished, enrolled.checked, enrolled.admitted]).toEqual([false, 0, []]);
    expect(y.f.app.context.services.accountHolds.enrolling()).toBe(true);
    // a passing failure leaves no permanent hold behind
    expect(y.f.app.context.services.accountHolds.full()).toBe(false);
  });

  it("relays its removes but sends no add when only PCs from before enrollments answered, and ends the new PC's wait", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    const onY = await linkY();
    const link = await connect(x, onX);
    const older = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      if (!path.startsWith("/api/account/status")) return answer;
      const { fresh: _fresh, ...rest } = await answer.json() as Record<string, unknown>;
      return Response.json(rest);
    };
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [{ serverId: x.identity.server_id, fetch: older }] });
    expect([enrolled.finished, enrolled.admitted]).toEqual([true, []]);
    expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
    expect(y.f.app.context.services.accountHolds.enrolling()).toBe(false);
  });

  it("sends no add while a PC from before enrollments answers beside a newer one", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    const onY = await linkY();
    const link = await connect(x, onX);
    const older = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      if (!path.startsWith("/api/account/status")) return answer;
      const { fresh: _fresh, ...rest } = await answer.json() as Record<string, unknown>;
      return Response.json(rest);
    };
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id,
      others: [{ serverId: x.identity.server_id, fetch: pcFetch(await connect(x, onX)) }, { serverId: "e".repeat(32), fetch: older }] });
    expect(enrolled.admitted).toEqual([]);
    expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
  });

  it("sends no add when the account lists other PCs this device cannot read", async () => {
    const { y, accountStore, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    const onY = await linkY();
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [], listed: 1 });
    expect([enrolled.finished, enrolled.admitted]).toEqual([true, []]);
    expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
  });

  it("sends a new PC from before enrollments its removes through records and no add", async () => {
    const { y, accountStore, approve, disconnect, linkY } = await setUp();
    const mac = await approve("Mac app");
    const lost = await approve("Lost phone");
    await disconnect(lost);
    const onY = await linkY();
    const link = await connect(y, onY);
    const paths: string[] = [];
    const older = async (path: string, init?: RequestInit) => {
      paths.push(path);
      const answer = await pcFetch(link)(path, init);
      if (!path.startsWith("/api/account/status")) return answer;
      const { enrolling: _enrolling, ...rest } = await answer.json() as Record<string, unknown>;
      return Response.json(rest);
    };
    expect((await enrollOnPc({ fetch: older, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id }))?.admitted).toEqual([]);
    expect(paths).not.toContain("/api/account/enroll");
    expect(y.f.app.context.services.devices.isTombstoned(lost.public_spki)).toBe(true);
    expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
  });

  it("keeps the plan for a new PC from before enrollments when a removal is signed while it runs", async () => {
    const { y, accountStore, approve, disconnect, linkY } = await setUp();
    const [mac, lost] = [await approve("Mac app"), await approve("Lost phone")];
    await disconnect(lost);
    const onY = await linkY();
    const link = await connect(y, onY);
    let removed = false;
    const older = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      if (path === "/api/account/records" && !removed) { removed = true; await disconnect(mac); }
      if (!path.startsWith("/api/account/status")) return answer;
      const { enrolling: _enrolling, ...rest } = await answer.json() as Record<string, unknown>;
      return Response.json(rest);
    };
    expect((await enrollOnPc({ fetch: older, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id }))?.finished).toBe(false);
    expect(await accountStore.get("enrolls")).not.toBeUndefined();
  });

  it("sends no add, and holds every one, when a PC it read lost removal evidence", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    const onY = await linkY();
    const link = await connect(x, onX);
    const blind = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      return path.startsWith("/api/account/status") ? Response.json({ ...await answer.json() as object, blocked_all: true }) : answer;
    };
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [{ serverId: x.identity.server_id, fetch: blind }] });
    expect(enrolled.admitted).toEqual([]);
    expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
    expect(y.f.app.context.services.accountHolds.full()).toBe(true);
  });

  it("introduces a device an unfinished attempt let in once the enrollment ends", async () => {
    const { x, y, accountStore, onX, approve, disconnect, linkY } = await setUp();
    const [mac, lost] = [await approve("Mac app"), await approve("Lost phone")];
    const onY = await linkY();
    const pcY = { server_id: y.identity.server_id, server_public_key: y.identity.public_key, relay: "wss://relay.example", name: "nuc" };
    const link = await connect(y, onY);
    let removed = false;
    // another tab removes a device while the enrollment is on its way to Y
    const racing = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      if (path === "/api/account/enroll" && !removed) { removed = true; await disconnect(lost); }
      return answer;
    };
    const others = async () => [{ serverId: x.identity.server_id, fetch: pcFetch(await connect(x, onX)) }];
    expect((await enrollPc({ fetch: racing, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: await others(), pc: pcY })).finished).toBe(false);
    expect((await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: await others(), pc: pcY })).finished).toBe(true);
    const macStore = new MemoryDeviceStore();
    const onXForMac = await macStore.update(x.identity.server_id, () => ({ server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: accountDeviceId(x.identity.server_id, mac.public_spki), private_key: mac.private_key, public_spki: mac.public_spki, label: "Mac app" }));
    expect((await takeIntroduction({ fetch: pcFetch(await connect(x, onXForMac)), key: mac, label: "Mac app", store: macStore, relay: "wss://relay.example" })).map((pc) => pc.server_id)).toEqual([y.identity.server_id]);
  });

  it("keeps the introductions a PC could not take, and sends them on the next connection", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    const onY = await linkY();
    const pcY = { server_id: y.identity.server_id, server_public_key: y.identity.public_key, relay: "wss://relay.example", name: "nuc" };
    const link = await connect(x, onX);
    const failing = async (path: string, init?: RequestInit) => path === "/api/account/introduce" ? Promise.reject(new TypeError("connection lost")) : pcFetch(link)(path, init);
    const first = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [{ serverId: x.identity.server_id, fetch: failing }], pc: pcY });
    expect([first.finished, first.admitted]).toEqual([false, [mac.public_spki]]);
    const again = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id, others: [{ serverId: x.identity.server_id, fetch: pcFetch(await connect(x, onX)) }], pc: pcY });
    expect(again.finished).toBe(true);
    expect(await accountStore.get("enrolls")).toBeUndefined();
    const macStore = new MemoryDeviceStore();
    const onXForMac = await macStore.update(x.identity.server_id, () => ({ server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: accountDeviceId(x.identity.server_id, mac.public_spki), private_key: mac.private_key, public_spki: mac.public_spki, label: "Mac app" }));
    expect((await takeIntroduction({ fetch: pcFetch(await connect(x, onXForMac)), key: mac, label: "Mac app", store: macStore, relay: "wss://relay.example" })).map((pc) => pc.server_id)).toEqual([y.identity.server_id]);
  });

  it("brings the devices another PC lists into the new PC, and introduces the new PC to them there", async () => {
    const { x, y, accountStore, onX, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    // a tablet another member let in on X, with that member's signed add kept there
    const other = await approve("Other phone");
    const tablet = await accountKey();
    const tabletAdd = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: tablet.public_spki, label: "Tablet", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: other.public_spki }, other.private_key);
    const otherOnX: RelayDevice = { server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: accountDeviceId(x.identity.server_id, other.public_spki), private_key: other.private_key, public_spki: other.public_spki, label: "Other phone" };
    expect((await pcFetch(await connect(x, otherOnX))("/api/account/records", { method: "POST", body: JSON.stringify({ records: [tabletAdd] }) })).ok).toBe(true);
    const onY = await linkY();
    const pcY = { server_id: y.identity.server_id, server_public_key: y.identity.public_key, relay: "wss://relay.example", name: "nuc" };
    const enrolled = await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id,
      others: [{ serverId: x.identity.server_id, fetch: pcFetch(await connect(x, onX)) }], pc: pcY });
    expect(enrolled.finished).toBe(true);
    const devices = y.f.app.context.services.devices;
    for (const device of [mac, other, tablet]) expect(devices.hasKey(device.public_spki)).toBe(true);
    // the tablet learns Y from X and signs in there with the account key alone
    const tabletStore = new MemoryDeviceStore();
    const onXForTablet = await tabletStore.update(x.identity.server_id, () => ({ server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: accountDeviceId(x.identity.server_id, tablet.public_spki), private_key: tablet.private_key, public_spki: tablet.public_spki, label: "Tablet" }));
    const introduced = await takeIntroduction({ fetch: pcFetch(await connect(x, onXForTablet)), key: tablet, label: "Tablet", store: tabletStore, relay: "wss://relay.example" });
    expect(introduced.map((device) => device.server_id)).toEqual([y.identity.server_id]);
    await connect(y, introduced[0]!);
  });

  /** Another phone this phone approved, which then removes the Mac on X; this phone reads X afterwards. */
  async function removedByAnother(setup: Awaited<ReturnType<typeof setUp>>) {
    const { x, onX, accountStore, approve } = setup;
    const mac = await approve("Mac app");
    const other = await approve("Other phone");
    const remove = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: mac.public_spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: other.public_spki }, other.private_key);
    // the other phone removes the Mac on X, over its own session there
    const otherOnX: RelayDevice = { server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: accountDeviceId(x.identity.server_id, other.public_spki), private_key: other.private_key, public_spki: other.public_spki, label: "Other phone" };
    expect((await pcFetch(await connect(x, otherOnX))("/api/account/records", { method: "POST", body: JSON.stringify({ records: [remove] }) })).ok).toBe(true);
    await keepRemovals({ store: accountStore, account: ACCOUNT, removals: (await pcAccountStatus(pcFetch(await connect(x, onX)))).removals });
    return { mac, other, remove };
  }

  /** The other phone becomes a member of Y, as a remote approval by this phone makes it. */
  const joinsY = (setup: Awaited<ReturnType<typeof setUp>>, onY: RelayDevice, other: AccountKey) => {
    const devices = setup.y.f.app.context.services.devices;
    if (!devices.hasKey(other.public_spki)) devices.addAccountDevice({ id: accountDeviceId(setup.y.identity.server_id, other.public_spki), key: other.public_spki, label: "Other phone", role: "drive", account: ACCOUNT, addedBy: onY.device_id! });
  };

  it("relays another member's removal to the new PC as it was signed, with the add that lets its signer in, so the key is tombstoned there", async () => {
    const setup = await setUp();
    const { y, accountStore, linkY } = setup;
    const { mac, other, remove } = await removedByAnother(setup);
    const onY = await linkY();
    expect((await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    const devices = y.f.app.context.services.devices;
    // the removal waited for its signer, whose add came in the same enrollment
    expect(devices.hasKey(other.public_spki)).toBe(true);
    expect(devices.isTombstoned(mac.public_spki)).toBe(true);
    // with its own signature and issued_at: Y lists the very record the other phone signed
    expect(devices.accountRemovals()).toEqual([remove]);
    expect(devices.hasKey(mac.public_spki)).toBe(false);
  });

  it("relays removals in the order they were signed, so a member's removal comes after the ones it signed", async () => {
    const setup = await setUp();
    const { y, accountStore, disconnect, linkY } = setup;
    const { other, remove } = await removedByAnother(setup);
    // this phone then removes the other phone itself
    const { remove: removal } = await disconnect(other);
    const onY = await linkY();
    const sent: string[] = [];
    const watching = async (path: string, init?: RequestInit) => {
      if (path === "/api/account/enroll") sent.push(...(JSON.parse(String(init?.body)) as { records: { id: string }[] }).records.map(({ id }) => id));
      return pcFetch(await connect(y, onY))(path, init);
    };
    expect((await enrollPc({ fetch: watching, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    expect(sent).toEqual([remove.id, removal.id]);
  });

  it("still keeps the removals a device signed before this phone removed it, and none it signed after", async () => {
    const { x, accountStore, approve, disconnect } = await setUp();
    const [mac, other] = [await approve("Mac app"), await approve("Other phone")];
    const signedBy = (at: string) => signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: mac.public_spki, issued_at: at, id: newRecordId(), signer: other.public_spki }, other.private_key);
    const before = await signedBy(new Date(Date.now() - 60_000).toISOString());
    await disconnect(other);
    const after = await signedBy(new Date(Date.now() + 60_000).toISOString());
    expect(x.f.app.context.services.devices.hasKey(other.public_spki)).toBe(false);
    await keepRemovals({ store: accountStore, account: ACCOUNT, removals: [before, after] });
    expect(Object.values(await accountStore.get("removals") ?? {})).toEqual([before]);
  });

  it("leaves be a pairing made on the new PC after the relayed removal was signed", async () => {
    const setup = await setUp();
    const { y, accountStore, linkY } = setup;
    const { mac, other } = await removedByAnother(setup);
    const onY = await linkY();
    const devices = y.f.app.context.services.devices;
    expect((await (await relayConnection(y.f, { serverId: y.identity.server_id })).pair(devices.startPairing().code, mac.public_spki)).role).toBe("drive");
    expect((await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    joinsY(setup, onY, other);
    await y.f.app.context.services.accountMailbox.pull();
    expect(devices.hasKey(mac.public_spki)).toBe(true);
  });

  it("keeps and relays no removal it cannot check: unsigned, forged, another account's, or signed by a key this phone never approved", async () => {
    const setup = await setUp();
    const { y, accountStore, key, approve, linkY } = setup;
    const mac = await approve("Mac app");
    const stranger = await accountKey();
    const signed = (signer: AccountKey, account = ACCOUNT) => signAccountRecord({ v: 1, kind: "remove", account, key: mac.public_spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.public_spki }, signer.private_key);
    const genuine = await signed(key);
    await keepRemovals({ store: accountStore, account: ACCOUNT, removals: [
      { key: mac.public_spki, removed_at: new Date().toISOString() },
      { ...genuine, issued_at: "2020-01-01T00:00:00.000Z" },
      await signed(key, "acct_2"),
      await signed(stranger),
      "not a record",
    ] });
    expect(await accountStore.get("removals")).toBeUndefined();
    const onY = await linkY();
    const sent: unknown[] = [];
    const watching = async (path: string, init?: RequestInit) => {
      if (path === "/api/account/enroll") sent.push(...(JSON.parse(String(init?.body)) as { records: unknown[] }).records);
      return pcFetch(await connect(y, onY))(path, init);
    };
    expect((await enrollPc({ fetch: watching, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    expect(sent.filter((record) => (record as { kind?: string }).kind === "remove")).toEqual([]);
    expect(y.f.app.context.services.devices.isTombstoned(mac.public_spki)).toBe(false);
  });

  it("signs nothing a PC's status names: a PC that lists a removal it never got cannot take a device off the account", async () => {
    const { x, y, service, accountStore, account, key, approve, linkY } = await setUp();
    const mac = await approve("Mac app");
    const onY = await linkY();
    await account.putPc(y.identity.server_id, { label: "nuc", public_key: Array.from(importPublicKey(y.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
    const before = await accountStore.get("devices");
    // Y's status, tampered, says the account removed the Mac and this phone's own key
    const link = await connect(y, onY);
    const tampered = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      if (path !== "/api/account/status") return answer;
      return Response.json({ ...await answer.json() as object, removed: [{ key: mac.public_spki, removed_at: new Date().toISOString() }, { key: key.public_spki, removed_at: new Date().toISOString() }] });
    };
    expect((await enrollOnPc({ fetch: tampered, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id }))?.finished).toBe(true);
    // no remove was signed, kept or mailed anywhere, and the Mac is still in on X
    expect(await accountStore.get("devices")).toEqual(before);
    expect(await accountStore.get("adds")).toBeUndefined();
    for (const at of [x, y]) expect(service.mailbox(at.identity.server_id, ACCOUNT)).toEqual([]);
    expect(x.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(true);
  });

  it("keeps the later signed record of a device, so an approval that finishes late cannot undo its removal", async () => {
    const store = memoryAccountStore();
    const key = await accountKey();
    const mac = await accountKey();
    const sign = (kind: "add" | "remove", at: string) => signAccountRecord(kind === "add"
      ? { v: 1, kind, account: ACCOUNT, key: mac.public_spki, label: "Mac app", role: "drive", issued_at: at, id: newRecordId(), signer: key.public_spki }
      : { v: 1, kind, account: ACCOUNT, key: mac.public_spki, issued_at: at, id: newRecordId(), signer: key.public_spki }, key.private_key);
    const removal = await sign("remove", "2026-11-05T10:00:01.000Z");
    await rememberDevice(store, removal);
    await rememberDevice(store, await sign("add", "2026-11-05T10:00:00.000Z"));
    expect((await store.get("devices"))?.[mac.public_spki]).toEqual(removal);
    // approved again after the removal: no removal of it is enrolled any more
    const again = await sign("add", "2026-11-05T10:00:02.000Z");
    await rememberDevice(store, again);
    expect((await store.get("devices"))?.[mac.public_spki]).toEqual(again);
  });

  it("does not call an enrollment finished when a removal was signed while it ran", async () => {
    const { y, accountStore, approve, disconnect, linkY } = await setUp();
    const [mac, lost] = [await approve("Mac app"), await approve("Lost phone")];
    await disconnect(lost);
    const onY = await linkY();
    const link = await connect(y, onY);
    let removed = false;
    // another tab disconnects the Mac while the first removal is on its way to Y
    const racing = async (path: string, init?: RequestInit) => {
      const answer = await pcFetch(link)(path, init);
      if (!removed) { removed = true; await disconnect(mac); }
      return answer;
    };
    expect((await enrollPc({ fetch: racing, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(false);
    expect(y.f.app.context.services.devices.isTombstoned(mac.public_spki)).toBe(false);
    expect((await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    expect(y.f.app.context.services.devices.isTombstoned(mac.public_spki)).toBe(true);
  });

  it("tries again on the next connection until every record's outcome is known", async () => {
    const { y, accountStore, approve, disconnect, linkY } = await setUp();
    const lost = await approve("Lost phone");
    await disconnect(lost);
    const onY = await linkY();
    const link = await connect(y, onY);
    // the PC applies the enrollment but its answer never arrives
    const gone = async (path: string, init?: RequestInit) => { await pcFetch(link)(path, init); throw new TypeError("connection lost"); };
    await expect(enrollPc({ fetch: gone, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).rejects.toBeInstanceOf(TypeError);
    expect(await accountStore.get("enrolls")).toEqual({ [y.identity.server_id]: { account: ACCOUNT, done: [] } });
    expect((await enrollPc({ fetch: pcFetch(await connect(y, onY)), store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
    expect(y.f.app.context.services.devices.isTombstoned(lost.public_spki)).toBe(true);
    expect(await accountStore.get("enrolls")).toBeUndefined();
    // nothing planned for a PC: nothing is sent
    expect((await enrollPc({ fetch: async () => { throw new Error("no request expected"); }, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(true);
  });

  it("keeps a record the PC could not decide on for the next try", async () => {
    const { y, accountStore, approve, disconnect, linkY } = await setUp();
    await disconnect(await approve("Lost phone"));
    const onY = await linkY();
    const busy = async (path: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { records: { id: string }[] };
      return path === "/api/account/enroll" ? Response.json({ results: sent.records.map(({ id }) => ({ id, outcome: "refused", code: "account_unavailable" })) }) : pcFetch(await connect(y, onY))(path, init);
    };
    expect((await enrollPc({ fetch: busy, store: accountStore, account: ACCOUNT, serverId: y.identity.server_id })).finished).toBe(false);
    expect((await accountStore.get("enrolls"))?.[y.identity.server_id]?.done).toEqual([]);
  });
});

describe("approving a device that asks to join the account", () => {
  // the service's clock: a test moves it on so a second admission is really the newer one
  let clock = Date.now();
  async function setUp() {
    clock = Date.now();
    const fake = new FakeAccountService(() => clock);
    const store = memoryAccountStore();
    await store.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: fake.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
    const service = new AccountService({ store, fetch: fake.fetch });
    const pcKey = generateKeyPair().publicKey;
    const X = deriveServerId(pcKey);
    await service.putPc(X, { label: "p620", public_key: Array.from(pcKey, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
    // the new device, signed in to the same account, rang from PC X with its own key
    const mac = await accountKey();
    await service.postAdmission(X, "Mac app", mac.public_spki);
    return { fake, service, mac, X };
  }

  it("reads who is asking from the account service: the system the device sent and the place it rang from", async () => {
    const { fake, service, X } = await setUp();
    fake.requestPlace = { country: "KR", city: "Seoul" };
    const phone = await accountKey();
    await service.postAdmission(X, "iPhone", phone.public_spki, "ios");
    expect((await service.recentAdmissions()).map(({ label, os, country, city }) => ({ label, os, country, city }))).toEqual([
      { label: "Mac app", os: null, country: null, city: null },
      { label: "iPhone", os: "ios", country: "KR", city: "Seoul" },
    ]);
  });

  it("refuses when the PC shows a key the account service never saw join at that PC", async () => {
    const { fake, service, X } = await setUp();
    const swapped = await accountKey();
    const decisions: string[] = [];
    let admitted = false;
    const outcome = approveJoin({
      request: { id: "r1", label: "Mac app", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: swapped.public_spki },
      digits: "111111", through: X, service,
      decide: async (decision) => { decisions.push(decision); }, admit: async () => { admitted = true; },
    });
    await expect(outcome).rejects.toBeInstanceOf(UnverifiedJoinError);
    expect(decisions).toEqual(["decline"]);
    expect(admitted).toBe(false);
    expect(fake.admissions().length).toBeGreaterThan(0);
  });

  it("approves and adds the device the account service saw join at that PC", async () => {
    const { service, mac, X } = await setUp();
    const decisions: string[] = [];
    let admitted = false;
    await approveJoin({
      request: { id: "r1", label: "Mac app", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: mac.public_spki },
      digits: "222222", through: X, service,
      decide: async (decision, digits) => { decisions.push(`${decision}:${digits}`); }, admit: async () => { admitted = true; },
    });
    expect(decisions).toEqual(["approve:222222"]);
    expect(admitted).toBe(true);
  });

  it("adds the device under the name it gave the account service, not the one the PC shows", async () => {
    const { service, mac, X } = await setUp();
    let joining = "";
    await approveJoin({
      request: { id: "r1", label: "Hako's Mac", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: mac.public_spki },
      digits: "111111", through: X, service, decide: async () => {}, admit: async (admission) => { joining = admission.label; },
    });
    expect(joining).toBe("Mac app");
  });

  it("refuses to approve when the device asked again with other details after the card was shown", async () => {
    const { service, mac, X } = await setUp();
    const shown = vouchedAdmission(await service.recentAdmissions(), X, mac.public_spki, Date.now())!;
    clock += 1_000;
    await service.postAdmission(X, "Other name", mac.public_spki, "windows");
    const decisions: string[] = [];
    const outcome = approveJoin({
      request: { id: "r1", label: "Mac app", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: mac.public_spki },
      digits: "111111", through: X, service, shown, decide: async (decision) => { decisions.push(decision); }, admit: async () => {},
    });
    await expect(outcome).rejects.toBeInstanceOf(AdmissionChangedError);
    expect(decisions).toEqual([]);
  });

  it("refuses to approve when the card showed no admission but one turned up since", async () => {
    const { service, mac, X } = await setUp();
    const decisions: string[] = [];
    const outcome = approveJoin({
      request: { id: "r1", label: "Mac app", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: mac.public_spki },
      digits: "111111", through: X, service, shown: null, decide: async (decision) => { decisions.push(decision); }, admit: async () => {},
    });
    await expect(outcome).rejects.toBeInstanceOf(AdmissionChangedError);
    expect(decisions).toEqual([]);
  });

  it("refuses an admission shown for another key or PC, even with the same details", async () => {
    const { service, mac, X } = await setUp();
    const vouched = vouchedAdmission(await service.recentAdmissions(), X, mac.public_spki, Date.now())!;
    for (const shown of [{ ...vouched, key: "other-key" }, { ...vouched, server_id: "f".repeat(32) }]) {
      const outcome = approveJoin({
        request: { id: "r1", label: "Mac app", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: mac.public_spki },
        digits: "111111", through: X, service, shown, decide: async () => {}, admit: async () => {},
      });
      await expect(outcome).rejects.toBeInstanceOf(AdmissionChangedError);
    }
  });

  it("keeps the newest admission even when its name has nothing left once made plain", async () => {
    const { service, mac, X } = await setUp();
    clock += 1_000;
    await service.postAdmission(X, "\u202E\u2066", mac.public_spki, "windows");
    const newest = vouchedAdmission(await service.recentAdmissions(), X, mac.public_spki, clock);
    expect(newest?.os).toBe("windows");
    expect(newest?.label).toBe("Device");
  });

  it("reads a device's name as one plain line a signed add takes: no bidi or control characters, single spaces", async () => {
    const { service, X } = await setUp();
    const phone = await accountKey();
    await service.postAdmission(X, "  Hako\u202E's   iPhone\u2066 ", phone.public_spki);
    const label = (await service.recentAdmissions()).find((admission) => admission.key === phone.public_spki)!.label;
    expect(label).toBe("Hako's iPhone");
    const member = await accountKey();
    expect(await readAccountRecord(await signAccountRecord({
      v: 1, kind: "add", account: ACCOUNT, key: phone.public_spki, label, role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: member.public_spki,
    }, member.private_key))).not.toBeNull();
  });

  it("vouches with the newest fresh admission of that key at that PC, whatever order the service lists them in", () => {
    const now = Date.parse("2026-11-07T00:10:00.000Z");
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const admission = (label: string, minutesAgo: number, server_id = "pc-x", key = "k") => ({ key, label, server_id, at: at(minutesAgo), os: null, country: null, city: null });
    const listed = [admission("newest", 1), admission("older", 5), admission("stale", 11), admission("other pc", 0, "pc-y"), admission("other key", 0, "pc-x", "k2")];
    expect(vouchedAdmission(listed, "pc-x", "k", now)?.label).toBe("newest");
    expect(vouchedAdmission([...listed].reverse(), "pc-x", "k", now)?.label).toBe("newest");
    expect(vouchedAdmission([admission("stale", 11)], "pc-x", "k", now)).toBeUndefined();
    // the same millisecond: one pick whatever order the service lists them in
    const tied = [admission("first", 2), admission("second", 2)];
    expect(vouchedAdmission(tied, "pc-x", "k", now)?.label).toBe(vouchedAdmission([...tied].reverse(), "pc-x", "k", now)?.label);
  });

  it("declines another PC of the account vouched for when the account service never saw its key ask at that PC", async () => {
    const { service, X } = await setUp();
    const decisions: string[] = [];
    let admitted = false;
    const outcome = approveJoin({
      request: { id: "r1", label: "Ovis on Desk", intent: "pc", vouched: true, choices: ["111111", "222222", "333333"], expires_at: "", key: (await accountKey()).public_spki },
      digits: "111111", through: X, service, decide: async (decision) => { decisions.push(decision); }, admit: async () => { admitted = true; },
    });
    await expect(outcome).rejects.toBeInstanceOf(UnverifiedJoinError);
    expect(decisions).toEqual(["decline"]);
    expect(admitted).toBe(false);
  });

  it("approves another PC of the account vouched for only on that PC: its admission checked, nothing signed", async () => {
    const { service, X } = await setUp();
    const desk = await accountKey();
    await service.postAdmission(X, "Ovis on Desk", desk.public_spki, "linux");
    const shown = vouchedAdmission(await service.recentAdmissions(), X, desk.public_spki, Date.now())!;
    const decisions: string[] = [];
    let admitted = false;
    await approveJoin({
      request: { id: "r1", label: "Ovis on Desk", intent: "pc", vouched: true, choices: ["111111", "222222", "333333"], expires_at: "", key: desk.public_spki },
      digits: "222222", through: X, service, shown, decide: async (decision, digits) => { decisions.push(`${decision}:${digits}`); }, admit: async () => { admitted = true; },
    });
    expect(decisions).toEqual(["approve:222222"]);
    expect(admitted).toBe(false);
  });

  it("approves a request for this PC only without adding the device to the account", async () => {
    const { service, X } = await setUp();
    let admitted = false;
    await approveJoin({
      request: { id: "r1", label: "Phone", intent: "pc", choices: ["111111", "222222", "333333"], expires_at: "", key: (await accountKey()).public_spki },
      digits: "333333", through: X, service, decide: async () => {}, admit: async () => { admitted = true; },
    });
    expect(admitted).toBe(false);
  });
});

it("links a device that just paired over a connection of its own, as the session that paired cannot yet", async () => {
  const x = pc();
  const store = new MemoryDeviceStore();
  const key = await accountKey();
  const pairing = await relayConnection(x.f, { serverId: x.identity.server_id });
  const code = x.f.app.context.services.devices.startPairing().code;
  const admitted = await pairing.pair(code, key.public_spki);
  const device = await store.update(x.identity.server_id, () => ({
    server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example",
    device_id: admitted.device_id, private_key: key.private_key, public_spki: key.public_spki, label: "Phone",
  }));
  // the session that paired has not proved the key: the PC refuses the link there
  await expect(linkThisDevice({ fetch: pcFetch(pairing), device, key, account: ACCOUNT, store })).rejects.toMatchObject({ code: "link_not_owner" });
  // a connection that signs in with the saved key links it
  await linkThisDevice({ fetch: pcFetch(await connect(x, device)), device, key, account: ACCOUNT, store });
  expect(await pcAccountStatus(pcFetch(await connect(x, device)))).toEqual({ account: ACCOUNT, unlinked: [], removals: [], adds: [], blocked: [], enrolling: true });
});
it("leaves the account from this device: every PC revokes it from its mailbox, and this device forgets the key and its pairings", async () => {
  const [a, b] = [pc(), pc()];
  const phone = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  for (const [at, name] of [[a, "p620"], [b, "nuc"]] as const) {
    await linkThisDevice({ fetch: pcFetch(await connect(at, await qrPairing(at, phone, name))), device: (await phone.get(at.identity.server_id))!, key, account: ACCOUNT, store: phone });
  }
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const at of [a, b]) await account.putPc(at.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  expect((await leaveAccount({ service: account, accountStore, relayStore: phone, session: (await account.session())! })).unconfirmed).toEqual([]);
  expect(await phone.list()).toEqual([]);
  expect(await accountStore.get("session")).toBeUndefined();
  for (const at of [a, b]) {
    expect(at.f.app.context.services.devices.hasKey(key.public_spki)).toBe(true);
    await new AccountMailbox({ devices: at.f.app.context.services.devices, identity: () => at.identity, service: SERVICE, fetch: service.fetch }).pull();
    expect(at.f.app.context.services.devices.hasKey(key.public_spki)).toBe(false);
  }
});

it("disconnects a lost device from every PC: at once on the PC this window is in, from the mailbox on the others", async () => {
  const [x, y] = [pc(), pc()];
  const phone = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone });
  const onY = await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key, account: ACCOUNT, store: phone });
  const lost = await accountKey();
  for (const [at, member] of [[x, onX], [y, onY]] as const) {
    at.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(at.identity.server_id, lost.public_spki), key: lost.public_spki, label: "Lost phone", role: "drive", account: ACCOUNT, addedBy: member.device_id! });
  }
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const at of [x, y]) await account.putPc(at.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const result = await removeFromAccount({ service: account, accountStore, relayStore: phone, key: lost.public_spki, account: ACCOUNT, hereId: x.identity.server_id, here: pcFetch(await connect(x, onX)) });
  // applied here; only sent to Y's mailbox, which may refuse it (this device revoked there): named, not claimed
  expect(result.queued).toEqual([y.identity.server_id]);
  expect(x.f.app.context.services.devices.hasKey(lost.public_spki)).toBe(false);
  expect(y.f.app.context.services.devices.hasKey(lost.public_spki)).toBe(true);
  await new AccountMailbox({ devices: y.f.app.context.services.devices, identity: () => y.identity, service: SERVICE, fetch: service.fetch }).pull();
  expect(y.f.app.context.services.devices.hasKey(lost.public_spki)).toBe(false);
  // the phone that disconnected it is still in on both
  expect(x.f.app.context.services.devices.hasKey(key.public_spki)).toBe(true);
});

it("names a PC this device is linked on that the account does not list, instead of passing it over", async () => {
  const [x, y] = [pc(), pc()];
  const phone = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone });
  const onY = await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key, account: ACCOUNT, store: phone });
  const lost = await accountKey();
  for (const [at, member] of [[x, onX], [y, onY]] as const) {
    at.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(at.identity.server_id, lost.public_spki), key: lost.public_spki, label: "Lost phone", role: "drive", account: ACCOUNT, addedBy: member.device_id! });
  }
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const at of [x]) await account.putPc(at.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const result = await removeFromAccount({ service: account, accountStore, relayStore: phone, key: lost.public_spki, account: ACCOUNT, hereId: x.identity.server_id, here: pcFetch(await connect(x, onX)) });
  // applied here; only sent to Y's mailbox, which may refuse it (this device revoked there): named, not claimed
  expect(result.unconfirmed).toEqual([y.identity.server_id]);
  expect(x.f.app.context.services.devices.hasKey(lost.public_spki)).toBe(false);
});

it("still disconnects it on the PC in view when the account service refuses the mailbox, and names the others", async () => {
  const [x, y] = [pc(), pc()];
  const phone = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone });
  const onY = await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key, account: ACCOUNT, store: phone });
  const lost = await accountKey();
  for (const [at, member] of [[x, onX], [y, onY]] as const) {
    at.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(at.identity.server_id, lost.public_spki), key: lost.public_spki, label: "Lost phone", role: "drive", account: ACCOUNT, addedBy: member.device_id! });
  }
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => new URL(input instanceof Request ? input.url : String(input)).pathname === "/v1/records" ? Response.json({ error: "mailbox_full" }, { status: 429 }) : service.fetch(input, init)) as typeof fetch });
  for (const at of [x, y]) await account.putPc(at.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const result = await removeFromAccount({ service: account, accountStore, relayStore: phone, key: lost.public_spki, account: ACCOUNT, hereId: x.identity.server_id, here: pcFetch(await connect(x, onX)) });
  // applied here; only sent to Y's mailbox, which may refuse it (this device revoked there): named, not claimed
  expect(result.unconfirmed).toEqual([y.identity.server_id]);
  expect(x.f.app.context.services.devices.hasKey(lost.public_spki)).toBe(false);
});

it("keeps a pairing the account does not list when this device leaves, and says which", async () => {
  const [a, hidden] = [pc(), pc()];
  const phone = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  for (const [at, name] of [[a, "p620"], [hidden, "nuc"]] as const) {
    await linkThisDevice({ fetch: pcFetch(await connect(at, await qrPairing(at, phone, name))), device: (await phone.get(at.identity.server_id))!, key, account: ACCOUNT, store: phone });
  }
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  // only one PC is in the directory: the other never reached it (or the service hides it)
  await account.putPc(a.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(a.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const { unconfirmed } = await leaveAccount({ service: account, accountStore, relayStore: phone, session: (await account.session())! });
  expect(unconfirmed).toEqual([hidden.identity.server_id]);
  expect((await phone.list()).map((device) => device.server_id)).toEqual([hidden.identity.server_id]);
  // the listed PCs tombstone that key: the next sign-in makes a new one, and the kept pairing still connects with its own
  expect((await accountStore.key()).public_spki).not.toBe(key.public_spki);
  expect((await phone.get(hidden.identity.server_id))!.public_spki).toBe(key.public_spki);
});

it("names the PCs a disconnect cannot reach, where this device is not a member, instead of claiming every PC", async () => {
  const [x, y] = [pc(), pc()];
  const phone2 = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone2, "p620"))), device: (await phone2.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone2 });
  const lost = await accountKey();
  x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, lost.public_spki), key: lost.public_spki, label: "Lost phone", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const at of [x, y]) await account.putPc(at.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const { unconfirmed } = await removeFromAccount({ service: account, accountStore, relayStore: phone2, key: lost.public_spki, account: ACCOUNT, hereId: x.identity.server_id, here: pcFetch(await connect(x, onX)) });
  expect(unconfirmed).toEqual([y.identity.server_id]);
  expect(service.mailbox(y.identity.server_id, ACCOUNT)).toEqual([]);
  expect(x.f.app.context.services.devices.hasKey(lost.public_spki)).toBe(false);
});

it("keeps the account key it linked to when the PC's answer is lost, so the next sign-in can try it", async () => {
  const x = pc();
  const store = new MemoryDeviceStore();
  const key = await accountKey();
  const saved = await qrPairing(x, store, "p620");
  const link = await connect(x, saved);
  const lost = async (path: string, init?: RequestInit) => { await pcFetch(link)(path, init); throw new TypeError("connection lost"); };
  await expect(linkThisDevice({ fetch: lost, device: saved, key, account: ACCOUNT, store })).rejects.toBeInstanceOf(TypeError);
  const after = await store.get(x.identity.server_id);
  expect(after?.public_spki).toBe(saved.public_spki);
  expect(after?.pending_key?.public_spki).toBe(key.public_spki);
  // the PC holds the account key now: the kept one signs in
  await connect(x, { ...after!, private_key: after!.pending_key!.private_key, public_spki: after!.pending_key!.public_spki });
});

it("introduces only the PCs the approver is in the account on, not a pairing it has not linked yet", async () => {
  const [x, y, z] = [pc(), pc(), pc()];
  const phone = new MemoryDeviceStore();
  const key = await accountKey();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone });
  await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key, account: ACCOUNT, store: phone });
  await qrPairing(z, phone, "old-desktop");
  const mac = await accountKey();
  x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, mac.public_spki), key: mac.public_spki, label: "Mac app", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
  const service = new FakeAccountService();
  const accountStore = memoryAccountStore();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  await admitToAccount({ fetch: pcFetch(await connect(x, onX)), service: new AccountService({ store: accountStore, fetch: service.fetch }), key, account: ACCOUNT,
    joining: { key: mac.public_spki, label: "Mac app" }, through: x.identity.server_id, paired: await phone.list(), directory: [] });
  const macStore = new MemoryDeviceStore();
  const macOnX = await macStore.update(x.identity.server_id, () => ({ server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: accountDeviceId(x.identity.server_id, mac.public_spki), private_key: mac.private_key, public_spki: mac.public_spki, label: "Mac app" }));
  const introduced = await takeIntroduction({ fetch: pcFetch(await connect(x, macOnX)), key: mac, label: "Mac app", store: macStore, relay: "wss://relay.example" });
  expect(introduced.map((device) => device.server_id)).toEqual([y.identity.server_id]);
  expect(introduced[0]?.introduced_at).toBeGreaterThan(0);
});

it("does not count a PC as reached when this device holds the account key there but the PC never confirmed it a member", async () => {
  const [x, y] = [pc(), pc()];
  const phone = new MemoryDeviceStore();
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key, account: ACCOUNT, store: phone });
  // paired with the account key, but the link never went through: not a member there
  await phone.update(y.identity.server_id, () => ({ server_id: y.identity.server_id, server_public_key: y.identity.public_key, relay: "wss://relay.example", device_id: "ab".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone" }));
  const lost = await accountKey();
  x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, lost.public_spki), key: lost.public_spki, label: "Lost phone", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
  const service = new FakeAccountService();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const at of [x, y]) await account.putPc(at.identity.server_id, { label: "pc", public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  const { unconfirmed } = await removeFromAccount({ service: account, accountStore, relayStore: phone, key: lost.public_spki, account: ACCOUNT, hereId: x.identity.server_id, here: pcFetch(await connect(x, onX)) });
  expect(unconfirmed).toEqual([y.identity.server_id]);
  const left = await leaveAccount({ service: account, accountStore, relayStore: phone, session: (await account.session())! });
  expect(left.unconfirmed).toEqual([y.identity.server_id]);
});
