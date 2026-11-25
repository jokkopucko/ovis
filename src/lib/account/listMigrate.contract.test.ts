/**
 * The app's side of moving an account that was in use onto its list, against a real PC (docs/account-list.md, "In the
 * app"): the app asks the PC what it lets in over a session of its sign-in key (GET /api/account/list/witness), moves
 * the account with that answer, and names the list it made in that session (POST /api/account/list/name); the PC
 * follows it. The account service is the fake both share, in memory.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { JOIN_HOLD_MS } from "../../../server/account/join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "../../../server/account/listed-pc.test-helpers.ts";
import { ask } from "../../../server/account/pairing.test-helpers.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, TestClock } from "../../../server/relay/test-helpers.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { accountList } from "./accountList.ts";
import { handListToPc } from "./join.ts";
import { keysForCarriedPc } from "./listCarriedPc.ts";
import { addPostedPc, numberWith, postedPcs } from "./listAdd.ts";
import { listNames } from "./listGenesis.ts";
import { postedFor } from "./listPcs.ts";
import { addByList } from "./addThisPc.ts";
import { confirmListAdd, fetchListAdd } from "../api.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { ListAddState } from "../../../shared/machines.ts";
import { link } from "../../../scripts/plugin-link.ts";
import { claimKey, listMember } from "../../../server/account/list.test-helpers.ts";
import { askWitness, onPcSession, pcAnswers } from "./listMigrate.ts";
import { memoryListLock, memoryListStore } from "./listStore.ts";
import { AccountService } from "./service.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountSession } from "./store.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

const DAY_MS = 86_400_000;
const READ_EVERY_MS = 30 * 60_000;

/** A Storage in memory, where a device keeps its record of its PCs. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return { get length() { return items.size; }, clear: () => items.clear(), getItem: (key) => items.get(key) ?? null, key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); }, setItem: (key, value) => { items.set(key, String(value)); } };
}

/** The app's side of one device: its stores, its sign-in, and its list with this run's answers and its record of the PC. */
async function appDevice(service: FakeAccountService, label: string, now: number, endpoint: string) {
  const store = memoryAccountStore();
  const token = service.issueToken(ACCOUNT, { twoStep: true });
  const signInId = `sign-in-${label}`;
  const session: AccountSession = { service: "https://account.test", account: ACCOUNT, provider: "github", access_token: token, refresh_token: "r", expires_at: now + 30 * DAY_MS, sign_in_id: signInId, signed_in_at: now };
  await store.set("session", session);
  const signIn = await newKey();
  await store.set("signin_key", { account: ACCOUNT, sign_in_id: signInId, key: signIn, no: service.registerSessionKey(token, signIn.public_spki, label) });
  const answers = pcAnswers();
  const storage = memoryStorage();
  const at = Math.floor(now / 1000) - 40 * 86_400;
  storage.setItem(`ovis:seen-pcs:${ACCOUNT}`, JSON.stringify({ v: 1, account: ACCOUNT, pcs: { [endpoint]: { since: at, last: at, how: "paired" } } }));
  const list = accountList({
    service: new AccountService({ store, fetch: (input, init) => service.fetch(new Request(input, init)), lock: memoryLock() }), accountStore: store, listStore: memoryListStore(), lock: memoryListLock(),
    names: () => ({ label, os: "ios" }), linkedPcs: async () => 1, genesis: () => "first-device", durable: async () => true, migration: { answers, storage },
  });
  return { store, signIn, answers, list, member: async () => (await store.key()).public_spki };
}

test("the app asks a real PC what it lets in, moves the account onto its list, and names the list there: the PC follows it", async () => {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  const advance = (ms: number): void => { now += ms; waits.advance(ms); };
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  service.listMigrateAccounts = ACCOUNT;
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  services.devices.useClock(waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));

  // the phone as the app holds it: an own sign-in of the account and the key it registered
  const store = memoryAccountStore();
  const token = service.issueToken(ACCOUNT, { twoStep: true });
  const session: AccountSession = { service: "https://account.test", account: ACCOUNT, provider: "github", access_token: token, refresh_token: "r", expires_at: now + 30 * DAY_MS, sign_in_id: "phone", signed_in_at: now };
  await store.set("session", session);
  const signIn = await newKey();
  await store.set("signin_key", { account: ACCOUNT, sign_in_id: "phone", key: signIn, no: service.registerSessionKey(token, signIn.public_spki, "Phone") });

  // the PC lets that key in through the account, for a day and more by both of its clocks
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  advance(JOIN_HOLD_MS + 1_000);
  // its row is out of the join hold: the PC lets the key in
  expect(services.accountRows!.access(accountDeviceId(serverId, signIn.public_spki))).toEqual({ ok: true });
  services.accountWitness!.step();
  for (let left = DAY_MS + 60_000; left > 0; left -= READ_EVERY_MS) {
    advance(Math.min(left, READ_EVERY_MS));
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    services.accountWitness!.step();
  }

  // a session of the phone's sign-in key, as the app opens a PC through the account, and its requests as the app makes them
  const link = await relayConnection(fixture, { serverId });
  await link.auth({ id: accountDeviceId(serverId, signIn.public_spki), keys: { privateKey: signIn.private_key } as CryptoKeyPair, publicKey: signIn.public_spki });
  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET") as "GET" | "POST";
    const answer = await ask(link, path, { method, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  const said = await askWitness(fetch);
  expect(said).toMatchObject({ account: ACCOUNT, pinned: null });
  const row = said!.admits.find((one) => one.key === signIn.public_spki);
  expect(row!.wall).toBeGreaterThanOrEqual(86_400);
  expect(row!.ran).toBeGreaterThanOrEqual(21_600);

  // the app moves the account, with that answer and its own record of the PC
  const answers = pcAnswers();
  answers.set(ACCOUNT, endpoint, said);
  const storage = memoryStorage();
  const at = Math.floor(now / 1000) - 40 * 86_400;
  storage.setItem(`ovis:seen-pcs:${ACCOUNT}`, JSON.stringify({ v: 1, account: ACCOUNT, pcs: { [endpoint]: { since: at, last: at, how: "paired" } } }));
  const list = accountList({
    service: new AccountService({ store, fetch: (input, init) => service.fetch(new Request(input, init)), lock: memoryLock() }), accountStore: store, listStore: memoryListStore(), lock: memoryListLock(),
    names: () => ({ label: "Phone", os: "ios" }), linkedPcs: async () => 1, genesis: () => "first-device", durable: async () => true, migration: { answers, storage },
  });
  const view = await list.sync();
  expect(view.status).toMatchObject({ at: "following", standing: "in" });
  const born = service.accountList(ACCOUNT)!;

  // in the same session, the app names the list it made: the PC follows it once its answer is out
  await onPcSession({ list, answers, account: ACCOUNT, fetch, endpoint, pinned: false, session: signIn.public_spki, signIn: signIn.public_spki });
  for (let round = 0; round < 50 && services.accountList!.status().pinned !== true; round += 1) {
    advance(100);
    services.accountList!.tick();
    await services.accountList!.settled();
  }
  expect(services.accountList!.status()).toMatchObject({ pinned: true, list: born.id });
}, 30_000);

test("a device the move carried in asks the PC that follows the list, joins it, hands its place on, and the PC lets it in by its account key", async () => {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  const advance = (ms: number): void => { now += ms; waits.advance(ms); };
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  service.listMigrateAccounts = ACCOUNT;
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  services.devices.useClock(waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const phone = await appDevice(service, "Phone", now, endpoint);
  const laptop = await appDevice(service, "Laptop", now, endpoint);

  // the PC lets both sign-in keys in through the account for a day and more
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  advance(JOIN_HOLD_MS + 1_000);
  for (const device of [phone, laptop]) expect(services.accountRows!.access(accountDeviceId(serverId, device.signIn.public_spki))).toEqual({ ok: true });
  services.accountWitness!.step();
  for (let left = DAY_MS + 60_000; left > 0; left -= READ_EVERY_MS) {
    advance(Math.min(left, READ_EVERY_MS));
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    services.accountWitness!.step();
  }
  /** A session of `key` at the PC, and the app's requests over it. */
  const sessionOf = async (key: { private_key: CryptoKey; public_spki: string }) => {
    const link = await relayConnection(fixture, { serverId });
    await link.auth({ id: accountDeviceId(serverId, key.public_spki), keys: { privateKey: key.private_key } as CryptoKeyPair, publicKey: key.public_spki });
    return async (path: string, init?: RequestInit): Promise<Response> => {
      const answer = await ask(link, path, { method: (init?.method ?? "GET") as "GET" | "POST", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    };
  };

  // the phone asks, moves the account carrying the laptop and the PC in, and names the list at the PC, which follows it
  const phoneFetch = await sessionOf(phone.signIn);
  phone.answers.set(ACCOUNT, endpoint, await askWitness(phoneFetch));
  expect((await phone.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  const born = service.accountList(ACCOUNT)!;
  await onPcSession({ list: phone.list, answers: phone.answers, account: ACCOUNT, fetch: phoneFetch, endpoint, pinned: false, session: phone.signIn.public_spki, signIn: phone.signIn.public_spki });
  for (let round = 0; round < 50 && services.accountList!.status().pinned !== true; round += 1) { advance(100); services.accountList!.tick(); await services.accountList!.settled(); }
  expect(services.accountList!.status()).toMatchObject({ pinned: true, list: born.id });

  // the laptop asks the PC, which says it follows this very list: the laptop joins, and hands its place to its account key
  advance(JOIN_HOLD_MS + 1_000);
  const said = await askWitness(await sessionOf(laptop.signIn));
  expect(said).toMatchObject({ account: ACCOUNT, pinned: born.id });
  laptop.answers.set(ACCOUNT, endpoint, said);
  expect((await laptop.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  const member = await laptop.member();
  expect(service.accountList(ACCOUNT)!.state.devices[member]).toBeDefined();

  // the PC reads the hand-over and lets the laptop in by its account key, as the same device
  await services.accountMailbox.pull();
  await services.accountList!.settled();
  services.accountList!.tick();
  await services.accountList!.settled();
  advance(JOIN_HOLD_MS + 1_000);
  expect(services.accountRows!.access(accountDeviceId(serverId, member))).toEqual({ ok: true });
}, 30_000);

test("the device that paired with a PC the move carried in with no key gives it its keys over the session: the PC can allow devices", async () => {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  const advance = (ms: number): void => { now += ms; waits.advance(ms); };
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  service.listMigrateAccounts = ACCOUNT;
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  services.devices.useClock(waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const phone = await appDevice(service, "Phone", now, endpoint);
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  advance(JOIN_HOLD_MS + 1_000);
  expect(services.accountRows!.access(accountDeviceId(serverId, phone.signIn.public_spki))).toEqual({ ok: true });
  services.accountWitness!.step();
  for (let left = DAY_MS + 60_000; left > 0; left -= READ_EVERY_MS) {
    advance(Math.min(left, READ_EVERY_MS));
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    services.accountWitness!.step();
  }
  const sessionOf = async (key: { private_key: CryptoKey; public_spki: string }) => {
    const link = await relayConnection(fixture, { serverId });
    await link.auth({ id: accountDeviceId(serverId, key.public_spki), keys: { privateKey: key.private_key } as CryptoKeyPair, publicKey: key.public_spki });
    return async (path: string, init?: RequestInit): Promise<Response> => {
      const answer = await ask(link, path, { method: (init?.method ?? "GET") as "GET" | "POST", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    };
  };
  const signInFetch = await sessionOf(phone.signIn);
  phone.answers.set(ACCOUNT, endpoint, await askWitness(signInFetch));
  expect((await phone.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  await onPcSession({ list: phone.list, answers: phone.answers, account: ACCOUNT, fetch: signInFetch, endpoint, pinned: false, session: phone.signIn.public_spki, signIn: phone.signIn.public_spki });
  for (let round = 0; round < 50 && services.accountList!.status().pinned !== true; round += 1) { advance(100); services.accountList!.tick(); await services.accountList!.settled(); }
  const born = service.accountList(ACCOUNT)!;
  expect(services.accountList!.status()).toMatchObject({ pinned: true, list: born.id });
  expect(born.state.pcs[endpoint]).toMatchObject({ how: "carried", key: null });

  // the phone comes back with the key the list holds for it, and the PC is one it paired with: it gives the PC its keys
  advance(JOIN_HOLD_MS + 1_000);
  const memberKey = await phone.store.key();
  const memberFetch = await sessionOf(memberKey);
  const record = { v: 1 as const, account: ACCOUNT, pcs: { [endpoint]: { since: 1, last: 2, how: "paired" as const } } };
  expect(await keysForCarriedPc({ list: phone.list, fetch: memberFetch, account: ACCOUNT, endpoint, record, names: { label: "Desk", os: null } })).toBe("added");
  expect(await handListToPc(memberFetch, phone.list)).toBe(true);
  const held = service.accountList(ACCOUNT)!;
  expect(held.state.pcs[endpoint]?.key).not.toBeNull();
  await services.accountList!.settled();
  expect(services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
}, 30_000);

/**
 * A PC the move carried in with no key gets its keys by the number on a member device, whatever that device did for it:
 * its add by the list is started `by` ovis add at it, or by its own window's button (addByList, the window's own call),
 * and the number is confirmed there. Then it allows a device.
 */
async function carriedPcGetsKeys(by: "ovis add" | "window"): Promise<void> {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  const advance = (ms: number): void => { now += ms; waits.advance(ms); };
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  service.listMigrateAccounts = ACCOUNT;
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountListAddPollMs: 0, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  services.devices.useClock(waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const phone = await appDevice(service, "Phone", now, endpoint);
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  advance(JOIN_HOLD_MS + 1_000);
  expect(services.accountRows!.access(accountDeviceId(serverId, phone.signIn.public_spki))).toEqual({ ok: true });
  services.accountWitness!.step();
  for (let left = DAY_MS + 60_000; left > 0; left -= READ_EVERY_MS) {
    advance(Math.min(left, READ_EVERY_MS));
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    services.accountWitness!.step();
  }
  const sessionOf = async (key: { private_key: CryptoKey; public_spki: string }) => {
    const link = await relayConnection(fixture, { serverId });
    await link.auth({ id: accountDeviceId(serverId, key.public_spki), keys: { privateKey: key.private_key } as CryptoKeyPair, publicKey: key.public_spki });
    return async (path: string, init?: RequestInit): Promise<Response> => {
      const answer = await ask(link, path, { method: (init?.method ?? "GET") as "GET" | "POST", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    };
  };
  const signInFetch = await sessionOf(phone.signIn);
  phone.answers.set(ACCOUNT, endpoint, await askWitness(signInFetch));
  expect((await phone.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  await onPcSession({ list: phone.list, answers: phone.answers, account: ACCOUNT, fetch: signInFetch, endpoint, pinned: false, session: phone.signIn.public_spki, signIn: phone.signIn.public_spki });
  for (let round = 0; round < 50 && services.accountList!.status().pinned !== true; round += 1) { advance(100); services.accountList!.tick(); await services.accountList!.settled(); }
  const born = service.accountList(ACCOUNT)!;
  expect(born.state.pcs[endpoint]).toMatchObject({ how: "carried", key: null });
  // it follows the list and lets nobody in itself; a device that did nothing itself for it may not take its keys over
  // the session with no number (the phone below, by the record it hands this ask)
  expect(services.accountList!.allowRefusal()).toBe("needs_keys");
  advance(JOIN_HOLD_MS + 1_000);
  const memberKey = await phone.store.key();
  const record = { v: 1 as const, account: ACCOUNT, pcs: { [endpoint]: { since: 1, last: 2, how: "none" as const } } };
  expect(await keysForCarriedPc({ list: phone.list, fetch: await sessionOf(memberKey), account: ACCOUNT, endpoint, record, names: { label: "Desk", os: null } })).toBe("no_evidence");

  services.relay.setRelayAccount(ACCOUNT);
  const origin = `http://127.0.0.1:${fixture.app.port}`;
  const yieldTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  /** What the PC's side does, as a person at it: start its add, show the number, confirm it, and end added. */
  let pc: { readonly shows: () => Promise<string>; readonly confirm: (digits: string) => Promise<void>; readonly done: () => Promise<void> };
  if (by === "ovis add") {
    // ovis add at the PC, as a person runs it there with no terminal: it goes on to the add by the list for its keys
    const said: string[] = [];
    const shown = deferred<string>();
    const asking = deferred<void>();
    const options = (out: (text: string) => void) => ({
      origin, headers: {}, fetch: globalThis.fetch, accountService: "https://account.test", signal: new AbortController().signal, terminal: false, isTty: false,
      lines: { next: () => new Promise<IteratorResult<string>>(() => {}) }, now: () => now,
      serviceFetch: async (): Promise<Response> => { throw new Error("a PC in its account signs in to nothing for its keys"); },
      wait: async (ms: number) => { advance(ms); await yieldTurn(); },
      out,
    });
    const run = link([], options((text) => {
      said.push(text);
      if (text.includes("Compare a number with a device of your account")) asking.resolve();
      const number = /This PC shows ([0-9]{3}) ([0-9]{3})\./.exec(text);
      if (number) shown.resolve(`${number[1]}${number[2]}`);
    }));
    await bounded(asking.promise, 20_000);
    pc = {
      shows: () => bounded(shown.promise, 20_000),
      confirm: async (digits) => { expect(await link(["--confirm", digits], options(() => {}))).toBe(0); },
      done: async () => {
        expect(await bounded(run, 20_000)).toBe(0);
        expect(said.join("")).toContain("Done: this PC holds its own keys in your account's list now");
      },
    };
  } else {
    // the PC's own window: its requests reach this PC as the window's own (same origin, this PC's address)
    setTransport({ ...nativeTransport, fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", origin);
      return globalThis.fetch(new URL(String(input), origin), { ...init, headers });
    } });
    closes.push(() => setTransport(nativeTransport));
    const started = await addByList(ACCOUNT);
    if (started.kind !== "run") throw new Error(`the window's add did not start: ${JSON.stringify(started)}`);
    const run = started.run;
    /** the window's wait: it asks the PC where its add stands until `state`, which each ask moves on */
    const until = async <S extends ListAddState["state"]>(state: S): Promise<Extract<ListAddState, { state: S }>> => {
      for (let turn = 0; turn < 5_000; turn++) {
        const now = await fetchListAdd(run);
        if (now.state === state) return now as Extract<ListAddState, { state: S }>;
        if (now.state === "ended") throw new Error(`the window's add ended: ${now.why}`);
        await yieldTurn();
      }
      throw new Error(`the window's add never came to ${state}`);
    };
    pc = { shows: async () => (await until("number")).digits, confirm: (digits) => confirmListAdd(run, digits), done: async () => { await until("added"); } };
  }
  // the phone reads the PCs that posted for the list, as Manage account and My PCs read them: this one is offered for its keys
  const writer = phone.list.writer()!;
  const post = (await postedPcs(phone.list)).find((each) => each.endpoint === endpoint)!;
  expect(postedFor(writer.state, writer.keys.key, post)).toEqual({ kind: "keys" });
  const numbering = numberWith(phone.list, post, { wait: yieldTurn });
  // the person at the PC sees the same number there and confirms it, then presses Add on the phone
  const digits = await pc.shows();
  const number = await numbering;
  if (!number.shown) throw new Error(`no number on the phone: ${number.why}`);
  expect(digits).toBe(number.number.digits);
  await pc.confirm(digits);
  const added = await addPostedPc(phone.list, number.number.post, listNames("Desk", null), { expect: { account: ACCOUNT, list: born.id }, member: number.number.member, admit: async () => {} });
  expect(added).toMatchObject({ added: true });
  await pc.done();
  expect(service.accountList(ACCOUNT)!.state.pcs[endpoint]?.key).not.toBeNull();

  // it allows a device into the list now, with its own keys
  expect(services.accountList!.allowRefusal()).toBeNull();
  const newcomer = await listMember();
  const card = await claimKey(service, ACCOUNT, born.id, newcomer);
  expect(await services.accountList!.allowDevice({ key: newcomer.key, enc: newcomer.enc, card, label: "Tablet" }, true)).toMatchObject({ allowed: expect.anything() });
}

test("a PC the move carried in with no key gets its keys by ovis add there and the number on a member device, whatever that device did for it: then it allows a device", () => carriedPcGetsKeys("ovis add"), 60_000);

test("a PC the move carried in with no key gets its keys by its own window's button and the number on a member device: then it allows a device", () => carriedPcGetsKeys("window"), 60_000);


