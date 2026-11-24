/**
 * Independent adversarial review of PC step 7 (feat/account-list-pc-join at 8225ae9df, stacked on step 6 at
 * a4edfbb4b): the sequences behind the findings of review-pc-join-p7.md, and pins for guards found sound.
 *
 * Written as if it lived in server/account/ of the reviewed head. To run it there:
 *   cp review-pc-join-p7.tests.ts <head>/server/account/review-pc-join-p7.test.ts
 *   cd <head> && TMPDIR=<short dir> bun test server/account/review-pc-join-p7.test.ts
 *
 * Tests named "FINDING ..." fail on 8225ae9df and pass once the finding is fixed (on 8225ae9df: 5 fail). Tests named
 * "PIN ..." pass on 8225ae9df and hold a guard the step's own suite leaves unpinned: each names the mutant of the
 * report's table it kills (on 8225ae9df: 11 pass). The mutants are the report's, applied one at a time.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { deferred, relayAccountFixture, relayConnection, relayDevice, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ask, pairingPc, sendLink, signedInWith, vouchFor, type Body, type Pc } from "./pairing.test-helpers.ts";
import { listNamingOf } from "./records.ts";
import { listMember, TestList, type ListMember } from "./list.test-helpers.ts";
import { registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ACCOUNT_LIST_KEYS_FILE, ListKeyStore } from "./list-keys.ts";
import { newInvite, readJoinLine } from "../../shared/account-list-join.ts";
import { pinList, readSave, startRead, takePage, writeSave } from "../../shared/account-list-follower.ts";
import { ACCOUNT_LIST_FILE } from "./list-follow.ts";
import type { LineProof } from "../../shared/account-list-invite.ts";
import { ADD_POLL_MS, ListAdd } from "./list-add.ts";
import { cardBinding } from "../../shared/account-list.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";

const ACCOUNT = "acct_1";

const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

// ---------------------------------------------------------------------------------------------------------------------
// A PC pinned to its account's list (as server/account/list-pinned.contract.test.ts builds one)
// ---------------------------------------------------------------------------------------------------------------------

type Signer = { keys: CryptoKeyPair; publicKey: string; id: string };

function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  return { waits, advance(ms: number) { now += ms; waits.advance(ms); }, seconds: () => Math.floor(now / 1000) };
}

async function snapshotPc(options: { list?: boolean } = {}) {
  const time = testTime();
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  const accountService = { url: "https://account.test", fetch: (request: Request) => service.fetch(request) };
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, publicKey, "Laptop");
  expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const { services } = fixture.app.context;
  services.devices.useClock(time.waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const list = services.accountList!;
  const idOf = (one: ListMember): Signer => ({ keys: one.keys, publicKey: one.key, id: accountDeviceId(serverId, one.key) });
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  const signsIn = async (device: Signer): Promise<"drive" | "watch" | null> => {
    const link = await relayConnection(fixture, { serverId });
    return await link.auth(device).then((ok) => ok.role, () => null);
  };
  const laptop = await listMember(keys);
  const account = options.list === false ? null : await TestList.start(service, ACCOUNT, undefined, time.seconds);
  if (account !== null) { await account.addDevice(laptop); await pull(); }
  return { fixture, member, service, serverId, time, services, endpoint, list, account: account!, laptop, first: account?.first as ListMember, idOf, pull, signsIn, reader: { server_id: serverId } };
}

async function pinnedPc() {
  const pc = await snapshotPc();
  expect(await pc.list.wantList(pc.account.id)).toMatchObject({ status: { pinned: false, want: pc.account.id } });
  await pc.account.addPostedPc(pc.endpoint);
  await pc.pull();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: pc.account.id });
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  return pc;
}

describe("FINDING H1 (HIGH): the session routes' budget is kept per session, and one device fills its 64 places", () => {
  test("FINDING H1: a device that opens session after session takes the 64 counted places, and a member's removal handed over its own session is refused for that minute", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    // the account service withholds the laptop's removal from this PC: the session routes are how it reaches the PC
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const removal = await pc.account.remove(pc.laptop.key);
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    // the laptop opens one session after another (at most 4 at once, as the relay allows); each asks once and closes.
    // (As fixed, the PC counts the laptop's calls by its key: past 30 in the minute they are refused, whatever session)
    const answered: number[] = [];
    for (let index = 0; index < 64; index++) {
      const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
      await link.auth(pc.idOf(pc.laptop));
      answered.push((await ask(link, "/api/account/list/head", { method: "POST", body: { list: pc.account.id, place: held } })).status);
      link.channel.close();
    }
    expect(answered.filter((status) => status === 200)).toHaveLength(30);
    expect(answered.filter((status) => status !== 200).every((status) => status === 429)).toBe(true);
    // a member that holds the removal opens its first session of the minute and hands it over
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.idOf(pc.first));
    const handed = await ask(member, "/api/account/list/page", { method: "POST", body: { list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place } });
    // E6 bounds each session to 30 calls a minute; nothing there lets one device shut every other session out
    expect([handed.status, handed.body.error?.code ?? handed.body.verdict]).toEqual([200, "caught_up"]);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// A PC in no account that is added by the list (as server/account/list-join.contract.test.ts builds one)
// ---------------------------------------------------------------------------------------------------------------------

const TOKEN = "review-p7-token";
const own = { authorization: `Bearer ${TOKEN}` };
type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;
const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function joinPc() {
  const hook: { on: Hook | null } = { on: null };
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN, accountListAddPollMs: 0 }, startRelay: false,
    accountFetch: (request, service) => hook.on ? hook.on(request, () => service.fetch(request)) : service.fetch(request) });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  made.account.completions = true;
  pcs.push(made);
  const post = (path: string, body: unknown = {}, header = "x-herdr-machine") => made.local(path, { method: "POST", headers: { ...own, [header]: "1" }, body });
  if ((await post("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  const { services } = made.app.context;
  const identity = services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  if ((await post("/api/account/relay-account", { account: ACCOUNT })).status !== 204) throw new Error("The account was not named");
  const directory = (account: string, path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method,
    headers: { authorization: `Bearer ${made.account.issueToken(account, { twoStep: true })}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" } : {}) }));
  if (!(await directory(ACCOUNT, `/v1/pcs/${identity.server_id}`, "PUT")).ok) throw new Error("The PC was not listed");
  return {
    pc: made, services, serverId: identity.server_id, endpoint, hook, post,
    admit: async () => { if (!(await directory(ACCOUNT, `/v1/pcs/${identity.server_id}/admit`, "POST")).ok) throw new Error("The PC was not admitted"); },
    start: () => post("/api/account/list/add", { account: ACCOUNT }),
    state: async () => (await made.local("/api/account/list/add", { headers: own })).body,
    confirm: async (digits: unknown) => post("/api/account/list/add/confirm", { digits }),
    cancel: async () => post("/api/account/list/add/cancel", {}),
    binding: () => (JSON.parse(readFileSync(join(made.stateDir, "account-pc.json"), "utf8")) as { binding: Record<string, unknown> | null }).binding,
  };
}
type Joining = Awaited<ReturnType<typeof joinPc>>;

async function compared(made: Joining, account: TestList, adder = account.first): Promise<{ phone: string; shown: Body }> {
  const number = await account.compare(made.endpoint, adder);
  await number.commit();
  expect(await made.state()).toMatchObject({ state: "waiting" });
  const phone = await number.reveal();
  if (phone === null) throw new Error("The PC did not answer the commitment");
  return { phone, shown: await made.state() };
}

/** The device of the account that scans the PC's QR code: it pairs with the code made for the account (as list-join.contract.test.ts). */
async function scanned(made: Joining, device: ListMember, options: { vouch?: boolean } = {}) {
  const code = made.pc.devices.startAccountPairing(ACCOUNT).code;
  const key = { keys: device.keys, spki: device.key };
  if (options.vouch !== false) await vouchFor(made.pc, ACCOUNT, key);
  const paired = await signedInWith(made.pc, code, key, { serverId: made.serverId });
  return {
    ...paired,
    names: (list: string) => ask(paired.session, "/api/account/list/named", { method: "POST", body: { account: ACCOUNT, list } }),
    links: async () => sendLink(paired.session, await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: device.key, server_id: made.serverId, device_id: paired.id,
      old_key: device.key, issued_at: new Date().toISOString(), id: newRecordId(), signer: device.key }, device.keys.privateKey)),
  };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) { if (performance.now() > deadline) throw new Error(what); await Bun.sleep(5); }
}

describe("FINDING L1 (LOW): a confirmed add that finds the PC bound meanwhile goes by wantList, not by B7's rules", () => {
  test("FINDING L1: the PC joined its account on the service's word while the confirmed add ran: an entry another member signed pins it, and the add says added", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const other = await listMember();
    await account.addDevice(other);
    await made.start();
    const { phone } = await compared(made, account);
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    // a device's link (an app that links instead of naming the list, which docs/account.md keeps) brings the PC into
    // its account meanwhile: the binding stands on the service's word
    made.pc.devices.bindByService(ACCOUNT);
    // another member, not the device whose number the person confirmed, adds the PC from its posted card
    await made.admit();
    await account.addPostedPc(made.endpoint, other);
    // B7 step 7: the PC takes the entry only when it is signed by the adder of the attempt the person confirmed
    expect(await made.state()).not.toMatchObject({ state: "added" });
    expect(made.services.accountList!.status()).toMatchObject({ pinned: false });
  });

  test("FINDING L1: on such a PC the person's No leaves the list wanted, on disk, after the add ended", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    made.pc.devices.bindByService(ACCOUNT);
    // the next poll of the confirmed add names the list on the bound PC (wantList)
    expect(await made.state()).toMatchObject({ state: "confirmed" });
    // the person says No at the PC: the add ends, and with it what the add wanted (B7: "the want ends with the Add")
    expect((await made.cancel()).body).toMatchObject({ state: "ended", why: "cancelled" });
    expect(made.services.accountList!.status()).toMatchObject({ want: null });
  });
});

describe("FINDING L2 and L3 (LOW): a PC that follows no list now does what step 6 did not", () => {
  test("FINDING L2: `ovis add` toward an account with no list makes this PC's list keys, which only a PC that joins a list needs", async () => {
    const made = await joinPc();
    // the account keeps no list: the add by the list says so, and ovis add goes on to one press
    expect((await made.start()).body).toEqual({ state: "no_list", account: ACCOUNT });
    expect(existsSync(join(made.pc.stateDir, ACCOUNT_LIST_KEYS_FILE))).toBe(false);
  });

  test("FINDING L3: on a PC that follows no list, a device that only watches is answered 404 on the two session routes, where step 6 answers 403", async () => {
    const pc = await snapshotPc({ list: false });
    const watching = await relayDevice(pc.fixture, "watch");
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await link.auth(watching);
    const answer = await ask(link, "/api/account/list/head", { method: "POST", body: { list: "ab".repeat(32), place: null } });
    // step 6 (a4edfbb4b) refuses a watching device's POST here before any route: 403 read_only
    expect([answer.status, answer.body.error?.code]).toEqual([403, "read_only"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pins: guards of the step found sound, which the step's own suite does not hold (see the report's mutant table)
// ---------------------------------------------------------------------------------------------------------------------

// ListAdd alone, against an account service that only carries the four messages (as server/account/list-add.test.ts)
const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
const SERVER = "0123456789abcdef0123456789abcdef";
const ENDPOINT = "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f";
interface Open { adder: string; commitment: string; nonce: string | null; reveal: string | null }

async function adding() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-review-add-"));
  closes.push(() => rmSync(dir, { recursive: true, force: true }));
  const keys = await new ListKeyStore(dir).keysFor(SERVER);
  const phone = await listMember();
  const binding = cardBinding({ key: keys.key, enc: keys.enc, list: LIST, endpoint: ENDPOINT, invite: null });
  const world = { now: 1_800_000_000_000, serverId: SERVER, open: null as Open | null, joins: 0, nonces: 0, gate: null as Promise<void> | null, held: 0 };
  const add = new ListAdd({
    own: async () => ({ serverId: world.serverId, endpoint: ENDPOINT, keys }),
    listNamed: async () => LIST,
    call: async (path, body) => {
      // what the account service holds when it is asked: an answer that is slow on its way carries no later message
      const held = world.open;
      if (world.gate !== null) { world.held++; await world.gate; }
      if (path === "/v2/pc/list/keys") return {};
      if (body.nonce === undefined) return { attempt: held };
      world.nonces++;
      world.open = { ...world.open!, nonce: body.nonce as string };
      return { attempt: world.open };
    },
    join: async () => { world.joins++; return { waiting: "waiting" }; },
    now: () => world.now, mono: () => world.now,
  });
  const next = async () => { world.now += ADD_POLL_MS; return await add.state(); };
  const number = async (): Promise<string> => {
    const nonce = randomPairNonce();
    world.open = { adder: phone.key, commitment: toBase64Url(pairCommitment(binding, phone.key, nonce)), nonce: null, reveal: null };
    await next();
    world.open = { ...world.open, reveal: toBase64Url(nonce) };
    const digits = pairDigits(binding, phone.key, nonce, fromBase64Url(world.open.nonce!));
    expect(await next()).toMatchObject({ state: "number", digits });
    return digits;
  };
  /** The phone opens an attempt with a fresh commitment. */
  const commits = () => {
    const nonce = randomPairNonce();
    world.open = { adder: phone.key, commitment: toBase64Url(pairCommitment(binding, phone.key, nonce)), nonce: null, reveal: null };
  };
  return { add, world, next, number, commits };
}

describe("PIN: guards of step 7 found sound", () => {
  test("PIN (kills A1: start's look at the relay identity of the run under way): after a relay identity reset, ovis add starts a new add for the new PC", async () => {
    const { add, world } = await adding();
    await add.start(ACCOUNT);
    world.serverId = "f".repeat(32);
    world.now += ADD_POLL_MS;
    expect(await add.start(ACCOUNT)).toMatchObject({ state: "waiting", account: ACCOUNT });
  });

  test("PIN (kills A7: step's look at the No's mark): a poll that waited behind the No answers no commitment and shows no number", async () => {
    const { add, world, commits } = await adding();
    await add.start(ACCOUNT);
    // a poll is out at the account service; a second poll waits for its turn behind it
    let open!: () => void;
    world.gate = new Promise((resolve) => { open = resolve; });
    world.now += ADD_POLL_MS;
    const out = add.state();
    await until(() => world.held > 0, "The first poll did not reach the account service");
    world.now += ADD_POLL_MS;
    const waiting = add.state();
    // the person says No at the PC, and the phone opens an attempt meanwhile
    const no = add.cancel();
    commits();
    world.gate = null;
    open();
    await out;
    expect(await waiting).toMatchObject({ state: "ended", why: "cancelled" });
    expect(await no).toMatchObject({ state: "ended", why: "cancelled" });
    expect(world.nonces).toBe(0);
  });

  test("PIN (kills F2: joining's look that the list holds the line's invite): a line whose invite the list does not hold joins nothing, whoever then adds the PC", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // a line for this account and list whose invite no member placed: its proof holds, the list knows nothing of it
    const line = await readJoinLine((await newInvite("https://account.test", ACCOUNT, account.id)).line, { service: "https://account.test", followsLists: true });
    // this branch's fake account service predates the two members the PC adds to its post: passed on without them
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/keys") return await forward();
      const { invite: _invite, invite_proof: _proof, ...rest } = await request.json() as Record<string, unknown>;
      return await made.pc.account.fetch(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(rest) }));
    };
    const named = { account: ACCOUNT, list: account.id, invite: line.key };
    const { card } = (await made.post("/api/account/list/join", named)).body as unknown as { card: LineProof["card"] };
    const proof = await line.signLineProof({ server_id: made.serverId, card });
    expect((await made.post("/api/account/list/join", { ...named, proof })).body).toMatchObject({ state: "waiting" });
    // a member adds the PC from the card it posted
    await made.admit();
    await account.addPostedPc(made.endpoint);
    const refused = await made.post("/api/account/list/join", { ...named, proof });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "invite_unknown"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("PIN (kills F24: the loser of a same-folder join goes by the winner's binding and copy): a removal the winner read stays in the copy on disk", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    // a device comes in and is put out again; the account service shows this server the list up to the device only
    const device = await listMember();
    await account.addDevice(device);
    const shown = made.pc.account.accountList(ACCOUNT)!.head.seq;
    await account.remove(device.key);
    made.pc.account.tamperList(account.id, { reader: { server_id: made.serverId }, withholdAfter: shown });
    // the other Ovis on this folder read the whole list, removal included, and bound the PC while this server read
    const winner = "ab".repeat(16);
    const pcPath = join(made.pc.stateDir, "account-pc.json");
    const listPath = join(made.pc.stateDir, ACCOUNT_LIST_FILE);
    let written = false;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list/log" && !written) {
        written = true;
        const disk = JSON.parse(readFileSync(pcPath, "utf8")) as { gen: number };
        writeFileSync(pcPath, JSON.stringify({ ...disk, v: 2, gen: disk.gen + 1, binding: { account: ACCOUNT, bind_id: winner, list: account.id } }));
        const keys = await new ListKeyStore(made.pc.stateDir).keysFor(made.serverId);
        const first = pinList(null, { account: ACCOUNT, list: account.id, me: { key: keys.key, endpoint: made.endpoint }, pin: { how: "added" } });
        if (!first.pinned) throw new Error("The copy could not be started");
        const held = made.pc.account.accountList(ACCOUNT)!;
        const taken = await takePage(first.copy, startRead(first.copy, "service"), { list: account.id, after: null, entries: held.entries, head: held.head }, Math.floor(Date.now() / 1000));
        writeFileSync(listPath, JSON.stringify({ v: 1, server_id: made.serverId, bind_id: winner, want: null, save: writeSave(taken.copy) }));
      }
      return await forward();
    };
    expect((await made.confirm(phone)).body).toMatchObject({ state: "added" });
    expect(made.binding()).toMatchObject({ bind_id: winner });
    const file = JSON.parse(readFileSync(listPath, "utf8")) as { bind_id: string; save: string };
    const saved = await readSave(file.save);
    expect(saved.read && saved.copy.state?.footing.seq).toBe(shown + 1);
  });

  test("PIN (kills R5: the add route's look at the PC's account): a PC already in an account starts no add by the list", async () => {
    const made = await joinPc();
    await TestList.start(made.pc.account, ACCOUNT);
    made.pc.devices.bindByService(ACCOUNT);
    const refused = await made.start();
    expect([refused.status, refused.body.error?.code]).toEqual([409, "in_account"]);
    expect((await made.state())).toMatchObject({ state: "none" });
  });

  test("PIN (kills R6: the add route's look at a removal by the list): a PC its account's list removed posts no card and shows no number", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.confirm(phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    // the list removes the PC, and the PC reads it
    await account.remove(made.pc.account.accountList(ACCOUNT)!.state.pcs[made.endpoint]!.key!);
    await made.services.accountMailbox.pull();
    await made.services.accountList!.settled();
    expect(made.pc.devices.account()).toBeNull();
    expect(made.pc.devices.listRemovedFrom(ACCOUNT)).toBe(true);
    const posts = made.pc.account.accountList(ACCOUNT)!.posts.length;
    const refused = await made.start();
    expect([refused.status, refused.body.error?.code]).toEqual([409, "list_removed"]);
    expect(made.pc.account.accountList(ACCOUNT)!.posts.length).toBe(posts);
  });

  test("PIN (kills C1 and C5 together, each masks the other: listNamedBy's looks that the row waits to link): a device this PC paired itself, which its account vouches for, names no list", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const key = { keys: account.first.keys, spki: account.first.key };
    await vouchFor(made.pc, ACCOUNT, key);
    // paired with a code of this PC's own, as `ovis pair` makes one: a device, not a row that waits to link
    const { code } = made.pc.devices.startPairing();
    const paired = await signedInWith(made.pc, code, key, { serverId: made.serverId });
    const refused = await ask(paired.session, "/api/account/list/named", { method: "POST", body: { account: ACCOUNT, list: account.id } });
    expect([refused.status, refused.body.error?.code]).toEqual([403, "link_required"]);
    expect(made.pc.account.accountList(ACCOUNT)!.posts).toEqual([]);
  });

  test("PIN (kills C4: a naming the account service did not confirm is no naming): asked again, it is judged afresh, never taken as confirmed", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // a device the account does not vouch for; the account service is away when it first names the list
    const clock = new TestClock();
    made.pc.devices.useClock(clock);
    const phone = await scanned(made, account.first, { vouch: false });
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/mailbox" ? new Response("away", { status: 503 }) : await forward();
    const first = await phone.names(account.id);
    expect([first.status, first.body.error?.code]).toEqual([503, "account_unavailable"]);
    made.hook.on = null;
    clock.advance(made.services.accountMailbox.serviceRetryMs());
    const again = await phone.names(account.id);
    expect(again.body.state).not.toBe("waiting");
    expect(made.pc.account.accountList(ACCOUNT)!.posts).toEqual([]);
  });

  test("PIN (kills C8: applyLink's look at a naming after the account's word): a naming that lands while the row's link waits for the vouch closes that link", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const clock = new TestClock();
    made.pc.devices.useClock(clock);
    const phone = await scanned(made, account.first);
    clock.advance(made.services.accountMailbox.serviceRetryMs());
    const held = deferred<void>();
    let asked = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v1/pc/mailbox" && asked++ === 0) await held.promise;
      return await forward();
    };
    const linking = phone.links();
    await until(() => asked > 0, "The link did not ask the account service");
    const naming = phone.names(account.id);
    await until(() => listNamingOf(made.pc.devices, phone.id) !== undefined, "The naming did not arrive");
    held.resolve();
    const linked = await linking;
    // the naming's own word is read in the next read, which the PC starts once it may
    await until(() => made.services.accountMailbox.serviceRetryMs() > 0, "The first read did not end");
    clock.advance(made.services.accountMailbox.serviceRetryMs());
    expect([linked.status, linked.body.error?.code]).toEqual([409, "list_named"]);
    expect((await naming).body.state).toBe("waiting");
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("PIN (kills V1: the reset's first ask, before anything is closed): a re-add reset for another identity leaves this PC's pairing code standing", async () => {
    const made = await joinPc();
    made.pc.devices.startAccountPairing(ACCOUNT);
    expect(made.pc.devices.pinnedCode()).not.toBeNull();
    const base = `http://127.0.0.1:${made.pc.app.port}`;
    const refused = await fetch(`${base}/api/relay/reset-identity`, { method: "POST", headers: { ...own, origin: base, "content-type": "application/json", "x-herdr-update": "1" },
      body: JSON.stringify({ removed: { account: ACCOUNT, server_id: "f".repeat(32) } }) });
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([409, "identity_changed"]);
    // a reset that was not asked for begins nothing: the code a device may be pairing with right now still stands
    expect(made.pc.devices.pinnedCode()).not.toBeNull();
  });

  test("PIN (kills F3: joining's look at 'still in no account, the same PC' after the read): a relay identity reset while the confirmed add reads the list binds nothing", async () => {
    const made = await joinPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    // the person at this PC resets its relay identity while the add reads the list: the PC it was is gone
    let reset = false;
    made.hook.on = async (request, forward) => {
      if (!reset && new URL(request.url).pathname === "/v2/pc/list/log") { reset = true; await made.services.relay.resetIdentity(); }
      return await forward();
    };
    await made.confirm(phone);
    expect(reset).toBe(true);
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });
});
