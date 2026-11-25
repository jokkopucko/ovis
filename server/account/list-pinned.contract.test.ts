/**
 * A PC pinned to its account's signed list (docs/account.md, "The account's signed list on a PC"): it lets its
 * account's devices in by the list alone. Each test here says what an account service that lies, withholds, replays or
 * shows two histories can and cannot bring about, whatever way it goes about it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { readSave, writeSave } from "../../shared/account-list-follower.ts";
import { entryFromText, entryHash } from "../../shared/account-list-entry.ts";
import { ACCOUNT_LIST_FEATURE, ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { handleRequest } from "../dispatch.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE, STALE_READ_MS } from "./account-devices.ts";
import { privateStateFs } from "../private-state.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ask, phone, SERVER_ID } from "./pairing.test-helpers.ts";
import { keyProofPc, provingDevice } from "./key-proof.test-helpers.ts";
import { FrameType } from "../../shared/relay-mux.ts";
import { ACCOUNT_LIST_FILE, ACCOUNT_LIST_OWED_FILE } from "./list-follow.ts";
import { signCard } from "../../shared/account-list.ts";
import { listMember, memberCard, TestList, type ListMember } from "./list.test-helpers.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { pressOnce } from "./one-press.ts";
import { AccountServiceRefusal } from "./mailbox.ts";
import { applyAccountRecords } from "./records.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

type Signer = { keys: CryptoKeyPair; publicKey: string; id: string };

/** The PC's clocks, moved by hand together: the time of day every part of it reads, and the clock its waits run on. */
function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  return { waits, advance(ms: number) { now += ms; waits.advance(ms); }, seconds: () => Math.floor(now / 1000),
    /** The time of day alone, as a clock set by hand: the clock the waits run on does not move. */
    wall(ms: number) { now += ms; } };
}

/**
 * A PC in an account whose snapshot lets one device in ("Laptop"), which reads the account's list: its first device,
 * and the laptop as a device of the list too. Not pinned yet.
 */
async function listedPc() {
  const time = testTime();
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  /** The account service as this PC reaches it: `away` makes every call fail, as a service that is down; `hook` answers a call first. */
  const reach: { away: boolean; hook?: ((request: Request) => Promise<Response | undefined>) | undefined } = { away: false };
  const fetchService = async (request: Request) => {
    if (reach.away) throw new Error("The account service is away");
    return await reach.hook?.(request) ?? await service.fetch(request);
  };
  const accountService = { url: "https://account.test", fetch: fetchService };
  // as createListedPc: a bound PC with a member in devices.json, whose whole read has admitted one account row
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, publicKey, "Laptop");
  expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const pc = { fixture, member, service, serverId, device: { keys, publicKey, id: accountDeviceId(serverId, publicKey) }, reach, accountService };
  const { services } = pc.fixture.app.context;
  services.devices.useClock(time.waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const list = services.accountList!;
  const idOf = (member: ListMember): Signer => ({ keys: member.keys, publicKey: member.key, id: accountDeviceId(pc.serverId, member.key) });
  /** One mailbox pull, with the snapshot read after it, and the list followed to the end of what it heard. */
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  /** What a sign-in comes to: the role the PC lets the device in as, or null. */
  const signsIn = async (device: Signer): Promise<"drive" | "watch" | null> => {
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    return await link.auth(device).then((ok) => ok.role, () => null);
  };
  const rowKeys = () => services.accountRows!.rows().map((row) => row.key).sort();
  const laptop = await listMember(pc.device.keys);
  const account = await TestList.start(pc.service, ACCOUNT, undefined, time.seconds);
  await account.addDevice(laptop);
  await pull();
  return { ...pc, time, services, endpoint, list, account, laptop, first: account.first, idOf, pull, signsIn, rowKeys, reader: { server_id: pc.serverId } };
}

/** The same PC, pinned: a person at it named the list, and a member added the PC from the keys it posted. */
async function pinnedPc() {
  const pc = await listedPc();
  expect(await pc.list.wantList(pc.account.id)).toMatchObject({ status: { pinned: false, want: pc.account.id } });
  await pc.account.addPostedPc(pc.endpoint);
  await pc.pull();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: pc.account.id });
  // every row the list just let in is past its join hold
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  return pc;
}

async function deviceEntry(account: TestList, device: ListMember, by: ListMember, after?: { seq: number; hash: string }) {
  return await account.sign({ kind: "device", key: device.key, power: "full", role: "drive", until: null, enc: device.enc, card: await memberCard(device, account.id), sealed: null, rotates: false }, by, after);
}

describe("how a PC comes to pin a list", () => {
  test("the list the account service names pins nothing, though it holds the PC: the snapshot still decides", async () => {
    const pc = await listedPc();
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ pinned: false, standing: "in", want: null });
    expect(pc.services.devices.listFollowed()).toBe(false);
    // so the PC is as on main: a device the service lists comes in, a device only the list holds does not
    const listed = await listMember();
    pc.service.registerDevice(ACCOUNT, listed.key, "Tablet");
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.idOf(listed))).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.first))).toBeNull();
  });

  test("a person at the PC names the list, and the PC pins it once that list holds an entry for the PC's own key", async () => {
    const pc = await listedPc();
    const base = `http://127.0.0.1:${pc.fixture.app.port}`;
    const named = await fetch(`${base}/api/account/list/pin`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ list: pc.account.id }) });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ pinned: false, want: pc.account.id, standing: "waiting" });
    expect(pc.services.devices.listFollowed()).toBe(false);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(pc.services.devices.listFollowed()).toBe(true);
  });

  test("only this PC's own window names the list: a device that drives it through the relay is refused", async () => {
    const pc = await listedPc();
    const relayed = await handleRequest(new Request("https://relay.ovis.invalid/api/account/list/pin", {
      method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ list: pc.account.id }),
    }), { ...pc.fixture.app.context, peer: { kind: "relay", device: { id: pc.member.id, label: "Account phone", role: "drive" }, sessionId: "s", serverId: pc.serverId, key: pc.member.publicKey }, timeout: () => {} });
    expect([relayed?.status, ((await relayed!.json()) as { error: { code: string } }).error.code]).toEqual([403, "owner_only"]);
    expect(pc.list.status().want).toBeNull();
  });

  test("a named list that holds no entry for this PC pins nothing, however long the PC reads it", async () => {
    const pc = await listedPc();
    await pc.list.wantList(pc.account.id);
    // a member adds some other PC's key at this PC's relay key: not this PC's own key
    const other = await listMember();
    const card = await signCard({ key: other.key, enc: other.enc, list: pc.account.id, endpoint: pc.endpoint, invite: null }, other.keys.privateKey);
    pc.service.tamperList(pc.account.id, { inject: [await pc.account.sign({ kind: "pc", key: other.key, endpoint: pc.endpoint, enc: other.enc, card, sealed: null }, pc.first, pc.list.status().head!)] });
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ pinned: false, standing: "waiting", pcs: 1 });
    expect(pc.services.devices.listFollowed()).toBe(false);
  });

  test("naming another list replaces the first until the PC is pinned, and nothing replaces it after", async () => {
    const pc = await listedPc();
    const other = "ab".repeat(32);
    expect(await pc.list.wantList(other)).toMatchObject({ status: { want: other, pinned: false, list: other } });
    expect(await pc.list.wantList("not a list id")).toEqual({ refused: "invalid_list" });
    expect(await pc.list.wantList(pc.account.id)).toMatchObject({ status: { want: pc.account.id } });
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    expect(await pc.list.wantList(other)).toEqual({ refused: "pinned" });
    expect(await pc.list.wantList(pc.account.id)).toMatchObject({ status: { pinned: true } });
  });

  test("a PC in no account names no list", async () => {
    const fixture = relayFixture(false, { accountOpensAll: true });
    closes.push(() => fixture.close());
    expect(await fixture.app.context.services.accountList!.wantList("ab".repeat(32))).toEqual({ refused: "not_in_account" });
  });
});

describe("a pinned PC lets its account's devices in by the list alone", () => {
  test("its rows are the list's devices, each as what its entry says", async () => {
    const pc = await pinnedPc();
    const watcher = await listMember();
    await pc.account.addDevice(watcher, { role: "watch", power: "bound" });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.rowKeys()).toEqual([pc.first.key, pc.laptop.key, watcher.key].sort());
    // and the PCs of the account are the list's: this one, and no relay key the list does not hold
    expect(pc.list.holdsPc(pc.endpoint)).toBe(true);
    expect(pc.list.holdsPc("ab".repeat(32))).toBe(false);
    expect(await pc.signsIn(pc.idOf(pc.first))).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    expect(await pc.signsIn(pc.idOf(watcher))).toBe("watch");
    expect(pc.services.devices.sessionRow(pc.idOf(watcher).id)?.role).toBe("watch");
  });

  test("its rows are named as the list seals each device's name, which this PC opens with the key it was given; one it cannot open stays Device", async () => {
    const pc = await pinnedPc();
    const tablet = await listMember();
    const unnamed = await listMember();
    await pc.account.addDevice(tablet, { names: { label: "Dana's tablet", os: "android" } });
    await pc.account.addDevice(unnamed);
    await pc.pull();
    const labelOf = (key: string) => pc.services.accountRows!.rows().find((row) => row.key === key)?.label;
    for (let turn = 0; turn < 50 && labelOf(tablet.key) !== "Dana's tablet"; turn++) await pc.list.settled();
    expect(labelOf(tablet.key)).toBe("Dana's tablet");
    expect(labelOf(unnamed.key)).toBe("Device");
    // what a person at this PC named a row stays: only the list's placeholder is replaced
    const renamed = pc.services.accountRows!.rows().find((row) => row.key === unnamed.key)!;
    pc.services.accountRows!.store()!.rename(renamed.id, "My laptop");
    await pc.pull();
    expect(labelOf(unnamed.key)).toBe("My laptop");
  });

  test("a device the list names \"failed\" is named so: no name is mistaken for a service that could not answer", async () => {
    const pc = await pinnedPc();
    const tablet = await listMember();
    await pc.account.addDevice(tablet, { names: { label: "failed", os: "android" } });
    await pc.pull();
    const labelOf = (key: string) => pc.services.accountRows!.rows().find((row) => row.key === key)?.label;
    for (let turn = 0; turn < 50 && labelOf(tablet.key) !== "failed"; turn++) await pc.list.settled();
    expect(labelOf(tablet.key)).toBe("failed");
  });

  test("a name whose key this PC was not given yet is opened once a later read finds the wrap, with no restart", async () => {
    const pc = await pinnedPc();
    const tablet = await listMember();
    let given = false;
    // the account service holds no wrap of the names' key for this PC yet (a PC just added gets it a moment later)
    pc.reach.hook = async (request) => !given && new URL(request.url).pathname === "/v2/pc/list/wraps" ? Response.json({ wraps: [] }) : undefined;
    const labelOf = (key: string) => pc.services.accountRows!.rows().find((row) => row.key === key)?.label;
    try {
      await pc.account.addDevice(tablet, { names: { label: "Dana's tablet", os: "android" } });
      await pc.pull();
      for (let turn = 0; turn < 20; turn++) await pc.list.settled();
      expect(labelOf(tablet.key)).toBe("Device");
      // the wrap is there now; the list did not move, and a pull a minute later reads it
      given = true;
      pc.time.wall(2 * 60_000);
      await pc.pull();
      for (let turn = 0; turn < 50 && labelOf(tablet.key) !== "Dana's tablet"; turn++) await pc.list.settled();
      expect(labelOf(tablet.key)).toBe("Dana's tablet");
    } finally { pc.reach.hook = undefined; }
  });

  test("a name sealed in an epoch before this PC's own wraps is final (sealed before it joined): it is not asked for again", async () => {
    const pc = await pinnedPc();
    const tablet = await listMember();
    let wraps = 0;
    // the service holds this PC's wrap of a later epoch only: the PC came into the list after the tablet's name was sealed
    pc.reach.hook = async (request) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/wraps") return undefined;
      wraps++;
      return Response.json({ wraps: [{ epoch: 99, wrap: "A".repeat(10) }] });
    };
    const labelOf = (key: string) => pc.services.accountRows!.rows().find((row) => row.key === key)?.label;
    try {
      await pc.account.addDevice(tablet, { names: { label: "Dana's tablet", os: "android" } });
      await pc.pull();
      for (let turn = 0; turn < 20; turn++) await pc.list.settled();
      expect(labelOf(tablet.key)).toBe("Device");
      const asked = wraps;
      expect(asked).toBeGreaterThan(0);
      pc.time.wall(2 * 60_000);
      await pc.pull();
      for (let turn = 0; turn < 20; turn++) await pc.list.settled();
      expect(wraps).toBe(asked);
      expect(labelOf(tablet.key)).toBe("Device");
    } finally { pc.reach.hook = undefined; }
  });

  test("opening names never holds up a read: with names to open and the wraps route held, then failing, a removal is read before a session opens", async () => {
    const pc = await pinnedPc();
    const victim = await listMember();
    await pc.account.addDevice(victim);
    await pc.pull();
    expect(pc.list.role(victim.key)).toBe("drive");
    const named = [await listMember(), await listMember(), await listMember(), await listMember()];
    for (const [at, device] of named.entries()) await pc.account.addDevice(device, { names: { label: `Phone ${at}`, os: "android" } });
    let wraps = 0;
    let answer = (): void => undefined;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    // the account service holds the wraps route until the test lets it answer, then fails it (a service under load)
    pc.reach.hook = async (request) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/wraps") return undefined;
      wraps++;
      await answered;
      return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    };
    try {
      await pc.services.accountMailbox.pull();
      const deadline = Date.now() + 10_000;
      while (wraps === 0) { if (Date.now() > deadline) throw new Error("no name was asked for"); await Bun.sleep(20); }
      // a member removes the victim at the account service; the victim signs in well after the PC's last read
      await pc.account.remove(victim.key);
      pc.time.wall(10 * 60_000);
      await pc.list.beforeSession(5_000);
      expect(pc.list.role(victim.key)).toBeNull();
      answer();
      await pc.list.settled();
      // one call for the epoch, however many names it seals
      expect(wraps).toBe(1);
    } finally { answer(); pc.reach.hook = undefined; }
  });

  test("a name the service could not give yet is asked for again, and a copy of the same list read meanwhile keeps the names opened", async () => {
    const pc = await pinnedPc();
    const tablet = await listMember();
    let failing = true;
    pc.reach.hook = async (request) => failing && new URL(request.url).pathname === "/v2/pc/list/wraps" ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : undefined;
    const labelOf = (key: string) => pc.services.accountRows!.rows().find((row) => row.key === key)?.label;
    try {
      await pc.account.addDevice(tablet, { names: { label: "Dana's tablet", os: "android" } });
      await pc.pull();
      for (let turn = 0; turn < 20; turn++) await pc.list.settled();
      expect(labelOf(tablet.key)).toBe("Device");
      // the service answers again; a sign-in a second later reads a new copy of the same list
      failing = false;
      pc.time.wall(2 * 60_000);
      pc.list.role(tablet.key);
      await pc.pull();
      for (let turn = 0; turn < 50 && labelOf(tablet.key) !== "Dana's tablet"; turn++) await pc.list.settled();
      expect(labelOf(tablet.key)).toBe("Dana's tablet");
    } finally { pc.reach.hook = undefined; }
  });

  test("a device the snapshot let in and the list does not hold goes at the pin, its session closed", async () => {
    const pc = await listedPc();
    const tablet = await listMember();
    pc.service.registerDevice(ACCOUNT, tablet.key, "Tablet");
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(tablet))).toMatchObject({ role: "drive" });
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    // as a row that changed, not as a device that was removed: its app tries again by itself, and is then one the PC never let in
    expect(await bounded(link.serverError, 2000)).toBe("auth_changed");
    expect(pc.rowKeys()).toEqual([pc.first.key, pc.laptop.key].sort());
    expect(await pc.signsIn(pc.idOf(tablet))).toBeNull();
  });

  test("a device the account service adds to its snapshot is never let in", async () => {
    const pc = await pinnedPc();
    const planted = await listMember();
    pc.service.registerDevice(ACCOUNT, planted.key, "Planted");
    await pc.pull();
    expect(await pc.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.rowKeys()).toEqual([pc.first.key, pc.laptop.key].sort());
    expect(await pc.signsIn(pc.idOf(planted))).toBeNull();
  });

  test("an entry that no member signed lets nobody in", async () => {
    const pc = await pinnedPc();
    const planted = await listMember();
    pc.service.tamperList(pc.account.id, { reader: pc.reader, inject: [await deviceEntry(pc.account, planted, planted, pc.list.status().head!)] });
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.rowKeys()).toEqual([pc.first.key, pc.laptop.key].sort());
    expect(await pc.signsIn(pc.idOf(planted))).toBeNull();
    expect(pc.list.status().alarm).toBeNull();
  });

  test("a member's v1 add record adds nobody, and its v1 remove still removes", async () => {
    const pc = await pinnedPc();
    const added = await listMember();
    const base = { v: 1 as const, account: ACCOUNT, issued_at: new Date().toISOString(), signer: pc.member.publicKey };
    const add = await signAccountRecord({ ...base, kind: "add", key: added.key, label: "Added", role: "drive", id: newRecordId() }, pc.member.keys.privateKey);
    expect(await applyAccountRecords(pc.services.devices, [add], pc.serverId)).toEqual([{ id: add.id, outcome: "refused", code: "list_followed" }]);
    expect(await pc.signsIn(pc.idOf(added))).toBeNull();
    const remove = await signAccountRecord({ ...base, kind: "remove", key: pc.laptop.key, id: newRecordId() }, pc.member.keys.privateKey);
    expect((await applyAccountRecords(pc.services.devices, [remove], pc.serverId))[0]).toMatchObject({ outcome: "applied" });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    // and the list does not bring back what this PC's own record of a removal keeps out
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  });

  test("a device that links itself is refused, and keeps the pairing it has", async () => {
    const pc = await pinnedPc();
    const local = await listMember();
    const paired = pc.services.devices.pairRelay(pc.services.devices.startPairing().code, "Local", local.key)!.device;
    const link = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: local.key, server_id: pc.serverId, device_id: paired.id, old_key: local.key,
      issued_at: new Date().toISOString(), id: newRecordId(), signer: local.key }, local.keys.privateKey);
    const answer = await handleRequest(new Request("https://relay.ovis.invalid/api/account/link", {
      method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ record: link }),
    }), { ...pc.fixture.app.context, peer: { kind: "relay", device: { id: paired.id, label: "Local", role: "drive" }, sessionId: "s", serverId: pc.serverId, key: local.key }, timeout: () => {} });
    expect([answer?.status, ((await answer!.json()) as { error: { code: string } }).error.code]).toEqual([409, "list_followed"]);
    expect(await pc.signsIn({ keys: local.keys, publicKey: local.key, id: paired.id })).toBe(paired.role);
    expect(pc.services.devices.accountRows().unlinked).toContain(paired.id);
  });

  test("a press in the PC's own window joins it to nothing: it is in its account", async () => {
    const pc = await pinnedPc();
    expect(await pressOnce(pc.services, ACCOUNT)).toMatchObject({ refused: { code: "account_mismatch" } });
    pc.services.relay.setRelayAccount(ACCOUNT);
    expect(await pressOnce(pc.services, ACCOUNT)).toMatchObject({ refused: { code: "in_account" } });
    expect(pc.list.status().pinned).toBe(true);
  });
});

describe("the moment a PC pins, and how an app signs in to it from then on", () => {
  /** One sign-in: the role the PC lets the device in as, or the code it refuses with. */
  async function opens(pc: Awaited<ReturnType<typeof listedPc>>, device: Signer, features: readonly string[] = [], required: readonly string[] = []) {
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    return await link.auth(device, features, required).then((ok) => ok.role, async () => await bounded(link.serverError, 2000));
  }

  test("an open session ends as a row that changed, the app is told to come by its list key, and comes back at once", async () => {
    const pc = await listedPc();
    // a device as today's app holds it: the key of its sign-in, which the snapshot names, and its member key in the list
    const signIn = await listMember();
    pc.service.registerDevice(ACCOUNT, signIn.key, "Phone");
    const member = await listMember();
    await pc.account.addDevice(member);
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const open = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await open.auth(pc.idOf(signIn), [ACCOUNT_LIST_FEATURE])).toMatchObject({ role: "drive" });
    // a PC that follows no list has no such feature: an app that requires it falls back to today's ways
    expect(await opens(pc, pc.idOf(member), [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE])).toBe("unsupported_extension");

    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    expect(await bounded(open.serverError, 2000)).toBe("auth_changed");

    // the app comes back as it was, and is told how to come instead; an app from before lists hears what it always did
    expect(await opens(pc, pc.idOf(signIn), [ACCOUNT_LIST_FEATURE])).toBe("account_list_required");
    expect(await opens(pc, pc.idOf(signIn))).toBe("auth_failed");
    // with its list key it is in at once: what the list held when the person pinned it waits for no join hold
    expect(await opens(pc, pc.idOf(member), [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE])).toBe("drive");
    // a device that is in no list is one the PC never let in, and its app leads to an Allow
    expect(await opens(pc, pc.idOf(await listMember()), [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE])).toBe("auth_failed");
    // a device this PC paired itself signs in as it did, whatever it offers
    const local = await listMember();
    const paired = pc.services.devices.pairRelay(pc.services.devices.startPairing().code, "Local", local.key)!.device;
    expect(await opens(pc, { keys: local.keys, publicKey: local.key, id: paired.id }, [ACCOUNT_LIST_FEATURE])).toBe(paired.role);
  });

  test("a device the list lets in after the pin still waits its ten seconds", async () => {
    const pc = await pinnedPc();
    const late = await listMember();
    await pc.account.addDevice(late);
    await pc.pull();
    expect(await opens(pc, pc.idOf(late), [ACCOUNT_LIST_FEATURE, ACCOUNT_OPENS_ALL_FEATURE], [ACCOUNT_LIST_FEATURE])).toBe("held");
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await opens(pc, pc.idOf(late), [ACCOUNT_LIST_FEATURE, ACCOUNT_OPENS_ALL_FEATURE], [ACCOUNT_LIST_FEATURE])).toBe("drive");
  });
});

describe("the account service cannot take a pinned PC out of its account, or shut out the devices it holds", () => {
  const unlist = (pc: Awaited<ReturnType<typeof pinnedPc>>) => pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` } }));

  test("a PC the service no longer lists stays in its account, pinned, and lets its devices in", async () => {
    const pc = await pinnedPc();
    expect((await unlist(pc)).status).toBe(204);
    await pc.pull();
    expect(await pc.services.accountMailbox.readSnapshot()).not.toMatchObject({ committed: true });
    expect(pc.services.devices.account()).toBe(ACCOUNT);
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });

  test("the same service word takes a PC that is not pinned out of its account, as before", async () => {
    const pc = await listedPc();
    expect((await unlist(pc)).status).toBe(204);
    await pc.pull();
    expect(pc.services.devices.account()).toBeNull();
  });

  test("a service that turns Step 2 off closes no device of the list", async () => {
    const pc = await pinnedPc();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    pc.service.opensAll = false;
    pc.service.reportsStep2Off = true;
    await pc.pull();
    expect(pc.services.devices.sessionRow(pc.idOf(pc.laptop).id)?.role).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.first))).toBe("drive");
  });

  test("a service that answers nothing: the PC lets in whom it holds, an hour later and after a restart too", async () => {
    const pc = await pinnedPc();
    pc.reach.away = true;
    await pc.pull();
    expect(pc.services.accountMailbox.error).toContain("away");
    // the hour after which a PC that is not pinned makes its account rows wait for a whole read
    pc.time.advance(STALE_READ_MS + 60_000);
    pc.services.checkAccountFreshness();
    expect(pc.services.devices.sessionRow(pc.idOf(pc.laptop).id)?.role).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.first))).toBe("drive");

    pc.fixture.app.stop();
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { accountList, accountMailbox } = again.app.context.services;
    await accountMailbox.pull();
    await accountList!.settled();
    expect(accountList!.status()).toMatchObject({ pinned: true, standing: "in", devices: 2 });
    const link = await relayConnection(again, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
  });

  test("a device of the list that this PC had taken in on a member's word waits for no read of the service after a restart", async () => {
    const pc = await listedPc();
    // before the pin, a member's signed add brings two devices in: rows this PC did not pair itself
    const [tablet, outside] = [await listMember(), await listMember()];
    for (const [device, label] of [[tablet, "Tablet"], [outside, "Outside"]] as const) {
      const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: device.key, label, role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: pc.member.publicKey }, pc.member.keys.privateKey);
      expect((await applyAccountRecords(pc.services.devices, [add], pc.serverId))[0]).toMatchObject({ outcome: "applied" });
    }
    // the list holds one of them
    await pc.account.addDevice(tablet);
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    expect(await pc.signsIn(pc.idOf(tablet))).toBe("drive");
    // the other opens through the account too (its id is the account's for its key), and the list does not hold it:
    // the row a member's add made gives it nothing on a pinned PC
    expect(await pc.signsIn(pc.idOf(outside))).toBeNull();

    pc.reach.away = true;
    pc.fixture.app.stop();
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    await again.app.context.services.accountMailbox.pull();
    await again.app.context.services.accountList!.settled();
    const signsIn = async (device: ListMember) => await (await relayConnection(again, { serverId: pc.serverId })).auth(pc.idOf(device)).then((ok) => ok.role, () => null);
    expect(await signsIn(tablet)).toBe("drive");
    expect(await signsIn(outside)).toBeNull();
    // an hour on, still
    pc.time.advance(STALE_READ_MS + 60_000);
    again.app.context.services.checkAccountFreshness();
    expect(await signsIn(tablet)).toBe("drive");
  });

  test("a service that says the account has no list, or names another, changes nothing", async () => {
    const pc = await pinnedPc();
    pc.service.listAccounts = "";
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: pc.account.id, devices: 2 });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });
});

describe("a removal the PC has seen is final", () => {
  test("a removed device is refused from the read that shows it, its session closed, and an old log never brings it back", async () => {
    const pc = await pinnedPc();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    const before = pc.list.status().head!;
    await pc.account.remove(pc.laptop.key);
    await pc.pull();
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    // the service answers with the log as it was before the removal, and its old head
    pc.service.tamperList(pc.account.id, { reader: pc.reader, head: before, withholdAfter: before.seq });
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ head: pc.account.place, devices: 1 });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    expect(await pc.signsIn(pc.idOf(pc.first))).toBe("drive");
  });

  test("a removed device that this PC also paired itself goes with its pairing, and the PC keeps the removal as its own", async () => {
    const pc = await pinnedPc();
    // the account phone: a member in this PC's own devices.json, and a device of the list
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    const own = { keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id };
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(own)).toMatchObject({ role: "drive" });
    await pc.account.remove(phone.key);
    await pc.pull();
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(own)).toBeNull();
    expect(await pc.signsIn(pc.idOf(phone))).toBeNull();
    // kept as this PC keeps a member's signed removal: it stands whatever becomes of the list's copy
    expect(pc.services.devices.removedByAccount(phone.key)).toBe(true);
    expect(pc.services.devices.removedByAccount(pc.laptop.key)).toBe(false);
    expect(pc.services.devices.admitsFromList(phone.key, ACCOUNT)).toBe(false);
    expect(pc.services.devices.admitsFromList(pc.laptop.key, ACCOUNT)).toBe(true);
  });

  test("a removed key comes back by nothing, not even a pairing at the PC: the device comes back with a new key, by a new act there", async () => {
    const pc = await pinnedPc();
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    await pc.account.remove(phone.key);
    await pc.pull();
    const own = { keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id };
    // nothing brings it back by itself: not another read, not the service's snapshot naming the key
    pc.service.registerDevice(ACCOUNT, phone.key, "Phone");
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(own)).toBeNull();
    expect(await pc.signsIn(pc.idOf(phone))).toBeNull();
    // as for a key a member's signed remove took: a code started on this PC lets that key in no more either
    const { devices } = pc.services;
    expect(devices.pairRelay(devices.startPairing().code, "Phone again", phone.key)).toBeNull();
    // the device itself comes back as a new one: a new key, paired by a person at the PC, which is that PC's own row
    const fresh = await listMember();
    const paired = devices.pairRelay(devices.startPairing().code, "Phone again", fresh.key)!.device;
    const again = { keys: fresh.keys, publicKey: fresh.key, id: paired.id };
    expect(await pc.signsIn(again)).toBe(paired.role);
    await pc.pull();
    expect(await pc.signsIn(again)).toBe(paired.role);
  });

  test("a removal the service withholds is applied once the service shows it, however late", async () => {
    const pc = await pinnedPc();
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: pc.list.status().head!.seq });
    await pc.account.remove(pc.laptop.key);
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    pc.service.untamperList(pc.account.id);
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  });

  test("a removal the service withholds is applied as soon as another member hands it over, and stays", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const removal = await pc.account.remove(pc.laptop.key);
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    // the residual the docs name: until an honest source reaches the PC, the removed device still gets in
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });

    const ask = pc.list.asks()!;
    expect(ask).toEqual({ list: pc.account.id, after: held.seq });
    expect(await pc.list.takeFromPeer({ list: ask.list, after: ask.after, entries: [removal], head: pc.account.place })).toBe("caught_up");
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    // the service goes on withholding, and after a restart the PC still holds the removal
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    pc.fixture.app.stop();
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    await again.app.context.services.accountMailbox.pull();
    await again.app.context.services.accountList!.settled();
    const next = await relayConnection(again, { serverId: pc.serverId });
    await expect(next.auth(pc.idOf(pc.laptop))).rejects.toThrow();
  });

  test("over its session, a device says where the list stands and hands the PC the removal the service withholds", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const removal = await pc.account.remove(pc.laptop.key);
    await pc.pull();
    const laptop = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await laptop.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    // the two say where they stand: the PC is behind
    const heads = await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: pc.account.place } });
    expect([heads.status, heads.body]).toEqual([200, { list: pc.account.id, place: held, asks: { list: pc.account.id, after: held.seq } }]);
    const handed = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place } });
    expect([handed.status, handed.body]).toEqual([200, { verdict: "caught_up", list: pc.account.id, place: pc.account.place }]);
    expect(await bounded(laptop.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  });

  test("a device that only watches may hand entries over too, and what no member signed is taken from nobody", async () => {
    const pc = await pinnedPc();
    const tablet = await listMember();
    await pc.account.addDevice(tablet, { role: "watch", power: "bound" });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const held = pc.list.status().head!;
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const watching = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await watching.auth(pc.idOf(tablet))).toMatchObject({ role: "watch" });
    // an entry a stranger signed, at the place after the PC's head
    const stranger = await listMember();
    const forged = await pc.account.sign({ kind: "remove", ends: pc.laptop.key }, stranger, held);
    const refused = await ask(watching, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: held.seq, entries: [forged], head: { seq: held.seq + 1, hash: "ab".repeat(32) } } });
    // kept beside the list at most, never in it: the PC stands where it stood
    expect([refused.status, refused.body]).toEqual([200, { verdict: "asks_after", asks: { list: pc.account.id, after: held.seq }, list: pc.account.id, place: held }]);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    // and a member's own removal, carried by the same device
    const removal = await pc.account.remove(pc.laptop.key);
    const handed = await ask(watching, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place } });
    expect(handed.body).toMatchObject({ verdict: "caught_up", place: pc.account.place });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    // nothing else of the account opens to it
    expect((await ask(watching, "/api/account/list/pin", { method: "POST", body: { list: pc.account.id } })).status).toBe(403);
  });

  test("a device that is behind is handed the entries it lacks, and the PC asks a device that is ahead for what it lacks itself", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const head = pc.list.status().head!;
    const entries = pc.service.accountList(ACCOUNT)!.entries;
    // the device stands at entry 0: the PC hands it everything after
    const behind = await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: { seq: 0, hash: pc.account.id } } });
    expect(behind.body).toEqual({ list: pc.account.id, place: head, page: { list: pc.account.id, after: 0, entries: entries.slice(1), head } });
    // the device stands where the PC does: only the PC's head
    expect((await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: head } })).body).toEqual({ list: pc.account.id, place: head });
    // the device stands further: the PC asks it for the entries after its own place
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: head.seq });
    await pc.account.addDevice(await listMember());
    const ahead = await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: pc.account.place } });
    expect(ahead.body).toEqual({ list: pc.account.id, place: head, asks: { list: pc.account.id, after: head.seq } });
    // a head of another list: the PC's own, and nothing else
    expect((await ask(member, "/api/account/list/head", { method: "POST", body: { list: "ef".repeat(32), place: null } })).body).toEqual({ list: pc.account.id, place: head });
    expect((await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: { seq: "1" } } })).status).toBe(400);
  });

  test("a device asks the PC for its own entries after a place it names, as any member answers a read, and gets nothing of another list", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const head = pc.list.status().head!;
    const entries = pc.service.accountList(ACCOUNT)!.entries;
    const heads = (body: unknown) => ask(member, "/api/account/list/head", { method: "POST", body });
    // where both stand at one entry, the PC still answers the read the device asks for: its entries after that place
    expect((await heads({ list: pc.account.id, place: head, asks: { list: pc.account.id, after: 0 } })).body)
      .toEqual({ list: pc.account.id, place: head, page: { list: pc.account.id, after: 0, entries: entries.slice(1, head.seq + 1), head } });
    // from entry 0, and over the page the device's own place would have given
    expect((await heads({ list: pc.account.id, place: { seq: 0, hash: pc.account.id }, asks: { list: pc.account.id, after: null } })).body)
      .toEqual({ list: pc.account.id, place: head, page: { list: pc.account.id, after: null, entries: entries.slice(0, head.seq + 1), head } });
    // the PC still asks a device that stands further for what it lacks, beside what it answers
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: head.seq });
    await pc.account.addDevice(await listMember());
    expect((await heads({ list: pc.account.id, place: pc.account.place, asks: { list: pc.account.id, after: head.seq } })).body)
      .toEqual({ list: pc.account.id, place: head, page: { list: pc.account.id, after: head.seq, entries: [], head }, asks: { list: pc.account.id, after: head.seq } });
    // a read of another list, or a head of another list, is answered with the PC's own head and nothing else: wherever
    // the device says it stands, behind the PC (no page of the PC's own), level, or further (no read asked of it)
    const foreign = { list: "ef".repeat(32), after: 0 };
    for (const place of [{ seq: 0, hash: pc.account.id }, head, pc.account.place]) {
      expect((await heads({ list: pc.account.id, place, asks: foreign })).body).toEqual({ list: pc.account.id, place: head });
    }
    expect((await heads({ list: "ef".repeat(32), place: null, asks: { list: pc.account.id, after: 0 } })).body).toEqual({ list: pc.account.id, place: head });
    // and a read out of form is refused, as a head out of form is; a read is left out, never sent as null
    for (const asks of [{ list: pc.account.id, after: -1 }, { list: pc.account.id }, { list: 7, after: 0 }, "all", null]) {
      expect((await heads({ list: pc.account.id, place: head, asks })).status).toBe(400);
    }
  });

  test("the place the PC asks a device for is its footing: an entry no member signed above it is not counted as held", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    // the service withholds what follows from the PC and shows it one entry of a key that is no member (loose)
    const stranger = await listMember();
    const loose = await pc.account.sign({ kind: "remove", ends: pc.laptop.key }, stranger, held);
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq, inject: [loose] });
    await pc.pull();
    expect(pc.list.status().head).toEqual(held);
    // a member removes the laptop at the place the loose entry stands, and tells the PC where it stands
    const removal = await pc.account.remove(pc.laptop.key);
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const heads = await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: pc.account.place } });
    // the PC states its footing and asks for what follows it, not for what follows the loose entry
    expect(heads.body).toEqual({ list: pc.account.id, place: held, asks: { list: pc.account.id, after: held.seq } });
    const handed = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place } });
    expect(handed.body).toMatchObject({ verdict: "caught_up", place: pc.account.place });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  });

  test("a read the PC goes on with inside another history past its footing is asked for at that very place, so the alarm comes", async () => {
    const pc = await pinnedPc();
    const footing = pc.list.status().head!;
    // another history from entry 1: the first device lets devices in there, past the PC's footing, which alone would be a
    // post its writer left behind; then the first of them signs on it, which makes it a second history members signed
    const history = [pc.service.accountList(ACCOUNT)!.entries[0]!];
    let at = { seq: 0, hash: pc.account.id };
    const added: ListMember[] = [];
    while (at.seq <= footing.seq) {
      const device = await listMember();
      added.push(device);
      const text = await deviceEntry(pc.account, device, pc.first, at);
      history.push(text);
      at = { seq: at.seq + 1, hash: entryHash(entryFromText(text).body) };
    }
    const last = await pc.account.sign({ kind: "remove", ends: pc.laptop.key }, added[0]!, at);
    history.push(last);
    const top = { seq: at.seq + 1, hash: entryHash(entryFromText(last).body) };
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    // the device says where it stands, then hands what the PC asks for: each page cut before its last entry, which it
    // hands only where the PC asks for the place right before it
    let said = await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: top } });
    for (let round = 0; round < 16 && said.body.asks; round += 1) {
      const after = (said.body.asks as { after: number | null }).after;
      const from = after === null ? 0 : after + 1;
      const entries = from >= history.length - 1 ? history.slice(from) : history.slice(from, history.length - 1);
      said = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after, entries, head: top } });
      expect([round, said.status]).toEqual([round, 200]);
    }
    expect(pc.list.status()).toMatchObject({ alarm: "fork", head: footing });
  });

  test("the PC answers a device's own read only for a key its list holds: a pairing of its own keeps the plain exchange", async () => {
    const pc = await pinnedPc();
    const head = pc.list.status().head!;
    const entries = pc.service.accountList(ACCOUNT)!.entries;
    const local = await listMember();
    const paired = pc.services.devices.pairRelay(pc.services.devices.startPairing().code, "Local", local.key)!.device;
    const pairing = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await pairing.auth({ keys: local.keys, publicKey: local.key, id: paired.id });
    const read = { list: pc.account.id, place: head, asks: { list: pc.account.id, after: 0 } };
    // the same head and the same read: what a key of no entry is told is E6's answer, the PC's head alone
    expect((await ask(pairing, "/api/account/list/head", { method: "POST", body: read })).body).toEqual({ list: pc.account.id, place: head });
    // and where it stands at an earlier place of the PC's history, the page the comparison gives, not the one it asked for
    expect((await ask(pairing, "/api/account/list/head", { method: "POST", body: { ...read, place: { seq: 0, hash: pc.account.id } } })).body)
      .toEqual({ list: pc.account.id, place: head, page: { list: pc.account.id, after: 0, entries: entries.slice(1, head.seq + 1), head } });
    // a device the list holds gets the read it asked for
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.laptop));
    expect((await ask(member, "/api/account/list/head", { method: "POST", body: read })).body)
      .toEqual({ list: pc.account.id, place: head, page: { list: pc.account.id, after: 0, entries: entries.slice(1, head.seq + 1), head } });
  });

  test("a call that began while the PC was pinned and ends after it left its list is answered as a new call would be", async () => {
    for (const path of ["/api/account/list/head", "/api/account/list/page"]) {
      // a PC of its own for each route, each left while that route's body is on its way
      const pc = await pinnedPc();
      const head = pc.list.status().head!;
      const reading = deferred<void>();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, pull() { reading.resolve(); } });
      const answer = handleRequest(new Request(`https://relay.ovis.invalid${path}`, {
        method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: stream, duplex: "half",
      } as RequestInit), { ...pc.fixture.app.context, peer: { kind: "relay", device: { id: pc.idOf(pc.laptop).id, label: "Laptop", role: "drive" }, sessionId: `s-${path}`, serverId: pc.serverId, key: pc.laptop.key }, timeout: () => {} });
      await bounded(reading.promise);
      // the call was let in and its body is on its way: the PC leaves its account and its list
      pc.services.devices.revokeAll();
      body.enqueue(new TextEncoder().encode(JSON.stringify({ list: pc.account.id, place: head, after: head.seq, entries: [], head })));
      body.close();
      const answered = (await answer)!;
      expect([path, answered.status, ((await answered.json()) as { error?: { code?: string } }).error?.code]).toEqual([path, 404, "not_found"]);
    }
  });

  test("one session makes thirty of these calls a minute, and no more", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const head = pc.list.status().head!;
    const call = () => ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: head } });
    for (let index = 0; index < 30; index++) expect((await call()).status).toBe(200);
    const refused = await call();
    expect([refused.status, refused.body.error?.code, refused.headers.get("retry-after")]).toEqual([429, "rate_limited", "60"]);
    // another session has its own count, and a minute later this one may again
    const other = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await other.auth(pc.idOf(pc.laptop));
    expect((await ask(other, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: head } })).status).toBe(200);
    pc.time.advance(61_000);
    expect((await call()).status).toBe(200);
  });

  test("the thirty calls are counted before the body is read, by a clock that only moves forward, and a live count is never forgotten", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const head = pc.list.status().head!;
    const call = (body: unknown = { list: pc.account.id, place: head }) => ask(member, "/api/account/list/head", { method: "POST", body });
    for (let index = 0; index < 30; index++) expect((await call()).status).toBe(200);
    // a session already due its wait is told so before its body is read
    expect((await call("no head")).status).toBe(429);
    // the PC's clock set back a minute gives it no new one
    pc.time.wall(-61_000);
    expect((await call()).status).toBe(429);
    // other sessions, as many as the PC keeps counts for, push no live count out
    for (let other = 0; other < 64; other++) pc.list.peerBudget(`other-${other}`);
    expect((await call()).status).toBe(429);
    pc.time.advance(61_000);
    expect((await call()).status).toBe(200);
  });

  test("a device on another history is followed back over its calls, by its key, until the PC sees where the two part", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    // the device holds another history from entry 0: two entries no other member saw
    const { texts } = await pc.account.forkFromStart();
    const history = [texts[0], texts[1]];
    const theirs = { seq: 2, hash: entryHash(entryFromText(texts[1]).body) };
    let answer = await ask(member, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: theirs } });
    expect(answer.status).toBe(200);
    // the device hands what the PC asks for, from the place it names, one call at a time
    const asked: number[] = [];
    for (let calls = 0; calls < 4 && answer.body.asks !== undefined && pc.list.status().alarm === null; calls++) {
      const after = (answer.body.asks as { after: number }).after;
      asked.push(after);
      answer = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after, entries: history.slice(after), head: theirs } });
      expect(answer.status).toBe(200);
    }
    // it took more than one call to find where the two histories part, and the PC found it
    expect(asked.length).toBeGreaterThan(1);
    expect(pc.list.status().alarm).toBe("fork");
  });

  test("a page nobody asked for whose first entry follows no entry this PC holds is refused before any of it is checked", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const head = pc.list.status().head!;
    // entries a member signed, but after a place this PC's copy does not hold
    const elsewhere = await pc.account.sign({ kind: "remove", ends: pc.laptop.key }, pc.first, { seq: head.seq + 5, hash: "ab".repeat(32) });
    const handed = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: head.seq, entries: [elsewhere], head: { seq: head.seq + 6, hash: "cd".repeat(32) } } });
    expect([handed.status, handed.body.error?.code]).toEqual([409, "not_continued"]);
    // and nothing of it counts: the laptop is in
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });

  test("a page the disk does not take is acted on, and the device is told it was not saved", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const removal = await pc.account.remove(pc.laptop.key);
    const laptop = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await laptop.auth(pc.idOf(pc.laptop));
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((_from, to) => {
      if (String(to).endsWith(ACCOUNT_LIST_FILE)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    try {
      const handed = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place } });
      expect([handed.status, handed.body.error?.code]).toEqual([503, "not_saved"]);
      // enforced all the same: the removed device's session ends, and it does not get in again
      expect(await bounded(laptop.serverError, 2000)).toBe("auth_revoked");
      expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    } finally { failing.mockRestore(); }
  });

  test("the calls answer nothing to a page of another list or out of form, and a PC that only reads its list answers 404", async () => {
    const pc = await pinnedPc();
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const head = pc.list.status().head!;
    const page = (body: unknown) => ask(member, "/api/account/list/page", { method: "POST", body });
    const other = await page({ list: "ef".repeat(32), after: 0, entries: [], head });
    expect([other.status, other.body.error?.code]).toEqual([409, "not_my_list"]);
    for (const body of [
      { list: pc.account.id, after: 0, entries: "x", head },
      { list: pc.account.id, after: -1, entries: [], head },
      { list: pc.account.id, after: 0, entries: [], head: { seq: "1", hash: head.hash } },
      { list: pc.account.id, after: 0, entries: Array<string>(257).fill("x"), head },
    ]) expect([(await page(body)).status]).toEqual([400]);
    expect(pc.list.status().head).toEqual(head);

    const shadow = await listedPc();
    // a device this PC paired itself
    const laptop = await relayConnection(shadow.fixture, { serverId: shadow.serverId });
    await laptop.auth({ keys: shadow.member.keys, publicKey: shadow.member.publicKey, id: shadow.member.id });
    for (const path of ["/api/account/list/head", "/api/account/list/page"]) {
      const none = await ask(laptop, path, { method: "POST", body: { list: shadow.account.id, place: shadow.account.place, after: 0, entries: [], head: shadow.account.place } });
      expect([path, none.status, none.body.error?.code]).toEqual([path, 404, "not_found"]);
    }
  });

  test("what a stranger hands over proves nothing: an entry no member signed removes nobody", async () => {
    const pc = await pinnedPc();
    const stranger = await listMember();
    const ask = pc.list.asks()!;
    const forged = await pc.account.sign({ kind: "remove", ends: pc.laptop.key }, stranger, pc.list.status().head!);
    await pc.list.takeFromPeer({ list: ask.list, after: ask.after, entries: [forged], head: pc.account.place });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    expect(pc.rowKeys()).toEqual([pc.first.key, pc.laptop.key].sort());
  });

  test("before a session opens, a PC whose copy is older than half a minute reads first: a removal that waited is applied", async () => {
    const pc = await pinnedPc();
    // the account phone is a device of the list too, with a row this PC paired itself
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    await pc.account.remove(pc.laptop.key);
    await pc.account.remove(phone.key);
    // no pull since: the PC has not heard
    pc.time.advance(31_000);
    // whichever row the device has here: the first to ask is the one this PC paired itself
    expect(await pc.signsIn({ keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id })).toBeNull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    expect(pc.list.status().devices).toBe(1);
  });

  test("a device whose time passed is refused also when the rows could not be written then", async () => {
    const pc = await pinnedPc();
    const borrowed = await listMember();
    await pc.account.addDevice(borrowed, { power: "bound", until: pc.time.seconds() + 600 });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.idOf(borrowed))).toBe("drive");
    // the disk takes no write of the account's rows when the time comes
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(ACCOUNT_DEVICES_FILE)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      renameSync(String(from), String(to));
    });
    try {
      pc.time.advance(600_000);
      pc.list.tick();
      await pc.list.settled();
      expect(await pc.signsIn(pc.idOf(borrowed))).toBeNull();
    } finally { failing.mockRestore(); }
    // the others are let in as before once the disk writes again
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    expect(await pc.signsIn(pc.idOf(borrowed))).toBeNull();
  });

  test("a device is let in only before its until, by the PC's clock, and a session open at that second closes", async () => {
    const pc = await pinnedPc();
    const borrowed = await listMember();
    await pc.account.addDevice(borrowed, { power: "bound", until: pc.time.seconds() + 600 });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(borrowed))).toMatchObject({ role: "drive" });
    pc.time.advance(600_000);
    pc.list.tick();
    await pc.list.settled();
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.idOf(borrowed))).toBeNull();
    expect(pc.rowKeys()).toEqual([pc.first.key, pc.laptop.key].sort());
    // the service's clock, and a log shown again, give it no more time
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(borrowed))).toBeNull();
  });
});

describe("who may let a device in from afar, on a pinned PC", () => {
  test("a member of this PC's own devices only while the list holds its key to drive with full power", async () => {
    const pc = await pinnedPc();
    const { devices } = pc.services;
    // the account phone is a drive member in this PC's devices.json, and the list does not hold its key
    expect(devices.isAccountApprover(pc.member.id)).toBe(false);
    expect(devices.hasAccountApprover()).toBe(false);
    const phone = await listMember(pc.member.keys);
    // held to watch, or with bound power: in the list, and it adds nobody to it
    await pc.account.addDevice(phone, { role: "drive", power: "bound" });
    await pc.pull();
    expect(devices.isAccountApprover(pc.member.id)).toBe(false);
    await pc.account.remove(phone.key);
    await pc.pull();
    expect(devices.isAccountApprover(pc.member.id)).toBe(false);
  });

  test("and it is one once the list holds its key so", async () => {
    const pc = await pinnedPc();
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    expect(pc.services.devices.isAccountApprover(pc.member.id)).toBe(true);
    expect(pc.services.devices.hasAccountApprover()).toBe(true);
  });

  test("on a PC that is not pinned a drive member is one, as before", async () => {
    const pc = await listedPc();
    expect(pc.services.devices.isAccountApprover(pc.member.id)).toBe(true);
  });
});

describe("a key the list holds, which this PC also holds by a pairing of its own", () => {
  test("opens under its account id too, as the role the list gives it, and the pairing keeps its own role", async () => {
    const pc = await pinnedPc();
    // the account phone: a row this PC paired itself, with an id of its own, and a device of the list by the same key
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone, { role: "watch", power: "bound" });
    await pc.pull();
    const paired = { keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id };
    expect(pc.idOf(phone).id).not.toBe(paired.id);
    expect(await pc.signsIn(pc.idOf(phone))).toBe("watch");
    expect(await pc.signsIn(paired)).toBe("drive");
    // the answer names the device as the app named it
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(phone))).toMatchObject({ device_id: pc.idOf(phone).id, role: "watch" });
    // and the session opens streams under that id: what the app stamps on each is the id the answer named
    expect((await ask(link, "/api/health")).status).toBe(200);
    // a key that is not the row's proves nothing under that id
    const stranger = await listMember();
    expect(await pc.signsIn({ keys: stranger.keys, publicKey: stranger.key, id: pc.idOf(phone).id })).toBeNull();
  });

  test("its session under the account id ends when the list puts the key out", async () => {
    const pc = await pinnedPc();
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(phone))).toMatchObject({ role: "drive" });
    await pc.account.remove(phone.key);
    await pc.pull();
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.idOf(phone))).toBeNull();
  });

  test("its session under the account id ends when the list lets it in no more, though the pairing stands", async () => {
    const pc = await pinnedPc();
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone, { role: "watch", power: "bound", until: pc.time.seconds() + 60 });
    await pc.pull();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(phone))).toMatchObject({ role: "watch" });
    pc.time.advance(61_000);
    pc.list.tick();
    await pc.list.settled();
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.idOf(phone))).toBeNull();
    // the pairing this PC made itself is its own doing, and stays
    expect(await pc.signsIn({ keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id })).toBe("drive");
  });

  test("a PC that is not pinned knows no such id", async () => {
    const pc = await listedPc();
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(phone))).toBeNull();
  });
});

describe("the reset that makes a removed PC a new one", () => {
  // from this PC's own window: loopback, with no proxy between
  const reset = (pc: Awaited<ReturnType<typeof pinnedPc>>, body: unknown) => {
    const base = `http://127.0.0.1:${pc.fixture.app.port}`;
    return fetch(`${base}/api/relay/reset-identity`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(body) });
  };

  test("names the identity the person was asked about: a second answer to an old question resets nothing", async () => {
    const pc = await pinnedPc();
    await pc.account.remove(pc.service.accountList(ACCOUNT)!.state.pcs[pc.endpoint]!.key!);
    await pc.pull();
    expect(pc.services.devices.account()).toBeNull();
    const removed = { account: ACCOUNT, server_id: pc.serverId };
    // not for a PC the list did not remove, and not for another identity than this PC has
    const other = await reset(pc, { removed: { account: "acct_2", server_id: pc.serverId } });
    expect([other?.status, ((await other!.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_removed"]);
    const wrong = await reset(pc, { removed: { account: ACCOUNT, server_id: "f".repeat(32) } });
    expect([wrong?.status, ((await wrong!.json()) as { error: { code: string } }).error.code]).toEqual([409, "identity_changed"]);
    expect(pc.services.relay.currentIdentity()!.server_id).toBe(pc.serverId);
    // the first answer resets it
    expect((await reset(pc, { removed }))?.status).toBe(200);
    const next = pc.services.relay.currentIdentity()!.server_id;
    expect(next).not.toBe(pc.serverId);
    // the same answer again, from a second terminal that asked the same question: the PC it would reset is no longer that one
    const again = await reset(pc, { removed });
    expect([again?.status, ((await again!.json()) as { error: { code: string } }).error.code]).toEqual([409, "identity_changed"]);
    expect(pc.services.relay.currentIdentity()!.server_id).toBe(next);
  });

  test("an old question to add the PC again resets nothing once the PC is in an account again under the same relay identity", async () => {
    const pc = await pinnedPc();
    await pc.account.remove(pc.service.accountList(ACCOUNT)!.state.pcs[pc.endpoint]!.key!);
    await pc.pull();
    const removed = { account: ACCOUNT, server_id: pc.serverId };
    // the question was asked; meanwhile the PC joined another account, which its removal from this one does not bar
    pc.services.devices.bindByService("acct_2");
    const refused = await reset(pc, { removed });
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([409, "in_account"]);
    expect(pc.services.devices.account()).toBe("acct_2");
    expect(pc.services.relay.currentIdentity()!.server_id).toBe(pc.serverId);
  });

  test("a PC that joins an account while that reset closes its relay is not reset: the reset asks again in the turn that resets", async () => {
    const pc = await pinnedPc();
    await pc.account.remove(pc.service.accountList(ACCOUNT)!.state.pcs[pc.endpoint]!.key!);
    await pc.pull();
    const was = pc.services.relay.status().phase;
    const relay = pc.services.relay as unknown as { disconnect(): Promise<void> };
    const disconnect = relay.disconnect.bind(relay);
    relay.disconnect = async () => { relay.disconnect = disconnect; await disconnect(); pc.services.devices.bindByService("acct_2"); };
    const refused = await reset(pc, { removed: { account: ACCOUNT, server_id: pc.serverId } });
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([409, "in_account"]);
    expect(pc.services.devices.account()).toBe("acct_2");
    expect(pc.services.relay.currentIdentity()!.server_id).toBe(pc.serverId);
    // and its relay is as the reset found it: not left closed
    expect(pc.services.relay.status().phase === "off").toBe(was === "off");
  });
});

describe("a pin outlives this PC's own settings", () => {
  test("the folder of another PC that is pinned to its list changes nothing for this PC: with Step 2 off here, it starts off", async () => {
    const other = await pinnedPc();
    other.fixture.app.stop();
    // this PC has a relay identity of its own, and is told of the other's folder as its second folder
    const dir = mkdtempSync(join(tmpdir(), "ovis-list-foreign-"));
    closes.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(loadRelayIdentity(dir).server_id).not.toBe(other.serverId);
    const mine = relayFixture(false, { stateDir: dir, siblingStateDir: other.fixture.stateDir, accountOpensAll: false });
    closes.push(() => mine.app.stop());
    expect(mine.app.context.services.devices.opensAll()).toBe(false);
    expect(mine.app.context.services.accountList).toBeNull();
  });

  test("started with Step 2 turned off here, a pinned PC still follows its list: a member's signed add adds nobody", async () => {
    const pc = await pinnedPc();
    const stranger = await listMember();
    pc.fixture.app.stop();
    // OVIS_ACCOUNT_OPENS_ALL=0 on this PC, the documented way to turn Step 2 off here
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: false, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { devices, accountList } = again.app.context.services;
    // the clock the rows' join holds ended by
    devices.useClock(pc.time.waits);
    await accountList?.settled();
    expect(accountList?.pinned()).toBe(true);
    expect(devices.listFollowed()).toBe(true);
    const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: stranger.key, label: "Stranger", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: pc.member.publicKey }, pc.member.keys.privateKey);
    expect(await applyAccountRecords(devices, [add], pc.serverId)).toEqual([{ id: add.id, outcome: "refused", code: "list_followed" }]);
    // and the list's own devices still open it
    await again.app.context.services.accountMailbox.pull();
    await accountList!.settled();
    // a row that was in its join hold at the stop begins it again at a start
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const link = await relayConnection(again, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
  });
});

describe("two histories, and another account's list", () => {
  test("a second history a member signed raises the alarm: the PC adds nobody, and keeps whom it held", async () => {
    const pc = await pinnedPc();
    // the first device signs another continuation from entry 0, with a device this PC never saw, which signs on it
    const { texts, device: onFork } = await pc.account.forkFromStart();
    pc.service.tamperList(pc.account.id, { reader: pc.reader, fork: texts });
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ alarm: "fork", pinned: true });
    expect(await pc.signsIn(pc.idOf(onFork))).toBeNull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    // and from then on a device the honest history adds is held back too, until a person looks
    pc.service.untamperList(pc.account.id);
    const late = await listMember();
    await pc.account.addDevice(late, { by: pc.first });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.idOf(late))).toBeNull();
    expect(await pc.signsIn(pc.idOf(pc.first))).toBe("drive");
  });

  test("another account's list, served under this account's id, lets none of its devices in", async () => {
    const pc = await pinnedPc();
    const theirs = await TestList.start(pc.service, "acct_other", undefined, pc.time.seconds);
    const stranger = await listMember();
    await theirs.addDevice(stranger);
    pc.service.tamperList(pc.account.id, { reader: pc.reader, answerList: theirs.id });
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: pc.account.id, devices: 2, pinned: true });
    expect(await pc.signsIn(pc.idOf(stranger))).toBeNull();
    expect(await pc.signsIn(pc.idOf(theirs.first))).toBeNull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });
});

describe("another PC of the account", () => {
  test("is the account's only while the list holds its relay key, and a removed one does not come back by any entry", async () => {
    const pc = await pinnedPc();
    const keys = await listMember();
    const endpoint = "cd".repeat(32);
    const card = await signCard({ key: keys.key, enc: keys.enc, list: pc.account.id, endpoint, invite: null }, keys.keys.privateKey);
    expect(pc.list.holdsPc(endpoint)).toBe(false);
    const added = await pc.account.sign({ kind: "pc", key: keys.key, endpoint, enc: keys.enc, card, sealed: null });
    await pc.list.takeFromPeer({ entries: [added], head: pc.account.place });
    expect(pc.list.holdsPc(endpoint)).toBe(true);
    const removed = await pc.account.sign({ kind: "remove", ends: keys.key });
    const again = await pc.account.sign({ kind: "pc", key: keys.key, endpoint, enc: keys.enc, card, sealed: null });
    await pc.list.takeFromPeer({ entries: [removed, again], head: pc.account.place });
    expect(pc.list.status().head).toEqual(pc.account.place);
    expect(pc.list.holdsPc(endpoint)).toBe(false);
    // and this PC itself is untouched by it
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", pcs: 1 });
  });
});

describe("a PC the list removed", () => {
  async function removedPc() {
    const pc = await pinnedPc();
    const own = pc.service.accountList(ACCOUNT)!.state.pcs[pc.endpoint]!.key!;
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    const before = pc.list.status().head!;
    await pc.account.remove(own);
    await pc.pull();
    return { pc, link, before };
  }

  test("leaves its account and lets none of the account's devices in", async () => {
    const { pc, link } = await removedPc();
    expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
    expect(pc.services.devices.account()).toBeNull();
    expect(pc.rowKeys()).toEqual([]);
    expect(pc.services.devices.listFollowed()).toBe(false);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    expect(await pc.signsIn(pc.idOf(pc.first))).toBeNull();
  });

  test("does not come back: not by a press, not by the service's word, not by an old log, not after a restart", async () => {
    const { pc, before } = await removedPc();
    // the account service lists and admits the PC again, and a press on the PC asks for that account
    const headers = { authorization: `Bearer ${pc.service.issueToken(ACCOUNT, { twoStep: true })}` };
    pc.service.completions = true;
    const listed = await pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}`, { method: "PUT", headers, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.ovis.sh" }) }));
    expect(listed.ok).toBe(true);
    await pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}/admit`, { method: "POST", headers, body: "{}" }));
    pc.services.relay.setRelayAccount(ACCOUNT);
    expect(await pressOnce(pc.services, ACCOUNT)).toMatchObject({ refused: { code: "list_removed" } });
    expect(pc.services.devices.account()).toBeNull();
    // an old log in which the PC was still in
    pc.service.tamperList(pc.account.id, { reader: pc.reader, head: before, withholdAfter: before.seq });
    await pc.pull();
    expect(pc.services.devices.account()).toBeNull();

    pc.fixture.app.stop();
    // the copy of the list is only a copy: without it the PC still knows it was removed
    rmSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE), { force: true });
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { services } = again.app.context;
    expect(services.devices.listRemovedFrom(ACCOUNT)).toBe(true);
    services.relay.setRelayAccount(ACCOUNT);
    expect(await pressOnce(services, ACCOUNT)).toMatchObject({ refused: { code: "list_removed" } });
    expect(await services.accountList!.wantList(pc.account.id)).toEqual({ refused: "not_in_account" });
    // another account is another matter, and so is this PC after a reset relay identity: a new PC
    expect(services.devices.listRemovedFrom("acct_other")).toBe(false);
    again.app.stop();
    // with Step 2 turned off on this PC the removal stands all the same: nothing links the PC back under this identity
    const off = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: false, accountService: pc.accountService });
    closes.push(() => off.app.stop());
    expect(off.app.context.services.devices.listRemovedFrom(ACCOUNT)).toBe(true);
    await off.app.context.services.relay.resetIdentity();
    expect(off.app.context.services.devices.listRemovedFrom(ACCOUNT)).toBe(false);
  });
});

describe("every way a row under the account's id for a key comes to a session, on a pinned PC", () => {
  test("a pairing confirmed on this PC's screen that reuses such a row opens no session by it: the list holds no device under that key", async () => {
    const made = await keyProofPc(true);
    closes.push(() => { void made.close(); });
    const { devices } = made.app.context.services;
    const device = await phone();
    // the row a comparison approved at this PC left for the key: its id is the account's for that key
    const id = accountDeviceId(SERVER_ID, device.spki);
    expect(devices.pairRelayApproved("Phone", device.spki, { path: "code", id })?.device.id).toBe(id);
    const followed = spyOn(devices, "listFollowed").mockReturnValue(true);
    const role = spyOn(devices, "listRoleOf").mockReturnValue(null);
    try {
      // the same key comes with a code and proves it; the person approves the key on the PC's screen
      const proving = await provingDevice(made, devices.startPairing().code, undefined, device);
      await proving.pending;
      const answered = deferred<string>();
      proving.link.onFrame = (frame) => { if (frame.type === FrameType.AUTH_OK) answered.resolve("let in"); };
      void proving.link.serverError.then((code) => answered.resolve(String(code)));
      made.screen.approve(made.screen.keyConfirm()!.id);
      expect(await bounded(answered.promise)).toBe("auth_failed");
      // the row is the one it was: no second row was made for the key
      expect(devices.list(null).filter((row) => row.id === id)).toHaveLength(1);
    } finally { followed.mockRestore(); role.mockRestore(); }
  });
});

describe("a removal this PC acted on and could not save", () => {
  test("keeps every row of that key out after a restart, a pairing this PC made itself under an id of its own too", async () => {
    const pc = await pinnedPc();
    // the account phone: paired at this PC under an id of its own, and a device of the list by the same key
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone);
    await pc.pull();
    const paired = { keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id };
    expect(await pc.signsIn(paired)).toBe("drive");
    pc.fixture.app.stop();
    // the last run verified the phone's removal and wrote the mark; neither the copy nor the removal's record reached the disk
    const binding = JSON.parse(readFileSync(join(pc.fixture.stateDir, "account-pc.json"), "utf8")) as { binding: { bind_id: string } };
    const mark = join(pc.fixture.stateDir, ACCOUNT_LIST_OWED_FILE);
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(mark, JSON.stringify({ v: 1, server_id: pc.serverId, bind_id: binding.binding.bind_id, at: now, floor: now, removed: [{ key: phone.key, seq: pc.account.place.seq + 1 }], expired: [] }));
    pc.reach.away = true;
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    await again.app.context.services.accountList!.settled();
    const signsIn = async (device: typeof paired) => await (await relayConnection(again, { serverId: pc.serverId })).auth(device).then((ok) => ok.role, () => null);
    expect(await signsIn(paired)).toBeNull();
    expect(await signsIn(pc.idOf(phone))).toBeNull();
    // without the mark the same pairing opens the PC: it was the mark that kept it out
    again.app.stop();
    rmSync(mark);
    const clean = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => clean.app.stop());
    await clean.app.context.services.accountList!.settled();
    expect(await (await relayConnection(clean, { serverId: pc.serverId })).auth(paired).then((ok) => ok.role, () => null)).toBe("drive");
  });
});

describe("a second Ovis server on the same state folder", () => {
  test("does not let the snapshot add a device once the other server pinned the PC: it takes the pin in before the snapshot's rows are committed", async () => {
    const pc = await listedPc();
    const path = join(pc.fixture.stateDir, "account-pc.json");
    // the other server pins the binding: the file gains the pin, this server's memory does not
    const disk = JSON.parse(readFileSync(path, "utf8")) as { gen: number; binding: object };
    writeFileSync(path, JSON.stringify({ ...disk, v: 2, gen: disk.gen + 1, binding: { ...disk.binding, list: pc.account.id } }));
    expect(pc.services.devices.listFollowed()).toBe(false);
    // the account service names a device its snapshot lets in
    const stranger = await listMember();
    pc.service.registerDevice(ACCOUNT, stranger.key, "Stranger");
    await pc.services.accountMailbox.readSnapshot();
    expect(pc.services.devices.listFollowed()).toBe(true);
    expect(pc.rowKeys()).not.toContain(stranger.key);
  });
});

describe("one press, for an account that keeps a signed list", () => {
  test("the account service's refusal to take the PC by an admission is said as that, not as a service that is away", async () => {
    const service = new FakeAccountService();
    service.opensAll = true;
    const fixture = relayFixture(false, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
    closes.push(() => fixture.close());
    const { services } = fixture.app.context;
    services.relay.setRelayAccount(ACCOUNT);
    // the PC heard a moment ago that the account keeps no list; the account made one since, and the service refuses the take
    const named = spyOn(services.accountMailbox, "listNamed").mockResolvedValue(null);
    const refused = spyOn(services.accountMailbox, "admission").mockRejectedValue(new AccountServiceRefusal(409, "list_add", "/v1/pc/admission"));
    try {
      expect(await pressOnce(services, ACCOUNT)).toMatchObject({ refused: { code: "list_add", status: 409 } });
    } finally { refused.mockRestore(); named.mockRestore(); }
    expect(services.devices.account()).toBeNull();
  });
});

describe("what unpins", () => {
  test("Revoke all at the PC: it is in no account, and the list it followed is not read for the next one", async () => {
    const pc = await pinnedPc();
    pc.services.devices.revokeAll();
    expect(pc.services.devices.account()).toBeNull();
    expect(pc.list.status()).toMatchObject({ pinned: false, list: null, want: null, account: null });
    expect(pc.services.devices.listFollowed()).toBe(false);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  });

  test("not losing the copy: a PC whose account-list.json is gone is still pinned, and reads its list again from the start", async () => {
    const pc = await pinnedPc();
    const borrowed = await listMember();
    await pc.account.addDevice(borrowed);
    await pc.pull();
    const beforeRemoval = pc.list.status().head!;
    await pc.account.remove(borrowed.key);
    await pc.pull();
    pc.fixture.app.stop();
    rmSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE));

    // the service is away, and its snapshot would name a device of its own
    const planted = await listMember();
    pc.service.registerDevice(ACCOUNT, planted.key, "Planted");
    pc.reach.away = true;
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { services } = again.app.context;
    const signsIn = async (device: ListMember) => await (await relayConnection(again, { serverId: pc.serverId })).auth(pc.idOf(device)).then((ok) => ok.role, () => null);
    const pull = async () => { await services.accountMailbox.pull(); await services.accountList!.settled(); };
    await pull();
    expect(services.devices.listFollowed()).toBe(true);
    expect(services.accountList!.status()).toMatchObject({ pinned: true, list: pc.account.id, standing: "waiting", devices: 0 });
    // with nothing read, nobody of the account gets in: no copy is no leave to ask the service instead
    expect(await signsIn(pc.laptop)).toBeNull();

    // the service is back, and shows the list only as it was before the removal: what it shows is taken, and the
    // device this PC had seen removed stays out
    pc.reach.away = false;
    pc.service.tamperList(pc.account.id, { reader: pc.reader, head: beforeRemoval, withholdAfter: beforeRemoval.seq });
    await pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", head: beforeRemoval });
    expect(await signsIn(pc.laptop)).toBe("drive");
    expect(await signsIn(borrowed)).toBeNull();
    expect(await signsIn(planted)).toBeNull();
  });

  test("not an update: a copy whose saved state another build wrote is read again from its entries, and the PC holds whom it held", async () => {
    const pc = await pinnedPc();
    pc.fixture.app.stop();
    const path = join(pc.fixture.stateDir, ACCOUNT_LIST_FILE);
    const file = JSON.parse(readFileSync(path, "utf8")) as { save: string };
    const saved = await readSave(file.save);
    if (!saved.read || saved.copy.state === null) throw new Error("The saved copy does not read");
    // the same entries under a state no build of today writes
    const other = writeSave({ ...saved.copy, state: { ...saved.copy.state, epoch: saved.copy.state.epoch + 7 } });
    writeFileSync(path, JSON.stringify({ ...file, save: other }));
    expect(await readSave(other)).toMatchObject({ read: true, rebuilt: true });

    pc.reach.away = true;
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    await again.app.context.services.accountMailbox.pull();
    await again.app.context.services.accountList!.settled();
    expect(again.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", devices: 2, error: null });
    const link = await relayConnection(again, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.first))).toMatchObject({ role: "drive" });
    // and it is written back as this build writes it
    const now = JSON.parse(readFileSync(path, "utf8")) as { save: string };
    expect(await readSave(now.save)).toMatchObject({ read: true, rebuilt: false });
  });

  test("nothing else: an account-list.json that will not read is a pin the PC cannot read, and lets nobody of the account in", async () => {
    const pc = await pinnedPc();
    pc.fixture.app.stop();
    const path = join(pc.fixture.stateDir, ACCOUNT_LIST_FILE);
    const saved = readFileSync(path, "utf8");
    writeFileSync(path, saved.slice(0, saved.length - 40));
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { services } = again.app.context;
    // the service offers its snapshot with a device of its own, and the list again
    const planted = await listMember();
    pc.service.registerDevice(ACCOUNT, planted.key, "Planted");
    await services.accountMailbox.pull();
    await services.accountList!.settled();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(services.devices.listFollowed()).toBe(true);
    expect(services.accountList!.status().error).toContain(ACCOUNT_LIST_FILE);
    for (const device of [planted, pc.laptop, pc.first]) {
      const link = await relayConnection(again, { serverId: pc.serverId });
      await expect(link.auth(pc.idOf(device))).rejects.toThrow();
    }
    expect(readFileSync(path, "utf8")).toBe(saved.slice(0, saved.length - 40));
  });
});
