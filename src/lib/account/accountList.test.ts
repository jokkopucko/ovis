import { beforeEach, describe, expect, it } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { LIST_LEVEL, kindBody, listView, namesFields, replayList, sealEpoch, signCard, signListEntry, type ListKind } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import { ATTEMPT_ENTRIES_MAX, LIST_SAVE_PREFIX } from "../../../shared/account-list-follower.ts";
import { openWrap, sealFields, wrapEpochKey, wrapFromText, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import { pcAddSigningBytes } from "../../../shared/account-records.ts";
import { FakeAccountService, WEB_REDIRECT, type ListTamper } from "../../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { fromBase64Url } from "../../../shared/relay-pair-sas.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { askingPc, postPcKeys, type AskingPc } from "./accountList.test-helpers.ts";
import { accountList, NO_LIST_SECONDS, OFF_SECONDS, UNREACHED_SECONDS, type AccountList, type AccountListView, type GenesisMode } from "./accountList.ts";
import { deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import { readWraps } from "./listNames.ts";
import { LIST_RECORDS, memoryListLock, memoryListStore, type ListStore } from "./listStore.ts";
import { AccountService } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountSession, type AccountStore } from "./store.ts";

const ORIGIN = "https://account.example";
const ACCOUNT = "acct_owner";
const MINUTE = 60_000;

let now = 1_795_000_000_000;
/** how far the account service's clock runs apart from the devices', in ms */
let serviceOff = 0;
let fake: FakeAccountService;
/** every challenge the account service handed out for a key proof */
let challenges: { challenge_id: string; challenge: string }[];

interface Sent { readonly method: string; readonly path: string; readonly body: Record<string, unknown> | null }
/** What a device's requests meet on the way: no network at all, one request that never arrives, one answer that is lost, or an answer of the test's own. */
interface Wire { down: boolean; dropRequestOf: string | null; loseAnswerOf: string | null; answer: ((request: Request) => Response | null) | null }
const openWire = (): Wire => ({ down: false, dropRequestOf: null, loseAnswerOf: null, answer: null });

/** One device: its own stores (so its own keys), its sign-in, and its copy of the list. `wire` is what its requests meet on the way. */
interface Device {
  readonly store: AccountStore;
  readonly lists: ListStore;
  readonly session: AccountSession;
  readonly list: AccountList;
  readonly sent: Sent[];
  readonly wire: Wire;
  keys(): Promise<DeviceListKeys>;
}

function wired(store: AccountStore, lists: ListStore, sent: Sent[], wire: Wire, options: { genesis: GenesisMode; linked: number; label: string; durable?: boolean }): AccountList {
  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (wire.down) throw new TypeError("the network is down");
    if (wire.dropRequestOf === route) {
      wire.dropRequestOf = null;
      throw new TypeError("the request never arrived");
    }
    const text = request.method === "GET" ? "" : await request.clone().text();
    sent.push({ method: request.method, path: `${url.pathname}${url.search}`, body: text === "" ? null : JSON.parse(text) as Record<string, unknown> });
    const answer = wire.answer?.(request) ?? await fake.fetch(request);
    if (url.pathname === "/v1/pcs/challenge" && answer.ok) challenges.push(await answer.clone().json() as { challenge_id: string; challenge: string });
    if (wire.loseAnswerOf === route) {
      wire.loseAnswerOf = null;
      throw new TypeError("the answer was lost");
    }
    return answer;
  };
  const service = new AccountService({ store, fetch, lock: memoryLock(), now: () => now });
  return accountList({
    service, accountStore: store, listStore: lists, lock: memoryListLock(), now: () => now,
    names: () => ({ label: options.label, os: "ios" }), linkedPcs: async () => options.linked, genesis: () => options.genesis, durable: async () => options.durable !== false,
  });
}

async function device(given: { genesis?: GenesisMode; register?: boolean; linked?: number; label?: string; code?: boolean; account?: string; durable?: boolean } = {}): Promise<Device> {
  const account = given.account ?? ACCOUNT;
  const options = { genesis: given.genesis ?? "first-device", linked: given.linked ?? 0, label: given.label ?? "Dana's phone", ...(given.durable === undefined ? {} : { durable: given.durable }) };
  const store = memoryAccountStore();
  const lists = memoryListStore();
  let session: AccountSession;
  if (given.code === true) {
    // a sign-in by a device code, as a PC's own page makes one: not an app's own
    session = { service: ORIGIN, account, provider: "github", access_token: fake.issueToken(account, { device: true }), refresh_token: `r-${Math.random()}`, expires_at: now + 60 * MINUTE, sign_in_id: `code-${Math.random()}`, signed_in_at: now };
    await store.set("session", session);
  } else {
    fake.signInAs("github", account);
    const start = await beginSignIn("github", { store, service: ORIGIN, redirectUri: WEB_REDIRECT, now: () => now });
    const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
    if (returned === null) throw new Error("no sign-in came back");
    session = await finishSignIn(returned, { store, fetch: fake.fetch, now: () => now });
  }
  if (given.register !== false && given.code !== true) {
    const key = await newKey();
    await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id!, key, no: fake.registerSessionKey(session.access_token, key.public_spki, options.label) });
  }
  const sent: Sent[] = [];
  const wire = openWire();
  return { store, lists, session, sent, wire, list: wired(store, lists, sent, wire, options), keys: () => deviceListKeys(store) };
}

/** The same device after a reload: what it saved, and a page that remembers nothing. */
function reloaded(from: Device, genesis: GenesisMode = "first-device"): Device {
  const sent: Sent[] = [];
  const wire = openWire();
  return { ...from, sent, wire, list: wired(from.store, from.lists, sent, wire, { genesis, linked: 0, label: "Dana's phone" }) };
}

const asked = (from: Device, route: string): number => from.sent.filter((each) => `${each.method} ${each.path.split("?")[0]}` === route).length;
const held = (account = ACCOUNT): NonNullable<ReturnType<FakeAccountService["accountList"]>> => {
  const list = fake.accountList(account);
  if (list === null) throw new Error("the account has no list");
  return list;
};
const following = (view: AccountListView) => {
  if (view.status.at !== "following") throw new Error(`the device is ${view.status.at}`);
  return view.status;
};
const tamper = (rule: ListTamper): void => fake.tamperList(held().id, rule);

function newPc(): { endpoint: string; server_id: string } {
  const key = generateKeyPair().publicKey;
  return { endpoint: Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join(""), server_id: deriveServerId(key) };
}

/** The key of the list's current epoch, opened from the wrap the device keeps: what a member seals a name with. */
async function epochKey(of: Device): Promise<EpochKey> {
  const keys = await of.keys();
  const { id, state } = held();
  const wrap = readWraps(await of.lists.get("wraps", ACCOUNT), id, keys.enc.key).wraps.get(state.epoch);
  const opened = await openWrap({ list: id, epoch: state.epoch, commitment: state.epochs[state.epoch]!.opens, wrap: wrap === undefined ? null : wrapFromText(wrap), member: keys.enc });
  if (!opened.open) throw new Error(`the device holds no key of epoch ${state.epoch}: ${opened.why}`);
  return opened.value;
}

/** An entry at the list's head with any signature a test wants on it, as a lying service or a stolen key writes one; `kind` is told where it stands. */
async function signed(by: DeviceListKeys | { key: string; signs: CryptoKey }, kind: (place: { list: string; seq: number }) => ListKind | Promise<ListKind>, at = held()): Promise<string> {
  const place = { list: at.id, seq: at.head.seq + 1 };
  const body = kindBody({ issued_at: Math.floor(now / 1000), list: at.id, prev: at.head.hash, seq: place.seq, signer: by.key }, await kind(place));
  return entryToText(await signEntry(body, by.signs));
}

/**
 * Another history from entry 1 that a member signed, which is no post the member left behind: `first`, then more entries by the same
 * signer than one post holds. A single entry there by a member that went on is no fork (the follower refuses it and nothing changes).
 */
async function otherHistory(by: DeviceListKeys | { key: string; signs: CryptoKey }, first: () => ListKind, list = held()): Promise<string[]> {
  const texts: string[] = [];
  let head = { seq: 0, hash: list.id };
  for (let index = 0; index <= ATTEMPT_ENTRIES_MAX; index += 1) {
    const text = await signed(by, index === 0 ? first : () => ({ kind: "carried", endpoint: newPc().endpoint, sealed: null }), { ...list, head });
    texts.push(text);
    head = { seq: head.seq + 1, hash: entryHash(entryFromText(text).body) };
  }
  return texts;
}

async function post(from: Device, entries: readonly string[], wraps: readonly { epoch: number; member: string; wrap: string }[] = []): Promise<Response> {
  return fake.fetch(`${ORIGIN}/v2/lists/${held().id}/entries`, {
    method: "POST", headers: { authorization: `Bearer ${(await from.store.get("session"))!.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ entries, ...(wraps.length === 0 ? {} : { wraps }) }),
  });
}

/**
 * The device adds a PC under a sealed name, as a person's Add will: the account lists the PC and the PC posts its keys
 * and its card, then the device signs the `pc` entry and wraps the epoch key to the PC.
 */
async function addPc(from: Device, label: string): Promise<AskingPc> {
  const pc = await askingPc();
  const { id, state } = held();
  const card = await postPcKeys(fake.fetch, ORIGIN, (await from.store.get("session"))!.access_token, pc, id);
  const keys = await from.keys();
  // the kinds say whether a writer may seal, and under which epoch: no writer decides it
  const where = sealEpoch(state, Math.floor(now / 1000));
  if (where === null) throw new Error("No name may be sealed where the list stands");
  const key = await epochKey(from);
  const place = { list: id, seq: state.footing.seq + 1 };
  const sealed = { epoch: where.epoch, bytes: await sealFields({ place, epoch: key, commitment: where.opens, fields: namesFields({ label, os: "linux" }) }) };
  // and a member signs only through the kinds' writer, which signs nothing that would not count
  const written = await signListEntry(state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card, sealed }, { key: keys.key, privateKey: keys.signs }, Math.floor(now / 1000));
  const wrap = await wrapEpochKey({ list: id, epoch: key, member: pc.enc });
  const placed = await post(from, [written.text], [{ epoch: key.epoch, member: pc.enc, wrap: wrapToText(wrap!) }]);
  expect([placed.status, placed.ok ? null : await placed.text()]).toEqual([200, null]);
  return pc;
}

async function removePc(from: Device, pc: AskingPc): Promise<void> {
  const keys = await from.keys();
  const written = await signListEntry(held().state, { kind: "remove", ends: pc.key }, { key: keys.key, privateKey: keys.signs }, Math.floor(now / 1000));
  expect((await post(from, [written.text])).status).toBe(200);
}

/** A key that is no member's, and an entry it signs at the head: what the account service could write by itself. */
async function strangers(kind: (key: string, place: { list: string; seq: number }) => ListKind): Promise<string> {
  const stranger = await deviceListKeys(memoryAccountStore());
  return signed(stranger, (place) => kind(stranger.key, place));
}

beforeEach(() => {
  now = 1_795_000_000_000;
  challenges = [];
  serviceOff = 0;
  fake = new FakeAccountService(() => now + serviceOff);
  fake.opensAll = true;
  fake.listAccounts = ACCOUNT;
});

describe("an account the service keeps no list for", () => {
  it("is as before: one question, no key made, and nothing kept but when it was answered", async () => {
    fake.listAccounts = "";
    const phone = await device();
    const view = await phone.list.sync();
    expect(view).toEqual({ account: ACCOUNT, status: { at: "off" }, reached: true, devices: [], pcs: [] });
    expect(phone.sent.map((each) => `${each.method} ${each.path}`)).toEqual(["GET /v2/lists/mine"]);
    expect(await phone.store.get("enc_key")).toBeUndefined();
    for (const record of ["copy", "wraps", "genesis", "shadow"] as const) expect(await phone.lists.get(record, ACCOUNT)).toBeUndefined();
    expect(await phone.lists.get("asked", ACCOUNT)).toEqual({ v: 1, off_at: Math.floor(now / 1000) });
    expect(fake.accountList(ACCOUNT)).toBeNull();
  });

  it("counts the day from when the answer came, not from when it was asked", async () => {
    fake.listAccounts = "";
    const phone = await device();
    // the answer takes twenty seconds
    phone.wire.answer = () => { now += 20_000; return null; };
    await phone.list.sync();
    phone.wire.answer = null;
    expect(await phone.lists.get("asked", ACCOUNT)).toEqual({ v: 1, off_at: Math.ceil(now / 1000) });
    expect(phone.list.due(true)).toBe((Math.ceil(now / 1000) + OFF_SECONDS) * 1000);
    // a second before a day after the answer, another page asks nothing
    now += OFF_SECONDS * 1000 - 1000;
    const again = reloaded(phone);
    await again.list.sync();
    expect(again.sent).toEqual([]);
  });

  it("is asked again where the time it kept of that answer is ahead of the clock, and keeps no such answer of a sign-in that could not be refreshed", async () => {
    fake.listAccounts = "";
    const phone = await device();
    await phone.list.sync();
    // the clock was set back since: the day cannot be counted from a time that has not come
    now -= 2 * 60 * MINUTE;
    const again = reloaded(phone);
    await again.list.sync();
    expect(asked(again, "GET /v2/lists/mine")).toBe(1);
    // an access token that ran out, and a refresh that the service answers 404: no word on lists at all
    const stale = await device({ account: "acct_stale" });
    await stale.store.set("session", { ...(await stale.store.get("session"))!, expires_at: now - 1000 });
    stale.wire.answer = (request) => new URL(request.url).pathname === "/v1/token" ? Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 }) : null;
    const view = await stale.list.sync().catch(() => null);
    expect(await stale.lists.get("asked", "acct_stale")).toBeUndefined();
    expect(view === null || view.reached === false).toBe(true);
  });

  it("is asked once a day at most, however often the app starts and whichever page asks", async () => {
    fake.listAccounts = "";
    const phone = await device();
    await phone.list.sync();
    expect([phone.list.due(true), phone.list.due(false)]).toEqual([now + OFF_SECONDS * 1000, null]);
    // the same page again, and the app started again an hour later and a second before the day is over: nothing is asked
    await phone.list.sync();
    for (const later of [60 * MINUTE, OFF_SECONDS * 1000 - 60 * MINUTE - 1000]) {
      now += later;
      const again = reloaded(phone);
      expect(await again.list.sync()).toEqual({ account: ACCOUNT, status: { at: "off" }, reached: true, devices: [], pcs: [] });
      expect(again.sent).toEqual([]);
    }
    expect(asked(phone, "GET /v2/lists/mine")).toBe(1);
    // a day after the answer it is asked once more, and the account service keeps lists for the account by then
    now += 1000;
    fake.listAccounts = ACCOUNT;
    const next = reloaded(phone, "never");
    expect((await next.list.sync()).status).toEqual({ at: "none", why: "switched_off" });
    expect(asked(next, "GET /v2/lists/mine")).toBe(1);
  });

  it("is as before for a device that is not signed in: nothing is asked", async () => {
    const phone = await device();
    await phone.store.set("session", undefined);
    expect(await phone.list.sync()).toEqual({ account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] });
    expect(phone.sent).toEqual([]);
  });
});

describe("an account service that answers the list's questions as it does not for any other", () => {
  const answers = (status: number, code: string) => (path: (pathname: string) => boolean) => (request: Request) =>
    path(new URL(request.url).pathname) ? Response.json({ error: { code, message: "x" } }, { status }) : null;

  it("signs nobody out and refreshes no token, whatever it answers to which list the account has", async () => {
    for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [500, "internal"], [429, "rate_limited"]] as const) {
      const phone = await device();
      const before = (await phone.store.get("session"))!;
      phone.wire.answer = answers(status, code)((pathname) => pathname === "/v2/lists/mine");
      expect(await phone.list.sync()).toEqual({ account: ACCOUNT, status: { at: "off" }, reached: false, devices: [], pcs: [] });
      expect(await phone.store.get("session")).toEqual(before);
      expect(phone.sent.map((each) => `${each.method} ${each.path}`)).toEqual(["GET /v2/lists/mine"]);
      expect(await phone.store.get("enc_key")).toBeUndefined();
    }
  });

  it("signs nobody out where it refuses the challenge for the proof of a claim: a device that waits, with an old sign-in, asks by itself", async () => {
    const phone = await device();
    await phone.list.sync();
    const tablet = await device({ label: "Dana's tablet" });
    // the tablet's sign-in is older than ten minutes: its claim goes with a proof by its registered key
    now += 11 * MINUTE;
    const before = (await tablet.store.get("session"))!;
    tablet.wire.answer = answers(401, "unauthorized")((pathname) => pathname === "/v1/pcs/challenge");
    const view = await tablet.list.sync();
    expect(view.status).toMatchObject({ at: "not_in", why: "not_mine" });
    expect(asked(tablet, "POST /v1/pcs/challenge")).toBe(1);
    expect(await tablet.store.get("session")).toEqual(before);
    expect(asked(tablet, "POST /v1/token")).toBe(0);
  });

  it("signs by its own clock and never by the floor it saved, and knows when the two are far apart, also where another page saved the floor", async () => {
    const phone = await device();
    await phone.list.sync();
    const own = Math.floor(now / 1000);
    expect([phone.list.writer()!.clock, phone.list.writer()!.issued_at, phone.list.writer()!.adrift]).toEqual([own, own, false]);
    // another page of this device saw a time an hour later (a date set ahead, since put right), and kept it beside the copy
    await phone.lists.set("times", ACCOUNT, { v: 1, list: held().id, read_at: own + 3600, seen_at: own + 3600 });
    await phone.list.sync();
    // what is signed still goes by this device's clock as it is: the floor would put out a key whose time is not over
    const writer = phone.list.writer()!;
    expect([writer.clock, writer.issued_at]).toEqual([own, own]);
    // and a clock more than ten minutes under the floor is known to be adrift: nobody is put out for a time that is over
    expect(writer.adrift).toBe(true);
  });

  it("signs nobody out where it refuses the log or the wraps of a list the device follows: the copy stands", async () => {
    const phone = await device();
    const view = await phone.list.sync();
    await addPc(phone, "Desk");
    const before = (await phone.store.get("session"))!;
    const list = held().id;
    for (const route of ["log", "wraps"]) {
      const again = reloaded(phone);
      if (route === "wraps") await phone.lists.set("wraps", ACCOUNT, undefined);
      again.wire.answer = answers(401, "unauthorized")((pathname) => pathname === `/v2/lists/${list}/${route}`);
      now += 30_000;
      const shown = await again.list.sync();
      expect(await phone.store.get("session")).toEqual(before);
      expect(asked(again, "POST /v1/token")).toBe(0);
      expect(following(shown)).toMatchObject({ list, standing: "in" });
      expect(shown.devices.map((row) => row.key)).toEqual(view.devices.map((row) => row.key));
    }
  });

  it("is asked again a day later once it says the account has no list to keep: 404 is the one answer that says so", async () => {
    const phone = await device();
    phone.wire.answer = answers(404, "not_found")((pathname) => pathname.startsWith("/v2/"));
    expect(await phone.list.sync()).toEqual({ account: ACCOUNT, status: { at: "off" }, reached: true, devices: [], pcs: [] });
    expect(phone.list.due(true)).toBe(now + OFF_SECONDS * 1000);
  });

  it("is asked less and less often while it does not answer: 5 minutes, 15, an hour, then every 6 hours", async () => {
    const phone = await device();
    phone.wire.answer = answers(500, "internal")((pathname) => pathname.startsWith("/v2/"));
    const waits: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      expect((await phone.list.sync()).reached).toBe(false);
      waits.push((phone.list.due(true)! - now) / 1000);
      now = phone.list.due(true)!;
    }
    expect(waits).toEqual([300, 900, 3600, 21600, 21600, 21600]);
    expect(await phone.lists.get("asked", ACCOUNT)).toBeUndefined();
    // one answer and it is back to its own pace (the sign-in is hours old by now, so it starts no list)
    phone.wire.answer = null;
    expect(await phone.list.sync()).toMatchObject({ status: { at: "none", why: "not_new" }, reached: true });
    expect(phone.list.due(true)).toBe(now + NO_LIST_SECONDS * 1000);
  });

  it("waits longer too where it follows a list and the account service stops answering for it", async () => {
    const phone = await device();
    await phone.list.sync();
    fake.listAccounts = "";
    const waits: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      now = phone.list.due(true)!;
      const view = await phone.list.sync();
      expect([view.reached, following(view).standing]).toEqual([false, "in"]);
      waits.push((phone.list.due(true)! - now) / 1000);
    }
    expect(waits).toEqual([300, 900, 3600]);
    expect(await phone.lists.get("asked", ACCOUNT)).toBeUndefined();
  });
});

describe("the first device of an account with nobody in it", () => {
  it("starts the list itself: entry 0 is its own, and every member and the account service take it", async () => {
    const phone = await device();
    const keys = await phone.keys();
    const view = await phone.list.sync();
    const list = held();
    expect(following(view)).toEqual({ at: "following", list: list.id, standing: "in", head: 0, read_at: Math.floor(now / 1000), trouble: null });
    expect(view.devices).toEqual([{ key: keys.key, self: true, power: "full", role: "drive", until: null, carried: false, name: { label: "Dana's phone", os: "ios" } }]);
    expect(view.pcs).toEqual([]);
    // the account service ran the same rules on it, and any member replays it to the same list
    expect(list.entries).toHaveLength(1);
    const replayed = await replayList(list.entries, LIST_LEVEL, { saved: null, given: list.id });
    expect(listView(replayed.member!.state).devices.map((row) => [row.key, row.power, row.enc])).toEqual([[keys.key, "full", keys.enc.key]]);
    expect(readBody(entryFromText(list.entries[0]!).body).signer).toBe(keys.key);
    expect(listView(list.state).devices.map((row) => row.key)).toEqual([keys.key]);
    expect(asked(phone, "POST /v2/lists")).toBe(1);
  });

  it("sends the account service nothing that names the device or opens its name", async () => {
    const phone = await device({ label: "Kitchen tablet" });
    await phone.list.sync();
    const told = JSON.stringify(phone.sent);
    expect(told).not.toContain("Kitchen");
    expect(atob(held().entries[0]!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("Kitchen");
    const genesis = phone.sent.find((each) => each.method === "POST" && each.path === "/v2/lists")!.body!;
    expect(Object.keys(genesis).sort()).toEqual(["entry", "wraps"]);
    expect(genesis.wraps).toEqual([{ epoch: 0, member: (await phone.keys()).enc.key, wrap: expect.any(String) }]);
  });

  it("starts none while the account has a PC, another device, or a sign-in that is not an app's own", async () => {
    const pc = newPc();
    const listPc = async (token: string) => fake.fetch(`${ORIGIN}/v1/pcs/${pc.server_id}`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "Desk", public_key: pc.endpoint, relay: "wss://relay.ovis.sh" }),
    });
    const none = async (from: Device, why: string) => {
      expect((await from.list.sync()).status).toEqual({ at: "none", why } as AccountListView["status"]);
      expect(asked(from, "POST /v2/lists")).toBe(0);
      expect(fake.accountList(ACCOUNT)).toBeNull();
    };
    const first = await device({ register: false });
    await none(first, "not_first_device");
    await none(await device({ linked: 1 }), "has_pcs");
    await none(await device(), "not_first_device");
    await none(await device({ genesis: "never" }), "switched_off");
    await none(await device({ code: true, genesis: "always" }), "not_own_sign_in");
    // a sign-in that is not new: the account was in use before it could have a list
    const old = await device({ account: "acct_in_use" });
    fake.listAccounts = "*";
    now += 10 * MINUTE;
    expect((await old.list.sync()).status).toEqual({ at: "none", why: "not_new" });
    expect([asked(old, "POST /v2/lists"), fake.accountList("acct_in_use")]).toEqual([0, null]);
    // a PC that typed a code for the account and waits to be confirmed is a PC of the account too
    const registered = await device({ register: false });
    await registered.store.set("signin_key", { account: ACCOUNT, sign_in_id: registered.session.sign_in_id!, key: await newKey(), no: 1 });
    expect((await listPc(fake.issueToken(ACCOUNT, { device: true }))).ok).toBe(true);
    await none(registered, "has_pcs");
  });

  it("starts none where what the page stores may be cleared at any time: another device starts it", async () => {
    const tab = await device({ durable: false });
    expect((await tab.list.sync()).status).toEqual({ at: "none", why: "storage" });
    expect([asked(tab, "POST /v2/lists"), await tab.lists.get("genesis", ACCOUNT), fake.accountList(ACCOUNT)]).toEqual([0, undefined, null]);
    // the developer's switch starts one all the same
    const forced = await device({ account: "acct_forced", durable: false, genesis: "always" });
    fake.listAccounts = "*";
    expect(following(await forced.list.sync()).standing).toBe("in");
  });

  it("starts none for a sign-in whose registered key is another sign-in's or another account's, or whose time is ahead of the clock", async () => {
    const other = await device({ account: "acct_gate_a" });
    fake.listAccounts = "*";
    const kept = (await other.store.get("signin_key"))!;
    await other.store.set("signin_key", { ...kept, sign_in_id: "an-earlier-sign-in" });
    expect((await other.list.sync()).status).toEqual({ at: "none", why: "not_first_device" });
    const another = await device({ account: "acct_gate_b" });
    await another.store.set("signin_key", { ...(await another.store.get("signin_key"))!, account: "acct_someone_else" });
    expect((await another.list.sync()).status).toEqual({ at: "none", why: "not_first_device" });
    const ahead = await device({ account: "acct_gate_c" });
    await ahead.store.set("session", { ...(await ahead.store.get("session"))!, signed_in_at: now + 60 * MINUTE });
    expect((await ahead.list.sync()).status).toEqual({ at: "none", why: "not_new" });
  });

  it("starts one all the same where the developer's switch says so", async () => {
    await device();
    const second = await device({ genesis: "always", linked: 2 });
    expect(following(await second.list.sync()).standing).toBe("in");
    expect(listView(held().state).devices.map((row) => row.key)).toEqual([(await second.keys()).key]);
  });

  it("sends no key proof from a sign-in that is new", async () => {
    const phone = await device();
    await phone.list.sync();
    expect([asked(phone, "POST /v1/pcs/challenge"), "key_proof" in phone.sent.find((each) => each.path === "/v2/lists")!.body!]).toEqual([0, false]);
  });

  it("proves an old sign-in with its registered key over the list id, where the developer's switch starts a list", async () => {
    const phone = await device({ genesis: "always" });
    now += 11 * MINUTE;
    expect(following(await phone.list.sync()).standing).toBe("in");
    const proof = phone.sent.find((each) => each.method === "POST" && each.path === "/v2/lists")!.body!.key_proof as { challenge_id: string; signature: string };
    const issued = challenges.find((each) => each.challenge_id === proof.challenge_id)!;
    const registered = (await phone.store.get("signin_key"))!.key.public_spki;
    const key = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(registered)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const bytes = pcAddSigningBytes("list-genesis", ACCOUNT, held().id, "", proof.challenge_id, issued.challenge);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(fromBase64Url(proof.signature)), bytes)).toBe(true);
  });

  it("dates entry 0 by its own clock, whatever the account service says the time is, and says so where the service refuses that time", async () => {
    fake.listAccounts = "*";
    const here = Math.floor(now / 1000);
    const started = async (off: number, account: string) => {
      serviceOff = off;
      const from = await device({ account });
      return { from, view: await from.list.sync() };
    };
    expect(following((await started(0, "acct_on_time")).view).standing).toBe("in");
    expect(readBody(entryFromText(held("acct_on_time").entries[0]!).body).issued_at).toBe(here);
    // the service's clock an hour ahead: the device signs its own time, never the service's
    expect(following((await started(60 * MINUTE, "acct_behind")).view).standing).toBe("in");
    expect(readBody(entryFromText(held("acct_behind").entries[0]!).body).issued_at).toBe(here);
    // the service's clock a day behind: it takes no entry dated that far ahead of it, and the device signs no other time for it
    const { from, view } = await started(-24 * 60 * MINUTE, "acct_ahead");
    expect(view.status).toEqual({ at: "none", why: "clock" });
    expect(fake.accountList("acct_ahead")).toBeNull();
    expect(readBody(entryFromText(from.sent.find((each) => each.path === "/v2/lists")!.body!.entry as string).body).issued_at).toBe(here);
  });

  it("signs another genesis after the account service refused the first as an entry, which it then never placed", async () => {
    const phone = await device();
    phone.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname === "/v2/lists"
      ? Response.json({ error: { code: "entry_refused", message: "x", index: 0, outcome: "service", reason: "entry_invalid" }, now: 1 }, { status: 400 }) : null;
    expect((await phone.list.sync()).status).toEqual({ at: "none", why: "refused" });
    expect([await phone.lists.get("genesis", ACCOUNT), fake.accountList(ACCOUNT)]).toEqual([undefined, null]);
    const first = phone.sent.find((each) => each.path === "/v2/lists")!.body!.entry as string;
    // given up for good: its id is written down
    expect(await phone.lists.get("dropped", ACCOUNT)).toEqual({ v: 1, lists: [entryHash(entryFromText(first).body)] });
    phone.wire.answer = null;
    now += NO_LIST_SECONDS * 1000;
    expect(following(await phone.list.sync()).standing).toBe("in");
    expect(held().entries).toHaveLength(1);
    expect(held().entries[0]).not.toBe(first);
  });

  it("keeps its entry 0 and counts the round as not reached where the account service is busy or fails, and makes the proof again where its challenge ran out", async () => {
    const phone = await device();
    const answers = [new Response("busy", { status: 429 }), new Response("down", { status: 503 })];
    phone.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname === "/v2/lists" ? answers.shift() ?? null : null;
    for (let tries = 0; tries < 2; tries += 1) {
      const view = await phone.list.sync();
      expect([view.reached, await phone.lists.get("dropped", ACCOUNT)]).toEqual([false, undefined]);
      expect(await phone.lists.get("genesis", ACCOUNT)).toBeDefined();
      now += 6 * 3600_000;
    }
    // by now the sign-in is old: the entry goes with a proof, and a proof whose challenge was spent on the way is made once more
    let spent = false;
    phone.wire.answer = (request) => {
      if (spent || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      spent = true;
      return Response.json({ error: { code: "challenge_invalid", message: "x" } }, { status: 400 });
    };
    const before = challenges.length;
    expect(following(await phone.list.sync()).standing).toBe("in");
    expect([challenges.length - before, held().entries.length]).toEqual([2, 1]);
  });

  it("sends no entry 0 that was kept under a key the device no longer has", async () => {
    for (const field of ["key", "enc"] as const) {
      const account = `acct_kept_${field}`;
      fake.listAccounts = "*";
      const phone = await device({ account });
      phone.wire.dropRequestOf = "POST /v2/lists";
      await phone.list.sync();
      const kept = await phone.lists.get("genesis", account) as { entry: string } & Record<string, unknown>;
      await phone.lists.set("genesis", account, { ...kept, [field]: `${kept[field] as string}x` });
      expect(following(await phone.list.sync()).standing).toBe("in");
      // what was sent is another entry 0, signed now
      expect(held(account).entries[0]).not.toBe(kept.entry);
    }
  });

  it("is told so, and starts nothing, when its sign-in is old and has no key to prove", async () => {
    const phone = await device({ register: false, genesis: "always" });
    now += 11 * MINUTE;
    expect((await phone.list.sync()).status).toEqual({ at: "none", why: "session_not_fresh" });
    expect(fake.accountList(ACCOUNT)).toBeNull();
  });
});

describe("two that start a list at once", () => {
  it("make one list: the other device follows none of it, and never sends a second", async () => {
    const first = await device();
    const second = await device({ genesis: "always" });
    const [a, b] = await Promise.all([first.list.sync(), second.list.sync()]);
    const list = held();
    const [won, lost] = a.status.at === "following" ? [a, b] : [b, a];
    const loser = a.status.at === "following" ? second : first;
    expect(following(won)).toMatchObject({ list: list.id, standing: "in", trouble: null });
    expect(lost).toEqual({ account: ACCOUNT, status: { at: "not_in", list: list.id, why: "not_mine", claim: "claimed" }, reached: true, devices: [], pcs: [] });
    expect(list.entries).toHaveLength(1);
    // it keeps nothing of a list it is not in, and asks for no more of it than entry 0, once
    expect(await loser.lists.get("copy", ACCOUNT)).toBeUndefined();
    const before = loser.sent.length;
    now += NO_LIST_SECONDS * 1000;
    expect((await loser.list.sync()).status).toEqual({ at: "not_in", list: list.id, why: "not_mine", claim: "claimed" });
    // it asks which list again, and keeps its claim of its own key standing for whoever lets it in
    expect(loser.sent.slice(before).map((each) => `${each.method} ${each.path}`)).toEqual(["GET /v2/lists/mine", `POST /v2/lists/${list.id}/claims`]);
    expect(asked(loser, "POST /v2/lists")).toBe(1);
    expect(asked(loser, `GET /v2/lists/${list.id}/log`)).toBe(1);
    expect(held().id).toBe(list.id);
  });

  it("make one list when they are two pages of one device with no lock between them", async () => {
    const page = await device();
    const other = reloaded(page);
    const [a, b] = await Promise.all([page.list.sync(), other.list.sync()]);
    const list = held();
    expect(list.entries).toHaveLength(1);
    expect([following(a).list, following(b).list, following(a).standing, following(b).standing]).toEqual([list.id, list.id, "in", "in"]);
    // whichever page's genesis the account service took, both read the device's name under its key
    expect([a.devices[0]!.name, b.devices[0]!.name]).toEqual([{ label: "Dana's phone", os: "ios" }, { label: "Dana's phone", os: "ios" }]);
  });

  it("signs no second genesis after a lost answer: the list the account service took is found to be its own", async () => {
    const phone = await device();
    phone.wire.loseAnswerOf = "POST /v2/lists";
    const lost = await phone.list.sync();
    expect([lost.status, lost.reached]).toEqual([{ at: "off" }, false]);
    const list = held();
    const view = await reloaded(phone).list.sync();
    expect(following(view)).toMatchObject({ list: list.id, standing: "in" });
    expect(view.devices[0]!.name).toEqual({ label: "Dana's phone", os: "ios" });
    expect(held().entries).toEqual(list.entries);
    expect(await phone.lists.get("genesis", ACCOUNT)).toBeUndefined();
  });

  it("sends the same genesis again after a request that never arrived, from a page that remembers nothing", async () => {
    const phone = await device();
    phone.wire.dropRequestOf = "POST /v2/lists";
    expect((await phone.list.sync()).reached).toBe(false);
    expect(fake.accountList(ACCOUNT)).toBeNull();
    const kept = await phone.lists.get("genesis", ACCOUNT) as { list: string; entry: string };
    const again = reloaded(phone);
    expect(following(await again.list.sync()).standing).toBe("in");
    expect([held().id, held().entries]).toEqual([kept.list, [kept.entry]]);
    expect(again.sent.find((each) => each.path === "/v2/lists")!.body!.entry).toBe(kept.entry);
  });

  it("sends the genesis it signed again when its next round comes, though the sign-in is no longer new by then", async () => {
    const phone = await device();
    phone.wire.dropRequestOf = "POST /v2/lists";
    expect((await phone.list.sync()).reached).toBe(false);
    const kept = await phone.lists.get("genesis", ACCOUNT) as { list: string; entry: string };
    // the next round by the clock: the sign-in is ten minutes old by then, past the nine in which a device starts a list
    now += 10 * MINUTE;
    expect(phone.list.due(true)!).toBeLessThanOrEqual(now);
    expect(following(await phone.list.sync()).standing).toBe("in");
    expect([held().id, held().entries]).toEqual([kept.list, [kept.entry]]);
    // and a device that signed none starts none that late
    fake.listAccounts = "*";
    const late = await device({ account: "acct_late" });
    now += 10 * MINUTE;
    expect((await late.list.sync()).status).toEqual({ at: "none", why: "not_new" });
  });

  it("forgets the genesis it signed once the account has another list", async () => {
    const first = await device();
    const second = await device({ genesis: "always" });
    second.wire.dropRequestOf = "POST /v2/lists";
    await second.list.sync();
    expect(await second.lists.get("genesis", ACCOUNT)).toBeDefined();
    await first.list.sync();
    expect((await second.list.sync()).status).toEqual({ at: "not_in", list: held().id, why: "not_mine", claim: "claimed" });
    expect(await second.lists.get("genesis", ACCOUNT)).toBeUndefined();
  });
});

describe("a device that gave up the entry 0 it signed", () => {
  it("never follows the list of that entry, whoever names it later and after a reload too", async () => {
    const first = await device();
    const second = await device({ genesis: "always" });
    const [a] = await Promise.all([first.list.sync(), second.list.sync()]);
    const loser = a.status.at === "following" ? second : first;
    const real = held().id;
    expect((await loser.list.sync()).status).toMatchObject({ at: "not_in", list: real, why: "not_mine" });
    const mine = loser.sent.find((each) => each.method === "POST" && each.path === "/v2/lists")!.body!.entry as string;
    const id = entryHash(entryFromText(mine).body);
    expect(id).not.toBe(real);
    expect([await loser.lists.get("genesis", ACCOUNT), await loser.lists.get("dropped", ACCOUNT)]).toEqual([undefined, { v: 1, lists: [id] }]);
    // a lying service names the entry 0 it was sent and refused, and serves it
    const lie: Wire["answer"] = (request) => {
      const path = new URL(request.url).pathname;
      const at = Math.floor(now / 1000);
      if (path === "/v2/lists/mine") return Response.json({ list: id, head: { seq: 0, hash: id }, now: at });
      if (path === `/v2/lists/${id}/log`) return Response.json({ list: id, after: null, entries: [mine], head: { seq: 0, hash: id }, more: false, now: at });
      return null;
    };
    const page = reloaded(loser, "always");
    page.wire.answer = lie;
    expect((await page.list.sync()).status).toMatchObject({ at: "not_in", list: id, why: "not_mine" });
    expect([await loser.lists.get("copy", ACCOUNT), asked(page, `GET /v2/lists/${id}/log`)]).toEqual([undefined, 0]);
    // the honest service again: the device waits to be let into the account's one list, as before
    page.wire.answer = null;
    now += NO_LIST_SECONDS * 1000;
    expect((await page.list.sync()).status).toMatchObject({ at: "not_in", list: real, why: "not_mine" });
  });
});

describe("catching up", () => {
  it("takes what the log shows after its own head: a PC that came in, by its relay key and its sealed name, and one that went", async () => {
    const phone = await device();
    await phone.list.sync();
    const desk = await addPc(phone, "Desk in the study");
    const laptop = await addPc(phone, "Laptop");
    now += 30_000;
    const view = await phone.list.sync();
    expect(following(view)).toMatchObject({ head: 2, standing: "in", trouble: null, read_at: Math.floor(now / 1000) });
    const by = (await phone.keys()).key;
    expect(view.pcs).toEqual([
      { endpoint: desk.endpoint, server_id: desk.server_id, how: "added", allows: true, name: { label: "Desk in the study", os: "linux" }, seq: 1, by, new_at: null },
      { endpoint: laptop.endpoint, server_id: laptop.server_id, how: "added", allows: true, name: { label: "Laptop", os: "linux" }, seq: 2, by, new_at: null },
    ]);
    expect([phone.list.holdsPc(desk.endpoint), phone.list.holdsPc(newPc().endpoint)]).toEqual([true, false]);
    expect([phone.list.pcOfKey(desk.key), phone.list.pcOfKey(laptop.key), phone.list.pcOfKey((await phone.keys()).key)]).toEqual([desk.endpoint, laptop.endpoint, null]);
    await removePc(phone, desk);
    const after = await phone.list.sync();
    expect(after.pcs.map((pc) => pc.endpoint)).toEqual([laptop.endpoint]);
    expect([phone.list.holdsPc(desk.endpoint), phone.list.pcOfKey(desk.key)]).toEqual([false, null]);
    expect(deriveServerId(hexToBytes(laptop.endpoint))).toBe(after.pcs[0]!.server_id);
  });

  it("asks for the log only when the head it is told is not its own", async () => {
    const phone = await device();
    await phone.list.sync();
    const before = phone.sent.length;
    now += 30_000;
    await phone.list.sync();
    expect(phone.sent.slice(before).map((each) => `${each.method} ${each.path}`)).toEqual(["GET /v2/lists/mine"]);
    await addPc(phone, "Desk");
    const then = phone.sent.length;
    await phone.list.sync();
    expect(phone.sent.slice(then).map((each) => `${each.method} ${each.path}`)).toEqual(["GET /v2/lists/mine", `GET /v2/lists/${held().id}/log?after=0`]);
  });

  it("comes to the same list however the account service cuts its pages", async () => {
    const phone = await device();
    await phone.list.sync();
    const pcs = [];
    for (const label of ["One", "Two", "Three", "Four", "Five"]) pcs.push(await addPc(phone, label));
    const whole = await reloaded(phone).list.sync();
    // the same device after a reset: it has saved nothing, and finds the list it started again
    const fresh = reloaded({ ...phone, lists: memoryListStore() });
    tamper({ pages: [0, 1, 3] });
    const paged = await fresh.list.sync();
    expect(paged.pcs).toEqual(whole.pcs);
    expect(following(paged)).toMatchObject({ head: 5, trouble: null });
    expect(asked(fresh, `GET /v2/lists/${held().id}/log`)).toBeGreaterThan(2);
  });

  it("is due every 30 seconds in front, not at all behind, and every five minutes while it follows nothing", async () => {
    const phone = await device();
    await phone.list.sync();
    expect([phone.list.due(true), phone.list.due(false)]).toEqual([now + 30_000, null]);
    now += 31_000;
    expect(phone.list.due(true)).toBe(now);
    const waiting = await device();
    await waiting.list.sync();
    expect([waiting.list.due(true), waiting.list.due(false)]).toEqual([now + NO_LIST_SECONDS * 1000, null]);
  });

  it("asks again in five minutes where the account service did not answer, and in a day where it keeps no list for the account", async () => {
    const phone = await device();
    phone.wire.down = true;
    expect(await phone.list.sync()).toEqual({ account: ACCOUNT, status: { at: "off" }, reached: false, devices: [], pcs: [] });
    expect([phone.list.due(true), phone.list.due(false)]).toEqual([now + NO_LIST_SECONDS * 1000, null]);
    phone.wire.down = false;
    fake.listAccounts = "";
    expect((await phone.list.sync()).reached).toBe(true);
    expect([phone.list.due(true), phone.list.due(false)]).toEqual([now + OFF_SECONDS * 1000, null]);
  });

  it("runs one more round for whoever asks while one is under way: the sign-in may have changed under it", async () => {
    const phone = await device();
    const signedIn = (await phone.store.get("session"))!;
    await phone.store.set("session", undefined);
    const first = phone.list.sync();
    await phone.store.set("session", signedIn);
    const [second, third] = [phone.list.sync(), phone.list.sync()];
    expect((await first).account).toBeNull();
    expect(following(await second).standing).toBe("in");
    expect(await third).toEqual(await second);
    expect(asked(phone, "GET /v2/lists/mine")).toBe(2);
  });

  it("writes its copy only when the list moved, and keeps when it last read it in full, and the floor of its clock, in a small record beside it", async () => {
    const phone = await device();
    let writes = 0;
    const swap = phone.lists.swap.bind(phone.lists);
    phone.lists.swap = async (record, account, expected, value) => { const swapped = await swap(record, account, expected, value); if (record === "copy" && swapped) writes += 1; return swapped; };
    await phone.list.sync();
    expect(writes).toBe(1);
    const copy = await phone.lists.get("copy", ACCOUNT);
    // rounds that reach the service move the time of the last full read and the floor of the clock: the long copy is not written for that
    for (let round = 0; round < 3; round += 1) { now += 30_000; await phone.list.sync(); }
    expect([writes, await phone.lists.get("copy", ACCOUNT)]).toEqual([1, copy]);
    expect(await phone.lists.get("times", ACCOUNT)).toEqual({ v: 1, list: held().id, read_at: Math.floor(now / 1000), seen_at: Math.floor(now / 1000) });
    // a round that did not reach it writes neither
    const read = now;
    phone.wire.down = true;
    now += 30_000;
    await phone.list.sync();
    expect([writes, (await phone.lists.get("times", ACCOUNT) as { read_at: number }).read_at]).toEqual([1, Math.floor(read / 1000)]);
    // a page loaded again, with the service away, knows when the list was last read in full
    const again = reloaded(phone);
    again.wire.down = true;
    expect(following(await again.list.sync()).read_at).toBe(Math.floor(read / 1000));
    // the list moved: the copy is written
    phone.wire.down = false;
    await addPc(phone, "Desk");
    now += 5 * MINUTE;
    await phone.list.sync();
    expect(writes).toBe(2);
    // a record that is another list's, or out of form, moves nothing
    await phone.lists.set("times", ACCOUNT, { v: 1, list: "ef".repeat(32), read_at: 9_999_999_999, seen_at: 9_999_999_999 });
    const other = reloaded(phone);
    other.wire.down = true;
    expect(following(await other.list.sync()).read_at).toBe(Math.floor(now / 1000));
  });

  it("tells who listens of each view that differs, and of none that does not", async () => {
    const phone = await device();
    const heard: AccountListView[] = [];
    const stop = phone.list.subscribe((view) => heard.push(view));
    await phone.list.sync();
    now += 30_000;
    await phone.list.sync();
    expect(heard.map((view) => view.status.at)).toEqual(["following", "following"]);
    expect(heard.map((view) => following(view).read_at)).toEqual([Math.floor((now - 30_000) / 1000), Math.floor(now / 1000)]);
    stop();
    await addPc(phone, "Desk");
    await phone.list.sync();
    expect(heard).toHaveLength(2);
  });
});

describe("after a reload", () => {
  it("holds the same list from what it saved, names and all, with the account service away", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    const before = await phone.list.sync();
    const again = reloaded(phone);
    again.wire.down = true;
    const view = await again.list.sync();
    expect(view).toEqual({ ...before, reached: false });
    expect(again.sent).toEqual([]);
    // and goes on from there, with the keys it had
    again.wire.down = false;
    await addPc(phone, "Laptop");
    expect((await again.list.sync()).pcs.map((pc) => pc.name?.label)).toEqual(["Desk", "Laptop"]);
    expect((await again.keys()).enc.key).toBe((await phone.keys()).enc.key);
  });

  it("keeps a list that the account service no longer answers for: off the switch is the service being away", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    const before = await phone.list.sync();
    fake.listAccounts = "";
    const view = await reloaded(phone).list.sync();
    expect([view.pcs, view.devices, view.reached, following(view).trouble]).toEqual([before.pcs, before.devices, false, null]);
  });

  it("reports a save that does not read, and puts nothing in its place", async () => {
    const phone = await device();
    await phone.list.sync();
    const saved = await phone.lists.get("copy", ACCOUNT) as string;
    const damaged = saved.replace(/"read_at":\d+|"read_at":null/, '"read_at":7');
    await phone.lists.set("copy", ACCOUNT, damaged);
    const again = reloaded(phone);
    expect(await again.list.sync()).toEqual({ account: ACCOUNT, status: { at: "damaged", why: "sum" }, reached: true, devices: [], pcs: [] });
    expect(await phone.lists.get("copy", ACCOUNT)).toBe(damaged);
    expect(asked(again, "POST /v2/lists")).toBe(0);
    expect(again.list.due(true)).toBeNull();
    await phone.lists.set("copy", ACCOUNT, { not: "a save" });
    expect((await reloaded(phone).list.sync()).status).toEqual({ at: "damaged", why: "form" });
    // a later build's save is not damage: the device says it needs a newer app, keeps the save, and asks nothing by the clock
    const later = saved.replace(/"v":1\}$/, '"v":2}');
    expect(later).not.toBe(saved);
    await phone.lists.set("copy", ACCOUNT, later);
    const older = reloaded(phone);
    expect((await older.list.sync()).status).toEqual({ at: "newer_save" });
    expect([await phone.lists.get("copy", ACCOUNT), older.list.due(true), asked(older, "POST /v2/lists")]).toEqual([later, null, 0]);
    // a person's reset is the one way on: the device then finds the list it started again
    await again.list.forget(ACCOUNT);
    expect(await phone.lists.get("copy", ACCOUNT)).toBeUndefined();
    expect(following(await again.list.sync()).standing).toBe("in");
  });

  it("takes a save whose state another build wrote: the entries are the truth, and the save is written again as this build writes it", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    const before = await phone.list.sync();
    const saved = await phone.lists.get("copy", ACCOUNT) as string;
    // the same entries with a state that says something else of them, under a sum that holds
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : typeof value === "object" && value !== null ? `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`).join(",")}}`
      : JSON.stringify(value);
    const { sum: _sum, ...body } = JSON.parse(saved) as { sum: string; state: { pcs: Record<string, unknown> } };
    const other = { ...body, state: { ...body.state, pcs: {}, pc_keys: {} } };
    const hex = Array.from(sha256(utf8ToBytes(LIST_SAVE_PREFIX + canonical(other))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const changed = canonical({ ...other, sum: hex });
    expect(changed).not.toBe(saved);
    await phone.lists.set("copy", ACCOUNT, changed);
    const again = reloaded(phone);
    again.wire.down = true;
    expect(await again.list.sync()).toEqual({ ...before, reached: false });
    expect(await phone.lists.get("copy", ACCOUNT)).toBe(saved);
  });

  it("drops what it saved under an account key it no longer has: with a new key it is another device, in no list", async () => {
    const phone = await device();
    await phone.list.sync();
    const session = (await phone.store.get("session"))!;
    await phone.store.clear((kept) => kept.account === session.account);
    const again = reloaded(phone);
    const view = await again.list.sync();
    expect(view.status).toEqual({ at: "not_in", list: held().id, why: "not_mine", claim: "claimed" });
    expect(await phone.lists.get("copy", ACCOUNT)).toBeUndefined();
    expect(asked(again, "POST /v2/lists")).toBe(0);
  });
});

describe("a device whose account key was made anew under a page that stays open", () => {
  it("drops the copy it holds, as a page loaded again does: no view under the key it no longer has", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    expect((await phone.list.sync()).pcs.length).toBe(1);
    const session = (await phone.store.get("session"))!;
    await phone.store.clear((kept) => kept.account === session.account);
    now += 30_000;
    const view = await phone.list.sync();
    expect(view).toMatchObject({ status: { at: "not_in", list: held().id, why: "not_mine" }, devices: [], pcs: [] });
    expect(await phone.lists.get("copy", ACCOUNT)).toBeUndefined();
  });
});

describe("a device that is far behind", () => {
  it("keeps every page it took when a later one does not come, and goes on from there at its next round", async () => {
    const phone = await device();
    await phone.list.sync();
    for (const label of ["One", "Two", "Three", "Four", "Five"]) await addPc(phone, label);
    // each page one entry, as a slow link or a long list makes many pages, and every third request for the log is lost
    tamper({ pages: [1, 2, 3, 4] });
    let logs = 0;
    phone.wire.answer = (request) => {
      if (new URL(request.url).pathname.endsWith("/log") && ++logs % 3 === 0) throw new DOMException("timed out", "TimeoutError");
      return null;
    };
    const heads: number[] = [];
    for (let round = 0; round < 3 && heads.at(-1) !== 5; round += 1) {
      now += 30_000;
      const view = await phone.list.sync();
      const saved = JSON.parse(await phone.lists.get("copy", ACCOUNT) as string) as { entries: string[] };
      // what is shown is what is saved, and a round that took pages is due again at once
      expect(following(view).head).toBe(saved.entries.length - 1);
      heads.push(following(view).head);
      if (following(view).head < 5) expect(phone.list.due(true)).toBe(now);
    }
    expect(heads).toEqual([2, 4, 5]);
    expect(phone.list.view().pcs.map((pc) => pc.name?.label)).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("counts a round whose first page did not come as one that did not reach the account service", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    phone.wire.answer = (request) => { if (new URL(request.url).pathname.endsWith("/log")) throw new DOMException("timed out", "TimeoutError"); return null; };
    now += 30_000;
    const view = await phone.list.sync();
    expect([view.reached, following(view).head]).toEqual([false, 0]);
    expect(phone.list.due(true)).toBe((Math.floor(now / 1000) + UNREACHED_SECONDS[0]!) * 1000);
  });

  it("goes by the copy it saved where the account service's answer does not read, on a page loaded again too", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    const before = await phone.list.sync();
    // the answer is cut off on the way: no JSON
    const again = reloaded(phone);
    again.wire.answer = () => new Response('{"list":"', { status: 200, headers: { "content-type": "application/json" } });
    now += 30_000;
    const view = await again.list.sync();
    expect([view.reached, view.status.at, view.pcs]).toEqual([false, "following", before.pcs]);
    expect(again.list.due(true)).toBe((Math.floor(now / 1000) + UNREACHED_SECONDS[0]!) * 1000);
  });

  it("counts a request that timed out as a round that did not reach the account service, and throws nothing", async () => {
    const phone = await device();
    await phone.list.sync();
    phone.wire.answer = () => { throw new DOMException("timed out", "TimeoutError"); };
    now += 30_000;
    const view = await phone.list.sync();
    expect([view.reached, following(view).standing]).toEqual([false, "in"]);
  });
});

describe("two pages of a browser with no Web Locks", () => {
  it("never save one copy over a newer one: the second page reads what the first saved, the alarm with it", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    await phone.list.sync();
    const keys = await phone.keys();
    const list = held();
    const fork = await otherHistory(keys, () => ({ kind: "carried", endpoint: newPc().endpoint, sealed: null }), list);
    // each page has a lock of its own, as where the browser has none
    const a = reloaded(phone);
    const b = reloaded(phone);
    // page B reads the saved copy, then its first request waits until page A is done
    const gate = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    b.wire.answer = ((request: Request) => new URL(request.url).pathname === "/v2/lists/mine"
      ? (waiting.resolve(), gate.promise.then(() => { b.wire.answer = null; return fake.fetch(request); })) : null) as unknown as Wire["answer"];
    now += 30_000;
    const later = b.list.sync();
    await waiting.promise;
    // page A is shown a fork that a member signed, and saves the alarm with its copy
    tamper({ fork });
    expect(following(await a.list.sync()).trouble).toBe("fork");
    // the service shows page B the honest log, one entry on: B does not write the copy it loaded before A's save
    fake.untamperList(held().id);
    await addPc(phone, "Laptop");
    gate.resolve();
    expect(following(await later).trouble).toBe("fork");
    expect(JSON.parse(await phone.lists.get("copy", ACCOUNT) as string).alarm).not.toBeNull();
    const c = reloaded(phone);
    c.wire.down = true;
    expect(following(await c.list.sync()).trouble).toBe("fork");
  });
});

describe("a leave or a deletion of the account", () => {
  it("ends the round under way instead of waiting for it, and that round writes and shows nothing after", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    // the round's request for the log gets no answer until it is given up
    const hung = Promise.withResolvers<void>();
    phone.wire.answer = ((request: Request) => new URL(request.url).pathname.endsWith("/log")
      ? new Promise<Response>((_, reject) => { hung.resolve(); request.signal.addEventListener("abort", () => reject(request.signal.reason as Error)); }) : null) as unknown as Wire["answer"];
    now += 30_000;
    const round = phone.list.sync();
    await hung.promise;
    await Promise.race([phone.list.forget(ACCOUNT), new Promise((_, reject) => setTimeout(() => reject(new Error("the forget waited for the round")), 2_000))]);
    await round;
    for (const record of LIST_RECORDS) expect(await phone.lists.get(record, ACCOUNT)).toBeUndefined();
    expect(phone.list.view()).toEqual({ account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] });
  });
});

describe("a sign-in that changes under a round", () => {
  it("publishes nothing of the account the round began with", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    const told: AccountListView[] = [];
    phone.list.subscribe((view) => told.push(view));
    // another tab stores another account's sign-in while this round waits for the account service
    // (as the round's last answer comes, the log's: nothing it asks after that would tell it)
    const other = { ...(await phone.store.get("session"))!, account: "acct_other", sign_in_id: "another-sign-in", refresh_token: "another-refresh-token" };
    phone.wire.answer = (request) => { if (new URL(request.url).pathname.endsWith("/log")) void phone.store.set("session", other); return null; };
    now += 30_000;
    const logs = asked(phone, `GET /v2/lists/${held().id}/log`);
    const view = await phone.list.sync();
    expect(asked(phone, `GET /v2/lists/${held().id}/log`)).toBe(logs + 1);
    expect(view).toEqual({ account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] });
    expect(told.filter((each) => each.account === ACCOUNT)).toEqual([]);
  });
});

describe("an account service that lies", () => {
  /** a device that follows a list with one PC in it */
  async function follower(): Promise<{ phone: Device; view: AccountListView; desk: AskingPc }> {
    const phone = await device();
    await phone.list.sync();
    const desk = await addPc(phone, "Desk");
    return { phone, desk, view: await phone.list.sync() };
  }
  const members = (view: AccountListView) => ({ devices: view.devices, pcs: view.pcs });

  it("gets no key in by writing entries of its own: a device, a PC, a removal", async () => {
    const { phone, view, desk } = await follower();
    const pc = newPc();
    for (const lie of [
      await strangers((key) => ({ kind: "carried", key, role: "drive", sealed: null })),
      await strangers(() => ({ kind: "carried", endpoint: pc.endpoint, sealed: null })),
      await strangers(() => ({ kind: "remove", endpoint: desk.endpoint })),
    ]) {
      tamper({ inject: [lie] });
      now += 30_000;
      const shown = await phone.list.sync();
      expect(members(shown)).toEqual(members(view));
      expect(phone.list.holdsPc(pc.endpoint)).toBe(false);
      // an honest service places nothing that no member signed: the device says what it was shown
      expect(following(shown)).toMatchObject({ standing: "in", trouble: "unsigned" });
      fake.untamperList(held().id);
    }
    // and what it wrote is gone from the copy once the log goes on honestly
    const laptop = await addPc(phone, "Laptop");
    now += 30_000;
    const honest = await phone.list.sync();
    expect(honest.pcs.map((row) => row.endpoint)).toEqual([desk.endpoint, laptop.endpoint]);
    expect(following(honest)).toMatchObject({ head: 2, trouble: null });
  });

  it("hides a removal by withholding the tail, and takes nobody out or in by it", async () => {
    const { phone, view, desk } = await follower();
    tamper({ withholdAfter: 1 });
    await removePc(phone, desk);
    now += 30_000;
    const shown = await phone.list.sync();
    expect(members(shown)).toEqual(members(view));
    expect(following(shown)).toMatchObject({ head: 1, trouble: null });
    fake.untamperList(held().id);
    now += 30_000;
    expect((await phone.list.sync()).pcs).toEqual([]);
  });

  it("changes nothing by naming an old head, and the device does not count it as a full read", async () => {
    const { phone, view } = await follower();
    const read = following(view).read_at;
    tamper({ head: { seq: 0, hash: held().id } });
    now += 30_000;
    const shown = await phone.list.sync();
    expect(members(shown)).toEqual(members(view));
    expect(following(shown)).toMatchObject({ head: 1, read_at: read, trouble: null });
  });

  it("is caught showing another history that a member signed: nobody of it comes in, and the alarm stays until a person resets it", async () => {
    const { phone, view, desk } = await follower();
    const keys = await phone.keys();
    const other = newPc();
    const list = held();
    // the same member signed another history from entry 1 (a stolen key, or a device made to), and the service shows that one now
    const fork = await otherHistory(keys, () => ({ kind: "carried", endpoint: other.endpoint, sealed: null }), list);
    const onward = await addPc(phone, "Laptop");
    tamper({ fork });
    now += 30_000;
    const shown = await phone.list.sync();
    expect(members(shown)).toEqual(members(view));
    expect(phone.list.holdsPc(other.endpoint)).toBe(false);
    expect(following(shown)).toMatchObject({ head: 1, standing: "in", trouble: "fork" });
    // it is kept with the copy: a reload says it too
    expect(following(await reloaded(phone).list.sync()).trouble).toBe("fork");
    // the device goes on taking what continues its own history, and lets in nobody it did not hold when the alarm rose
    fake.untamperList(held().id);
    now += 30_000;
    const honest = await phone.list.sync();
    expect(following(honest)).toMatchObject({ head: 2, trouble: "fork" });
    expect(honest.pcs.map((row) => row.endpoint)).toEqual([desk.endpoint]);
    await removePc(phone, desk);
    now += 30_000;
    expect((await phone.list.sync()).pcs).toEqual([]);
    // a person's reset: the device finds the list it started again, as the log has it
    await phone.list.forget(ACCOUNT);
    const reset = await phone.list.sync();
    expect(following(reset)).toMatchObject({ head: 3, trouble: null });
    expect(reset.pcs.map((row) => row.endpoint)).toEqual([onward.endpoint]);
  });

  it("keeps the alarm of another history with its copy: a page loaded again still says so, with the account service away", async () => {
    const { phone } = await follower();
    const keys = await phone.keys();
    const list = held();
    const fork = await otherHistory(keys, () => ({ kind: "carried", endpoint: newPc().endpoint, sealed: null }), list);
    tamper({ fork });
    now += 30_000;
    expect(following(await phone.list.sync()).trouble).toBe("fork");
    const again = reloaded(phone);
    again.wire.down = true;
    expect(following(await again.list.sync()).trouble).toBe("fork");
  });

  it("is caught showing another history that nobody signed under what the device holds", async () => {
    const { phone, view } = await follower();
    const list = held();
    const lie = await signed(await deviceListKeys(memoryAccountStore()), () => ({ kind: "remove", endpoint: "ab".repeat(32) }), { ...list, head: { seq: 0, hash: list.id } });
    tamper({ fork: [lie] });
    now += 30_000;
    const shown = await phone.list.sync();
    expect(members(shown)).toEqual(members(view));
    expect(following(shown)).toMatchObject({ head: 1, standing: "in", trouble: "stuck" });
    // no member signed it, so it is no fork: once the service shows the log again, nothing is left of it
    fake.untamperList(held().id);
    now += 30_000;
    expect(following(await phone.list.sync())).toMatchObject({ head: 1, trouble: null });
  });

  it("is caught changing an entry: nothing from it on is taken", async () => {
    const { phone, view } = await follower();
    await addPc(phone, "Laptop");
    tamper({ flipEntry: { seq: 2 } });
    now += 30_000;
    const shown = await phone.list.sync();
    expect(members(shown)).toEqual(members(view));
    expect(following(shown)).toMatchObject({ head: 1, trouble: "refused" });
    fake.untamperList(held().id);
    now += 30_000;
    expect(following(await phone.list.sync())).toMatchObject({ head: 2, trouble: null });
  });

  it("is caught naming another list for the account, and is no hint where it names none: the device keeps the one it follows, and goes on reading it", async () => {
    const { phone, view, desk } = await follower();
    const mine = held().id;
    const mineIs = (answer: unknown) => (request: Request) => new URL(request.url).pathname === "/v2/lists/mine" ? Response.json(answer) : null;
    // the service says the account has no list: that is no hint and no alarm, and the device starts no other
    phone.wire.answer = mineIs({ list: null, now: 1 });
    now += 30_000;
    const logsBefore = asked(phone, `GET /v2/lists/${mine}/log`);
    const none = await phone.list.sync();
    expect(members(none)).toEqual(members(view));
    expect(following(none)).toMatchObject({ list: mine, standing: "in", trouble: null });
    expect(asked(phone, "POST /v2/lists")).toBe(1);
    // that very round read the list's log, hint or no hint
    expect(asked(phone, `GET /v2/lists/${mine}/log`)).toBeGreaterThan(logsBefore);
    // the service names a list a stranger started for the account
    const stranger = await device({ account: "acct_stranger", genesis: "always" });
    fake.listAccounts = "*";
    await stranger.list.sync();
    const theirs = held("acct_stranger");
    phone.wire.answer = mineIs({ list: theirs.id, head: theirs.head, now: 1 });
    now += 30_000;
    const other = await phone.list.sync();
    expect(members(other)).toEqual(members(view));
    expect(following(other)).toMatchObject({ list: mine, trouble: "other_list" });
    expect(asked(phone, `GET /v2/lists/${theirs.id}/log`)).toBe(0);
    // what it is told of which list is no hint: it still reads its own, so a removal reaches it all the same
    await removePc(phone, desk);
    now += 30_000;
    const read = await phone.list.sync();
    expect([read.pcs, following(read).trouble, following(read).head]).toEqual([[], "other_list", 2]);
    phone.wire.answer = null;
    now += 30_000;
    expect(following(await phone.list.sync()).trouble).toBeNull();
  });

  it("counts a round as not reached where it names another list and the device's own log does not answer, and waits longer", async () => {
    const { phone, view } = await follower();
    const stranger = await device({ account: "acct_stranger", genesis: "always" });
    fake.listAccounts = "*";
    await stranger.list.sync();
    const theirs = held("acct_stranger");
    phone.wire.answer = (request) => {
      const { pathname } = new URL(request.url);
      return pathname === "/v2/lists/mine" ? Response.json({ list: theirs.id, head: theirs.head, now: 1 }) : pathname.endsWith("/log") ? new Response("away", { status: 503 }) : null;
    };
    now += 30_000;
    const other = await phone.list.sync();
    expect([other.reached, following(other).trouble, members(other)]).toEqual([false, "other_list", members(view)]);
    expect(phone.list.due(true)).toBe((Math.floor(now / 1000) + UNREACHED_SECONDS[0]!) * 1000);
  });

  it("is caught answering with another list's log under this list's id: none of it is taken", async () => {
    const { phone, view } = await follower();
    const stranger = await device({ account: "acct_stranger", genesis: "always" });
    fake.listAccounts = "*";
    await stranger.list.sync();
    const mine = held().id;
    const theirs = held("acct_stranger");
    const lie = (request: Request): Response | null => {
      const { pathname } = new URL(request.url);
      if (pathname === "/v2/lists/mine") return Response.json({ list: mine, head: theirs.head });
      return pathname === `/v2/lists/${mine}/log` ? Response.json({ list: mine, after: null, entries: theirs.entries, head: theirs.head, more: false }) : null;
    };
    phone.wire.answer = lie;
    now += 30_000;
    const shown = await phone.list.sync();
    expect(members(shown)).toEqual(members(view));
    expect(following(shown)).toMatchObject({ head: 1, standing: "in" });
    expect(following(shown).trouble).not.toBeNull();
    // a device that has saved nothing takes no entry 0 but the one with the id it was told, and keeps nothing.
    // It was not shown that list's entry 0, so it does not take the list for another's: it asks again
    const fresh = reloaded({ ...phone, lists: memoryListStore() });
    fresh.wire.answer = lie;
    expect(await fresh.list.sync()).toEqual({ account: ACCOUNT, status: { at: "not_in", list: mine, why: "unread", claim: "unclaimed" }, reached: true, devices: [], pcs: [] });
    expect(await fresh.lists.get("copy", ACCOUNT)).toBeUndefined();
    fresh.wire.answer = null;
    now += NO_LIST_SECONDS * 1000;
    expect(following(await fresh.list.sync())).toMatchObject({ list: mine, standing: "in" });
    // the fake's own lie of this kind names the other list as the account's, and serves its log for this list's too:
    // the device keeps to its own, reads none of the other's, and says the worse of the two things it was shown
    phone.wire.answer = null;
    tamper({ answerList: theirs.id });
    now += 30_000;
    const named = await phone.list.sync();
    expect(members(named)).toEqual(members(view));
    expect(following(named)).toMatchObject({ list: mine, head: 1, standing: "in", trouble: "stuck" });
    expect(asked(phone, `GET /v2/lists/${theirs.id}/log`)).toBe(0);
  });

  it("lets a PC in only by a member's signature, also where it drops its own second lock", async () => {
    const { phone, desk } = await follower();
    const keys = await phone.keys();
    const pc = newPc();
    const [signing, enc] = [await deviceListKeys(memoryAccountStore()), await deviceListKeys(memoryAccountStore())];
    const card = (list: string) => signCard({ key: signing.key, enc: enc.enc.key, list, endpoint: pc.endpoint, invite: null }, signing.signs);
    // the PC never posted its keys to the service: an honest service places no such entry, and a lying one may show it
    const byStranger = await strangers(() => ({ kind: "carried", endpoint: pc.endpoint, sealed: null }));
    tamper({ inject: [byStranger] });
    now += 30_000;
    await phone.list.sync();
    expect([phone.list.holdsPc(pc.endpoint), phone.list.pcOfKey(signing.key)]).toEqual([false, null]);
    fake.untamperList(held().id);
    const byMember = await signed(keys, async () => ({ kind: "pc", key: signing.key, endpoint: pc.endpoint, enc: enc.enc.key, card: await card(held().id), sealed: null }));
    tamper({ inject: [byMember] });
    now += 30_000;
    const shown = await phone.list.sync();
    expect(shown.pcs.map((row) => [row.endpoint, row.how, row.allows, row.name])).toEqual([[desk.endpoint, "added", true, { label: "Desk", os: "linux" }], [pc.endpoint, "added", true, null]]);
    expect([phone.list.holdsPc(pc.endpoint), phone.list.pcOfKey(signing.key), phone.list.pcOfKey(keys.key)]).toEqual([true, pc.endpoint, null]);
    expect(following(shown).trouble).toBeNull();
  });

  it("is caught handing over a key to the names that is not the list's: the names stay shut, and who is in does not change", async () => {
    const { phone, view } = await follower();
    const keys = await phone.keys();
    // the device lost its wraps, and the service answers with a wrap of a key of its own
    await phone.lists.set("wraps", ACCOUNT, undefined);
    const forged = await wrapEpochKey({ list: held().id, epoch: { epoch: 0, key: new Uint8Array(32).fill(9) }, member: keys.enc.key });
    tamper({ wraps: [{ epoch: 0, member: keys.enc.key, wrap: wrapToText(forged!) }] });
    const again = reloaded(phone);
    const shown = await again.list.sync();
    expect(shown.pcs.map((row) => [row.endpoint, row.name])).toEqual(view.pcs.map((row) => [row.endpoint, null]));
    expect(shown.devices.map((row) => [row.key, row.name])).toEqual(view.devices.map((row) => [row.key, null]));
    expect(following(shown)).toMatchObject({ standing: "in", trouble: "wrong_key" });
    // the wrong key is not kept: it is not asked for again at once, and the names open once the service hands over the right one
    expect(readWraps(await phone.lists.get("wraps", ACCOUNT), held().id, keys.enc.key).wraps.size).toBe(0);
    fake.untamperList(held().id);
    now += 30_000;
    expect(following(await again.list.sync()).trouble).toBe("wrong_key");
    expect(asked(again, `GET /v2/lists/${held().id}/wraps`)).toBe(1);
    now += NO_LIST_SECONDS * 1000;
    const honest = await again.list.sync();
    expect([members(honest), following(honest).trouble]).toEqual([members(view), null]);
  });

  it("hides the names by spoiling a wrap, which is no evidence: rows without names, and no alarm", async () => {
    const { phone, view } = await follower();
    const keys = await phone.keys();
    await phone.lists.set("wraps", ACCOUNT, undefined);
    tamper({ flipWrap: { member: keys.enc.key, epoch: 0 } });
    const shown = await reloaded(phone).list.sync();
    expect(shown.pcs.map((row) => [row.endpoint, row.name])).toEqual(view.pcs.map((row) => [row.endpoint, null]));
    expect(following(shown)).toMatchObject({ standing: "in", trouble: null });
  });

  it("withholds entry 0 of the list it names: the device follows nothing, keeps its genesis, and asks again", async () => {
    const phone = await device();
    phone.wire.loseAnswerOf = "POST /v2/lists";
    await phone.list.sync();
    const mine = held().id;
    const again = reloaded(phone);
    again.wire.answer = (request) => new URL(request.url).pathname === `/v2/lists/${mine}/log` ? Response.json({ list: mine, after: null, entries: [], head: { seq: 0, hash: mine }, more: true }) : null;
    expect((await again.list.sync()).status).toEqual({ at: "not_in", list: mine, why: "unread", claim: "unclaimed" });
    expect(await phone.lists.get("genesis", ACCOUNT)).toBeDefined();
    expect(again.list.due(true)).toBe(now + NO_LIST_SECONDS * 1000);
    again.wire.answer = null;
    now += NO_LIST_SECONDS * 1000;
    const view = await again.list.sync();
    expect(following(view)).toMatchObject({ list: mine, standing: "in" });
    expect(view.devices[0]!.name).toEqual({ label: "Dana's phone", os: "ios" });
  });

  it("names a list whose entry 0 is of a later build's form: the device says it needs a newer app, and follows nothing", async () => {
    const phone = await device({ genesis: "never" });
    const keys = await phone.keys();
    const body = kindBody({ issued_at: 1, list: "", prev: "", seq: 0, signer: keys.key }, { kind: "genesis", account: ACCOUNT, enc: keys.enc.key, opens: "ab".repeat(32), sealed: null });
    const later = await signEntry({ ...body, v: 2 }, keys.signs);
    const [text, list] = [entryToText(later), entryHash(later.body)];
    phone.wire.answer = (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/v2/lists/mine") return Response.json({ list, head: { seq: 0, hash: list } });
      return pathname === `/v2/lists/${list}/log` ? Response.json({ list, after: null, entries: [text], head: { seq: 0, hash: list }, more: false }) : null;
    };
    expect(await phone.list.sync()).toEqual({ account: ACCOUNT, status: { at: "not_in", list, why: "needs_newer_client", claim: "unclaimed" }, reached: true, devices: [], pcs: [] });
    expect(await phone.lists.get("copy", ACCOUNT)).toBeUndefined();
  });

  it("shows a new device another account's list, or one a stranger started, and the device follows neither", async () => {
    const phone = await device({ genesis: "never" });
    const stranger = await device({ genesis: "always" });
    await stranger.list.sync();
    const view = await phone.list.sync();
    expect(view).toEqual({ account: ACCOUNT, status: { at: "not_in", list: held().id, why: "not_mine", claim: "claimed" }, reached: true, devices: [], pcs: [] });
    expect(await phone.lists.get("copy", ACCOUNT)).toBeUndefined();
    expect(phone.list.holdsPc("ab".repeat(32))).toBe(false);
  });
});

describe("when a sign-in ends", () => {
  it("forgets what opens the names and keeps its copy: it is the same member at the next sign-in, and asks for the keys again", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    const before = await phone.list.sync();
    const copy = await phone.lists.get("copy", ACCOUNT);
    const told: AccountListView[] = [];
    phone.list.subscribe((view) => told.push(view));
    await phone.list.dropNames(ACCOUNT);
    expect([await phone.lists.get("wraps", ACCOUNT), await phone.lists.get("genesis", ACCOUNT)]).toEqual([undefined, undefined]);
    expect(await phone.lists.get("copy", ACCOUNT)).toBe(copy);
    // the page that had the names open holds them no more, and whoever listens is told: who is in is as before
    const closed = { ...before, devices: before.devices.map((row) => ({ ...row, name: null })), pcs: before.pcs.map((row) => ({ ...row, name: null })) };
    expect([phone.list.view(), told]).toEqual([closed, [closed]]);
    // another account's view is not touched by it
    await phone.list.dropNames("acct_other");
    expect(told.length).toBe(1);
    // with the account service away nobody's name opens, and who is in is as before
    const away = reloaded(phone);
    away.wire.down = true;
    const unnamed = await away.list.sync();
    expect([unnamed.devices.map((row) => [row.key, row.name]), unnamed.pcs.map((row) => [row.endpoint, row.name])])
      .toEqual([before.devices.map((row) => [row.key, null]), before.pcs.map((row) => [row.endpoint, null])]);
    // signed in again: the wraps come from the account service, checked against the list as ever
    now += 30_000;
    const again = reloaded(phone);
    expect(await again.list.sync()).toEqual({ ...before, status: { ...following(before), read_at: Math.floor(now / 1000) } });
    expect(asked(again, `GET /v2/lists/${held().id}/wraps`)).toBe(1);
  });

  it("forgets a genesis that was not seen placed, and signs no other when the account service took it", async () => {
    const phone = await device();
    phone.wire.loseAnswerOf = "POST /v2/lists";
    await phone.list.sync();
    const mine = held().id;
    await phone.list.dropNames(ACCOUNT);
    const again = reloaded(phone);
    const view = await again.list.sync();
    expect(following(view)).toMatchObject({ list: mine, standing: "in" });
    expect(view.devices[0]!.name).toEqual({ label: "Dana's phone", os: "ios" });
    expect([asked(again, "POST /v2/lists"), held().entries.length]).toEqual([0, 1]);
  });
});

describe("what a device keeps for an account", () => {
  it("is forgotten whole on a person's reset", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    await phone.list.sync();
    await phone.list.shadow(ACCOUNT, [], new Set());
    await phone.list.forget(ACCOUNT);
    for (const record of LIST_RECORDS) expect(await phone.lists.get(record, ACCOUNT)).toBeUndefined();
    expect(phone.list.view()).toEqual({ account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] });
  });

  it("holds no private key and no epoch key: the save, the wraps and the record of differences are text and numbers", async () => {
    const phone = await device();
    await phone.list.sync();
    await addPc(phone, "Desk");
    await phone.list.sync();
    await phone.list.shadow(ACCOUNT, [], new Set());
    const key = await epochKey(phone);
    const hex = Array.from(key.key, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const plain = (kept: unknown): void => {
      expect(kept).toBeDefined();
      const text = JSON.stringify(kept);
      expect(text).not.toContain(hex);
      expect(text).not.toContain("Desk");
      expect(text).not.toContain("Dana");
      expect(JSON.parse(text)).toEqual(kept);
    };
    for (const record of ["copy", "wraps", "shadow"] as const) plain(await phone.lists.get(record, ACCOUNT));
    // a genesis is kept only until the device sees it placed: one whose request never arrived is still there
    fake.listAccounts = "*";
    const waiting = await device({ account: "acct_waiting" });
    waiting.wire.dropRequestOf = "POST /v2/lists";
    await waiting.list.sync();
    plain(await waiting.lists.get("genesis", "acct_waiting"));
  });

  it("records where the list and the directory differ, for the account in view only", async () => {
    const phone = await device();
    await phone.list.sync();
    const desk = await addPc(phone, "Desk");
    await phone.list.sync();
    const row = (id: string) => ({ server_id: id, label: "x", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: null, relay: null, new_until: null, admitted_at: null, admitted_before_you: false });
    const stray = newPc();
    const record = await phone.list.shadow(ACCOUNT, [row(desk.server_id), row(stray.server_id)], new Set([stray.server_id]));
    expect(record).toMatchObject({ compared: 1, differed: 1, last: { both: 1, list_only: [], service_only: [{ server_id: stray.server_id, seen: false, opens: true }] } });
    expect(await phone.list.shadow("acct_other", [], new Set())).toBeNull();
  });

  it("counts every comparison, also two that are made at once", async () => {
    const phone = await device();
    await phone.list.sync();
    await Promise.all([phone.list.shadow(ACCOUNT, [], new Set()), phone.list.shadow(ACCOUNT, [], new Set()), phone.list.shadow(ACCOUNT, [], new Set())]);
    expect(await phone.lists.get("shadow", ACCOUNT)).toMatchObject({ compared: 3 });
  });
});
