/**
 * A PC whose account was in use before it had a signed list (docs/account-list.md, "An account that was in use"): what
 * it tells a device of the keys it has let in, how it comes to follow the list a device names to it, and what it does
 * with the rows of that list once it follows it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { signCard } from "../../shared/account-list.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_FEATURE, ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, relayAccountFixture, relayConnection, relayDevice, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_LIST_FILE, ACCOUNT_LIST_OWED_FILE, forgetList } from "./list-follow.ts";
import { ACCOUNT_WITNESS_FILE } from "./witness.ts";
import { ACCOUNT_LIST_VOUCHES_FILE } from "./list-vouches.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";
import { asSignIn, birthPlan, migratingDevice, MigratedList, scaled, signedInAgain, signIn, signInOutcome, type MigratingPhone } from "./migrate.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

const DAY_MS = 86_400_000;
/** How often the PC under test reads its account's snapshot while time passes: within the hour after which its rows would wait for a read. */
const READ_EVERY_MS = 55 * 60_000;
/** Each test lets a day pass on the PC, a read of its snapshot at a time: more than bun's five seconds on a busy machine. */
const SLOW = 30_000;
/** A key this PC put out: what a device's sign-in key was before somebody removed it here. */
const removedKey = (await migratingDevice("Old phone")).signIn.key;

/** The PC's clocks, moved by hand together: the time of day every part of it reads, and the clock its waits and its running time are counted on. */
function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  return { waits, advance(ms: number) { now += ms; waits.advance(ms); }, seconds: () => Math.floor(now / 1000) };
}

/**
 * A PC in an account that was in use: the account's snapshot let a phone and a tablet in by their sign-in keys, and
 * the PC has let both in for a day and more, by both of its clocks. The account has no list yet.
 */
async function accountInUse(options: { readonly scale?: number } = {}) {
  const time = testTime();
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  service.listMigrateAccounts = "*";
  /** How often the PC asked the account service for a page of its list's log. */
  const reads = { log: 0 };
  const accountService = { url: "https://account.test", fetch: async (request: Request) => { if (new URL(request.url).pathname === "/v2/pc/list/log") reads.log += 1; return await service.fetch(request); } };
  const { fixture, member } = await scaled(options.scale, () => relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService, accountListAddPollMs: 0, accountListTickMs: 0 }));
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
  /**
   * Time passes with the PC running: both of its clocks move, it reads the account's snapshot as it does every few
   * minutes (with no whole read for an hour its rows would wait for one), and its record takes each stretch.
   */
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
  /** What a sign-in comes to: the role the PC lets the device in as, or null. */
  const signsIn = async (device: MigratingPhone, which: "signIn" | "member" = "signIn"): Promise<"drive" | "watch" | null> => {
    return await signInOutcome(await relayConnection(fixture, { serverId }), asSignIn(serverId, device, which));
  };
  const rowOf = (key: string) => services.accountRows!.rows().find((row) => row.key === key) ?? null;
  /** The PC looks at its clock, and does what that brings. */
  const settle = async () => { list.tick(); await list.settled(); };
  return { time, service, fixture, member, serverId, services, endpoint, phone, tablet, witness, run, list, pull, signsIn, rowOf, settle, reads };
}

describe("what a PC tells a device of its account before the account moves", () => {
  test("the keys it lets in through the account now, for how long by its two counters, and the keys it holds a removal against", async () => {
    const pc = await accountInUse();
    const guest = await relayDevice(pc.fixture);
    pc.services.devices.removeAccountKey(removedKey, ACCOUNT, { id: "b".repeat(32), issuedAt: new Date().toISOString() });
    const phone = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await phone.auth(asSignIn(pc.serverId, pc.phone));
    const answer = await ask(phone, "/api/account/list/witness");
    expect(answer.status).toBe(200);
    const body = answer.body as { account: string; pinned: string | null; admits: { key: string; wall: number; ran: number; idle: number | null }[]; removed: string[] };
    expect([body.account, body.pinned, body.removed]).toEqual([ACCOUNT, null, [removedKey]]);
    // the account's rows alone: the pairing made at this PC is none, and neither is a guest's
    expect(body.admits.map((row) => row.key).sort()).toEqual([pc.phone.signIn.key, pc.tablet.signIn.key].sort());
    for (const row of body.admits) {
      expect(row.wall).toBeGreaterThanOrEqual(86_400);
      expect(row.ran).toBeGreaterThanOrEqual(86_400);
    }
    // the phone signed in today; the tablet's row was let in and not used since
    expect(body.admits.find((row) => row.key === pc.phone.signIn.key)?.idle).toBeLessThan(86_400);
    // a pairing of the account's member may ask too, and a device outside the account may not
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.member);
    expect((await ask(member, "/api/account/list/witness")).status).toBe(200);
    const outsider = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await outsider.auth(guest);
    expect((await ask(outsider, "/api/account/list/witness")).status).toBe(403);
  }, SLOW);

  test("a key let in a moment ago is told with what it has; a row that waits for the account service is told as none", async () => {
    const pc = await accountInUse();
    const laptop = await migratingDevice("Laptop");
    signIn(pc.service, ACCOUNT, laptop);
    expect(await pc.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, laptop.signIn.key))).toEqual({ ok: true });
    await pc.run(60_000);
    const phone = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await phone.auth(asSignIn(pc.serverId, pc.phone));
    const admits = (await ask(phone, "/api/account/list/witness")).body as { admits: { key: string; wall: number; ran: number }[] };
    expect(admits.admits.find((row) => row.key === laptop.signIn.key)).toMatchObject({ wall: 60, ran: 60 });
    // two hours with no whole read of the snapshot: every row waits for one, and lets nobody in meanwhile
    pc.time.advance(2 * 60 * 60_000);
    expect(pc.services.accountWitness!.admits()).toEqual({ account: ACCOUNT, admits: [] });
  }, SLOW);

  test("a staging run's factor multiplies what the PC tells, and says so in its status; the production service never takes it", async () => {
    const pc = await accountInUse({ scale: 60 });
    const phone = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await phone.auth(asSignIn(pc.serverId, pc.phone));
    const told = (await ask(phone, "/api/account/list/witness")).body as { admits: { key: string; wall: number; ran: number }[] };
    const record = pc.witness.record()!.keys[pc.phone.signIn.key]!;
    expect(told.admits.find((row) => row.key === pc.phone.signIn.key)).toMatchObject({ wall: record.wall * 60, ran: record.ran * 60 });
    expect((await ask(phone, "/api/account/status")).body).toMatchObject({ migrate_time_scale: 60 });
    const production = scaled(60, () => relayFixture(false, { accountOpensAll: true, accountService: { url: "https://account.ovis.sh", fetch: pc.service.fetch } }));
    closes.push(() => production.close());
    expect(production.app.context.services.accountWitness!.scale).toBe(1);
  }, SLOW);

  test("a PC in its account whose rows cannot be read now has no answer, which is not an answer that nobody is let in", async () => {
    const pc = await accountInUse();
    const phone = await sessionOf(pc, pc.phone);
    const unread = spyOn(pc.witness, "admits").mockReturnValue(null);
    const answer = await ask(phone, "/api/account/list/witness");
    expect([answer.status, (answer.body as { error: { code: string } }).error.code]).toEqual([503, "witness_unavailable"]);
    unread.mockRestore();
  }, SLOW);

  test("a PC in no account answers not_in_account", async () => {
    const fixture = relayFixture(false, { accountOpensAll: true });
    closes.push(() => fixture.close());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const answer = await fetch(`${base}/api/account/list/witness`, { headers: { origin: base } });
    expect([answer.status, ((await answer.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_in_account"]);
  }, SLOW);
});

/** A session of `device` signed in with one of its keys: what it says over it, and what it is told. */
async function sessionOf(pc: Awaited<ReturnType<typeof accountInUse>>, device: MigratingPhone, which: "signIn" | "member" = "signIn") {
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

describe("a PC that follows no list, and a device of its account names one in its session", () => {
  test("the device that started the list names it in a session this PC has let in for a day: the PC follows it, and its rows are the list's", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(false);
    const phone = await sessionOf(pc, pc.phone);
    const answer = await names(phone, { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) });
    expect(answer).toEqual({ pinned: true, list: born.id });
    // the pin follows once the answer is out: it ends every session of the account's rows, this one among them
    await pc.settle();
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: born.id });
    // the session it named the list in was one of the rows the snapshot made: it ends, and the phone comes back by its account key
    expect(await bounded(phone.serverError, 2000)).toBe("auth_changed");
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([pc.phone.member.key, pc.tablet.signIn.key].sort());
    expect(await pc.signsIn(pc.phone, "member")).toBe("drive");
    expect(await pc.signsIn(pc.phone)).toBeNull();
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
    // a device that asks where it stands is told the list this PC follows: the copy is the list's, pinned by how it came
    const copy = JSON.parse(readFileSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE), "utf8")) as { want: string; save: string };
    expect(copy.want).toBe(born.id);
    // naming it again tells the same
    const again = await sessionOf(pc, pc.phone, "member");
    expect(await names(again, { naming: await born.naming(pc.phone, pc.phone.member.key, pc.endpoint) })).toEqual({ pinned: true, list: born.id });
  }, SLOW);

  test("its WELCOME says the list it follows to a client that knows of lists, and nothing to one that does not; a PC that follows none says nothing new", async () => {
    const pc = await accountInUse();
    /** Every WELCOME a session is sent after its HELLO offers `features`: the provisional one, and the final one when there is one. */
    const welcomes = async (features: readonly string[]) => {
      const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
      const seen: Record<string, unknown>[] = [];
      link.onFrame = (frame) => { if (frame.type === FrameType.WELCOME) seen.push(frame.payload as unknown as Record<string, unknown>); };
      const first = await link.hello(features) as unknown as Record<string, unknown>;
      await link.flush();
      // each WELCOME once: the one hello() was answered with may have reached onFrame too
      const welcomes = [first, ...seen.filter((payload) => JSON.stringify(payload) !== JSON.stringify(first))];
      expect(link.frames.filter((frame) => frame.type === FrameType.WELCOME)).toHaveLength(welcomes.length);
      return welcomes;
    };
    // as on main: the provisional WELCOME alone, with the same members and no feature of lists
    const before = await welcomes([ACCOUNT_LIST_FEATURE]);
    expect(before.map((welcome) => Object.keys(welcome).sort())).toEqual([["features", "limits", "min_supported_client", "nonce", "protocol", "provisional", "relay_protocol", "server_version", "version"]]);
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    const phone = await sessionOf(pc, pc.phone);
    expect(await names(phone, { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toMatchObject({ pinned: true });
    await pc.settle();
    const knows = await welcomes([ACCOUNT_LIST_FEATURE]);
    expect(knows.at(-1)).toMatchObject({ features: [ACCOUNT_LIST_FEATURE], list: born.id });
    expect(knows.at(-1)).not.toHaveProperty("provisional");
    expect((await welcomes([])).some((welcome) => "list" in welcome)).toBe(false);
  }, SLOW);

  test("a session this PC let in an hour ago names nothing yet, and says how long it waits; after a day it does", async () => {
    const pc = await accountInUse();
    const laptop = await migratingDevice("Laptop");
    signIn(pc.service, ACCOUNT, laptop);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, laptop.signIn.key))).toEqual({ ok: true });
    await pc.run(60 * 60_000);
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet, laptop]), pc.time.seconds);
    await pc.pull();
    const link = await sessionOf(pc, laptop);
    const body = { naming: await born.naming(laptop, laptop.signIn.key, pc.endpoint, "signIn") };
    const waiting = await names(link, body);
    expect(waiting).toMatchObject({ pinned: false, why: "session_new" });
    expect((waiting as { wait: number }).wait).toBeGreaterThan(80_000);
    expect(pc.list.status().pinned).toBe(false);
    await pc.run(DAY_MS);
    expect(await names(await sessionOf(pc, laptop), body)).toEqual({ pinned: true, list: born.id });
    await pc.settle();
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
  }, SLOW);

  test("a list started by a key this PC never let in is followed on nobody's word: not on a carried device's, and not in a pairing's session", async () => {
    const pc = await accountInUse();
    const stranger = await migratingDevice("Stranger");
    // the account service's own birth, with a key of its own as the first signer: no device sends it, so it is made up
    const born = await MigratedList.forged(pc.service, ACCOUNT, stranger, birthPlan([pc.phone, pc.tablet]), pc.time.seconds);
    await pc.pull();
    // the phone was carried in and named it, fooled: the PC does not know who started it
    const phone = await sessionOf(pc, pc.phone);
    expect(await names(phone, { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint, "signIn") })).toEqual({ pinned: false, why: "first_signer_unknown", wait: null });
    // a naming said in a pairing's session: a pairing made at this PC is known here by nothing
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.member);
    expect(await names(member, { naming: await born.naming(pc.phone, pc.member.publicKey, pc.endpoint, "signIn") })).toEqual({ pinned: false, why: "session_unknown", wait: null });
    // a session of another device of the account carries no naming of the phone's (a borrowed browser's, say)
    expect(await names(await sessionOf(pc, pc.tablet), { naming: await born.naming(pc.phone, pc.tablet.signIn.key, pc.endpoint, "signIn") })).toEqual({ pinned: false, why: "session_other_device", wait: null });
    // and a naming said for another session or another PC holds nowhere
    expect(await names(await sessionOf(pc, pc.tablet), { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint, "signIn") })).toEqual({ pinned: false, why: "naming_invalid", wait: null });
    expect(await names(await sessionOf(pc, pc.phone), { naming: await born.naming(pc.phone, pc.phone.signIn.key, "ab".repeat(32), "signIn") })).toEqual({ pinned: false, why: "naming_invalid", wait: null });
    expect(pc.list.status().pinned).toBe(false);
    expect(await pc.signsIn(pc.phone)).toBe("drive");
  }, SLOW);

  test("a device that signed in again names the list by its vouch, which the PC keeps for the next session", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    // the phone signs in again: its old sign-in ends, and the PC lets the new key in from now on
    const again = await signedInAgain(pc.phone);
    signIn(pc.service, ACCOUNT, again);
    pc.service.removeDevice(ACCOUNT, pc.phone.signIn.key);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, again.signIn.key))).toEqual({ ok: true });
    expect(pc.rowOf(pc.phone.signIn.key)).toBeNull();
    const naming = () => born.naming(again, again.signIn.key, pc.endpoint);
    // with its vouch the session is the phone's, but this PC has let that key in for a minute only
    expect(await names(await sessionOf(pc, again), { naming: await naming(), vouches: [await born.vouch(again)] })).toMatchObject({ pinned: false, why: "session_new" });
    expect(existsSync(join(pc.fixture.stateDir, ACCOUNT_LIST_VOUCHES_FILE))).toBe(true);
    await pc.run(DAY_MS);
    // a day later the PC holds the vouch it was handed, and follows
    expect(await names(await sessionOf(pc, again), { naming: await naming() })).toEqual({ pinned: true, list: born.id });
    await pc.settle();
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
  }, SLOW);

  test("what the route takes: at most 16 vouches, only from a device's own session", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    const phone = await sessionOf(pc, pc.phone);
    const naming = await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint);
    const many = await ask(phone, "/api/account/list/name", { method: "POST", body: { naming, vouches: Array.from({ length: 17 }, () => ({ key: "k", device: "d", link: { member: "m", device: "d" } })) } });
    expect(many.status).toBe(400);
    expect((await ask(phone, "/api/account/list/name", { method: "POST", body: { vouches: [] } })).status).toBe(400);
    const base = `http://127.0.0.1:${pc.fixture.app.port}`;
    const local = await fetch(`${base}/api/account/list/name`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ naming }) });
    expect(local.status).toBe(403);
    expect(pc.list.status().pinned).toBe(false);
    // each call costs signature checks: a session makes 30 a minute, with the list's other session calls
    const other = await sessionOf(pc, pc.tablet);
    const statuses: number[] = [];
    for (let call = 0; call < 31; call++) statuses.push((await ask(other, "/api/account/list/name", { method: "POST", body: { naming } })).status);
    expect([statuses.slice(0, 30).every((status) => status === 200), statuses[30]]).toEqual([true, 429]);
  }, SLOW);
});

/** The PC once the phone moved the account onto its list, carrying the tablet in and this PC as an endpoint with no key, and named it here. */
async function followsByMove() {
  const pc = await accountInUse();
  const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet], [pc.endpoint]), pc.time.seconds);
  await pc.pull();
  expect(await names(await sessionOf(pc, pc.phone), { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toEqual({ pinned: true, list: born.id });
  await pc.settle();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  /** A member hands this PC entries over its own session, as it does after it placed them. */
  const hand = async (link: Awaited<ReturnType<typeof relayConnection>>, texts: readonly string[]) => {
    const after = born.head.seq - texts.length;
    born.serve();
    return await ask(link, "/api/account/list/page", { method: "POST", body: { list: born.id, after, entries: texts, head: born.head } });
  };
  const own = { headers: { origin: `http://127.0.0.1:${pc.fixture.app.port}`, "x-herdr-machine": "1", "content-type": "application/json" } };
  /** This PC's own window. */
  const local = async (path: string, body?: unknown) => {
    const answer = await fetch(`http://127.0.0.1:${pc.fixture.app.port}${path}`, body === undefined ? { headers: own.headers } : { method: "POST", ...own, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  return { ...pc, born, hand, local };
}

type Card = { key: string; enc: string; card: string; endpoint: string; list: string };

describe("the naming's bounds, and what the PC does not take for a list", () => {
  /** The vouches file as another server of this folder, or an earlier run, left it for this binding: these lists tracked. */
  const tracked = (pc: Awaited<ReturnType<typeof accountInUse>>, lists: readonly string[]) => {
    const binding = (JSON.parse(readFileSync(join(pc.fixture.stateDir, "account-pc.json"), "utf8")) as { binding: { bind_id: string } }).binding;
    writeFileSync(join(pc.fixture.stateDir, ACCOUNT_LIST_VOUCHES_FILE), JSON.stringify({ v: 1, server_id: pc.serverId, bind_id: binding.bind_id, lists: Object.fromEntries(lists.map((list) => [list, []])) }), { mode: 0o600 });
  };

  test("a person at the PC named another list: a device's naming does not take its place", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    expect(await pc.list.wantList("ab".repeat(32))).toMatchObject({ status: { want: "ab".repeat(32) } });
    expect(await names(await sessionOf(pc, pc.phone), { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) })).toEqual({ pinned: false, why: "named_here", wait: null });
  }, SLOW);

  test("a PC that tracks four lists already takes no fifth, and the lists it tracked go once it follows one", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    const others = ["a1", "b2", "c3", "d4"].map((two) => two.repeat(32));
    tracked(pc, others);
    const naming = async () => ({ naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) });
    expect(await names(await sessionOf(pc, pc.phone), await naming())).toEqual({ pinned: false, why: "lists_full", wait: null });
    tracked(pc, others.slice(0, 1));
    expect(await names(await sessionOf(pc, pc.phone), await naming())).toEqual({ pinned: true, list: born.id });
    const kept = JSON.parse(readFileSync(join(pc.fixture.stateDir, ACCOUNT_LIST_VOUCHES_FILE), "utf8")) as { lists: Record<string, unknown> };
    expect(Object.keys(kept.lists)).toEqual([born.id]);
  }, SLOW);

  test("one read of a named list each 30 seconds, and none that stops short of the head the service shows pins anything", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    // the service shows a head its log does not reach: the read never gets to it
    pc.service.tamperList(born.id, { reader: { server_id: pc.serverId }, head: { seq: born.head.seq + 3, hash: "ab".repeat(32) } });
    const body = { naming: await born.naming(pc.phone, pc.phone.signIn.key, pc.endpoint) };
    const before = pc.reads.log;
    expect(await names(await sessionOf(pc, pc.phone), body)).toEqual({ pinned: false, why: "not_read", wait: null });
    const once = pc.reads.log;
    expect(once).toBeGreaterThan(before);
    // asked again at once: no new read
    expect(await names(await sessionOf(pc, pc.phone), body)).toEqual({ pinned: false, why: "not_read", wait: null });
    expect(pc.reads.log).toBe(once);
    pc.service.untamperList(born.id);
    pc.time.advance(31_000);
    expect(await names(await sessionOf(pc, pc.phone), body)).toEqual({ pinned: true, list: born.id });
    expect(pc.reads.log).toBeGreaterThan(once);
  }, SLOW);

  test("on a staging run the wait the PC tells is in its own seconds, the factor taken back out", async () => {
    const pc = await accountInUse({ scale: 60 });
    const laptop = await migratingDevice("Laptop");
    signIn(pc.service, ACCOUNT, laptop);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, laptop.signIn.key))).toEqual({ ok: true });
    await pc.run(10 * 60_000);
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet, laptop]), pc.time.seconds);
    await pc.pull();
    const told = await names(await sessionOf(pc, laptop), { naming: await born.naming(laptop, laptop.signIn.key, pc.endpoint, "signIn") });
    // ten minutes by the record are ten hours at 60: a day is fourteen more, which is 14 minutes of this PC's own
    expect(told).toMatchObject({ pinned: false, why: "session_new" });
    expect((told as { wait: number }).wait).toBeGreaterThan(13 * 60);
    expect((told as { wait: number }).wait).toBeLessThanOrEqual(86_400 / 60);
  }, SLOW);

  test("the vouches go when the PC leaves its account, and at a reset of its relay identity", async () => {
    const pc = await accountInUse();
    const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
    await pc.pull();
    const again = await signedInAgain(pc.phone);
    signIn(pc.service, ACCOUNT, again);
    await pc.run(60_000);
    pc.time.advance(JOIN_HOLD_MS);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, again.signIn.key))).toEqual({ ok: true });
    await names(await sessionOf(pc, again), { naming: await born.naming(again, again.signIn.key, pc.endpoint), vouches: [await born.vouch(again)] });
    const file = join(pc.fixture.stateDir, ACCOUNT_LIST_VOUCHES_FILE);
    expect(existsSync(file)).toBe(true);
    pc.services.devices.revokeAll();
    pc.list.status();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "{}");
    forgetList(pc.fixture.stateDir);
    expect(existsSync(file)).toBe(false);
  }, SLOW);

  test("the WELCOME names the list only to a client that offered account-list-1, whatever else it offered", async () => {
    const pc = await followsByMove();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    const seen: Record<string, unknown>[] = [];
    link.onFrame = (frame) => { if (frame.type === FrameType.WELCOME) seen.push(frame.payload as unknown as Record<string, unknown>); };
    await link.hello([ACCOUNT_OPENS_ALL_FEATURE]);
    await link.flush();
    expect(seen.some((welcome) => "list" in welcome)).toBe(false);
  }, SLOW);

  test("the PC's witness answer counts against the caller's calls a minute, and an answer writes nothing the timer would not", async () => {
    const pc = await accountInUse();
    const phone = await sessionOf(pc, pc.phone);
    const file = join(pc.fixture.stateDir, ACCOUNT_WITNESS_FILE);
    const written = statSync(file).mtimeMs;
    const statuses: number[] = [];
    for (let call = 0; call < 31; call++) statuses.push((await ask(phone, "/api/account/list/witness")).status);
    expect([statuses.slice(0, 30).every((status) => status === 200), statuses[30]]).toEqual([true, 429]);
    expect(statSync(file).mtimeMs).toBe(written);
  }, SLOW);
});

describe("keys for a PC the list carried in as an endpoint", () => {
  test("a device that may add devices asks for the PC's card in its session, signs its pc entry and hands it over: the PC signs with its keys from then on", async () => {
    const pc = await followsByMove();
    // it follows the list and lets its devices in, and lets nobody in itself: it has no key of its own there, which is
    // not the case of a PC that joined by an invite, and says so, with what gives it one
    expect(pc.list.allowRefusal()).toBe("needs_keys");
    expect(pc.list.summary()).toMatchObject({ needs_keys: true });
    expect(pc.list.status().reason).toContain("ovis add");
    const phone = await sessionOf(pc, pc.phone, "member");
    const asked = await ask(phone, "/api/account/list/card", { method: "POST", body: {} });
    expect(asked.status).toBe(200);
    const card = asked.body as Card;
    expect([card.endpoint, card.list]).toEqual([pc.endpoint, pc.born.id]);
    // its keys are posted at the account service, the second lock of the entry that adds them
    expect(pc.service.accountList(ACCOUNT)!.posts.find((post) => post.endpoint === pc.endpoint)).toMatchObject({ key: card.key, enc: card.enc, card: card.card });
    const entry = await pc.born.append({ kind: "pc", key: card.key, endpoint: card.endpoint, enc: card.enc, card: card.card, sealed: null }, pc.phone.member);
    const handed = await pc.hand(phone, [entry]);
    expect([handed.status, (handed.body as { verdict: string }).verdict]).toEqual([200, "caught_up"]);
    expect(pc.list.allowRefusal()).toBeNull();
    expect(pc.list.status().reason).toBeNull();
    expect(pc.list.summary()).not.toHaveProperty("needs_keys");
    // once it holds its keys, nobody asks for its card again
    expect((await ask(phone, "/api/account/list/card", { method: "POST", body: {} })).status).toBe(409);
  }, SLOW);

  test("a pc entry with its keys that another device signed is no key it signs with, and one with another key at its relay key: it says so", async () => {
    const pc = await followsByMove();
    const phone = await sessionOf(pc, pc.phone, "member");
    const card = (await ask(phone, "/api/account/list/card", { method: "POST", body: {} })).body as Card;
    // the tablet, which did nothing for this PC, signs the entry the phone asked for
    const tablet = await sessionOf(pc, pc.tablet);
    const entry = await pc.born.append({ kind: "pc", key: card.key, endpoint: card.endpoint, enc: card.enc, card: card.card, sealed: null }, pc.tablet.signIn, "hold");
    expect((await pc.hand(tablet, [entry])).status).toBe(200);
    expect(pc.list.status().pcs).toBe(1);
    expect(pc.list.allowRefusal()).toBe("needs_keys");
    expect(pc.list.summary()).toMatchObject({ needs_keys: true });
    expect(pc.list.status().reason).toContain("ovis add");
    // its devices are let in all the same
    expect(await pc.signsIn(pc.phone, "member")).toBe("drive");
  }, SLOW);

  test("such a PC is added by ovis add, its keys from the adder the person confirms", async () => {
    const pc = await followsByMove();
    const phone = await sessionOf(pc, pc.phone, "member");
    const card = (await ask(phone, "/api/account/list/card", { method: "POST", body: {} })).body as Card;
    const entry = await pc.born.append({ kind: "pc", key: card.key, endpoint: card.endpoint, enc: card.enc, card: card.card, sealed: null }, pc.tablet.signIn, "hold");
    expect((await pc.hand(phone, [entry])).status).toBe(200);
    expect(pc.services.relay.setRelayAccount(ACCOUNT)).toBe(true);
    expect((await pc.local("/api/account/list/add", { account: ACCOUNT })).status).toBe(200);
  }, SLOW);

  test("the card counts against the caller's calls a minute", async () => {
    const pc = await followsByMove();
    const phone = await sessionOf(pc, pc.phone, "member");
    const statuses: number[] = [];
    for (let call = 0; call < 31; call++) statuses.push((await ask(phone, "/api/account/list/card", { method: "POST", body: {} })).status);
    // the account service bounds a PC's posts a minute too (503 then); this PC's own bound is the 31st call's 429
    expect([statuses[0], statuses.slice(0, 30).includes(429), statuses[30]]).toEqual([200, false, 429]);
  }, SLOW);

  test("the list holds another key at this PC's relay key: the PC follows its list, signs nothing, and says so", async () => {
    const pc = await followsByMove();
    const other = await migratingDevice("Other");
    const card = await signCard({ key: other.member.key, enc: other.enc, list: pc.born.id, endpoint: pc.endpoint, invite: null }, other.memberPair.privateKey);
    const phone = await sessionOf(pc, pc.phone, "member");
    const entry = await pc.born.append({ kind: "pc", key: other.member.key, endpoint: pc.endpoint, enc: other.enc, card, sealed: null }, pc.phone.member, "hold");
    expect((await pc.hand(phone, [entry])).status).toBe(200);
    expect(pc.list.allowRefusal()).toBe("not_signer");
    expect(pc.list.summary()).not.toHaveProperty("needs_keys");
    expect(pc.list.status().reason).toContain("another key");
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
  }, SLOW);

  test("who may ask for the card: a device the list holds with full power, to drive, over its own session", async () => {
    const pc = await followsByMove();
    const bound = await migratingDevice("Watch");
    const boundCard = await pc.born.claim(bound);
    await pc.born.append({ kind: "device", key: bound.member.key, power: "bound", role: "drive", until: null, enc: bound.enc, card: boundCard, sealed: null, rotates: false }, pc.phone.member);
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const asking = await sessionOf(pc, bound, "member");
    const refused = await ask(asking, "/api/account/list/card", { method: "POST", body: {} });
    expect([refused.status, (refused.body as { error: { code: string } }).error.code]).toEqual([403, "list_cannot_allow"]);
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.member);
    expect((await ask(member, "/api/account/list/card", { method: "POST", body: {} })).status).toBe(403);
    expect((await pc.local("/api/account/list/card", {})).status).toBe(403);
    // a PC that follows no list has no card to give for one
    const unpinned = await accountInUse();
    expect((await ask(await sessionOf(unpinned, unpinned.phone), "/api/account/list/card", { method: "POST", body: {} })).status).toBe(409);
  }, SLOW);

  test("with nobody's evidence, the number at the PC gives it its keys: ovis add on a PC that follows its list with no key of its own", async () => {
    const pc = await followsByMove();
    expect(pc.services.relay.setRelayAccount(ACCOUNT)).toBe(true);
    const started = await pc.local("/api/account/list/add", { account: ACCOUNT });
    expect(started).toMatchObject({ status: 200, body: { state: "waiting", list: pc.born.id } });
    const number = await pc.born.compare(pc.endpoint, pc.phone.member);
    await number.commit();
    expect((await pc.local("/api/account/list/add")).body).toMatchObject({ state: "waiting" });
    const digits = await number.reveal();
    expect((await pc.local("/api/account/list/add")).body).toMatchObject({ state: "number", digits });
    expect((await pc.local("/api/account/list/add/confirm", { digits })).body).toMatchObject({ state: "confirmed" });
    // the phone whose number the person confirmed signs the entry; until it is there the PC waits
    const post = pc.service.accountList(ACCOUNT)!.posts.find((one) => one.endpoint === pc.endpoint)!;
    await pc.born.append({ kind: "pc", key: post.key, endpoint: pc.endpoint, enc: post.enc, card: post.card, sealed: null }, pc.phone.member);
    expect((await pc.local("/api/account/list/add")).body).toMatchObject({ state: "added", list: pc.born.id });
    expect(pc.list.allowRefusal()).toBeNull();
  }, SLOW);

  test("a confirmed add for its keys whose entry never comes ends as a timeout at its ten minutes, never added: the PC still lets nobody in", async () => {
    const pc = await followsByMove();
    expect(pc.services.relay.setRelayAccount(ACCOUNT)).toBe(true);
    const started = await pc.local("/api/account/list/add", { account: ACCOUNT });
    expect(started).toMatchObject({ status: 200, body: { state: "waiting", list: pc.born.id } });
    const number = await pc.born.compare(pc.endpoint, pc.phone.member);
    await number.commit();
    await pc.local("/api/account/list/add");
    const digits = await number.reveal();
    expect((await pc.local("/api/account/list/add")).body).toMatchObject({ state: "number", digits });
    expect((await pc.local("/api/account/list/add/confirm", { digits })).body).toMatchObject({ state: "confirmed" });
    // the phone never signs the entry (its write failed, its person gave up); the add's ten minutes run out
    const real = performance.now.bind(performance);
    const later = spyOn(performance, "now").mockImplementation(() => real() + 11 * 60_000);
    let state: unknown;
    try { state = (await pc.local("/api/account/list/add")).body; } finally { later.mockRestore(); }
    expect(state).toMatchObject({ state: "ended", why: "timeout" });
    expect(pc.list.allowRefusal()).toBe("needs_keys");
    expect(pc.list.summary()).toMatchObject({ needs_keys: true });
  }, SLOW);

  test("a PC that follows its list with no key of its own and lost its copy lets nobody in, and says to run ovis add", async () => {
    const pc = await followsByMove();
    pc.fixture.app.stop();
    rmSync(join(pc.fixture.stateDir, ACCOUNT_LIST_FILE));
    const again = scaled(undefined, () => relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: pc.service.fetch } }));
    closes.push(() => again.app.stop());
    const { accountList, accountMailbox } = again.app.context.services;
    await accountMailbox.pull();
    await accountList!.settled();
    accountList!.tick();
    await accountList!.settled();
    expect(accountList!.status()).toMatchObject({ pinned: true, standing: "waiting" });
    expect(accountList!.summary()?.reason).toContain("ovis add");
    // and it lets no device of its account in meanwhile: the tablet's sign-in is refused, not lost
    expect(await signInOutcome(await relayConnection(again, { serverId: pc.serverId }), asSignIn(pc.serverId, pc.tablet))).toBeNull();
  }, SLOW);
});

/** The same PC, once the phone moved the account onto its list carrying the tablet in, and pinned to that list by a person at it. */
async function pinnedToBirth() {
  const pc = await accountInUse();
  const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
  await pc.pull();
  expect(await pc.list.wantList(born.id)).toMatchObject({ status: { pinned: false, want: born.id } });
  await born.addPostedPc(pc.endpoint, pc.phone.member);
  await pc.pull();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: born.id });
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  return { ...pc, born };
}

describe("after the pin, the rows the list makes", () => {
  test("a carried device that hands its place to its account key keeps its row on this PC: no removal, no hold, no notice", async () => {
    const pc = await pinnedToBirth();
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
    const before = pc.rowOf(pc.tablet.signIn.key)!;
    const published = spyOn(pc.services.devices, "publish");
    const announced = spyOn(pc.services.devices, "announceListAdmissions");
    const open = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await open.auth(asSignIn(pc.serverId, pc.tablet));
    await pc.born.handOver(pc.tablet);
    await pc.pull();
    // the session of the key it handed over ends as a row that changed under it, and it signs in with its account key
    expect(await bounded(open.serverError, 2000)).toBe("auth_changed");
    const after = pc.rowOf(pc.tablet.member.key);
    expect(after).toMatchObject({ id: accountDeviceId(pc.serverId, pc.tablet.member.key), no: before.no, label: before.label, origin: before.origin, state: "live", hold_until: null });
    expect(pc.rowOf(pc.tablet.signIn.key)).toBeNull();
    expect(await pc.signsIn(pc.tablet, "member")).toBe("drive");
    expect(await pc.signsIn(pc.tablet)).toBeNull();
    // a hand-over is no removal: nothing is kept against the key it ended, and nothing is owed
    expect(pc.services.devices.isTombstoned(pc.tablet.signIn.key)).toBe(false);
    expect(existsSync(join(pc.fixture.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(false);
    expect([published.mock.calls.length, announced.mock.calls.length]).toEqual([0, 0]);
  }, SLOW);

  test("a device the list removes after its hand-over is kept out here by every key it has been in by", async () => {
    const pc = await pinnedToBirth();
    await pc.born.handOver(pc.tablet);
    await pc.pull();
    await pc.born.remove(pc.tablet.member.key, pc.phone.member);
    await pc.pull();
    for (const key of [pc.tablet.member.key, pc.tablet.signIn.key]) expect(pc.services.devices.isTombstoned(key)).toBe(true);
  }, SLOW);

  test("a removal of a key the device handed over from that could not be kept is tried again, not skipped with the rest of its chain", async () => {
    const pc = await pinnedToBirth();
    await pc.born.handOver(pc.tablet);
    await pc.pull();
    const removeAccountKey = pc.services.devices.removeAccountKey.bind(pc.services.devices);
    let failed = false;
    const once = spyOn(pc.services.devices, "removeAccountKey").mockImplementation((key, ...rest) => {
      if (key === pc.tablet.signIn.key && !failed) { failed = true; throw new Error("disk full"); }
      return removeAccountKey(key, ...rest);
    });
    await pc.born.remove(pc.tablet.member.key, pc.phone.member);
    await pc.pull();
    expect([failed, pc.services.devices.isTombstoned(pc.tablet.member.key), pc.services.devices.isTombstoned(pc.tablet.signIn.key)]).toEqual([true, true, false]);
    await pc.settle();
    expect(pc.services.devices.isTombstoned(pc.tablet.signIn.key)).toBe(true);
    once.mockRestore();
  }, SLOW);

  test("a device this PC holds a removal against stays out by whichever of its keys it is in by", async () => {
    const pc = await pinnedToBirth();
    pc.services.devices.removeAccountKey(pc.tablet.signIn.key, ACCOUNT, { id: "a".repeat(32), issuedAt: new Date().toISOString() });
    await pc.pull();
    expect(await pc.signsIn(pc.tablet)).toBeNull();
    await pc.born.handOver(pc.tablet);
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.rowOf(pc.tablet.member.key)).toBeNull();
    expect(await pc.signsIn(pc.tablet, "member")).toBeNull();
    expect(pc.list.role(pc.tablet.member.key)).toBeNull();
  }, SLOW);

  test("a carried key that never handed over is let in only while the account's snapshot names it too", async () => {
    const pc = await pinnedToBirth();
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
    const open = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await open.auth(asSignIn(pc.serverId, pc.tablet));
    // the tablet's sign-in ends at the account service: the list still holds its key, and nobody signs a removal
    pc.service.removeDevice(ACCOUNT, pc.tablet.signIn.key);
    await pc.pull();
    expect(await bounded(open.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.tablet)).toBeNull();
    expect(pc.list.status().devices).toBe(2);
    expect(pc.services.devices.isTombstoned(pc.tablet.signIn.key)).toBe(false);
    // the phone, which handed over, is the list's alone
    expect(await pc.signsIn(pc.phone, "member")).toBe("drive");
    // local, and undone by the same word: the service names it again (as Step 2 lets a key in again after a wait)
    const registry = (pc.service as unknown as { registry(account: string): { devices: Map<string, { removed: boolean }>; version: number } }).registry(ACCOUNT);
    registry.devices.get(pc.tablet.signIn.key)!.removed = false;
    registry.version += 1;
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
  }, SLOW);

  test("after a restart such a key waits for the first whole read of the snapshot, and keeps its row: no new admission, no notice", async () => {
    const pc = await pinnedToBirth();
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
    const before = pc.rowOf(pc.tablet.signIn.key)!;
    pc.fixture.app.stop();
    const reach = { away: true };
    const again = scaled(undefined, () => relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: async (request: Request) => { if (reach.away) throw new Error("away"); return await pc.service.fetch(request); } } }));
    closes.push(() => again.app.stop());
    const { accountList, accountMailbox, accountRows, devices } = again.app.context.services;
    devices.useClock(pc.time.waits);
    const announced = spyOn(devices, "announceListAdmissions");
    await accountList!.settled();
    accountList!.tick();
    await accountList!.settled();
    const signsIn = async () => await signInOutcome(await relayConnection(again, { serverId: pc.serverId }), asSignIn(pc.serverId, pc.tablet));
    // the service is away: nothing says the tablet's sign-in still stands, so it waits, and its row stays
    expect(await signsIn()).toBeNull();
    expect(accountRows!.rows().find((row) => row.key === pc.tablet.signIn.key)).toMatchObject({ id: before.id, no: before.no });
    reach.away = false;
    await accountMailbox.pull();
    await accountList!.settled();
    expect(await signsIn()).toBe("drive");
    expect(accountRows!.rows().find((row) => row.key === pc.tablet.signIn.key)).toMatchObject({ id: before.id, origin: before.origin });
    expect(announced).not.toHaveBeenCalled();
  }, SLOW);
});
