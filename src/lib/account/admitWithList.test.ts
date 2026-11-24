import { describe, expect, it } from "bun:test";
import { signListEntry } from "../../../shared/account-list.ts";
import { readAccountRecord } from "../../../shared/account-records.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { admitWithList, allowOnPinnedPc, approveForAccount, handListToPc, ListAllowError, NotConfirmedError, takeIntroduction, type PcFetch } from "./join.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList, ListOffer } from "./accountList.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { allowDevice } from "./listAllow.ts";
import { memoryAccountStore } from "./store.ts";

const THROUGH = "a1".repeat(16);
const noWait = async (): Promise<void> => {};
/** A pause that moves the world's clock by its length: a poll bounded by a deadline (the introduction's) ends instead of spinning. */
const passes = (w: { clock: { now: number } }) => async (ms: number): Promise<void> => { w.clock.now += ms; };

/** PC X as an approval meets it: it records what it is sent, and answers the introduction, the records and the list's two calls. */
function pcX(answers: { head?: (body: unknown) => Response; page?: (body: unknown) => Response | Promise<Response>; introduce?: (body: Record<string, unknown>) => Response | Promise<Response>; records?: () => Response | Promise<Response> } = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: PcFetch = async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path, body });
    if (path === "/api/account/list/head") return answers.head?.(body) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (path === "/api/account/list/page") return answers.page?.(body) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (path === "/api/account/introduce" && answers.introduce !== undefined) return answers.introduce(body);
    if (path === "/api/account/records" && answers.records !== undefined) return answers.records();
    return new Response(null, { status: 204 });
  };
  return { sent, fetch, paths: () => sent.map((each) => each.path) };
}

/** The place a PC's introduction carries for a device, as that device reads it over its own session. */
async function listOffer(fetch: PcFetch): Promise<ListOffer | null> {
  let offer: ListOffer | null = null;
  await takeIntroduction({ fetch, key: await memoryAccountStore().key(), label: "Tablet", store: new MemoryDeviceStore(), relay: "wss://relay.test", onList: (handed) => { offer = handed; } });
  return offer;
}

async function admit(from: WorldDevice, joining: { key: string; label: string; os: "android" | null }, pc: ReturnType<typeof pcX>, withList = true) {
  const session = (await from.store.get("session"))!;
  return admitWithList(withList ? from.list : null, {
    fetch: pc.fetch, service: from.service, key: await from.store.key(), account: session.account, joining, through: THROUGH, paired: [], directory: [], wait: noWait,
  });
}

describe("a member's approval, once the PC let the new device in", () => {
  it("is as ever for an account with no list: the introduction and the add, and nothing of a list", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const member = await w.device();
    const newcomer = await w.device({ label: "Tablet" });
    const joining = { key: (await newcomer.store.key()).public_spki, label: "Tablet", os: "android" as const };
    for (const withList of [true, false]) {
      const pc = pcX();
      const add = await admit(member, joining, pc, withList);
      expect(pc.paths()).toEqual(["/api/account/introduce", "/api/account/records"]);
      expect(pc.sent[0]!.body).toEqual({ key: joining.key, pcs: [] });
      expect([add.kind, add.key, (await readAccountRecord(add))?.signer]).toEqual(["add", joining.key, (await member.store.key()).public_spki]);
    }
    expect(member.sent.map((each) => each.route).filter((route) => route.includes("/v2/lists/") && route !== "GET /v2/lists/mine")).toEqual([]);
    expect(w.fake.accountList(w.account)).toBeNull();
  });

  it("lets the newcomer into the list first, hands its place over in the introduction, and the newcomer follows from it", async () => {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    const joining = { key: (await newcomer.keys()).key, label: "Tablet", os: "android" as const };
    const pc = pcX();
    await admit(member, joining, pc);
    const list = w.held();
    expect(list.entries).toHaveLength(2);
    // the PC is asked first whether the new device confirmed there (it holds its row), with nothing introduced yet;
    // only then is the entry signed, and the introduction follows with the place
    expect(pc.paths()).toEqual(["/api/account/introduce", "/api/account/introduce", "/api/account/records", "/api/account/list/head"]);
    expect(pc.sent[0]!.body).toEqual({ key: joining.key, pcs: [] });
    expect(pc.sent[1]!.body).toEqual({ key: joining.key, pcs: [], list: { id: list.id, seq: 1, hash: list.head.hash } });
    // the PC carries it to the new device over that device's own session
    const offer = await listOffer(async () => Response.json({ pcs: [], list: pc.sent[1]!.body.list }));
    expect(offer).toEqual({ list: list.id, seq: 1, hash: list.head.hash });
    const view = await newcomer.list.adopt(offer!);
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    expect(view.devices.map((row) => row.name?.label)).toEqual(["Phone", "Tablet"]);
  });

  it("signs nothing else where the list does not take the newcomer, and says why", async () => {
    const w = listWorld();
    const member = await w.device();
    await member.list.sync();
    const stranger = await listWorld("acct_other").device();
    const pc = pcX();
    const refused = await admit(member, { key: (await stranger.store.key()).public_spki, label: "Stranger", os: null }, pc).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListAllowError);
    expect((refused as ListAllowError).why).toBe("not_claimed");
    // the PC was asked whether the device confirmed, and handed nothing: no PC is introduced, no add is signed
    expect([pc.sent, w.held().entries.length]).toEqual([[{ path: "/api/account/introduce", body: { key: (await stranger.store.key()).public_spki, pcs: [] } }], 1]);
  });

  it("signs nobody into the list who did not confirm at the PC: the entry waits for the PC to hold the new device's row", async () => {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    const joining = { key: (await newcomer.keys()).key, label: "Tablet", os: "android" as const };
    // the new device cancelled before it confirmed its digits: the PC never holds a row for its key
    const never = pcX({ introduce: () => Response.json({ error: { code: "introduction_unknown_key", message: "No account member added that device here" } }, { status: 404 }) });
    let clock = 1_000;
    const session = (await member.store.get("session"))!;
    const refused = await admitWithList(member.list, {
      fetch: never.fetch, service: member.service, key: await member.store.key(), account: session.account, joining, through: THROUGH, paired: [], directory: [],
      now: () => clock, wait: async (ms) => { clock += ms; },
    }).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe("introduction_unknown_key");
    expect(w.held().entries).toHaveLength(1);
    expect(member.sent.map((each) => each.route).filter((route) => route.endsWith("/entries"))).toEqual([]);
    // once it confirmed, the same approval lets it in
    let asked = 0;
    const later = pcX({ introduce: () => (asked++ === 0 ? Response.json({ error: { code: "introduction_unknown_key" } }, { status: 404 }) : new Response(null, { status: 204 })) });
    await admit(member, joining, later);
    expect(w.held().entries).toHaveLength(2);
  });

  it("signs nothing where the sign-in on this page changed since the approval began: neither into the other account's list, nor the old way", async () => {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    // the approval was begun under this device's account, whose list it follows; another tab then signed in to another account
    const began = (await member.store.get("session"))!;
    await member.store.set("session", { ...began, account: "acct_other", access_token: w.fake.issueToken("acct_other"), sign_in_id: "sign-in-other" });
    const pc = pcX();
    const refused = await admitWithList(member.list, {
      fetch: pc.fetch, service: member.service, key: await member.store.key(), account: w.account, joining: { key: (await newcomer.keys()).key, label: "Tablet", os: "android" }, through: THROUGH, paired: [], directory: [], wait: noWait,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListAllowError);
    expect((refused as ListAllowError).why).toBe("changed");
    expect([pc.sent, w.held().entries.length]).toEqual([[], 1]);
  });

  it("goes the way from before lists, at once, for an account this device holds no list of, whatever the page's list is for", async () => {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const pc = pcX();
    // an approval for another account, of which this device keeps no copy of a list: nothing of the list on this page is asked or written
    const before = member.sent.length;
    await admitWithList(member.list, {
      fetch: pc.fetch, service: member.service, key: await member.store.key(), account: "acct_other", joining: { key: (await memoryAccountStore().key()).public_spki, label: "Tablet", os: null }, through: THROUGH, paired: [], directory: [], wait: noWait,
    });
    expect(pc.paths()).toEqual(["/api/account/introduce", "/api/account/records"]);
    expect(member.sent.slice(before).filter((each) => each.route.includes("/v2/lists"))).toEqual([]);
    expect(w.held().entries).toHaveLength(1);
  });

  it("takes no place from an introduction that is out of form, or from a PC that has none", async () => {
    for (const list of [null, "x", { id: "ab".repeat(32), seq: 0, hash: "cd".repeat(32) }, { id: "AB".repeat(32), seq: 1, hash: "cd".repeat(32) }, { id: "ab".repeat(32), seq: 1.5, hash: "cd".repeat(32) }, { id: "ab".repeat(32), seq: 1 }]) {
      expect(await listOffer(async () => Response.json({ pcs: [], list }))).toBeNull();
    }
    expect(await listOffer(async () => Response.json({ pcs: [] }))).toBeNull();
    expect(await listOffer(async () => Response.json({ error: { code: "introduction_none" } }, { status: 404 }))).toBeNull();
  });
});

describe("a member's approval on a PC that lets devices in by the list", () => {
  it("signs the new device in and hands the PC the entry, with no question to the PC about the device's row", async () => {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    const joining = { key: (await newcomer.keys()).key, label: "Tablet", os: "android" as const };
    const list = w.held();
    const pc = pcX({ head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => Response.json({ verdict: "caught_up", list: list.id, place: w.held().head }) });
    const offer = await allowOnPinnedPc(member.list, { fetch: pc.fetch, account: w.account, joining, wait: noWait });
    // the entry is in the list, and the PC holds it
    expect(offer).toEqual({ list: list.id, seq: 1, hash: w.held().head.hash });
    expect(pc.paths()).toEqual(["/api/account/list/head", "/api/account/list/page"]);
    expect(w.held().entries).toHaveLength(2);
  });

  it("says why where the list does not take the device, and hands the PC nothing", async () => {
    const w = listWorld();
    const member = await w.device();
    await member.list.sync();
    const stranger = await listWorld("acct_other").device();
    const pc = pcX();
    const refused = await allowOnPinnedPc(member.list, { fetch: pc.fetch, account: w.account, joining: { key: (await stranger.store.key()).public_spki, label: "Stranger", os: null }, wait: noWait }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListAllowError);
    expect((refused as ListAllowError).why).toBe("not_claimed");
    expect(pc.sent).toEqual([]);
    // a device that follows no list of that account cannot let anybody into such a PC
    const outsider = await listWorld("acct_none").device();
    const none = await allowOnPinnedPc(outsider.list, { fetch: pc.fetch, account: w.account, joining: { key: "k", label: "x", os: null }, wait: noWait }).catch((error: unknown) => error);
    expect((none as ListAllowError).why).toBe("changed");
  });
});

describe("an approval on a card, from the press to what is left to say", () => {
  /** A member in its account's list, a new device that rang at PC X with the key it claimed, and what the card holds of it. */
  async function rang() {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    const relay = generateKeyPair().publicKey;
    const X = deriveServerId(relay);
    await member.service.putPc(X, { label: "Desk", public_key: Array.from(relay, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.test" });
    const key = (await newcomer.keys()).key;
    await newcomer.service.postAdmission(X, "Tablet", key, "android");
    const request = { id: "r1", label: "Tablet", intent: "account" as const, choices: ["111111", "222222", "333333"] as [string, string, string], expires_at: "", key };
    const said: (string | null)[] = [];
    /** for each card: whether X let the device in by a pairing of its own (one that does not follow the list) */
    const ways: boolean[] = [];
    const retries: (() => Promise<void>)[] = [];
    const order: string[] = [];
    /** for each card: whether the list placed the device before the approval stopped */
    const placed: boolean[] = [];
    const approve = (pc: ReturnType<typeof pcX>, followsList: boolean, told: { list?: true; confirmed?: true } = {}, list: typeof member.list | null = member.list, others: readonly string[] = []) => approveForAccount({
      request: { ...request, ...told }, digits: "222222", through: X, service: member.service, account: w.account, key: member.store.key(), list,
      pc: { fetch: async (path, init) => { order.push(path); return pc.fetch(path, init); }, followsList },
      decide: async (decision) => { order.push(decision); }, paired: async () => [], directory: async () => [X, ...others], wait: passes(w), now: () => w.clock.now,
      onStalled: (stalled) => { said.push(stalled === null ? null : stalled.why); if (stalled !== null) { retries.push(stalled.retry); ways.push(stalled.pairedAtPc); placed.push(stalled.placed); } },
    });
    return { w, member, X, key, order, said, ways, placed, retries, approve };
  }

  /** A PC that lets devices in by the list, as an approval meets it: it takes the page, and keeps no row a member added. */
  const pinnedPc = (w: Awaited<ReturnType<typeof rang>>["w"], during: { page?: () => Promise<void>; introduce?: () => Promise<void> } = {}) => {
    const list = w.held();
    return pcX({
      head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }),
      page: async () => { await during.page?.(); return Response.json({ verdict: "caught_up", list: list.id, place: w.held().head }); },
      introduce: async () => { await during.introduce?.(); return Response.json({ error: { code: "introduction_unknown_key" } }, { status: 404 }); },
    });
  };

  /** A member of the list puts `key` out, and `member` reads it into its own copy: what an approval may meet while it waits on the PC. */
  const putOut = async (member: WorldDevice, key: string): Promise<void> => {
    await member.list.sync();
    const writer = member.list.writer()!;
    const removal = await signListEntry(writer.state, { kind: "remove", ends: key }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [removal.text], []);
    await member.list.sync();
  };

  it("on such a PC, sends nothing more for a device its own copy shows put out while the entry was handed over: no introduction, no add", async () => {
    const { w, member, key, order, said, approve } = await rang();
    await approve(pinnedPc(w, { page: () => putOut(member, key) }), true, { list: true, confirmed: true });
    expect(order).toEqual(["approve", "/api/account/list/head", "/api/account/list/page"]);
    expect([w.held().entries.length, said]).toEqual([3, [null, "removed"]]);
  });

  it("on such a PC, signs no add for a device its own copy shows put out while the PC was introduced to it", async () => {
    const { w, member, key, order, said, approve } = await rang();
    await approve(pinnedPc(w, { introduce: () => putOut(member, key) }), true, { list: true, confirmed: true });
    expect(order).toEqual(["approve", "/api/account/list/head", "/api/account/list/page", "/api/account/introduce"]);
    expect([w.held().entries.length, said]).toEqual([3, [null, "removed"]]);
  });

  it("on any other PC, signs no add for a device its own copy shows put out while the PC was introduced to it", async () => {
    const { w, member, key, order, said, approve } = await rang();
    let introductions = 0;
    const pc = pcX({ introduce: async () => { introductions += 1; if (introductions === 2) await putOut(member, key); return new Response(null, { status: 204 }); } });
    await approve(pc, false);
    expect(order).toEqual(["approve", "/api/account/introduce", "/api/account/introduce"]);
    expect([w.held().entries.length, said]).toEqual([3, ["removed"]]);
  });

  it("on a PC that lets devices in by the list: nothing is approved and nothing signed until the new device's person said that the numbers match", async () => {
    const { w, order, said, approve } = await rang();
    const refused = await approve(pinnedPc(w), true).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotConfirmedError);
    expect([order, w.held().entries.length, said]).toEqual([[], 1, []]);
    // and the same for a join the PC marks as one into the list, whatever session the approver has
    const marked = await rang();
    expect(await marked.approve(pinnedPc(marked.w), false, { list: true }).catch((error: unknown) => error)).toBeInstanceOf(NotConfirmedError);
    expect([marked.order, marked.w.held().entries.length]).toEqual([[], 1]);
  });

  it("on such a PC, once the new device confirmed: the approval, then the entry and its hand-over, then the add for the account's other PCs", async () => {
    const { w, order, said, approve } = await rang();
    await approve(pinnedPc(w), true, { list: true, confirmed: true });
    expect(order).toEqual(["approve", "/api/account/list/head", "/api/account/list/page", "/api/account/introduce", "/api/account/records"]);
    expect(w.held().entries).toHaveLength(2);
    expect(said).toEqual([null]);
    const marked = await rang();
    await marked.approve(pinnedPc(marked.w), false, { list: true, confirmed: true });
    expect(marked.order.slice(0, 3)).toEqual(["approve", "/api/account/list/head", "/api/account/list/page"]);
  });

  it("on such a PC, the add for the account's other PCs goes out also where the PC takes no introduction from a device of the list", async () => {
    const { w, order, said, approve } = await rang();
    const list = w.held();
    const pc = pcX({
      head: () => Response.json({ error: { code: "account_route_denied" } }, { status: 403 }),
      introduce: () => Response.json({ error: { code: "account_required" } }, { status: 403 }),
    });
    await approve(pc, true, { list: true, confirmed: true });
    expect(order).toEqual(["approve", "/api/account/list/head", "/api/account/introduce", "/api/account/records"]);
    expect([w.held().entries.length, w.held().id, said]).toEqual([2, list.id, [null]]);
  });

  it("on such a PC, approves nothing where this device holds no list of the account to write", async () => {
    const { w, order, approve } = await rang();
    const refused = await approve(pinnedPc(w), true, { list: true, confirmed: true }, null).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListAllowError);
    expect((refused as ListAllowError).why).toBe("changed");
    expect([order, w.held().entries.length]).toEqual([[], 1]);
  });

  it("on such a PC, where the list does not take the device after the approval: a card says why, and Try again signs it in and hands the PC the entry", async () => {
    const { w, member, order, said, retries, approve } = await rang();
    member.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_stopped", message: "x" } }, { status: 503 }) : null;
    await approve(pinnedPc(w), true, { list: true, confirmed: true });
    expect([order, w.held().entries.length, said]).toEqual([["approve"], 1, ["stopped"]]);
    member.wire.answer = () => null;
    await retries[0]!();
    expect(order).toEqual(["approve", "/api/account/list/head", "/api/account/list/page", "/api/account/introduce", "/api/account/records"]);
    expect([w.held().entries.length, said]).toEqual([2, ["stopped", null]]);
  });

  it("tells the card whether X let the device in by a pairing of its own: never on a PC that lets devices in by the list", async () => {
    const stop = (request: Request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_stopped", message: "x" } }, { status: 503 }) : null;
    const pinned = await rang();
    pinned.member.wire.answer = stop;
    await pinned.approve(pinnedPc(pinned.w), true, { list: true, confirmed: true });
    const other = await rang();
    other.member.wire.answer = stop;
    await other.approve(pcX(), false);
    expect([pinned.said, pinned.ways, other.said, other.ways]).toEqual([["stopped"], [false], ["stopped"], [true]]);
  });

  it.each([true, false])("on a PC that lets devices in by the list (%p) and on any other, a Try again after this device's account key was replaced by another member key ends as changed, and signs nothing", async (pinned) => {
    const { w, member, key, said, retries, approve } = await rang();
    // the page's copy of the list, as another tab may change it under the card: by this device's key, then by another
    let current = member.list;
    const page = new Proxy({} as AccountList, { get: (_target, name) => { const value = Reflect.get(current, name) as unknown; return typeof value === "function" ? value.bind(current) : value; } });
    // the first try reads no claims: nothing is signed, and a card offers Try again
    member.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/claims") ? Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }) : null;
    await (pinned ? approve(pinnedPc(w), true, { list: true, confirmed: true }, page) : approve(pcX(), false, {}, page));
    expect(said).toEqual(["unreached"]);
    member.wire.answer = null;
    // meanwhile another tab put another key on this device, one the list holds as a full member as well
    const other = await w.device({ label: "Laptop" });
    await other.list.sync();
    const laptop = (await other.keys()).key;
    const allowed = await allowDevice(member.list, { key: laptop, label: "Laptop", os: null }, { wait: noWait });
    if (!allowed.allowed) throw new Error(`The laptop was not let in: ${allowed.why}`);
    await other.list.adopt(allowed.offer);
    current = other.list;
    expect(page.writer()?.keys.key).toBe(laptop);
    const entries = w.held().entries.length;
    await retries[0]!();
    expect([said, w.held().entries.length, w.held().state.signers[key]]).toEqual([["unreached", "changed"], entries, undefined]);
  });

  /** Another PC of the account, which the account service lists: one the `add` for the account's other PCs goes to. */
  const anotherPc = async (member: WorldDevice): Promise<string> => {
    const relay = generateKeyPair().publicKey;
    const Y = deriveServerId(relay);
    await member.service.putPc(Y, { label: "Studio", public_key: Array.from(relay, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.test" });
    return Y;
  };

  it("on such a PC, sends the add for the account's other PCs also where the introduction's request itself failed", async () => {
    const { w, member, said, order, approve } = await rang();
    const list = w.held();
    const pc = pcX({
      head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => Response.json({ verdict: "caught_up", list: list.id, place: w.held().head }),
      introduce: () => { throw new TypeError("Failed to fetch"); },
    });
    await approve(pc, true, { list: true, confirmed: true }, member.list, [await anotherPc(member)]);
    expect([order.slice(-2), said]).toEqual([["/api/account/introduce", "/api/account/records"], [null]]);
    expect(member.sent.filter((each) => each.route === "POST /v1/records")).toHaveLength(1);
  });

  it("sends no add to the account's other PCs for a device its own copy shows put out while the PC took the add", async () => {
    const { w, member, key, said, approve } = await rang();
    const pc = pinnedPc(w);
    const records = pcX({ records: async () => { await putOut(member, key); return Response.json({ results: [] }); } });
    const both: ReturnType<typeof pcX> = { ...pc, fetch: async (path, init) => (path === "/api/account/records" ? records : pc).fetch(path, init) };
    await approve(both, true, { list: true, confirmed: true }, member.list, [await anotherPc(member)]);
    expect([member.sent.filter((each) => each.route === "POST /v1/records"), said]).toEqual([[], [null, "removed"]]);
  });

  it("on such a PC, says the device was placed in the list where only the add for the other PCs stopped, for a member key replaced meanwhile", async () => {
    const { w, member, key, said, placed, approve } = await rang();
    let current = member.list;
    const page = new Proxy({} as AccountList, { get: (_target, name) => { const value = Reflect.get(current, name) as unknown; return typeof value === "function" ? value.bind(current) : value; } });
    const other = await w.device({ label: "Laptop" });
    await other.list.sync();
    const allowed = await allowDevice(member.list, { key: (await other.keys()).key, label: "Laptop", os: null }, { wait: noWait });
    if (!allowed.allowed) throw new Error(`The laptop was not let in: ${allowed.why}`);
    await other.list.adopt(allowed.offer);
    // the entry is placed under this device's key; while the PC takes the page, another tab puts the laptop's key here
    const list = w.held();
    const pc = pcX({ head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => { current = other.list; return Response.json({ verdict: "caught_up", list: list.id, place: w.held().head }); } });
    await approve(pc, true, { list: true, confirmed: true }, page);
    expect([w.held().state.signers[key] !== undefined, said, placed]).toEqual([true, [null, "changed"], [true]]);
  });

  it("does not take the way from before lists on a Try again of an approval that began with a list", async () => {
    const { member, said, order, retries, approve } = await rang();
    let current = member.list;
    const page = new Proxy({} as AccountList, { get: (_target, name) => { const value = Reflect.get(current, name) as unknown; return typeof value === "function" ? value.bind(current) : value; } });
    member.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/claims") ? Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }) : null;
    await approve(pcX(), false, {}, page);
    expect(said).toEqual(["unreached"]);
    member.wire.answer = null;
    // the page's copy of the list is gone meanwhile: a device that holds none of this account's
    current = (await listWorld("acct_none").device()).list;
    await retries[0]!();
    expect([said, order.filter((path) => path === "/api/account/records")]).toEqual([["unreached", "changed"], []]);
  });

  it("binds an approval to the member key of its first read where its caller keeps no scope", async () => {
    const { w, member, key } = await rang();
    let current = member.list;
    const page = new Proxy({} as AccountList, { get: (_target, name) => { const value = Reflect.get(current, name) as unknown; return typeof value === "function" ? value.bind(current) : value; } });
    const other = await w.device({ label: "Laptop" });
    await other.list.sync();
    const laptop = (await other.keys()).key;
    const allowed = await allowDevice(member.list, { key: laptop, label: "Laptop", os: null }, { wait: noWait });
    if (!allowed.allowed) throw new Error(`The laptop was not let in: ${allowed.why}`);
    await other.list.adopt(allowed.offer);
    let asked = 0;
    const pc = pcX({ introduce: async () => {
      asked += 1;
      if (asked > 1) return new Response(null, { status: 204 });
      current = other.list;
      return Response.json({ error: { code: "introduction_unknown_key", message: "x" } }, { status: 404 });
    } });
    const session = (await member.store.get("session"))!;
    const refused = await admitWithList(page, {
      fetch: pc.fetch, service: member.service, key: await member.store.key(), account: session.account, joining: { key, label: "Tablet", os: "android" }, through: THROUGH, paired: [], directory: [], wait: passes(w), now: () => w.clock.now,
    }).catch((error: unknown) => error);
    expect([refused instanceof ListAllowError ? refused.why : refused, w.held().state.signers[key]]).toEqual(["changed", undefined]);
  });

  it("on any other PC: the approval first, then the entry once the PC holds the device's row, and a card where the list did not take it", async () => {
    const { w, member, order, said, approve } = await rang();
    await approve(pcX(), false);
    expect(order).toEqual(["approve", "/api/account/introduce", "/api/account/introduce", "/api/account/records", "/api/account/list/head"]);
    expect([w.held().entries.length, said]).toEqual([2, [null]]);
    // the list refuses a second device: the PC let it in already, and the card says so and can try again
    const other = await rang();
    other.member.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_stopped", message: "x" } }, { status: 503 }) : null;
    await other.approve(pcX(), false);
    expect([other.order[0], other.said]).toEqual(["approve", ["stopped"]]);
    expect(member.sent.length).toBeGreaterThan(0);
  });
});

describe("handing a PC the list's new entries over a session", () => {
  /** a member whose list holds a second device, so that there is an entry to hand over */
  async function memberWithNews() {
    const w = listWorld();
    const member = await w.device();
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    await admit(member, { key: (await newcomer.keys()).key, label: "Tablet", os: "android" }, pcX());
    return { w, member };
  }

  it("says where it stands, and hands the entries after the PC's place when the PC is behind", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    const pc = pcX({ head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => Response.json({ verdict: "caught_up" }) });
    expect(await handListToPc(pc.fetch, member.list)).toBe(true);
    expect(pc.sent).toEqual([
      { path: "/api/account/list/head", body: { list: list.id, place: list.head } },
      { path: "/api/account/list/page", body: { list: list.id, after: 0, entries: [list.entries[1]], head: list.head } },
    ]);
  });

  it("counts a PC that stands at that place already as handed, and hands nothing to one that follows another list or has no such call", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    const there = pcX({ head: () => Response.json({ list: list.id, place: list.head }) });
    expect(await handListToPc(there.fetch, member.list)).toBe(true);
    expect(there.paths()).toEqual(["/api/account/list/head"]);
    for (const head of [
      () => Response.json({ list: "ef".repeat(32), place: { seq: 0, hash: "ef".repeat(32) } }),
      // the same list id and the place's number, with another entry at it: no proof that the PC holds this device's entry
      () => Response.json({ list: list.id, place: { seq: list.head.seq, hash: "ef".repeat(32) } }),
      () => Response.json({ list: list.id, place: { seq: "0" } }),
      undefined,
    ]) {
      const pc = pcX(head === undefined ? {} : { head });
      expect(await handListToPc(pc.fetch, member.list)).toBe(false);
      expect(pc.paths()).toEqual(["/api/account/list/head"]);
    }
  });

  it("sends the page the PC asks for, and says the entry was handed only when the PC stands at its place", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    // the PC says it stands at entry 1 of some history, then asks for the list from entry 0, and takes that page
    const answers = [Response.json({ verdict: "asks_after", list: list.id, place: null, asks: { list: list.id, after: null } }), Response.json({ verdict: "caught_up", list: list.id, place: list.head })];
    const pc = pcX({ head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => answers.shift()! });
    expect(await handListToPc(pc.fetch, member.list, list.head)).toBe(true);
    expect(pc.sent.slice(1).map((each) => [each.path, (each.body as { after: number | null }).after])).toEqual([["/api/account/list/page", 0], ["/api/account/list/page", null]]);
  });

  it("says the entry was not handed where the PC refuses the page, takes less than it, or keeps asking", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    const behind = { head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }) };
    for (const page of [
      () => Response.json({ verdict: "refused", list: list.id, place: { seq: 0, hash: list.id } }),
      () => Response.json({ verdict: "refused" }),
      // a page the PC refused is not handed, whatever place the answer names
      () => Response.json({ verdict: "refused", list: list.id, place: list.head }),
      () => Response.json({ verdict: "caught_up", list: list.id, place: { seq: list.head.seq, hash: "ef".repeat(32) } }),
      () => Response.json({ verdict: "asks_after", asks: { list: list.id, after: 0 } }),
      () => Response.json({ verdict: "asks_after", asks: { list: "ef".repeat(32), after: null } }),
      () => Response.json({ error: { code: "rate_limited" } }, { status: 429 }),
    ]) {
      expect(await handListToPc(pcX({ ...behind, page }).fetch, member.list, list.head)).toBe(false);
    }
  });

  it("asks a PC nothing where this device follows no list", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const member = await w.device();
    await member.list.sync();
    const pc = pcX();
    expect(await handListToPc(pc.fetch, member.list)).toBe(false);
    expect(pc.sent).toEqual([]);
  });
});
