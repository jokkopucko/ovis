/**
 * Independent review of the PC's part of migration (feat/account-list-migrate-pc at b98723e45, on pc-join ae4d4aee8):
 * the PC that follows no list pins the list a device names in its own session (V4-1), what it tells a device (W1), the
 * vouches it keeps (W2), the card it hands out (W4) and the staging factor (W5).
 *
 * Tests named `FINDING ...` FAIL on b98723e45 and show a finding of review-migrate-pc.md; tests named `GUARD ...` pass
 * and pin a guard the review checked. Written to live in server/account/ (as list-migrate.contract.test.ts does).
 *
 * Taken into the suite after the review, with the birth placed whole at the account service fake (its one-request
 * birth) and each device signed in there: the FINDING tests pass since the fixes of that round (M2 by the account
 * service's links, as the lead ruled), and the residual of M2 is pinned beside them.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { linkBytes, namingBytes, type SignedNaming, type SignedVouch } from "../../shared/account-list-migrate.ts";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { toBase64Url } from "../../shared/relay-pair-sas.ts";
import { relayAccountFixture, relayConnection, relayDevice, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_LIST_VOUCHES_FILE, VOUCHES_PER_LIST_MAX } from "./list-vouches.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { accountServiceUrl } from "./mailbox.ts";
import { asSignIn, birthPlan, migratingDevice, MigratedList, scaled, signedInAgain, signIn, signInOutcome, type MigratingPhone } from "./migrate.test-helpers.ts";
import { migrateTimeScale } from "./migrate-time.ts";
import { ask } from "./pairing.test-helpers.ts";
import { AccountWitness, type WitnessedRow } from "./witness.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

const DAY_MS = 86_400_000;
const READ_EVERY_MS = 55 * 60_000;
const SLOW = 60_000;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  return { waits, advance(ms: number) { now += ms; waits.advance(ms); }, seconds: () => Math.floor(now / 1000) };
}

/** As list-migrate.contract.test.ts: a PC in an account in use, a phone and a tablet let in for a day and more. */
async function accountInUse() {
  const time = testTime();
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  service.listMigrateAccounts = "*";
  const accountService = { url: "https://account.test", fetch: (request: Request) => service.fetch(request) };
  const { fixture, member } = await scaled(undefined, () => relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService, accountListAddPollMs: 0 }));
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  services.devices.useClock(time.waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const phone = await migratingDevice("Phone");
  const tablet = await migratingDevice("Tablet");
  for (const device of [phone, tablet]) signIn(service, ACCOUNT, device);
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  time.advance(JOIN_HOLD_MS + 1_000);
  for (const device of [phone, tablet]) expect(services.accountRows!.access(accountDeviceId(serverId, device.signIn.key))).toEqual({ ok: true });
  const witness = services.accountWitness!;
  witness.step();
  const run = async (ms: number) => {
    for (let left = ms; left > 0; left -= READ_EVERY_MS) {
      time.advance(Math.min(left, READ_EVERY_MS));
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      witness.step();
    }
  };
  await run(DAY_MS + 60_000);
  const list = services.accountList!;
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  const signsIn = async (device: MigratingPhone, which: "signIn" | "member" = "signIn"): Promise<"drive" | "watch" | null> => {
    return await signInOutcome(await relayConnection(fixture, { serverId }), asSignIn(serverId, device, which));
  };
  const rowOf = (key: string) => services.accountRows!.rows().find((row) => row.key === key) ?? null;
  const settle = async () => { list.tick(); await list.settled(); };
  return { time, service, fixture, member, serverId, services, endpoint, phone, tablet, witness, run, list, pull, signsIn, rowOf, settle };
}
type Pc = Awaited<ReturnType<typeof accountInUse>>;

async function sessionOf(pc: Pc, device: MigratingPhone, which: "signIn" | "member" = "signIn") {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await link.auth(asSignIn(pc.serverId, device, which));
  return link;
}

type NameAnswer = { pinned: true; list: string } | { pinned: false; why: string; wait: number | null };
async function names(link: Awaited<ReturnType<typeof relayConnection>>, body: unknown): Promise<NameAnswer> {
  const answer = await ask(link, "/api/account/list/name", { method: "POST", body });
  expect(answer.status).toBe(200);
  return answer.body as NameAnswer;
}

async function freshKey(): Promise<{ key: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { key: await exportAccountKey(pair.publicKey), privateKey: pair.privateKey };
}
const sign = async (privateKey: CryptoKey, bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, new Uint8Array(bytes))));

/** A naming that holds for this PC and this session, signed by a key that is nobody's (no device of any list). */
async function strangerNaming(list: string, session: string, endpoint: string): Promise<SignedNaming> {
  const signer = await freshKey();
  return { list, key: signer.key, signature: await sign(signer.privateKey, namingBytes({ account: ACCOUNT, list, key: signer.key, session, endpoint })) };
}

/** A link that holds for this account and list, between two keys made up a moment ago: nobody's device. */
async function junkVouch(list: string): Promise<SignedVouch> {
  const [member, device] = [await freshKey(), await freshKey()];
  const bytes = linkBytes({ account: ACCOUNT, list, key: member.key, device: device.key });
  return { key: member.key, device: device.key, link: { member: await sign(member.privateKey, bytes), device: await sign(device.privateKey, bytes) } };
}

describe("FINDING MEDIUM-1: the vouches a PC keeps for a list can be filled by one caller", () => {
  test("FINDING MEDIUM-1: a guest's pairing hands 64 links of made-up keys; the phone that signed in again then never gets the PC to follow", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    // the phone signs in again after the move: from now on this PC knows it only by its vouch
    const again = await signedInAgain(pc.phone);
    signIn(pc.service, ACCOUNT, again);
    pc.service.removeDevice(ACCOUNT, pc.phone.signIn.key);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, again.signIn.key))).toEqual({ ok: true });
    // a guest the person paired at this PC (no device of the account; it only needs the list's id) names the list
    // with a key of its own and hands made-up links, 16 a request: each holds (both signatures are its own)
    const guest = await relayDevice(pc.fixture);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await link.auth(guest);
    for (let request = 0; request < VOUCHES_PER_LIST_MAX / 16; request++) {
      const vouches = await Promise.all(Array.from({ length: 16 }, () => junkVouch(born.id)));
      expect(await names(link, { naming: await strangerNaming(born.id, guest.publicKey, pc.endpoint), vouches })).toEqual({ pinned: false, why: "session_unknown", wait: null });
    }
    // since the fix: a link between keys that are no device of the list and no key this PC lets in takes no place
    const kept = JSON.parse(readFileSync(join(pc.fixture.stateDir, ACCOUNT_LIST_VOUCHES_FILE), "utf8")) as { lists: Record<string, unknown[]> };
    expect(kept.lists[born.id] ?? []).toHaveLength(0);
    // a day later the phone names its list with its own vouch, in its own session, as the honest app does every session
    await pc.run(DAY_MS);
    const answer = await names(await sessionOf(pc, again), { naming: await born.naming(again, again.signIn.key, pc.endpoint), vouches: [await born.vouch(again)] });
    // what should be: the PC follows (as list-migrate.contract.test.ts shows without the guest's links)
    expect(answer).toEqual({ pinned: true, list: born.id });
  }, SLOW);
});

describe("FINDING LOW-1: the staging factor is honoured toward the production service by another spelling of its host", () => {
  test("FINDING LOW-1: account.ovis.sh. (the same host, as a fully qualified name) takes the factor", () => {
    // every other spelling of the production origin is one origin once accountServiceUrl has read it
    expect(migrateTimeScale(accountServiceUrl("https://ACCOUNT.ovis.sh:443/v1"), "86400")).toBe(1);
    expect(migrateTimeScale(accountServiceUrl("https://user@account.ovis.sh/"), "86400")).toBe(1);
    // and the trailing dot names the same host to DNS, but not the same origin to the check
    expect(migrateTimeScale(accountServiceUrl("https://account.ovis.sh./"), "86400")).toBe(1);
  });
});

/** The PC once the phone moved the account onto its list carrying the tablet in and this PC as an endpoint, named here. */
async function followsByMove() {
  const pc = await accountInUse();
  const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet], [pc.endpoint]), pc.time.seconds);
  await pc.pull();
  expect(await names(await sessionOf(pc, pc.phone), { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toEqual({ pinned: true, list: born.id });
  await pc.settle();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  return { ...pc, born };
}

describe("LOW-2, ruled W2 as built: a pinned PC answers its own pin", () => {
  test("a naming of another list, even one that holds for nobody, is told the list this PC follows, which the device compares with its own", async () => {
    const pc = await followsByMove();
    const link = await sessionOf(pc, pc.phone, "member");
    const other = "ab".repeat(32);
    expect(await names(link, { naming: await strangerNaming(other, pc.phone.member.key, pc.endpoint) })).toEqual({ pinned: true, list: pc.born.id });
  }, SLOW);
});

describe("FINDING LOW-3: a hand-over during a join hold ends the hold", () => {
  test("FINDING LOW-3: a device a member allowed a moment ago hands its place on, and is let in before its hold is over", async () => {
    const pc = await followsByMove();
    const late = await migratingDevice("Laptop");
    // a member allows it by the key of its sign-in, which it claimed at the service; then it claims its account key
    signIn(pc.service, ACCOUNT, late);
    const card = await pc.born.claim({ ...late, member: late.signIn, memberPair: late.signInPair });
    await pc.born.append({ kind: "device", key: late.signIn.key, power: "full", role: "drive", until: null, enc: late.enc, card, sealed: null, rotates: false }, pc.phone.member);
    await pc.born.claim(late);
    await pc.pull();
    expect(pc.rowOf(late.signIn.key)).toMatchObject({ state: "hold" });
    expect(await pc.signsIn(late)).toBeNull();
    await pc.born.handOver(late);
    await pc.pull();
    // what should be: the same device, the same row, the hold it was in still running (JOIN_HOLD_MS has not passed)
    expect(await pc.signsIn(late, "member")).toBeNull();
    expect(pc.rowOf(late.member.key)?.state).toBe("hold");
  }, SLOW);
});

describe("FINDING MEDIUM-2: a removal this PC holds against a device's present sign-in key does not reach its account key at the pin", () => {
  /**
   * The tablet was carried and handed its place on to its account key; then it signed in again (a new sign-in key the
   * account service links to that account key), and this PC let the new key in through the account.
   */
  async function tabletSignedInAgain() {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    await born.handOver(pc.tablet);
    await pc.pull();
    const again = await signedInAgain(pc.tablet);
    signIn(pc.service, ACCOUNT, again);
    // the app links its new sign-in to the key the list holds it by, at the account service (D11.2)
    await born.link(again);
    pc.service.removeDevice(ACCOUNT, pc.tablet.signIn.key);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, again.signIn.key))).toEqual({ ok: true });
    /** The person at this PC removes the tablet as it stands here: by the key this PC lets it in by now. */
    const removeHere = () => pc.services.devices.removeAccountKey(again.signIn.key, ACCOUNT, { id: "d".repeat(32), issuedAt: new Date().toISOString() });
    /** The phone names the list in its own session: this PC knows it, and knows who started the list. */
    const phoneNames = async () => {
      expect(await names(await sessionOf(pc, pc.phone), { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toEqual({ pinned: true, list: born.id });
      await pc.settle();
      expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
      pc.time.advance(JOIN_HOLD_MS + 1_000);
    };
    return { ...pc, born, again, removeHere, phoneNames };
  }

  test("FINDING MEDIUM-2: the person removes the tablet here by its new sign-in key, whose link the tablet never handed this PC; after the phone's naming the tablet opens this PC by its account key", async () => {
    const pc = await tabletSignedInAgain();
    pc.removeHere();
    expect(pc.services.devices.holdsRemoval(pc.again.signIn.key)).toBe(true);
    await pc.run(60_000);
    await pc.phoneNames();
    // what should be (the lead's ruling M2, a): the PC read the link from the account service before it pinned
    expect(await pc.signsIn(pc.again, "member")).toBeNull();
  }, SLOW);

  test("after the pin: the tablet signs in again, the person removes it here by that key, and the PC's next read of the list keeps it out by its account key", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    await born.handOver(pc.tablet);
    await pc.pull();
    expect(await names(await sessionOf(pc, pc.phone), { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toEqual({ pinned: true, list: born.id });
    await pc.settle();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.tablet, "member")).toBe("drive");
    // the link is taken at the account service only now, after the pin: no naming ever handed it to this PC
    const again = await signedInAgain(pc.tablet);
    signIn(pc.service, ACCOUNT, again);
    await born.link(again);
    pc.services.devices.removeAccountKey(again.signIn.key, ACCOUNT, { id: "e".repeat(32), issuedAt: new Date().toISOString() });
    // the PC reads its list at its own pace: the read after the removal takes the link with it
    pc.time.advance(301_000);
    pc.list.tick();
    await pc.list.settled();
    expect(await pc.signsIn(pc.tablet, "member")).toBeNull();
  }, SLOW);

  test("the residual of M2: a service that withholds the link lets that device in by its account key", async () => {
    const pc = await tabletSignedInAgain();
    pc.service.tamperList(pc.born.id, { reader: { server_id: pc.serverId }, withholdLinks: [pc.again.member.key] });
    pc.removeHere();
    await pc.run(60_000);
    await pc.phoneNames();
    expect(await pc.signsIn(pc.again, "member")).toBe("drive");
  }, SLOW);

  test("no links read, no pin: a PC whose account service does not serve the list's links follows no naming yet", async () => {
    const pc = await tabletSignedInAgain();
    // an account service from before the route answers it as an unknown one
    const served = pc.service.fetch.bind(pc.service);
    const older = spyOn(pc.service, "fetch").mockImplementation(async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === "/v2/pc/list/links" ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : await served(request);
    });
    expect(await names(await sessionOf(pc, pc.phone), { naming: await pc.born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toEqual({ pinned: false, why: "not_read", wait: null });
    older.mockRestore();
    pc.time.advance(31_000);
    await pc.phoneNames();
  }, SLOW);

  test("GUARD: the same tablet named the list here once by its new key (its link kept): after the pin it stays out", async () => {
    const pc = await tabletSignedInAgain();
    const tablet = await sessionOf(pc, pc.again);
    expect(await names(tablet, { naming: await pc.born.naming(pc.again, pc.again.signIn.key, pc.endpoint), vouches: [await pc.born.vouch(pc.again)] })).toMatchObject({ pinned: false, why: "session_new" });
    pc.removeHere();
    await pc.run(60_000);
    await pc.phoneNames();
    expect(await pc.signsIn(pc.again, "member")).toBeNull();
  }, SLOW);
});

describe("GUARD: an account with no list sees nothing new", () => {
  test("GUARD: a naming on a PC whose account has no list reads nothing in, writes no file and changes no row", async () => {
    const pc = await accountInUse();
    const rows = pc.services.accountRows!.rows().map((row) => row.key).sort();
    const link = await sessionOf(pc, pc.phone);
    const nowhere = "ef".repeat(32);
    expect(await names(link, { naming: await strangerNaming(nowhere, pc.phone.signIn.key, pc.endpoint), vouches: [await junkVouch(nowhere)] })).toEqual({ pinned: false, why: "not_read", wait: null });
    expect(existsSync(join(pc.fixture.stateDir, ACCOUNT_LIST_VOUCHES_FILE))).toBe(false);
    expect(pc.services.accountRows!.rows().map((row) => row.key).sort()).toEqual(rows);
    expect(pc.list.status().pinned).toBe(false);
  }, SLOW);
});

describe("GUARD: what the review checked and found holding", () => {
  test("GUARD: a guest's pairing, a device let in an hour ago and a device the list does not hold as full name nothing", async () => {
    const pc = await accountInUse();
    const laptop = await migratingDevice("Laptop");
    signIn(pc.service, ACCOUNT, laptop);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, laptop.signIn.key))).toEqual({ ok: true });
    await pc.run(60 * 60_000);
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    // a guest's pairing: known here by nothing, whoever's naming it carries
    const guest = await relayDevice(pc.fixture);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await link.auth(guest);
    expect(await names(link, { naming: await born.naming(pc.phone, guest.publicKey, pc.endpoint) })).toMatchObject({ pinned: false, why: "session_unknown" });
    // a key let in an hour ago, carrying a full device's naming it was handed: it waits first, and is no device of that naming
    const fresh = await sessionOf(pc, laptop);
    expect(await names(fresh, { naming: await born.naming(pc.phone, laptop.signIn.key, pc.endpoint) })).toMatchObject({ pinned: false, why: "session_new" });
    await pc.run(DAY_MS);
    expect(await names(await sessionOf(pc, laptop), { naming: await born.naming(pc.phone, laptop.signIn.key, pc.endpoint) })).toMatchObject({ pinned: false, why: "session_other_device" });
    // a key of its own that the list does not hold: not a member
    expect(await names(await sessionOf(pc, laptop), { naming: await strangerNaming(born.id, laptop.signIn.key, pc.endpoint) })).toMatchObject({ pinned: false, why: "not_member" });
    expect(pc.list.status().pinned).toBe(false);
  }, SLOW);

  test("GUARD: a removal this PC holds against the key that started the list keeps it unpinned, whoever names it", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    pc.services.devices.removeAccountKey(pc.phone.signIn.key, ACCOUNT, { id: "c".repeat(32), issuedAt: new Date().toISOString() });
    const tablet = await sessionOf(pc, pc.tablet);
    expect(await names(tablet, { naming: await born.naming(pc.tablet, pc.tablet.signIn.key, pc.endpoint, "signIn") })).toEqual({ pinned: false, why: "first_signer_removed", wait: null });
    expect(pc.list.status().pinned).toBe(false);
  }, SLOW);

  test("GUARD: links of made-up keys never make a session a device's own, and a link of another list is no link here", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    const laptop = await migratingDevice("Laptop");
    signIn(pc.service, ACCOUNT, laptop);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, laptop.signIn.key))).toEqual({ ok: true });
    await pc.run(DAY_MS);
    // the laptop signs a link of its own sign-in key to the phone's account key: it lacks the phone's signature
    const bytes = linkBytes({ account: ACCOUNT, list: born.id, key: pc.phone.member.key, device: laptop.signIn.key });
    const half: SignedVouch = { key: pc.phone.member.key, device: laptop.signIn.key, link: { member: await sign(laptop.signInPair.privateKey, bytes), device: await sign(laptop.signInPair.privateKey, bytes) } };
    // the phone's honest link, for another list id: it says nothing of this one
    const otherList = "cd".repeat(32);
    const elsewhere = linkBytes({ account: ACCOUNT, list: otherList, key: pc.phone.member.key, device: laptop.signIn.key });
    const moved: SignedVouch = { key: pc.phone.member.key, device: laptop.signIn.key, link: { member: await sign(pc.phone.memberPair.privateKey, elsewhere), device: await sign(laptop.signInPair.privateKey, elsewhere) } };
    const link = await sessionOf(pc, laptop);
    expect(await names(link, { naming: await born.naming(pc.phone, laptop.signIn.key, pc.endpoint), vouches: [half, moved] })).toMatchObject({ pinned: false, why: "session_other_device" });
    expect(pc.list.status().pinned).toBe(false);
  }, SLOW);

  test("GUARD: a W1 answer goes to the account's drive sessions only: a watch pairing of the member gets read_only", async () => {
    const pc = await accountInUse();
    const watcher = await relayDevice(pc.fixture, "watch");
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await link.auth(watcher);
    const answer = await ask(link, "/api/account/list/witness");
    expect(answer.status).toBe(403);
    expect(JSON.stringify(answer.body)).not.toContain(pc.phone.signIn.key);
  }, SLOW);
});

describe("GUARD: the record's counters (witness.ts) as the naming reads them", () => {
  /** A record driven by hand: one key let in, its own wall clock and running time. */
  function record(stateDir: string, clocks: { wall: number; mono: number }, scale = 1) {
    const rows: WitnessedRow[] = [{ key: "k".repeat(87), lets: true, seen: null }];
    return new AccountWitness({ stateDir, scope: () => ({ account: ACCOUNT, serverId: "s".repeat(16) }), rows: () => rows, wall: () => clocks.wall, mono: () => clocks.mono, scale });
  }

  test("GUARD: a wall clock set two days forward across a restart gives a day of wall time and no running time", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "rvmpc-"));
    closes.push(() => rmSync(dir, { recursive: true, force: true }));
    const clocks = { wall: 1_800_000_000_000, mono: 1_000 };
    const first = record(dir, clocks);
    first.step();
    clocks.wall += 60 * 60_000;
    clocks.mono += 60 * 60_000;
    first.step();
    first.stop();
    // restarted with the clock two days ahead, and run for an hour
    clocks.wall += 2 * DAY_MS;
    clocks.mono = 1_000;
    const second = record(dir, clocks);
    second.step();
    clocks.wall += 60 * 60_000;
    clocks.mono += 60 * 60_000;
    const told = second.admits()!.admits[0]!;
    expect(told.ran).toBe(2 * 60 * 60);
    expect(told.wall).toBeLessThanOrEqual(DAY_MS / 1000 + 2 * 60 * 60 + 60);
  });

  test("GUARD: the staging factor multiplies what was counted, and a key let in a moment ago still counts for nothing", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "rvmpc-"));
    closes.push(() => rmSync(dir, { recursive: true, force: true }));
    const clocks = { wall: 1_800_000_000_000, mono: 1_000 };
    const scaled = record(dir, clocks, 86_400);
    expect(scaled.admits()!.admits[0]).toMatchObject({ wall: 0, ran: 0 });
  });
});
