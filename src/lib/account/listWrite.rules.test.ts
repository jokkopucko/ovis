/**
 * The rules every change to the list goes by, kept in the one write loop (listWrite.ts) so that no caller can leave
 * one out: a request this call did not sign is never its result, a write is bound to the account, the list and the
 * member key it began with, a clock far under its floor puts nobody out, and a card acts on the request it shows.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listClock, pcRemoval, signListEntry, type ListKind } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { addListPc, listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import type { ListClaim } from "./listAnswers.ts";
import { deviceListKeys } from "./listKeys.ts";
import { removeListPc } from "./listRemove.ts";
import { WRITE_ENTRIES_MAX, resendWaiting, signedNamed, signedOn, writeNamed, writeScope, writeToList } from "./listWrite.ts";
import { memoryAccountStore } from "./store.ts";

const noWait = { wait: async () => {} };
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));
const entriesSent = (from: WorldDevice): string[][] => placements(from).map((each) => each.body!.entries as string[]);
const kindsOf = (entries: readonly string[]): string[] => entries.map((text) => String(readBody(entryFromText(text).body).kind));

/** A device in its list with a PC in it, and a second device that signed in and claimed its key. */
async function world() {
  const w = listWorld();
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const pc = await addListPc(w, first, "Desk");
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const newcomer = { key: (await second.keys()).key, label: "Dana's tablet", os: "android" as const };
  return { w, first, second, pc, newcomer };
}

/** An invite in the list, signed by `from`: `auto` holds a key of the epoch, a plain one holds none. */
async function placeInvite(w: ReturnType<typeof listWorld>, from: WorldDevice, auto: boolean, seconds = 840): Promise<string> {
  const keys = await from.keys();
  const invite = await deviceListKeys(memoryAccountStore());
  const at = Math.floor(w.clock.now / 1000);
  const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + seconds, uses: 1, auto, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
  await from.service.placeEntries(w.held().id, [placed.text], []);
  // The account service holds five open invites at a time. Its own invite of this one is revoked here, which leaves the
  // list's entry as it is: a test may so hold more open invites in the list than the service lets a person make.
  const auth = { authorization: `Bearer ${from.session.access_token}` };
  const open = await (await w.fake.fetch(`${w.origin}/v1/pc-invites`, { headers: auth })).json() as { invites?: { id: string }[] };
  for (const { id } of open.invites ?? []) expect((await w.fake.fetch(`${w.origin}/v1/pc-invites/${id}`, { method: "DELETE", headers: auth })).status).toBe(204);
  return invite.key;
}

describe("a request another page kept for the same head (C1)", () => {
  it("is never this change's result: a Remove that lost the place to an Allow sends nothing, removes nothing and says that the earlier change waits", async () => {
    const { w, first, pc, newcomer } = await world();
    let raced = false;
    const outcome = await writeToList(first.list, async (writer) => {
      if (!raced) {
        raced = true;
        // another page of this device signs an Allow on this very head and keeps it, between this page's look and its own keep
        w.fake.tamperList(w.held().id, { headMoved: true });
        expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
        w.fake.untamperList(w.held().id);
      }
      return { request: await signedOn(writer, pcRemoval(writer.state, pc.endpoint)) };
    }, { ...noWait, operation: `remove-pc:${pc.endpoint}` });
    expect(outcome).toEqual({ written: false, why: "waiting", retryAfterMs: null });
    // the Allow's request was not sent by the Remove, and the PC is still in the list
    expect(kindsOf(w.held().entries)).toEqual(["genesis", "pc"]);
    expect((await first.list.sync()).pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    expect(await first.list.waiting()).toMatchObject({ for: `allow:${newcomer.key}` });
  });

  it("is sent in place of this page's own where it is for the same change, and that change is then read from the list: one signature per place", async () => {
    const { w, first, newcomer } = await world();
    let raced = false;
    let other: string[] = [];
    const before = placements(first).length;
    // the same Allow, pressed on two pages at once
    const outcome = await writeNamed<ListClaim>(first.list, async (writer) => {
      if (!raced) {
        raced = true;
        w.fake.tamperList(w.held().id, { headMoved: true });
        await allowDevice(first.list, newcomer, noWait);
        w.fake.untamperList(w.held().id);
        other = entriesSent(first).at(-1)!;
      }
      const row = writer.state.signers[newcomer.key];
      if (row !== undefined) return { done: first.list.placeAt(row.seq)! };
      return { go: (await writer.service.listClaims(writer.list)).find((each) => each.key === newcomer.key)! };
    }, (writer, claim) => signedNamed(writer, null, claim.enc, (sealed): ListKind => ({ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed, rotates: false })),
    { ...noWait, operation: `allow:${newcomer.key}` });
    expect(outcome).toMatchObject({ written: true });
    // only the request that was kept first ever went out after the race, and it is the entry the list holds
    expect(entriesSent(first).slice(before).every((entries) => entries[0] === other[0])).toBe(true);
    expect(w.held().entries.at(-1)).toBe(other[0]!);
  });
});

describe("the account, the list and the member key a write began with (C2)", () => {
  it("are all three held against the writer: another member key ends the write with nothing signed", async () => {
    const { first, pc } = await world();
    const scope = writeScope(first.list)!;
    expect(scope).toEqual({ account: first.session.account, list: first.list.writer()!.list, key: (await first.keys()).key });
    const before = placements(first).length;
    const stranger = (await deviceListKeys(memoryAccountStore())).key;
    expect(await removeListPc(first.list, pc.endpoint, { ...noWait, expect: { ...scope, key: stranger } })).toEqual({ removed: false, why: "changed", retryAfterMs: null });
    expect(placements(first).length).toBe(before);
    expect(await removeListPc(first.list, pc.endpoint, { ...noWait, expect: scope })).toEqual({ removed: true });
  });

  it("are bound at the first read where the caller named an account alone, and a later try under another key signs nothing", async () => {
    const { w, first, pc } = await world();
    const other = await deviceListKeys(memoryAccountStore());
    let tries = 0;
    const outcome = await writeToList(first.list, async (writer) => {
      tries += 1;
      // the head moves under the first try, so the loop reads and comes back with a writer
      await placeInvite(w, first, false);
      return { request: await signedOn(writer, pcRemoval(writer.state, pc.endpoint)) };
    }, { ...noWait, expect: { account: first.session.account }, writer: () => { const own = first.list.writer(); return own === null || tries === 0 ? own : { ...own, keys: { ...own.keys, key: other.key } }; } });
    expect([tries, outcome]).toEqual([1, { written: false, why: "changed", retryAfterMs: null }]);
  });

  it("an Allow keeps what it bound for every Try again: the same holder, another member key, nothing signed", async () => {
    const { first, newcomer } = await world();
    const scope: { account: string; list?: string; key?: string } = { account: first.session.account };
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_stopped", message: "x" } }, { status: 503 }) : null;
    expect(await allowDevice(first.list, newcomer, { ...noWait, scope })).toMatchObject({ allowed: false, why: "stopped" });
    expect(scope).toEqual({ account: first.session.account, list: first.list.writer()!.list, key: (await first.keys()).key });
    first.wire.answer = null;
    const stranger = (await deviceListKeys(memoryAccountStore())).key;
    expect(await allowDevice(first.list, newcomer, { ...noWait, scope: { ...scope, key: stranger } })).toMatchObject({ allowed: false, why: "changed" });
    expect(await allowDevice(first.list, newcomer, { ...noWait, scope })).toMatchObject({ allowed: true });
  });
});

describe("a device whose clock reads far under the time it saved (C3)", () => {
  /** The first device let a borrowed browser in for an hour; another page of it saw a time three days on, and its clock now reads five minutes past that hour. */
  async function adrift() {
    const { w, first, pc, newcomer } = await world();
    const browser = await w.device({ label: "A borrowed browser" });
    await browser.list.sync();
    const borrowed = (await browser.keys()).key;
    const writer = first.list.writer()!;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === borrowed)!;
    const written = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: writer.issued_at + 3600, enc: claim.enc, card: claim.card, sealed: null, rotates: false }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [written.text], []);
    // and a plain invite, which a PC joined with: its time is over by then too
    const plain = await placeInvite(w, first, false);
    await first.lists.set("times", first.session.account, { v: 1, list: writer.list, read_at: writer.issued_at + 3 * 86_400, seen_at: writer.issued_at + 3 * 86_400 });
    // the clock reads five minutes past the browser's hour: the real time may be before it
    w.clock.now += 65 * 60_000;
    await first.list.sync();
    expect(first.list.writer()!.adrift).toBe(true);
    return { w, first, pc, newcomer, borrowed, plain };
  }

  it("removes a PC and puts nobody else out for a time that is over", async () => {
    const { w, first, pc, borrowed } = await adrift();
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: true });
    expect(w.held().state.signers[borrowed]).toMatchObject({ ended: null });
    expect((await first.list.sync()).pcs).toEqual([]);
  });

  it("lets a device in unnamed, as the caller asked, with what the caller asked to follow it, and no clean-up", async () => {
    const { w, first, newcomer, borrowed, plain } = await adrift();
    // the tablet signs in again: its claim is of this hour
    await w.device({ label: "Dana's tablet" }).then(async (again) => { await again.list.sync(); newcomer.key = (await again.keys()).key; });
    await first.list.sync();
    const writer = first.list.writer()!;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === newcomer.key)!;
    const signed = await signedNamed(writer, { label: "Dana's tablet", os: "android" }, claim.enc,
      (sealed): ListKind => ({ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed, rotates: false }), [{ kind: "remove", ends: plain } as ListKind]);
    expect(kindsOf(signed.entries)).toEqual(["device", "remove"]);
    expect(readBody(entryFromText(signed.entries[1]!).body).ends).toBe(plain);
    expect(w.held().state.signers[borrowed]).toMatchObject({ ended: null });
  });

  it("is the writer's own rule: nothing outside the write loop asks the kinds whose time is over", () => {
    const root = join(import.meta.dir, "..", "..");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith("test-helpers.ts"));
    const users = files.filter((file) => /\blapsedRemovals\s*\(/.test(readFileSync(join(root, file), "utf8"))).map((file) => file.replaceAll("\\", "/"));
    expect(users).toEqual(["lib/account/listWrite.ts"]);
  });

  it("has a second clock for what is shown and what a press admits: held against the floor, and it signs nothing", async () => {
    const { first } = await adrift();
    const writer = first.list.writer()!;
    const copy = (await first.lists.get("times", first.session.account)) as { seen_at: number };
    expect(writer.shown).toBe(listClock(writer.state, writer.issued_at, copy.seen_at));
    expect(writer.shown).toBeGreaterThan(writer.clock + 86_400);
    expect([writer.clock, writer.issued_at]).toEqual([listClock(writer.state, writer.issued_at, null), writer.issued_at]);
  });
});

describe("the card of a change that waits (C4)", () => {
  /** An Allow whose request stays kept and unplaced. */
  async function waiting() {
    const made = await world();
    const { w, first, newcomer } = made;
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
    w.fake.untamperList(w.held().id);
    return made;
  }

  it("names the request it is shown for: its account, list, signer, head and hash", async () => {
    const { first, newcomer } = await waiting();
    const shown = (await first.list.waiting())!;
    const writer = first.list.writer()!;
    expect(shown).toMatchObject({ account: first.session.account, list: writer.list, key: writer.keys.key, for: `allow:${newcomer.key}`, on: { seq: writer.state.footing.seq, hash: writer.state.footing.hash } });
    expect(shown.place.seq).toBe(writer.state.footing.seq + 1);
  });

  it("Try again and Cancel on an old card do nothing to the request that replaced it", async () => {
    const { w, first, pc } = await waiting();
    const old = (await first.list.waiting())!;
    // on another page: the first change is cancelled, and a Remove is signed on the same head and left waiting
    await first.list.cancel(old);
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toMatchObject({ removed: false, why: "busy" });
    w.fake.untamperList(w.held().id);
    const replaced = (await first.list.waiting())!;
    expect(replaced.for).toBe(`remove-pc:${pc.endpoint}`);
    const before = placements(first).length;
    // the old card: nothing of its own waits any more, and it neither sends nor drops the Remove
    expect(await resendWaiting(first.list, old, noWait)).toBe(true);
    await first.list.cancel(old);
    expect(placements(first).length).toBe(before);
    expect(await first.list.waiting()).toEqual(replaced);
    expect((await first.list.sync()).pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    // the Remove's own card sends it
    expect(await resendWaiting(first.list, replaced, noWait)).toBe(true);
    expect((await first.list.sync()).pcs).toEqual([]);
  });
});

describe("what a caller asks to follow a named entry in the same request (C5)", () => {
  const device = (claim: { key: string; enc: string; card: string }) => (sealed: Parameters<Parameters<typeof signedNamed>[3]>[0]): ListKind =>
    ({ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed, rotates: false });

  it("is carried by every signing branch: names under the current epoch, no key of the epoch, and a request that opens the next epoch", async () => {
    const { w, first, second, newcomer } = await world();
    // an invite that holds a key of the epoch, which runs out first, and a plain one, still open then
    const stale = await placeInvite(w, first, true, 600);
    const plain = await placeInvite(w, first, false);
    await first.list.sync();
    const then = [{ kind: "remove", ends: plain } as ListKind];
    const claimOf = async () => (await first.list.writer()!.service.listClaims(first.list.writer()!.list)).find((each) => each.key === newcomer.key)!;
    const names = { label: "Dana's tablet", os: "android" as const };
    const writer = first.list.writer()!;
    expect(kindsOf((await signedNamed(writer, names, (await claimOf()).enc, device(await claimOf()), then)).entries)).toEqual(["device", "remove"]);
    expect(kindsOf((await signedNamed({ ...writer, epochs: new Map() }, names, (await claimOf()).enc, device(await claimOf()), then)).entries)).toEqual(["device", "remove"]);
    // the first invite's time is over: the request tidies up, opens the next epoch, and still ends the plain invite
    w.clock.now += 11 * 60_000;
    await second.list.sync();
    await first.list.sync();
    const opened = await signedNamed(first.list.writer()!, names, (await claimOf()).enc, device(await claimOf()), then);
    expect(kindsOf(opened.entries)).toEqual(["remove", "epoch", "device", "remove"]);
    expect([readBody(entryFromText(opened.entries[0]!).body).ends, readBody(entryFromText(opened.entries[3]!).body).ends]).toEqual([stale, plain]);
  });

  it("has its places reserved within the sixteen: the clean-up goes out first where the whole would not fit", async () => {
    const { w, first, second, newcomer } = await world();
    // fourteen invites over their time: with the epoch, the entry and the one that follows it, seventeen
    for (let made = 0; made < 14; made += 1) await placeInvite(w, first, true, 600);
    const plain = await placeInvite(w, first, false);
    w.clock.now += 11 * 60_000;
    await second.list.sync();
    const before = placements(first).length;
    const outcome = await writeNamed(first.list, async (writer) => {
      return { go: (await writer.service.listClaims(writer.list)).find((each) => each.key === newcomer.key)! };
    }, (writer, claim) => signedNamed(writer, { label: "Dana's tablet", os: "android" }, claim.enc, device(claim), [{ kind: "remove", ends: plain } as ListKind]), { ...noWait, reserve: 1 });
    expect(outcome).toMatchObject({ written: true });
    const sent = entriesSent(first).slice(before).map(kindsOf);
    expect(sent.every((request) => request.length <= WRITE_ENTRIES_MAX)).toBe(true);
    expect(sent.at(-1)!.slice(-2)).toEqual(["device", "remove"]);
    expect(sent.flat().filter((kind) => kind === "remove")).toHaveLength(15);
  });
});

describe("a write that is called off (C6)", () => {
  it("stops before it signs, before it keeps, and before each send, and throws the abort", async () => {
    const { first, pc } = await world();
    const reason = new DOMException("called off", "AbortError");
    const sign = async (writer: Parameters<Parameters<typeof writeToList>[1]>[0]) => ({ request: await signedOn(writer, pcRemoval(writer.state, pc.endpoint)) });
    // before anything is signed
    const early = new AbortController();
    early.abort(reason);
    let signed = 0;
    expect(await writeToList(first.list, async (writer) => { signed += 1; return sign(writer); }, { ...noWait, signal: early.signal }).catch((error: unknown) => error)).toBe(reason);
    expect(signed).toBe(0);
    // signed, and called off before it is kept: nothing waits, nothing was sent
    const during = new AbortController();
    const before = placements(first).length;
    expect(await writeToList(first.list, async (writer) => { const next = await sign(writer); during.abort(reason); return next; }, { ...noWait, signal: during.signal }).catch((error: unknown) => error)).toBe(reason);
    expect([await first.list.waiting(), placements(first).length]).toEqual([null, before]);
    // kept and sent once, and called off before it is sent again
    const late = new AbortController();
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_rebuilding", message: "x" } }, { status: 503, headers: { "retry-after": "1" } }) : null;
    expect(await writeToList(first.list, sign, { wait: async () => { late.abort(reason); }, signal: late.signal }).catch((error: unknown) => error)).toBe(reason);
    expect(placements(first).length).toBe(before + 1);
  });
});

describe("Cancel on a card whose request may have been placed", () => {
  /** An Allow whose request the account service placed while its answer, and the read after it, were lost: not known yet. */
  async function unknown() {
    const made = await world();
    const { w, first, newcomer } = made;
    let lost: "not yet" | "now" | "over" = "not yet";
    first.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      if (lost === "over") return null;
      // the placement reaches the account service, and its answer does not come back; nor does any read after it
      if (request.method === "POST" && path.endsWith("/entries")) { lost = "now"; await w.fake.fetch(request); return new Response("bad gateway", { status: 502 }); }
      if (lost === "now" && request.method === "GET" && path.includes("/v2/lists/")) return new Response("bad gateway", { status: 502 });
      return null;
    };
    expect(await allowDevice(first.list, newcomer, { ...noWait, placeMs: 200 })).toMatchObject({ allowed: false, why: "unknown" });
    return { ...made, back: () => { lost = "over"; } };
  }

  it("reads the log first: a request that was placed is not called cancelled, and one whose outcome cannot be read stays", async () => {
    const { w, first, newcomer, back } = await unknown();
    const shown = (await first.list.waiting())!;
    expect(shown.for).toBe(`allow:${newcomer.key}`);
    // the log still cannot be read: nothing is let go, and the card stays
    expect(await first.list.cancel(shown)).toBe("unread");
    expect(await first.list.waiting()).toEqual(shown);
    // it reads again: the entry is there, so there was nothing to cancel
    back();
    expect(await first.list.cancel(shown)).toBe("placed");
    expect(w.held().state.signers[newcomer.key]).toMatchObject({ ended: null });
    expect(await first.list.waiting()).toBeNull();
  });

  it("lets go of a request that the log shows unplaced at an unmoved head", async () => {
    const { w, first, newcomer } = await world();
    w.fake.tamperList(w.held().id, { headMoved: true });
    await allowDevice(first.list, newcomer, noWait);
    w.fake.untamperList(w.held().id);
    const shown = (await first.list.waiting())!;
    expect(await first.list.cancel(shown)).toBe("gone");
    expect([await first.list.waiting(), w.held().state.signers[newcomer.key]]).toEqual([null, undefined]);
  });
});

describe("how long a request that waits holds another change back", () => {
  it("not at all once this device's clock reads before the time it was kept: its age cannot be told, and the log showed it unplaced", async () => {
    const { w, first, pc, newcomer } = await world();
    w.fake.tamperList(w.held().id, { headMoved: true });
    await allowDevice(first.list, newcomer, noWait);
    w.fake.untamperList(w.held().id);
    // the clock is set back an hour: by it the kept request is from the future
    w.clock.now -= 3_600_000;
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: true });
    expect(w.held().state.signers[newcomer.key]).toBeUndefined();
  });

  it("is over when the log moved, also where the account service still names the old head (M41)", async () => {
    const { w, first, second, pc, newcomer } = await world();
    w.fake.tamperList(w.held().id, { headMoved: true });
    await allowDevice(first.list, newcomer, noWait);
    w.fake.untamperList(w.held().id);
    // what the account service says of the list's head now, kept: it will go on saying it
    let stale = "";
    first.wire.answer = async (request) => {
      if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/v2/lists/mine")) return null;
      const answered = await w.fake.fetch(request);
      stale = await answered.clone().text();
      return answered;
    };
    await first.list.sync();
    expect(stale).not.toBe("");
    // another page of this device places an entry: the log moves, and the service's word on the head does not
    await placeInvite(w, first, false);
    void second;
    first.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/v2/lists/mine") ? new Response(stale, { headers: { "content-type": "application/json" } }) : null;
    // the Remove reads the log itself, finds the head moved, and is signed on it: it is not told that the Allow waits
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: true });
    expect(await first.list.waiting()).toBeNull();
  });
});

describe("a Remove by a device that holds no key of the current epoch (M62)", () => {
  it("signs the PC's removal alone: no clean-up and no epoch", async () => {
    const { w, first, pc } = await world();
    await placeInvite(w, first, true, 600);
    w.clock.now += 11 * 60_000;
    await first.list.sync();
    const before = placements(first).length;
    expect(await removeListPc(first.list, pc.endpoint, { ...noWait, writer: () => { const own = first.list.writer(); return own === null ? null : { ...own, epochs: new Map() }; } })).toEqual({ removed: true });
    expect(entriesSent(first).slice(before).map(kindsOf)).toEqual([["remove"]]);
  });
});

describe("a request that was cancelled while the write waited to send it again", () => {
  it("is not sent again: what a person cancelled is not placed after that", async () => {
    const { w, first, pc } = await world();
    const before = placements(first).length;
    // the account service asks for the request again; while this write pauses, the person cancels it on its card
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_rebuilding", message: "x" } }, { status: 503, headers: { "retry-after": "1" } }) : null;
    const outcome = await removeListPc(first.list, pc.endpoint, { wait: async () => {
      const waits = await first.list.waiting();
      if (waits !== null) expect(await first.list.cancel(waits)).toBe("gone");
      first.wire.answer = null;
    } });
    expect(outcome).toMatchObject({ removed: false, why: "busy" });
    expect(placements(first).length).toBe(before + 1);
    expect((await first.list.sync()).pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    void w;
  });
});
