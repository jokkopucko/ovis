import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalBase64Url, entryFromText, entryHash, entryToText, readBody, signEntry, verifySignature, type EntryBody } from "./account-list-entry.ts";
import { kindBody, replayList, shownList, signCard, type ListKind, type Sealed } from "./account-list.ts";
import { inviteRedeemBytes, lineChallenge, lineProofBytes } from "./account-list-invite.ts";
import { linkBytes } from "./account-list-migrate.ts";
import type { ListPlace } from "./account-list-signers.ts";
import { newRecordId, pcAddSigningBytes, signSafetyRecord, type PcAddPurpose } from "./account-records.ts";
import { FakeAccountService, LIST_CLAIM_MS, type ListAttempt, type ListWrap } from "./account-service-fake.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";
import { answerServerChallenge, deriveServerId } from "./relay-server-proof.ts";

const BASE = "https://account.test";
const ACCOUNT = "acct_1";
const T0 = Date.UTC(2026, 10, 24, 12);
const MINUTE = 60_000;

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const spki = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));

interface Key { readonly key: string; readonly enc: string; readonly pair: CryptoKeyPair }
async function newKey(): Promise<Key> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const enc = await spki((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])).publicKey);
  return { key: await spki(pair.publicKey), enc, pair };
}

/** Names as an entry carries them, under epoch 0 unless said: bytes the service never opens. */
const sealed = (epoch = 0): Sealed => ({ epoch, bytes: Uint8Array.from({ length: 60 }, (_, index) => index) });
const OPENS = (epoch: number) => (epoch + 10).toString(16).padStart(2, "0").repeat(32);
/** A wrap as the service sees one: 151 characters, checked for their length and spelling only. */
const WRAP = (n: number) => toBase64Url(new Uint8Array(113).fill(n));

interface Place { readonly seq: number; readonly list: string; readonly prev: string }
interface Signed { readonly text: string; readonly head: ListPlace }
async function sign(by: Key, place: Place, kind: ListKind, issuedAt: number): Promise<Signed> {
  const entry = await signEntry(kindBody({ ...place, issued_at: issuedAt, signer: by.key }, kind), by.pair.privateKey);
  return { text: entryToText(entry), head: { seq: place.seq, hash: entryHash(entry.body) } };
}
/** Entries signed one after the other from `head` on: their texts, and the head after the last. */
async function chain(list: string, head: ListPlace, steps: readonly (readonly [Key, ListKind])[], issuedAt: number): Promise<{ texts: string[]; head: ListPlace }> {
  const texts: string[] = [];
  let at = head;
  for (const [by, kind] of steps) {
    const signed = await sign(by, { seq: at.seq + 1, list, prev: at.hash }, kind, issuedAt);
    texts.push(signed.text);
    at = signed.head;
  }
  return { texts, head: at };
}

const cardOf = (key: Key, list: string, endpoint: string | null = null, invite: string | null = null) => signCard({ key: key.key, enc: key.enc, list, endpoint, invite }, key.pair.privateKey);
const genesisOf = (owner: Key, account = ACCOUNT): ListKind => ({ kind: "genesis", account, enc: owner.enc, opens: OPENS(0), sealed: sealed() });
const deviceOf = async (key: Key, list: string, rotates = false, card?: string): Promise<ListKind> =>
  ({ kind: "device", key: key.key, power: "full", role: "drive", until: null, enc: key.enc, card: card ?? await cardOf(key, list), sealed: sealed(), rotates });
const pcOf = async (key: Key, list: string, endpoint: string): Promise<ListKind> => ({ kind: "pc", key: key.key, endpoint, enc: key.enc, card: await cardOf(key, list, endpoint), sealed: sealed() });
const inviteOf = (key: Key, exp: number, auto = true, uses = 1, names: Sealed | null = sealed()): ListKind => ({ kind: "invite", key: key.key, exp, uses, auto, sealed: names });
const joinOf = async (key: Key, list: string, endpoint: string, invite: Key, names: Sealed | null = sealed()): Promise<ListKind> =>
  ({ kind: "join", endpoint, pc: key.key, enc: key.enc, card: await cardOf(key, list, endpoint, invite.key), sealed: names });
const removeOf = (key: Key): ListKind => ({ kind: "remove", ends: key.key });
const epochOf = (epoch: number): ListKind => ({ kind: "epoch", epoch, opens: OPENS(epoch + 1), link: new Uint8Array(61) });

interface Answer {
  readonly now: number;
  readonly error?: { readonly code: string; readonly message?: string; readonly index?: number; readonly outcome?: string; readonly reason?: string | null; readonly head?: ListPlace; readonly list?: string };
  readonly list?: string | null | { readonly id: string; readonly head: ListPlace };
  readonly head?: ListPlace;
  readonly after?: number | null;
  readonly entries?: readonly string[];
  readonly more?: boolean;
  readonly placed?: number;
  readonly wraps?: readonly { readonly epoch: number; readonly wrap: string }[];
  readonly claims?: readonly { readonly key: string; readonly enc: string; readonly card: string; readonly until: number }[];
  readonly posts?: readonly { readonly endpoint: string; readonly server_id: string; readonly key: string; readonly enc: string; readonly card: string; readonly until: number; readonly attempt: ListAttempt | null }[];
  readonly attempt?: ListAttempt | null;
  readonly key?: string;
  readonly endpoint?: string;
  readonly until?: number;
}
interface Called { readonly status: number; readonly body: Answer; readonly headers: Headers }

/** One world: a fake service on a clock the test moves, with every account on the list switch, and the account's first device. */
async function world() {
  let clock = T0;
  const service = new FakeAccountService(() => clock);
  service.listAccounts = "*";
  const owner = await newKey();
  const token = service.issueToken(ACCOUNT);
  const call = async (method: string, path: string, body?: unknown, bearer?: string): Promise<Called> => {
    const response = await service.fetch(new Request(BASE + path, {
      method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      headers: { "content-type": "application/json", ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    }));
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Answer, headers: response.headers };
  };
  const tick = (ms: number) => { clock += ms; };
  const seconds = () => Math.floor(clock / 1000);
  const place = (list: string, entries: readonly string[], wraps?: readonly ListWrap[], bearer = token) =>
    call("POST", `/v2/lists/${list}/entries`, { entries, ...(wraps === undefined ? {} : { wraps }) }, bearer);
  const claim = async (list: string, key: Key, bearer = token, more: Record<string, unknown> = {}) =>
    call("POST", `/v2/lists/${list}/claims`, { key: key.key, enc: key.enc, card: await cardOf(key, list), ...more }, bearer);
  const log = (list: string, query = "", bearer = token) => call("GET", `/v2/lists/${list}/log${query}`, undefined, bearer);
  /** The account's list, started by the owner with its own wrap. */
  const start = async (wraps: readonly ListWrap[] = [{ epoch: 0, member: owner.enc, wrap: WRAP(1) }]) => {
    const first = await sign(owner, { seq: 0, list: "", prev: "" }, genesisOf(owner), seconds());
    const made = await call("POST", "/v2/lists", { entry: first.text, wraps }, token);
    expect(made.status).toBe(201);
    return { list: made.body.list as string, head: made.body.head!, first: first.text };
  };
  return { service, owner, token, call, tick, seconds, place, claim, log, start };
}
type World = Awaited<ReturnType<typeof world>>;

const code = (called: Called) => called.body.error?.code;
const refusal = (called: Called) => `${called.status} ${code(called)}`;

function machine() {
  const keys = x25519.keygen();
  return { keys, serverId: deriveServerId(keys.publicKey), endpoint: bytesToHex(keys.publicKey) };
}
type Machine = ReturnType<typeof machine>;

/** A PC's relay-key proof for one call: a challenge of POST /v1/pc/challenge, answered with role `account`. */
async function proof(w: World, pc: Machine): Promise<Record<string, string>> {
  const challenge = await (await w.service.fetch(new Request(`${BASE}/v1/pc/challenge`, { method: "POST", body: JSON.stringify({ server_id: pc.serverId, public_key: pc.endpoint }) }))).json() as { challenge_id: string; frame: string };
  const answer = answerServerChallenge(challenge.frame, pc.keys.secretKey, { server_id: pc.serverId, role: "account", connection_id: challenge.challenge_id });
  return { server_id: pc.serverId, public_key: pc.endpoint, challenge_id: challenge.challenge_id, proof: answer! };
}
const pcCall = async (w: World, pc: Machine, path: string, body: Record<string, unknown>) => w.call("POST", path, { ...(await proof(w, pc)), ...body });

/** The account lists the PC, as an app's own sign-in does (confirmed), or as a device code's sign-in does while Step 2 is on (unconfirmed). */
async function listPc(w: World, pc: Machine, bearer = w.token): Promise<void> {
  const listed = await w.call("PUT", `/v1/pcs/${pc.serverId}`, { label: "tower", public_key: pc.endpoint, relay: "wss://relay.test" }, bearer);
  expect(listed.status).toBe(200);
}

/** The mailbox pull of a PC, with `with_list` unless said. */
async function pull(w: World, pc: Machine, withList = true): Promise<Record<string, unknown>> {
  const response = await w.service.fetch(new Request(`${BASE}/v1/pc/mailbox`, { method: "POST", body: JSON.stringify({ ...(await proof(w, pc)), ack: null, account: ACCOUNT, ...(withList ? { with_list: true } : {}) }) }));
  return await response.json() as Record<string, unknown>;
}

/** A key proof by `signer` (the key `bearer`'s sign-in registered) for this purpose, list id and slot, on a challenge of POST /v1/pcs/challenge. */
async function keyProof(w: World, bearer: string, signer: Key, purpose: PcAddPurpose, list: string, slot = "") {
  const challenge = await (await w.service.fetch(new Request(`${BASE}/v1/pcs/challenge`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${bearer}` } }))).json() as { challenge_id: string; challenge: string };
  const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, signer.pair.privateKey, pcAddSigningBytes(purpose, ACCOUNT, list, slot, challenge.challenge_id, challenge.challenge))));
  return { challenge_id: challenge.challenge_id, signature };
}

/** A device let in after `at`: its own sign-in's claim, then the owner's `device` entry. */
async function addDevice(w: World, list: string, at: ListPlace, names: Sealed | null = sealed()): Promise<{ key: Key; head: ListPlace }> {
  const key = await newKey();
  expect((await w.claim(list, key, w.service.issueToken(ACCOUNT))).status).toBe(200);
  const added = await chain(list, at, [[w.owner, { ...(await deviceOf(key, list)), sealed: names } as ListKind]], w.seconds());
  expect((await w.place(list, added.texts)).status).toBe(200);
  return { key, head: added.head };
}

/** A PC a person added after `at`: listed by an own sign-in, its keys posted with its own proof, then the owner's `pc` entry. */
async function addPc(w: World, list: string, at: ListPlace): Promise<{ pc: Machine; key: Key; head: ListPlace }> {
  const pc = machine();
  await listPc(w, pc);
  const key = await newKey();
  expect((await pcCall(w, pc, "/v2/pc/list/keys", { list, key: key.key, enc: key.enc, card: await cardOf(key, list, pc.endpoint) })).status).toBe(200);
  const added = await chain(list, at, [[w.owner, await pcOf(key, list, pc.endpoint)]], w.seconds());
  expect((await w.place(list, added.texts)).status).toBe(200);
  return { pc, key, head: added.head };
}

/** `pc` redeems the service's invite of `pool`'s key (made when its `invite` entry was placed, D11.5) with the line's key. */
async function redeemCall(w: World, pc: Machine, pool: Key, account = ACCOUNT): Promise<Called> {
  const proved = await proof(w, pc);
  const bytes = inviteRedeemBytes({ account, server_id: pc.serverId, public_key: pc.endpoint, challenge_id: proved.challenge_id! });
  const invite_signature = toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, pool.pair.privateKey, bytes)));
  return await w.call("POST", "/v1/pc-invites/redeem", { invite_key: pool.key, invite_signature, relay: "wss://relay.test", label: "joined", ...proved });
}
/** The redeem a join's second lock asks for. */
async function redeem(w: World, pc: Machine, pool: Key): Promise<void> {
  expect((await redeemCall(w, pc, pool)).status).toBe(200);
}

/** A counter of the fake's, as it stands: what the service keeps in its counters table. */
const counted = (w: World, key: string): number => (w.service as unknown as { counters: Map<string, { count: number }> }).counters.get(key)?.count ?? 0;

/** An own sign-in older than ten minutes, with its own registered account key. */
function staleSignIn(w: World, key: Key): string {
  const bearer = w.service.issueToken(ACCOUNT);
  w.service.registerSessionKey(bearer, key.key, "phone");
  w.tick(11 * MINUTE);
  return bearer;
}

/** A sign-in of the account that registered its own device key (POST /v1/devices): Step 2 lets that key in unless said. */
function signedIn(w: World, key: Key, eligible = true): string {
  const bearer = w.service.issueToken(ACCOUNT);
  if (!eligible) w.service.registerDevice(ACCOUNT, key.key, "device", false);
  w.service.registerSessionKey(bearer, key.key, "device");
  return bearer;
}

/** A link of the member key to the registered key `device` (D11.2): both keys' signatures over the library's bytes. */
async function linkOf(list: string, member: Key, device: Key, account = ACCOUNT): Promise<{ member: string; device: string }> {
  const bytes = new Uint8Array(linkBytes({ account, list, key: member.key, device: device.key }));
  const by = async (key: Key) => toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, key.pair.privateKey, bytes)));
  return { member: await by(member), device: await by(device) };
}

/** The account's list started by a sign-in that registered its own key and links the owner's member key to it. */
async function startLinked(w: World): Promise<{ list: string; head: ListPlace; ownerReg: Key; ownerTok: string }> {
  const ownerReg = await newKey();
  const ownerTok = signedIn(w, ownerReg);
  const first = await sign(w.owner, { seq: 0, list: "", prev: "" }, genesisOf(w.owner), w.seconds());
  const made = await w.call("POST", "/v2/lists", { entry: first.text, wraps: [{ epoch: 0, member: w.owner.enc, wrap: WRAP(1) }], link: await linkOf(first.head.hash, w.owner, ownerReg) }, ownerTok);
  expect(made.status).toBe(201);
  return { list: first.head.hash, head: made.body.head!, ownerReg, ownerTok };
}

/** A device the owner lets in after `at`: its own sign-in (which Step 2 does not let in unless said) claims it, with its link unless said. */
async function addLinked(w: World, list: string, at: ListPlace, { eligible = false, link = true } = {}): Promise<{ key: Key; reg: Key; bearer: string; head: ListPlace }> {
  const key = await newKey();
  const reg = await newKey();
  const bearer = signedIn(w, reg, eligible);
  expect((await w.claim(list, key, bearer, link ? { link: await linkOf(list, key, reg) } : {})).status).toBe(200);
  const added = await chain(list, at, [[w.owner, await deviceOf(key, list)]], w.seconds());
  expect((await w.place(list, added.texts)).status).toBe(200);
  return { key, reg, bearer, head: added.head };
}

/** What a PC the account lists reads in the snapshot's first page: each listed key's eligibility, and the removed keys. */
async function snapshotOf(w: World, pc: Machine): Promise<{ eligible: Record<string, boolean>; removed: string[] }> {
  const read = await pcCall(w, pc, "/v1/pc/snapshot", { account: ACCOUNT });
  expect(read.status).toBe(200);
  const page = read.body as unknown as { devices: { key: string; eligible: boolean }[]; removed: { key: string }[] };
  return { eligible: Object.fromEntries(page.devices.map(({ key, eligible }) => [key, eligible])), removed: page.removed.map(({ key }) => key) };
}

const carriedKey = (key: Key): ListKind => ({ kind: "carried", key: key.key, role: "drive", sealed: sealed() });
const carriedPc = (pc: Machine): ListKind => ({ kind: "carried", endpoint: pc.endpoint, sealed: sealed() });

/** A birth's texts (F10b): entry 0 by `first`, a `carried` for each of `carried`, the hand-over to `next` and the epoch it opens. */
async function birthOf(w: World, first: Key, next: Key, carried: readonly ListKind[], account = ACCOUNT): Promise<{ list: string; entry: string; entries: string[]; head: ListPlace }> {
  const zero = await sign(first, { seq: 0, list: "", prev: "" }, genesisOf(first, account), w.seconds());
  const list = zero.head.hash;
  const run = await chain(list, zero.head, [...carried.map((kind) => [first, kind] as const), [first, await deviceOf(next, list, true)], [next, epochOf(0)]], w.seconds());
  return { list, entry: zero.text, entries: run.texts, head: run.head };
}

/** The line's proof a PC that joined by a plain invite posts with its keys: the line key's signature over lineProofBytes for its card. */
async function lineProof(list: string, pc: Machine, card: Key, line: Key, account = ACCOUNT): Promise<string> {
  const bytes = lineProofBytes({ account, server_id: pc.serverId, list, card: { key: card.key, enc: card.enc, endpoint: pc.endpoint } });
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, line.pair.privateKey, bytes)));
}

/** A redeem signature by the line over the line challenge of a card, which a lying service can ask a line for: never a line's proof. */
async function redeemOverLineChallenge(list: string, pc: Machine, card: Key, line: Key): Promise<string> {
  const bytes = inviteRedeemBytes({ account: ACCOUNT, server_id: pc.serverId, public_key: pc.endpoint, challenge_id: lineChallenge(list, { key: card.key, enc: card.enc, endpoint: pc.endpoint }) });
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, line.pair.privateKey, bytes)));
}

const rowOf = <Row>(rows: { readonly [name: string]: Row }, name: string): Row | undefined => (Object.hasOwn(rows, name) ? rows[name] : undefined);

describe("the fake account service's list routes (Part D)", () => {
  describe("the switch and what every answer carries", () => {
    test("off the switch every route answers as an unknown one, the mailbox's with_list says null, and the list is kept", async () => {
      const w = await world();
      const { list } = await w.start();
      const pc = machine();
      await listPc(w, pc);
      w.service.listAccounts = "acct_2,acct_3";
      for (const [method, path] of [["GET", "/v2/lists/mine"], ["POST", "/v2/lists"], ["GET", `/v2/lists/${list}/log`], ["GET", `/v2/lists/${list}/wraps?member=x`],
        ["POST", `/v2/lists/${list}/entries`], ["POST", `/v2/lists/${list}/claims`], ["GET", `/v2/lists/${list}/claims`], ["GET", `/v2/lists/${list}/posts`]] as const) {
        const answered = await w.call(method, path, method === "POST" ? {} : undefined, w.token);
        expect([refusal(answered), typeof answered.body.now]).toEqual(["404 not_found", "number"]);
      }
      for (const [path, body] of [["/v2/pc/list", { account: ACCOUNT }], ["/v2/pc/list/log", { list }], ["/v2/pc/list/wraps", { list, member: w.owner.enc }],
        ["/v2/pc/list/entries", { list, entries: ["x.y"] }], ["/v2/pc/list/keys", { list, key: "k", enc: "e", card: "c".repeat(86) }]] as const) {
        expect(refusal(await pcCall(w, pc, path, body))).toBe("404 not_found");
      }
      // with only some accounts named, a missing sign-in is not told apart from an account that is not named
      expect(refusal(await w.call("GET", "/v2/lists/mine"))).toBe("404 not_found");
      expect((await pull(w, pc)).list).toBeNull();
      w.service.listAccounts = ` acct_2, ${ACCOUNT} `;
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body.list).toBe(list);
      expect(((await pull(w, pc)).list as { id: string }).id).toBe(list);
      w.service.listAccounts = "";
      expect(refusal(await w.call("GET", "/v2/lists/mine", undefined, w.token))).toBe("404 not_found");
    });

    test("every answer carries now in seconds and no-store; a body out of form, a dead token, an unknown route and another account's list are refused", async () => {
      const w = await world();
      const { list } = await w.start();
      const mine = await w.call("GET", "/v2/lists/mine", undefined, w.token);
      expect([mine.body.now, mine.headers.get("cache-control")]).toEqual([w.seconds(), "no-store"]);
      expect(refusal(await w.call("GET", "/v2/lists/mine"))).toBe("401 unauthorized");
      expect(refusal(await w.call("GET", "/v2/lists/mine", undefined, "nope"))).toBe("401 unauthorized");
      expect(refusal(await w.call("GET", "/v2/lists/other", undefined, w.token))).toBe("404 not_found");
      expect(refusal(await w.call("PUT", `/v2/lists/${list}/entries`, {}, w.token))).toBe("404 not_found");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, "{", w.token))).toBe("400 invalid_json");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: ["x"], extra: 1 }, w.token))).toBe("400 invalid_request");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: [] }, w.token))).toBe("400 invalid_request");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: Array(17).fill("x") }, w.token))).toBe("400 invalid_request");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: ["x".repeat(600 * 1024)] }, w.token))).toBe("413 too_large");
      // any sign-in of the account reads, a device code's included; another account's sign-in sees no such list
      expect((await w.log(list, "", w.service.issueToken(ACCOUNT, { device: true }))).status).toBe(200);
      expect(refusal(await w.log("0".repeat(64)))).toBe("404 not_found");
      expect(refusal(await w.log("short"))).toBe("404 not_found");
      const stranger = w.service.issueToken("acct_2");
      expect(refusal(await w.log(list, "", stranger))).toBe("404 not_found");
      expect((await w.call("GET", "/v2/lists/mine", undefined, stranger)).body.list).toBeNull();
    });
  });

  describe("POST /v2/lists: the genesis", () => {
    test("starts the account's one list with its own wrap; a second genesis, the same one included, is list_exists", async () => {
      const w = await world();
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body).toEqual({ now: w.seconds(), list: null });
      const { list, head, first } = await w.start();
      expect(list).toBe(entryHash(entryFromText(first).body));
      expect(head).toEqual({ seq: 0, hash: list });
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body).toEqual({ now: w.seconds(), list, head });
      expect((await w.call("GET", `/v2/lists/${list}/wraps?member=${w.owner.enc}`, undefined, w.token)).body.wraps).toEqual([{ epoch: 0, wrap: WRAP(1) }]);
      expect(w.service.accountList(ACCOUNT)?.wraps).toEqual([{ epoch: 0, member: w.owner.enc, wrap: WRAP(1) }]);
      const again = await w.call("POST", "/v2/lists", { entry: first }, w.token);
      expect([refusal(again), again.body.error?.list, again.body.error?.head]).toEqual(["409 list_exists", list, head]);
      const other = await sign(await newKey(), { seq: 0, list: "", prev: "" }, genesisOf(w.owner), w.seconds());
      expect(refusal(await w.call("POST", "/v2/lists", { entry: other.text }, w.token))).toBe("409 list_exists");
      // two that race for an account with none: one list, the other is told which
      const racer = w.service.issueToken("acct_2");
      const [a, b] = await Promise.all([newKey(), newKey()]);
      const zeros = await Promise.all([a, b].map((by) => sign(by, { seq: 0, list: "", prev: "" }, genesisOf(by, "acct_2"), w.seconds())));
      const raced = await Promise.all(zeros.map(({ text }) => w.call("POST", "/v2/lists", { entry: text }, racer)));
      expect(raced.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(raced.find(({ status }) => status === 409)?.body.error?.list).toBe(w.service.accountList("acct_2")?.id);
      expect(raced.find(({ status }) => status === 201)?.body.list).toBe(w.service.accountList("acct_2")?.id);
      // the account's deletion is the only thing that deletes it
      expect((await w.call("DELETE", "/v1/account", undefined, w.token)).status).toBe(204);
      expect(w.service.accountList(ACCOUNT)).toBeNull();
    });

    test("refuses what is no genesis of this account at level 1, and wraps but the one for epoch 0 and its own enc", async () => {
      const w = await world();
      const owner = w.owner;
      const at0 = { seq: 0, list: "", prev: "" };
      const post = (entry: string, wraps?: unknown) => w.call("POST", "/v2/lists", { entry, ...(wraps === undefined ? {} : { wraps }) }, w.token);
      const good = await sign(owner, at0, genesisOf(owner), w.seconds());
      expect(refusal(await post("not an entry"))).toBe("400 entry_malformed");
      expect((await post("not an entry")).body.error?.index).toBe(0);
      expect(refusal(await post(`${good.text}=`))).toBe("400 entry_malformed");
      const flipped = entryFromText(good.text);
      const changed = new Uint8Array(flipped.body);
      changed[20] = changed[20]! ^ 1;
      expect(refusal(await post(entryToText({ body: changed, signature: flipped.signature })))).toBe("400 signature_invalid");
      const second = await sign(owner, { seq: 1, list: good.head.hash, prev: good.head.hash }, inviteOf(await newKey(), w.seconds() + 600), w.seconds());
      expect(refusal(await post(second.text))).toBe("400 chain_broken");
      const card = await sign(owner, at0, { kind: "card", enc: owner.enc }, w.seconds());
      const notGenesis = await post(card.text);
      expect([refusal(notGenesis), notGenesis.body.error?.outcome, notGenesis.body.error?.reason]).toEqual(["400 entry_refused", "no_effect", "entry_invalid"]);
      expect(refusal(await post((await sign(owner, at0, genesisOf(owner, "acct_2"), w.seconds())).text))).toBe("403 account_mismatch");
      for (const [wraps, index] of [
        [[{ epoch: 0, member: owner.enc, wrap: WRAP(1) }, { epoch: 1, member: owner.enc, wrap: WRAP(2) }], 1],
        [[{ epoch: 1, member: owner.enc, wrap: WRAP(1) }], 0],
        [[{ epoch: 0, member: owner.key, wrap: WRAP(1) }], 0],
        [[{ epoch: 0, member: owner.enc, wrap: WRAP(1).slice(1) }], 0],
        [[{ epoch: 0, member: owner.enc, wrap: `${WRAP(1).slice(0, -1)}=` }], 0],
      ] as const) {
        const refused = await post(good.text, wraps);
        expect([refusal(refused), refused.body.error?.index]).toEqual(["400 wrap_invalid", index]);
      }
      expect(refusal(await post(good.text, [{ epoch: 0, member: owner.enc }]))).toBe("400 invalid_request");
      expect(refusal(await w.call("POST", "/v2/lists", { entry: good.text, account: ACCOUNT }, w.token))).toBe("400 invalid_request");
      expect(w.service.accountList(ACCOUNT)).toBeNull();
      // two wraps for one place: the first is stored, the second dropped without an error
      expect((await post(good.text, [{ epoch: 0, member: owner.enc, wrap: WRAP(1) }, { epoch: 0, member: owner.enc, wrap: WRAP(2) }])).status).toBe(201);
      expect((await w.call("GET", `/v2/lists/${good.head.hash}/wraps?member=${owner.enc}`, undefined, w.token)).body.wraps).toEqual([{ epoch: 0, wrap: WRAP(1) }]);
    });

    test("the second lock: an app's own sign-in, not frozen, made in the last ten minutes or proving its registered key", async () => {
      const w = await world();
      const owner = w.owner;
      w.service.opensAll = true;
      const genesis = await sign(owner, { seq: 0, list: "", prev: "" }, genesisOf(owner), w.seconds());
      const list = genesis.head.hash;
      const post = (bearer: string, more: Record<string, unknown> = {}) => w.call("POST", "/v2/lists", { entry: genesis.text, ...more }, bearer);
      expect(refusal(await post(w.service.issueToken(ACCOUNT, { device: true })))).toBe("403 own_sign_in_required");
      const frozen = w.service.issueToken(ACCOUNT);
      w.service.registerSessionKey(frozen, (await newKey()).key, "frozen");
      (w.service as unknown as { registry(account: string): { freezes: { block: string; target: string; after: number }[] } }).registry(ACCOUNT).freezes.push({ block: "b", target: "t", after: 0 });
      expect(refusal(await post(frozen))).toBe("403 frozen");
      (w.service as unknown as { registry(account: string): { freezes: unknown[] } }).registry(ACCOUNT).freezes.length = 0;
      // a block kept before a sign-in was made freezes it even with no key of its own; one made before the block is not frozen by it
      const before = w.service.issueToken(ACCOUNT);
      const [elder, target] = [await newKey(), await newKey()];
      const elderNo = w.service.registerDevice(ACCOUNT, elder.key, "elder");
      const targetNo = w.service.registerDevice(ACCOUNT, target.key, "target");
      w.tick(1000);
      const block = await signSafetyRecord({ v: 1, account: ACCOUNT, signed_at: new Date(T0).toISOString(), kind: "block", target: target.key, target_no: targetNo, signer: elder.key, signer_no: elderNo, nonce: newRecordId() }, elder.pair.privateKey);
      expect((await w.call("POST", "/v1/safety-records", { record: block }, w.token)).status).toBe(200);
      w.tick(1000);
      const after = w.service.issueToken(ACCOUNT);
      // a genesis for another account passes the frozen check and stops at account_mismatch: a probe that writes nothing
      const elsewhere = (await sign(owner, { seq: 0, list: "", prev: "" }, genesisOf(owner, "acct_2"), w.seconds())).text;
      const probe = (bearer: string) => w.call("POST", "/v2/lists", { entry: elsewhere }, bearer);
      expect(refusal(await probe(after))).toBe("403 frozen");
      expect(refusal(await probe(before))).toBe("403 account_mismatch");
      const lift = await signSafetyRecord({ v: 1, account: ACCOUNT, signed_at: new Date(T0).toISOString(), kind: "lift", target: block.id, signer: elder.key, signer_no: elderNo }, elder.pair.privateKey);
      expect((await w.call("POST", "/v1/safety-records", { record: lift }, w.token)).status).toBe(200);
      expect(refusal(await probe(after))).toBe("403 account_mismatch");
      const phone = await newKey();
      const stale = staleSignIn(w, phone);
      expect(refusal(await post(stale))).toBe("403 session_not_fresh");
      // a proof for another purpose, another list or another slot, or by a key this sign-in did not register, proves nothing
      expect(refusal(await post(stale, { key_proof: await keyProof(w, stale, phone, "list-claim", list) }))).toBe("403 session_not_fresh");
      expect(refusal(await post(stale, { key_proof: await keyProof(w, stale, phone, "list-genesis", OPENS(4)) }))).toBe("403 session_not_fresh");
      expect(refusal(await post(stale, { key_proof: await keyProof(w, stale, phone, "list-genesis", list, "x") }))).toBe("403 session_not_fresh");
      expect(refusal(await post(stale, { key_proof: await keyProof(w, stale, await newKey(), "list-genesis", list) }))).toBe("403 session_not_fresh");
      // a proof is spent by its first use, whatever came of it
      const spent = await keyProof(w, stale, phone, "list-genesis", list);
      const other = await sign(owner, { seq: 0, list: "", prev: "" }, genesisOf(owner), w.seconds() + 1);
      expect(refusal(await w.call("POST", "/v2/lists", { entry: other.text, key_proof: spent }, stale))).toBe("403 session_not_fresh");
      expect(refusal(await post(stale, { key_proof: spent }))).toBe("400 challenge_invalid");
      expect(refusal(await post(stale, { key_proof: { challenge_id: "0".repeat(32) } }))).toBe("400 invalid_request");
      expect((await post(stale, { key_proof: await keyProof(w, stale, phone, "list-genesis", list) })).status).toBe(201);
    });
  });

  describe("which list, and the log", () => {
    test("a PC learns the list while its account lists it in any state, or while its relay key has a row in the list", async () => {
      const w = await world();
      w.service.opensAll = true;
      const pc = machine();
      const asking = machine();
      await listPc(w, pc);
      await listPc(w, asking, w.service.issueToken(ACCOUNT, { device: true }));
      expect((await pcCall(w, pc, "/v2/pc/list", { account: ACCOUNT })).body.list).toBeNull();
      const { list, head } = await w.start();
      expect((await pcCall(w, pc, "/v2/pc/list", { account: ACCOUNT })).body).toEqual({ now: w.seconds(), list, head });
      expect((await pcCall(w, asking, "/v2/pc/list", { account: ACCOUNT })).body.list).toBe(list);
      // a listing that only asks to join reads no log
      expect(refusal(await pcCall(w, asking, "/v2/pc/list/log", { list }))).toBe("404 not_found");
      expect(refusal(await pcCall(w, machine(), "/v2/pc/list", { account: ACCOUNT }))).toBe("404 not_found");
      expect((await pcCall(w, pc, "/v2/pc/list/log", { list })).body.entries).toHaveLength(1);
      // a PC let in by the list and then dropped from the directory still learns the head and reads its removal
      const key = await newKey();
      const posted = await pcCall(w, pc, "/v2/pc/list/keys", { list, key: key.key, enc: key.enc, card: await cardOf(key, list, pc.endpoint) });
      expect(posted.status).toBe(200);
      const added = await chain(list, head, [[w.owner, await pcOf(key, list, pc.endpoint)], [w.owner, removeOf(key)]], w.seconds());
      expect((await w.place(list, added.texts)).status).toBe(200);
      expect((await w.call("DELETE", `/v1/pcs/${pc.serverId}`, undefined, w.token)).status).toBe(204);
      expect((await pcCall(w, pc, "/v2/pc/list", { account: ACCOUNT })).body.head).toEqual(added.head);
      expect((await pcCall(w, pc, "/v2/pc/list/log", { list, after: 0 })).body.entries).toEqual(added.texts);
      expect(refusal(await pcCall(w, pc, "/v2/pc/list/log", { list, limit: 0 }))).toBe("400 invalid_request");
      expect(refusal(await w.call("POST", "/v2/pc/list/log", { ...(await proof(w, pc)), server_id: asking.serverId, list }))).toBe("400 server_key_mismatch");
      expect(refusal(await w.call("POST", "/v2/pc/list/log", { ...(await proof(w, pc)), proof: "{}", list }))).toBe("401 proof_invalid");
    });

    test("a proven PC's calls are counted per server_id, past the limit 429 rate_limited with retry-after; off the switch nothing is spent", async () => {
      const w = await world();
      const { list } = await w.start();
      const pc = machine();
      await listPc(w, pc);
      w.service.listLimits.pcCallsPerMinute = 0;
      expect(refusal(await pcCall(w, pc, "/v2/pc/list", { account: ACCOUNT }))).toBe("429 rate_limited");
      w.tick(MINUTE);
      w.service.listLimits.pcCallsPerMinute = 2;
      // off the switch the call is refused before the proof: its challenge is still good, and nothing is counted
      w.service.listAccounts = "";
      const kept = await proof(w, pc);
      expect(refusal(await w.call("POST", "/v2/pc/list/log", { ...kept, list }))).toBe("404 not_found");
      w.service.listAccounts = "*";
      expect((await w.call("POST", "/v2/pc/list/log", { ...kept, list })).status).toBe(200);
      expect((await pcCall(w, pc, "/v2/pc/list", { account: ACCOUNT })).status).toBe(200);
      const limited = await pcCall(w, pc, "/v2/pc/list/log", { list });
      expect([refusal(limited), limited.headers.get("retry-after")]).toEqual(["429 rate_limited", "60"]);
      expect((await pcCall(w, machine(), "/v2/pc/list", { account: ACCOUNT })).status).toBe(404);
      w.tick(MINUTE);
      expect((await pcCall(w, pc, "/v2/pc/list/log", { list })).status).toBe(200);
    });

    test("the log is paged by after and limit, says more while entries follow, and serves every entry as the text it was sent", async () => {
      const w = await world();
      const { list, head, first } = await w.start();
      // one invite a batch: the service asks for each what making one asks
      const texts: string[] = [];
      let at = head;
      for (let made = 0; made < 5; made++) {
        const one = await chain(list, at, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
        expect((await w.place(list, one.texts)).body).toEqual({ now: w.seconds(), list, head: one.head, placed: 1 });
        texts.push(...one.texts);
        at = one.head;
      }
      const placed = { texts, head: at };
      const all = [first, ...placed.texts];
      expect((await w.log(list)).body).toEqual({ now: w.seconds(), list, after: null, entries: all, head: placed.head, more: false });
      const page = await w.log(list, "?after=1&limit=2");
      expect([page.body.after, page.body.entries, page.body.more]).toEqual([1, all.slice(2, 4), true]);
      expect((await w.log(list, "?after=5")).body).toMatchObject({ entries: [], more: false });
      expect((await w.log(list, "?after=99")).body).toMatchObject({ entries: [], more: false, head: placed.head });
      for (const query of ["?after=-1", "?after=01", "?after=x", "?limit=0", "?limit=257", "?limit=1&x=1", "?after="]) expect(refusal(await w.log(list, query))).toBe("400 invalid_request");
      // the same body with the other spelling of its signature (r || n-s) is another text: not the one in the log
      const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
      const entry = entryFromText(placed.texts[0]!);
      const s = BigInt(`0x${bytesToHex(entry.signature.subarray(32))}`);
      const twin = new Uint8Array(entry.signature);
      twin.set(hexToBytes((n - s).toString(16).padStart(64, "0")), 32);
      expect(refusal(await w.place(list, [entryToText({ body: entry.body, signature: twin })]))).toBe("409 head_moved");
      expect((await w.log(list, "?after=0&limit=1")).body.entries).toEqual([placed.texts[0]!]);
    });
  });

  describe("POST /v2/lists/{list}/entries: placing", () => {
    test("places a batch at the head, whole; head_moved names the head; a batch already in the log is placed 0 again", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const a = await newKey();
      const b = await newKey();
      await w.claim(list, b);
      const batch = await chain(list, head, [[w.owner, inviteOf(a, w.seconds() + 600)], [w.owner, await deviceOf(b, list)]], w.seconds());
      const placed = await w.place(list, batch.texts);
      expect([placed.status, placed.body.placed, placed.body.head]).toEqual([200, 2, batch.head]);
      expect((await w.place(list, batch.texts)).body).toEqual({ now: w.seconds(), list, head: batch.head, placed: 0 });
      expect((await w.place(list, batch.texts.slice(1))).body.placed).toBe(0);
      const stale = await w.place(list, (await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds())).texts);
      expect([refusal(stale), stale.body.error?.head]).toEqual(["409 head_moved", batch.head]);
      // in the log in part, new in part: the head moved
      const more = await chain(list, batch.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      expect(refusal(await w.place(list, [batch.texts[1]!, ...more.texts]))).toBe("409 head_moved");
      const ahead = await chain(list, more.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      expect(refusal(await w.place(list, ahead.texts))).toBe("409 head_moved");
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(batch.head);
    });

    test("each text must hold where it stands: entry_malformed, chain_broken and signature_invalid name its index, and nothing is placed", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const good = await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)], [w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      const at = (called: Called) => [refusal(called), called.body.error?.index];
      expect(at(await w.place(list, [good.texts[0]!, "x.y"]))).toEqual(["400 entry_malformed", 1]);
      const broken = await sign(w.owner, { seq: 2, list, prev: head.hash }, inviteOf(await newKey(), w.seconds() + 600), w.seconds());
      expect(at(await w.place(list, [good.texts[0]!, broken.text]))).toEqual(["400 chain_broken", 1]);
      const other = await sign(w.owner, { seq: 1, list: OPENS(3), prev: head.hash }, inviteOf(await newKey(), w.seconds() + 600), w.seconds());
      expect(at(await w.place(list, [other.text]))).toEqual(["400 chain_broken", 0]);
      const forged = entryFromText(good.texts[1]!);
      const signature = new Uint8Array(forged.signature);
      signature[40] = signature[40]! ^ 1;
      expect(at(await w.place(list, [good.texts[0]!, entryToText({ body: forged.body, signature })]))).toEqual(["400 signature_invalid", 1]);
      expect(w.service.accountList(ACCOUNT)?.entries).toHaveLength(1);
    });

    test("only an entry the library takes as counts is placed: entry_refused names its index, outcome and reason, and the batch goes whole or not at all", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const stranger = await newKey();
      const refusedAt = async (steps: readonly (readonly [Key, ListKind])[]) => {
        const refused = await w.place(list, (await chain(list, head, steps, w.seconds())).texts);
        return [refusal(refused), refused.body.error?.index, refused.body.error?.outcome, refused.body.error?.reason];
      };
      expect(await refusedAt([[w.owner, inviteOf(await newKey(), w.seconds() + 600)], [stranger, inviteOf(await newKey(), w.seconds() + 600)]])).toEqual(["400 entry_refused", 1, "passed_over", "signer_unknown"]);
      expect(await refusedAt([[w.owner, inviteOf(await newKey(), w.seconds() + 600)], [w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, sealed(1))]])).toEqual(["400 entry_refused", 1, "no_effect", "epoch_other"]);
      const phone = await newKey();
      expect(await refusedAt([[w.owner, await deviceOf(phone, list, false, await cardOf(stranger, list))]])).toEqual(["400 entry_refused", 0, "no_effect", "card_invalid"]);
      // carrying members in has no second lock yet: the service places no carried entry
      expect(await refusedAt([[w.owner, { kind: "carried", key: phone.key, role: "drive", sealed: sealed() }]])).toEqual(["400 entry_refused", 0, "service", "carried_not_open"]);
      // once the list is in use, every member refuses a carried entry itself
      expect(await refusedAt([[w.owner, inviteOf(await newKey(), w.seconds() + 600)], [w.owner, { kind: "carried", key: phone.key, role: "drive", sealed: sealed() }]]))
        .toEqual(["400 entry_refused", 1, "no_effect", "carried_late"]);
      // a kind of a level above the service's: cannot_read
      const raised: EntryBody = { issued_at: w.seconds(), kind: "later_kind", list, prev: head.hash, seq: 1, signer: w.owner.key, v: 2, own: [] };
      const later = await w.place(list, [entryToText(await signEntry(raised, w.owner.pair.privateKey))]);
      expect([refusal(later), later.body.error?.outcome, later.body.error?.reason]).toEqual(["400 entry_refused", "cannot_read", null]);
      expect(w.service.accountList(ACCOUNT)?.entries).toHaveLength(1);
    });

    test("after a removal, names are placed only once the next epoch is open: epoch_stale until then, and an entry without names counts", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await newKey();
      await w.claim(list, phone);
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)], [w.owner, removeOf(phone)]], w.seconds());
      expect((await w.place(list, added.texts)).status).toBe(200);
      const named = await chain(list, added.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      const stale = await w.place(list, named.texts);
      expect([refusal(stale), stale.body.error?.outcome, stale.body.error?.reason]).toEqual(["400 entry_refused", "service", "epoch_stale"]);
      expect((await w.place(list, (await chain(list, added.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, null)]], w.seconds())).texts)).status).toBe(200);
      const at = w.service.accountList(ACCOUNT)!.head;
      const opened = await chain(list, at, [[w.owner, epochOf(0)], [w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, sealed(1))]], w.seconds());
      expect((await w.place(list, opened.texts)).status).toBe(200);
    });

    test("of two writers at one head exactly one is placed; the other gets head_moved and none of its wraps is stored", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const [p1, p2, x] = [await newKey(), await newKey(), await newKey()];
      await w.claim(list, p1);
      await w.claim(list, p2, w.service.issueToken(ACCOUNT));
      const long = await chain(list, head, [[w.owner, await deviceOf(p1, list)], [w.owner, await deviceOf(p2, list)], [w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      const short = await chain(list, head, [[w.owner, inviteOf(x, w.seconds() + 600)]], w.seconds());
      const [slow, quick] = await Promise.all([w.place(list, long.texts, [{ epoch: 0, member: p1.enc, wrap: WRAP(7) }]), w.place(list, short.texts, [{ epoch: 0, member: x.key, wrap: WRAP(9) }])]);
      expect([slow.status, quick.status].sort()).toEqual([200, 409]);
      const winner = slow.status === 200 ? long : short;
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(winner.head);
      expect((slow.status === 409 ? slow : quick).body.error?.head).toEqual(winner.head);
      expect(w.service.accountList(ACCOUNT)!.wraps.map(({ wrap }) => wrap)).toEqual(slow.status === 200 ? [WRAP(1), WRAP(7)] : [WRAP(1), WRAP(9)]);
    });

    test("the service's clock: no entry dated more than ten minutes ahead, and a join after its invite's exp", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const ahead = await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 1200)]], w.seconds() + 601);
      const refused = await w.place(list, ahead.texts);
      expect([refusal(refused), refused.body.error?.outcome, refused.body.error?.reason]).toEqual(["400 entry_refused", "service", "issued_at_ahead"]);
      expect((await w.place(list, (await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 900)]], w.seconds() + 600)).texts)).status).toBe(200);
      const after = w.service.accountList(ACCOUNT)!.head;
      // the list's own time is now the invite above's issued_at, 600 s ahead: this invite's exp lies after it
      const pool = await newKey();
      const invited = await chain(list, after, [[w.owner, inviteOf(pool, w.seconds() + 700)]], w.seconds());
      expect((await w.place(list, invited.texts)).status).toBe(200);
      const pc = machine();
      await listPc(w, pc, w.service.issueToken(ACCOUNT, { device: true }));
      const pcKey = await newKey();
      const named = await chain(list, invited.head, [[pool, await joinOf(pcKey, list, pc.endpoint, pool)]], w.seconds());
      const joined = await chain(list, invited.head, [[pool, await joinOf(pcKey, list, pc.endpoint, pool, null)]], w.seconds());
      // past exp by the service's clock alone: the service's own refusal, before the names' epoch (an open invite over its
      // time stops all sealing), so a join with names answers invite_expired too
      w.tick(701_000);
      const stale = await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: named.texts });
      expect([refusal(stale), stale.body.error?.index]).toEqual(["409 invite_expired", 0]);
      const late = await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: joined.texts });
      expect([refusal(late), late.body.error?.index]).toEqual(["409 invite_expired", 0]);
      // once an entry of a full signer dated after exp is in, every member refuses the join itself
      const dated = await chain(list, invited.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, null)]], w.seconds());
      // an invite asks a fresh sign-in (or the make proof) of whoever places it
      expect((await w.place(list, dated.texts, undefined, w.service.issueToken(ACCOUNT))).status).toBe(200);
      const joinedLate = await chain(list, dated.head, [[pool, await joinOf(pcKey, list, pc.endpoint, pool, null)]], w.seconds());
      const byMembers = await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: joinedLate.texts });
      expect([refusal(byMembers), byMembers.body.error?.outcome, byMembers.body.error?.reason]).toEqual(["400 entry_refused", "no_effect", "invite_expired"]);
    });

    test("size and budget: from removalsOnlyFrom only remove and epoch, from closedFrom nothing, past the hard size only remove, and additions per ten minutes and per day", async () => {
      const w = await world();
      const { list, head } = await w.start();
      // entries 1 to 3: three devices
      const phone = await addDevice(w, list, head);
      const tablet = await addDevice(w, list, phone.head);
      const laptop = await addDevice(w, list, tablet.head);
      w.service.listLimits.removalsOnlyFrom = 4;
      expect(refusal(await w.place(list, (await chain(list, laptop.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds())).texts))).toBe("409 list_full");
      const removal = await chain(list, laptop.head, [[w.owner, removeOf(phone.key)], [w.owner, epochOf(0)]], w.seconds());
      expect((await w.place(list, removal.texts)).status).toBe(200);
      w.service.listLimits.closedFrom = 6;
      expect(refusal(await w.place(list, (await chain(list, removal.head, [[w.owner, removeOf(tablet.key)]], w.seconds())).texts))).toBe("409 list_full");
      w.service.listLimits.closedFrom = 1e9;
      w.service.listLimits.removalsOnlyFrom = 1e9;
      w.service.listLimits.stateChars = 10;
      // epoch 1 is open: these invites carry no names (under epoch 0 they would be epoch_other)
      expect(refusal(await w.place(list, (await chain(list, removal.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, null)]], w.seconds())).texts))).toBe("409 list_full");
      // past the hard size only the remove, which adds no row; past the soft one its epoch too
      const both = await chain(list, removal.head, [[w.owner, removeOf(tablet.key)], [w.owner, epochOf(1)]], w.seconds());
      w.service.listLimits.stateHardChars = 10;
      expect(refusal(await w.place(list, both.texts))).toBe("409 list_full");
      w.service.listLimits.stateHardChars = 1e9;
      expect((await w.place(list, both.texts)).status).toBe(200);
      w.service.listLimits.stateChars = 1e9;
      w.service.listLimits.additionsPerWindow = 4;
      const fourth = await chain(list, both.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, null)]], w.seconds());
      expect((await w.place(list, fourth.texts)).status).toBe(200);
      w.tick(MINUTE);
      const over = await chain(list, fourth.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, null)]], w.seconds());
      const budget = await w.place(list, over.texts);
      // the three devices and the invite are the window's four additions: the first leaves it nine minutes on
      expect([refusal(budget), budget.headers.get("retry-after")]).toEqual(["429 entry_budget", String(9 * 60)]);
      w.tick(9 * MINUTE);
      expect((await w.place(list, over.texts)).status).toBe(200);
      // and the day's: five additions so far, the first ones ten minutes ago
      w.service.listLimits.additionsPerDay = 5;
      const sixth = await chain(list, over.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600, true, 1, null)]], w.seconds());
      const daily = await w.place(list, sixth.texts);
      expect([refusal(daily), daily.headers.get("retry-after")]).toEqual(["429 entry_budget", String(24 * 3600 - 10 * 60)]);
    });

    test("removals alone by a signer of the list spend that signer's own counter, so a spent account still removes", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await newKey();
      const tablet = await newKey();
      await w.claim(list, phone);
      await w.claim(list, tablet, w.service.issueToken(ACCOUNT));
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)], [w.owner, await deviceOf(tablet, list)]], w.seconds());
      expect((await w.place(list, added.texts)).status).toBe(200);
      // the account's sign-ins spend all its requests
      while ((await w.call("GET", "/v2/lists/mine", undefined, w.token)).status === 200);
      // an epoch beside an addition spends the account's
      const mixed = await w.place(list, (await chain(list, added.head, [[w.owner, epochOf(0)], [w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds())).texts);
      expect(refusal(mixed)).toBe("429 rate_limited");
      // a removal with the epoch it moves, whose first entry verifies under a signer of the list, is counted apart, under that signer
      const removed = await chain(list, added.head, [[w.owner, removeOf(phone)], [w.owner, epochOf(0)]], w.seconds());
      expect((await w.place(list, removed.texts)).status).toBe(200);
      // a removal nobody of the list signed spends the account's, so it buys no way past the limit
      const forged = await chain(list, removed.head, [[await newKey(), removeOf(tablet)]], w.seconds());
      expect(refusal(await w.place(list, forged.texts))).toBe("429 rate_limited");
      w.service.listLimits.removalsPerWindow = 1;
      const second = await chain(list, removed.head, [[w.owner, removeOf(tablet)]], w.seconds());
      expect(refusal(await w.place(list, second.texts))).toBe("429 rate_limited");
      w.tick(10 * MINUTE);
      expect((await w.place(list, second.texts)).status).toBe(200);
    });

    test("a placement rings the account's other subscribed devices", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const other = w.service.issueToken(ACCOUNT);
      const subscription = { endpoint: "https://push.test/other", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };
      expect((await w.call("PUT", "/v1/push", subscription, other)).status).toBe(204);
      expect((await w.call("PUT", "/v1/push", { ...subscription, endpoint: "https://push.test/mine" }, w.token)).status).toBe(204);
      expect((await w.place(list, (await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds())).texts)).status).toBe(200);
      expect(w.service.rings().map((ring) => ring.endpoint)).toEqual(["https://push.test/other"]);
    });
  });

  describe("wraps", () => {
    test("a wrap is stored only with its placed batch, for the epoch current after it and one of its wrapKeys, and once", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await newKey();
      await w.claim(list, phone);
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      const wrapsOf = async (member: string) => (await w.call("GET", `/v2/lists/${list}/wraps?member=${member}`, undefined, w.token)).body.wraps;
      const noMember = await w.place(list, added.texts, [{ epoch: 0, member: phone.enc, wrap: WRAP(2) }, { epoch: 0, member: (await newKey()).enc, wrap: WRAP(3) }]);
      expect([refusal(noMember), noMember.body.error?.index]).toEqual(["400 wrap_invalid", 1]);
      expect(w.service.accountList(ACCOUNT)?.entries).toHaveLength(1);
      expect(await wrapsOf(phone.enc)).toEqual([]);
      expect((await w.place(list, added.texts, [{ epoch: 0, member: phone.enc, wrap: WRAP(2) }, { epoch: 0, member: phone.enc, wrap: WRAP(4) }])).status).toBe(200);
      expect(await wrapsOf(phone.enc)).toEqual([{ epoch: 0, wrap: WRAP(2) }]);
      // the removal moves the epoch: remove, epoch and the new epoch's wraps in one request, for those who stay
      const removal = await chain(list, added.head, [[w.owner, removeOf(phone)], [w.owner, epochOf(0)]], w.seconds());
      expect(refusal(await w.place(list, removal.texts, [{ epoch: 1, member: phone.enc, wrap: WRAP(5) }]))).toBe("400 wrap_invalid");
      expect(refusal(await w.place(list, removal.texts, [{ epoch: 0, member: w.owner.enc, wrap: WRAP(5) }]))).toBe("400 wrap_invalid");
      expect((await w.place(list, removal.texts, [{ epoch: 1, member: w.owner.enc, wrap: WRAP(6) }])).status).toBe(200);
      expect(await wrapsOf(w.owner.enc)).toEqual([{ epoch: 0, wrap: WRAP(1) }, { epoch: 1, wrap: WRAP(6) }]);
      expect(refusal(await w.call("GET", `/v2/lists/${list}/wraps`, undefined, w.token))).toBe("400 invalid_request");
      const pc = machine();
      await listPc(w, pc);
      expect((await pcCall(w, pc, "/v2/pc/list/wraps", { list, member: w.owner.enc })).body.wraps).toEqual([{ epoch: 0, wrap: WRAP(1) }, { epoch: 1, wrap: WRAP(6) }]);
      expect(refusal(await pcCall(w, machine(), "/v2/pc/list/wraps", { list, member: w.owner.enc }))).toBe("404 not_found");
    });
  });

  describe("wraps by the service's clock", () => {
    test("an open auto invite's own key takes a wrap until its exp, by the service's clock, and none after", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const pool = await newKey();
      const invited = await chain(list, head, [[w.owner, inviteOf(pool, w.seconds() + 60)]], w.seconds());
      expect((await w.place(list, invited.texts, [{ epoch: 0, member: pool.key, wrap: WRAP(3) }])).status).toBe(200);
      w.tick(61_000);
      const phone = await newKey();
      await w.claim(list, phone);
      // names cannot be sealed while an open invite is past its exp: this device carries none
      const later = await chain(list, invited.head, [[w.owner, { ...(await deviceOf(phone, list)), sealed: null } as ListKind]], w.seconds());
      const refused = await w.place(list, later.texts, [{ epoch: 0, member: pool.key, wrap: WRAP(4) }]);
      expect([refusal(refused), refused.body.error?.index]).toEqual(["400 wrap_invalid", 0]);
      expect((await w.place(list, later.texts, [{ epoch: 0, member: phone.enc, wrap: WRAP(4) }])).status).toBe(200);
    });
  });

  describe("the second lock", () => {
    test("a device entry is placed only on a live claim of its key, which the placement uses up", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await newKey();
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      const unclaimed = await w.place(list, added.texts);
      expect([refusal(unclaimed), unclaimed.body.error?.index]).toEqual(["403 not_claimed", 0]);
      const newcomer = w.service.issueToken(ACCOUNT);
      const claimed = await w.claim(list, phone, newcomer);
      expect(claimed.body).toEqual({ now: w.seconds(), key: phone.key, until: Math.floor((T0 + LIST_CLAIM_MS) / 1000) });
      expect(w.service.accountList(ACCOUNT)?.claims.map(({ key }) => key)).toEqual([phone.key]);
      expect((await w.call("GET", `/v2/lists/${list}/claims`, undefined, w.token)).body.claims).toEqual([{ key: phone.key, enc: phone.enc, card: expect.any(String), until: claimed.body.until! }]);
      // a claim lasts ten minutes
      w.tick(LIST_CLAIM_MS + 1000);
      expect(refusal(await w.place(list, added.texts))).toBe("403 not_claimed");
      expect((await w.call("GET", `/v2/lists/${list}/claims`, undefined, w.token)).body.claims).toEqual([]);
      // a claim whose sign-in has signed out since is no claim
      const fresh = w.service.issueToken(ACCOUNT);
      expect((await w.claim(list, phone, fresh)).status).toBe(200);
      expect((await w.call("POST", "/v1/signout", undefined, fresh)).status).toBe(204);
      expect(refusal(await w.place(list, added.texts))).toBe("403 not_claimed");
      const again = w.service.issueToken(ACCOUNT);
      expect((await w.claim(list, phone, again)).status).toBe(200);
      expect((await w.place(list, added.texts)).status).toBe(200);
      expect((await w.call("GET", `/v2/lists/${list}/claims`, undefined, w.token)).body.claims).toEqual([]);
    });

    test("a claim takes the key's own card, from an own sign-in that is fresh or proves its key; claiming another key drops the earlier", async () => {
      const w = await world();
      w.service.opensAll = true;
      const { list } = await w.start();
      const phone = await newKey();
      const tablet = await newKey();
      expect(refusal(await w.claim(list, phone, w.token, { card: await cardOf(tablet, list) }))).toBe("400 card_invalid");
      expect(refusal(await w.claim(list, phone, w.token, { card: await cardOf(phone, list, "ab".repeat(32)) }))).toBe("400 card_invalid");
      expect(refusal(await w.claim(list, phone, w.service.issueToken(ACCOUNT, { device: true })))).toBe("403 own_sign_in_required");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/claims`, { key: phone.key, enc: phone.enc }, w.token))).toBe("400 invalid_request");
      const signedIn = await newKey();
      const stale = staleSignIn(w, signedIn);
      expect(refusal(await w.claim(list, phone, stale))).toBe("403 session_not_fresh");
      const proof = await keyProof(w, stale, signedIn, "list-claim", list, phone.key);
      expect((await w.claim(list, phone, stale, { key_proof: proof })).status).toBe(200);
      expect(refusal(await w.claim(list, phone, stale, { key_proof: proof }))).toBe("400 challenge_invalid");
      const claimed = async () => (await w.call("GET", `/v2/lists/${list}/claims`, undefined, w.token)).body.claims?.map(({ key }) => key);
      const other = w.service.issueToken(ACCOUNT);
      w.tick(1000);
      expect((await w.claim(list, tablet, other)).status).toBe(200);
      expect(await claimed()).toEqual([phone.key, tablet.key]);
      // one claim per key: another sign-in's claim of it takes it over, and drops that sign-in's earlier claim
      expect((await w.claim(list, phone, other)).status).toBe(200);
      expect(await claimed()).toEqual([phone.key]);
      expect(refusal(await w.claim(list, phone, other, { card: "A".repeat(85) }))).toBe("400 invalid_request");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/claims`, { key: "nokey", enc: phone.enc, card: await cardOf(phone, list) }, other))).toBe("400 invalid_request");
    });

    test("a rotation asks the claim of the new key", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const next = await newKey();
      const rotated = await chain(list, head, [[w.owner, await deviceOf(next, list, true)]], w.seconds());
      expect(refusal(await w.place(list, rotated.texts))).toBe("403 not_claimed");
      await w.claim(list, next);
      expect((await w.place(list, rotated.texts)).status).toBe(200);
    });

    test("a pc entry is placed only on a live post of its key and relay key, by a PC the account lists", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const pc = machine();
      const key = await newKey();
      const post = async (on: Machine, card?: string) => pcCall(w, on, "/v2/pc/list/keys", { list, key: key.key, enc: key.enc, card: card ?? await cardOf(key, list, on.endpoint) });
      expect(refusal(await post(pc))).toBe("404 not_found");
      await listPc(w, pc);
      expect(refusal(await post(pc, await cardOf(key, list)))).toBe("400 card_invalid");
      const added = await chain(list, head, [[w.owner, await pcOf(key, list, pc.endpoint)]], w.seconds());
      const unposted = await w.place(list, added.texts);
      expect([refusal(unposted), unposted.body.error?.index]).toEqual(["403 not_posted", 0]);
      const posted = await post(pc);
      expect(w.service.accountList(ACCOUNT)?.posts.map(({ endpoint, key: posted }) => [endpoint, posted])).toEqual([[pc.endpoint, key.key]]);
      expect(posted.body).toEqual({ now: w.seconds(), endpoint: pc.endpoint, key: key.key, until: Math.floor((T0 + LIST_CLAIM_MS) / 1000) });
      expect((await w.call("GET", `/v2/lists/${list}/posts`, undefined, w.token)).body.posts).toEqual([{ endpoint: pc.endpoint, server_id: pc.serverId, key: key.key, enc: key.enc, card: expect.any(String), until: posted.body.until!, attempt: null }]);
      w.tick(LIST_CLAIM_MS + 1000);
      expect(refusal(await w.place(list, added.texts))).toBe("403 not_posted");
      await post(pc);
      expect((await w.call("DELETE", `/v1/pcs/${pc.serverId}`, undefined, w.service.issueToken(ACCOUNT))).status).toBe(204);
      expect(refusal(await w.place(list, added.texts))).toBe("403 not_posted");
      // an account that has a list lists a new PC only from a sign-in that may add one: a fresh one here
      await listPc(w, pc, w.service.issueToken(ACCOUNT));
      expect((await w.place(list, added.texts)).status).toBe(200);
      // the post is used up by the entry it let in
      expect((await w.call("GET", `/v2/lists/${list}/posts`, undefined, w.token)).body.posts).toEqual([]);
    });

    test("a post carries the number comparison: the adder opens an attempt, the PC answers it once, the adder reveals", async () => {
      const w = await world();
      const { list } = await w.start();
      const pc = machine();
      await listPc(w, pc);
      const key = await newKey();
      const adder = w.owner.key;
      const post = async (as = key) => pcCall(w, pc, "/v2/pc/list/keys", { list, key: as.key, enc: as.enc, card: await cardOf(as, list, pc.endpoint) });
      const nonce = (n: number) => toBase64Url(new Uint8Array(32).fill(n));
      const open = (body: Record<string, unknown>) => w.call("POST", `/v2/lists/${list}/posts/${pc.endpoint}/attempt`, { key: key.key, adder, commitment: nonce(1), ...body }, w.token);
      const atPc = (body: Record<string, unknown> = {}) => pcCall(w, pc, "/v2/pc/list/attempt", { list, ...body });
      expect(refusal(await open({}))).toBe("409 post_changed");
      expect((await post()).status).toBe(200);
      expect((await atPc()).body.attempt).toBeNull();
      expect((await open({})).body).toMatchObject({ endpoint: pc.endpoint, key: key.key, attempt: { adder, commitment: nonce(1), nonce: null, reveal: null } });
      // a reveal before the PC's nonce, or for another commitment, is not the open attempt's
      expect(refusal(await open({ reveal: nonce(9) }))).toBe("409 attempt_changed");
      expect(refusal(await atPc({ commitment: nonce(1) }))).toBe("400 invalid_request");
      expect(refusal(await atPc({ commitment: nonce(2), nonce: nonce(5) }))).toBe("409 attempt_changed");
      expect((await atPc({ commitment: nonce(1), nonce: nonce(5) })).body.attempt).toMatchObject({ nonce: nonce(5) });
      expect((await atPc({ commitment: nonce(1), nonce: nonce(5) })).status).toBe(200);
      expect(refusal(await atPc({ commitment: nonce(1), nonce: nonce(6) }))).toBe("409 attempt_changed");
      expect((await open({ commitment: nonce(1), reveal: nonce(9) })).body.attempt).toEqual({ adder, commitment: nonce(1), nonce: nonce(5), reveal: nonce(9) });
      expect((await open({ commitment: nonce(1), reveal: nonce(9) })).status).toBe(200);
      expect(refusal(await open({ commitment: nonce(1), reveal: nonce(8) }))).toBe("409 attempt_changed");
      expect((await w.call("GET", `/v2/lists/${list}/posts`, undefined, w.token)).body.posts?.[0]).toMatchObject({ attempt: { reveal: nonce(9) } });
      // the same keys posted again keep the comparison while the post stands; other keys are another card, and it goes
      expect((await post()).status).toBe(200);
      expect((await atPc()).body.attempt).toMatchObject({ reveal: nonce(9) });
      const other = await newKey();
      expect((await post(other)).status).toBe(200);
      expect((await atPc()).body.attempt).toBeNull();
      expect(refusal(await open({}))).toBe("409 post_changed");
      // a reveal is taken once: the same again is the same answer, another is not this attempt's
      // (tested above through the PC's own answer; here the counting) six openings per PC post in ten minutes: only a
      // call that opens one counts, so the one that found no post did not; a reveal is not counted
      expect((await post()).status).toBe(200);
      for (let opened = 2; opened <= 6; opened++) expect((await open({})).status).toBe(200);
      const spent = await open({});
      expect([refusal(spent), spent.headers.get("retry-after")]).toEqual(["429 attempts_spent", "600"]);
      expect(refusal(await open({ commitment: nonce(3) }))).toBe("429 attempts_spent");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/posts/${pc.endpoint}/attempt`, { key: key.key, adder, commitment: "short" }, w.token))).toBe("400 invalid_request");
      expect(refusal(await pcCall(w, machine(), "/v2/pc/list/attempt", { list }))).toBe("404 not_found");
      // a post that ran out is over: posting the same keys again starts with no comparison
      expect((await atPc()).body.attempt).not.toBeNull();
      w.tick(LIST_CLAIM_MS + 1000);
      expect((await post()).status).toBe(200);
      expect((await atPc()).body.attempt).toBeNull();
    });

    test("a join is placed only through the PC route, by the PC whose relay key it names, after that PC redeemed that invite", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const pool = await newKey();
      const invited = await chain(list, head, [[w.owner, inviteOf(pool, w.seconds() + 600)]], w.seconds());
      expect((await w.place(list, invited.texts)).status).toBe(200);
      const pc = machine();
      const key = await newKey();
      const joined = await chain(list, invited.head, [[pool, await joinOf(key, list, pc.endpoint, pool)]], w.seconds());
      // listed by a device code's sign-in, as an agent can: no redeem of that invite by this PC, no join
      await listPc(w, pc, w.service.issueToken(ACCOUNT, { device: true }));
      const unredeemed = await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: joined.texts });
      expect([refusal(unredeemed), unredeemed.body.error?.index]).toEqual(["403 not_redeemed", 0]);
      const byDevice = await w.place(list, joined.texts);
      expect([refusal(byDevice), byDevice.body.error?.index]).toEqual(["403 pc_proof_required", 0]);
      // a machine neither listed nor in the list learns nothing, whatever it sends
      expect(refusal(await pcCall(w, machine(), "/v2/pc/list/entries", { list, entries: joined.texts }))).toBe("404 not_found");
      expect(refusal(await pcCall(w, machine(), "/v2/pc/list/entries", { list, entries: ["x.y"] }))).toBe("404 not_found");
      // the PC redeems that very invite (an invite key is an invite once, at the service); a device code's listing of it
      // since then is not one an own sign-in made or let in: not_listed
      const relist = async (bearer: string) => {
        expect((await w.call("DELETE", `/v1/pcs/${pc.serverId}`, undefined, w.service.issueToken(ACCOUNT))).status).toBe(204);
        await listPc(w, pc, bearer);
      };
      expect((await w.call("DELETE", `/v1/pcs/${pc.serverId}`, undefined, w.service.issueToken(ACCOUNT))).status).toBe(204);
      await redeem(w, pc, pool);
      await relist(w.service.issueToken(ACCOUNT, { device: true }));
      const unlisted = await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: joined.texts });
      expect([refusal(unlisted), unlisted.body.error?.index]).toEqual(["403 not_listed", 0]);
      // listed by an own sign-in (as the auto redeem itself lists it): its join is placed
      await relist(w.service.issueToken(ACCOUNT));
      expect((await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: joined.texts })).body).toMatchObject({ head: joined.head, placed: 1 });
      // now in the list, the PC places what it is given; a join naming another relay key is still not its to place
      const other = machine();
      const spare = await newKey();
      // (the used invite is out of the list, so names wait for the next epoch: these carry none)
      const again = await chain(list, joined.head, [[w.owner, inviteOf(spare, w.seconds() + 600, true, 1, null)]], w.seconds());
      expect((await w.place(list, again.texts)).status).toBe(200);
      const second = await chain(list, again.head, [[spare, await joinOf(await newKey(), list, other.endpoint, spare, null)]], w.seconds());
      expect(refusal(await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: second.texts }))).toBe("403 pc_proof_required");
      expect(refusal(await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: ["x.y"] }))).toBe("400 entry_malformed");
      // an invite lets a PC in with nobody else awake: a PC's key alone places none
      const invite = await chain(list, again.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      expect(refusal(await pcCall(w, pc, "/v2/pc/list/entries", { list, entries: invite.texts }))).toBe("403 sign_in_required");
    });
  });

  describe("the mailbox's with_list", () => {
    test("adds the list's id and head for a PC the account lists confirmed, null for one that only asks to join, nothing without the member", async () => {
      const w = await world();
      w.service.opensAll = true;
      const pc = machine();
      const asking = machine();
      await listPc(w, pc);
      await listPc(w, asking, w.service.issueToken(ACCOUNT, { device: true }));
      expect((await pull(w, pc)).list).toBeNull();
      const { list, head } = await w.start();
      expect((await pull(w, pc)).list).toEqual({ id: list, head });
      expect((await pull(w, asking)).list).toBeNull();
      expect("list" in await pull(w, pc, false)).toBe(false);
    });
  });

  describe("listing a new PC in an account that has a list", () => {
    test("an account that has a list lists a new PC only by a sign-in that may add one, whatever the list rule's switch says; an account without a list lists as it did", async () => {
      const w = await world();
      w.service.listProofRequired = false;
      const put = (pc: Machine, bearer: string, more: Record<string, unknown> = {}) =>
        w.call("PUT", `/v1/pcs/${pc.serverId}`, { label: "tower", public_key: pc.endpoint, relay: "wss://relay.test", ...more }, bearer);
      const registered = await newKey();
      const old = staleSignIn(w, registered);
      // no list yet: the switch decides, and it is off here
      expect((await put(machine(), old)).status).toBe(200);
      const genesis = await sign(w.owner, { seq: 0, list: "", prev: "" }, genesisOf(w.owner), w.seconds());
      expect((await w.call("POST", "/v2/lists", { entry: genesis.text }, w.service.issueToken(ACCOUNT))).status).toBe(201);
      // with a list: an old own sign-in lists nothing new without its key's proof, and writes nothing
      const fresh = machine();
      const refused = await put(fresh, old);
      expect([refused.status, (refused.body as unknown as { error: { code: string } }).error.code]).toEqual([403, "session_not_fresh"]);
      expect(w.service.pcs(ACCOUNT).some((row) => row.server_id === fresh.serverId)).toBe(false);
      w.service.opensAll = true;
      const challenge = await (await w.service.fetch(new Request(`${BASE}/v1/pcs/challenge`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${old}` } }))).json() as { challenge_id: string; challenge: string };
      const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, registered.pair.privateKey, pcAddSigningBytes("list", ACCOUNT, fresh.serverId, "", challenge.challenge_id, challenge.challenge))));
      expect((await put(fresh, old, { key_proof: { challenge_id: challenge.challenge_id, signature } })).status).toBe(200);
      // upkeep of a listed PC and a device code's listing are as before
      expect((await put(fresh, old)).status).toBe(200);
      expect((await put(machine(), w.service.issueToken(ACCOUNT, { device: true }))).status).toBe(200);
    });
  });

  describe("the account service review's reproducing cases (PR 73) the fake refuses too", () => {
    test("R1, R1c: a person-added PC lists a machine with a device-code sign-in, new or two hours old: that listing locks no pc entry", async () => {
      for (const age of [0, 120 * MINUTE]) {
        const w = await world();
        w.service.opensAll = true;
        const { list, head } = await w.start();
        const a = await addPc(w, list, head);
        const tokenA = w.service.issueToken(ACCOUNT, { device: true });
        w.tick(age);
        const machineB = machine();
        await listPc(w, machineB, tokenA);
        const keyB = await newKey();
        expect((await pcCall(w, machineB, "/v2/pc/list/keys", { list, key: keyB.key, enc: keyB.enc, card: await cardOf(keyB, list, machineB.endpoint) })).status).toBe(200);
        const entry = await chain(list, a.head, [[a.key, await pcOf(keyB, list, machineB.endpoint)]], w.seconds());
        const wraps = [{ epoch: 0, member: keyB.enc, wrap: WRAP(5) }];
        const byProof = await pcCall(w, a.pc, "/v2/pc/list/entries", { list, entries: entry.texts, wraps });
        expect([age, refusal(byProof), byProof.body.error?.index]).toEqual([age, "403 not_posted", 0]);
        expect(refusal(await w.place(list, entry.texts, wraps, tokenA))).toBe("403 own_sign_in_required");
        expect(w.service.accountList(ACCOUNT)?.head).toEqual(a.head);
        // what does let B in is a person: an own sign-in's Add, inside the listing's ten minutes
        const admitted = await w.call("POST", `/v1/pcs/${machineB.serverId}/admit`, {}, w.service.issueToken(ACCOUNT));
        expect(admitted.status).toBe(age === 0 ? 200 : 409);
        expect((await pcCall(w, a.pc, "/v2/pc/list/entries", { list, entries: entry.texts, wraps })).status).toBe(age === 0 ? 200 : 403);
      }
    });

    test("R1b: an agent with an auto invite's line and any device-code sign-in lists a second machine: no join without that machine's own redeem", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const pool = await newKey();
      const invited = await chain(list, head, [[w.owner, inviteOf(pool, w.seconds() + 600)]], w.seconds());
      expect((await w.place(list, invited.texts)).status).toBe(200);
      const q = machine();
      await listPc(w, q, w.service.issueToken(ACCOUNT, { device: true }));
      const join = await chain(list, invited.head, [[pool, await joinOf(await newKey(), list, q.endpoint, pool)]], w.seconds());
      const placed = await pcCall(w, q, "/v2/pc/list/entries", { list, entries: join.texts });
      expect([refusal(placed), placed.body.error?.index]).toEqual(["403 not_redeemed", 0]);
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(invited.head);
    });

    test("R2, R2b: an old remove, an old epoch and an old removal batch sent again spend nothing of their signer's removal counter", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const d1 = await addDevice(w, list, head);
      const d2 = await addDevice(w, list, d1.head);
      const d3 = await addDevice(w, list, d2.head);
      const removals = () => counted(w, `removals:${w.owner.key}:${ACCOUNT}`);
      const requests = () => counted(w, `requests:${ACCOUNT}`);
      const bare = await chain(list, d3.head, [[w.owner, removeOf(d1.key)]], w.seconds());
      expect((await w.place(list, bare.texts)).status).toBe(200);
      const pair = await chain(list, bare.head, [[w.owner, removeOf(d2.key)], [w.owner, epochOf(0)]], w.seconds());
      expect((await w.place(list, pair.texts)).status).toBe(200);
      expect(removals()).toBe(2);
      // a device-code sign-in (the one a compromised PC holds) and an own sign-in replay each of them
      const typed = w.service.issueToken(ACCOUNT, { device: true });
      const own = w.service.issueToken(ACCOUNT);
      const answers = new Set<string>();
      for (const batch of [bare.texts, pair.texts.slice(1), pair.texts]) {
        for (let sent = 0; sent < 10; sent++) {
          const by = sent % 2 === 0 ? typed : own;
          const answer = await w.place(list, batch, undefined, by);
          answers.add(`${by === typed ? "device code" : "own"}: ${answer.status} ${answer.body.error?.code ?? `placed ${answer.body.placed}`}`);
        }
      }
      expect([...answers].sort()).toEqual(["device code: 403 own_sign_in_required", "own: 200 placed 0"]);
      expect(removals()).toBe(2);
      // the signer's own next removal, at the head, from a sign-in that may not write: refused, and not on its counter
      const next = await chain(list, pair.head, [[w.owner, removeOf(d3.key)]], w.seconds());
      expect(refusal(await w.place(list, next.texts, undefined, typed))).toBe("403 own_sign_in_required");
      expect(removals()).toBe(2);
      // `remove` entries with at most one `epoch` after them: with two, it is counted as any other batch
      const twice = await chain(list, pair.head, [[w.owner, removeOf(d3.key)], [w.owner, epochOf(1)], [w.owner, epochOf(2)]], w.seconds());
      const before = requests();
      const refused = await w.place(list, twice.texts);
      expect([refused.body.error?.reason, removals(), requests()]).toEqual(["epoch_not_needed", 2, before + 1]);
      // the removal alone is placed on the signer's counter; the epoch it calls for, sent alone afterwards, is no removal
      expect((await w.place(list, next.texts)).status).toBe(200);
      expect([removals(), requests()]).toEqual([3, before + 1]);
      expect((await w.place(list, (await chain(list, next.head, [[w.owner, epochOf(1)]], w.seconds())).texts)).status).toBe(200);
      expect([removals(), requests()]).toEqual([3, before + 2]);
    });

    test("R3: one full signer alone cannot grow the list with epoch entries: none is placed that nobody needs", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const a = await addPc(w, list, head);
      const send = (texts: readonly string[]) => pcCall(w, a.pc, "/v2/pc/list/entries", { list, entries: texts });
      const flood = await chain(list, a.head, Array.from({ length: 16 }, (_, made) => [a.key, epochOf(made)] as const), w.seconds());
      for (const answer of [await send(flood.texts), await send(flood.texts.slice(0, 1)), await w.place(list, flood.texts.slice(0, 1))]) {
        expect([refusal(answer), answer.body.error?.index, answer.body.error?.outcome, answer.body.error?.reason]).toEqual(["400 entry_refused", 0, "service", "epoch_not_needed"]);
      }
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(a.head);
      // a removal calls for one epoch, and for one only
      const phone = await addDevice(w, list, a.head);
      const twice = await chain(list, phone.head, [[a.key, removeOf(phone.key)], [a.key, epochOf(0)], [a.key, epochOf(1)]], w.seconds());
      const refused = await send(twice.texts);
      expect([refusal(refused), refused.body.error?.index, refused.body.error?.reason]).toEqual(["400 entry_refused", 2, "epoch_not_needed"]);
      const once = await chain(list, phone.head, [[a.key, removeOf(phone.key)], [a.key, epochOf(0)]], w.seconds());
      expect((await send(once.texts)).status).toBe(200);
      expect((await send((await chain(list, once.head, [[a.key, epochOf(1)]], w.seconds())).texts)).body.error?.reason).toBe("epoch_not_needed");
      // an invite left open past its hour makes names unsealable until it is put out: an epoch meanwhile changes nothing
      const pool = await newKey();
      const invited = await chain(list, once.head, [[w.owner, inviteOf(pool, w.seconds() + 60, true, 1, sealed(1))]], w.seconds());
      expect((await w.place(list, invited.texts)).status).toBe(200);
      const other = await addDevice(w, list, invited.head, sealed(1));
      w.tick(2 * MINUTE);
      const useless = await send((await chain(list, other.head, [[a.key, epochOf(1)]], w.seconds())).texts);
      expect([refusal(useless), useless.body.error?.outcome, useless.body.error?.reason]).toEqual(["400 entry_refused", "service", "epoch_no_use"]);
      // a member is put out with its epoch all the same: a removal is never held up by what else is stale
      const gone = await chain(list, other.head, [[a.key, removeOf(other.key)], [a.key, epochOf(1)]], w.seconds());
      expect((await send(gone.texts)).status).toBe(200);
      const end = await chain(list, gone.head, [[a.key, removeOf(pool)], [a.key, epochOf(2)]], w.seconds());
      expect((await send(end.texts)).status).toBe(200);
      // and the owner still lets a new phone in
      await addDevice(w, list, end.head, null);
    });

    test("R4: a machine with no standing learns nothing of a list from a join-shaped batch: not that it is there, not where its head stands", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await addDevice(w, list, head);
      const outsider = machine();
      const invite = await newKey();
      const fake = await sign(invite, { seq: 40, list, prev: "0".repeat(64) }, await joinOf(await newKey(), list, outsider.endpoint, invite), w.seconds());
      const atHead = await chain(list, phone.head, [[invite, await joinOf(await newKey(), list, outsider.endpoint, invite)]], w.seconds());
      for (const batch of [[fake.text], atHead.texts, ["no entry"]]) {
        const answer = await pcCall(w, outsider, "/v2/pc/list/entries", { list, entries: batch });
        expect([answer.status, answer.body.error]).toEqual([404, { code: "not_found", message: "Unknown request" }]);
      }
      expect(refusal(await pcCall(w, outsider, "/v2/pc/list/entries", { list: "0".repeat(64), entries: [fake.text] }))).toBe("404 not_found");
    });

    test("R7: no entry is placed that is dated more than ten minutes ahead of the service's clock, the first one of a list included", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await addDevice(w, list, head);
      const far = w.seconds() + 10 * 365 * 86400;
      for (const one of [
        await chain(list, phone.head, [[w.owner, removeOf(phone.key)]], far),
        await chain(list, phone.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 900)]], w.seconds() + 11 * 60),
      ]) {
        const answer = await w.place(list, one.texts);
        expect([refusal(answer), answer.body.error?.index, answer.body.error?.outcome, answer.body.error?.reason]).toEqual(["400 entry_refused", 0, "service", "issued_at_ahead"]);
      }
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(phone.head);
      expect((await w.place(list, (await chain(list, phone.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 900)]], w.seconds() + 9 * 60)).texts)).status).toBe(200);
      // a genesis from the future starts no list
      const other = w.service.issueToken("acct_2");
      const first = await newKey();
      const zero = await sign(first, { seq: 0, list: "", prev: "" }, { ...genesisOf(first, "acct_2"), sealed: null } as ListKind, far);
      const made = await w.call("POST", "/v2/lists", { entry: zero.text }, other);
      expect([refusal(made), made.body.error?.index, made.body.error?.reason]).toEqual(["400 entry_refused", 0, "issued_at_ahead"]);
      expect(w.service.accountList("acct_2")).toBeNull();
    });

    test("R9: a reveal is taken once: another for the same attempt, from any sign-in, changes nothing", async () => {
      const w = await world();
      const { list } = await w.start();
      const pc = machine();
      await listPc(w, pc);
      const keys = await newKey();
      expect((await pcCall(w, pc, "/v2/pc/list/keys", { list, key: keys.key, enc: keys.enc, card: await cardOf(keys, list, pc.endpoint) })).status).toBe(200);
      const value = (n: number) => toBase64Url(new Uint8Array(32).fill(n));
      const path = `/v2/lists/${list}/posts/${pc.endpoint}/attempt`;
      const body = { key: keys.key, adder: (await newKey()).key, commitment: value(1) };
      expect((await w.call("POST", path, body, w.token)).status).toBe(200);
      expect((await pcCall(w, pc, "/v2/pc/list/attempt", { list, commitment: value(1), nonce: value(2) })).status).toBe(200);
      expect((await w.call("POST", path, { ...body, reveal: value(3) }, w.token)).status).toBe(200);
      const other = w.service.issueToken(ACCOUNT);
      expect(refusal(await w.call("POST", path, { ...body, reveal: value(4) }, other))).toBe("409 attempt_changed");
      expect((await w.call("POST", path, { ...body, reveal: value(3) }, other)).body.attempt).toMatchObject({ reveal: value(3) });
      expect((await pcCall(w, pc, "/v2/pc/list/attempt", { list })).body.attempt).toMatchObject({ nonce: value(2), reveal: value(3) });
    });

    test("R11: an own sign-in two hours old with no key proof places no invite; with the make proof it does, and a batch holds one", async () => {
      const w = await world();
      w.service.opensAll = true;
      const { list, head } = await w.start();
      const a = await addPc(w, list, head);
      const registered = await newKey();
      const copied = staleSignIn(w, registered);
      w.tick(110 * MINUTE);
      const pool = await newKey();
      const signed = await chain(list, a.head, [[a.key, inviteOf(pool, w.seconds() + 600)]], w.seconds());
      expect(refusal(await w.place(list, signed.texts, undefined, copied))).toBe("403 session_not_fresh");
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(a.head);
      // a key proof needs an invite to prove
      const lone = await chain(list, a.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)], [w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      const twoInvites = await w.place(list, lone.texts, undefined, w.service.issueToken(ACCOUNT));
      expect([refusal(twoInvites), twoInvites.body.error?.index, twoInvites.body.error?.reason]).toEqual(["400 entry_refused", 1, "invite_alone"]);
      const phone = await newKey();
      await w.claim(list, phone, w.service.issueToken(ACCOUNT));
      const plain = await chain(list, a.head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      const proofFor = async (purpose: string, slot: string) => keyProof(w, copied, registered, purpose as PcAddPurpose, "", slot);
      const stray = await w.call("POST", `/v2/lists/${list}/entries`, { entries: plain.texts, key_proof: await proofFor("invite-auto", pool.key) }, w.service.issueToken(ACCOUNT));
      expect(refusal(stray)).toBe("400 invalid_request");
      // a proof for the plain purpose, or for another key, proves nothing for an auto invite; the make proof places it
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: signed.texts, key_proof: await proofFor("invite", pool.key) }, copied))).toBe("403 session_not_fresh");
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: signed.texts, key_proof: await proofFor("invite-auto", phone.key) }, copied))).toBe("403 session_not_fresh");
      expect((await w.call("POST", `/v2/lists/${list}/entries`, { entries: signed.texts, key_proof: await proofFor("invite-auto", pool.key) }, copied)).status).toBe(200);
    });

    test("R14: attempts that open nothing spend nothing: a sign-in cannot lock a PC's Add out before the PC has posted", async () => {
      const w = await world();
      const { list } = await w.start();
      const pc = machine();
      const copied = w.service.issueToken(ACCOUNT);
      w.tick(120 * MINUTE);
      const value = (n: number) => toBase64Url(new Uint8Array(32).fill(n));
      const path = `/v2/lists/${list}/posts/${pc.endpoint}/attempt`;
      for (let sent = 0; sent < 8; sent++) expect(refusal(await w.call("POST", path, { key: (await newKey()).key, adder: (await newKey()).key, commitment: value(sent + 1) }, copied))).toBe("409 post_changed");
      expect(counted(w, `list_attempts:${pc.endpoint}:${ACCOUNT}`)).toBe(0);
      await listPc(w, pc, w.service.issueToken(ACCOUNT));
      const keys = await newKey();
      expect((await pcCall(w, pc, "/v2/pc/list/keys", { list, key: keys.key, enc: keys.enc, card: await cardOf(keys, list, pc.endpoint) })).status).toBe(200);
      for (let sent = 0; sent < 8; sent++) expect((await w.call("POST", path, { key: (await newKey()).key, adder: w.owner.key, commitment: value(sent + 1) }, copied)).status).toBe(409);
      expect((await w.call("POST", path, { key: keys.key, adder: w.owner.key, commitment: value(9) }, w.service.issueToken(ACCOUNT))).status).toBe(200);
      expect(counted(w, `list_attempts:${pc.endpoint}:${ACCOUNT}`)).toBe(1);
    });

    test("R5: a batch whose second entry the service refuses stores nothing, not its wraps, and the first's claim stays; an entry that counts only after the one before it is placed with it", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await newKey();
      expect((await w.claim(list, phone, w.service.issueToken(ACCOUNT))).status).toBe(200);
      const first = await sign(w.owner, { seq: head.seq + 1, list, prev: head.hash }, await deviceOf(phone, list), w.seconds());
      const second = await sign(w.owner, { seq: first.head.seq + 1, list, prev: first.head.hash }, inviteOf(await newKey(), w.seconds() + 4000), w.seconds() + 3600);
      const answer = await w.place(list, [first.text, second.text], [{ epoch: 0, member: phone.enc, wrap: WRAP(2) }]);
      expect([refusal(answer), answer.body.error?.index, answer.body.error?.reason]).toEqual(["400 entry_refused", 1, "issued_at_ahead"]);
      const held = w.service.accountList(ACCOUNT)!;
      expect([held.entries.length, held.wraps.length, held.claims.length]).toEqual([1, 1, 1]);
      const gone = await newKey();
      await w.claim(list, gone);
      const addGone = await chain(list, head, [[w.owner, await deviceOf(gone, list)]], w.seconds());
      expect((await w.place(list, addGone.texts)).status).toBe(200);
      const together = await chain(list, addGone.head, [[w.owner, removeOf(gone)], [w.owner, epochOf(0)], [w.owner, { ...(await deviceOf(phone, list)), sealed: sealed(1) } as ListKind]], w.seconds());
      expect((await w.place(list, together.texts)).status).toBe(200);
    });

    test("R10: a PC listed in account X posts to account Y's list, and Y's member signs its pc: refused both ways; X reads nothing of Y", async () => {
      const w = await world();
      await w.start();
      const yToken = w.service.issueToken("acct_2");
      const yOwner = await newKey();
      const yGenesis = await sign(yOwner, { seq: 0, list: "", prev: "" }, genesisOf(yOwner, "acct_2"), w.seconds());
      const y = (await w.call("POST", "/v2/lists", { entry: yGenesis.text }, yToken)).body.list as string;
      const x = w.service.accountList(ACCOUNT)!.id;
      const pc = machine();
      await listPc(w, pc);
      const who = await newKey();
      const postTo = async (list: string) => pcCall(w, pc, "/v2/pc/list/keys", { list, key: who.key, enc: who.enc, card: await cardOf(who, list, pc.endpoint) });
      expect(refusal(await postTo(y))).toBe("404 not_found");
      expect((await postTo(x)).status).toBe(200);
      const inY = await chain(y, yGenesis.head, [[yOwner, await pcOf(who, y, pc.endpoint)]], w.seconds());
      expect(refusal(await w.place(y, inY.texts, undefined, yToken))).toBe("403 not_posted");
      expect(refusal(await w.log(y))).toBe("404 not_found");
      expect(refusal(await w.call("GET", `/v2/lists/${y}/claims`, undefined, w.token))).toBe("404 not_found");
    });

    test("R12: a second genesis from a sign-in older than ten minutes answers 409 list_exists, not 403", async () => {
      const w = await world();
      await w.start();
      const old = w.service.issueToken(ACCOUNT);
      w.tick(30 * MINUTE);
      const again = await sign(w.owner, { seq: 0, list: "", prev: "" }, genesisOf(w.owner), w.seconds());
      expect(refusal(await w.call("POST", "/v2/lists", { entry: again.text }, old))).toBe("409 list_exists");
    });

    test("R13: an unlisted PC posting a card that does not hold sees the unknown route", async () => {
      const w = await world();
      const { list } = await w.start();
      const who = await newKey();
      expect(refusal(await pcCall(w, machine(), "/v2/pc/list/keys", { list, key: who.key, enc: who.enc, card: "A".repeat(86) }))).toBe("404 not_found");
    });
  });

  describe("tamper mode: each lie is served", () => {
    /** A list of four entries: genesis, an invite, a device and another invite, and the device's sign-in. */
    async function told() {
      const w = await world();
      const { list, head, first } = await w.start();
      const phone = await newKey();
      const phoneToken = w.service.issueToken(ACCOUNT);
      await w.claim(list, phone, phoneToken);
      const placed = await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)], [w.owner, await deviceOf(phone, list)]], w.seconds());
      expect((await w.place(list, placed.texts, [{ epoch: 0, member: phone.enc, wrap: WRAP(2) }])).status).toBe(200);
      const more = await chain(list, placed.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      expect((await w.place(list, more.texts)).status).toBe(200);
      return { w, list, all: [first, ...placed.texts, ...more.texts], head: more.head, phone, phoneToken };
    }

    test("inject: an entry of a key that is no member is served after the log, and a member passes it over", async () => {
      const { w, list, all, head } = await told();
      const stranger = await newKey();
      const invited = await newKey();
      const injected = await chain(list, head, [[stranger, inviteOf(invited, w.seconds() + 600)]], w.seconds());
      w.service.tamperList(list, { inject: injected.texts });
      const served = await w.log(list);
      expect([served.body.entries, served.body.head]).toEqual([[...all, ...injected.texts], injected.head]);
      const replayed = await replayList(served.body.entries!, 1, { saved: null });
      expect(replayed.stopped).toBeNull();
      expect([replayed.member?.state.signers[stranger.key], replayed.member?.state.signers[invited.key], replayed.member?.state.invites[invited.key]]).toEqual([undefined, undefined, undefined]);
      expect(w.service.accountList(ACCOUNT)?.entries).toEqual(all);
    });

    test("wraps: a wrap of the service's own is served in place of the stored one", async () => {
      const { w, list, phone } = await told();
      w.service.tamperList(list, { wraps: [{ epoch: 0, member: phone.enc, wrap: WRAP(66) }] });
      expect((await w.call("GET", `/v2/lists/${list}/wraps?member=${phone.enc}`, undefined, w.token)).body.wraps).toEqual([{ epoch: 0, wrap: WRAP(66) }]);
    });

    test("withholdAfter: one reader's log ends at that seq, its head with it, while the others read on", async () => {
      const { w, list, all, phoneToken } = await told();
      w.service.tamperList(list, { reader: { token: phoneToken }, withholdAfter: 1 });
      const lied = await w.log(list, "", phoneToken);
      expect([lied.body.entries, lied.body.head?.seq, lied.body.more]).toEqual([all.slice(0, 2), 1, false]);
      expect((await w.call("GET", "/v2/lists/mine", undefined, phoneToken)).body.head?.seq).toBe(1);
      expect((await w.log(list)).body.entries).toEqual(all);
      const pc = machine();
      await listPc(w, pc);
      w.service.tamperList(list, { reader: { server_id: pc.serverId }, withholdAfter: 2 });
      expect(((await pull(w, pc)).list as { head: ListPlace }).head.seq).toBe(2);
      expect((await pcCall(w, pc, "/v2/pc/list/log", { list })).body.entries).toEqual(all.slice(0, 3));
    });

    test("withholdAfter for every reader replays an old prefix: a member that holds more keeps its head", async () => {
      const { w, list, all } = await told();
      const member = (await replayList(all, 1, { saved: null })).member!;
      w.service.tamperList(list, { withholdAfter: 1 });
      expect((await w.log(list)).body.entries).toEqual(all.slice(0, 2));
      const served = await w.log(list, "?after=3");
      expect([served.body.entries, served.body.head?.seq]).toEqual([[], 1]);
      const shown = await shownList(member, { after: 3, entries: served.body.entries!, head: served.body.head! });
      expect([shown.member.entries, shown.stuck]).toEqual([all, false]);
    });

    test("head: every answer reports a head the log does not reach, or an old one", async () => {
      const { w, list, all, head } = await told();
      const beyond = { seq: head.seq + 5, hash: "ab".repeat(32) };
      w.service.tamperList(list, { head: beyond });
      const served = await w.log(list);
      expect([served.body.entries, served.body.head, served.body.more]).toEqual([all, beyond, false]);
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body.head).toEqual(beyond);
      w.service.untamperList(list);
      w.service.tamperList(list, { head: { seq: 1, hash: entryHash(entryFromText(all[1]!).body) } });
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body.head?.seq).toBe(1);
      expect((await w.log(list)).body.entries).toEqual(all);
    });

    test("fork: two readers are served two valid member-signed continuations at the same seq", async () => {
      const { w, list, all, head, phoneToken } = await told();
      const ours = await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      expect((await w.place(list, ours.texts)).status).toBe(200);
      const theirs = await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      w.service.tamperList(list, { reader: { token: phoneToken }, fork: theirs.texts });
      const toPhone = await w.log(list, "", phoneToken);
      const toOwner = await w.log(list);
      expect([toPhone.body.entries, toPhone.body.head]).toEqual([[...all, ...theirs.texts], theirs.head]);
      expect([toOwner.body.entries, toOwner.body.head]).toEqual([[...all, ...ours.texts], ours.head]);
      for (const entries of [toPhone.body.entries!, toOwner.body.entries!]) expect((await replayList(entries, 1, { saved: null })).stopped).toBeNull();
    });

    test("pages: pages end after the cuts with more true, and asking on after the last seq joins the whole log", async () => {
      const { w, list, all } = await told();
      w.service.tamperList(list, { pages: [0, 2] });
      const pages: (readonly string[])[] = [];
      let after: number | null = null;
      for (let more = true; more;) {
        const page: Called = await w.log(list, after === null ? "" : `?after=${after}`);
        pages.push(page.body.entries!);
        after = (after ?? -1) + page.body.entries!.length;
        more = page.body.more!;
      }
      expect(pages.map((page) => page.length)).toEqual([1, 2, 1]);
      expect(pages.flat()).toEqual(all);
    });

    test("listId: another id is reported as the account's list while the log is unchanged", async () => {
      const { w, list, all } = await told();
      const pc = machine();
      await listPc(w, pc);
      const wrong = OPENS(9);
      w.service.tamperList(list, { listId: wrong });
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body.list).toBe(wrong);
      expect((await pcCall(w, pc, "/v2/pc/list", { account: ACCOUNT })).body.list).toBe(wrong);
      expect(((await pull(w, pc)).list as { id: string }).id).toBe(wrong);
      expect((await w.log(list)).body).toMatchObject({ list, entries: all });
      expect(w.service.accountList(ACCOUNT)?.id).toBe(list);
    });

    test("answerList: another account's list is answered under this one's id, and its entry 0 is not the pinned one", async () => {
      const { w, list } = await told();
      const elsewhere = w.service.issueToken("acct_2");
      const stranger = await newKey();
      const theirs = await sign(stranger, { seq: 0, list: "", prev: "" }, genesisOf(stranger, "acct_2"), w.seconds());
      const made = await w.call("POST", "/v2/lists", { entry: theirs.text }, elsewhere);
      w.service.tamperList(list, { answerList: made.body.list as string });
      const served = await w.log(list);
      expect([served.body.list, served.body.entries]).toEqual([list, [theirs.text]]);
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body.list).toBe(made.body.list);
      expect((await replayList(served.body.entries!, 1, { saved: null, given: list })).stopped?.code).toBe("list_mismatch");
    });

    test("flipEntry and flipWrap: one byte of an entry or a wrap is flipped as served", async () => {
      const { w, list, all, phone } = await told();
      w.service.tamperList(list, { flipEntry: { seq: 2 }, flipWrap: { member: phone.enc, epoch: 0, byte: 0 } });
      const served = await w.log(list);
      expect(served.body.entries?.filter((text, seq) => text !== all[seq])).toHaveLength(1);
      const stopped = (await replayList(served.body.entries!, 1, { saved: null })).stopped;
      expect([stopped?.seq, ["signature_invalid", "entry_malformed"].includes(stopped?.code ?? "")]).toEqual([2, true]);
      const wrap = (await w.call("GET", `/v2/lists/${list}/wraps?member=${phone.enc}`, undefined, w.token)).body.wraps![0]!.wrap;
      expect(Array.from(fromBase64Url(wrap)).filter((byte, at) => byte !== fromBase64Url(WRAP(2))[at])).toHaveLength(1);
    });

    test("headMoved: every placement is refused head_moved forever, and nothing is placed", async () => {
      const { w, list, head } = await told();
      w.service.tamperList(list, { headMoved: true });
      const batch = await chain(list, head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = await w.place(list, batch.texts);
        expect([refusal(refused), refused.body.error?.head]).toEqual(["409 head_moved", head]);
      }
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(head);
    });

    test("dropWraps: a placed batch's entries are stored and its wraps are not", async () => {
      const { w, list, head } = await told();
      w.service.tamperList(list, { dropWraps: true });
      const tablet = await newKey();
      await w.claim(list, tablet);
      const added = await chain(list, head, [[w.owner, await deviceOf(tablet, list)]], w.seconds());
      expect((await w.place(list, added.texts, [{ epoch: 0, member: tablet.enc, wrap: WRAP(3) }])).status).toBe(200);
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(added.head);
      expect((await w.call("GET", `/v2/lists/${list}/wraps?member=${tablet.enc}`, undefined, w.token)).body.wraps).toEqual([]);
      expect(w.service.accountList(ACCOUNT)?.wraps.map(({ member }) => member)).not.toContain(tablet.enc);
    });

    test("rebuilding and stopped: placements, and a PC's reads whose only right is its row in the list, answer 503", async () => {
      const { w, list, head } = await told();
      const confirmed = machine();
      await listPc(w, confirmed);
      const added = await addPc(w, list, head);
      // the PC added by the list is then dropped from the directory: its only right is its row
      expect((await w.call("DELETE", `/v1/pcs/${added.pc.serverId}`, undefined, w.service.issueToken(ACCOUNT))).status).toBe(204);
      const batch = await chain(list, added.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 600)]], w.seconds());
      w.service.tamperList(list, { rebuilding: true });
      const busy = await w.place(list, batch.texts);
      expect([refusal(busy), busy.headers.get("retry-after")]).toEqual(["503 list_rebuilding", "1"]);
      expect(refusal(await pcCall(w, added.pc, "/v2/pc/list/log", { list }))).toBe("503 list_rebuilding");
      expect((await pcCall(w, confirmed, "/v2/pc/list/log", { list })).status).toBe(200);
      w.service.untamperList(list);
      w.service.tamperList(list, { stopped: true });
      expect(refusal(await w.place(list, batch.texts))).toBe("503 list_stopped");
      expect(refusal(await pcCall(w, added.pc, "/v2/pc/list", { account: ACCOUNT }))).toBe("503 list_stopped");
      w.service.untamperList(list);
      expect((await w.place(list, batch.texts)).status).toBe(200);
    });
  });

  describe("S2: the link, the snapshot, one invite, wraps with no entry (D11)", () => {
    test("D11.2's vector: a link's two halves are over the library's 357 bytes, each under its own key and no other", async () => {
      const vector = {
        account: "TEST-ONLY-account", list: "1e02680cc5e01ec2c5c7ebaf0a37a1007dd79352492b040879f664cfc142d54c",
        key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5lhuexKpDRsxAK4WTOjTQTjBurzk0iGngvCpNGetUiwtppuB-SgVWvMwkHCQe6FNPoAzLJZntcFyjzv0sk82Bg",
        device: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVMfhqT7llP9gRR8DB4RLbsL-kQmlkQnKxvJUV6DKvpBKDyennnEbD6f1HOM687iSzBnjcltJ9OLFSM_Tcbr2rw",
      };
      const member = canonicalBase64Url("kCfnXvVzpgmrcZ2AnxdsTl2XM_JV-2xWQwnmfQ1eUtA1VqiFxWFChAUe5Lu5FBdWFK_EpbV637LNW0pE77Grig")!;
      const device = canonicalBase64Url("aqWL_uCE1CQy0sJiiBk_kzmmjM8Z-r6OY0uM9wxp5sGJ1we7IeDKSmjqkZm6_-iS-qhVAgbuFy4kdQhat4eCQg")!;
      const bytes = linkBytes(vector);
      expect([bytes.length, bytesToHex(bytes.slice(0, 16))]).toEqual([357, "6f7669732d6c6973742d6c696e6b2f31"]);
      expect([await verifySignature(bytes, member, vector.key), await verifySignature(bytes, device, vector.device)]).toEqual([true, true]);
      expect([await verifySignature(bytes, member, vector.device), await verifySignature(bytes, device, vector.key)]).toEqual([false, false]);
      expect(await verifySignature(linkBytes({ ...vector, key: vector.device, device: vector.key }), member, vector.key)).toBe(false);
    });

    test("a link rides on the genesis, a claim or the links route, only with the registered key's own signature: a bare text is link_unsigned, any other half link_invalid", async () => {
      const w = await world();
      const ownerReg = await newKey();
      const ownerTok = signedIn(w, ownerReg);
      const first = await sign(w.owner, { seq: 0, list: "", prev: "" }, genesisOf(w.owner), w.seconds());
      const list = first.head.hash;
      const good = await linkOf(list, w.owner, ownerReg);
      const make = (link: unknown, bearer = ownerTok) => w.call("POST", "/v2/lists", { entry: first.text, link }, bearer);
      expect(refusal(await make(good.member))).toBe("400 link_unsigned");
      expect(refusal(await make({ member: good.member }))).toBe("400 invalid_request");
      expect(refusal(await make({ member: good.member, device: good.member }))).toBe("400 link_invalid");
      // another sign-in's registered key, or a sign-in that registered none, is not what the link names
      expect(refusal(await make(good, signedIn(w, await newKey())))).toBe("400 link_invalid");
      expect(refusal(await make(good, w.token))).toBe("400 link_invalid");
      expect(w.service.accountList(ACCOUNT)).toBeNull();
      expect((await make(good)).status).toBe(201);
      expect(w.service.accountList(ACCOUNT)?.links).toEqual([{ key: w.owner.key, device: ownerReg.key }]);
      // a claim keeps its link, written with the member when its entry is placed
      const phone = await newKey();
      const phoneReg = await newKey();
      const phoneTok = signedIn(w, phoneReg);
      expect(refusal(await w.claim(list, phone, phoneTok, { link: (await linkOf(list, phone, phoneReg)).member }))).toBe("400 link_unsigned");
      expect(refusal(await w.claim(list, phone, phoneTok, { link: await linkOf(list, phone, ownerReg) }))).toBe("400 link_invalid");
      expect((await w.claim(list, phone, phoneTok, { link: await linkOf(list, phone, phoneReg) })).status).toBe(200);
      expect(w.service.accountList(ACCOUNT)?.links).toHaveLength(1);
      const added = await chain(list, w.service.accountList(ACCOUNT)!.head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      expect((await w.place(list, added.texts)).status).toBe(200);
      expect(w.service.accountList(ACCOUNT)?.links).toContainEqual({ key: phone.key, device: phoneReg.key });
      // the links route: for a device that is in, the link of this very sign-in's key
      const links = (key: string, link: unknown, bearer: string) => w.call("POST", `/v2/lists/${list}/links`, { key, link }, bearer);
      const laterReg = await newKey();
      const laterTok = signedIn(w, laterReg);
      expect(refusal(await links(phone.key, (await linkOf(list, phone, laterReg)).member, laterTok))).toBe("400 link_unsigned");
      expect(refusal(await links(phone.key, await linkOf(list, phone, phoneReg), laterTok))).toBe("400 link_invalid");
      const stranger = await newKey();
      expect(refusal(await links(stranger.key, await linkOf(list, stranger, laterReg), laterTok))).toBe("409 not_member");
      expect(refusal(await links("no key", good, laterTok))).toBe("400 invalid_request");
      expect(refusal(await links(phone.key, good, w.service.issueToken(ACCOUNT, { device: true })))).toBe("403 own_sign_in_required");
      // the phone's holder signed in again: its new key takes the member key's link, the earlier one is replaced
      expect((await links(phone.key, await linkOf(list, phone, laterReg), laterTok)).body).toMatchObject({ key: phone.key, linked: true });
      expect(w.service.accountList(ACCOUNT)?.links).toEqual([{ key: w.owner.key, device: ownerReg.key }, { key: phone.key, device: laterReg.key }]);
    });

    test("a sign-in is one device: its key is linked to one member key that is in, a second link is link_taken, and a key that changed hands its link on", async () => {
      const w = await world();
      const { list, head } = await startLinked(w);
      const phone = await addLinked(w, list, head);
      const tablet = await addLinked(w, list, phone.head, { link: false });
      const taken = await w.call("POST", `/v2/lists/${list}/links`, { key: tablet.key.key, link: await linkOf(list, tablet.key, phone.reg) }, phone.bearer);
      expect(refusal(taken)).toBe("409 link_taken");
      // a claim taken over by a sign-in that sends no link carries none
      const next = await newKey();
      expect((await w.claim(list, next, phone.bearer, { link: await linkOf(list, next, phone.reg) })).status).toBe(200);
      const rotated = await chain(list, tablet.head, [[phone.key, await deviceOf(next, list, true)]], w.seconds());
      expect((await w.place(list, rotated.texts)).status).toBe(200);
      const links = w.service.accountList(ACCOUNT)!.links;
      expect([links.some(({ key }) => key === phone.key.key), links.find(({ key }) => key === next.key)?.device]).toEqual([false, phone.reg.key]);
      // the phone's old key is out, so a link that named it gives way to the tablet's
      expect((await w.call("POST", `/v2/lists/${list}/links`, { key: tablet.key.key, link: await linkOf(list, tablet.key, tablet.reg) }, tablet.bearer)).status).toBe(200);
    });

    test("a claim's link is written only while the sign-in that claimed still holds the key it named; its device is let in all the same", async () => {
      const w = await world();
      const { list, head } = await startLinked(w);
      const phone = await newKey();
      const phoneReg = await newKey();
      const phoneTok = signedIn(w, phoneReg);
      expect((await w.claim(list, phone, phoneTok, { link: await linkOf(list, phone, phoneReg) })).status).toBe(200);
      w.service.removeDevice(ACCOUNT, phoneReg.key);
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      expect((await w.place(list, added.texts)).status).toBe(200);
      expect(w.service.accountList(ACCOUNT)?.links.map(({ key }) => key)).toEqual([w.owner.key]);
    });

    test("the snapshot of a list account: Step 2's rules, plus at once a device another member allowed and linked while a member up the chain passes them, whatever the switch says", async () => {
      const w = await world();
      w.service.opensAll = true;
      const { list, head, ownerReg } = await startLinked(w);
      const pc = machine();
      await listPc(w, pc);
      const phone = await addLinked(w, list, head);
      const bare = await addLinked(w, list, phone.head, { link: false });
      const stranger = await newKey();
      signedIn(w, stranger, false);
      const read = await snapshotOf(w, pc);
      expect([read.eligible[ownerReg.key], read.eligible[phone.reg.key], read.eligible[bare.reg.key], read.eligible[stranger.key]]).toEqual([true, true, false, false]);
      // "has a list" is the list itself, whatever OVIS_LIST_ACCOUNTS says
      w.service.listAccounts = "";
      expect((await snapshotOf(w, pc)).eligible[phone.reg.key]).toBe(true);
      w.service.listAccounts = "*";
      // a stopped list adds nobody; one read again answers 503 and the PC keeps what it read
      w.service.tamperList(list, { stopped: true });
      expect((await snapshotOf(w, pc)).eligible[phone.reg.key]).toBe(false);
      w.service.untamperList(list);
      w.service.tamperList(list, { rebuilding: true });
      const busy = await pcCall(w, pc, "/v1/pc/snapshot", { account: ACCOUNT });
      expect([refusal(busy), busy.headers.get("retry-after")]).toEqual(["503 list_rebuilding", "1"]);
      w.service.untamperList(list);
      // the chain: once nobody up it passes Step 2, the phone waits on its own sign-in's rules
      w.service.removeDevice(ACCOUNT, ownerReg.key);
      expect((await snapshotOf(w, pc)).eligible[phone.reg.key]).toBe(false);
    });

    test("a device put out of the list is signed out and its registered key removed in the same write; one that only changed its key stays", async () => {
      const w = await world();
      w.service.opensAll = true;
      const { list, head } = await startLinked(w);
      const pc = machine();
      await listPc(w, pc);
      const phone = await addLinked(w, list, head);
      const unlinked = await addLinked(w, list, phone.head, { link: false });
      const next = await newKey();
      expect((await w.claim(list, next, phone.bearer, { link: await linkOf(list, next, phone.reg) })).status).toBe(200);
      const rotated = await chain(list, unlinked.head, [[phone.key, await deviceOf(next, list, true)]], w.seconds());
      expect((await w.place(list, rotated.texts)).status).toBe(200);
      expect((await w.call("GET", "/v2/lists/mine", undefined, phone.bearer)).status).toBe(200);
      const out = await chain(list, rotated.head, [[w.owner, removeOf(next)], [w.owner, removeOf(unlinked.key)]], w.seconds());
      expect((await w.place(list, out.texts)).status).toBe(200);
      expect(refusal(await w.call("GET", "/v2/lists/mine", undefined, phone.bearer))).toBe("401 unauthorized");
      // a device that never linked is not signed out: the service does not know its sign-in
      expect((await w.call("GET", "/v2/lists/mine", undefined, unlinked.bearer)).status).toBe(200);
      const read = await snapshotOf(w, pc);
      expect([read.removed.includes(phone.reg.key), phone.reg.key in read.eligible, read.removed.includes(unlinked.reg.key)]).toEqual([true, false, false]);
    });

    test("placing a list's invite makes the service's invite of that key, to the entry's exp; a PC redeems one only while the list holds it open", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const pool = await newKey();
      const pc = machine();
      // an invite made by POST /v1/pc-invites alone redeems nothing for an account that has a list
      expect((await w.call("POST", "/v1/pc-invites", { invite_key: pool.key, auto: true }, w.service.issueToken(ACCOUNT))).status).toBe(200);
      expect(refusal(await redeemCall(w, pc, pool))).toBe("409 invite_not_in_list");
      // the entry takes that invite as it is (same key, same auto, an exp within its end): no second one is made
      const invited = await chain(list, head, [[w.owner, inviteOf(pool, w.seconds() + 600)]], w.seconds());
      expect((await w.place(list, invited.texts)).status).toBe(200);
      const shown = async () => (await w.call("GET", "/v1/pc-invites", undefined, w.token)).body as unknown as { invites: { auto: boolean; expires_at: string; yours: boolean; used_at: string | null }[] };
      expect((await shown()).invites).toHaveLength(1);
      w.service.tamperList(list, { rebuilding: true });
      expect(refusal(await redeemCall(w, pc, pool))).toBe("503 list_rebuilding");
      w.service.untamperList(list);
      expect((await redeemCall(w, pc, pool)).status).toBe(200);
      // an entry alone makes the service's invite, by the sign-in that placed it, ending at the entry's exp
      const plain = await chain(list, invited.head, [[w.owner, inviteOf(await newKey(), w.seconds() + 300, false, 1, null)]], w.seconds());
      expect((await w.place(list, plain.texts)).status).toBe(200);
      expect((await shown()).invites.find((invite) => !invite.auto)).toMatchObject({ expires_at: new Date((w.seconds() + 300) * 1000).toISOString(), yours: true, used_at: null });
    });

    test("an invite entry whose service invite cannot be made is not placed: exp_too_late, uses_one, invite_key_used, invites_full, pc_add_cap", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const one = async (kind: ListKind) => w.place(list, (await chain(list, head, [[w.owner, kind]], w.seconds())).texts);
      const reasonOf = (called: Called) => [refusal(called), called.body.error?.index, called.body.error?.reason];
      expect(reasonOf(await one(inviteOf(await newKey(), w.seconds() + 901)))).toEqual(["400 entry_refused", 0, "exp_too_late"]);
      expect(reasonOf(await one(inviteOf(await newKey(), w.seconds() + 600, true, 2)))).toEqual(["400 entry_refused", 0, "uses_one"]);
      // a key an invite had (here of the other kind), or one a device registered, is never an invite's
      const made = await newKey();
      expect((await w.call("POST", "/v1/pc-invites", { invite_key: made.key, auto: false }, w.service.issueToken(ACCOUNT))).status).toBe(200);
      expect(refusal(await one(inviteOf(made, w.seconds() + 600, true)))).toBe("409 invite_key_used");
      const device = await newKey();
      signedIn(w, device);
      expect(refusal(await one(inviteOf(device, w.seconds() + 600)))).toBe("409 invite_key_used");
      // the invite made first ends before this exp
      w.tick(5 * MINUTE);
      expect(reasonOf(await one(inviteOf(made, w.seconds() + 700, false)))).toEqual(["400 entry_refused", 0, "exp_too_late"]);
      // an auto invite stops at the day's one-press adds; a plain one does not
      (w.service as unknown as { admitTimes: Map<string, number[]> }).admitTimes.set(ACCOUNT, [T0, T0, T0]);
      const capped = await one(inviteOf(await newKey(), w.seconds() + 600));
      expect([refusal(capped), Number(capped.headers.get("retry-after")) > 0]).toEqual(["429 pc_add_cap", true]);
      // five open invites, the list's among them
      for (let made = 0; made < 4; made++) expect((await w.call("POST", "/v1/pc-invites", { invite_key: (await newKey()).key }, w.service.issueToken(ACCOUNT))).status).toBe(200);
      expect(refusal(await one(inviteOf(await newKey(), w.seconds() + 600, false)))).toBe("409 invites_full");
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(head);
    });

    test("a counted remove of an invite's key revokes its service invite while nobody used it; one a PC used is left as it is", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const pool = await newKey();
      const used = await newKey();
      const first = await chain(list, head, [[w.owner, inviteOf(pool, w.seconds() + 600, true, 1, null)]], w.seconds());
      expect((await w.place(list, first.texts)).status).toBe(200);
      const second = await chain(list, first.head, [[w.owner, inviteOf(used, w.seconds() + 600, true, 1, null)]], w.seconds());
      expect((await w.place(list, second.texts)).status).toBe(200);
      await redeem(w, machine(), used);
      const out = await chain(list, second.head, [[w.owner, removeOf(pool)], [w.owner, removeOf(used)]], w.seconds());
      expect((await w.place(list, out.texts)).status).toBe(200);
      const shown = (await w.call("GET", "/v1/pc-invites", undefined, w.token)).body as unknown as { invites: { used_at: string | null }[] };
      expect(shown.invites.map((invite) => invite.used_at !== null)).toEqual([true]);
      expect(refusal(await redeemCall(w, machine(), pool))).toBe("400 invite_invalid");
      // an invite placed and put out in one batch leaves no open invite at the service
      const brief = await newKey();
      const both = await chain(list, out.head, [[w.owner, inviteOf(brief, w.seconds() + 600, true, 1, null)], [w.owner, removeOf(brief)]], w.seconds());
      expect((await w.place(list, both.texts)).status).toBe(200);
      expect(refusal(await redeemCall(w, machine(), brief))).toBe("400 invite_invalid");
    });

    test("an account that has a list hands out no one-press admission: the PC's take is refused, a retry of one taken before the list too", async () => {
      const w = await world();
      w.service.opensAll = true;
      const pc = machine();
      await listPc(w, pc, w.service.issueToken(ACCOUNT, { device: true }));
      expect((await w.call("POST", `/v1/pcs/${pc.serverId}/admit`, {}, w.service.issueToken(ACCOUNT))).status).toBe(200);
      const take = (who = pc) => pcCall(w, who, "/v1/pc/admission", { account: ACCOUNT });
      expect((await take()).status).toBe(200);
      await w.start();
      expect(refusal(await take())).toBe("409 list_add");
      // told only to a PC an admission waits for
      const other = machine();
      await listPc(w, other);
      expect(refusal(await take(other))).toBe("404 no_admission");
    });

    test("wraps with no entry: for the current epoch and a key it is wrapped to, never over one that stands, from a sign-in linked to a device that is in, or a PC in the list", async () => {
      const w = await world();
      const { list, head } = await startLinked(w);
      const phone = await addLinked(w, list, head);
      const put = (wraps: unknown, bearer: string) => w.call("PUT", `/v2/lists/${list}/wraps`, { wraps }, bearer);
      const mine = { epoch: 0, member: phone.key.enc, wrap: WRAP(7) };
      expect(refusal(await put([mine], w.token))).toBe("403 not_linked");
      expect(refusal(await put([], phone.bearer))).toBe("400 invalid_request");
      const stale = await put([mine, { ...mine, epoch: 1 }], phone.bearer);
      expect([refusal(stale), stale.body.error?.index]).toEqual(["400 wrap_invalid", 1]);
      expect((await put([mine], phone.bearer)).body).toMatchObject({ list, stored: 1 });
      expect((await put([{ ...mine, wrap: WRAP(8) }, { epoch: 0, member: w.owner.enc, wrap: WRAP(8) }], phone.bearer)).body).toMatchObject({ stored: 0 });
      expect((await w.call("GET", `/v2/lists/${list}/wraps?member=${phone.key.enc}`, undefined, w.token)).body.wraps).toEqual([{ epoch: 0, wrap: WRAP(7) }]);
      // a PC in the list stores them as a device does; a PC the account lists that is not in it has no such route
      const a = await addPc(w, list, phone.head);
      const tablet = await addLinked(w, list, a.head);
      const theirs = [{ epoch: 0, member: tablet.key.enc, wrap: WRAP(9) }];
      expect((await pcCall(w, a.pc, "/v2/pc/list/wraps/put", { list, wraps: theirs })).body).toMatchObject({ list, stored: 1 });
      const outsider = machine();
      await listPc(w, outsider);
      expect(refusal(await pcCall(w, outsider, "/v2/pc/list/wraps/put", { list, wraps: theirs }))).toBe("404 not_found");
    });
  });

  describe("the one-request birth and the later hand-over (Part F, F10b)", () => {
    test("a birth places entry 0, its carried keys and PCs, the hand-over and its epoch in one request, with the hand-over's link", async () => {
      const w = await world();
      const first = await newKey();
      const firstTok = signedIn(w, first);
      expect((await w.call("GET", "/v2/lists/mine", undefined, firstTok)).body).not.toHaveProperty("migrate");
      w.service.listMigrateAccounts = ACCOUNT;
      expect((await w.call("GET", "/v2/lists/mine", undefined, firstTok)).body).toMatchObject({ list: null, migrate: true });
      const phone = await newKey();
      signedIn(w, phone);
      const pc = machine();
      await listPc(w, pc);
      const next = await newKey();
      const born = await birthOf(w, first, next, [carriedKey(phone), carriedPc(pc)]);
      const made = await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries, wraps: [{ epoch: 1, member: next.enc, wrap: WRAP(1) }], link: await linkOf(born.list, next, first) }, firstTok);
      expect([made.status, made.body.list, made.body.head]).toEqual([201, born.list, born.head]);
      const held = w.service.accountList(ACCOUNT)!;
      expect([held.head.seq, held.state.epoch, held.state.carrying, held.links, held.wraps]).toEqual([4, 1, false, [{ key: next.key, device: first.key }], [{ epoch: 1, member: next.enc, wrap: WRAP(1) }]]);
      expect([rowOf(held.state.devices, phone.key)?.carried, rowOf(held.state.pcs, pc.endpoint)?.how]).toEqual([true, "carried"]);
      // sent again, its answer lost: list_exists with its own id, which the device takes as placed, before its run is read
      const again = await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries.slice(0, 2) }, firstTok);
      expect([refusal(again), again.body.error?.list]).toEqual(["409 list_exists", born.list]);
      expect((await w.call("GET", "/v2/lists/mine", undefined, firstTok)).body).not.toHaveProperty("migrate");
    });

    test("off the migrate switch a birth carries nobody in (carried_not_open); with a key proof, or fewer than 2 or more than 66 texts, it is out of form", async () => {
      const w = await world();
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const born = await birthOf(w, first, await newKey(), []);
      const send = (body: Record<string, unknown>) => w.call("POST", "/v2/lists", { entry: born.entry, ...body }, firstTok);
      const off = await send({ entries: born.entries });
      expect([refusal(off), off.body.error?.index, off.body.error?.reason]).toEqual(["400 entry_refused", 1, "carried_not_open"]);
      w.service.listMigrateAccounts = "*";
      expect(refusal(await send({ entries: born.entries.slice(0, 1) }))).toBe("400 invalid_request");
      expect(refusal(await send({ entries: Array<string>(67).fill(born.entries[0]!) }))).toBe("400 invalid_request");
      expect(refusal(await send({ entries: born.entries, key_proof: { challenge_id: "0".repeat(32), signature: "A".repeat(86) } }))).toBe("400 invalid_request");
      expect(w.service.accountList(ACCOUNT)).toBeNull();
    });

    test("a birth holds whole or not at all: first_signer, birth_shape and not_carried name their index, a wrap for epoch 0 is wrap_invalid, a link for another key link_invalid", async () => {
      const w = await world();
      w.service.listMigrateAccounts = ACCOUNT;
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const next = await newKey();
      const send = (born: { entry: string; entries: readonly string[] }, more: Record<string, unknown> = {}) => w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries, ...more }, firstTok);
      const at = (called: Called) => [refusal(called), called.body.error?.index, called.body.error?.reason ?? null];
      expect(at(await send(await birthOf(w, await newKey(), next, [])))).toEqual(["400 entry_refused", 0, "first_signer"]);
      // entry 0's signer is held to what a carried key is: a sign-in Step 2 keeps waiting starts no birth
      const waiting = await newKey();
      const waitingTok = signedIn(w, waiting, false);
      const byWaiting = await birthOf(w, waiting, next, []);
      expect(at(await w.call("POST", "/v2/lists", { entry: byWaiting.entry, entries: byWaiting.entries }, waitingTok))).toEqual(["403 not_carried", 0, null]);
      // read in order: anything after the epoch, an epoch with no hand-over before it, a run that stops before its hand-over
      const zero = await sign(first, { seq: 0, list: "", prev: "" }, genesisOf(first), w.seconds());
      const list = zero.head.hash;
      const after = await chain(list, zero.head, [[first, await deviceOf(next, list, true)], [next, epochOf(0)], [next, removeOf(first)]], w.seconds());
      expect(at(await send({ entry: zero.text, entries: after.texts }))).toEqual(["400 entry_refused", 3, "birth_shape"]);
      const phone = await newKey();
      signedIn(w, phone);
      const early = await chain(list, zero.head, [[first, carriedKey(phone)], [first, epochOf(0)]], w.seconds());
      expect(at(await send({ entry: zero.text, entries: early.texts }))).toEqual(["400 entry_refused", 2, "birth_shape"]);
      const tablet = await newKey();
      signedIn(w, tablet);
      const short = await chain(list, zero.head, [[first, carriedKey(phone)], [first, carriedKey(tablet)]], w.seconds());
      expect(at(await send({ entry: zero.text, entries: short.texts }))).toEqual(["400 entry_refused", 3, "birth_shape"]);
      // a key Step 2 does not let in today, a device code's sign-in's key, a PC the account does not list
      const late = await newKey();
      signedIn(w, late, false);
      const typed = await newKey();
      w.service.registerSessionKey(w.service.issueToken(ACCOUNT, { device: true }), typed.key, "typed");
      expect(at(await send(await birthOf(w, first, next, [carriedKey(phone), carriedKey(late)])))).toEqual(["403 not_carried", 2, null]);
      // the service's word on the carried keys comes after the whole run is judged: a run cut short is birth_shape first
      const cut = await chain(list, zero.head, [[first, carriedKey(late)], [first, carriedKey(phone)]], w.seconds());
      expect(at(await send({ entry: zero.text, entries: cut.texts }))).toEqual(["400 entry_refused", 3, "birth_shape"]);
      expect(at(await send(await birthOf(w, first, next, [carriedKey(typed)])))).toEqual(["403 not_carried", 1, null]);
      expect(at(await send(await birthOf(w, first, next, [carriedPc(machine())])))).toEqual(["403 not_carried", 1, null]);
      const typedPc = machine();
      await listPc(w, typedPc, w.service.issueToken(ACCOUNT, { device: true }));
      expect(at(await send(await birthOf(w, first, next, [carriedPc(typedPc)])))).toEqual(["403 not_carried", 1, null]);
      const born = await birthOf(w, first, next, [carriedKey(phone)]);
      expect(at(await send(born, { wraps: [{ epoch: 0, member: next.enc, wrap: WRAP(1) }] }))).toEqual(["400 wrap_invalid", 0, null]);
      expect(at(await send(born, { link: await linkOf(born.list, next, phone) }))).toEqual(["400 link_invalid", undefined, null]);
      expect(w.service.accountList(ACCOUNT)).toBeNull();
    });

    test("a later hand-over: one device entry ending the key its sign-in registered needs no claim, is outside the budget and takes its link; a carried key's removal signs its sign-in out", async () => {
      const w = await world();
      w.service.listMigrateAccounts = ACCOUNT;
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const phone = await newKey();
      const phoneTok = signedIn(w, phone);
      const tablet = await newKey();
      const tabletTok = signedIn(w, tablet);
      const next = await newKey();
      const born = await birthOf(w, first, next, [carriedKey(phone), carriedKey(tablet)]);
      expect((await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, firstTok)).status).toBe(201);
      const list = born.list;
      // a carried sign-in is in the list by its own key: it stores wraps without a link
      expect((await w.call("PUT", `/v2/lists/${list}/wraps`, { wraps: [{ epoch: 1, member: next.enc, wrap: WRAP(3) }] }, phoneTok)).body).toMatchObject({ stored: 1 });
      w.service.listLimits.additionsPerWindow = 0;
      const phone2 = await newKey();
      // names under epoch 1, the one the birth opened
      const handOver = await chain(list, born.head, [[phone, { ...await deviceOf(phone2, list, true), sealed: sealed(1) } as ListKind]], w.seconds());
      const link = await linkOf(list, phone2, phone);
      // a link goes with a hand-over alone, refused after the second lock; the same entry sent by another sign-in is a device
      // entry that asks a claim
      const other = await newKey();
      const plain = await chain(list, born.head, [[next, { ...await deviceOf(other, list), sealed: sealed(1) } as ListKind]], w.seconds());
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: plain.texts, link }, firstTok))).toBe("403 not_claimed");
      expect((await w.claim(list, other, firstTok)).status).toBe(200);
      expect(refusal(await w.call("POST", `/v2/lists/${list}/entries`, { entries: plain.texts, link }, firstTok))).toBe("400 invalid_request");
      expect(refusal(await w.place(list, handOver.texts, undefined, firstTok))).toBe("403 not_claimed");
      expect((await w.call("POST", `/v2/lists/${list}/entries`, { entries: handOver.texts, link }, phoneTok)).body).toMatchObject({ head: handOver.head, placed: 1 });
      expect(w.service.accountList(ACCOUNT)?.links).toContainEqual({ key: phone2.key, device: phone.key });
      // the tablet never handed over: its registered key is its member key, and its removal ends that sign-in
      const out = await chain(list, handOver.head, [[next, removeOf(tablet)]], w.seconds());
      expect((await w.place(list, out.texts, undefined, firstTok)).status).toBe(200);
      expect(refusal(await w.call("GET", "/v2/lists/mine", undefined, tabletTok))).toBe("401 unauthorized");
      expect((await w.call("GET", "/v2/lists/mine", undefined, phoneTok)).status).toBe(200);
    });
  });

  describe("a registered key that is its own link", () => {
    test("a lone rotating device takes no claim only for a key carried in: on any other list it needs its claim", async () => {
      const w = await world();
      const { list, head } = await w.start();
      const phone = await newKey();
      const phoneTok = signedIn(w, phone);
      expect((await w.claim(list, phone, phoneTok)).status).toBe(200);
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      expect((await w.place(list, added.texts)).status).toBe(200);
      const next = await newKey();
      const rotated = await chain(list, added.head, [[phone, { ...await deviceOf(next, list, true), sealed: null } as ListKind]], w.seconds());
      expect(refusal(await w.place(list, rotated.texts, undefined, phoneTok))).toBe("403 not_claimed");
      expect((await w.claim(list, next, phoneTok)).status).toBe(200);
      expect((await w.place(list, rotated.texts, undefined, phoneTok)).status).toBe(200);
    });

    test("a carried key in the list is its sign-in's link: another link of that key is link_taken, a claim's is not written, and its removal signs it out", async () => {
      const w = await world();
      w.service.listMigrateAccounts = ACCOUNT;
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const phone = await newKey();
      const phoneTok = signedIn(w, phone);
      const next = await newKey();
      const born = await birthOf(w, first, next, [carriedKey(phone)]);
      expect((await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, firstTok)).status).toBe(201);
      const list = born.list;
      const second = await newKey();
      expect((await w.claim(list, second, phoneTok, { link: await linkOf(list, second, phone) })).status).toBe(200);
      const added = await chain(list, born.head, [[phone, { ...await deviceOf(second, list), sealed: null } as ListKind]], w.seconds());
      expect((await w.place(list, added.texts, undefined, phoneTok)).status).toBe(200);
      expect(w.service.accountList(ACCOUNT)?.links.map(({ key }) => key)).not.toContain(second.key);
      expect(refusal(await w.call("POST", `/v2/lists/${list}/links`, { key: second.key, link: await linkOf(list, second, phone) }, phoneTok))).toBe("409 link_taken");
      const out = await chain(list, added.head, [[next, removeOf(phone)]], w.seconds());
      expect((await w.place(list, out.texts, undefined, firstTok)).status).toBe(200);
      expect(refusal(await w.call("GET", "/v2/lists/mine", undefined, phoneTok))).toBe("401 unauthorized");
    });

    test("a carried key that the table links to another sign-in's key stands for that one, not for its own; its removal signs both out", async () => {
      const w = await world();
      w.service.listMigrateAccounts = ACCOUNT;
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const phone = await newKey();
      const phoneTok = signedIn(w, phone);
      const next = await newKey();
      const born = await birthOf(w, first, next, [carriedKey(phone)]);
      expect((await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, firstTok)).status).toBe(201);
      // the phone's holder signs in again elsewhere and links the carried key to that sign-in's key
      const elsewhere = await newKey();
      const elsewhereTok = signedIn(w, elsewhere);
      expect((await w.call("POST", `/v2/lists/${born.list}/links`, { key: phone.key, link: await linkOf(born.list, phone, elsewhere) }, elsewhereTok)).status).toBe(200);
      // the phone's own sign-in stores no wraps for it now; the key's removal retires the linked sign-in, and the registered
      // key that is the key itself, as the service does
      expect(refusal(await w.call("PUT", `/v2/lists/${born.list}/wraps`, { wraps: [{ epoch: 1, member: next.enc, wrap: WRAP(3) }] }, phoneTok))).toBe("403 not_linked");
      const out = await chain(born.list, born.head, [[next, removeOf(phone)]], w.seconds());
      expect((await w.place(born.list, out.texts, undefined, firstTok)).status).toBe(200);
      expect([refusal(await w.call("GET", "/v2/lists/mine", undefined, elsewhereTok)), refusal(await w.call("GET", "/v2/lists/mine", undefined, phoneTok))]).toEqual(["401 unauthorized", "401 unauthorized"]);
    });

    test("a carried key stands up the snapshot's chain for a device it let in, as a link would", async () => {
      const w = await world();
      w.service.opensAll = true;
      w.service.listMigrateAccounts = ACCOUNT;
      const pc = machine();
      await listPc(w, pc);
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const phone = await newKey();
      signedIn(w, phone);
      const next = await newKey();
      const born = await birthOf(w, first, next, [carriedKey(phone)]);
      expect((await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, firstTok)).status).toBe(201);
      // the carried phone lets a new device in; that device's sign-in passes no Step 2 rule of its own
      const tablet = await newKey();
      const tabletReg = await newKey();
      const tabletTok = signedIn(w, tabletReg, false);
      expect((await w.claim(born.list, tablet, tabletTok, { link: await linkOf(born.list, tablet, tabletReg) })).status).toBe(200);
      const added = await chain(born.list, born.head, [[phone, { ...await deviceOf(tablet, born.list), sealed: sealed(1) } as ListKind]], w.seconds());
      expect((await w.place(born.list, added.texts)).status).toBe(200);
      expect((await snapshotOf(w, pc)).eligible[tabletReg.key]).toBe(true);
      // once the phone's own sign-in no longer passes Step 2, nobody up the chain does
      w.service.removeDevice(ACCOUNT, phone.key);
      expect((await snapshotOf(w, pc)).eligible[tabletReg.key]).toBe(false);
    });
  });

  describe("a list account's PC completes its listing", () => {
    test("on its own mailbox pull, as the service accepts any confirmed listing a PC pulled since: a list hands out no admission to take", async () => {
      const w = await world();
      w.service.opensAll = true;
      await w.start();
      const complete = async (pc: Machine, listing: string) => {
        const scope = { account: ACCOUNT, listing_id: listing };
        const challenge = await (await w.service.fetch(new Request(`${BASE}/v1/pc/challenge`, { method: "POST", body: JSON.stringify({ server_id: pc.serverId, public_key: pc.endpoint, completion: scope }) }))).json() as { challenge_id: string; frame: string };
        const answer = answerServerChallenge(challenge.frame, pc.keys.secretKey, { server_id: pc.serverId, role: "account", connection_id: `pc-complete/1:${ACCOUNT}:${listing}:${challenge.challenge_id}` });
        return await w.call("POST", "/v1/pc/complete", { server_id: pc.serverId, ...scope, challenge_id: challenge.challenge_id, proof: answer });
      };
      const pullListing = async (pc: Machine) => (await (await w.service.fetch(new Request(`${BASE}/v1/pc/mailbox`, { method: "POST",
        body: JSON.stringify({ ...(await proof(w, pc)), ack: null, account: ACCOUNT, with_listing_id: true }) }))).json() as { listing_id: string | null }).listing_id;
      const listingOf = (pc: Machine) => w.service.pcs(ACCOUNT).find((row) => row.server_id === pc.serverId)!.listing_id!;
      const pc = machine();
      await listPc(w, pc);
      // before its first pull, with no admission to take, nothing is the listing's evidence
      expect(refusal(await complete(pc, listingOf(pc)))).toBe("409 listing_changed");
      expect(refusal(await pcCall(w, pc, "/v1/pc/admission", { account: ACCOUNT }))).toBe("404 no_admission");
      expect(await pullListing(pc)).toBe(listingOf(pc));
      expect((await complete(pc, listingOf(pc))).status).toBe(200);
      // a listing a device code made that nobody confirmed completes on no pull
      const typed = machine();
      await listPc(w, typed, w.service.issueToken(ACCOUNT, { device: true }));
      expect(await pullListing(typed)).toBeNull();
      expect(refusal(await complete(typed, listingOf(typed)))).toBe("409 listing_changed");
    });
  });

  describe("the plain invite's line proof on a PC's post", () => {
    /** A list that holds a plain invite of `line`, and a PC the account lists, with the keys it posts. */
    async function withPlainInvite() {
      const w = await world();
      const { list, head } = await w.start();
      const line = await newKey();
      const invited = await chain(list, head, [[w.owner, inviteOf(line, w.seconds() + 600, false, 1, null)]], w.seconds());
      expect((await w.place(list, invited.texts)).status).toBe(200);
      const pc = machine();
      await listPc(w, pc);
      const key = await newKey();
      const post = async (more: Record<string, unknown> = {}) => pcCall(w, pc, "/v2/pc/list/keys", { list, key: key.key, enc: key.enc, card: await cardOf(key, list, pc.endpoint), ...more });
      const posts = async () => ((await w.call("GET", `/v2/lists/${list}/posts`, undefined, w.token)).body.posts ?? []) as unknown as Record<string, unknown>[];
      return { w, list, head: invited.head, line, pc, key, post, posts };
    }

    test("a PC posts its keys with the plain invite's key and the line's proof: carried on the post and shown to the account's devices; a post without them clears them", async () => {
      const { list, line, pc, key, post, posts } = await withPlainInvite();
      const proof = await lineProof(list, pc, key, line);
      const posted = await post({ invite: line.key, invite_proof: proof });
      expect([posted.status, posted.body.key]).toEqual([200, key.key]);
      expect(await posts()).toEqual([expect.objectContaining({ endpoint: pc.endpoint, key: key.key, invite: line.key, invite_proof: proof })]);
      expect((await post()).status).toBe(200);
      const plain = await posts();
      expect([plain.length, Object.hasOwn(plain[0] ?? {}, "invite"), Object.hasOwn(plain[0] ?? {}, "invite_proof")]).toEqual([1, false, false]);
    });

    test("the invite and its proof go together, in their forms; an invite the list does not hold open is invite_not_in_list; a proof not the line's is invite_proof_invalid; nothing is posted", async () => {
      const { w, list, head, line, pc, key, post, posts } = await withPlainInvite();
      const proof = await lineProof(list, pc, key, line);
      for (const over of [{ invite: line.key }, { invite_proof: proof }, { invite: "not a key", invite_proof: proof }, { invite: line.key, invite_proof: 7 }]) {
        expect([Object.keys(over), refusal(await post(over))]).toEqual([Object.keys(over), "400 invalid_request"]);
      }
      const stranger = await newKey();
      expect(refusal(await post({ invite: stranger.key, invite_proof: await lineProof(list, pc, key, stranger) }))).toBe("409 invite_not_in_list");
      const other = await newKey();
      const proofs = {
        "another key's": await lineProof(list, pc, key, other),
        "another PC's": await lineProof(list, machine(), key, line),
        "another account's": await lineProof(list, pc, key, line, "acct_2"),
        "another card's": await lineProof(list, pc, other, line),
        // a lying service hands the line the challenge of a card of its own as a redeem challenge: that signature is no proof
        "a redeem signature over another card's line challenge": await redeemOverLineChallenge(list, pc, other, line),
        "a redeem signature over this card's line challenge": await redeemOverLineChallenge(list, pc, key, line),
        "86 characters of junk": "A".repeat(86),
      };
      for (const [why, bad] of Object.entries(proofs)) expect([why, refusal(await post({ invite: line.key, invite_proof: bad }))]).toEqual([why, "400 invite_proof_invalid"]);
      expect(await posts()).toEqual([]);
      // the invite put out of the list by a member
      const out = await chain(list, head, [[w.owner, removeOf(line)]], w.seconds());
      expect((await w.place(list, out.texts)).status).toBe(200);
      expect(refusal(await post({ invite: line.key, invite_proof: proof }))).toBe("409 invite_not_in_list");
      expect(await posts()).toEqual([]);
    });
  });

  describe("tamper mode: the migration's lies", () => {
    test("forgeBirth: the service answers a birth of its own, by a key of its own carrying the account's registered keys, as the account's list", async () => {
      const w = await world();
      const phone = await newKey();
      signedIn(w, phone);
      const pc = machine();
      await listPc(w, pc);
      const forged = await w.service.forgeBirth(ACCOUNT, { endpoints: [pc.endpoint] });
      expect((await w.call("GET", "/v2/lists/mine", undefined, w.token)).body.list).toBe(forged);
      const served = await w.log(forged);
      const replayed = await replayList(served.body.entries!, 1, { saved: null });
      const state = replayed.member!.state;
      expect([replayed.stopped, state.epoch, state.carrying, rowOf(state.devices, phone.key)?.carried, rowOf(state.pcs, pc.endpoint)?.how]).toEqual([null, 1, false, true, "carried"]);
      const signer = readBody(entryFromText(served.body.entries![0]!).body).signer;
      expect([signer === phone.key, signer === w.owner.key]).toEqual([false, false]);
    });

    test("a part of a birth: withholdAfter serves entry 0 and the carried entries, or everything but the epoch", async () => {
      const w = await world();
      w.service.listMigrateAccounts = ACCOUNT;
      const first = await newKey();
      const firstTok = signedIn(w, first);
      const phone = await newKey();
      signedIn(w, phone);
      const born = await birthOf(w, first, await newKey(), [carriedKey(phone)]);
      expect((await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, firstTok)).status).toBe(201);
      for (const [after, epoch] of [[1, 0], [2, 0]] as const) {
        w.service.untamperList(born.list);
        w.service.tamperList(born.list, { withholdAfter: after });
        const served = await w.log(born.list);
        const replayed = await replayList(served.body.entries!, 1, { saved: null });
        expect([served.body.entries!.length, served.body.head?.seq, replayed.member?.state.epoch]).toEqual([after + 1, after, epoch]);
      }
    });

    test("withholdAnswer: a genesis, a birth and a placement are stored and their answers never come; sent again they answer list_exists or placed 0", async () => {
      const w = await world();
      const { list, head } = await w.start();
      w.service.tamperAccount(ACCOUNT, { withholdAnswer: true });
      const phone = await newKey();
      expect((await w.claim(list, phone)).status).toBe(200);
      const added = await chain(list, head, [[w.owner, await deviceOf(phone, list)]], w.seconds());
      await expect(w.place(list, added.texts)).rejects.toThrow("withheld");
      expect(w.service.accountList(ACCOUNT)?.head).toEqual(added.head);
      // a genesis, and a birth, of another account told the same lie
      w.service.listMigrateAccounts = "*";
      const other = await newKey();
      const otherTok = w.service.issueToken("acct_2");
      w.service.registerSessionKey(otherTok, other.key, "first");
      w.service.tamperAccount("acct_2", { withholdAnswer: true });
      const born = await birthOf(w, other, await newKey(), [], "acct_2");
      await expect(w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, otherTok)).rejects.toThrow("withheld");
      expect(w.service.accountList("acct_2")?.head).toEqual(born.head);
      w.service.untamperAccount(ACCOUNT);
      w.service.untamperAccount("acct_2");
      expect((await w.place(list, added.texts)).body.placed).toBe(0);
      expect(refusal(await w.call("POST", "/v2/lists", { entry: born.entry, entries: born.entries }, otherTok))).toBe("409 list_exists");
    });

    test("eligibleAgain: a removed key is listed eligible in the snapshot again, until the lie ends", async () => {
      const w = await world();
      w.service.opensAll = true;
      const pc = machine();
      await listPc(w, pc);
      const phone = await newKey();
      signedIn(w, phone);
      w.service.removeDevice(ACCOUNT, phone.key);
      expect((await snapshotOf(w, pc)).removed).toEqual([phone.key]);
      w.service.tamperAccount(ACCOUNT, { eligibleAgain: [phone.key] });
      const lied = await snapshotOf(w, pc);
      expect([lied.eligible[phone.key], lied.removed]).toEqual([true, []]);
      w.service.untamperAccount(ACCOUNT);
      expect((await snapshotOf(w, pc)).removed).toEqual([phone.key]);
    });
  });
});
