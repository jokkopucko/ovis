import { describe, expect, it, spyOn } from "bun:test";
import { kindBody } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import {
  admitsSession, ATTEMPT_ENTRIES_MAX, compareHeads, gossipHead, pinList, readSave, servePage, shownPcs, startRead, takePage,
  type FollowerCopy, type FollowRead, type ListPage,
} from "../../../shared/account-list-follower.ts";
import { addListPc, listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { accountList, type AccountList } from "./accountList.ts";
import { memoryListLock } from "./listStore.ts";
import { allowDevice } from "./listAllow.ts";
import { deliverOnce, GOSSIP_CALLS_PER_MINUTE, GOSSIP_SECONDS, gossipBudget, gossipWithPc, keepListGossip, type GossipSession } from "./listGossip.ts";
import { removeListPc } from "./listRemove.ts";
import { moved } from "./listMigrate.test-helpers.ts";
import { signedOn, writeToList } from "./listWrite.ts";
import { handListToPc, type PcFetch } from "./join.ts";

type World = ReturnType<typeof listWorld>;

const noWait = { wait: async () => {} };
const seconds = (w: World): number => Math.floor(w.clock.now / 1000);
const hashOf = (text: string): string => entryHash(entryFromText(text).body);
/** Every call may be made: the budget of a minute is the session's (keepListGossip), not one exchange's. */
/** An exchange with a PC this device's copy holds: what it lacks is handed to it. */
const handing = { hands: true } as const;
/** The id of a PC the list holds, as the session with it names it: the fake PCs here stand in for it. */
const knownPc = (list: AccountList): string => list.view().pcs[0]?.server_id ?? "no PC";
const always = (): boolean => true;

/** An account with two devices in its list and a PC the first one added. */
async function account(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const outcome = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, noWait);
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  await second.list.adopt(outcome.offer);
  const desk = await addListPc(w, first, "Desk");
  await second.list.sync();
  return { w, first, second, desk };
}

/** A member puts a device out: one `remove` of its key, as a Remove of the devices list signs it. */
async function removeDevice(from: WorldDevice, key: string): Promise<void> {
  const outcome = await writeToList(from.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), noWait);
  if (!outcome.written) throw new Error(`the removal was not placed: ${outcome.why}`);
}

/**
 * Another history from entry 1 that the first device signed, which is no post it left behind: more entries by one
 * signer than one post holds. Each lets a PC in that the honest history never names.
 */
async function otherHistory(w: World, by: WorldDevice): Promise<string[]> {
  const keys = await by.keys();
  const { id } = w.held();
  const texts: string[] = [];
  let head = { seq: 0, hash: id };
  for (let index = 0; index <= ATTEMPT_ENTRIES_MAX; index += 1) {
    const endpoint = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const body = kindBody({ issued_at: seconds(w), list: id, prev: head.hash, seq: head.seq + 1, signer: keys.key }, { kind: "carried", endpoint, sealed: null });
    const text = entryToText(await signEntry(body, keys.signs));
    texts.push(text);
    head = { seq: head.seq + 1, hash: hashOf(text) };
  }
  return texts;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers });

/**
 * A PC in memory that follows the account's list and answers the two calls of a session as a pinned PC does
 * (server/account/list-follow.ts `peerHeads`, `takePeerPage`; the real one is held to this in
 * relay/listGossip.contract.test.ts). It holds `texts` as its history, whatever the account service shows anybody.
 */
async function memoryPc(w: World, texts: readonly string[], options: { followsList?: boolean; takeAtMost?: number } = {}) {
  const list = hashOf(texts[0]!);
  // it follows the list as entry 0's signer would: whose copy it is does not change what it holds or answers
  const pinned = pinList(null, { account: w.account, list, me: { key: readBody(entryFromText(texts[0]!).body).signer, endpoint: null }, pin: { how: "genesis" } });
  if (!pinned.pinned) throw new Error("the PC could not pin the list");
  const top = texts.length - 1;
  let copy: FollowerCopy = (await takePage(pinned.copy, startRead(pinned.copy, "service"), { entries: texts, head: { seq: top, hash: top === 0 ? list : hashOf(texts[top]!) } }, seconds(w))).copy;
  let kept: FollowRead | null = null;
  // as a pinned PC asks: never past its footing (server/account/list-follow.ts, footingAsk)
  const atFooting = (after: number | null): number | null => after === null || copy.state === null || after <= copy.state.footing.seq ? after : copy.state.footing.seq;
  const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const pc = {
    calls,
    followsList: options.followsList !== false,
    /** Answer 429 to every call from now on, with this `retry-after` (seconds). */
    limit: null as number | null,
    copy: () => copy,
    /** Takes what the account service shows it (a removal it was not withheld). */
    async read(more: readonly string[]): Promise<void> {
      const at = copy.entries.length - 1;
      copy = (await takePage(copy, startRead(copy, "service"), { entries: more, head: { seq: at + more.length, hash: hashOf(more.at(-1)!) } }, seconds(w))).copy;
    },
    fetch: (async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
      calls.push({ path, body });
      if (pc.limit !== null) return json({ error: { code: "rate_limited" } }, 429, { "retry-after": String(pc.limit) });
      const own = gossipHead(copy);
      if (path === "/api/account/list/head") {
        const compared = compareHeads(copy, { list: body.list as string, place: body.place as never });
        if (compared.verdict === "not_my_list") return json(own);
        const asks = body.asks as { list: string; after: number | null } | undefined;
        const served = asks !== undefined && asks.list === copy.list ? servePage(copy, asks, 256) : null;
        if (compared.verdict === "ahead") {
          const page = served ?? servePage(copy, { list: copy.list, after: (body.place as { seq: number } | null)?.seq ?? null }, 256);
          return json(page === null ? own : { ...own, page });
        }
        const answered = served === null ? own : { ...own, page: served };
        if (compared.read === null) return json(answered);
        kept = compared.read;
        return json({ ...answered, asks: { list: compared.read.list, after: atFooting(compared.read.after) } });
      }
      if (path === "/api/account/list/page") {
        const after = body.after as number | null;
        const read: FollowRead = kept !== null && kept.after === after ? kept : { ...startRead(copy, "peer"), after };
        // a PC that reads fewer entries of a page than it is handed asks for the rest next (`more`)
        const page = options.takeAtMost === undefined ? body : { ...body, entries: (body.entries as string[]).slice(0, options.takeAtMost) };
        const took = await takePage(copy, read, page as unknown as ListPage, seconds(w));
        copy = took.copy;
        kept = took.read;
        return json({ verdict: took.verdict, ...(took.read === null ? {} : { asks: { list: took.read.list, after: atFooting(took.read.after) } }), ...gossipHead(copy) });
      }
      return json({ error: { code: "not_found" } }, 404);
    }) as PcFetch,
  };
  return pc;
}

/** A session with `pc` as the relay transport gives it: up, and following the list as the PC says. */
function sessionOf(pc: { fetch: PcFetch; followsList: boolean }): GossipSession & { up(on: boolean): void } {
  const listeners = new Set<() => void>();
  const session = {
    followsList: pc.followsList,
    route: "relay" as "relay" | "direct" | undefined,
    fetch: (input: string, init?: RequestInit) => pc.fetch(input, init),
    onRouteChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    up(on: boolean) { session.route = on ? "relay" : undefined; for (const listener of [...listeners]) listener(); },
  };
  return session;
}

/** Waits for `done` to hold, polling to a deadline: the exchanges run on their own. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Lets what an answer already in leads to run its course: no more than a few turns of the event loop, no timer. */
async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The page's list as it is until `other.on`: from then on it stands for another account's list, of another list and
 * member, as the page shows it once another tab signed this browser in to another account. Counts the pages a PC
 * handed it (`took`).
 */
function pageOf(list: AccountList) {
  const other = { on: false, took: 0 };
  const page: AccountList = new Proxy(list, { get: (target, name, receiver) => {
    if (name === "takeFromPeer") return (...args: Parameters<AccountList["takeFromPeer"]>) => { other.took += 1; return target.takeFromPeer(...args); };
    if (!other.on) return Reflect.get(target, name, receiver);
    if (name === "view") return () => ({ ...target.view(), account: "acct_other", devices: target.view().devices.map((row) => row.self ? { ...row, key: "another member key" } : row) });
    if (name === "gossip") return () => { const head = target.gossip(); return head === null ? null : { ...head, list: "6d".repeat(32) }; };
    if (name === "knowsPc") return () => false;
    return Reflect.get(target, name, receiver);
  } });
  return { page, other };
}

/** A PC that holds a removal of a PC of the list the account service withholds from `second`: it stands ahead of that device. */
async function aheadOf(w: World, first: WorldDevice, second: WorldDevice, endpoint: string) {
  w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
  expect(await removeListPc(first.list, endpoint, noWait)).toEqual({ removed: true });
  w.clock.now += 30_000;
  await second.list.sync();
  expect(second.list.holdsPc(endpoint)).toBe(true);
  return memoryPc(w, w.held().entries);
}

describe("a device and the PC it has a session with say where the list stands", () => {
  it("in one call where both stand at one entry, and hand nothing", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    expect(await gossipWithPc(pc.fetch, first.list, null, always, handing)).toEqual({ end: "done", carry: null, retryAfterMs: null });
    expect(pc.calls.map((call) => call.path)).toEqual(["/api/account/list/head"]);
    expect(pc.calls[0]!.body).toEqual(gossipHead(pc.copy()) as unknown as Record<string, unknown>);
  });

  it("hand the PC a removal the account service withholds from it, which it takes on its own check of the entry", async () => {
    const { w, first, second } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const removed = (await second.keys()).key;
    expect(admitsSession(pc.copy(), removed, seconds(w)).why).toBeNull();
    await removeDevice(first, removed);
    expect(await gossipWithPc(pc.fetch, first.list, null, always, handing)).toMatchObject({ end: "done" });
    expect(pc.calls.map((call) => call.path)).toEqual(["/api/account/list/head", "/api/account/list/page"]);
    expect(admitsSession(pc.copy(), removed, seconds(w)).why).toBe("removed");
    expect(gossipHead(pc.copy())).toEqual(first.list.gossip()!);
  });

  it("take from the PC a removal the account service withholds from this device, and keep it", async () => {
    const { w, first, second, desk } = await account();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    w.clock.now += 30_000;
    await second.list.sync();
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
    const pc = await memoryPc(w, w.held().entries);
    expect(await gossipWithPc(pc.fetch, second.list, null, always, handing)).toMatchObject({ end: "done" });
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    expect(second.list.gossip()).toEqual(gossipHead(pc.copy()));
    // kept: what the device saved holds the removal, and the account service's withholding takes nothing back
    const saved = await readSave(String(await second.lists.get("copy", w.account)));
    expect(saved.read && shownPcs(saved.copy).map((row) => row.endpoint)).toEqual([]);
    w.clock.now += 30_000;
    await second.list.sync();
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    // a peer's page is no full read of the account service
    expect(second.list.view().status).toMatchObject({ at: "following", trouble: null });
  });

  it("raise the alarm on both sides where each holds a history members signed, and the device then signs nothing", async () => {
    const { w, first, second } = await account();
    const fork = await otherHistory(w, first);
    // the honest history goes on by another member too: to the PC it is no post its writer left behind
    await addListPc(w, second, "Laptop");
    await first.list.sync();
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const before = first.list.view();
    const result = await gossipWithPc(pc.fetch, first.list, null, always, handing);
    expect(result.end).toBe("alarm");
    expect(first.list.view().status).toMatchObject({ at: "following", standing: "in", trouble: "fork" });
    // nobody of the other history is let in or shown, whom the device held stays, and it signs nothing from now on
    expect(first.list.view().pcs.map((row) => row.endpoint)).toEqual(before.pcs.map((row) => row.endpoint));
    expect(first.list.writer()).toBeNull();
    // the PC asked for the device's own entries and judged them: it has the alarm too
    expect(pc.calls.some((call) => call.path === "/api/account/list/page")).toBe(true);
    expect(pc.copy().alarm).toMatchObject({ code: "fork", source: "peer" });
    // the device's alarm is kept with its copy
    const saved = await readSave(String(await first.lists.get("copy", w.account)));
    expect(saved.read && saved.copy.alarm).toMatchObject({ code: "fork", source: "peer", seq: 1 });
  });

  it("take nothing a stranger signed from the PC", async () => {
    const { w, second, desk } = await account();
    const stranger = await w.device({ label: "nobody", register: false });
    const { id, head } = w.held();
    const keys = await stranger.keys();
    const forged = entryToText(await signEntry(kindBody({ issued_at: seconds(w), list: id, prev: head.hash, seq: head.seq + 1, signer: keys.key }, { kind: "remove", endpoint: desk.endpoint }), keys.signs));
    const pc = await memoryPc(w, w.held().entries);
    const page = { list: id, after: head.seq, entries: [forged], head: { seq: head.seq + 1, hash: hashOf(forged) } };
    expect(await second.list.takeFromPeer(page, null)).not.toBeNull();
    // whatever the follower makes of it, nobody is put out, and where the device stands is what members signed
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
    expect(second.list.gossip()).toEqual(gossipHead(pc.copy()));
    expect(second.list.view().status).toMatchObject({ standing: "in" });
    expect(second.list.view().status).not.toMatchObject({ trouble: "fork" });
  });

  it("act on a removal whose save failed, say it was not taken, and write it at the next round", async () => {
    const { w, first, second, desk } = await account();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    await removeListPc(first.list, desk.endpoint, noWait);
    const pc = await memoryPc(w, w.held().entries);
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    const page = servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!;
    const failing = spyOn(second.lists, "swap").mockImplementation(async () => { throw new DOMException("The disk is full", "QuotaExceededError"); });
    let taken: Awaited<ReturnType<typeof second.list.takeFromPeer>>;
    try { taken = await second.list.takeFromPeer(page, ask.read); } finally { failing.mockRestore(); }
    expect(taken).toMatchObject({ verdict: "caught_up", saved: false });
    // acted on at once
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    const stale = await readSave(String(await second.lists.get("copy", w.account)));
    expect(stale.read && shownPcs(stale.copy).length).toBe(1);
    // the next round writes it first, though the account service still withholds it
    w.clock.now += 30_000;
    await second.list.sync();
    const saved = await readSave(String(await second.lists.get("copy", w.account)));
    expect(saved.read && shownPcs(saved.copy).length).toBe(0);
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
  });
});

/** Another tab of the same browser: its own page of the list over the same stores and the same sign-in. */
function otherTab(w: World, of: WorldDevice): AccountList {
  return accountList({
    service: of.service, accountStore: of.store, listStore: of.lists, lock: memoryListLock(), now: () => w.clock.now,
    names: () => ({ label: "Other tab", os: "ios" }), linkedPcs: async () => 0, genesis: () => "first-device", durable: async () => true,
  });
}

const failingSaves = (of: WorldDevice) => spyOn(of.lists, "swap").mockImplementation(async () => { throw new DOMException("The disk is full", "QuotaExceededError"); });

describe("what a PC's page leaves in this page, and in the other tabs", () => {
  it("keeps a removal it could not save over a shorter copy another tab saved since, and writes it", async () => {
    const { w, first, second, desk } = await account();
    const held = w.held().head.seq;
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: held });
    await addListPc(w, first, "Laptop");
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const pc = await memoryPc(w, w.held().entries);
    const tab = otherTab(w, second);
    await tab.sync();
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    const failing = failingSaves(second);
    try {
      expect(await second.list.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!, ask.read)).toMatchObject({ saved: false });
    } finally { failing.mockRestore(); }
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    // the other tab is handed the first of those entries alone, and saves it
    expect((await tab.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: held }, 1)!, null))?.saved).toBe(true);
    // and the account service shows this device that shorter copy
    w.fake.untamperList(w.held().id);
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: held + 1 });
    w.clock.now += 30_000;
    await second.list.sync();
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    const saved = await readSave(String(await second.lists.get("copy", w.account)));
    expect(saved.read && shownPcs(saved.copy).map((row) => row.endpoint)).not.toContain(desk.endpoint);
  });

  it("keeps a removal it could not save over a copy another tab saved since with an entry no member signed at that place", async () => {
    const { w, first, second, desk } = await account();
    const { id, head } = w.held();
    // the account service shows the other tab an entry of a key that is no member where the removal stands
    const stranger = await w.device({ label: "nobody", register: false });
    const keys = await stranger.keys();
    // as many as the removal's entries: the copy that tab saves reaches as far as the one this tab verified
    const loose: string[] = [];
    for (let at = head; loose.length < 2;) {
      const text = entryToText(await signEntry(kindBody({ issued_at: seconds(w), list: id, prev: at.hash, seq: at.seq + 1, signer: keys.key }, { kind: "remove", ends: (await first.keys()).key }), keys.signs));
      loose.push(text);
      at = { seq: at.seq + 1, hash: hashOf(text) };
    }
    w.fake.tamperList(id, { reader: { token: second.session.access_token }, withholdAfter: head.seq });
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    expect(w.held().head.seq).toBe(head.seq + loose.length);
    const pc = await memoryPc(w, w.held().entries);
    const tab = otherTab(w, second);
    await tab.sync();
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    const failing = failingSaves(second);
    try {
      expect(await second.list.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!, ask.read)).toMatchObject({ saved: false });
    } finally { failing.mockRestore(); }
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    // the other tab reads the account service again and saves the loose entry above the footing
    w.fake.untamperList(id);
    w.fake.tamperList(id, { reader: { token: second.session.access_token }, withholdAfter: head.seq, inject: loose });
    w.clock.now += 30_000;
    await tab.sync({ read: true });
    const other = await readSave(String(await second.lists.get("copy", w.account)));
    expect(other.read && other.copy.entries.slice(head.seq + 1)).toEqual(loose);
    w.clock.now += 30_000;
    await second.list.sync();
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    const saved = await readSave(String(await second.lists.get("copy", w.account)));
    expect(saved.read && shownPcs(saved.copy).map((row) => row.endpoint)).not.toContain(desk.endpoint);
  });

  it("keeps an alarm it could not save over an ordinary save another tab made since", async () => {
    const { w, first, second } = await account();
    const fork = await otherHistory(w, first);
    await addListPc(w, second, "Laptop");
    await first.list.sync();
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const failing = failingSaves(first);
    try {
      expect((await gossipWithPc(pc.fetch, first.list, null, always, handing)).end).toBe("alarm");
    } finally { failing.mockRestore(); }
    expect(first.list.view().status).toMatchObject({ trouble: "fork" });
    // another tab saves what the account service shows next: a copy with no alarm
    const tab = otherTab(w, first);
    await addListPc(w, second, "Desk 2");
    await tab.sync();
    w.clock.now += 30_000;
    await first.list.sync();
    expect(first.list.view().status).toMatchObject({ trouble: "fork" });
    expect(first.list.writer()).toBeNull();
    const saved = await readSave(String(await first.lists.get("copy", w.account)));
    expect(saved.read && saved.copy.alarm).toMatchObject({ code: "fork", source: "peer" });
  });

  it("installs a PC's page only for the sign-in it was begun under", async () => {
    const { w, first, second, desk } = await account();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    await removeListPc(first.list, desk.endpoint, noWait);
    const pc = await memoryPc(w, w.held().entries);
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    const swap = second.lists.swap.bind(second.lists);
    // while the page is being saved, another tab signs this browser in to an account with no list, and this page reads it
    const hook = spyOn(second.lists, "swap").mockImplementation(async (...args: Parameters<typeof swap>) => {
      hook.mockRestore();
      await second.store.set("session", { ...second.session, account: "acct_lone", access_token: w.fake.issueToken("acct_lone"), refresh_token: "refresh-another", sign_in_id: "another" });
      expect((await second.list.sync()).account).not.toBe(w.account);
      return swap(...args);
    });
    expect(await second.list.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!, ask.read)).toBeNull();
    // nothing of the first account is shown or said to a PC under the second
    expect(second.list.view().account).not.toBe(w.account);
    expect(second.list.gossip()).toBeNull();
  });

  it("ends every writer handed out before an alarm: an Allow that waited for its claim signs and sends nothing", async () => {
    const { w, first } = await account();
    const fork = await otherHistory(w, first);
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const newcomer = await w.device({ label: "Dana's laptop" });
    await newcomer.list.sync();
    const claims = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    first.wire.answer = async (request) => {
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/claims")) { asked.resolve(); await claims.promise; }
      return null;
    };
    const allow = allowDevice(first.list, { key: (await newcomer.keys()).key, label: "Dana's laptop", os: "macos" }, noWait);
    await asked.promise;
    // the alarm rises while the Allow waits for the account service's claims
    expect((await gossipWithPc(pc.fetch, first.list, null, always, handing)).end).toBe("alarm");
    const placed = first.sent.filter((each) => each.route.endsWith("/entries")).length;
    claims.resolve();
    expect(await allow).toMatchObject({ allowed: false });
    expect(first.sent.filter((each) => each.route.endsWith("/entries")).length).toBe(placed);
    expect(await first.list.waiting()).toBeNull();
  });
});

describe("what one exchange hands over, and what it reads of the PC", () => {
  it("goes on handing a PC that asks for the next place after a page it took in part, within the call budget", async () => {
    const { w, first, second, desk } = await account();
    const pc = await memoryPc(w, w.held().entries, { takeAtMost: 1 });
    // three entries the PC does not hold: a laptop, then the tablet's removal, then the desk's
    await addListPc(w, first, "Laptop");
    await removeDevice(first, (await second.keys()).key);
    await removeListPc(first.list, desk.endpoint, noWait);
    const result = await gossipWithPc(pc.fetch, first.list, null, always, handing);
    expect(result.end).toBe("done");
    // a page at a time, each asked for by the PC: it stands where the device does
    expect(gossipHead(pc.copy())).toEqual(first.list.gossip()!);
    expect(admitsSession(pc.copy(), (await second.keys()).key, seconds(w)).why).toBe("removed");
  });

  it("carries a hand-over the budget cut to the next exchange, from the place the PC asked for", async () => {
    const { w, first, second, desk } = await account();
    const pc = await memoryPc(w, w.held().entries, { takeAtMost: 1 });
    await removeDevice(first, (await second.keys()).key);
    await removeListPc(first.list, desk.endpoint, noWait);
    let left = 2;
    const cut = await gossipWithPc(pc.fetch, first.list, null, () => left-- > 0, handing);
    expect(cut.end).toBe("spent");
    expect(cut.carry?.asks).not.toBeNull();
    const rest = await gossipWithPc(pc.fetch, first.list, cut.carry, always, handing);
    expect(rest.end).toBe("done");
    expect(gossipHead(pc.copy())).toEqual(first.list.gossip()!);
    // what was handed in the second exchange began where the PC asked: no page went twice
    const pages = pc.calls.filter((call) => call.path === "/api/account/list/page").map((call) => call.body.after);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("reads at most 512 KiB of one answer, and gives an answer 10 s", async () => {
    const { first } = await account();
    let pulled = 0;
    const flood: PcFetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { const chunk = new Uint8Array(64 * 1024).fill(0x20); pulled += chunk.byteLength; controller.enqueue(chunk); },
    }), { status: 200, headers: { "content-type": "application/json" } });
    expect((await gossipWithPc(flood, first.list, null, always, handing)).end).toBe("unreached");
    expect(pulled).toBeLessThanOrEqual(512 * 1024 + 128 * 1024);
    // an error body is held to the same bound
    pulled = 0;
    const failing: PcFetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { const chunk = new Uint8Array(64 * 1024).fill(0x20); pulled += chunk.byteLength; controller.enqueue(chunk); },
    }), { status: 500 });
    expect((await gossipWithPc(failing, first.list, null, always, handing)).end).toBe("unreached");
    expect(pulled).toBeLessThanOrEqual(512 * 1024 + 128 * 1024);
    // an answer that never ends ends the exchange at its deadline
    const silent: PcFetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    const began = performance.now();
    expect((await gossipWithPc(silent, first.list, null, always, { limits: { ms: 50 }, hands: true })).end).toBe("unreached");
    expect(performance.now() - began).toBeLessThan(5_000);
  });
});

describe("the account, list and member key a session was compared for", () => {
  it("tells the PC nothing while the page's list stands for another member key of that list, and goes on once it is back", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    let key = (await first.keys()).key;
    // the page's list as it is, but for the member key this device stands for (one that left and came back has another)
    const page: AccountList = new Proxy(first.list, { get: (target, name, receiver) => name !== "view" ? Reflect.get(target, name, receiver)
      : () => { const view = target.view(); return { ...view, devices: view.devices.map((row) => row.self ? { ...row, key } : row) }; } });
    const timers: (() => void)[] = [];
    const stop = keepListGossip(sessionOf(pc), { list: () => page, pc: knownPc(first.list), setTimer: (run) => { timers.push(run); return run; }, clearTimer: (timer) => { const at = timers.indexOf(timer as () => void); if (at >= 0) timers.splice(at, 1); } });
    try {
      await until(() => pc.calls.length === 1 && timers.length > 0);
      key = "another key";
      timers.shift()!();
      await until(() => timers.length > 0);
      expect(pc.calls.length).toBe(1);
      key = (await first.keys()).key;
      timers.shift()!();
      await until(() => pc.calls.length === 2);
    } finally { stop(); }
  });
});

describe("an exchange the page's list, the keeper or the carrier left behind", () => {
  it("takes nothing of an answer that came once the page's list stood for another account", async () => {
    const { w, first, second, desk } = await account();
    const pc = await aheadOf(w, first, second, desk.endpoint);
    const { page, other } = pageOf(second.list);
    // another tab signs this browser in to another account while the PC's answer is on its way
    const fetch: PcFetch = async (path, init) => { other.on = true; return pc.fetch(path, init); };
    expect((await gossipWithPc(fetch, page, null, always, handing)).end).toBe("stopped");
    expect([other.took, pc.calls.length]).toEqual([0, 1]);
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
  });

  it("hands nothing more once the page's list stood for another account during a hand-over", async () => {
    const { w, first, second, desk } = await account();
    const pc = await memoryPc(w, w.held().entries, { takeAtMost: 1 });
    await addListPc(w, first, "Laptop");
    await removeDevice(first, (await second.keys()).key);
    await removeListPc(first.list, desk.endpoint, noWait);
    const { page, other } = pageOf(first.list);
    const fetch: PcFetch = async (path, init) => { const answer = await pc.fetch(path, init); if (path === "/api/account/list/page") other.on = true; return answer; };
    expect((await gossipWithPc(fetch, page, null, always, handing)).end).toBe("stopped");
    expect(pc.calls.map((call) => call.path)).toEqual(["/api/account/list/head", "/api/account/list/page"]);
  });

  it("keeps a fork search a 429 cut, and goes on with it after the wait", async () => {
    const { w, first, second } = await account();
    const fork = await otherHistory(w, first);
    await addListPc(w, second, "Laptop");
    await first.list.sync();
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    let calls = 0;
    const limited: PcFetch = async (path, init) => (calls += 1) === 2 ? json({ error: { code: "rate_limited" } }, 429, { "retry-after": "5" }) : pc.fetch(path, init);
    const cut = await gossipWithPc(limited, first.list, null, always, handing);
    expect([cut.end, cut.retryAfterMs]).toEqual(["limited", 5_000]);
    expect(cut.carry).not.toBeNull();
    // what the cut exchange had narrowed is where the next one begins
    const before = pc.calls.length;
    expect((await gossipWithPc(pc.fetch, first.list, cut.carry, always, handing)).end).toBe("alarm");
    // its first call is the page the PC asked for, or the device's own read with the place it got to
    const resumed = pc.calls[before]!;
    expect(resumed.path === "/api/account/list/page" || "asks" in resumed.body).toBe(true);
  });

  it("keeps the place a PC asked for when a 429 cut the hand-over", async () => {
    const { w, first, second, desk } = await account();
    const pc = await memoryPc(w, w.held().entries, { takeAtMost: 1 });
    await removeDevice(first, (await second.keys()).key);
    await removeListPc(first.list, desk.endpoint, noWait);
    let pages = 0;
    const limited: PcFetch = async (path, init) => path === "/api/account/list/page" && (pages += 1) === 2 ? json({ error: { code: "rate_limited" } }, 429, { "retry-after": "5" }) : pc.fetch(path, init);
    const cut = await gossipWithPc(limited, first.list, null, always, handing);
    expect(cut.end).toBe("limited");
    expect(cut.carry?.asks).not.toBeNull();
    const before = pc.calls.length;
    expect((await gossipWithPc(pc.fetch, first.list, cut.carry, always, handing)).end).toBe("done");
    expect(gossipHead(pc.copy())).toEqual(first.list.gossip()!);
    // the second exchange began with the page the PC asked for, before it said anything else
    expect(pc.calls[before]).toMatchObject({ path: "/api/account/list/page", body: { after: cut.carry!.asks!.after } });
  });

  it("goes by its own record of the minute while the browser's storage takes no write", () => {
    let clock = 5_000_000;
    // storage that still reads an earlier record, and writes nothing
    const earlier = JSON.stringify({ calls: [], until: 0, pause: 0 });
    const storage = { getItem: () => earlier, setItem: () => { throw new DOMException("The disk is full", "QuotaExceededError"); } };
    const budget = gossipBudget(`full:${Math.random()}`, { perMinute: 2, storage, now: () => clock });
    expect([budget.spend(), budget.spend(), budget.spend()]).toEqual([true, true, false]);
    clock += 61_000;
    budget.pause(30_000);
    expect(budget.wait()).toBe(30_000);
    expect(budget.spend()).toBe(false);
  });

  it("hands a PC that is out nothing when the page's list stood for another account by the time the carrier came back", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const session = sessionOf(pc);
    session.up(false);
    const { page, other } = pageOf(first.list);
    const delivered = deliverOnce(session, page, gossipBudget(`out:${Math.random()}`, { storage: null }), 3_000, knownPc(first.list));
    other.on = true;
    session.up(true);
    await delivered;
    expect(pc.calls).toEqual([]);
  });

  it("stops an exchange in flight when the keeper stops: its call is called off, and a late answer is neither taken nor followed", async () => {
    const { w, first, second, desk } = await account();
    const pc = await aheadOf(w, first, second, desk.endpoint);
    const held = Promise.withResolvers<void>();
    let signal: AbortSignal | null | undefined;
    const session = sessionOf({ followsList: true, fetch: async (path, init) => { signal = init?.signal; await held.promise; return pc.fetch(path, init); } });
    const { page, other } = pageOf(second.list);
    const stop = keepListGossip(session, { list: () => page, pc: knownPc(second.list) });
    await until(() => signal !== undefined);
    stop();
    expect(signal?.aborted).toBe(true);
    held.resolve();
    await until(() => pc.calls.length === 1);
    await settle();
    expect([other.took, pc.calls.length]).toEqual([0, 1]);
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
  });

  it("drops what an exchange of an earlier carrier found: a stale 'another list' does not end the new carrier's exchanges", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const held = Promise.withResolvers<void>();
    let stale = 0;
    const session = sessionOf({ followsList: true, fetch: async (path, init) => {
      if (stale > 0) return pc.fetch(path, init);
      stale += 1;
      await held.promise;
      return json({ list: "6d".repeat(32), place: null });
    } });
    const stop = keepListGossip(session, { list: () => first.list, pc: knownPc(first.list) });
    try {
      await until(() => stale === 1);
      session.up(false);
      session.up(true);
      held.resolve();
      // the new carrier's exchange goes on, whatever the earlier one was told
      await until(() => pc.calls.length === 1);
    } finally { stop(); }
  });

  it("reads its own alarm again after it read the saved copy: one raised meanwhile and not saved ends the write", async () => {
    const { w, first, second } = await account();
    const fork = await otherHistory(w, first);
    await addListPc(w, second, "Laptop");
    await first.list.sync();
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const writer = first.list.writer()!;
    const get = first.lists.get.bind(first.lists);
    const gate = Promise.withResolvers<void>();
    let gated = false;
    const hold = spyOn(first.lists, "get").mockImplementation(async (...args: Parameters<typeof get>) => {
      if (!gated && args[0] === "copy") { gated = true; await gate.promise; }
      return get(...args);
    });
    const failing = failingSaves(first);
    try {
      const live = writer.live();
      await until(() => gated);
      expect((await gossipWithPc(pc.fetch, first.list, null, always, handing)).end).toBe("alarm");
      gate.resolve();
      expect(await live).toBe(false);
    } finally { hold.mockRestore(); failing.mockRestore(); }
  });
});

describe("an entry no member signed above a PC's footing", () => {
  it("keeps no removal from the PC: the list gossip and the approver's hand-over (join.ts) both hand from its footing", async () => {
    for (const how of ["gossip", "hand-over"] as const) {
      const { w, first, second } = await account();
      const pc = await memoryPc(w, w.held().entries);
      // the service shows the PC an entry of a key that is no member, right after where it stands
      const stranger = await w.device({ label: "nobody", register: false });
      const keys = await stranger.keys();
      const { id, head } = w.held();
      const loose = entryToText(await signEntry(kindBody({ issued_at: seconds(w), list: id, prev: head.hash, seq: head.seq + 1, signer: keys.key }, { kind: "remove", ends: (await second.keys()).key }), keys.signs));
      await pc.read([loose]);
      expect(gossipHead(pc.copy()).place).toEqual(head);
      // the device's own removal stands at the very place of the loose entry
      await removeDevice(first, (await second.keys()).key);
      const reached = how === "gossip" ? (await gossipWithPc(pc.fetch, first.list, null, always, handing)).end === "done" : await handListToPc(pc.fetch, first.list);
      expect([how, reached]).toEqual([how, true]);
      expect(admitsSession(pc.copy(), (await second.keys()).key, seconds(w)).why).toBe("removed");
    }
  });
});

describe("a session keeps the list compared", () => {
  it("asks nothing of a PC that follows no list, and nothing at all for an account with no list", async () => {
    const { w, first } = await account();
    const unpinned = await memoryPc(w, w.held().entries, { followsList: false });
    // an exchange makes its first call before keepListGossip returns, and a trigger before the call that moved the head returns: none was made
    const stop = keepListGossip(sessionOf(unpinned), { list: () => first.list });
    stop();
    expect(unpinned.calls).toEqual([]);
    // a device of an account with no list holds none: no request, whatever the PC says it follows
    const lone = listWorld("acct_lone");
    const device = await lone.device({ genesis: "never" });
    await device.list.sync();
    expect(device.list.gossip()).toBeNull();
    const pinned = await memoryPc(w, w.held().entries);
    const other = keepListGossip(sessionOf(pinned), { list: () => device.list });
    const none = keepListGossip(sessionOf(pinned), { list: () => null });
    other();
    none();
    expect(pinned.calls).toEqual([]);
  });

  it("says where it stands at once, hands a removal it places at once, and says it again on the next carrier", async () => {
    const { w, first, second, desk } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const session = sessionOf(pc);
    const stop = keepListGossip(session, { list: () => first.list, pc: knownPc(first.list) });
    try {
      await until(() => pc.calls.length === 1);
      const removed = (await second.keys()).key;
      await removeDevice(first, removed);
      // the copy moved its head: the PC is handed the removal without waiting for anything else
      await until(() => admitsSession(pc.copy(), removed, seconds(w)).why === "removed");
      const made = pc.calls.length;
      session.up(false);
      session.up(true);
      await until(() => pc.calls.length > made);
      expect(pc.calls.at(-1)!.path).toBe("/api/account/list/head");
    } finally { stop(); }
    // stopped: a head that moves after it asks nothing
    const made = pc.calls.length;
    await removeListPc(first.list, desk.endpoint, noWait);
    expect(pc.calls.length).toBe(made);
  });

  it("waits as long as the PC says after a 429, and makes no more calls a minute than the PC takes", async () => {
    const { w, first, second } = await account();
    const pc = await memoryPc(w, w.held().entries);
    let clock = 0;
    const timers: { run: () => void; at: number }[] = [];
    const options = {
      list: () => first.list, pc: knownPc(first.list), mono: () => clock,
      setTimer: (run: () => void, ms: number) => { const timer = { run, at: clock + ms }; timers.push(timer); return timer; },
      clearTimer: (timer: unknown) => { timers.splice(timers.indexOf(timer as never), 1); },
    };
    pc.limit = 60;
    const stop = keepListGossip(sessionOf(pc), options);
    try {
      await until(() => pc.calls.length === 1);
      await until(() => timers.length === 1);
      expect(timers[0]!.at).toBe(60_000);
      // nothing is asked before then, however the copy moves
      await removeDevice(first, (await second.keys()).key);
      expect(pc.calls.length).toBe(1);
      pc.limit = null;
      clock = 60_000;
      timers.shift()!.run();
      await until(() => pc.calls.length >= 3);
      expect(pc.calls.slice(1).map((call) => call.path)).toEqual(["/api/account/list/head", "/api/account/list/page"]);
      await until(() => timers.length === 1);
      expect(timers[0]!.at).toBe(60_000 + GOSSIP_SECONDS * 1000);
    } finally { stop(); }
    // one exchange spends no more than the minute's calls, and says where its read got to
    let spent = 0;
    const result = await gossipWithPc(pc.fetch, first.list, null, () => ++spent <= 0, handing);
    expect([result.end, spent]).toEqual(["spent", 1]);
    expect(GOSSIP_CALLS_PER_MINUTE).toBeLessThan(30);
  });

  it("gives a new carrier no new minute of calls: the PC counts them by the device's key, whatever its sessions", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    let clock = 0;
    const timers: { run: () => void; at: number }[] = [];
    const session = sessionOf(pc);
    const stop = keepListGossip(session, {
      list: () => first.list, pc: knownPc(first.list), mono: () => clock, callsPerMinute: 1,
      setTimer: (run: () => void, ms: number) => { const timer = { run, at: clock + ms }; timers.push(timer); return timer; },
      clearTimer: (timer: unknown) => { timers.splice(timers.indexOf(timer as never), 1); },
    });
    try {
      await until(() => pc.calls.length === 1 && timers.length === 1);
      // the carrier drops and comes back within the minute: nothing is asked until that minute is over
      clock = 10_000;
      session.up(false);
      session.up(true);
      await until(() => timers.length === 1 && timers[0]!.at === 60_000);
      expect(pc.calls.length).toBe(1);
      clock = 60_000;
      timers.shift()!.run();
      await until(() => pc.calls.length === 2);
    } finally { stop(); }
  });

  it("shares the minute's calls and a 429's wait among the tabs and reopenings that sign in to one PC with one key", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    let clock = 1_000_000;
    const timers: { run: () => void; at: number }[] = [];
    const keep = (budgetKey: string) => keepListGossip(sessionOf(pc), {
      list: () => first.list, pc: knownPc(first.list), mono: () => clock, budget: gossipBudget(budgetKey, { perMinute: 1, storage, now: () => clock }),
      setTimer: (run: () => void, ms: number) => { const timer = { run, at: clock + ms }; timers.push(timer); return timer; },
      clearTimer: (timer: unknown) => { timers.splice(timers.indexOf(timer as never), 1); },
    });
    const one = keep("desk:key-a");
    await until(() => pc.calls.length === 1);
    // another tab, or the same PC opened again, with the same key: the minute's one call is spent
    const two = keep("desk:key-a");
    expect(pc.calls.length).toBe(1);
    // another key of another PC has a minute of its own
    const other = keep("laptop:key-b");
    await until(() => pc.calls.length === 2);
    one(); two(); other();
    // a 429 the PC sent one keeper holds the next one back as long as it said
    clock += 120_000;
    pc.limit = 600;
    const three = keep("desk:key-a");
    await until(() => pc.calls.length === 3);
    await until(() => timers.length > 0);
    three();
    pc.limit = null;
    clock += 61_000;
    const four = keep("desk:key-a");
    expect(pc.calls.length).toBe(3);
    four();
  });

  it("arms a long wait in pieces, so no timer is set past what a browser can hold", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    pc.limit = 30 * 24 * 3600;
    let clock = 0;
    const armed: number[] = [];
    const stop = keepListGossip(sessionOf(pc), { list: () => first.list, mono: () => clock, setTimer: (_run: () => void, ms: number) => { armed.push(ms); return armed.length; }, clearTimer: () => {} });
    try {
      await until(() => armed.length > 0);
      expect(Math.max(...armed)).toBeLessThanOrEqual(GOSSIP_SECONDS * 1000);
    } finally { stop(); }
  });

  it("goes on with a read the minute's calls cut, from where it got to, while the device stands where it stood", async () => {
    const { w, first } = await account();
    const fork = await otherHistory(w, first);
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    let left = 2;
    const cut = await gossipWithPc(pc.fetch, first.list, null, () => left-- > 0, handing);
    expect(cut.end).toBe("spent");
    expect(cut.carry).not.toBeNull();
    const done = await gossipWithPc(pc.fetch, first.list, cut.carry, always, handing);
    expect(done.end).toBe("alarm");
    expect(first.list.view().status).toMatchObject({ trouble: "fork" });
  });
});

describe("a device its account's move onto the list carried in", () => {
  it("takes a PC's page into its copy, still pinned to its sign-in key before its hand-over is placed, and keeps that copy", async () => {
    const { laptop, phone, world, pc: carried } = await moved();
    // the account service takes no entry from the laptop: its hand-over to its member key waits
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "try_again" } }, { status: 409 }) : null;
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    const before = await readSave(String(await laptop.device.lists.get("copy", world.account)));
    expect(before.read && before.copy.me.key).toBe(laptop.signIn);
    expect(laptop.device.list.holdsPc(carried.endpoint)).toBe(true);
    // the phone puts the PC the move carried in out, and a PC that holds that removal hands it over
    expect(await removeListPc(phone.device.list, carried.endpoint, noWait)).toEqual({ removed: true });
    const pc = await memoryPc(world, world.held().entries);
    const ask = laptop.device.list.compare(gossipHead(pc.copy()))!;
    expect(ask.read).not.toBeNull();
    const took = await laptop.device.list.takeFromPeer(servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!, ask.read);
    expect(took).toMatchObject({ saved: true });
    expect(laptop.device.list.holdsPc(carried.endpoint)).toBe(false);
    const after = await readSave(String(await laptop.device.lists.get("copy", world.account)));
    expect(after.read && [after.copy.me.key, shownPcs(after.copy).map((row) => row.endpoint).includes(carried.endpoint)]).toEqual([laptop.signIn, false]);
  });
});
