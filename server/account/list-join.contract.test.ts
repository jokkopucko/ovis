/**
 * A PC is added to an account that keeps a signed list (docs/account.md, "A PC is added to the list"): a person at the
 * PC and the phone that adds it see one number, the person says so at the PC, and the PC joins by the list alone,
 * pinned from its first moment. The account service's word adds it nowhere.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryFromText, entryToText, readBody } from "../../shared/account-list-entry.ts";
import { pinList, startRead, takePage, writeSave } from "../../shared/account-list-follower.ts";
import { lineChallenge, verifyLineProof, type LineProof } from "../../shared/account-list-invite.ts";
import { readJoinLine, type JoinLine } from "../../shared/account-list-join.ts";
import { openWrap, wrapEpochKey, wrapFromText, wrapToText } from "../../shared/account-list-seal.ts";
import { cardHolds, inviteRefusal, joinEntry } from "../../shared/account-list.ts";
import { newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { fromBase64Url } from "../../shared/relay-pair-sas.ts";
import { listMember, TestList, type ListMember } from "./list.test-helpers.ts";
import { bounded, deferred, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_LIST_FILE, LIST_POST_RENEW_MS } from "./list-follow.ts";
import { ListKeyStore } from "./list-keys.ts";
import { ask, ended, pairingPc, sendLink, signedInWith, vouchFor, type Body, type Pc } from "./pairing.test-helpers.ts";
import { pressOnce } from "./one-press.ts";
import { NAMED_READ_MS } from "./routes.ts";
import { PcAccountState } from "./pc-binding.ts";
import { privateStateFs } from "../private-state.ts";

const ACCOUNT = "acct_1";
const OTHER = "acct_2";
const TOKEN = "list-join-token";
/** This PC's own window: the access token from loopback, no proxy (dispatch.ts ownWindow). */
const own = { authorization: `Bearer ${TOKEN}` };

const pcs: Pc[] = [];
const keptDirs: string[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
  for (const dir of keptDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

/** A PC in no account, named for ACCOUNT and listed in it by a sign-in, as `ovis add` leaves it before anybody presses Add. */
async function listedPc() {
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
  const listIn = async (account: string) => { if (!(await directory(account, `/v1/pcs/${identity.server_id}`, "PUT")).ok) throw new Error("The PC was not listed"); };
  await listIn(ACCOUNT);
  return {
    pc: made, services, serverId: identity.server_id, endpoint, hook, post, listIn,
    /** A device of the account presses Add: the account admits this PC (the phone does it before it places the entry). */
    admit: async (account = ACCOUNT) => { if (!(await directory(account, `/v1/pcs/${identity.server_id}/admit`, "POST")).ok) throw new Error("The PC was not admitted"); },
    start: () => post("/api/account/list/add", { account: ACCOUNT }),
    state: async () => (await made.local("/api/account/list/add", { headers: own })).body,
    status: async () => (await made.local("/api/account/status", { headers: own })).body,
    confirm: async (digits: unknown) => post("/api/account/list/add/confirm", { digits }),
    binding: () => (JSON.parse(readFileSync(join(made.stateDir, "account-pc.json"), "utf8")) as { binding: Record<string, unknown> | null }).binding,
  };
}

type Listed = Awaited<ReturnType<typeof listedPc>>;

/** The number as both sides come to it: the phone commits, the PC answers, the phone reveals, the PC shows it. */
async function compared(made: Listed, account: TestList, adder = account.first): Promise<{ phone: string; shown: Body }> {
  const number = await account.compare(made.endpoint, adder);
  await number.commit();
  // the PC takes the commitment and answers with its nonce
  expect(await made.state()).toMatchObject({ state: "waiting" });
  const phone = await number.reveal();
  if (phone === null) throw new Error("The PC did not answer the commitment");
  return { phone, shown: await made.state() };
}

/** Waits for `done`, ten seconds at most. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) { if (performance.now() > deadline) throw new Error(what); await Bun.sleep(5); }
}

/** The file another Ovis on this folder keeps for its binding `bindId`: its copy of the list, read from entry 0 with this PC's own keys. */
async function listFileOf(made: Listed, account: TestList, bindId: string): Promise<string> {
  const keys = await new ListKeyStore(made.pc.stateDir).keysFor(made.serverId);
  const first = pinList(null, { account: ACCOUNT, list: account.id, me: { key: keys.key, endpoint: made.endpoint }, pin: { how: "added" } });
  if (!first.pinned) throw new Error("The copy could not be started");
  const held = made.pc.account.accountList(ACCOUNT)!;
  const taken = await takePage(first.copy, startRead(first.copy, "service"), { list: account.id, after: null, entries: held.entries, head: held.head }, Math.floor(Date.now() / 1000));
  return JSON.stringify({ v: 1, server_id: made.serverId, bind_id: bindId, want: null, save: writeSave(taken.copy) });
}

describe("a PC in no account is added to an account that keeps a signed list", () => {
  test("the phone and the PC show one number, the person says so at the PC, and the PC joins by the list, pinned from its first moment", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    expect((await made.start()).body).toEqual({ state: "waiting", run: expect.stringMatching(/^[0-9a-f]{16}$/), account: ACCOUNT, list: account.id, until: expect.any(String) });
    expect((await made.status()).waiting_for_add).toBe(true);
    const { phone, shown } = await compared(made, account);
    expect(shown).toEqual({ state: "number", run: expect.any(String), account: ACCOUNT, list: account.id, digits: phone, until: expect.any(String) });
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    // the phone's Add: the account admits the PC, then the entry
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toEqual({ state: "added", run: expect.any(String), account: ACCOUNT, list: account.id });
    expect(made.pc.devices.account()).toBe(ACCOUNT);
    // bound by the list: no binding on the service's word ever stood, and the pin is in the binding itself
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.binding()).not.toHaveProperty("service");
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    expect(made.pc.devices.listFollowed()).toBe(true);
    expect((await made.status()).waiting_for_add).toBe(false);
  });

  test("a PC that joined by the list tells the account service so with the listing its own pull names, and takes no admission", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const named: string[] = [];
    const completed: string[] = [];
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/pc/complete") completed.push((await request.clone().json() as { listing_id: string }).listing_id);
      const answer = await forward();
      if (path === "/v1/pc/mailbox" && answer.ok) {
        const listing = (await answer.clone().json() as { listing_id?: unknown }).listing_id;
        if (typeof listing === "string") named.push(listing);
      }
      return answer;
    };
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await until(() => completed.length > 0, "No completion was sent");
    // once, with the listing the pull named, and the account service takes it (its pull is the listing's evidence): the
    // account's page stops showing the PC as only listed
    expect(completed).toHaveLength(1);
    expect(named).toContain(completed[0]!);
    await until(() => made.pc.account.pcs(ACCOUNT).find((row) => row.listing_id === completed[0])?.completed_at != null, "The completion was not taken");
    expect(made.pc.account.requests.some((line) => line.includes("/v1/pc/admission"))).toBe(false);
  });

  test("the account service's refusal of that receipt drops the receipt and nothing else: the PC stays in by its list, with its copy", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    let refused = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v1/pc/complete") return await forward();
      refused++;
      return Response.json({ error: { code: "listing_changed", message: "This add is no longer waiting for that action" } }, { status: 409 });
    };
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await until(() => refused > 0, "No completion was sent");
    await made.services.accountMailbox.pull();
    await made.services.accountList!.settled();
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.pc.devices.account()).toBe(ACCOUNT);
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    expect((JSON.parse(readFileSync(join(made.pc.stateDir, ACCOUNT_LIST_FILE), "utf8")) as { save: unknown }).save).not.toBeNull();
    // the receipt is dropped: it is not sent again
    expect(refused).toBe(1);
  });

  test("only a final refusal of that receipt drops it: a 429, a 401 of a lapsed proof and a 5xx keep it for the next pull", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const answers = [
      () => Response.json({ error: { code: "rate_limited", message: "Slow down" } }, { status: 429, headers: { "retry-after": "1" } }),
      () => Response.json({ error: { code: "proof_invalid", message: "Ask for a new challenge and answer it" } }, { status: 401 }),
      () => Response.json({ error: { code: "unavailable", message: "Down" } }, { status: 503 }),
      () => Response.json({ error: { code: "listing_changed", message: "This add is no longer waiting for that action" } }, { status: 409 }),
    ];
    let sent = 0;
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/complete" ? answers[Math.min(sent++, answers.length - 1)]!() : await forward();
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await until(() => sent > 0, "No completion was sent");
    const receipt = join(made.pc.stateDir, "account-completion.json");
    // kept after the 429, the 401 and the 503, and sent again at each pull
    for (const kept of [1, 2, 3]) {
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ account: ACCOUNT, listing_id: expect.any(String) });
      await made.services.accountMailbox.pull();
      expect(sent).toBe(kept + 1);
    }
    // the fourth answer is final: the receipt goes, and nothing else
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toBeNull();
    await made.services.accountMailbox.pull();
    expect(sent).toBe(4);
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
  });

  test("a PC that stops before any pull after its join still tells the account service, once, after it starts again", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // no pull of this PC's mailbox is answered while it joins: nothing names its listing before it stops
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/mailbox" ? new Response("away", { status: 503 }) : await forward();
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await made.services.accountMailbox.pull();
    expect(made.pc.account.requests.some((line) => line.includes("/v1/pc/complete"))).toBe(false);
    const kept = mkdtempSync(join(tmpdir(), "ovis-list-join-"));
    keptDirs.push(kept);
    cpSync(made.pc.stateDir, kept, { recursive: true, filter: (path) => !statSync(path).isSocket() });
    await made.pc.close();
    pcs.splice(pcs.indexOf(made.pc), 1);
    // the same PC starts again, and the account service answers it
    const named: string[] = [];
    const completed: string[] = [];
    const again = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false,
      prepare: (dir) => cpSync(kept, dir, { recursive: true }), accountFetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/pc/complete") completed.push((await request.clone().json() as { listing_id: string }).listing_id);
        const answer = await made.pc.account.fetch(request);
        if (path === "/v1/pc/mailbox" && answer.ok) {
          const listing = (await answer.clone().json() as { listing_id?: unknown }).listing_id;
          if (typeof listing === "string") named.push(listing);
        }
        return answer;
      } });
    pcs.push(again);
    const { services } = again.app.context;
    await services.accountList!.settled();
    expect(services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    await services.accountMailbox.pull();
    await until(() => completed.length > 0, "No completion was sent after the start");
    // once, with the listing its own pull named, and not again
    await services.accountMailbox.pull();
    expect(completed).toHaveLength(1);
    expect(named).toContain(completed[0]!);
    expect(made.pc.account.requests.some((line) => line.includes("/v1/pc/admission"))).toBe(false);
  });

  test("what a join owes the account service, when the disk does not take it at the join, is written at the next pull", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/mailbox" ? new Response("away", { status: 503 }) : await forward();
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    const receipt = join(made.pc.stateDir, "account-completion.json");
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === receipt) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      renameSync(from, to);
    });
    try { expect((await made.confirm(phone)).body).toMatchObject({ state: "added" }); } finally { failing.mockRestore(); }
    expect(existsSync(receipt)).toBe(false);
    await made.services.accountMailbox.pull();
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ account: ACCOUNT, list_bind_id: made.binding()!.bind_id });
  });

  test("a join whose binding ended before any pull named its listing owes the account service nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/mailbox" ? new Response("away", { status: 503 }) : await forward();
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    const receipt = join(made.pc.stateDir, "account-completion.json");
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ account: ACCOUNT });
    // the person revokes everything at the PC before the account service is reached again
    expect(made.pc.devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    made.hook.on = null;
    await made.services.accountMailbox.pull();
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toBeNull();
    expect(made.pc.account.requests.some((line) => line.includes("/v1/pc/complete"))).toBe(false);
  });

  test("a device the list holds opens the PC at once, and one only the account service names does not", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await listMember();
    await account.addDevice(phone);
    await made.start();
    const number = await compared(made, account);
    await made.confirm(number.phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await made.services.accountList!.settled();
    expect(made.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
    // what the account service says from then on moves nothing: a snapshot that names another device, and one that lists this PC no more
    const stranger = await listMember();
    made.pc.account.registerDevice(ACCOUNT, stranger.key, "Stranger");
    await made.services.accountMailbox.pull();
    await made.services.accountList!.settled();
    expect(made.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    // a member removes a device: it goes at the next read
    await account.remove(phone.key);
    await made.services.accountMailbox.pull();
    await made.services.accountList!.settled();
    expect(made.services.accountRows!.rows().map((row) => row.key)).toEqual([account.first.key]);
  });

  test("after a restart with the account service away, the PC is still in the account by its list and holds the list's devices", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await listMember();
    await account.addDevice(phone);
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await made.services.accountList!.settled();
    // what the PC keeps on disk, as it stood when it stopped
    const kept = mkdtempSync(join(tmpdir(), "ovis-list-join-"));
    keptDirs.push(kept);
    // its files only: the socket it listens on for recovery is no state
    cpSync(made.pc.stateDir, kept, { recursive: true, filter: (path) => !statSync(path).isSocket() });
    await made.pc.close();
    pcs.splice(pcs.indexOf(made.pc), 1);
    // the same state, and an account service that answers nothing
    const again = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false,
      prepare: (dir) => cpSync(kept, dir, { recursive: true }), accountFetch: async () => { throw new Error("The account service is away"); } });
    pcs.push(again);
    const { services } = again.app.context;
    await services.accountList!.settled();
    expect(again.devices.account()).toBe(ACCOUNT);
    expect(again.devices.listFollowed()).toBe(true);
    expect(services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    expect(services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
  });

  test("two Ovis on one folder join by the list at once: the one whose binding did not win takes the other's copy, and writes nothing over it", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    // The other Ovis on this folder read the list a moment earlier: its binding and its copy are on disk by the time
    // this server's own read of the list is done, and this server's memory holds neither
    const winner = "ab".repeat(16);
    const pcPath = join(made.pc.stateDir, "account-pc.json");
    const listPath = join(made.pc.stateDir, ACCOUNT_LIST_FILE);
    let theirs = "";
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list/log" && theirs === "") {
        const disk = JSON.parse(readFileSync(pcPath, "utf8")) as { gen: number };
        writeFileSync(pcPath, JSON.stringify({ ...disk, v: 2, gen: disk.gen + 1, binding: { account: ACCOUNT, bind_id: winner, list: account.id } }));
        theirs = await listFileOf(made, account, winner);
        writeFileSync(listPath, theirs);
      }
      return await forward();
    };
    expect((await made.confirm(phone)).body).toMatchObject({ state: "added" });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, bind_id: winner, list: account.id });
    // the other's copy stays on disk under its binding: never `save: null` in its place
    const file = JSON.parse(readFileSync(listPath, "utf8")) as { bind_id: string; save: string | null };
    expect(file.bind_id).toBe(winner);
    expect(file.save).not.toBeNull();
    // and this server goes by that binding and that copy
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    expect(made.services.accountRows!.rows().map((row) => row.key)).toEqual([account.first.key]);
  });

  test("a No given while the confirmed add reads the list binds nothing, though the entry is there", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    const cancels = spyOn(made.services.listAdd!, "cancel");
    let cancelled: Promise<unknown> | null = null;
    made.hook.on = async (request, forward) => {
      // the person at the PC gives the add up while its read of the list is out
      if (new URL(request.url).pathname === "/v2/pc/list/log" && cancelled === null) {
        cancelled = made.post("/api/account/list/add/cancel");
        await until(() => cancels.mock.calls.length > 0, "The cancel did not reach the add");
      }
      return await forward();
    };
    const confirmed = await made.confirm(phone);
    await cancelled;
    expect(confirmed.body.state).not.toBe("added");
    expect(await made.state()).toMatchObject({ state: "ended", why: "cancelled" });
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a PC in its account that another way pins to another list while the confirmed add reads its list keeps that pin, and the add ends", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    // a device's link brings the PC into its account meanwhile, on the service's word
    made.pc.devices.bindByService(ACCOUNT);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    // and another list is pinned while the add's read of its own list is out
    const elsewhere = "ab".repeat(32);
    let pinned = false;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list/log" && !pinned) {
        pinned = PcAccountState.open(made.pc.stateDir).pinToList(made.binding()!.bind_id as string, elsewhere);
      }
      return await forward();
    };
    const state = await made.state();
    expect(pinned).toBe(true);
    expect(state.state).not.toBe("added");
    expect(made.binding()).toMatchObject({ list: elsewhere });
    expect(made.services.accountList!.status()).toMatchObject({ pinned_list: elsewhere });
  });

  test("a follower that stopped while the confirmed add read the list binds nothing from that read", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    let stopped = false;
    made.hook.on = async (request, forward) => {
      // Ovis stops on this PC while the read of the list is out
      if (new URL(request.url).pathname === "/v2/pc/list/log" && !stopped) { stopped = true; made.services.accountList!.stop(); }
      return await forward();
    };
    const confirmed = await made.confirm(phone);
    expect(stopped).toBe(true);
    expect(confirmed.body.state).not.toBe("added");
    expect(made.binding()).toBeNull();
    expect(existsSync(join(made.pc.stateDir, "account-completion.json"))).toBe(false);
  });

  test("a PC pinned to the list says it joined only by a copy that shows it in, never by a copy it is still reading", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    // its copy is lost, and it starts again with the account service away: it holds a copy it has not read yet
    const kept = mkdtempSync(join(tmpdir(), "ovis-list-join-"));
    keptDirs.push(kept);
    cpSync(made.pc.stateDir, kept, { recursive: true, filter: (path) => !statSync(path).isSocket() });
    rmSync(join(kept, ACCOUNT_LIST_FILE));
    await made.pc.close();
    pcs.splice(pcs.indexOf(made.pc), 1);
    const again = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false,
      prepare: (dir) => cpSync(kept, dir, { recursive: true }), accountFetch: async () => { throw new Error("The account service is away"); } });
    pcs.push(again);
    const list = again.app.context.services.accountList!;
    await list.settled();
    expect(list.status()).toMatchObject({ pinned: true, standing: "waiting" });
    expect(await list.joinList({ account: ACCOUNT, list: account.id, by: null })).toEqual({ waiting: "waiting" });
  });

  test("only an entry the device whose number was confirmed signed adds the PC: another member's entry joins nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const other = await listMember();
    await account.addDevice(other);
    await made.start();
    // the person compared with the account's first device, and said yes to that number
    const { phone } = await compared(made, account);
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    // another device of the account signs the PC in
    await made.admit();
    await account.addPostedPc(made.endpoint, other);
    expect(await made.state()).toMatchObject({ state: "ended", why: "other_adder" });
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a poll that names its run learns nothing of the run that replaced it", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    const started = (await made.start()).body as { run: string };
    expect((await made.pc.local(`/api/account/list/add?run=${started.run}`, { headers: own })).body).toMatchObject({ state: "waiting", run: started.run });
    expect((await made.pc.local(`/api/account/list/add?run=${"0".repeat(16)}`, { headers: own })).body).toEqual({ state: "replaced" });
    expect((await made.post("/api/account/list/add/cancel", { run: "0".repeat(16) })).body).toEqual({ state: "replaced" });
    expect((await made.pc.local(`/api/account/list/add?run=x`, { headers: own })).status).toBe(400);
    expect((await made.post("/api/account/list/add/cancel", { run: started.run })).body).toMatchObject({ state: "ended", why: "cancelled" });
  });

  test("without the person's yes at the PC nothing is joined, whatever the list then holds", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "number", digits: phone });
    expect(made.pc.devices.account()).toBeNull();
    // and the account service's word adds it nowhere: an account with a list takes a PC by the list alone
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([409, "list_add"]);
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a yes to another number than the one on the screen confirms nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    const other = phone === "000000" ? "000001" : "000000";
    expect((await made.confirm(12)).status).toBe(400);
    // a wrong number ends that number, and the answer names none
    const wrong = await made.confirm(other);
    expect([wrong.status, wrong.body.error?.code]).toEqual([409, "wrong_number"]);
    expect(JSON.stringify(wrong.body)).not.toContain(phone);
    // the right one confirms nothing any more: the device has to ask again
    expect((await made.confirm(phone)).status).toBe(409);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "waiting" });
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a No at the PC ends the add: the entry a member then places joins nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    await compared(made, account);
    expect((await made.post("/api/account/list/add/cancel")).body).toMatchObject({ state: "ended", account: ACCOUNT, why: "cancelled" });
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "ended", account: ACCOUNT, why: "cancelled" });
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a service that names a list of its own shows the PC a number the phone never shows, and its entry joins nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // the lie: another list, which the service made with a key of its own, named to this PC as its account's
    const lie = await TestList.start(made.pc.account, OTHER);
    await made.listIn(OTHER);
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (new URL(request.url).pathname !== "/v2/pc/list" || !answer.ok) return answer;
      return Response.json({ ...await answer.json() as object, list: lie.id });
    };
    expect((await made.start()).body).toMatchObject({ state: "waiting", list: lie.id });
    // the phone of the account finds no card of this PC on its own list: it has no number to show
    await expect(account.compare(made.endpoint)).rejects.toThrow("The PC posted no keys");
    const forged = await compared(made, lie);
    expect(forged.shown).toMatchObject({ state: "number", digits: forged.phone });
    // nobody at the PC says yes to a number no phone shows; the service's own entry is there all the same
    await made.admit(OTHER);
    await lie.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "number" });
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a yes to a list that is another account's joins nothing", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    const lie = await TestList.start(made.pc.account, OTHER);
    await made.listIn(OTHER);
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (new URL(request.url).pathname !== "/v2/pc/list" || !answer.ok) return answer;
      return Response.json({ ...await answer.json() as object, list: lie.id });
    };
    await made.start();
    const forged = await compared(made, lie);
    await made.confirm(forged.phone);
    await made.admit(OTHER);
    await lie.addPostedPc(made.endpoint);
    const ended = await made.state();
    expect(ended.state).not.toBe("added");
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });
});

/** `ovis join` up to the account service's listing: the PC redeems the invite of the line on its own proof, as the command does. */
async function redeemed(made: Listed, invite: { line: string }) {
  const line = await readJoinLine(invite.line, { service: "https://account.test", followsLists: true });
  const proof = (await made.post("/api/account/pc-proof")).body as { challenge_id: string; proof: string };
  const signature = await line.signRedeem({ server_id: made.serverId, public_key: made.endpoint, challenge_id: proof.challenge_id });
  const answer = await made.pc.account.fetch(new Request("https://account.test/v1/pc-invites/redeem", { method: "POST", body: JSON.stringify({
    invite_key: line.key, invite_signature: signature, server_id: made.serverId, public_key: made.endpoint, relay: "wss://relay.ovis.sh", label: "PC", challenge_id: proof.challenge_id, proof: proof.proof }) }));
  if (!answer.ok) throw new Error(`The invite was not redeemed: ${answer.status} ${await answer.text()}`);
  return line;
}

/** The command's side of a join the PC makes by itself: it asks where the list stands, has the PC build the body, signs it with the line, and has it placed. */
async function joinsByItself(made: Listed, list: string, line: JoinLine, change: { entry?: (text: string) => string } = {}) {
  const scope = { account: ACCOUNT, list, invite: line.key };
  const prepared = await made.post("/api/account/list/join/prepare", scope);
  if (prepared.body.state !== "prepared") return prepared;
  const { seq, enc, seal, wraps } = prepared.body as unknown as { seq: number; enc: string; seal: { epoch: number; opens: string } | null; wraps: { epoch: number; wrap: string }[] };
  // the names' key, which only the line opens, wrapped again for the PC
  const held = seal === null ? undefined : wraps.find((wrap) => wrap.epoch === seal.epoch);
  const opened = seal === null || held === undefined ? null : await openWrap({ list, epoch: seal.epoch, commitment: seal.opens, wrap: wrapFromText(held.wrap), member: { key: line.key, privateKey: line.encryptionKey } });
  const own = opened !== null && opened.open ? await wrapEpochKey({ list, epoch: opened.value, member: enc }) : null;
  const built = await made.post("/api/account/list/join/body", { ...scope, seq });
  if (built.body.state !== "body") return built;
  const entry = entryToText(await line.signJoin(readBody(fromBase64Url(built.body.body as string))));
  return await made.post("/api/account/list/join/place", { ...scope, entry: change.entry?.(entry) ?? entry, ...(own === null ? {} : { wraps: [{ epoch: seal!.epoch, member: enc, wrap: wrapToText(own) }] }) });
}

describe("a PC joins a signed list with the line of an invite (ovis join)", () => {
  test("a plain invite: the PC posts its card with the line's proof, a device of the account adds it, and the PC joins by the list the line names", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: false }));
    const named = { account: ACCOUNT, list: account.id, invite: line.key };
    // What the PC posts with its keys, the two members it adds included, which the fake service checks as the account
    // service does
    const posts: Record<string, unknown>[] = [];
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list/keys") posts.push(await request.clone().json() as Record<string, unknown>);
      return await forward();
    };
    // the line names the list, so its holder shows that it holds it: the PC hands over its card for the line to sign
    const asked = await made.post("/api/account/list/join", named);
    const card = { key: expect.any(String), enc: expect.any(String), endpoint: made.endpoint, list: account.id };
    expect(asked.body).toEqual({ state: "prove", card });
    const proof = await line.signLineProof({ server_id: made.serverId, card: asked.body.card as unknown as LineProof["card"] });
    const waiting = await made.post("/api/account/list/join", { ...named, proof });
    expect(waiting.body).toEqual({ state: "waiting", standing: "waiting" });
    expect(made.pc.devices.account()).toBeNull();
    // the post carries the invite and the line's proof for the very card it posts, which a device checks by itself
    expect(posts).toHaveLength(1);
    const post = posts[0] as { key: string; enc: string; card: string; invite: string; invite_proof: string };
    expect([post.invite, post.invite_proof]).toEqual([line.key, proof]);
    expect(await verifyLineProof({ account: ACCOUNT, server_id: made.serverId, list: account.id, card: { key: post.key, enc: post.enc, endpoint: made.endpoint } }, post.invite_proof, post.invite)).toBe(true);
    // a device chooses Add on the card of the PC that joined with its invite
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect((await made.post("/api/account/list/join", { ...named, proof })).body).toEqual({ state: "added", account: ACCOUNT });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(made.pc.account.accountList(ACCOUNT)!.state.pcs[made.endpoint]).toMatchObject({ how: "added" });
  });

  test("a renewed post carries the line's proof again", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: false }));
    const named = { account: ACCOUNT, list: account.id, invite: line.key };
    const posts: Record<string, unknown>[] = [];
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list/keys") {
        const { invite, invite_proof } = await request.clone().json() as Record<string, unknown>;
        posts.push({ invite, invite_proof });
      }
      return await forward();
    };
    const { card } = (await made.post("/api/account/list/join", named)).body as unknown as { card: LineProof["card"] };
    const proof = await line.signLineProof({ server_id: made.serverId, card });
    await made.post("/api/account/list/join", { ...named, proof });
    // the post lasts ten minutes at the account service: it is made again before they are over
    const clock = spyOn(Date, "now").mockImplementation(() => performance.timeOrigin + performance.now() + LIST_POST_RENEW_MS + 1_000);
    try { await made.post("/api/account/list/join", { ...named, proof }); } finally { clock.mockRestore(); }
    expect(posts).toEqual([{ invite: line.key, invite_proof: proof }, { invite: line.key, invite_proof: proof }]);
  });

  test("a list id alone names no list to this PC: only the line's proof for this PC's own card names it, and a redeem signature is none", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: false }));
    const stranger = await readJoinLine((await account.invite({ auto: false })).line, { service: "https://account.test", followsLists: true });
    const named = { account: ACCOUNT, list: account.id, invite: line.key };
    const { card } = (await made.post("/api/account/list/join", named)).body as unknown as { card: LineProof["card"] & { list: string } };
    // a card of keys the PC does not hold, at this PC's relay key: what an account service that lies would have signed
    const theirs = await listMember();
    const forged = { key: theirs.key, enc: theirs.enc, endpoint: made.endpoint, list: account.id };
    const posted = () => made.pc.account.accountList(ACCOUNT)!.posts.length;
    for (const proof of [
      // the line's redeem signature over the challenge of another card: the account service chooses redeem challenges
      await line.signRedeem({ server_id: made.serverId, public_key: made.endpoint, challenge_id: lineChallenge(account.id, forged) }),
      // and over this very card's challenge: a redeem signature is no proof of a line, whatever it signs
      await line.signRedeem({ server_id: made.serverId, public_key: made.endpoint, challenge_id: lineChallenge(account.id, card) }),
      // another line's proof, the line's proof for another PC, and for another card
      await stranger.signLineProof({ server_id: made.serverId, card }),
      await line.signLineProof({ server_id: "f".repeat(32), card }),
      await line.signLineProof({ server_id: made.serverId, card: forged }),
      "A".repeat(86),
    ]) {
      const refused = await made.post("/api/account/list/join", { ...named, proof });
      expect([refused.status, refused.body.error?.code]).toEqual([409, "line_unproven"]);
    }
    expect(posted()).toBe(0);
    // a member's entry for this PC, if there were one, would join nothing either
    expect(made.pc.devices.account()).toBeNull();
    // the card is this PC's for this list: another list gives another
    const other = await TestList.start(made.pc.account, OTHER);
    expect(((await made.post("/api/account/list/join", { ...named, list: other.id })).body as unknown as { card: { list: string } }).card.list).toBe(other.id);
  });

  test("an invite for one PC to join by itself: the PC builds its join, the line signs it, the PC places it and joins, with nobody else awake", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await listMember();
    await account.addDevice(phone);
    const invite = await account.invite({ auto: true });
    const line = await redeemed(made, invite);
    const joined = await joinsByItself(made, account.id, line);
    expect(joined.body).toEqual({ state: "added", account: ACCOUNT });
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(held.state.pcs[made.endpoint]).toMatchObject({ how: "joined", invite: invite.key, removed: null });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    // the devices of the list open it, and the names' key came with the join
    expect(made.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
    expect(held.wraps.some((wrap) => wrap.member === held.state.pcs[made.endpoint]!.enc)).toBe(true);
    // a machine that joined by itself is no signer: it lets nobody into the list
    expect(made.services.accountList!.canAllow()).toBe(false);
    expect(made.services.accountList!.allowRefusal()).toBe("not_signer");
  });

  test("a PC's own join is dated by the clock that signs, held against the list's own time: a PC whose clock reads early joins all the same", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    // this PC's own clock reads five minutes early: what it signs is never dated before the list's own time
    const follower = made.services.accountList! as unknown as { seconds(): number };
    const early = spyOn(follower, "seconds").mockImplementation(() => Math.floor(Date.now() / 1000) - 300);
    try { expect((await joinsByItself(made, account.id, line)).body).toEqual({ state: "added", account: ACCOUNT }); } finally { early.mockRestore(); }
    const held = made.pc.account.accountList(ACCOUNT)!;
    // its join is dated no earlier than the entry before it
    const join = held.entries.at(-1)!;
    expect(readBody(entryFromText(join).body).issued_at).toBeGreaterThanOrEqual(readBody(entryFromText(held.entries.at(-2)!).body).issued_at);
  });

  test("a gateway's 5xx answer to the placement is no refusal: the PC reads the list, and joins when its entry is there", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    // the account service places the entry, and a gateway in front of it answers 502
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/entries") return await forward();
      await forward();
      return new Response("Bad gateway", { status: 502 });
    };
    expect((await joinsByItself(made, account.id, line)).body).toEqual({ state: "added", account: ACCOUNT });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
  });

  test("a PC whose Ovis is older than what a member wrote into the list does not write itself in, and says that it needs an update", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    const placed = made.pc.account.accountList(ACCOUNT)!.head.seq;
    // a member with a newer Ovis wrote an entry this build cannot read: the PC is behind from it on
    made.pc.account.tamperList(account.id, { inject: [await account.signLater()] });
    const refused = await joinsByItself(made, account.id, line);
    expect([refused.status, refused.body.error?.code]).toEqual([409, "behind"]);
    expect(refused.body.error?.message).toContain("Update Ovis on this PC");
    expect(made.pc.account.accountList(ACCOUNT)!.head.seq).toBe(placed);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("the PC places only the join it built itself", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    const placed = made.pc.account.accountList(ACCOUNT)!.head.seq;
    // another join the line would sign too: this PC's relay key with a key of somebody else's choosing
    const stranger = await listMember();
    const state = made.pc.account.accountList(ACCOUNT)!.state;
    const other = await joinEntry(line, { key: stranger.key, privateKey: stranger.keys.privateKey, enc: stranger.enc, endpoint: made.endpoint }, state, Math.floor(Date.now() / 1000), null);
    const refused = await joinsByItself(made, account.id, line, { entry: () => other.text });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "not_written"]);
    expect(made.pc.account.accountList(ACCOUNT)!.head.seq).toBe(placed);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("getting ready to join binds nothing: a PC the list holds already is handed its card for the line to sign, whatever invite it was named", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // a member signed this PC's posted card into the list, and nobody at the PC confirmed a number
    await made.start();
    await made.admit();
    await account.addPostedPc(made.endpoint);
    // this PC's own window names the member's key, which anybody can read, as the invite
    const prepared = await made.post("/api/account/list/join/prepare", { account: ACCOUNT, list: account.id, invite: account.first.key });
    expect(prepared.body.state).toBe("prove");
    expect(made.binding()).toBeNull();
    expect(made.pc.devices.account()).toBeNull();
    // and that key signs no proof of a line: the join then refuses it
    const refused = await made.post("/api/account/list/join", { account: ACCOUNT, list: account.id, invite: account.first.key, proof: "A".repeat(86) });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "line_unproven"]);
    expect(made.binding()).toBeNull();
  });

  test("a PC joins by itself only with an invite made for one PC, and never with one a person adds a PC with", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const plain = await readJoinLine((await account.invite({ auto: false })).line, { service: "https://account.test", followsLists: true });
    const asPlain = await made.post("/api/account/list/join/prepare", { account: ACCOUNT, list: account.id, invite: plain.key });
    expect([asPlain.status, asPlain.body.error?.code]).toEqual([409, "invite_plain"]);
    // An auto invite that lets two PCs in, signed by a member. The account service places none (`uses_one`), so it is
    // shown to this PC beside the log, as a service that lies would: the PC refuses it all the same
    const many = await listMember();
    const text = await account.sign({ kind: "invite", key: many.key, exp: Math.floor(Date.now() / 1000) + 15 * 60, uses: 2, auto: true, sealed: null }, account.first, account.place);
    made.pc.account.tamperList(account.id, { inject: [text] });
    const asMany = await made.post("/api/account/list/join/prepare", { account: ACCOUNT, list: account.id, invite: many.key });
    expect([asMany.status, asMany.body.error?.code]).toEqual([409, "invite_uses"]);
    const unknown = await listMember();
    const refused = await made.post("/api/account/list/join/prepare", { account: ACCOUNT, list: account.id, invite: unknown.key });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "invite_unknown"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("an invite that was used lets no second PC in", async () => {
    const first = await listedPc();
    const account = await TestList.start(first.pc.account, ACCOUNT);
    const invite = await account.invite({ auto: true });
    expect((await joinsByItself(first, account.id, await redeemed(first, invite))).body).toMatchObject({ state: "added" });
    // the list holds the join: every member counts the invite as spent
    const line = await readJoinLine(invite.line, { service: "https://account.test", followsLists: true });
    expect(inviteRefusal(first.pc.account.accountList(ACCOUNT)!.state, line.key)).toBe("invite_spent");
  });

  test("the list moved between the body and the placement: the PC is told to prepare again, and then joins", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    const scope = { account: ACCOUNT, list: account.id, invite: line.key };
    const prepared = await made.post("/api/account/list/join/prepare", scope);
    const built = await made.post("/api/account/list/join/body", { ...scope, seq: (prepared.body as { seq?: number }).seq });
    const entry = entryToText(await line.signJoin(readBody(fromBase64Url(built.body.body as string))));
    // a member writes meanwhile
    await account.addDevice(await listMember());
    expect((await made.post("/api/account/list/join/place", { ...scope, entry })).body).toEqual({ state: "again" });
    expect(made.pc.devices.account()).toBeNull();
    account.refresh();
    expect((await joinsByItself(made, account.id, line)).body).toEqual({ state: "added", account: ACCOUNT });
  });

  test("the join routes are this PC's own window's alone, and name the account this PC was set up for", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    for (const path of ["/api/account/list/join", "/api/account/list/join/prepare", "/api/account/list/join/body", "/api/account/list/join/place"]) {
      const base = `http://127.0.0.1:${made.pc.app.port}`;
      const answer = await fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-machine": "1", "x-forwarded-for": "100.64.0.9", ...own }, body: JSON.stringify({ account: ACCOUNT, list: account.id }) });
      expect(answer.status).toBe(403);
    }
    const other = await made.post("/api/account/list/join", { account: OTHER, list: account.id, invite: account.first.key });
    expect([other.status, other.body.error?.code]).toEqual([409, "account_mismatch"]);
  });
});

describe("a device that scans the PC's QR code names the list over that pairing, in the place of its link", () => {
  /** The device of the account that scans: it pairs with the code made for the account, and its account vouches for its key. */
  async function scanned(made: Listed, device: ListMember, options: { vouch?: boolean; account?: string } = {}) {
    // the clock a row's waits run on, moved by hand: what the PC answers a row asking again is its last read for a while
    const clock = new TestClock();
    made.pc.devices.useClock(clock);
    const code = made.pc.devices.startAccountPairing(options.account ?? ACCOUNT).code;
    const key = { keys: device.keys, spki: device.key };
    if (options.vouch !== false) await vouchFor(made.pc, options.account ?? ACCOUNT, key);
    const paired = await signedInWith(made.pc, code, key, { serverId: made.serverId });
    return {
      ...paired,
      names: (list: string, account = ACCOUNT) => ask(paired.session, "/api/account/list/named", { method: "POST", body: { account, list } }),
      /** Past the time the PC answers this row from its last read of the list. */
      later: () => clock.advance(NAMED_READ_MS),
      /** Its ordinary signed link, for the account the code was made for. */
      links: async () => sendLink(paired.session, await signAccountRecord({ v: 1, kind: "link", account: options.account ?? ACCOUNT, key: device.key, server_id: made.serverId, device_id: paired.id,
        old_key: device.key, issued_at: new Date().toISOString(), id: newRecordId(), signer: device.key }, device.keys.privateKey)),
    };
  }

  test("a device that named its account's list sends no link after it: the PC joins by that list, or not at all", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await scanned(made, account.first);
    expect((await phone.names(account.id)).body.state).toBe("waiting");
    // the same pairing then sends its ordinary link, which its account vouches for
    const linked = await bounded(phone.links(), 3_000);
    expect([linked.status, linked.body.error?.code]).toEqual([409, "list_named"]);
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
    // it still waits for that list, and the list then adds the PC by that device
    expect((await phone.names(account.id)).body.state).toBe("waiting");
    await made.admit();
    await account.addPostedPc(made.endpoint);
    phone.later();
    expect((await phone.names(account.id)).body).toEqual({ state: "added", account: ACCOUNT });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
  });

  test("two namings of one pairing that cross while the account service is asked: the first names its list, another list is refused, and asking again spends no try", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const theirs = await TestList.start(made.pc.account, OTHER);
    const phone = await scanned(made, account.first);
    // the account service's word on the device's key is held until the other namings are in
    const held = deferred<void>();
    let asked = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v1/pc/mailbox" && asked++ === 0) await held.promise;
      return await forward();
    };
    const arrivals = spyOn(made.pc.devices, "linkArrived");
    const first = phone.names(account.id);
    await until(() => asked > 0, "The first naming did not ask the account service");
    const second = await bounded(phone.names(theirs.id), 3_000);
    expect([second.status, second.body.error?.code]).toEqual([409, "pairing_ended"]);
    // the same naming asked again, more often than a row has tries, while the first one's answer is out
    const again = Array.from({ length: 6 }, () => phone.names(account.id));
    await until(() => arrivals.mock.calls.filter((call) => call[0] === phone.id).length >= 7, "The asks did not arrive");
    held.resolve();
    expect((await first).body.state).toBe("waiting");
    for (const answer of await Promise.all(again)) expect([answer.status, answer.body.state]).toEqual([200, "waiting"]);
    expect(made.pc.account.accountList(ACCOUNT)!.posts.map((post) => post.endpoint)).toEqual([made.endpoint]);
    expect(made.pc.account.accountList(OTHER)!.posts).toEqual([]);
  });

  test("the PC hands its card over the pairing, the device signs it in, and the PC joins by that list, pinned", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await scanned(made, account.first);
    const waiting = await phone.names(account.id);
    expect([waiting.status, waiting.body.state]).toEqual([200, "waiting"]);
    // the card came over the pairing the QR code made, and is this PC's own for that list
    const { key, enc, card } = waiting.body as unknown as { key: string; enc: string; card: string };
    expect(await cardHolds({ key, enc, list: account.id, endpoint: made.endpoint, invite: null }, card)).toBe(true);
    expect(made.pc.account.accountList(ACCOUNT)!.posts.map((post) => [post.endpoint, post.key])).toEqual([[made.endpoint, key]]);
    expect(made.pc.devices.account()).toBeNull();
    // asking again where it stands is no new try: the device may ask as often as it needs
    const reads = () => made.pc.account.requests.filter((line) => line.includes("/v2/pc/list/log")).length;
    const read = reads();
    for (let asks = 0; asks < 8; asks++) expect((await phone.names(account.id)).body.state).toBe("waiting");
    // and costs the PC no read of the list at the account service: it is answered from the last one, for a few seconds
    expect(reads()).toBe(read);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect((await phone.names(account.id)).body.state).toBe("waiting");
    phone.later();
    expect((await phone.names(account.id)).body).toEqual({ state: "added", account: ACCOUNT });
    expect(reads()).toBeGreaterThan(read);
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.binding()).not.toHaveProperty("service");
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    // no member was written by the pairing: the devices are the list's
    expect(made.pc.stored()).toEqual([]);
    expect(made.services.accountRows!.rows().map((row) => row.key)).toEqual([account.first.key]);
  });

  test("an entry another key signed joins nothing: the PC is added by the device that scanned it", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const other = await listMember();
    await account.addDevice(other);
    const phone = await scanned(made, account.first);
    await phone.names(account.id);
    await made.admit();
    await account.addPostedPc(made.endpoint, other);
    phone.later();
    const refused = await phone.names(account.id);
    expect([refused.status, refused.body.error?.code]).toEqual([409, "other_adder"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a device its account does not vouch for names nothing, and goes", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await scanned(made, account.first, { vouch: false });
    const refused = await phone.names(account.id);
    expect([refused.status, refused.body.error?.code]).toEqual([403, "unverified_device"]);
    // turned away, as a link its account does not vouch for is: its session ends
    expect(await ended(phone.session)).toBe("auth_revoked");
    expect(made.pc.account.accountList(ACCOUNT)!.posts).toEqual([]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a list of another account, another account than the code's, and a second list from one device are refused", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const theirs = await TestList.start(made.pc.account, OTHER);
    const phone = await scanned(made, account.first);
    // the code was made for ACCOUNT: a device that names another account is turned away as its link would be
    const other = await scanned(await listedPc(), account.first);
    const mismatch = await other.names(theirs.id, OTHER);
    expect([mismatch.status, mismatch.body.error?.code]).toEqual([409, "account_mismatch"]);
    // a list that is not ACCOUNT's own, named as if it were: nothing of it is taken
    expect((await phone.names(theirs.id)).body.state).toBe("waiting");
    await made.listIn(OTHER);
    await made.admit(OTHER);
    await theirs.addPostedPc(made.endpoint).catch(() => undefined);
    expect((await phone.names(theirs.id)).body.state).not.toBe("added");
    const second = await phone.names(account.id);
    expect([second.status, second.body.error?.code]).toEqual([409, "pairing_ended"]);
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a key this PC removed itself names no list, though it pairs again with the account's code", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const key = { keys: account.first.keys, spki: account.first.key };
    // the device paired with a code of this PC's own, and the person revoked it here
    const { code } = made.pc.devices.startPairing();
    const before = await signedInWith(made.pc, code, key, { serverId: made.serverId });
    expect(made.pc.devices.revoke(before.id)).toBe(true);
    // it scans the account's QR code: its row waits to link, under the key this PC removed
    const phone = await scanned(made, account.first);
    const refused = await phone.names(account.id);
    expect([refused.status, refused.body.error?.code]).toEqual([409, "tombstoned"]);
    expect(made.pc.account.accountList(ACCOUNT)!.posts).toEqual([]);
    expect(made.binding()).toBeNull();
  });

  test("only a device that waits to link names a list: a device this PC already holds does not", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // paired with a code of this PC's own, as `ovis pair` makes one
    const { code } = made.pc.devices.startPairing();
    const paired = await signedInWith(made.pc, code, undefined, { serverId: made.serverId });
    const refused = await ask(paired.session, "/api/account/list/named", { method: "POST", body: { account: ACCOUNT, list: account.id } });
    expect(refused.status).toBe(403);
    expect(made.pc.devices.account()).toBeNull();
  });
});

describe("what stays as it was", () => {
  test("an account with no list takes the PC in one press, and the add by the list says there is none", async () => {
    const made = await listedPc();
    expect((await made.start()).body).toEqual({ state: "no_list", account: ACCOUNT });
    expect((await made.status()).waiting_for_add).toBe(false);
    await made.admit();
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.account]).toEqual([200, ACCOUNT]);
    expect(made.binding()).toMatchObject({ account: ACCOUNT, service: true });
    expect(made.binding()).not.toHaveProperty("list");
  });

  test("a PC already in an account, and one named for another account, start no add", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    const other = await made.post("/api/account/list/add", { account: OTHER });
    expect([other.status, other.body.error?.code]).toEqual([409, "account_mismatch"]);
    expect((await made.post("/api/account/list/add", {})).status).toBe(400);
  });

  test("a poll of a run that was replaced leaves the run that stands as it is", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    expect((await made.status()).waiting_for_add).toBe(true);
    expect((await made.pc.local(`/api/account/list/add?run=${"0".repeat(16)}`, { headers: own })).body).toEqual({ state: "replaced" });
    expect((await made.status()).waiting_for_add).toBe(true);
  });

  test("the number is shown to this PC's own window alone", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    await compared(made, account);
    // the access token from another origin's page, or with no token at all
    for (const path of ["/api/account/list/add"]) {
      const answer = await fetch(`http://127.0.0.1:${made.pc.app.port}${path}`, { headers: { "x-forwarded-for": "100.64.0.9", ...own } });
      expect(answer.status).toBe(403);
      expect(JSON.stringify(await answer.json())).not.toMatch(/[0-9]{6}/);
    }
  });

  test("a Revoke all that ends while one press still asks whether the account keeps a list makes that press bind nothing", async () => {
    const made = await listedPc();
    await made.admit();
    // the owner revokes every device while the PC's first question to the account service is out
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list") PcAccountState.open(made.pc.stateDir).raiseGen();
      return await forward();
    };
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([409, "revoked"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a relay identity that changes while one press still asks whether the account keeps a list makes that press bind nothing", async () => {
    const made = await listedPc();
    await made.admit();
    const { relay } = made.services;
    const before = relay.currentIdentity()!;
    // from the PC's first question on, this PC answers to another relay identity: the account service's answers were for the old one
    let changed = false;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list") changed = true;
      return await forward();
    };
    const services = { ...made.services, relay: Object.assign(Object.create(relay) as typeof relay, { currentIdentity: () => changed ? { ...before, server_id: "f".repeat(32) } : before }) };
    const pressed = await pressOnce(services, ACCOUNT);
    expect(changed).toBe(true);
    expect(pressed).toMatchObject({ refused: { code: "identity_changed", status: 409 } });
    expect(made.pc.devices.account()).toBeNull();
  });

  test("an account that made its list a moment ago takes no PC in one press: the service refuses the take, and the PC forgets that it had none", async () => {
    const made = await listedPc();
    // the PC heard that the account keeps no list
    expect((await made.start()).body).toEqual({ state: "no_list", account: ACCOUNT });
    await made.admit();
    // the account makes its list, and the service refuses the take of an admission for it
    const account = await TestList.start(made.pc.account, ACCOUNT);
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/admission"
      ? Response.json({ error: { code: "list_add", message: "This account keeps a signed list" } }, { status: 409 }) : await forward();
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([409, "list_add"]);
    expect(made.pc.devices.account()).toBeNull();
    // and the next ask goes by the list, with no half minute of the old answer in between
    made.hook.on = null;
    expect((await made.start()).body).toMatchObject({ state: "waiting", list: account.id });
  });

  test("while the account service does not answer, one press binds nothing", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    await made.admit();
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v2/pc/list" ? new Response("away", { status: 503 }) : await forward();
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([503, "account_unavailable"]);
    expect(made.pc.devices.account()).toBeNull();
  });
});
