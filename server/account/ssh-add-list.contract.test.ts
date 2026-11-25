/**
 * Adding a PC over SSH to an account that keeps a signed list (docs/account.md, "Adding a PC over SSH to an account that
 * keeps a list"). The take that another PC of the owner sends on this PC's owner socket, over the owner's own SSH
 * session, is the act at this PC that names the list and the key whose entry adds it: no number is compared. This PC
 * answers its card for that list until the list holds its entry signed by that key, then joins its account by the
 * list, pinned from its first moment. Nothing the account service says names a list here.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startBunRelay, type BunRelay } from "../../relay/bun.ts";
import { cardHolds, signCard } from "../../shared/account-list.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { ListKeyStore } from "./list-keys.ts";
import { listMember, TestList } from "./list.test-helpers.ts";
import { pairingPc, setUpFor, type Pc } from "./pairing.test-helpers.ts";
import { askRecovery } from "./recovery.ts";
import { link } from "../../scripts/plugin-link.ts";

const ACCOUNT = "acct_1";

const pcs: Pc[] = [];
const relays: BunRelay[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
  for (const relay of relays.splice(0)) await relay.stop();
});

/** A relay on this machine that a PC's relay comes online on: its port. */
function localRelay(): number {
  const relay = startBunRelay({ port: 0 });
  relays.push(relay);
  return relay.port;
}

/**
 * A PC installed over SSH: in no account, its relay never turned on, on an account service that keeps lists, and read
 * once by the adding PC's inspect (which makes its missing relay identity).
 */
async function addedPc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc({ relayPort: localRelay(), startRelay: false, ...options, server: { accountOpensAll: true, ...options.server } });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  pcs.push(made);
  await askRecovery(made.stateDir, { act: "account_add_inspect" });
  return made;
}

/** What the owner's signed-in window does before the take: lists that PC with its own sign-in, then admits it. */
async function listAndAdmit(pc: Pc, account = ACCOUNT): Promise<void> {
  const identity = pc.app.context.services.relay.currentIdentity()!;
  const token = pc.account.issueToken(account, { twoStep: true });
  const call = (path: string, method: string, body: unknown) =>
    pc.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`Not listed: ${listed.status} ${await listed.text()}`);
  const admitted = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  if (!admitted.ok) throw new Error(`Not admitted: ${admitted.status} ${await admitted.text()}`);
}

const endpointOf = (pc: Pc): string => bytesToHex(importPublicKey(pc.app.context.services.relay.currentIdentity()!.public_key));
const serverIdOf = (pc: Pc): string => pc.app.context.services.relay.currentIdentity()!.server_id;
const relayPhase = (pc: Pc) => pc.app.context.services.relay.status().phase;

/** The take that names the list and the adder, as the adding PC sends it over the SSH channel. */
const takeByList = (pc: Pc, list: string, adder: string, account = ACCOUNT) =>
  askRecovery(pc.stateDir, { act: "account_add_take", account, server_id: serverIdOf(pc), list, adder }) as Promise<Record<string, unknown>>;

/** The posts the account service holds for the list, as a member reads them. */
async function posts(pc: Pc, list: TestList): Promise<{ endpoint: string; key: string; enc: string; card: string }[]> {
  const answer = await pc.account.fetch(new Request(`https://account.test/v2/lists/${list.id}/posts`, { headers: { authorization: `Bearer ${pc.account.issueToken(ACCOUNT, { twoStep: true })}` } }));
  return (await answer.json() as { posts: { endpoint: string; key: string; enc: string; card: string }[] }).posts;
}

test.skipIf(process.platform === "win32")("a take that names the list and its adder answers this PC's card for that list, posts its keys there, and binds nothing", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  // read before any matcher looks at it: a matcher must not stand in for what the PC said
  const { state, key, enc, card } = await takeByList(b, list.id, list.first.key) as { state: unknown; key: string; enc: string; card: string };
  expect([state, typeof key, typeof enc, typeof card]).toEqual(["waiting", "string", "string", "string"]);
  // the card is this PC's own, for that very list and its own relay key
  expect(await cardHolds({ key, enc, list: list.id, endpoint: endpointOf(b), invite: null }, card)).toBe(true);
  // its keys at the account service with its own proof: the second lock of the entry that adds it
  // (a card is signed anew each time: the post's and the answer's are both that key's own)
  const posted = await posts(b, list);
  expect(posted.map((post) => [post.endpoint, post.key, post.enc])).toEqual([[endpointOf(b), key, enc]]);
  expect(await cardHolds({ key, enc, list: list.id, endpoint: endpointOf(b), invite: null }, posted[0]!.card)).toBe(true);
  expect(b.devices.account()).toBeNull();
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false, account: null });
  expect(relayPhase(b)).toBe("off");
});

test.skipIf(process.platform === "win32")("once the list holds its entry signed by that adder, the same take joins the account by the list, pinned from the start, and turns its relay on", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ state: "waiting" });
  await list.addPostedPc(endpointOf(b));
  // it joined the list by this very take, and says so
  expect(await takeByList(b, list.id, list.first.key)).toEqual({ account: ACCOUNT, relay: { phase: "online", blocked: null }, list_joined: true });
  expect(b.devices.account()).toBe(ACCOUNT);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, pinned_list: list.id, standing: "in" });
  expect(relayPhase(b)).toBe("online");
  // asked again (an answer that was lost): it is in, by that list, and it did not join it by this take
  expect(await takeByList(b, list.id, list.first.key)).toEqual({ account: ACCOUNT, relay: { phase: "online", blocked: null } });
});

test.skipIf(process.platform === "win32")("an entry signed by another member than the adder the take named is not taken: nothing is bound and the relay stays off", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  const other = await listMember();
  await list.addDevice(other);
  await listAndAdmit(b);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ state: "waiting" });
  await list.addPostedPc(endpointOf(b), other);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ code: "other_adder" });
  expect(b.devices.account()).toBeNull();
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false });
  expect(relayPhase(b)).toBe("off");
});

test.skipIf(process.platform === "win32")("a take that names no list, for an account that keeps one, is refused list_add as before, and turns nothing on", async () => {
  const b = await addedPc();
  await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  expect(await askRecovery(b.stateDir, { act: "account_add_take", account: ACCOUNT, server_id: serverIdOf(b) })).toMatchObject({ code: "list_add" });
  expect(b.devices.account()).toBeNull();
  expect(relayPhase(b)).toBe("off");
});

test.skipIf(process.platform === "win32")("a list without its adder, an adder without its list, or either in another form names nothing", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  const server_id = serverIdOf(b);
  for (const request of [
    { act: "account_add_take", account: ACCOUNT, server_id, list: list.id },
    { act: "account_add_take", account: ACCOUNT, server_id, adder: list.first.key },
    { act: "account_add_take", account: ACCOUNT, server_id, list: list.id.toUpperCase(), adder: list.first.key },
    { act: "account_add_take", account: ACCOUNT, server_id, list: list.id, adder: "not a key" },
  ]) expect(await askRecovery(b.stateDir, request)).toEqual({ error: "Invalid recovery action" });
  expect(await posts(b, list)).toEqual([]);
  expect(b.devices.account()).toBeNull();
});

test.skipIf(process.platform === "win32")("a PC in another account names no list for a take, and posts nothing", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await setUpFor(b, "acct_other");
  await listAndAdmit(b, "acct_other");
  expect((await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: "acct_other" } })).status).toBe(200);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ code: "other_account" });
  expect(b.devices.account()).toBe("acct_other");
  expect(await posts(b, list)).toEqual([]);
});

test.skipIf(process.platform === "win32")("a take for another relay identity than this PC's names nothing", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  expect(await askRecovery(b.stateDir, { act: "account_add_take", account: ACCOUNT, server_id: "0".repeat(32), list: list.id, adder: list.first.key })).toMatchObject({ code: "identity_changed" });
  expect(await posts(b, list)).toEqual([]);
});

/** That PC in the account already on the account service's word, from before the account had its list: one press. */
async function boundBefore(b: Pc): Promise<void> {
  await setUpFor(b, ACCOUNT);
  await listAndAdmit(b);
  const pressed = await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: ACCOUNT } });
  if (pressed.status !== 200) throw new Error(`Not added in one press: ${pressed.status} ${JSON.stringify(pressed.body)}`);
}

test.skipIf(process.platform === "win32")("a PC in the account from before its list follows the list a take names once the list holds its entry signed by that adder", async () => {
  const b = await addedPc();
  await boundBefore(b);
  const list = await TestList.start(b.account, ACCOUNT);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ state: "waiting" });
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false });
  await list.addPostedPc(endpointOf(b));
  // in the account before, and in its list by this take: it says it joined the list now
  expect(await takeByList(b, list.id, list.first.key)).toEqual({ account: ACCOUNT, relay: { phase: "online", blocked: null }, list_joined: true });
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, pinned_list: list.id, standing: "in" });
});

test.skipIf(process.platform === "win32")("a PC in the account from before its list takes no entry of another key than the adder the take named, neither then nor at a later read", async () => {
  const b = await addedPc();
  await boundBefore(b);
  const list = await TestList.start(b.account, ACCOUNT);
  const other = await listMember();
  await list.addDevice(other);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ state: "waiting" });
  await list.addPostedPc(endpointOf(b), other);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ code: "other_adder" });
  // its own reads of the list later pin nothing either: the take named no list it took
  await b.app.context.services.accountMailbox.pull();
  await b.app.context.services.accountList!.settled();
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false, want: null });
  expect(b.devices.account()).toBe(ACCOUNT);
});

test.skipIf(process.platform === "win32")("ovis add --account, as an agent runs it on a PC an add over SSH put in the account's list: one line says it is in that account, and nothing is asked or listed", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  await takeByList(b, list.id, list.first.key);
  await list.addPostedPc(endpointOf(b));
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ account: ACCOUNT });
  const out: string[] = [];
  const code = await link(["--account", ACCOUNT], {
    origin: `http://127.0.0.1:${b.app.port}`, headers: {}, accountService: "https://account.test", serviceFetch: b.account.fetch, signal: new AbortController().signal,
    lines: { next: () => new Promise(() => {}) }, terminal: false, isTty: false, out: (text) => { out.push(text); },
  });
  expect([code, out.join("")]).toEqual([0, `This PC is already in an Ovis account (${ACCOUNT}).\n`]);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, pinned_list: list.id });
});

test.skipIf(process.platform === "win32")("the entry it joins by must carry exactly the keys it posted: one by the adder for its key with another encryption key is not taken", async () => {
  const b = await addedPc();
  const list = await TestList.start(b.account, ACCOUNT);
  await listAndAdmit(b);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ state: "waiting" });
  // whoever holds this PC's signing key (not the PC) signs its card for an encryption key that is not its own
  const own = await new ListKeyStore(b.stateDir).keysFor(serverIdOf(b));
  const other = await listMember();
  const card = await signCard({ key: own.key, enc: other.enc, list: list.id, endpoint: endpointOf(b), invite: null }, own.privateKey);
  await list.placeTexts([await list.sign({ kind: "pc", key: own.key, endpoint: endpointOf(b), enc: other.enc, card, sealed: null })]);
  expect(await takeByList(b, list.id, list.first.key)).toMatchObject({ code: "other_keys" });
  expect(b.devices.account()).toBeNull();
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false });
  expect(relayPhase(b)).toBe("off");
});
