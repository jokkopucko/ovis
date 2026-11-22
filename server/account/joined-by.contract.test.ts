/**
 * How a device joined the PC's account (docs/account.md, "How a device joined"): the mark a link leaves on the row,
 * the members /api/account/status lists under `own_word`, and the two groups the PC's own health answer tells its
 * owner. No test sleeps: the clock a waiting device is bounded on is moved by hand, and nothing here moves it.
 */
import { randomBytes } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { DeviceStore } from "../devices.ts";
import * as herdr from "../herdr/client.ts";
import { TestClock } from "../relay/test-helpers.ts";
import { ask, linkRecord, memberRow, pairingPc, phone, sendLink, SERVER_ID, setUpFor, signedInWith, signIn, vouchFor, type Pc, type Phone } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
});

async function pc(options: Parameters<typeof pairingPc>[0] = {}) {
  const made = await pairingPc({ ...options, server: { accountOpensAll: false, ...options.server } });
  pcs.push(made);
  made.devices.useClock(new TestClock());
  return made;
}

/** The code of an offer made for `account`, as this PC's own page or command asks for it. */
async function codeFor(f: Pc, account: string): Promise<string> {
  const offer = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-expect-account": account } });
  const code = typeof offer.body.url === "string" ? decodeOffer(offer.body.url)?.code : undefined;
  if (offer.status !== 200 || code === undefined) throw new Error(`The offer gave no code: ${offer.status} ${JSON.stringify(offer.body)}`);
  return code;
}

/** A device that paired with a plain code and drives this PC, in no account yet. */
const driving = async (f: Pc) => signedInWith(f, await f.offerCode());

const marks = (f: Pc) => Object.fromEntries(f.stored().map((device) => [device.id, device.joined_by]));

/** What a new server on the same state folder lists: the mark is on disk. */
const afterRestart = (f: Pc) => new DeviceStore(f.stateDir).accountRows();

async function linked(session: Parameters<typeof sendLink>[0], id: string, account: string, from: Phone, to: Phone = from): Promise<void> {
  const answer = await sendLink(session, await linkRecord(id, account, from, to));
  if (answer.status !== 200) throw new Error(`The link was refused: ${answer.status} ${JSON.stringify(answer.body)}`);
}

test("a device that paired with a code made for an account and linked into it on that account's word is marked so: it is not listed, and a later link that moves its key and a restart keep that", async () => {
  const f = await pc();
  const owner = await signedInWith(f, await codeFor(f, "acct_1"));
  await vouchFor(f, "acct_1", owner.key);
  await linked(owner.session, owner.id, "acct_1", owner.key);
  expect(marks(f)).toEqual({ [owner.id]: "service" });
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, unlinked: [], own_word: [] });
  // a member reads the same list through the relay
  expect((await ask(owner.session, "/api/account/status")).body).toMatchObject({ account: "acct_1", own_word: [] });
  const moved = await phone();
  await linked(owner.session, owner.id, "acct_1", owner.key, moved);
  expect(f.stored()).toEqual([expect.objectContaining({ id: owner.id, relay_public_key: moved.spki, joined_by: "service" })]);
  expect(afterRestart(f)).toEqual({ members: 1, unlinked: [], own_word: [] });
});

test("the relay tab's code on a PC an account was named for marks the device it brings in the same way", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  const owner = await signedInWith(f, await f.tabCode());
  await vouchFor(f, "acct_1", owner.key);
  await linked(owner.session, owner.id, "acct_1", owner.key);
  expect(marks(f)).toEqual({ [owner.id]: "service" });
  expect(await f.status()).toMatchObject({ account: "acct_1", own_word: [] });
});

test("a device that already drives this PC and links it into an account joins on its own word: listed under own_word instead of unlinked, and still after a restart", async () => {
  const f = await pc();
  const device = await driving(f);
  expect(device.role).toBe("drive");
  expect(await f.status()).toMatchObject({ account: null, unlinked: [device.id], own_word: [] });
  await linked(device.session, device.id, "acct_1", device.key);
  expect(marks(f)).toEqual({ [device.id]: "word" });
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, unlinked: [], own_word: [device.id] });
  expect((await ask(device.session, "/api/account/status")).body).toMatchObject({ unlinked: [], own_word: [device.id] });
  expect(afterRestart(f)).toEqual({ members: 1, unlinked: [], own_word: [device.id] });
});

test("a relay device outside the account that links into the account the PC is in joins on its own word, beside a member a code brought in", async () => {
  const f = await pc();
  const device = await driving(f);
  const owner = await signedInWith(f, await codeFor(f, "acct_1"));
  await vouchFor(f, "acct_1", owner.key);
  await linked(owner.session, owner.id, "acct_1", owner.key);
  // the PC is in the account, and the device from before drives on outside it
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, unlinked: [device.id], own_word: [] });
  await linked(device.session, device.id, "acct_1", device.key);
  expect(marks(f)).toEqual({ [device.id]: "word", [owner.id]: "service" });
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 2, unlinked: [], own_word: [device.id] });
});

test("a device that already drives links while a code made for that account is pending on that account's word, is marked so, and the code then ends", async () => {
  const f = await pc();
  const device = await driving(f);
  await codeFor(f, "acct_1");
  await vouchFor(f, "acct_1", device.key);
  await linked(device.session, device.id, "acct_1", device.key);
  expect(marks(f)).toEqual({ [device.id]: "service" });
  expect(await f.status()).toMatchObject({ account: "acct_1", own_word: [] });
  expect(f.devices.activePairing()).toBeNull();
});

test("a member on its own word stays listed whatever it links again, with the same key, another key or another account, until it is removed", async () => {
  const f = await pc();
  const device = await driving(f);
  await linked(device.session, device.id, "acct_1", device.key);
  const listed = async () => [marks(f)[device.id], (await f.status()).own_word];
  expect(await listed()).toEqual(["word", [device.id]]);
  await linked(device.session, device.id, "acct_1", device.key);
  expect(await listed()).toEqual(["word", [device.id]]);
  expect((await sendLink(device.session, await linkRecord(device.id, "acct_9", device.key))).status).toBe(409);
  expect(await listed()).toEqual(["word", [device.id]]);
  const moved = await phone();
  await linked(device.session, device.id, "acct_1", device.key, moved);
  expect(f.stored()).toEqual([expect.objectContaining({ id: device.id, relay_public_key: moved.spki, account: "acct_1", joined_by: "word" })]);
  expect(await listed()).toEqual(["word", [device.id]]);
  expect((await f.local(`/api/devices/${device.id}`, { method: "DELETE", headers: { "x-herdr-machine": "1" } })).status).toBe(204);
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [], own_word: [] });
});

test("a member from before the mark, a row a member's add made and a row a member approved have none and are not listed; a device approved by its digits on this PC links on its own word", async () => {
  const before = await memberRow("acct_1");
  const f = await pc({ rows: [before.row] });
  const session = await signIn(f, before.row.id, before.key);
  if ("error" in session) throw new Error(`The member was refused: ${session.error}`);
  // a row a member's add makes: the member's signature stands behind it
  const added = await phone();
  const add = await signAccountRecord({ v: 1, kind: "add", account: "acct_1", key: added.spki, label: "Mac app", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: before.key.spki }, before.key.keys.privateKey);
  expect((await ask(session.link, "/api/account/records", { method: "POST", body: { records: [add] } })).body.results).toEqual([{ id: add.id, outcome: "applied" }]);
  const byAdd = f.stored().find((device) => device.relay_public_key === added.spki);
  expect(byAdd).toMatchObject({ account: "acct_1", added_by: before.row.id });
  // a row a member approved through the relay, which then links itself in
  const vouched = await phone();
  const approved = f.devices.pairRelayApproved("Approved by a member", vouched.spki, { path: "account", addedBy: before.row.id, id: accountDeviceId(SERVER_ID, vouched.spki) })?.device;
  if (!approved) throw new Error("The member's approval made no device");
  const its = await signIn(f, approved.id, vouched);
  if ("error" in its) throw new Error(`The approved device was refused: ${its.error}`);
  await linked(its.link, approved.id, "acct_1", vouched);
  // a later link of the member from before moves its key and adds no mark
  const moved = await phone();
  await linked(session.link, before.row.id, "acct_1", before.key, moved);
  expect(f.stored().find((device) => device.id === before.row.id)).toMatchObject({ relay_public_key: moved.spki, account: "acct_1" });
  expect(marks(f)).toEqual({ [before.row.id]: undefined, [byAdd?.id ?? ""]: undefined, [approved.id]: undefined });
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 3, unlinked: [], own_word: [] });
  // a comparison of digits approved on this PC makes a row in no account, as a plain code does
  const digits = await phone();
  const row = f.devices.pairRelayApproved("Approved here", digits.spki, { path: "code", id: accountDeviceId(SERVER_ID, digits.spki) })?.device;
  if (!row) throw new Error("The approved pairing made no device");
  expect(await f.status()).toMatchObject({ members: 3, unlinked: [row.id], own_word: [] });
  const signedIn = await signIn(f, row.id, digits);
  if ("error" in signedIn) throw new Error(`The device approved here was refused: ${signedIn.error}`);
  await linked(signedIn.link, row.id, "acct_1", digits);
  expect(marks(f)[row.id]).toBe("word");
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 4, unlinked: [], own_word: [row.id] });
});

test("a mark this PC does not know refuses no file, is kept by a write and is listed as the device's own word", async () => {
  const odd = await memberRow("acct_1");
  const known = await memberRow("acct_1");
  const rows = [{ ...odd.row, joined_by: "something else" }, { ...known.row, joined_by: "service" }];
  const f = await pc({ rows });
  expect(f.devices.error).toBeNull();
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 2, unlinked: [], own_word: [odd.row.id] });
  // a write of the registry keeps what it does not know
  const session = await signIn(f, known.row.id, known.key);
  if ("error" in session) throw new Error(`The member was refused: ${session.error}`);
  await linked(session.link, known.row.id, "acct_1", known.key, await phone());
  expect(marks(f) as Record<string, unknown>).toEqual({ [odd.row.id]: "something else", [known.row.id]: "service" });
  expect(await f.status()).toMatchObject({ own_word: [odd.row.id] });
});

test("the PC's own health answer names both groups to its owner, and to a watching device neither", async () => {
  const ping = spyOn(herdr, "ping").mockResolvedValue({ version: "fixture", protocol: 22, terminal_attach: false, terminal_mirror: true });
  try {
    const f = await pc();
    const outside = await driving(f);
    const own = await driving(f);
    await linked(own.session, own.id, "acct_1", own.key);
    const label = (id: string) => f.stored().find((device) => device.id === id)?.label;
    const health = await f.local("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.account_devices).toEqual({ unlinked: [{ id: outside.id, label: label(outside.id) }], own_word: [{ id: own.id, label: label(own.id) }] });
    // a device that drives reads them through the relay too
    expect((await ask(own.session, "/api/health")).body.account_devices).toEqual(health.body.account_devices);
    const watching = f.devices.pair(f.devices.startPairing().code, `Watcher ${randomBytes(2).toString("hex")}`, "watch");
    if (!watching) throw new Error("The watching device was not paired");
    const watched = await f.local("/api/health", { headers: { cookie: `ovis_device=${watching.token}` } });
    expect(watched.status).toBe(200);
    expect(watched.body).not.toHaveProperty("account_devices");
  } finally { ping.mockRestore(); }
});
