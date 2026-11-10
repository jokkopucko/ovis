import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, type AccountRecord, type UnsignedAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { ACCOUNT_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { DeviceStore, mergeAccountTombstones, readDeviceRegistry } from "../devices.ts";
import { mergeRegistries } from "../state-merge.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { AccountHolds } from "./holds.ts";
import { AccountMailbox, PENDING_MAX, SIGN_IN_PULL_MS, SIGN_IN_PULL_RETRY_MS } from "./mailbox.ts";
import { AccountIntroductions, INTRODUCTION_TTL_MS } from "./introductions.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { applyAccountRecords } from "./records.ts";
import { createServer } from "../index.ts";

type Fixture = ReturnType<typeof relayFixture>;
type Link = Awaited<ReturnType<typeof relayConnection>>;
type Device = Awaited<ReturnType<typeof relayDevice>>;

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "acct_1";
const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function fixture(options: Parameters<typeof relayFixture>[1] = {}): Fixture {
  const made = relayFixture(false, options);
  fixtures.push(made);
  return made;
}

interface AccountKey { keys: CryptoKeyPair; spki: string }

async function accountKey(): Promise<AccountKey> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

const issued = () => new Date().toISOString();
/** a P-256 key in account form, for a held key that names no device here */
const SPKI_HELD = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEohc9drfTsvgAQFPdfyJRNVK8kwTU5TT1EGzwz2pYouZoYlXQEUOwFcKAsplXf9r8jjWDrG4tVcnnqT2-bIq4Ig";

const sign = (record: UnsignedAccountRecord, key: AccountKey) => signAccountRecord(record, key.keys.privateKey);

const add = (signer: AccountKey, key: string, account = ACCOUNT) =>
  sign({ v: 1, kind: "add", account, key, label: "Mac app", role: "drive", issued_at: issued(), id: newRecordId(), signer: signer.spki }, signer);

const remove = (signer: AccountKey, key: string) =>
  sign({ v: 1, kind: "remove", account: ACCOUNT, key, issued_at: issued(), id: newRecordId(), signer: signer.spki }, signer);

const linkRecord = (device: Device, key: AccountKey, overrides: Partial<Record<"server_id" | "device_id" | "old_key", string>> = {}) =>
  sign({ v: 1, kind: "link", account: ACCOUNT, key: key.spki, server_id: SERVER_ID, device_id: device.id, old_key: device.publicKey,
    issued_at: issued(), id: newRecordId(), signer: key.spki, ...overrides }, key);

async function signedIn(f: Fixture, device: Device): Promise<Link> {
  const link = await relayConnection(f);
  await link.auth(device);
  return link;
}

async function post(link: Link, target: string, body: unknown) {
  const request = link.open(target, { method: "POST", headers: guard, body: "stream" });
  void request.stream.sendBody(new Response(JSON.stringify(body)).body ?? new ReadableStream()).catch(() => {});
  const response = await request.response;
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> & { error?: { code: string }; results?: { outcome: string; code?: string }[] } };
}

async function status(link: Link) {
  return await (await link.open("/api/account/status").response).json() as { account: string | null; members: number; unlinked: string[] };
}

/** A relay device that linked its row to the account: the device as it signs in from then on. */
async function member(f: Fixture): Promise<{ device: Device; key: AccountKey; link: Link }> {
  const legacy = await relayDevice(f);
  const key = await accountKey();
  const before = await signedIn(f, legacy);
  expect((await post(before, "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  const device = { keys: key.keys, publicKey: key.spki, id: legacy.id };
  // a member acts from a session signed in with its account key; the PC's first member enrolls it, which lifts the barrier
  const link = await signedIn(f, device);
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(200);
  return { device, key, link };
}

function registryRow(f: Fixture, id: string) {
  const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
  return registry.kind === "ok" ? registry.devices.find((device) => device.id === id) : undefined;
}

test("a device links its row to the account over its own session, which gives the PC its first member", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const key = await accountKey();
  const link = await signedIn(f, legacy);
  expect((await status(link)).account).toBeNull();
  expect((await post(link, "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  expect(registryRow(f, legacy.id)).toMatchObject({ relay_public_key: key.spki, account: ACCOUNT });
  // the same session goes on, and from now on the device signs in with the account key
  expect(await status(link)).toEqual(expect.objectContaining({ account: ACCOUNT, members: 1, unlinked: [] }));
  const again = await relayConnection(f);
  expect((await again.auth({ keys: key.keys, publicKey: key.spki, id: legacy.id })).device_id).toBe(legacy.id);
});

test("a link is refused for another row, another PC, a stale key, a key another row holds, or off the relay", async () => {
  const f = fixture();
  const mine = await relayDevice(f);
  const other = await relayDevice(f);
  const key = await accountKey();
  const link = await signedIn(f, mine);
  const cases: [Promise<AccountRecord>, string][] = [
    [linkRecord(mine, key, { device_id: other.id }), "link_not_owner"],
    [linkRecord(mine, key, { server_id: "f".repeat(32) }), "link_not_owner"],
    [linkRecord(mine, key, { old_key: other.publicKey }), "link_not_owner"],
    [linkRecord(mine, { keys: other.keys, spki: other.publicKey }), "key_in_use"],
  ];
  for (const [record, code] of cases) expect((await post(link, "/api/account/link", { record: await record })).body.error?.code).toBe(code);
  const direct = await fetch(`http://127.0.0.1:${f.app.port}/api/account/link`, {
    method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: `http://127.0.0.1:${f.app.port}` },
    body: JSON.stringify({ record: await linkRecord(mine, key) }),
  });
  expect(((await direct.json()) as { error: { code: string } }).error.code).toBe("link_not_owner");
  expect(registryRow(f, mine.id)?.account).toBeUndefined();
});

test("a PC left half moved lists the relay rows account removal does not reach, until each links on its next connection", async () => {
  const f = fixture();
  const { link } = await member(f);
  const later = await relayDevice(f);
  expect((await status(link)).unlinked).toEqual([later.id]);
  const key = await accountKey();
  expect((await post(await signedIn(f, later), "/api/account/link", { record: await linkRecord(later, key) })).status).toBe(200);
  expect(await status(link)).toEqual(expect.objectContaining({ members: 2, unlinked: [] }));
});

test("a member's add puts a device on this PC with who added it; a stranger's, another account's, a forged or a malformed one change nothing", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const [joining, stranger] = [await accountKey(), await accountKey()];
  const valid = await add(key, joining.spki);
  const results = (await post(link, "/api/account/records", { records: [
    valid, await add(stranger, (await accountKey()).spki), await add(key, (await accountKey()).spki, "acct_2"),
    { ...await add(key, (await accountKey()).spki), label: "Forged" }, { kind: "add" },
  ] })).body.results;
  expect(results?.map(({ outcome, code }) => code ?? outcome)).toEqual(["applied", "signer_not_member", "account_mismatch", "signature_invalid", "record_invalid"]);
  const added = f.app.context.services.devices.list(null).find((row) => row.label === "Mac app");
  expect(registryRow(f, added!.id)).toMatchObject({ relay_public_key: joining.spki, account: ACCOUNT, added_by: device.id });
  expect((await post(link, "/api/account/records", { records: [valid] })).body.results?.[0]?.outcome).toBe("unchanged");
  const joined = await relayConnection(f);
  expect((await joined.auth({ keys: joining.keys, publicKey: joining.spki, id: added!.id })).role).toBe("drive");
});

test("a member's remove cuts the device off at once and keeps it out: its add replayed is refused until this PC pairs it again", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  const replay = await add(key, lost.spki);
  await post(link, "/api/account/records", { records: [replay] });
  const lostId = f.app.context.services.devices.list(null).find((row) => row.label === "Mac app")!.id;
  const lostLink = await relayConnection(f);
  await lostLink.auth({ keys: lost.keys, publicKey: lost.spki, id: lostId });

  expect((await post(link, "/api/account/records", { records: [await remove(key, lost.spki)] })).body.results?.[0]?.outcome).toBe("applied");
  expect(await bounded(lostLink.serverError)).toBe("auth_revoked");
  expect((await post(link, "/api/account/records", { records: [replay] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });

  // a pairing made on this PC wins over the account's removal
  const again = await relayConnection(f);
  expect((await again.pair(f.app.context.services.devices.startPairing().code, lost.spki)).role).toBe("drive");
  expect(f.app.context.services.devices.isTombstoned(lost.spki)).toBe(false);
});

test("a removal's signed record stays with its tombstone and is listed in the status, verbatim, after a restart too", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, lost.spki)] });
  const removal = await remove(key, lost.spki);
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("applied");
  // a later remove of the same key by the same signer keeps the first record
  await post(link, "/api/account/records", { records: [await remove(key, lost.spki)] });
  // another member's removal of it is kept beside the first
  const second = await member(f);
  const secondRemoval = await remove(second.key, lost.spki);
  expect((await post(second.link, "/api/account/records", { records: [secondRemoval] })).body.results?.[0]?.outcome).toBe("unchanged");
  // a Revoke on the PC leaves a tombstone with no record, which is not listed
  const revoked = await relayDevice(f);
  f.app.context.services.devices.revoke(revoked.id);
  const listed = await (await link.open("/api/account/status").response).json() as { removals?: unknown };
  expect(listed.removals).toEqual([removal, secondRemoval]);
  expect(new DeviceStore(f.stateDir).accountRemovals() as unknown[]).toEqual([removal, secondRemoval]);
  // a record damaged on disk is dropped, never listed altered
  const path = join(f.stateDir, "account-tombstones.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { v: 1; tombstones: { records?: Record<string, unknown>[] }[] };
  writeFileSync(path, JSON.stringify({ ...saved, tombstones: saved.tombstones.map((t) => ({ ...t, records: t.records?.map((r) => ({ ...r, signature: undefined })) })) }), { mode: 0o600 });
  expect(new DeviceStore(f.stateDir).accountRemovals()).toEqual([]);
});

test("a member removed from the account signs nothing more here", async () => {
  const f = fixture();
  const first = await member(f);
  const second = await member(f);
  await post(second.link, "/api/account/records", { records: [await remove(second.key, first.key.spki)] });
  const late = await add(first.key, (await accountKey()).spki);
  expect((await post(second.link, "/api/account/records", { records: [late] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "signer_not_member" });
});

test("through the relay only a member of this PC's own account names the account its relay pass is asked under", async () => {
  const f = fixture();
  const { link } = await member(f);
  const outsider = await signedIn(f, await relayDevice(f));
  expect((await post(outsider, "/api/account/relay-account", { account: ACCOUNT })).body.error?.code).toBe("account_required");
  expect((await post(link, "/api/account/relay-account", { account: "acct_2" })).body.error?.code).toBe("account_required");
  expect((await post(link, "/api/account/relay-account", { account: ACCOUNT })).status).toBe(204);
});

test("only a member enrolls this PC, and the PC applies an enrollment's removes before its adds, whatever the order sent", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const outsider = await signedIn(f, await relayDevice(f));
  const [laptop, tablet, lost] = [await accountKey(), await accountKey(), await accountKey()];
  // the laptop's own addition comes first, before the add that lets the laptop in: it applies in the next round
  const records = [await add(laptop, tablet.spki), await add(key, lost.spki), await add(key, laptop.spki), await remove(key, lost.spki)];
  expect((await post(outsider, "/api/account/enroll", { account: ACCOUNT, records })).body.error?.code).toBe("account_required");
  expect((await post(link, "/api/account/enroll", { account: "acct_2", records })).body.error?.code).toBe("account_required");
  const results = (await post(link, "/api/account/enroll", { account: ACCOUNT, records })).body.results;
  expect(results?.map(({ outcome, code }) => code ?? outcome)).toEqual(["applied", "tombstoned", "applied", "applied"]);
  const store = f.app.context.services.devices;
  expect([store.hasKey(laptop.spki), store.hasKey(tablet.spki), store.hasKey(lost.spki)]).toEqual([true, true, false]);
});

test("the first link holds every account add back until its member enrolls the PC, across a restart, then lets the waiting ones in", async () => {
  const service = new FakeAccountService();
  const f = fixture({ accountService: { url: "https://account.test", fetch: service.fetch } });
  const identity = rotateRelayIdentity(f.stateDir);
  const legacy = await relayDevice(f);
  const key = await accountKey();
  expect((await post(await signedIn(f, legacy), "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  const link = await signedIn(f, { keys: key.keys, publicKey: key.spki, id: legacy.id });
  const [direct, mailed] = [await accountKey(), await accountKey()];
  expect((await post(link, "/api/account/records", { records: [await add(key, direct.spki)] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "enrolling" });
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record: await add(key, mailed.spki) }) }));
  const mailbox = f.app.context.services.accountMailbox;
  await mailbox.pull();
  const store = f.app.context.services.devices;
  expect(store.hasKey(mailed.spki)).toBe(false);
  // the barrier is on disk: a restart keeps it
  expect(new AccountHolds({ enrollingPath: join(f.stateDir, "account-enrolling.json") }).enrolling()).toBe(true);
  expect((await status(link) as { enrolling?: boolean }).enrolling).toBe(true);
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(200);
  expect(store.hasKey(mailed.spki)).toBe(true);
  expect((await post(link, "/api/account/records", { records: [await add(key, direct.spki)] })).body.results?.[0]?.outcome).toBe("applied");
});

test("a remove waiting for its signer keeps that key's adds out on every path; once an enrollment lets the signer in, the key is removed", async () => {
  const service = new FakeAccountService();
  const f = fixture({ accountService: { url: "https://account.test", fetch: service.fetch } });
  const identity = rotateRelayIdentity(f.stateDir);
  const { key, link } = await member(f);
  // another member removed the Mac elsewhere; this PC does not know that member yet
  const [other, mac] = [await accountKey(), await accountKey()];
  const removal = await remove(other, mac.spki);
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "signer_not_member" });
  const macAdd = await add(key, mac.spki);
  expect((await post(link, "/api/account/records", { records: [macAdd] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "removal_pending" });
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record: macAdd }) }));
  await f.app.context.services.accountMailbox.pull();
  const store = f.app.context.services.devices;
  expect(store.hasKey(mac.spki)).toBe(false);
  expect(((await status(link)) as { blocked?: string[] }).blocked).toContain(mac.spki);
  // the add that lets the other member in, then the Mac's add again: the remove applies between them
  const results = (await post(link, "/api/account/enroll", { account: ACCOUNT, records: [macAdd, await add(key, other.spki)] })).body.results;
  expect(results?.map(({ outcome, code }) => code ?? outcome)).toEqual(["removal_pending", "applied"]);
  expect(store.hasKey(mac.spki)).toBe(false);
  expect(store.isTombstoned(mac.spki)).toBe(true);
});

test("an add right behind a remove for its key in one batch meets that remove waiting for its signer", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const [other, mac] = [await accountKey(), await accountKey()];
  const results = (await post(link, "/api/account/records", { records: [await remove(other, mac.spki), await add(key, mac.spki)] })).body.results;
  expect(results?.map(({ outcome, code }) => code ?? outcome)).toEqual(["signer_not_member", "removal_pending"]);
  expect(f.app.context.services.devices.hasKey(mac.spki)).toBe(false);
});

test("only the member whose link brought the PC in ends its wait, and only with the last part of its enrollment", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const key = await accountKey();
  expect((await post(await signedIn(f, legacy), "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  const linker = await signedIn(f, { keys: key.keys, publicKey: key.spki, id: legacy.id });
  // a second device links while the first still reads the account's other PCs
  const second = await relayDevice(f);
  const secondKey = await accountKey();
  expect((await post(await signedIn(f, second), "/api/account/link", { record: await linkRecord(second, secondKey) })).status).toBe(200);
  const other = await signedIn(f, { keys: secondKey.keys, publicKey: secondKey.spki, id: second.id });
  const holds = f.app.context.services.accountHolds;
  expect((await post(other, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(200);
  expect(holds.enrolling()).toBe(true);
  expect((await post(linker, "/api/account/enroll", { account: ACCOUNT, records: [], last: false })).status).toBe(200);
  expect(holds.enrolling()).toBe(true);
  expect((await post(linker, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(200);
  expect(holds.enrolling()).toBe(false);
});

test("a fresh status says so only after the PC read its whole mailbox without an error", async () => {
  let failing = true;
  const service = new FakeAccountService();
  const flaky = async (request: Request) => failing ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : service.fetch(request);
  const f = fixture({ accountService: { url: "https://account.test", fetch: flaky } });
  rotateRelayIdentity(f.stateDir);
  const { link } = await member(f);
  const read = async () => await (await link.open("/api/account/status?fresh=1").response).json() as { fresh?: boolean };
  expect((await read()).fresh).toBe(false);
  failing = false;
  // a pull is asked for at most once every 10 seconds: a later one is the timer's
  await f.app.context.services.accountMailbox.pull();
  expect((await read()).fresh).toBe(true);
});

test("keys an enrollment holds stay out of every later path, while a device already here keeps its row", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const [here, held] = [await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, here.spki)] });
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records: [await add(key, held.spki)], held: [held.spki, here.spki] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "removal_pending" });
  expect((await post(link, "/api/account/records", { records: [await add(key, held.spki)] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "removal_pending" });
  const store = f.app.context.services.devices;
  expect([store.hasKey(here.spki), store.hasKey(held.spki)]).toEqual([true, false]);
  expect(new AccountHolds({ heldPath: join(f.stateDir, "account-held.json") }).holds(held.spki)).toBe(true);
});

test("the status lists the signed adds behind the account's rows as received, and every key the PC keeps out", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const [added, removed] = [await accountKey(), await accountKey()];
  const addition = await add(key, added.spki);
  await post(link, "/api/account/records", { records: [addition, await add(key, removed.spki)] });
  await post(link, "/api/account/records", { records: [await remove(key, removed.spki)] });
  const revoked = await relayDevice(f);
  f.app.context.services.devices.revoke(revoked.id);
  const listed = await (await link.open("/api/account/status?fresh=1").response).json() as { adds?: unknown[]; blocked?: string[] };
  expect(listed.adds).toEqual([addition]);
  expect(new Set(listed.blocked)).toEqual(new Set([removed.spki, revoked.publicKey]));
  // an approver's own add for a row its remote approval made is kept on that row, once
  const approved = await accountKey();
  const store = f.app.context.services.devices;
  const row = store.pairRelayApproved("Phone", approved.spki, { path: "account", addedBy: device.id, id: accountDeviceId(SERVER_ID, approved.spki) });
  expect(row).not.toBeNull();
  const approval = await add(key, approved.spki);
  expect((await post(link, "/api/account/records", { records: [approval] })).body.results?.[0]?.outcome).toBe("unchanged");
  expect(store.accountAdds() as unknown[]).toEqual([addition, approval]);
});

test("waiting records that cannot be read, or removes pushed out of a full queue, hold every add back", async () => {
  const f = fixture();
  const { key } = await member(f);
  const pendingPath = join(f.stateDir, "account-pending.json");
  writeFileSync(pendingPath, "{not json", { mode: 0o600 });
  const store = f.app.context.services.devices;
  const broken = new AccountMailbox({ devices: store, identity: () => undefined, service: "https://account.test", pendingPath });
  const joining = await accountKey();
  expect((await applyAccountRecords(store, [await add(key, joining.spki)], SERVER_ID, Date.now(), broken.gates()))[0]).toMatchObject({ outcome: "refused", code: "removal_pending" });
  // a full queue of removes whose signers never join: one more pushes the oldest out, and from then on no add applies
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const stranger = await accountKey();
  const waiting = await Promise.all(Array.from({ length: PENDING_MAX }, async () => remove(stranger, (await accountKey()).spki)));
  writeFileSync(pendingPath, JSON.stringify(waiting), { mode: 0o600 });
  const holds = new AccountHolds({ heldPath: join(f.stateDir, "account-held.json") });
  const mailbox = new AccountMailbox({ devices: store, identity: () => identity, service: "https://account.test", fetch: service.fetch, pendingPath, holds });
  await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record: await remove(stranger, (await accountKey()).spki) }) }));
  await mailbox.pull();
  expect(holds.holds(joining.spki)).toBe(true);
  expect(new AccountHolds({ heldPath: join(f.stateDir, "account-held.json") }).holds(joining.spki)).toBe(true);
});

test("an add right behind a remove the full queue could not keep is held back too", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const pendingPath = join(f.stateDir, "account-pending.json");
  const stranger = await accountKey();
  writeFileSync(pendingPath, JSON.stringify(await Promise.all(Array.from({ length: PENDING_MAX }, async () => remove(stranger, (await accountKey()).spki)))), { mode: 0o600 });
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => undefined, service: "https://account.test", pendingPath });
  const mac = await accountKey();
  const outcomes = await applyAccountRecords(f.app.context.services.devices, [await remove(stranger, mac.spki), await add(key, mac.spki)], SERVER_ID, Date.now(), mailbox.gates(), (record) => mailbox.wait(record));
  expect(outcomes.map((outcome) => outcome.outcome === "refused" ? outcome.code : outcome.outcome)).toEqual(["account_unavailable", "removal_pending"]);
  void link;
});

test("a retry after an enrollment and a mailbox pull at the same time never lose sight of a waiting remove", async () => {
  const service = new FakeAccountService();
  const f = fixture({ accountService: { url: "https://account.test", fetch: service.fetch } });
  const identity = rotateRelayIdentity(f.stateDir);
  const { key } = await member(f);
  const stranger = await accountKey();
  const target = await accountKey();
  const pendingPath = join(f.stateDir, "account-pending.json");
  const fillers = await Promise.all(Array.from({ length: 900 }, async () => remove(stranger, (await accountKey()).spki)));
  writeFileSync(pendingPath, JSON.stringify([...fillers, await remove(stranger, target.spki)]), { mode: 0o600 });
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record: await add(key, target.spki) }) }));
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch, pendingPath });
  await Promise.all([mailbox.settle(), mailbox.pull()]);
  expect(f.app.context.services.devices.hasKey(target.spki)).toBe(false);
});

test("a barrier file that cannot be read never lets the held keys be written over", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-holds-"));
  try {
    const [enrollingPath, heldPath] = [join(dir, "account-enrolling.json"), join(dir, "account-held.json")];
    new AccountHolds({ heldPath }).hold([SPKI_HELD]);
    writeFileSync(enrollingPath, "{not json", { mode: 0o600 });
    const broken = new AccountHolds({ enrollingPath, heldPath });
    expect(broken.holds("any")).toBe(true);
    expect(() => broken.hold([])).toThrow();
    rmSync(enrollingPath);
    expect(new AccountHolds({ enrollingPath, heldPath }).holds(SPKI_HELD)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a relayed remove the full queue cannot take still keeps its key out, and only true or false is taken for last", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const pendingPath = join(f.stateDir, "account-pending.json");
  const stranger = await accountKey();
  writeFileSync(pendingPath, JSON.stringify(await Promise.all(Array.from({ length: PENDING_MAX }, async () => remove(stranger, (await accountKey()).spki)))), { mode: 0o600 });
  const holds = new AccountHolds({ heldPath: join(f.stateDir, "account-held.json") });
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => undefined, service: "https://account.test", pendingPath, holds });
  const mac = await accountKey();
  expect(mailbox.wait(await remove(stranger, mac.spki))).toBe(false);
  expect((await applyAccountRecords(f.app.context.services.devices, [await add(key, mac.spki)], SERVER_ID, Date.now(), mailbox.gates()))[0]).toMatchObject({ outcome: "refused", code: "removal_pending" });
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records: [], last: "false" })).body.error?.code).toBe("record_invalid");
});

test("a fresh status reads the mailbox after the request, so a remove posted a moment before it is counted", async () => {
  const service = new FakeAccountService();
  const f = fixture({ accountService: { url: "https://account.test", fetch: service.fetch } });
  const identity = rotateRelayIdentity(f.stateDir);
  const { link } = await member(f);
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const read = async () => await (await link.open("/api/account/status?fresh=1").response).json() as { fresh?: boolean; blocked?: string[] };
  expect((await read()).fresh).toBe(true);
  const [stranger, mac] = [await accountKey(), await accountKey()];
  await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record: await remove(stranger, mac.spki) }) }));
  // within the ten seconds a join's pull is limited to
  expect((await read()).blocked).toContain(mac.spki);
});

test("a PC with no account service says its status is fresh: no mailbox can hold a removal for it", async () => {
  const f = fixture({ accountService: { url: "off" } });
  const { link } = await member(f);
  expect((await (await link.open("/api/account/status?fresh=1").response).json() as { fresh?: boolean }).fresh).toBe(true);
});

test("a PC whose account service address is unusable, not turned off, is never fresh", async () => {
  const f = fixture({ accountService: { url: "http://account.example" } });
  const { link } = await member(f);
  expect((await (await link.open("/api/account/status?fresh=1").response).json() as { fresh?: boolean }).fresh).toBe(false);
});

test("fresh requests at the same time share one mailbox pull", async () => {
  const service = new FakeAccountService();
  let pulls = 0;
  const counting = async (request: Request) => { if (new URL(request.url).pathname === "/v1/pc/challenge") pulls++; return service.fetch(request); };
  const f = fixture();
  const identity = rotateRelayIdentity(f.stateDir);
  await member(f);
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: counting });
  expect(await Promise.all(Array.from({ length: 5 }, () => mailbox.freshen()))).toEqual([true, true, true, true, true]);
  // the first starts a pull; the four that came while it ran share the one after it
  expect(pulls).toBe(2);
});

test("another member's enrollment during the barrier lets no add in; the linker's does", async () => {
  const f = fixture();
  const first = await relayDevice(f);
  const firstKey = await accountKey();
  expect((await post(await signedIn(f, first), "/api/account/link", { record: await linkRecord(first, firstKey) })).status).toBe(200);
  const second = await relayDevice(f);
  const secondKey = await accountKey();
  expect((await post(await signedIn(f, second), "/api/account/link", { record: await linkRecord(second, secondKey) })).status).toBe(200);
  const other = await signedIn(f, { keys: secondKey.keys, publicKey: secondKey.spki, id: second.id });
  const mac = await accountKey();
  expect((await post(other, "/api/account/enroll", { account: ACCOUNT, records: [await add(secondKey, mac.spki)] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "enrolling" });
  expect(f.app.context.services.devices.hasKey(mac.spki)).toBe(false);
});

test("an add signed by a member that a waiting remove names waits too", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const [stranger, b, t] = [await accountKey(), await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, b.spki)] });
  const results = (await post(link, "/api/account/records", { records: [await remove(stranger, b.spki), await add(b, t.spki)] })).body.results;
  expect(results?.map(({ outcome, code }) => code ?? outcome)).toEqual(["signer_not_member", "removal_pending"]);
  expect(f.app.context.services.devices.hasKey(t.spki)).toBe(false);
});

test("a member whose key an enrollment held, but who is here, still signs adds", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const [b, t] = [await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, b.spki)] });
  await post(link, "/api/account/enroll", { account: ACCOUNT, records: [], held: [b.spki] });
  expect((await post(link, "/api/account/records", { records: [await add(b, t.spki)] })).body.results?.[0]?.outcome).toBe("applied");
});

test("another member ends the wait once the member whose link started it is revoked", async () => {
  const f = fixture();
  const first = await relayDevice(f);
  const firstKey = await accountKey();
  expect((await post(await signedIn(f, first), "/api/account/link", { record: await linkRecord(first, firstKey) })).status).toBe(200);
  const second = await relayDevice(f);
  const secondKey = await accountKey();
  expect((await post(await signedIn(f, second), "/api/account/link", { record: await linkRecord(second, secondKey) })).status).toBe(200);
  f.app.context.services.devices.revoke(first.id);
  const other = await signedIn(f, { keys: secondKey.keys, publicKey: secondKey.spki, id: second.id });
  expect((await post(other, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(200);
  expect(f.app.context.services.accountHolds.enrolling()).toBe(false);
});

test("a row cannot link to a key this PC holds back", async () => {
  const f = fixture();
  const { link } = await member(f);
  const other = await relayDevice(f);
  const held = await accountKey();
  await post(link, "/api/account/enroll", { account: ACCOUNT, records: [], held: [held.spki] });
  expect((await post(await signedIn(f, other), "/api/account/link", { record: await linkRecord(other, held) })).body.error?.code).toBe("removal_pending");
  expect(f.app.context.services.devices.hasKey(held.spki)).toBe(false);
});

test("a new first member takes over the barrier of one revoked before it enrolled the PC", async () => {
  const f = fixture();
  const first = await relayDevice(f);
  const firstKey = await accountKey();
  expect((await post(await signedIn(f, first), "/api/account/link", { record: await linkRecord(first, firstKey) })).status).toBe(200);
  f.app.context.services.devices.revoke(first.id);
  expect(f.app.context.services.devices.account()).toBeNull();
  const next = await relayDevice(f);
  const nextKey = await accountKey();
  expect((await post(await signedIn(f, next), "/api/account/link", { record: await linkRecord(next, nextKey) })).status).toBe(200);
  const linked = await signedIn(f, { keys: nextKey.keys, publicKey: nextKey.spki, id: next.id });
  expect((await post(linked, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(200);
  expect(f.app.context.services.accountHolds.enrolling()).toBe(false);
});

test("the first link that succeeds keeps the barrier: a later link cannot take it over", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-holds-"));
  try {
    const enrollingPath = join(dir, "account-enrolling.json");
    const holds = new AccountHolds({ enrollingPath });
    holds.startEnrolling("first");
    holds.confirmEnrolling("first");
    holds.startEnrolling("second");
    holds.confirmEnrolling("second");
    expect(new AccountHolds({ enrollingPath }).enrollingMember()).toBe("first");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a full queue makes room for a relayed remove by dropping a waiting add, never a remove", async () => {
  const f = fixture();
  const { key } = await member(f);
  const pendingPath = join(f.stateDir, "account-pending.json");
  const stranger = await accountKey();
  const adds = await Promise.all(Array.from({ length: PENDING_MAX }, async () => add(stranger, (await accountKey()).spki)));
  writeFileSync(pendingPath, JSON.stringify(adds), { mode: 0o600 });
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => undefined, service: "https://account.test", pendingPath });
  const relayed = await remove(stranger, (await accountKey()).spki);
  expect(mailbox.wait(relayed)).toBe(true);
  const kept = JSON.parse(readFileSync(pendingPath, "utf8")) as unknown[];
  expect(kept).toHaveLength(PENDING_MAX);
  expect(kept).toContainEqual(relayed);
  // a full queue of waiting adds does not hold every other add back
  const joining = await accountKey();
  expect((await applyAccountRecords(f.app.context.services.devices, [await add(key, joining.spki)], SERVER_ID, Date.now(), mailbox.gates()))[0]?.outcome).toBe("applied");
});

test("a watch device reaches none of the account routes", async () => {
  const f = fixture();
  const watcher = await signedIn(f, await relayDevice(f, "watch"));
  expect((await (await watcher.open("/api/account/status").response).json() as { error: { code: string } }).error.code).toBe("read_only");
  expect((await post(watcher, "/api/account/records", { records: [] })).body.error?.code).toBe("read_only");
});

test("the PC selects the account feature for a client that offers it", async () => {
  const f = fixture();
  const link = await relayConnection(f);
  link.mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [ACCOUNT_FEATURE], required_features: [] } });
  const welcome = await new Promise<string[]>((resolve) => { link.onFrame = (frame) => { if (frame.type === FrameType.WELCOME) resolve([...frame.payload.features]); }; });
  expect(welcome).toEqual([ACCOUNT_FEATURE]);
});

test("the PC collects its mailbox with a proof of its relay key and applies it: removals reach a PC that was off", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, lost.spki)] });
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }), headers: { authorization: `Bearer ${token}` } }));
  const stranger = await accountKey();
  for (const record of [await remove(stranger, key.spki), await remove(key, lost.spki)]) {
    await service.fetch(new Request("https://account.test/v1/records", { method: "POST", body: JSON.stringify({ server_ids: [identity.server_id], record }), headers: { authorization: `Bearer ${token}` } }));
  }
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.pull()).toBe(1);
  expect(mailbox.error).toBeNull();
  expect(f.app.context.services.devices.hasKey(lost.spki)).toBe(false);
  expect(f.app.context.services.devices.hasKey(key.spki)).toBe(true);
  // the refused record is acknowledged with the applied one, so neither waits in the mailbox
  expect(service.mailbox(identity.server_id, ACCOUNT)).toEqual([]);
});

test("a new relay identity leaves the account: its members go with the relay pairings, and nothing is collected", async () => {
  const f = fixture();
  const { link } = await member(f);
  expect((await status(link)).account).toBe(ACCOUNT);
  await f.app.context.services.relay.resetIdentity();
  expect(f.app.context.services.devices.account()).toBeNull();
  const service = new FakeAccountService();
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => f.app.context.services.relay.currentIdentity(), service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.pull()).toBe(0);
  expect(service.requests).toEqual([]);
});

test("a revoke on this PC wins over the account: the device's signed add replayed is refused", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const record = await add(key, (await accountKey()).spki);
  await post(link, "/api/account/records", { records: [record] });
  f.app.context.services.devices.revoke(f.app.context.services.devices.list(null).find((row) => row.label === "Mac app")!.id);
  expect((await post(link, "/api/account/records", { records: [record] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });
});

test("a code started through the relay does not let a removed key back in", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const removed = await accountKey();
  await post(link, "/api/account/records", { records: [await remove(key, removed.spki)] });
  const code = (await post(link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  await expect((await relayConnection(f)).pair(code.code, removed.spki)).rejects.toThrow();
  expect(f.app.context.services.devices.isTombstoned(removed.spki)).toBe(true);
});

test("a session signed in with a row's old key cannot move the row on to a key of its choosing", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const oldSession = await signedIn(f, legacy);
  const current = await accountKey();
  expect((await post(oldSession, "/api/account/link", { record: await linkRecord(legacy, current) })).status).toBe(200);
  const takeover = await linkRecord(legacy, await accountKey(), { old_key: current.spki });
  expect((await post(oldSession, "/api/account/link", { record: takeover })).body.error?.code).toBe("link_not_owner");
  expect(registryRow(f, legacy.id)?.relay_public_key).toBe(current.spki);
});

test("a link cannot give a row the key another row holds, not even the key it signed in with", async () => {
  const f = fixture();
  const first = await member(f);
  const store = f.app.context.services.devices;
  const duplicate = store.pairRelay(store.startPairing().code, "Duplicate", first.key.spki)!.device;
  const twin = { id: duplicate.id, keys: first.key.keys, publicKey: first.key.spki };
  const session = await signedIn(f, twin);
  expect((await post(session, "/api/account/link", { record: await linkRecord(twin, first.key) })).body.error?.code).toBe("key_in_use");
});

test("a remove signed before this PC paired the key again leaves the new pairing be", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  const removal = await remove(key, lost.spki);
  await post(link, "/api/account/records", { records: [removal] });
  expect((await (await relayConnection(f)).pair(f.app.context.services.devices.startPairing().code, lost.spki)).role).toBe("drive");
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("unchanged");
  expect(f.app.context.services.devices.hasKey(lost.spki)).toBe(true);
});

test("a remove signed before a row was paired here still takes the key a link later moved that row onto", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const stolen = await accountKey();
  const removal = await sign({ v: 1, kind: "remove", account: ACCOUNT, key: stolen.spki, issued_at: new Date(Date.now() - 60_000).toISOString(), id: newRecordId(), signer: key.spki }, key);
  // paired on this PC as another key after the removal was signed, then moved onto the removed key by a link
  const legacy = await relayDevice(f);
  expect((await post(await signedIn(f, legacy), "/api/account/link", { record: await linkRecord(legacy, stolen) })).status).toBe(200);
  expect(f.app.context.services.devices.hasKey(stolen.spki)).toBe(true);
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("applied");
  expect(f.app.context.services.devices.hasKey(stolen.spki)).toBe(false);
  expect(registryRow(f, legacy.id)).toBeUndefined();
});

test("a link that keeps the key a row was paired with here leaves it a pairing of that key: an older remove still leaves it be", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const store = f.app.context.services.devices;
  const own = await accountKey();
  const removal = await sign({ v: 1, kind: "remove", account: ACCOUNT, key: own.spki, issued_at: new Date(Date.now() - 60_000).toISOString(), id: newRecordId(), signer: key.spki }, key);
  // paired on this PC with its account key after the removal was signed, then linked into the account with that same key
  const paired = store.pairRelay(store.startPairing().code, "Paired here", own.spki)!.device;
  const device = { id: paired.id, keys: own.keys, publicKey: own.spki };
  expect((await post(await signedIn(f, device), "/api/account/link", { record: await linkRecord(device, own) })).status).toBe(200);
  expect(registryRow(f, paired.id)).toMatchObject({ relay_public_key: own.spki, account: ACCOUNT, link_moved_key: false });
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("unchanged");
  expect(store.hasKey(own.spki)).toBe(true);
  // and a restart does not take it for a row to sweep
  expect(new DeviceStore(f.stateDir).hasKey(own.spki)).toBe(true);
});

/** A state dir as a stop between two writes leaves it: one relay row and a tombstone for its key. */
async function interrupted(rowCreated: string, removed: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-account-interrupted-"));
  const key = (await accountKey()).spki;
  const row = { id: "00112233445566aa", label: "Phone", role: "drive", token_hash: "0".repeat(64), relay_public_key: key, account: ACCOUNT, created_at: rowCreated, last_seen_at: null };
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: rowCreated, devices: [row] }), { mode: 0o600 });
  writeFileSync(join(stateDir, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r", removed_at: removed }] }), { mode: 0o600 });
  return { stateDir, key, store: () => new DeviceStore(stateDir) };
}

test("a tombstone older than a linked row takes it on start only when the link moved the row onto that key", async () => {
  // as a sibling dir's older tombstone comes back after this PC paired the key again and the device linked into the account
  for (const [moved, kept] of [[true, false], [false, true]] as const) {
    const state = await interrupted("2026-11-02T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    try {
      const path = join(state.stateDir, "devices.json");
      const registry = JSON.parse(readFileSync(path, "utf8")) as { devices: Record<string, unknown>[] };
      registry.devices[0] = { ...registry.devices[0], linked_at: "2026-11-03T00:00:00.000Z", link_moved_key: moved };
      writeFileSync(path, JSON.stringify(registry), { mode: 0o600 });
      const store = state.store();
      expect(store.error).toBeNull();
      expect(store.hasKey(state.key)).toBe(kept);
      expect(store.isTombstoned(state.key)).toBe(!kept);
    } finally { rmSync(state.stateDir, { recursive: true, force: true }); }
  }
});

test("a removal cut off between its two writes is finished when the PC starts", async () => {
  const state = await interrupted("2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  try {
    const store = state.store();
    expect(store.error).toBeNull();
    expect(store.hasKey(state.key)).toBe(false);
    expect(store.isTombstoned(state.key)).toBe(true);
    expect(store.list(null)).toEqual([]);
  } finally { rmSync(state.stateDir, { recursive: true, force: true }); }
});

test("a pairing on this PC cut off before it cleared the tombstone keeps its device when the PC starts", async () => {
  const state = await interrupted("2026-11-03T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  try {
    const store = state.store();
    expect(store.hasKey(state.key)).toBe(true);
    expect(store.isTombstoned(state.key)).toBe(false);
  } finally { rmSync(state.stateDir, { recursive: true, force: true }); }
});

test("an unreadable tombstone file refuses every account way in, and the mailbox collects nothing until it is fixed", async () => {
  const f = fixture();
  const { device, key } = await member(f);
  writeFileSync(join(f.stateDir, "account-tombstones.json"), "{not json", { mode: 0o600 });
  const store = new DeviceStore(f.stateDir);
  expect(store.accountError).not.toBeNull();
  expect((await applyAccountRecords(store, [await remove(key, (await accountKey()).spki)], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "account_unavailable" });
  expect(store.pairRelayApproved("Phone", (await accountKey()).spki, { path: "account", addedBy: device.id })).toBeNull();
  const service = new FakeAccountService();
  const mailbox = new AccountMailbox({ devices: store, identity: () => rotateRelayIdentity(f.stateDir), service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.pull()).toBe(0);
  expect(mailbox.error).not.toBeNull();
  expect(service.requests).toEqual([]);
});

test("two state dirs end with every tombstone of both", () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), "ovis-account-a-")), mkdtempSync(join(tmpdir(), "ovis-account-b-"))];
  try {
    const key = "a-removed-key";
    writeFileSync(join(a, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r", removed_at: "2026-11-02T00:00:00.000Z" }] }));
    writeFileSync(join(b, "account-tombstones.pending.json"), JSON.stringify({ v: 1, tombstones: [{ key: "a-pending-key", account: "", record_id: "local", removed_at: "2026-11-03T00:00:00.000Z" }] }));
    expect(mergeAccountTombstones(a, b)).toBeNull();
    expect(new DeviceStore(b).isTombstoned(key)).toBe(true);
    expect(new DeviceStore(a).isTombstoned("a-pending-key")).toBe(true);
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }); }
});

test("a bad account service address shows as the mailbox's error instead of stopping the PC", async () => {
  const f = fixture();
  await member(f);
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => rotateRelayIdentity(f.stateDir), service: new Error("The account service must be https") });
  expect(await mailbox.pull()).toBe(0);
  expect(mailbox.error).toBe("The account service must be https");
});

test("a PC that was off and gets a member's add and remove together ends without the device", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const passing = await accountKey();
  const signedEarlier = new Date(Date.now() - 60_000).toISOString();
  const records = [
    await sign({ v: 1, kind: "add", account: ACCOUNT, key: passing.spki, label: "Mac app", role: "drive", issued_at: signedEarlier, id: newRecordId(), signer: key.spki }, key),
    await sign({ v: 1, kind: "remove", account: ACCOUNT, key: passing.spki, issued_at: signedEarlier, id: newRecordId(), signer: key.spki }, key),
  ];
  expect((await post(link, "/api/account/records", { records })).body.results?.map(({ outcome }) => outcome)).toEqual(["applied", "applied"]);
  expect(f.app.context.services.devices.hasKey(passing.spki)).toBe(false);
  expect(f.app.context.services.devices.isTombstoned(passing.spki)).toBe(true);
});

test("a pairing by a code started through the relay does not outlast an older remove", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const target = await accountKey();
  const removal = await sign({ v: 1, kind: "remove", account: ACCOUNT, key: target.spki, issued_at: new Date(Date.now() - 60_000).toISOString(), id: newRecordId(), signer: key.spki }, key);
  const code = (await post(link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  await (await relayConnection(f)).pair(code.code, target.spki);
  const row = f.app.context.services.devices.list(null).find((d) => d.label === "New phone")!;
  expect(registryRow(f, row.id)?.added_by).toBe(device.id);
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("applied");
  expect(f.app.context.services.devices.hasKey(target.spki)).toBe(false);
});

test("an add for a key off the curve is refused and leaves devices.json readable", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const offCurve = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(86);
  expect((await post(link, "/api/account/records", { records: [await add(key, offCurve)] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "record_invalid" });
  expect(readDeviceRegistry(join(f.stateDir, "devices.json")).kind).toBe("ok");
});

test("a revoke while the tombstone file cannot be read still keeps the key out once it is fixed", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const extra = await accountKey();
  const record = await add(key, extra.spki);
  await post(link, "/api/account/records", { records: [record] });
  const saved = await Bun.file(join(f.stateDir, "account-tombstones.json")).exists() ? await Bun.file(join(f.stateDir, "account-tombstones.json")).text() : JSON.stringify({ v: 1, tombstones: [] });
  writeFileSync(join(f.stateDir, "account-tombstones.json"), "{broken", { mode: 0o600 });
  const broken = new DeviceStore(f.stateDir);
  expect(broken.revoke(broken.list(null).find((row) => row.label === "Mac app")!.id)).toBe(true);
  writeFileSync(join(f.stateDir, "account-tombstones.json"), saved, { mode: 0o600 });
  const fixed = new DeviceStore(f.stateDir);
  expect(fixed.accountError).toBeNull();
  expect(fixed.isTombstoned(extra.spki)).toBe(true);
  expect((await applyAccountRecords(fixed, [record], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });
});

test("merging two state dirs keeps a link done in either", () => {
  const linked = { id: "00112233445566aa", label: "Phone", role: "drive" as const, token_hash: "0".repeat(64), relay_public_key: "NEW", account: ACCOUNT, created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null };
  const old = { ...linked, relay_public_key: "OLD", account: undefined };
  const ids = new Set([linked.id]);
  const merged = mergeRegistries({ gate_closed_at: null, devices: [old] }, { gate_closed_at: null, devices: [linked] }, { own: ids, other: ids });
  expect(merged.devices[0]).toMatchObject({ relay_public_key: "NEW", account: ACCOUNT });
});

test("a member's relay code lets nobody in once the member is revoked", async () => {
  const f = fixture();
  const starter = await member(f);
  const code = (await post(starter.link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  f.app.context.services.devices.revoke(starter.device.id);
  await expect((await relayConnection(f)).pair(code.code, (await accountKey()).spki)).rejects.toThrow();
});

test("on a PC in no account a code a relay device started still pairs a new device", async () => {
  const f = fixture();
  const starter = await signedIn(f, await relayDevice(f));
  const code = (await post(starter, "/api/devices/pair/start", {})).body as unknown as { code: string };
  expect((await (await relayConnection(f)).pair(code.code, (await accountKey()).spki)).role).toBe("drive");
});

test("a device an add puts on this PC has the id both ends derive, and signs in with it", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const joining = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, joining.spki)] });
  const id = accountDeviceId(SERVER_ID, joining.spki);
  expect(registryRow(f, id)?.relay_public_key).toBe(joining.spki);
  expect((await (await relayConnection(f)).auth({ keys: joining.keys, publicKey: joining.spki, id })).device_id).toBe(id);
});

// A device a member added on another PC a moment ago signs in before this PC's next mailbox pull.

/** The fake account service with this PC in `ACCOUNT`'s directory, and a way to leave a record in the PC's mailbox. */
async function mailboxService(f: Fixture) {
  const service = new FakeAccountService();
  const identity = rotateRelayIdentity(f.stateDir);
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const leave = async (record: AccountRecord) => {
    const response = await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ server_ids: [identity.server_id], record }) }));
    expect(response.ok).toBe(true);
  };
  return { service, identity, leave };
}

/** A PC in the account with one member, whose server reads its mailbox at the fake account service. */
async function accountPc() {
  let fetch = (_request: Request): Promise<Response> => Promise.reject(new Error("no account service yet"));
  const made = await relayAccountFixture("drive", ACCOUNT, { accountService: { url: "https://account.test", fetch: (request) => fetch(request) } });
  fixtures.push(made.fixture);
  const { service, identity, leave } = await mailboxService(made.fixture);
  // the pull at start found no relay identity, so it asked nothing
  await made.fixture.app.context.services.accountMailbox.pull();
  fetch = service.fetch;
  service.requests.length = 0;
  const signer: AccountKey = { keys: made.member.keys, spki: made.member.publicKey };
  return { f: made.fixture, service, identity, leave, signer, member: made.member };
}

/** The session error a sign-in as `key` ends in, or null when it was let in. */
async function signInAs(f: Fixture, serverId: string, key: AccountKey): Promise<string | null> {
  const link = await relayConnection(f, { serverId });
  const entered = link.auth({ keys: key.keys, publicKey: key.spki, id: accountDeviceId(serverId, key.spki) }).then(() => null);
  return await Promise.race([entered, bounded(link.serverError)]).catch(() => bounded(link.serverError));
}

const pulls = (service: FakeAccountService) => service.requests.filter((request) => request === "POST /v1/pc/mailbox").length;

test("a device a member just added elsewhere signs in at once: the PC reads its mailbox for a device it does not know", async () => {
  const { f, service, identity, leave, signer } = await accountPc();
  const joining = await accountKey();
  await leave(await add(signer, joining.spki));
  expect(f.app.context.services.devices.hasKey(joining.spki)).toBe(false);
  expect(await signInAs(f, identity.server_id, joining)).toBeNull();
  expect(registryRow(f, accountDeviceId(identity.server_id, joining.spki))?.relay_public_key).toBe(joining.spki);
  expect(pulls(service)).toBeGreaterThan(0);
});

test("unknown devices make the PC read its mailbox at most once a minute, and are refused alike with and without a pull", async () => {
  const { f, service, identity, leave, signer } = await accountPc();
  const first = await signInAs(f, identity.server_id, await accountKey());
  expect(pulls(service)).toBeGreaterThan(0);
  const asked = service.requests.length;
  // an add that arrives now waits for the next pull: another unknown device within the minute asks the service nothing
  const late = await accountKey();
  await leave(await add(signer, late.spki));
  service.requests.length = asked;
  const second = await signInAs(f, identity.server_id, late);
  expect(service.requests.length).toBe(asked);
  expect(f.app.context.services.devices.hasKey(late.spki)).toBe(false);
  expect([first, second]).toEqual(["auth_failed", "auth_failed"]);
});

test("a member's own sign-in reads no mailbox, and a signature that does not hold is treated as an unknown device is", async () => {
  const { f, service, identity, member } = await accountPc();
  await (await relayConnection(f, { serverId: identity.server_id })).auth(member);
  expect(service.requests).toEqual([]);
  // the same way for an id with a row here as for one without, so the refusal's delay does not tell them apart
  const link = await relayConnection(f, { serverId: identity.server_id });
  const other = await accountKey();
  void link.auth({ keys: other.keys, publicKey: other.spki, id: member.id }).catch(() => {});
  expect(await bounded(link.serverError)).toBe("auth_failed");
  expect(pulls(service)).toBeGreaterThan(0);
  const asked = service.requests.length;
  // and on the same count: an unknown device within the minute asks the service nothing
  expect(await signInAs(f, identity.server_id, await accountKey())).toBe("auth_failed");
  expect(service.requests.length).toBe(asked);
});

test("a PC in no account reads no mailbox for an unknown device", async () => {
  let fetch = (_request: Request): Promise<Response> => Promise.reject(new Error("no account service yet"));
  const f = fixture({ accountService: { url: "https://account.test", fetch: (request) => fetch(request) } });
  await relayDevice(f);
  const { service, identity } = await mailboxService(f);
  fetch = service.fetch;
  service.requests.length = 0;
  expect(await signInAs(f, identity.server_id, await accountKey())).toBe("auth_failed");
  expect(service.requests).toEqual([]);
});

test("a key removed from the account stays out when its add waits in the mailbox an unknown device's sign-in reads", async () => {
  const { f, service, identity, leave, signer, member } = await accountPc();
  const removed = await accountKey();
  const link = await relayConnection(f, { serverId: identity.server_id });
  await link.auth(member);
  expect((await post(link, "/api/account/records", { records: [await remove(signer, removed.spki)] })).body.results?.[0]?.outcome).toBe("applied");
  await leave(await add(signer, removed.spki));
  service.requests.length = 0;
  expect(await signInAs(f, identity.server_id, removed)).toBe("auth_failed");
  // the pull ran and took the add out of the mailbox: it was refused, not left unread
  expect(pulls(service)).toBeGreaterThan(0);
  expect(service.mailbox(identity.server_id, ACCOUNT)).toEqual([]);
  expect(f.app.context.services.devices.hasKey(removed.spki)).toBe(false);
});

test("a refused sign-in waits for a slow account service only so long, and joins a pull under way", async () => {
  const { f, identity } = await accountPc();
  const answer = deferred<Response>();
  let calls = 0;
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test",
    fetch: () => { calls++; return answer.promise; } });
  await mailbox.pullForRefusedSignIn(1);
  expect(calls).toBe(1);
  // the pull is still under way: a second device joins it rather than being turned away by the once-a-minute count
  await mailbox.pullForRefusedSignIn(1);
  expect(calls).toBe(1);
  answer.resolve(new Response("{}", { status: 503 }));
  await mailbox.pull();
});

test("a pull that could not read the mailbox does not spend the minute: the next refused sign-in may ask again 10 seconds on", async () => {
  const { f, service, identity, leave, signer } = await accountPc();
  const devices = f.app.context.services.devices;
  let down = true;
  let calls = 0;
  const mailbox = new AccountMailbox({ devices, identity: () => identity, service: "https://account.test",
    fetch: (request) => { calls++; return down ? Promise.resolve(new Response("{}", { status: 503 })) : service.fetch(request); } });
  const joining = await accountKey();
  await leave(await add(signer, joining.spki));
  const start = 1_000_000;
  await mailbox.pullForRefusedSignIn(1_000, start);
  expect(calls).toBe(1);
  expect(mailbox.error).not.toBeNull();
  // the service is back, but a retry inside the short floor asks nothing
  down = false;
  await mailbox.pullForRefusedSignIn(1_000, start + SIGN_IN_PULL_RETRY_MS - 1);
  expect(calls).toBe(1);
  expect(devices.hasKey(joining.spki)).toBe(false);
  // after it, the retry reads the mailbox and finds the add
  await mailbox.pullForRefusedSignIn(1_000, start + SIGN_IN_PULL_RETRY_MS);
  expect(mailbox.error).toBeNull();
  expect(devices.hasKey(joining.spki)).toBe(true);
  // that pull read the mailbox: now the minute holds
  const read = calls;
  const again = start + SIGN_IN_PULL_RETRY_MS;
  await mailbox.pullForRefusedSignIn(1_000, again + SIGN_IN_PULL_MS - 1);
  expect(calls).toBe(read);
  await mailbox.pullForRefusedSignIn(1_000, again + SIGN_IN_PULL_MS);
  expect(calls).toBeGreaterThan(read);
});

test("a pull that fails after the sign-in stopped waiting for it gives the minute back too", async () => {
  const { f, identity } = await accountPc();
  const answer = deferred<Response>();
  let calls = 0;
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test",
    fetch: () => { calls++; return calls === 1 ? answer.promise : Promise.resolve(new Response("{}", { status: 503 })); } });
  const start = 1_000_000;
  await mailbox.pullForRefusedSignIn(1, start);
  answer.resolve(new Response("{}", { status: 503 }));
  await mailbox.pull();
  await mailbox.pullForRefusedSignIn(1, start + SIGN_IN_PULL_RETRY_MS);
  expect(calls).toBe(2);
});

function introducedPc(name = "nuc") {
  const keys = generateKeyPair();
  return { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.sh", name };
}

test("a member introduces the account's PCs to a device it added, which reads them over its own session only", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const joining = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, joining.spki)] });
  const pcs = [introducedPc(), introducedPc("laptop")];
  const introduced = link.open("/api/account/introduce", { method: "POST", headers: guard, body: "stream" });
  void introduced.stream.sendBody(new Response(JSON.stringify({ key: joining.spki, pcs })).body!).catch(() => {});
  expect((await introduced.response).status).toBe(204);
  const joined = await relayConnection(f);
  await joined.auth({ keys: joining.keys, publicKey: joining.spki, id: accountDeviceId(SERVER_ID, joining.spki) });
  expect(await (await joined.open("/api/account/introduction").response).json()).toEqual({ pcs });
  // the member's own session has no introduction of its own
  expect((await link.open("/api/account/introduction").response).status).toBe(404);
});

test("an introduction is refused from a non-member, for a device no member added, or with a PC whose id is not its key's", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const plain = await relayDevice(f);
  const outsider = await signedIn(f, plain);
  const joining = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, joining.spki)] });
  expect((await post(outsider, "/api/account/introduce", { key: joining.spki, pcs: [introducedPc()] })).body.error?.code).toBe("account_required");
  expect((await post(link, "/api/account/introduce", { key: plain.publicKey, pcs: [introducedPc()] })).body.error?.code).toBe("introduction_unknown_key");
  expect((await post(link, "/api/account/introduce", { key: joining.spki, pcs: [{ ...introducedPc(), server_id: "f".repeat(32) }] })).body.error?.code).toBe("introduction_invalid");
});

test("introductions for a device merge by PC, outlast a restart, and go once they expire", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-introductions-"));
  try {
    const path = join(dir, "account-introductions.json");
    let now = 0;
    const [nuc, laptop] = [introducedPc(), introducedPc("laptop")];
    const introductions = new AccountIntroductions(() => now, path);
    introductions.set("k", [nuc]);
    introductions.set("k", [laptop, { ...nuc, name: "nuc renamed" }]);
    now = INTRODUCTION_TTL_MS - 1;
    expect(new AccountIntroductions(() => now, path).get("k")).toEqual([laptop, { ...nuc, name: "nuc renamed" }]);
    now = INTRODUCTION_TTL_MS;
    expect(new AccountIntroductions(() => now, path).get("k")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the device list shows account members' account, key and adder to a driving device, and to a watching one nothing of it", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const joining = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, joining.spki)] });
  const plain = await relayDevice(f);
  const list = async (l: Link) => (await (await l.open("/api/devices").response).json() as { devices: Record<string, unknown>[] }).devices;
  const seen = await list(link);
  expect(seen.find((d) => d.id === device.id)).toMatchObject({ account: ACCOUNT, account_key: key.spki });
  expect(seen.find((d) => d.id === accountDeviceId(SERVER_ID, joining.spki))).toMatchObject({ account: ACCOUNT, account_key: joining.spki, added_by: device.id });
  expect(seen.find((d) => d.id === plain.id)).not.toHaveProperty("account");
  const watcher = await signedIn(f, await relayDevice(f, "watch"));
  for (const row of await list(watcher)) for (const field of ["account", "account_key", "added_by"]) expect(row).not.toHaveProperty(field);
});

test("the session that linked a row, still on the row's former key, acts as no member", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const first = await signedIn(f, legacy);
  const key = await accountKey();
  expect((await post(first, "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  const joining = await accountKey();
  const fresh = await signedIn(f, { keys: key.keys, publicKey: key.spki, id: legacy.id });
  await post(fresh, "/api/account/records", { records: [await add(key, joining.spki)] });
  expect((await post(first, "/api/account/introduce", { key: joining.spki, pcs: [introducedPc()] })).body.error?.code).toBe("account_required");
});

test("a device paired with a code, which sent its key but never signed with it, can neither read nor link as that key", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const victim = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, victim.spki)] });
  const introduced = link.open("/api/account/introduce", { method: "POST", headers: guard, body: "stream" });
  void introduced.stream.sendBody(new Response(JSON.stringify({ key: victim.spki, pcs: [introducedPc()] })).body!).catch(() => {});
  expect((await introduced.response).status).toBe(204);
  const code = (await post(link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  const impostor = await relayConnection(f);
  const paired = await impostor.pair(code.code, victim.spki);
  expect((await impostor.open("/api/account/introduction").response).status).toBe(404);
  const own = await accountKey();
  expect((await post(impostor, "/api/account/link", { record: await linkRecord({ id: paired.device_id, keys: victim.keys, publicKey: victim.spki }, own) })).body.error?.code).toBe("link_not_owner");
});

test("a device paired with a code a relay device started on a PC in no account is that device's addition, so an older remove takes it", async () => {
  const f = fixture();
  const starterDevice = await relayDevice(f);
  const legacy = await relayDevice(f);
  const starter = await signedIn(f, starterDevice);
  const code = (await post(starter, "/api/devices/pair/start", {})).body as unknown as { code: string };
  // the PC joins an account after the code was started, by a row linking itself; a member signed the removal before the pairing
  const key = await accountKey();
  expect((await post(await signedIn(f, legacy), "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  const link = await signedIn(f, { keys: key.keys, publicKey: key.spki, id: legacy.id });
  const target = await accountKey();
  const removal = await sign({ v: 1, kind: "remove", account: ACCOUNT, key: target.spki, issued_at: new Date(Date.now() - 60_000).toISOString(), id: newRecordId(), signer: key.spki }, key);
  expect((await (await relayConnection(f)).pair(code.code, target.spki)).role).toBe("drive");
  const row = f.app.context.services.devices.list(null).find((d) => d.label === "New phone")!;
  expect(registryRow(f, row.id)?.added_by).toBe(starterDevice.id);
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("applied");
  expect(f.app.context.services.devices.hasKey(target.spki)).toBe(false);
});

test("a link ends the row's other sessions from its former key, and keeps the one that linked", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const [first, stale] = [await signedIn(f, legacy), await signedIn(f, legacy)];
  const key = await accountKey();
  expect((await post(first, "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  expect(await bounded(stale.serverError)).toBe("auth_changed");
  // the linking session goes on (with the old key's rights until it signs in again)
  expect((await first.open("/api/devices").response).status).toBe(200);
});

test("a watching device added by a member reads its own introduction", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const watcher = await accountKey();
  const record = await sign({ v: 1, kind: "add", account: ACCOUNT, key: watcher.spki, label: "Tablet", role: "watch", issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key);
  await post(link, "/api/account/records", { records: [record] });
  const pcs = [introducedPc()];
  const introduced = link.open("/api/account/introduce", { method: "POST", headers: guard, body: "stream" });
  void introduced.stream.sendBody(new Response(JSON.stringify({ key: watcher.spki, pcs })).body!).catch(() => {});
  expect((await introduced.response).status).toBe(204);
  const session = await relayConnection(f);
  await session.auth({ keys: watcher.keys, publicKey: watcher.spki, id: accountDeviceId(SERVER_ID, watcher.spki) });
  expect(await (await session.open("/api/account/introduction").response).json()).toEqual({ pcs });
});

test("an admission counts only for the account and relay identity it was made for", async () => {
  const f = fixture();
  await member(f);
  let identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const waiting = await accountKey();
  await service.fetch(new Request("https://account.test/v1/admissions", { method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ server_id: identity.server_id, label: "Mac", key: waiting.spki }) }));
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.admitted(waiting.spki)).toBe(true);
  identity = rotateRelayIdentity(f.stateDir);
  expect(await mailbox.admitted(waiting.spki)).toBe(false);
});

test("a remove that reaches the PC before its signer's own add, in one pull, still applies", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const [b, c] = [await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, c.spki)] });
  const queue = async (record: AccountRecord) => service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record }) }));
  await queue(await remove(b, c.spki));
  await queue(await add(key, b.spki));
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch });
  await mailbox.pull();
  expect(f.app.context.services.devices.hasKey(b.spki)).toBe(true);
  expect(f.app.context.services.devices.hasKey(c.spki)).toBe(false);
});

test("merging two state dirs keeps the later of two links of one row", () => {
  const base = { id: "00112233445566aa", label: "Phone", role: "drive" as const, token_hash: "0".repeat(64), account: ACCOUNT, created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null };
  const earlier = { ...base, relay_public_key: "K1", linked_at: "2026-11-02T00:00:00.000Z" };
  const later = { ...base, relay_public_key: "K2", linked_at: "2026-11-03T00:00:00.000Z" };
  const ids = new Set([base.id]);
  expect(mergeRegistries({ gate_closed_at: null, devices: [earlier] }, { gate_closed_at: null, devices: [later] }, { own: ids, other: ids }).devices[0]?.relay_public_key).toBe("K2");
  expect(mergeRegistries({ gate_closed_at: null, devices: [later] }, { gate_closed_at: null, devices: [earlier] }, { own: ids, other: ids }).devices[0]?.relay_public_key).toBe("K2");
});

test("a sibling dir's unreadable tombstones keep account records out of the active dir", () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), "ovis-account-a-")), mkdtempSync(join(tmpdir(), "ovis-account-b-"))];
  try {
    writeFileSync(join(b, "account-tombstones.json"), "{broken");
    const blocked = mergeAccountTombstones(a, b);
    expect(blocked).not.toBeNull();
    expect(new DeviceStore(a, null, blocked).accountError).not.toBeNull();
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }); }
});

test("a row a member added goes with its key's tombstone on start, however late it was made", async () => {
  const state = await interrupted("2026-11-03T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  try {
    const rows = JSON.parse(readFileSync(join(state.stateDir, "devices.json"), "utf8")) as { devices: Record<string, unknown>[] };
    rows.devices[0]!.added_by = "00112233445566bb";
    writeFileSync(join(state.stateDir, "devices.json"), JSON.stringify(rows), { mode: 0o600 });
    const store = state.store();
    expect(store.hasKey(state.key)).toBe(false);
    expect(store.isTombstoned(state.key)).toBe(true);
  } finally { rmSync(state.stateDir, { recursive: true, force: true }); }
});

test("a remove at the end of a chain of adds read in reverse in one pull still applies", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const [b, c, d] = [await accountKey(), await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, d.spki)] });
  const queue = async (record: AccountRecord) => service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record }) }));
  await queue(await remove(b, d.spki));
  await queue(await add(c, b.spki));
  await queue(await add(key, c.spki));
  await new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch }).pull();
  expect(f.app.context.services.devices.hasKey(d.spki)).toBe(false);
});

/** An event stream opened (and subscribed) now; `until` reads it up to `needle`. */
async function openEvents(l: Link) {
  const reader = (await l.open("/api/machines/events").response).body!.getReader();
  let text = "";
  return {
    async until(needle: string) {
      while (!text.includes(needle)) {
        const chunk = await bounded(reader.read());
        if (chunk.done) throw new Error(`The stream ended before ${needle}`);
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    },
    close: () => reader.cancel(),
  };
}

test("a driving device hears of a device an account remove took, and of one revoked on the PC", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const [gone, revoked] = [await accountKey(), await relayDevice(f)];
  await post(link, "/api/account/records", { records: [await add(key, gone.spki)] });
  const events = await openEvents(link);
  await post(link, "/api/account/records", { records: [await remove(key, gone.spki)] });
  const removed = await events.until('"type":"device-removed"');
  expect(removed).toContain(`"device_id":"${accountDeviceId(SERVER_ID, gone.spki)}","label":"Mac app"`);
  expect(removed).toContain(`"by":{"device_id":"${device.id}","label":"Relay test"}`);
  f.app.context.services.devices.revoke(revoked.id);
  expect(await events.until(`"device_id":"${revoked.id}"`)).toContain('"by":"pc"');
  await events.close();
});

test("a watching device is not told of removals", async () => {
  const f = fixture();
  const watcher = await signedIn(f, await relayDevice(f, "watch"));
  const other = await relayDevice(f);
  const events = await openEvents(watcher);
  f.app.context.services.devices.revoke(other.id);
  // a pairing after it is told to every stream, in order: by then a removal would have arrived
  await relayDevice(f);
  expect(await events.until('"type":"device-paired"')).not.toContain("device-removed");
  await events.close();
});

test("a remove that reaches the PC a pull before its signer's own add still applies, even after a restart", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const [b, c] = [await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, c.spki)] });
  const queue = async (record: AccountRecord) => service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record }) }));
  const options = { devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch, pendingPath: join(f.stateDir, "account-pending.json") };
  await queue(await remove(b, c.spki));
  await new AccountMailbox(options).pull();
  expect(f.app.context.services.devices.hasKey(c.spki)).toBe(true);
  await queue(await add(key, b.spki));
  // a new mailbox, as after a restart, finds the waiting remove on disk
  await new AccountMailbox(options).pull();
  expect(f.app.context.services.devices.hasKey(b.spki)).toBe(true);
  expect(f.app.context.services.devices.hasKey(c.spki)).toBe(false);
});

test("a relayed removal waiting on its signer is kept beside the mailbox's, never in place of one, and on disk while a pull retries them", async () => {
  const f = fixture();
  await member(f);
  const identity = rotateRelayIdentity(f.stateDir);
  const pendingPath = join(f.stateDir, "account-pending.json");
  const [signer, target] = [await accountKey(), await accountKey()];
  const waiting = await remove(signer, target.spki);
  writeFileSync(pendingPath, JSON.stringify([waiting]), { mode: 0o600 });
  // the pull stops at the service until released, with the waiting record taken out to retry
  let release = () => {};
  const asked = Promise.withResolvers<void>();
  const stalled = async () => { asked.resolve(); await new Promise<void>((resolve) => { release = resolve; }); throw new Error("service away"); };
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: stalled, pendingPath });
  const pulling = mailbox.pull();
  await bounded(asked.promise);
  const relayed = await remove(signer, (await accountKey()).spki);
  mailbox.wait(relayed);
  // a stop now keeps both: the one the pull holds and the one just relayed
  expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual([waiting, relayed]);
  release();
  await pulling;
  expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual([waiting, relayed]);
  // a full queue takes no more relayed records, and pushes none out
  for (let i = 0; i < 1000; i++) mailbox.wait({ id: String(i) });
  const full = JSON.parse(readFileSync(pendingPath, "utf8")) as unknown[];
  expect(full).toHaveLength(1000);
  expect(full.slice(0, 2)).toEqual([waiting, relayed]);
});

test("a waiting remove survives a stop right after the service took its page's acknowledgement", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const [b, c] = [await accountKey(), await accountKey()];
  await post(link, "/api/account/records", { records: [await add(key, c.spki)] });
  const queue = async (record: AccountRecord) => service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_ids: [identity.server_id], record }) }));
  await queue(await remove(b, c.spki));
  // the request that carries the ack reaches the service, and its answer is lost
  const pendingPath = join(f.stateDir, "account-pending.json");
  // what is on disk the moment the acknowledgement leaves: a stop right then keeps only that
  let onDiskAtAck = "";
  const dropping = async (request: Request) => {
    const acknowledging = new URL(request.url).pathname === "/v1/pc/mailbox" && (await request.clone().json() as { ack: unknown }).ack !== null;
    if (acknowledging) onDiskAtAck = readFileSync(pendingPath, "utf8");
    const answer = await service.fetch(request);
    if (acknowledging) throw new Error("connection lost");
    return answer;
  };
  await new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: dropping, pendingPath }).pull();
  expect(service.mailbox(identity.server_id, ACCOUNT)).toEqual([]);
  expect(onDiskAtAck).toContain(c.spki);
  await queue(await add(key, b.spki));
  await new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch, pendingPath }).pull();
  expect(f.app.context.services.devices.hasKey(c.spki)).toBe(false);
});

test("a key paired again in one of two state dirs stays paired, without its tombstone, when the other starts", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const gone = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, gone.spki)] });
  await post(link, "/api/account/records", { records: [await remove(key, gone.spki)] });
  const sibling = mkdtempSync(join(tmpdir(), "ovis-account-sibling-"));
  // both dirs share the registry and the removal
  for (const name of ["devices.json", "account-tombstones.json"]) writeFileSync(join(sibling, name), readFileSync(join(f.stateDir, name)), { mode: 0o600 });
  const store = f.app.context.services.devices;
  // a second after the removal, as a person pairing again would be
  const later = Date.now() + 1_000;
  expect(store.pairRelay(store.startPairing(later).code, "Mac app", gone.spki, later)).not.toBeNull();
  const other = createServer({ port: 0, hostname: "127.0.0.1", stateDir: sibling, siblingStateDir: f.stateDir, token: "t", tailscaleOwner: null, machines: false, sidecar: false });
  try {
    // the merge brings the other dir's tombstone back, and the start-up repair drops it: the row is newer
    for (const devices of [other.context.services.devices, new DeviceStore(f.stateDir)]) {
      expect(devices.hasKey(gone.spki)).toBe(true);
      expect(devices.isTombstoned(gone.spki)).toBe(false);
    }
  } finally {
    other.stop();
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("a key revoked before the PC joined an account stays out: a member's signed add for it is refused", async () => {
  const f = fixture();
  const store = f.app.context.services.devices;
  const revoked = await accountKey();
  const before = store.pairRelay(store.startPairing().code, "Old phone", revoked.spki);
  if (!before) throw new Error("Expected relay enrollment");
  store.revoke(before.device.id);
  const { key, link } = await member(f);
  const outcome = await post(link, "/api/account/records", { records: [await add(key, revoked.spki)] });
  expect((outcome.body as unknown as { results: { outcome: string; code?: string }[] }).results[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });
  expect(store.hasKey(revoked.spki)).toBe(false);
});

test("an account remove for a key this PC revoked first makes its tombstone the account's", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const store = f.app.context.services.devices;
  const gone = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, gone.spki)] });
  store.revoke(accountDeviceId(SERVER_ID, gone.spki));
  const removal = await remove(key, gone.spki);
  await post(link, "/api/account/records", { records: [removal] });
  const kept = JSON.parse(readFileSync(join(f.stateDir, "account-tombstones.json"), "utf8")) as { tombstones: { key: string; record_id: string }[] };
  expect(kept.tombstones.find((t) => t.key === gone.spki)?.record_id).toBe(removal.id);
});

test("a key revoked on this PC stays out when a sibling dir that missed the revoke added it through the account", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const store = f.app.context.services.devices;
  const gone = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, gone.spki)] });
  const sibling = mkdtempSync(join(tmpdir(), "ovis-account-sibling-"));
  try {
    // the sibling dir still has the account's row; this dir then revokes it on the PC
    writeFileSync(join(sibling, "devices.json"), readFileSync(join(f.stateDir, "devices.json")), { mode: 0o600 });
    store.revoke(accountDeviceId(SERVER_ID, gone.spki));
    const registry = JSON.parse(readFileSync(join(sibling, "devices.json"), "utf8")) as { devices: { relay_public_key?: string; created_at: string }[] };
    // made a second after the revoke, as the sibling knew nothing of it
    for (const row of registry.devices) if (row.relay_public_key === gone.spki) row.created_at = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(join(sibling, "devices.json"), JSON.stringify(registry), { mode: 0o600 });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: f.stateDir, siblingStateDir: sibling, token: "t", tailscaleOwner: null, machines: false, sidecar: false });
    try {
      expect(app.context.services.devices.hasKey(gone.spki)).toBe(false);
    } finally { app.stop(); }
  } finally { rmSync(sibling, { recursive: true, force: true }); }
});

test("merging two dirs keeps the account's removal of a key over a revoke on the PC, with the later time", () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), "ovis-account-a-")), mkdtempSync(join(tmpdir(), "ovis-account-b-"))];
  try {
    const key = "a-removed-key";
    writeFileSync(join(a, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r1", removed_at: "2026-11-01T00:00:00.000Z" }] }));
    writeFileSync(join(b, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: "", record_id: "local", removed_at: "2026-11-02T00:00:00.000Z" }] }));
    expect(mergeAccountTombstones(a, b)).toBeNull();
    for (const dir of [a, b]) {
      const kept = JSON.parse(readFileSync(join(dir, "account-tombstones.json"), "utf8")) as { tombstones: { record_id: string; removed_at: string }[] };
      expect(kept.tombstones.map((t) => [t.record_id, t.removed_at])).toEqual([["r1", "2026-11-02T00:00:00.000Z"]]);
    }
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }); }
});

test("merging two dirs keeps the signed removals of both, one per signer", () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), "ovis-account-a-")), mkdtempSync(join(tmpdir(), "ovis-account-b-"))];
  try {
    const key = "a-removed-key";
    const [first, second] = [{ id: "r1", signer: "member-1" }, { id: "r2", signer: "member-2" }];
    writeFileSync(join(a, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r1", removed_at: "2026-11-01T00:00:00.000Z", records: [first] }] }));
    writeFileSync(join(b, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r1", removed_at: "2026-11-01T00:00:00.000Z", records: [first, second] }] }));
    expect(mergeAccountTombstones(a, b)).toBeNull();
    for (const dir of [a, b]) {
      const kept = JSON.parse(readFileSync(join(dir, "account-tombstones.json"), "utf8")) as { tombstones: { records?: unknown[] }[] };
      expect(kept.tombstones.map((t) => t.records)).toEqual([[first, second]]);
    }
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }); }
});

test("merging two dirs rewrites a dir whose tombstone for the key is the PC's revoke at the same time as the account's removal", () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), "ovis-account-a-")), mkdtempSync(join(tmpdir(), "ovis-account-b-"))];
  try {
    const key = "a-removed-key";
    const at = "2026-11-02T00:00:00.000Z";
    writeFileSync(join(a, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: "", record_id: "local", removed_at: at }] }));
    writeFileSync(join(b, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r1", removed_at: at }] }));
    expect(mergeAccountTombstones(a, b)).toBeNull();
    for (const dir of [a, b]) {
      const kept = JSON.parse(readFileSync(join(dir, "account-tombstones.json"), "utf8")) as { tombstones: { record_id: string }[] };
      expect(kept.tombstones.map((t) => t.record_id)).toEqual(["r1"]);
    }
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }); }
});


test("a watching member leaves the account on a PC with a remove signed by its own key", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const watcher = await accountKey();
  const record = await sign({ v: 1, kind: "add", account: ACCOUNT, key: watcher.spki, label: "Tablet", role: "watch", issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key);
  await post(link, "/api/account/records", { records: [record] });
  expect(f.app.context.services.devices.hasKey(watcher.spki)).toBe(true);
  const [left] = await applyAccountRecords(f.app.context.services.devices, [await remove(watcher, watcher.spki)], SERVER_ID);
  expect(left?.outcome).toBe("applied");
  expect(f.app.context.services.devices.hasKey(watcher.spki)).toBe(false);
});

test("a watching member still cannot remove another device", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const [watcher, other] = [await accountKey(), await accountKey()];
  const watch = await sign({ v: 1, kind: "add", account: ACCOUNT, key: watcher.spki, label: "Tablet", role: "watch", issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key);
  await post(link, "/api/account/records", { records: [watch, await add(key, other.spki)] });
  const [refused] = await applyAccountRecords(f.app.context.services.devices, [await remove(watcher, other.spki)], SERVER_ID);
  expect(refused).toMatchObject({ outcome: "refused", code: "signer_not_member" });
  expect(f.app.context.services.devices.hasKey(other.spki)).toBe(true);
});
