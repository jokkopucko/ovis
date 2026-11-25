import { describe, expect, test } from "bun:test";
import { heldNaming, heldVouches } from "../../../shared/account-list-migrate.ts";
import type { AccountList, AccountListView } from "./accountList.ts";
import { askWitness, onPcSession, pcAnswers, waitsOnPcs } from "./listMigrate.ts";

const ACCOUNT = "acct_owner";
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5lhuexKpDRsxAK4WTOjTQTjBurzk0iGngvCpNGetUiwtppuB-SgVWvMwkHCQe6FNPoAzLJZntcFyjzv0sk82Bg";

/** A PC's session routes, as the app reaches them over its channel: what it was asked, and its answers. */
function pcWire(answers: Record<string, () => Response>) {
  const asked: { method: string; path: string; body: unknown }[] = [];
  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    asked.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return answers[`${init?.method ?? "GET"} ${path}`]?.() ?? new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  };
  return { fetch, asked };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A list in the view a test gives, with the naming it would say. */
function listOf(status: AccountListView["status"], said: Awaited<ReturnType<NonNullable<AccountList["naming"]>>> = null): Pick<AccountList, "view" | "naming" | "sync"> & { synced: number } {
  const list = {
    synced: 0,
    view: (): AccountListView => ({ account: ACCOUNT, status, reached: true, devices: [], pcs: [] }),
    naming: async () => said,
    sync: async () => { list.synced += 1; return list.view(); },
  };
  return list;
}

describe("what a PC answers a device of its account", () => {
  test("its answer, read for its form", async () => {
    const wire = pcWire({ "GET /api/account/list/witness": json({ account: ACCOUNT, pinned: null, admits: [{ key: KEY, wall: 9, ran: 3, idle: null }], removed: [] }) });
    expect(await askWitness(wire.fetch)).toEqual({ account: ACCOUNT, pinned: null, admits: [{ key: KEY, wall: 9, ran: 3, idle: null }], removed: [] });
  });

  test("a PC from before this release, or in no account, answers nothing a device counts", async () => {
    expect(await askWitness(pcWire({}).fetch)).toBeNull();
    expect(await askWitness(pcWire({ "GET /api/account/list/witness": json({ error: { code: "not_in_account" } }, 409) }).fetch)).toBeNull();
    expect(await askWitness(pcWire({ "GET /api/account/list/witness": json({ account: 1 }) }).fetch)).toBeNull();
    expect(await askWitness(async () => { throw new Error("the channel closed"); })).toBeNull();
  });
});

describe("a session the app opened to a PC of the account", () => {
  test("a device that waits on its PCs asks this one, keeps its answer for this run and reads its list again", async () => {
    const answers = pcAnswers();
    const list = listOf({ at: "none", why: "moving", move: { why: "pcs_silent", wait: 10, asks: [E(1)] } });
    const said = { account: ACCOUNT, pinned: null, admits: [], removed: [] };
    const wire = pcWire({ "GET /api/account/list/witness": json(said) });
    await onPcSession({ list, answers, account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
    expect(answers.get(ACCOUNT, E(1))).toEqual(said);
    expect(list.synced).toBe(1);
  });

  test("a device that waits on nothing asks nothing; an account that never moved is told nothing", async () => {
    for (const status of [{ at: "off" as const }, { at: "none" as const, why: "not_new" as const }, { at: "following" as const, list: "a".repeat(64), standing: "in" as const, head: 3, read_at: null, trouble: null }]) {
      const wire = pcWire({});
      await onPcSession({ list: listOf(status), answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
      expect(wire.asked).toEqual([]);
    }
  });

  test("a device that follows its moved list names it, and vouches, to a PC that follows none", async () => {
    const naming = { naming: { list: "a".repeat(64), key: KEY, signature: "s".repeat(86) }, vouches: [{ key: KEY, device: "D", link: { member: "m", device: "d" } }] };
    const wire = pcWire({ "POST /api/account/list/name": json({ pinned: false, why: "session_new", wait: 60 }) });
    const following = { at: "following" as const, list: "a".repeat(64), standing: "in" as const, head: 3, read_at: null, trouble: null };
    await onPcSession({ list: listOf(following, naming), answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
    expect(wire.asked).toEqual([{ method: "POST", path: "/api/account/list/name", body: { naming: naming.naming, vouches: naming.vouches } }]);
  });

  test("a PC that follows a list is named nothing", async () => {
    const naming = { naming: { list: "a".repeat(64), key: KEY, signature: "s".repeat(86) }, vouches: [] };
    const wire = pcWire({});
    const following = { at: "following" as const, list: "a".repeat(64), standing: "in" as const, head: 3, read_at: null, trouble: null };
    await onPcSession({ list: listOf(following, naming), answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: true, session: KEY, signIn: KEY });
    expect(wire.asked).toEqual([]);
  });

  test("which states wait on the PCs: the start, a carried device's join, and a refusal that may clear", () => {
    expect(waitsOnPcs({ at: "none", why: "moving", move: { why: "too_new", wait: 1, asks: [] } })).toBe(true);
    expect(waitsOnPcs({ at: "not_in", list: "a".repeat(64), why: "carried", claim: "unclaimed", join: { why: "pcs_silent", wait: 1, pcs: [] } })).toBe(true);
    expect(waitsOnPcs({ at: "not_in", list: "a".repeat(64), why: "not_mine", claim: "claimed", refused: { why: "other_list", pcs: [E(1)] } })).toBe(true);
    expect(waitsOnPcs({ at: "not_in", list: "a".repeat(64), why: "not_mine", claim: "claimed" })).toBe(false);
    expect(waitsOnPcs({ at: "none", why: "has_pcs" })).toBe(false);
  });
});

// the real naming a PC checks: covered end to end in listMigrate.test.ts
void heldNaming;
void heldVouches;

describe("a session to a PC that follows the list", () => {
  test("a device that follows its list gives the PC its keys where the move left it none, and names it nothing", async () => {
    const wire = pcWire({});
    let asked = 0;
    const following = { at: "following" as const, list: "a".repeat(64), standing: "in" as const, head: 3, read_at: null, trouble: null };
    await onPcSession({ list: listOf(following), answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: true, session: KEY, signIn: KEY, carriedKeys: async () => { asked += 1; } });
    expect(asked).toBe(1);
    expect(wire.asked).toEqual([]);
    // a PC that follows no list is named the list instead, and is given no keys
    await onPcSession({ list: listOf(following), answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY, carriedKeys: async () => { asked += 1; } });
    expect(asked).toBe(1);
  });
});

describe("what a PC answered stays for the run", () => {
  test("a session that gets no answer (a pairing's, which the PC does not answer) leaves an answer heard before", async () => {
    const answers = pcAnswers();
    const said = { account: ACCOUNT, pinned: null, admits: [], removed: [] };
    answers.set(ACCOUNT, E(1), said);
    const list = listOf({ at: "none", why: "moving", move: { why: "too_new", wait: 10, asks: [] } });
    await onPcSession({ list, answers, account: ACCOUNT, fetch: pcWire({ "GET /api/account/list/witness": json({ error: { code: "account_required" } }, 403) }).fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
    expect(answers.get(ACCOUNT, E(1))).toEqual(said);
  });
});

describe("a carried device that follows its list and still asks about it (V4-6)", () => {
  test("asks the PC what it lets in, and names the list to it all the same", async () => {
    const answers = pcAnswers();
    const naming = { naming: { list: "a".repeat(64), key: KEY, signature: "s".repeat(86) }, vouches: [] };
    const asking = { at: "following" as const, list: "a".repeat(64), standing: "in" as const, head: 3, read_at: null, trouble: null, asks: [E(1)] };
    const said = { account: ACCOUNT, pinned: null, admits: [], removed: [] };
    const wire = pcWire({ "GET /api/account/list/witness": json(said), "POST /api/account/list/name": json({ pinned: false, why: "session_new", wait: 60 }) });
    const list = listOf(asking, naming);
    await onPcSession({ list, answers, account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
    expect(wire.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["GET /api/account/list/witness", "POST /api/account/list/name"]);
    expect(answers.get(ACCOUNT, E(1))).toEqual(said);
    expect(list.synced).toBe(1);
    expect(waitsOnPcs(asking)).toBe(true);
    expect(waitsOnPcs({ ...asking, asks: [] })).toBe(false);
  });
});

describe("a session's acts re-read where the device stands after each wait (astra-migapp 8, others)", () => {
  const naming = { naming: { list: "a".repeat(64), key: KEY, signature: "s".repeat(86) }, vouches: [] };
  const following = { at: "following" as const, list: "a".repeat(64), standing: "in" as const, head: 3, read_at: null, trouble: null };
  const moving = { at: "none" as const, why: "moving" as const, move: { why: "pcs_silent" as const, wait: 10, asks: [E(1)] } };

  test("a device that moves its account because of this very answer names the list on this session", async () => {
    let view: AccountListView = { account: ACCOUNT, status: moving, reached: true, devices: [], pcs: [] };
    const asked: unknown[] = [];
    const list = { view: () => view, naming: async (given: unknown) => { asked.push(given); return naming; }, sync: async () => { view = { ...view, status: following }; return view; } };
    const wire = pcWire({ "GET /api/account/list/witness": json({ account: ACCOUNT, pinned: null, admits: [], removed: [] }), "POST /api/account/list/name": json({ pinned: true, list: "a".repeat(64) }) });
    await onPcSession({ list, answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
    expect(wire.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["GET /api/account/list/witness", "POST /api/account/list/name"]);
    expect(asked).toEqual([{ account: ACCOUNT, session: KEY, endpoint: E(1), signIn: KEY }]);
  });

  test("another account signed in while this session waited: nothing is named with its key", async () => {
    let view: AccountListView = { account: ACCOUNT, status: moving, reached: true, devices: [], pcs: [] };
    let named = 0;
    const list = { view: () => view, naming: async () => { named += 1; return naming; }, sync: async () => { view = { account: "acct_b", status: following, reached: true, devices: [], pcs: [] }; return view; } };
    const wire = pcWire({ "GET /api/account/list/witness": json({ account: ACCOUNT, pinned: null, admits: [], removed: [] }) });
    await onPcSession({ list, answers: pcAnswers(), account: ACCOUNT, fetch: wire.fetch, endpoint: E(1), pinned: false, session: KEY, signIn: KEY });
    expect(named).toBe(0);
    expect(wire.asked.map((one) => one.path)).toEqual(["/api/account/list/witness"]);
  });
});
