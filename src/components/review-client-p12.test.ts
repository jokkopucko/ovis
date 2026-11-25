/**
 * Independent adversarial review of client P12 (16e75c156, feat/account-list-client-add) and P12b (1cb5f8afa,
 * feat/account-list-client-invites). Written to live in `src/components/` of 1cb5f8afa: copy it there as
 * `src/components/review-client-p12.test.ts` and run `bun test src/components/review-client-p12.test.ts`.
 *
 * Tests named `RED` fail on 1cb5f8afa: each shows one finding of review-client-p12.md. Tests named `PIN` pass on
 * 1cb5f8afa: each holds a guard that was checked and found sound, and most kill a mutant that the step's own tests
 * leave alive (named in the test).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { FakeAccountService, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import { listView, signCard } from "../../shared/account-list.ts";
import { readJoinLine } from "../../shared/account-list-join.ts";
import { accountList, type AccountList } from "../lib/account/accountList.ts";
import { addListPc, askingPc, listWorld, pcComparing, postPcKeys, type AskingPc, type WorldDevice } from "../lib/account/accountList.test-helpers.ts";
import type { PcFetch } from "../lib/account/join.ts";
import type { ListPost } from "../lib/account/listAnswers.ts";
import { addPostedPc, numberWith, postedPcs } from "../lib/account/listAdd.ts";
import { addInvitedPc, invitedPcs } from "../lib/account/listInvited.ts";
import { randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { invitesOf, makeInvite, revokeInvite, type MadeInvite } from "../lib/account/listInvite.ts";
import { nameListToPc } from "../lib/account/listNamed.ts";
import { memoryListLock, memoryListStore, type ListStore } from "../lib/account/listStore.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { AccountService } from "../lib/account/service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../lib/account/signin.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountStore } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AddPcByNumber } from "./AddPcByNumber.tsx";
import { InvitePc } from "./InvitePc.tsx";
import { deviceListKeys } from "../lib/account/listKeys.ts";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../shared/relay-mux.ts";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { createAccountController } from "../lib/relay/accountController.ts";
import type { RelayDevice, ShellDeviceStore } from "../lib/relay/device.ts";
import { RelayTransport } from "../lib/relay/transport.ts";
import { UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";

const ORIGIN = "https://account.ovis.sh";
const ACCOUNT = "acct_owner";
const noWait = { wait: async () => {} };
type World = ReturnType<typeof listWorld>;

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let now = Date.now();
let fake: FakeAccountService;
let store: AccountStore;
let service: AccountService;

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const pressWhere = async (find: (node: ReactTestInstance) => boolean): Promise<void> => {
  const found = renderer!.root.findAll((node) => node.type === "button" && find(node));
  if (found.length !== 1) throw new Error(`${found.length} buttons match`);
  await act(async () => { await found[0]!.props.onClick(); });
  await settle();
};
const press = (label: string): Promise<void> => pressWhere((node) => textOf(node).trim() === label);
const text = (): string => renderer === undefined ? "" : renderer.root.findAll((node) => node.type === "div").map(textOf).join(" ");
const cardsFor = (serverId: string): number => renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === serverId).length;
const focus = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event("focus")); }); await settle(); };
const admitsOf = (pc: AskingPc): number => fake.requests.filter((line) => line === `POST /v1/pcs/${pc.server_id}/admit`).length;

async function signIn(): Promise<void> {
  fake.signInAs("github", ACCOUNT);
  const start = await beginSignIn("github", { store, service: ORIGIN, redirectUri: WEB_REDIRECT, now: () => now });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  await finishSignIn(returned, { store, fetch: fake.fetch, now: () => now });
}
async function registerKey(): Promise<void> {
  const session = (await store.get("session"))!;
  const made = await newKey();
  const no = fake.registerSessionKey(session.access_token, made.public_spki, "Phone");
  await store.set("signin_key", { account: ACCOUNT, sign_in_id: session.sign_in_id!, key: made, no });
}
async function mountCard(): Promise<void> {
  if (renderer !== undefined) await act(async () => { renderer!.unmount(); });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(UnconfirmedPcNotices, { service, now: () => now }) })); });
  await settle();
}
const pageList = (listStore: ListStore, svc: AccountService = service): AccountList => accountList({
  service: svc, accountStore: store, listStore, lock: memoryListLock(), now: () => now, genesis: () => "always", durable: async () => true, names: () => ({ label: "Phone", os: "ios" }),
});

beforeEach(async () => {
  const events = new EventTarget();
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } });
  for (const [name, value] of Object.entries({
    window: Object.assign(events, { location: new URL("https://app.ovis.sh/"), history: { state: null, pushState() {}, replaceState() {}, back() {} }, localStorage: storage(local), sessionStorage: storage(session), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"], clipboard: { writeText: async () => {} } },
    localStorage: storage(local),
    sessionStorage: storage(session),
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  now = Date.now();
  fake = new FakeAccountService(() => now);
  fake.opensAll = true;
  fake.listAccounts = "*";
  fake.signInAs("github", ACCOUNT);
  store = memoryAccountStore();
  service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  setPageAccountList(null);
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
});

/**
 * This device is in its account's list (it started it), and a PC listed itself with a device code and posted its
 * keys and card for that list; the PC answers a number as soon as the account service holds the commitment.
 * `carried`: what the account service carries with that PC's post (an invite's key and the line's proof).
 */
async function listAccount(lies: { entries?: () => Response | null; /** the PC lists itself and posts only when the test says (`postNow`) */ deferPost?: true; /** an own sign-in listed the PC: the account has it already (Settings' Add) */ ownListed?: true } = {}) {
  await signIn();
  await registerKey();
  const pc = await askingPc();
  let play: ReturnType<typeof pcComparing> | undefined;
  const carried: { value: Record<string, string> | null } = { value: null };
  service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.endsWith("/entries")) { const said = lies.entries?.(); if (said) return said; }
    const answer = await fake.fetch(request.clone());
    if (request.method === "POST" && path.endsWith("/attempt")) await play?.answer();
    if (carried.value !== null && request.method === "GET" && path.endsWith("/posts") && answer.ok) {
      const body = await answer.json() as { posts: Record<string, unknown>[] };
      return Response.json({ ...body, posts: body.posts.map((post) => post.endpoint === pc.endpoint ? { ...post, ...carried.value } : post) });
    }
    return answer;
  } });
  const list = pageList(memoryListStore());
  await list.sync();
  setPageAccountList(list);
  const held = () => fake.accountList(ACCOUNT)!;
  const postNow = async (): Promise<void> => { await postPcKeys(fake.fetch, ORIGIN, lies.ownListed ? fake.issueToken(ACCOUNT) : fake.issueToken(ACCOUNT, { device: true }), pc, held().id); };
  if (lies.deferPost !== true) await postNow();
  play = pcComparing({ fake, origin: ORIGIN } as unknown as World, pc, held().id);
  return { pc, list, held, carried, postNow };
}

/** A device in its list that made a plain invite, and a PC that holds the line. */
async function invited() {
  const w = listWorld();
  const first = await w.device({ label: "Dana's Mac" });
  await first.list.sync();
  const made = await makeInvite(first.list, { auto: false, ...noWait });
  if (!made.made) throw new Error(`no invite was made: ${made.why}`);
  return { w, first, invite: made.invite, pc: await askingPc() };
}

/** The PC's post as it reaches the device, with the line's proof for `signedFor`'s card (the PC's own by default). */
async function posted(w: World, first: WorldDevice, invite: MadeInvite, pc: AskingPc, signedFor: AskingPc = pc): Promise<ListPost> {
  const list = first.list.writer()!.list;
  const card = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, pc.signs);
  const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
  const proof = await line.signLineProof({ server_id: signedFor.server_id, card: { key: signedFor.key, enc: signedFor.enc, endpoint: signedFor.endpoint } });
  return { endpoint: pc.endpoint, server_id: pc.server_id, key: pc.key, enc: pc.enc, card, attempt: null, invite: invite.key, invite_proof: proof };
}

/** The PC used the invite at the account service: it is listed and posted its keys. */
async function listedAndPosted(w: World, first: WorldDevice, pc: AskingPc): Promise<void> {
  const token = w.fake.issueToken(w.account, { device: true });
  await w.fake.fetch(`${w.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }) });
  await postPcKeys(w.fake.fetch, w.origin, token, pc, first.list.writer()!.list);
}

// ---------------------------------------------------------------------------------------------------------------
// Findings: each test fails on 1cb5f8afa
// ---------------------------------------------------------------------------------------------------------------

describe("RED findings", () => {
  it("RED P12-F1: a device that holds its account's list, on a page whose list has not read it yet (a reload), admits no PC by the directory alone and does not say a PC was added", async () => {
    await signIn();
    await registerKey();
    const lists = memoryListStore();
    const first = pageList(lists);
    await first.sync();
    const pc = await askingPc();
    await postPcKeys(fake.fetch, ORIGIN, fake.issueToken(ACCOUNT, { device: true }), pc, fake.accountList(ACCOUNT)!.id);
    // the page reloads: its list holds the saved copy (follows() is true) and its first round has not ended
    const reloaded = pageList(lists);
    expect(await reloaded.follows(ACCOUNT)).toBe(true);
    setPageAccountList(reloaded);
    await mountCard();
    await press("Add");
    // on 1cb5f8afa: one admission of the directory alone, the card turns into "New PC added to your account", and the
    // list holds no entry for the PC
    expect([admitsOf(pc), fake.accountList(ACCOUNT)!.entries.length]).toEqual([0, 1]);
    expect(text()).not.toContain("New PC added to your account");
  });

  it("RED P12-F1b: a device of a list account that waits to be let into the list (`not_in`) admits no PC by the directory alone and does not say a PC was added", async () => {
    await signIn();
    await registerKey();
    await pageList(memoryListStore()).sync();
    const id = fake.accountList(ACCOUNT)!.id;
    // a second device of the account, with its own stores: it signed in and claimed its key, and nobody let it in yet
    store = memoryAccountStore();
    service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
    await signIn();
    await registerKey();
    const second = pageList(memoryListStore());
    await second.sync();
    expect([second.view().account, second.view().status.at]).toEqual([ACCOUNT, "not_in"]);
    setPageAccountList(second);
    const pc = await askingPc();
    await postPcKeys(fake.fetch, ORIGIN, fake.issueToken(ACCOUNT, { device: true }), pc, id);
    await mountCard();
    await press("Add");
    // on 1cb5f8afa: holdsList() is false for `not_in`, so the card takes the admission from before lists
    expect([admitsOf(pc), fake.accountList(ACCOUNT)!.entries.length]).toEqual([0, 1]);
    expect(text()).not.toContain("New PC added to your account");
  });

  it("RED P12-F2: a QR add whose entry is in the list, where the placement's answer was lost and the log could not be read, is not reported as refused", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const pc = await askingPc();
    const fetch: PcFetch = async (_path, init) => {
      const body = JSON.parse(String(init?.body)) as { account: string; list: string };
      const card = await signCard({ key: pc.key, enc: pc.enc, list: body.list, endpoint: pc.endpoint, invite: null }, pc.signs);
      await postPcKeys(w.fake.fetch, w.origin, phone.session.access_token, pc, body.list);
      return Response.json({ state: "waiting", standing: "waiting", key: pc.key, enc: pc.enc, card });
    };
    let placed = false;
    phone.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      // the account service places the entry and the answer is lost on the way; the log cannot be read after it
      if (request.method === "POST" && path.endsWith("/entries")) { await w.fake.fetch(request); placed = true; return new Response("bad gateway", { status: 502 }); }
      return placed && path.startsWith("/v2/") ? new Response("down", { status: 503 }) : null;
    };
    const outcome = await nameListToPc({ fetch, list: phone.list, account: w.account, endpoint: pc.endpoint, names: { label: "Desk", os: "linux" }, admit: async () => {}, wait: async () => {} });
    expect(w.held().state.pcs[pc.endpoint]).toMatchObject({ key: pc.key, removed: null });
    // on 1cb5f8afa: { outcome: "refused", why: "unknown" }, which the controller turns into AccountPcError(409) and
    // "Account setup is incomplete." while the PC is in the list
    expect(outcome.outcome).not.toBe("refused");
  });

  it("RED P12-F3: a card whose admission passed and whose entry the list did not take stays until the PC is in the list", async () => {
    let stopped = false;
    const { pc, list, held } = await listAccount({ entries: () => stopped ? Response.json({ error: { code: "list_stopped", message: "stopped" } }, { status: 503 }) : null });
    await mountCard();
    await press("Add");
    stopped = true;
    await press("Add");
    expect(text()).toContain("The account service cannot change the list right now.");
    expect([admitsOf(pc), held().entries.length, list.view().pcs.length]).toEqual([1, 1, 0]);
    // the next read of the account's PCs (the page comes to the front): the listing is admitted, so on 1cb5f8afa the
    // card is gone with nothing said, the PC admitted by the directory alone and not in the list
    await focus();
    expect(cardsFor(pc.server_id)).toBe(1);
  });

  it("RED P12-F9: the number Add writes its `added` record before the card goes, as the invited Add does", async () => {
    const { pc, list } = await listAccount();
    const locks = Promise.withResolvers<void>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { ...navigator, locks: { request: async (_name: string, work: () => Promise<void>) => { await locks.promise; return work(); } } }, configurable: true });
    try {
      await mountCard();
      await press("Add");
      const add = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === "Add")[0]!;
      await act(async () => { void add.props.onClick(); });
      await settle();
      // another tab holds the record's lock: the PC is in the list; on 1cb5f8afa the card is gone while the record waits
      expect(list.view().pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
      expect(cardsFor(pc.server_id)).toBe(1);
    } finally {
      locks.resolve();
      if (saved) Object.defineProperty(globalThis, "navigator", saved);
    }
  });

  it("RED P12b-F4: Revoke on a page that did not make the invite (a reload) ends the account service's invite too", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Mac" });
    await first.list.sync();
    const made = await makeInvite(first.list, { auto: false, ...noWait });
    if (!made.made) throw new Error("no invite");
    // the page reloads: the module that made the invite, and its memory, are gone. What a reloaded page has of the
    // service's id is what this device stored beside its pages (the invite's public key and the id, never the line)
    expect(localStorage.getItem(`ovis:invite-ids:${w.account}`)).toContain(made.invite.key);
    expect(localStorage.getItem(`ovis:invite-ids:${w.account}`)).not.toContain(made.invite.line);
    expect(await revokeInvite(first.list, made.invite.key, noWait)).toEqual({ revoked: true });
    expect(listView(w.held().state).invites.map((row) => row.refusal)).toEqual(["invite_revoked"]);
    const open = await (await w.fake.fetch(`${w.origin}/v1/pc-invites`, { headers: { authorization: `Bearer ${first.session.access_token}` } })).json() as { invites: unknown[] };
    // on 1cb5f8afa: no DELETE went, and the service's invite is still open (a line holder can still redeem it)
    expect(open.invites).toEqual([]);
  });

  it("RED P12b-F5: an invite is never reported made where the list holds it expired from its first second (this device's clock reads behind the list's own time)", async () => {
    const w = listWorld();
    const clock = { label: "Mac", skew: 0 };
    const first = await w.device(clock);
    await first.list.sync();
    // the device's clock is set back twenty minutes after the list's last entry
    w.clock.now += 60_000;
    clock.skew = -20 * 60_000;
    // the account service makes its invite (the fake refuses the key proof the device's clock calls for)
    first.wire.answer = (request) => new URL(request.url).pathname === "/v1/pc-invites" && request.method === "POST"
      ? Response.json({ id: "ab".repeat(16), account: w.account, expires_at: new Date(w.clock.now + 900_000).toISOString(), auto: false }) : null;
    const made = await makeInvite(first.list, { auto: false, ...noWait });
    const state = made.made ? invitesOf(first.list, w.clock.now + clock.skew).find((row) => row.key === made.invite.key)?.state : null;
    // on 1cb5f8afa: made, with an `exp` under the list's own time: the list calls it `invite_expired`, InvitePc shows no
    // line and no reason, and the service's invite is not ended
    expect(made.made && state !== "open").toBe(false);
  });

  it("RED P12b-F6: the plain invite a PC joined with does not stay open after that PC was added (here by the number, the post's proof read at the press)", async () => {
    const { pc, list, held, carried } = await listAccount();
    const made = await makeInvite(list, { auto: false });
    if (!made.made) throw new Error(`no invite was made: ${made.why}`);
    await mountCard();
    // the line's proof reaches the account service after the card was drawn; the press reads the posts with it
    const line = await readJoinLine(made.invite.line, { service: ORIGIN, followsLists: true });
    carried.value = { invite: made.invite.key, invite_proof: await line.signLineProof({ server_id: pc.server_id, card: pc }) };
    await press("Add");
    if (text().includes("Check that the PC shows this number")) await press("Add");
    expect(list.view().pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    // on 1cb5f8afa: the invite is still open (refusal null) and listed with Revoke, so the same line gets a second
    // PC a one-tap card for the rest of its fourteen minutes
    expect(listView(held().state).invites.map((row) => row.refusal)).not.toEqual([null]);
  });

  it("RED P12b-F7: a line whose placement is not known survives the invites panel leaving the screen, and the next Make an invite settles it", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's Mac" });
    await first.list.sync();
    const id = w.held().id;
    let reads = true;
    let placements = 0;
    first.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      // the first placement goes through, and the log cannot be read right after it
      if (request.method === "POST" && path.endsWith("/entries") && placements++ === 0) { const answer = await w.fake.fetch(request); reads = false; return answer; }
      return !reads && request.method === "GET" && path.startsWith(`/v2/lists/${id}`) ? Response.json({ error: { code: "unavailable", message: "" } }, { status: 503 }) : null;
    };
    const mountPanel = async (): Promise<void> => {
      if (renderer !== undefined) await act(async () => { renderer!.unmount(); });
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(InvitePc, { list: first.list, now: () => w.clock.now }) })); });
      await settle();
    };
    await mountPanel();
    await pressWhere((node) => node.props["data-action"] === "make-invite");
    expect(renderer!.root.findAll((node) => node.props["data-testid"] === "invite-pc").map(textOf).join(" ")).toContain("It is not known yet whether the invite was made.");
    // the person goes to another tab of Add PC and comes back: the panel is drawn anew
    reads = true;
    await mountPanel();
    await pressWhere((node) => node.props["data-action"] === "make-invite");
    const shownLine = renderer!.root.findAll((node) => node.props["data-invite-line"] === "").map(textOf)[0];
    const key = (await readJoinLine(shownLine!, { service: w.origin, followsLists: true })).key;
    // on 1cb5f8afa: the first invite is in the list with a line nobody holds any more, and a second one is made
    expect(listView(w.held().state).invites.map((row) => row.key)).toEqual([key]);
  });

  it("RED P12b-F10: a Revoke placed right after another PC's entry is said as Revoked, not Used", async () => {
    const { w, first, invite } = await invited();
    await addListPc(w, first, "Desk");
    expect(await revokeInvite(first.list, invite.key, noWait)).toEqual({ revoked: true });
    // on 1cb5f8afa: "used" (endOf reads only that a `pc` entry sits right before the removal)
    expect(invitesOf(first.list, w.clock.now).find((row) => row.key === invite.key)?.state).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Guards checked and found sound: each passes on 1cb5f8afa
// ---------------------------------------------------------------------------------------------------------------

/** `list` as a page sees it while another page replaced this device's member key with `key` (only while `swap.on`). */
function swappedKey(list: AccountList, swap: { on: boolean }, key: string): AccountList {
  return new Proxy(list, {
    get(target, prop) {
      if (prop === "writer") return (options?: { readonly self?: boolean }) => { const own = target.writer(options); return own === null || !swap.on ? own : { ...own, keys: { ...own.keys, key } }; };
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A device in its list, and a PC that listed itself and posted its keys and card for that list, answering numbers as a PC does. */
async function numbered() {
  const w = listWorld();
  const phone = await w.device({ label: "Dana's phone" });
  await phone.list.sync();
  const pc = await askingPc();
  await postPcKeys(w.fake.fetch, w.origin, w.fake.issueToken(w.account, { device: true }), pc, w.held().id);
  const play = pcComparing(w, pc, w.held().id);
  const [post] = await postedPcs(phone.list);
  if (post === undefined) throw new Error("no post");
  return { w, phone, pc, play, post };
}

describe("PIN guards", () => {
  it("PIN (kills M4) a number is never worked out from a nonce that answers another commitment than this device's own", async () => {
    const { phone, pc, post } = await numbered();
    const other = await askingPc();
    // the account service shows an attempt of another adder, already answered, in place of this device's, and takes
    // any reveal
    const theirs = { adder: other.key, commitment: toBase64Url(randomPairNonce()), nonce: toBase64Url(randomPairNonce()), reveal: null };
    phone.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path.endsWith("/attempt") && (await request.clone().json() as { reveal?: string }).reveal !== undefined) return Response.json({ endpoint: pc.endpoint, key: post.key, attempt: theirs });
      if (request.method !== "GET" || !path.endsWith("/posts")) return null;
      return Response.json({ posts: [{ endpoint: pc.endpoint, server_id: pc.server_id, key: post.key, enc: post.enc, card: post.card, attempt: theirs }] });
    };
    expect(await numberWith(phone.list, post, { wait: async () => {}, waitMs: 5_000 })).toEqual({ shown: false, why: "gone" });
  });

  it("PIN (kills M5) shows no number whose reveal was answered only after the number's two minutes", async () => {
    const { w, phone, play, post } = await numbered();
    phone.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !path.endsWith("/attempt")) return null;
      const revealing = (await request.clone().json() as { reveal?: string }).reveal !== undefined;
      const answer = await w.fake.fetch(request);
      // the PC answers the commitment at once; the reveal's answer comes back two minutes and more later
      if (!revealing) await play.answer();
      else w.clock.now += 121_000;
      return answer;
    };
    expect(await numberWith(phone.list, post, { wait: async () => {}, now: () => w.clock.now })).toEqual({ shown: false, why: "silent" });
  });

  it("PIN (kills M11) says added only where the list holds the PC by the very key of the card: a relay key the list holds under other keys is not this PC's Add", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    const before = await addListPc(w, phone, "Desk");
    // the same relay identity posts other keys (its list keys were made anew); the list holds it under the old ones
    const fresh = await askingPc();
    const list = w.held().id;
    const card = await signCard({ key: fresh.key, enc: fresh.enc, list, endpoint: before.endpoint, invite: null }, fresh.signs);
    const outcome = await addPostedPc(phone.list, { list, endpoint: before.endpoint, server_id: before.server_id, key: fresh.key, enc: fresh.enc, card }, null, { ...noWait, admit: async () => {} });
    expect(outcome.added).toBe(false);
    expect(w.held().state.pcs[before.endpoint]).toMatchObject({ key: before.key });
  });

  it("PIN (kills M17) sends the reveal three times at most while the account service says the PC has not answered", async () => {
    const { w, phone, play, post } = await numbered();
    let reveals = 0;
    phone.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !path.endsWith("/attempt")) return null;
      if ((await request.clone().json() as { reveal?: string }).reveal === undefined) { const answer = await w.fake.fetch(request); await play.answer(); return answer; }
      reveals += 1;
      return reveals > 10 ? new Response("stop", { status: 500 }) : Response.json({ error: { code: "attempt_changed", message: "not yet" } }, { status: 409 });
    };
    expect(await numberWith(phone.list, post, { wait: async () => {}, now: () => w.clock.now })).toEqual({ shown: false, why: "gone" });
    expect(reveals).toBe(3);
  });

  it("PIN (kills M22) offers no one-tap Add for an invite past its time by the floor this device saved, after its clock was set back", async () => {
    const w = listWorld();
    const clock = { label: "Dana's Mac", skew: 0 };
    const first = await w.device(clock);
    await first.list.sync();
    const made = await makeInvite(first.list, { auto: false, ...noWait });
    if (!made.made) throw new Error("no invite");
    const pc = await askingPc();
    const post = await posted(w, first, made.invite, pc);
    // a read past the invite's end saves that time as the floor; then the clock is set back inside the invite's time
    w.clock.now = (made.invite.exp + 120) * 1000;
    await first.list.sync({ read: true });
    clock.skew = -600_000;
    expect(Math.floor((w.clock.now + clock.skew) / 1000)).toBeLessThan(made.invite.exp);
    expect(await invitedPcs(first.list, [post], w.clock.now + clock.skew)).toEqual([]);
  });

  it("PIN (kills M24) offers no one-tap Add where the post names another PC's id than its relay key gives, even with the line's proof for that pairing", async () => {
    const { w, first, invite, pc } = await invited();
    const other = await askingPc();
    const list = first.list.writer()!.list;
    const card = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, pc.signs);
    const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
    // the line holder signs for its relay key under the id of the person's own PC that asks, so the card would be drawn on that PC's row
    const proof = await line.signLineProof({ server_id: other.server_id, card: { key: pc.key, enc: pc.enc, endpoint: pc.endpoint } });
    const post: ListPost = { endpoint: pc.endpoint, server_id: other.server_id, key: pc.key, enc: pc.enc, card, attempt: null, invite: invite.key, invite_proof: proof };
    expect(await invitedPcs(first.list, [post], w.clock.now)).toEqual([]);
  });

  it("PIN (kills M25) offers no one-tap Add for a post whose card is not its key's own, whatever the line signed", async () => {
    const { w, first, invite, pc } = await invited();
    const other = await askingPc();
    const good = await posted(w, first, invite, pc);
    const list = first.list.writer()!.list;
    const forged = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, other.signs);
    expect(await invitedPcs(first.list, [{ ...good, card: forged }], w.clock.now)).toEqual([]);
  });

  it("PIN (kills M30) names nothing to a PC whose scan was for another account than the one this device's list is of", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const pc = await askingPc();
    let asked = 0;
    const fetch: PcFetch = async () => { asked += 1; return Response.json({ error: { code: "not_found" } }, { status: 404 }); };
    expect(await nameListToPc({ fetch, list: phone.list, account: "acct_someone_else", endpoint: pc.endpoint, names: null, admit: async () => {}, wait: async () => {} })).toEqual({ outcome: "none" });
    expect(asked).toBe(0);
  });

  it("PIN (kills M31) takes a 403 link_required at a later ask, after the entry was signed, as the PC's own refusal and never as no such call", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const pc = await askingPc();
    let asks = 0;
    const fetch: PcFetch = async (_path, init) => {
      asks += 1;
      if (asks > 1) return Response.json({ error: { code: "link_required" } }, { status: 403 });
      const body = JSON.parse(String(init?.body)) as { list: string };
      const card = await signCard({ key: pc.key, enc: pc.enc, list: body.list, endpoint: pc.endpoint, invite: null }, pc.signs);
      await postPcKeys(w.fake.fetch, w.origin, phone.session.access_token, pc, body.list);
      return Response.json({ state: "waiting", standing: "waiting", key: pc.key, enc: pc.enc, card });
    };
    const outcome = await nameListToPc({ fetch, list: phone.list, account: w.account, endpoint: pc.endpoint, names: null, admit: async () => {}, wait: async () => {} });
    expect(w.held().state.pcs[pc.endpoint]).toMatchObject({ key: pc.key });
    expect(outcome).toEqual({ outcome: "refused", why: "link_required" });
  });

  it("PIN (kills M35) a QR add signs nothing under another member key than the one the naming began with (C2)", async () => {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const pc = await askingPc();
    const swap = { on: false };
    const stranger = (await deviceListKeys(memoryAccountStore())).key;
    const list = swappedKey(phone.list, swap, stranger);
    const fetch: PcFetch = async (_path, init) => {
      const body = JSON.parse(String(init?.body)) as { list: string };
      const card = await signCard({ key: pc.key, enc: pc.enc, list: body.list, endpoint: pc.endpoint, invite: null }, pc.signs);
      await postPcKeys(w.fake.fetch, w.origin, phone.session.access_token, pc, body.list);
      return Response.json({ state: "waiting", standing: "waiting", key: pc.key, enc: pc.enc, card });
    };
    // another page replaces this device's member key while the account admits the PC
    const outcome = await nameListToPc({ fetch, list, account: w.account, endpoint: pc.endpoint, names: null, admit: async () => { swap.on = true; }, wait: async () => {} });
    expect(outcome).toMatchObject({ outcome: "refused", why: "changed" });
    expect(w.held().entries.length).toBe(1);
  });

  it("PIN (kills M42) keeps the line, and ends nothing at the service, where the account service kept asking for the request again (busy)", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's Mac" });
    await first.list.sync();
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "try_again", message: "again" } }, { status: 409 }) : null;
    const outcome = await makeInvite(first.list, { auto: false, ...noWait });
    expect(outcome).toMatchObject({ made: false, why: "unknown" });
    expect(outcome.made === false && outcome.pending !== undefined).toBe(true);
    expect(first.sent.filter((sent) => sent.route.startsWith("DELETE /v1/pc-invites/"))).toEqual([]);
  });

  it("PIN (kills M60) a device whose copy of the list does not read says it cannot change the list, and admits nothing", async () => {
    await signIn();
    await registerKey();
    const lists = memoryListStore();
    await pageList(lists).sync();
    const id = fake.accountList(ACCOUNT)!.id;
    await lists.set("copy", ACCOUNT, "not a copy of a list");
    const damaged = pageList(lists);
    await damaged.sync();
    expect(damaged.view().status.at).toBe("damaged");
    setPageAccountList(damaged);
    const pc = await askingPc();
    await postPcKeys(fake.fetch, ORIGIN, fake.issueToken(ACCOUNT, { device: true }), pc, id);
    await mountCard();
    await press("Add");
    expect(text()).toContain("This device cannot change your account's list right now.");
    expect(admitsOf(pc)).toBe(0);
  });

  it("PIN (kills M65) the card's Add beside a number signs nothing where the member key is not the one the number was worked out with", async () => {
    const { pc, list, held } = await listAccount();
    const swap = { on: true };
    const stranger = (await deviceListKeys(memoryAccountStore())).key;
    setPageAccountList(swappedKey(list, swap, stranger));
    await mountCard();
    await press("Add");
    expect(text()).toContain("Check that the PC shows this number");
    // the number was worked out under the other key; this device signs with its own again by the press
    swap.on = false;
    await press("Add");
    expect([admitsOf(pc), held().entries.length]).toEqual([0, 1]);
  });

  it("PIN (kills M82) the Settings Add beside a number signs nothing where the member key is not the one the number was worked out with", async () => {
    const { pc, list, held } = await listAccount({ ownListed: true });
    const swap = { on: true };
    const stranger = (await deviceListKeys(memoryAccountStore())).key;
    const swapped = swappedKey(list, swap, stranger);
    const [post] = await postedPcs(swapped);
    if (post === undefined) throw new Error("no post");
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(AddPcByNumber, { list: swapped, account: ACCOUNT, post, name: "PC", now: () => now, onClose: () => {}, onAdded: () => {} }) })); });
    for (let looks = 0; looks < 200 && renderer!.root.findAllByProps({ className: "relay-shell-digits" }).length === 0; looks++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    swap.on = false;
    await pressWhere((node) => textOf(node).trim() === "Add" && node.props.className === "btn btn-primary");
    expect(held().entries.length).toBe(1);
    expect(list.view().pcs.map((row) => row.endpoint)).not.toContain(pc.endpoint);
  });

  it("PIN (kills M70) the card is drawn again at the invite's end by its own timer, with no focus or list change", async () => {
    const { pc, list, carried, postNow } = await listAccount({ deferPost: true });
    const made = await makeInvite(list, { auto: false });
    if (!made.made) throw new Error(`no invite was made: ${made.why}`);
    // the PC listed itself and posted with the line's proof a minute before the invite ends
    now = (made.invite.exp - 60) * 1000;
    await postNow();
    const line = await readJoinLine(made.invite.line, { service: ORIGIN, followsLists: true });
    carried.value = { invite: made.invite.key, invite_proof: await line.signLineProof({ server_id: pc.server_id, card: pc }) };
    now = made.invite.exp * 1000 - 10;
    await mountCard();
    const title = (): string => textOf(renderer!.root.find((node) => node.props["data-unconfirmed-pc"] !== undefined).findAll((node) => node.type === "span")[1]!);
    expect(title()).toBe("Add this PC to your account? (joined with your invite)");
    now = (made.invite.exp + 5) * 1000;
    // the card's own timer, armed for the invite's end and a second after it: waited for by the title, within a deadline
    const deadline = Date.now() + 5_000;
    while (title() !== "Add this PC to your account?" && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(title()).toBe("Add this PC to your account?");
  });

  it("PIN (kills M71) an account with no list: a press after the request's ten minutes admits nothing, whatever the timer did not draw yet", async () => {
    await signIn();
    await registerKey();
    const pc = await askingPc();
    // a PC lists itself with a device code, on an account that has no list
    const token = fake.issueToken(ACCOUNT, { device: true });
    await fake.fetch(`${ORIGIN}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }) });
    await mountCard();
    expect(text()).toContain("Add this PC to your account?");
    now += 11 * 60_000;
    await press("Add");
    expect(admitsOf(pc)).toBe(0);
    expect(fake.accountList(ACCOUNT)).toBeNull();
  });

  it("PIN (kills M9) a one-tap Add for an invite that is over asks the account service to admit nothing", async () => {
    const { w, first, invite, pc } = await invited();
    await listedAndPosted(w, first, pc);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    if (found === undefined) throw new Error("not offered");
    w.clock.now = (invite.exp + 60) * 1000;
    let admitted = 0;
    const outcome = await addInvitedPc(first.list, found, null, { ...noWait, admit: async () => { admitted += 1; } });
    expect([outcome, admitted]).toEqual([{ added: false, why: "invite_ended", retryAfterMs: null }, 0]);
  });
});

describe("PIN the QR naming is only for a code made for the account", () => {
  it("PIN (kills M101) a fresh pairing with a code that carries no account mark names no list to the PC and signs no entry", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    const identity = generateKeyPair();
    const offer: RelayOffer = { v: 1, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.invalid" };
    const accountStore = memoryAccountStore();
    const service = new FakeAccountService();
    service.opensAll = true;
    service.listAccounts = "*";
    const token = service.issueToken("account");
    await accountStore.set("session", { service: "https://account.invalid", account: "account", provider: "github", access_token: token, refresh_token: "test", expires_at: Date.now() + 3_600_000, sign_in_id: "this-sign-in", signed_in_at: Date.now() });
    const registered = await newKey();
    await accountStore.set("signin_key", { account: "account", sign_in_id: "this-sign-in", key: registered, no: service.registerSessionKey(token, registered.public_spki, "Phone") });
    // this device is in its account's list, and may write it
    const list = accountList({ service: new AccountService({ store: accountStore, fetch: service.fetch, lock: memoryLock() }), accountStore, listStore: memoryListStore(), lock: memoryListLock(), genesis: () => "always", durable: async () => true, names: () => ({ label: "Phone", os: "ios" }) });
    await list.sync();
    expect(list.writer()).not.toBeNull();
    // the pairing a plain code made: a key of this device's own at the PC's new row
    const own = await memoryAccountStore().key();
    const devices = new Map<string, RelayDevice>([[offer.server_id, { ...offer, device_id: "12".repeat(8), private_key: own.private_key, public_spki: own.public_spki, label: "Phone" }]]);
    const store: ShellDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()], remove: async (id) => { devices.delete(id); },
      removeRow: async (id, row) => { if (devices.get(id)?.device_id !== row) return false; devices.delete(id); return true; },
      update: async (id, change, source) => { source?.assert(devices.get(source.serverId)); const next = change(devices.get(id)); devices.set(id, next); return next; },
    };
    let namings = 0;
    let linked = false;
    class Paired extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string) {
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked ? "account" : null, unlinked: [], removals: [], enrolling: false });
          case "/api/account/list/named": namings += 1; return Response.json({ error: { code: "not_found" } }, { status: 404 });
          case "/api/account/link": linked = true; return Response.json({});
          case "/api/account/enroll": return Response.json({ results: [] });
          case "/api/account/introduction": return Response.json({ pcs: [] });
          default: return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
      }
    }
    const opened: RelayTransport[] = [];
    const open = async () => { const transport = new Paired(offer); opened.push(transport); return transport; };
    const controller = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.invalid", renderApp: () => { throw new TypeError("No app here"); },
      store, accountStore, accountService: "https://account.invalid", accountProviders: ["github"], open, accountList: list,
      accountFetch: async (input, init) => service.fetch(input, init),
    }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
    try {
      const consent = (await accountStore.get("session"))!;
      // a code for this device alone: no `admission` mark, so the person did not ask to add the PC to the account
      await controller.prepare({ ...offer, code: "123456" }, new AbortController().signal, consent);
      await controller.enroll(await open(), offer.server_id, true, false, { consent }).catch(() => undefined);
      expect(namings).toBe(0);
      expect(service.accountList("account")!.entries.length).toBe(1);
    } finally {
      for (const transport of opened) transport.close();
    }
  });
});

