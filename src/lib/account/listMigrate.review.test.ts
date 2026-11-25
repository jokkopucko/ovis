/**
 * The independent review of the app's part of the move onto the account's list (at 406e6ad34), kept: each finding is a
 * test that failed there and holds now, and each guard the review checked is pinned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { MIGRATION_ANSWER_SECONDS, type PcAnswer } from "../../../shared/account-list-migrate.ts";
import { listView, readKind } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import type { RemoveRecord } from "../../../shared/account-records.ts";
import { ListMoveNotice } from "../../components/ListMoveNotice.tsx";
import { SettingsProvider } from "../settings.ts";
import type { AccountList, AccountListView } from "./accountList.ts";
import { askingPc, listWorld, type AskingPc, type WorldDevice } from "./accountList.test-helpers.ts";
import { rememberDevice } from "./join.ts";
import { MOVE_AGAIN_SECONDS, ownRemovals, pcAnswers, readBirth, type MoveNoticeView } from "./listMigrate.ts";
import type { SeenPcs } from "./seenPcs.ts";
import { AccountServiceError } from "./service.ts";
import { keepUnsent, postKept } from "./unsentBlocks.ts";

const DAY = 86400;
const OLD = { wall: 30 * DAY, ran: 30 * DAY };

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); },
    setItem: (key, value) => { items.set(key, String(value)); },
  };
}

/** listMigrate.test.ts's world, with the controller's own `removed` (ownRemovals over the device's account store) where asked. */
function movingWorld() {
  const world = listWorld();
  world.fake.listMigrateAccounts = world.account;
  const json = (body: unknown, bearer: string): RequestInit => ({ headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
  const seconds = () => Math.floor(world.clock.now / 1000);
  const member = async (label: string, given: { readonly ownRemovals?: boolean } = {}) => {
    const storage = memoryStorage();
    const answers = pcAnswers();
    const box: { device?: WorldDevice } = {};
    // as accountController.ts wires it: `removed: (id) => ownRemovals(accountStore, id)`
    const removed = async (account: string): Promise<readonly string[]> => (given.ownRemovals === true && box.device !== undefined ? await ownRemovals(box.device.store, account) : []);
    const device = await world.device({ label, migration: { answers, storage, scale: () => 1, removed } });
    box.device = device;
    const signIn = (await device.store.get("signin_key"))!.key.public_spki;
    const member = (await device.store.key()).public_spki;
    const record = (pcs: SeenPcs["pcs"], tried?: number) => storage.setItem(`ovis:seen-pcs:${world.account}`, JSON.stringify({ v: 1, account: world.account, pcs, ...(tried === undefined ? {} : { tried }) }));
    const kept = () => JSON.parse(storage.getItem(`ovis:seen-pcs:${world.account}`) ?? "null") as SeenPcs | null;
    return { device, storage, answers, signIn, member, record, kept, label };
  };
  const pcOf = async (by: WorldDevice): Promise<AskingPc> => {
    const pc = await askingPc();
    const listed = await world.fake.fetch(`${world.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", ...json({ label: "Desk", public_key: pc.endpoint, relay: "wss://relay.test" }, by.session.access_token) });
    if (!listed.ok) throw new Error(`The account did not list the PC: ${listed.status}`);
    return pc;
  };
  const answer = (admits: readonly { key: string; wall?: number; ran?: number; idle?: number }[], rest: Partial<PcAnswer> = {}): PcAnswer =>
    ({ account: world.account, pinned: null, admits: admits.map((row) => ({ ...OLD, idle: null, ...row })), removed: [], ...rest });
  const birthsSent = (device: WorldDevice) => device.sent.filter((one) => one.route === "POST /v2/lists" && Array.isArray(one.body?.entries));
  /** Every key a birth this device sent carries in (its `carried` entries with `key`). */
  const carriedSent = (device: WorldDevice): string[] => birthsSent(device).flatMap((one) => (one.body!.entries as string[]).flatMap((text) => {
    const kind = readKind(readBody(entryFromText(text).body));
    return kind?.kind === "carried" && "key" in kind && typeof kind.key === "string" ? [kind.key] : [];
  }));
  return { world, member, pcOf, answer, seconds, birthsSent, carriedSent };
}

type Moving = ReturnType<typeof movingWorld>;

/** listMigrate.test.ts's inUse: a phone and a laptop of the account, let in for a month by one PC each knows by its own pairing. */
async function inUse(moving: Moving = movingWorld(), given: { readonly ownRemovals?: boolean; readonly more?: number } = {}) {
  const phone = await moving.member("Phone", given);
  const laptop = await moving.member("Laptop");
  const pc = await moving.pcOf(phone.device);
  // further PCs the account lists, listed while the phone's sign-in is fresh (as `pc`)
  const more: AskingPc[] = [];
  for (let n = 0; n < (given.more ?? 0); n += 1) more.push(await moving.pcOf(phone.device));
  moving.world.clock.now += 11 * 60_000;
  const at = moving.seconds() - 40 * DAY;
  const pcs: SeenPcs["pcs"] = { [pc.endpoint]: { since: at, last: at, how: "paired" } };
  phone.record(pcs);
  laptop.record(pcs);
  const said = moving.answer([{ key: phone.signIn }, { key: laptop.signIn }]);
  phone.answers.set(moving.world.account, pc.endpoint, said);
  laptop.answers.set(moving.world.account, pc.endpoint, said);
  return { ...moving, phone, laptop, pc, at, other: more[0]! };
}

/** The account service's directory (GET /v1/pcs) as `device` reads it leaves out these relay keys: a breached service's lie. */
function hideFromDirectory(device: WorldDevice, world: ReturnType<typeof listWorld>, endpoints: readonly string[]): void {
  device.wire.answer = async (request) => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/pcs") return null;
    const real = await world.fake.fetch(request);
    const body = await real.json() as { pcs: { public_key: string | null }[] };
    return Response.json({ ...body, pcs: body.pcs.filter((pc) => pc.public_key === null || !endpoints.includes(pc.public_key)) });
  };
}

describe("H1: R-F, a key this device blocked itself is never carried, sent or not", () => {
  test("H1: a Not me's block the account service confirmed is still never carried", async () => {
    const { phone, laptop, world, carriedSent } = await inUse(movingWorld(), { ownRemovals: true });
    // the phone pressed Not me on the laptop's sign-in: the block is kept first (AccountDeviceNotices.tsx), then sent
    const block = { v: 1, kind: "block", id: "b".repeat(64), account: world.account, target: laptop.signIn, target_no: 2, signer: phone.signIn, signer_no: 1, signed_at: "2026-11-25T00:00:00Z", nonce: "n", signature: "s" } as never;
    expect(await keepUnsent(phone.device.store, phone.device.session, [block])).toBe(true);
    expect(await ownRemovals(phone.device.store, world.account)).toContain(laptop.signIn);
    // the account service answers 200 for it: confirmed, so the record leaves unsent_blocks (unsentBlocks.ts postKept)
    expect(await postKept(phone.device.store, phone.device.session, [block], async () => {})).toBe("sent");
    // a breached service never applied it and lists the laptop as before; the one PC that answers never heard of the block
    const view = await phone.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
    expect(listView(world.held().state).devices.some((row) => row.key === laptop.signIn)).toBe(false);
  });

  test("H1 (unit): ownRemovals still names a key this device blocked once the service confirmed the block", async () => {
    const { phone, laptop, world } = await inUse(movingWorld(), { ownRemovals: true });
    const block = { v: 1, kind: "block", id: "c".repeat(64), account: world.account, target: laptop.signIn, target_no: 2, signer: phone.signIn, signer_no: 1, signed_at: "2026-11-25T00:00:00Z", nonce: "n", signature: "s" } as never;
    await keepUnsent(phone.device.store, phone.device.session, [block]);
    await postKept(phone.device.store, phone.device.session, [block], async () => {});
    expect(await ownRemovals(phone.device.store, world.account)).toContain(laptop.signIn);
  });

  test("F6: a block the account service refused for good holds no move: the birth goes at once, without the blocked key", async () => {
    const { phone, laptop, world, carriedSent, birthsSent } = await inUse(movingWorld(), { ownRemovals: true });
    const block = { v: 1, kind: "block", id: "a".repeat(64), account: world.account, target: laptop.signIn, target_no: 2, signer: phone.signIn, signer_no: 1, signed_at: "2026-11-25T00:00:00Z", nonce: "n", signature: "s" } as never;
    await keepUnsent(phone.device.store, phone.device.session, [block]);
    expect(await postKept(phone.device.store, phone.device.session, [block], async () => { throw new AccountServiceError(403, "unknown_target", "x"); })).toBe("refused");
    expect(Object.values(await phone.device.store.get("unsent_blocks") ?? {}).map((entry) => entry.refused)).toEqual([true]);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
  });

  test("H1: an unsent block is never carried (the half that holds)", async () => {
    const { phone, laptop, world, carriedSent } = await inUse(movingWorld(), { ownRemovals: true });
    const block = { v: 1, kind: "block", id: "d".repeat(64), account: world.account, target: laptop.signIn, target_no: 2, signer: phone.signIn, signer_no: 1, signed_at: "2026-11-25T00:00:00Z", nonce: "n", signature: "s" } as never;
    await keepUnsent(phone.device.store, phone.device.session, [block]);
    await phone.device.list.sync();
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
  });
});

describe("LOW-1: the removals this device signed itself are among its own", () => {
  test("L1: a `remove` this device signed itself (removeFromAccount keeps it in `devices`) is among its own removals", async () => {
    const { phone, world } = await inUse(movingWorld(), { ownRemovals: true });
    const key = (await askingPc()).key;
    const remove: RemoveRecord = { v: 1, kind: "remove", account: world.account, key, issued_at: "2026-11-25T00:00:00.000Z", id: "r1", signer: phone.member, signature: "s" } as RemoveRecord;
    await rememberDevice(phone.device.store, remove);
    expect(await ownRemovals(phone.device.store, world.account)).toContain(key);
  });
});

describe("H2: the account service's word takes no PC of the device's own record out of the witnesses", () => {
  test("H2a: a PC this device paired with, which answered that it does not let a key in, still vetoes it when the directory leaves that PC out", async () => {
    const moving = movingWorld();
    const { phone, laptop, pc, world, at, carriedSent, other } = await inUse(moving, { more: 1 });
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [other.endpoint]: { since: at, last: at, how: "paired" } });
    // the second PC lets the phone in for a month and never let the laptop's sign-in in
    phone.answers.set(world.account, other.endpoint, moving.answer([{ key: phone.signIn }]));
    // without the lie the laptop is `unwitnessed` and not carried (PIN below); with it the second PC is no witness at all
    hideFromDirectory(phone.device, world, [other.endpoint]);
    await phone.device.list.sync();
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
  });

  test("H2a: with the directory honest, the same PC keeps the laptop out (`unwitnessed`)", async () => {
    const moving = movingWorld();
    const { phone, laptop, pc, world, at, carriedSent, other } = await inUse(moving, { more: 1 });
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [other.endpoint]: { since: at, last: at, how: "paired" } });
    phone.answers.set(world.account, other.endpoint, moving.answer([{ key: phone.signIn }]));
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
  });

  test("H2b: a `403 not_carried` naming a PC's entry takes that PC out of the next plan's witnesses, not only out of its run", async () => {
    const moving = movingWorld();
    const { phone, laptop, pc, world, at, carriedSent, other } = await inUse(moving, { more: 1 });
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [other.endpoint]: { since: at, last: at, how: "paired" } });
    phone.answers.set(world.account, other.endpoint, moving.answer([{ key: phone.signIn }]));
    // the service refuses the first birth for good at the second PC's `carried` entry
    let refusedAt: number | null = null;
    phone.device.wire.answer = async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists" || refusedAt !== null) return null;
      const body = await request.json() as { entries: string[] };
      const at = body.entries.findIndex((text) => { const kind = readKind(readBody(entryFromText(text).body)); return kind?.kind === "carried" && "endpoint" in kind && kind.endpoint === other.endpoint; });
      refusedAt = at + 1;
      return Response.json({ error: { code: "not_carried", message: "x", index: refusedAt }, now: 0 }, { status: 403 });
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    expect(refusedAt).not.toBeNull();
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
    world.clock.now += MOVE_AGAIN_SECONDS * 1000;
    phone.device.wire.answer = null;
    await phone.device.list.sync();
    expect(moving.birthsSent(phone.device)).toHaveLength(2);
    // the second PC still answered that it never let the laptop in: the laptop is not carried
    expect(carriedSent(phone.device)).not.toContain(laptop.signIn);
  });

  test("H2c: a PC this device paired with that is silent holds the start back, even where the directory does not list it", async () => {
    const moving = movingWorld();
    const { phone, pc, at, birthsSent } = await inUse(moving);
    // paired at the PC, so known by this device's own record; the account service's directory does not name it
    const silent = await askingPc();
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [silent.endpoint]: { since: at, last: at, how: "paired" } });
    const view = await phone.device.list.sync();
    expect(view.status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent" } });
    expect(birthsSent(phone.device)).toEqual([]);
  });
});

/** The phone moved the account; the laptop was carried in. */
async function moved() {
  const setting = await inUse();
  await setting.phone.device.list.sync();
  return setting;
}

describe("M1: a carried device's notice leaves out its own row", () => {
  test("M1a: before its hand-over is placed, the notice does not offer the device itself as one it brought in", async () => {
    const { laptop, world } = await moved();
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "list_rebuilding", message: "x" } }, { status: 503, headers: { "retry-after": "1" } }) : null;
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    const notice = await laptop.device.list.notice!(world.account);
    expect(notice).not.toBeNull();
    expect(notice!.devices.map((row) => row.key)).not.toContain(laptop.signIn);
  });

  test("M1b: the round that joins and places the hand-over shows a notice without the device itself", async () => {
    const { laptop, world } = await moved();
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    const notice = await laptop.device.list.notice!(world.account);
    expect(notice).not.toBeNull();
    expect(notice!.devices.map((row) => row.key)).not.toContain(laptop.signIn);
  });

  test("M1: after the next read the notice names nobody of this device's own", async () => {
    const { laptop, world } = await moved();
    await laptop.device.list.sync();
    await laptop.device.list.sync({ read: true });
    const notice = await laptop.device.list.notice!(world.account);
    expect(notice!.devices.map((row) => row.key)).not.toContain(laptop.signIn);
    expect(notice!.devices.map((row) => row.key)).not.toContain(laptop.member);
  });
});

describe("M2: who made the list has Not me (R-G)", () => {
  const globals = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  const setGlobals = () => {
    for (const [key, value] of Object.entries({
      IS_REACT_ACT_ENVIRONMENT: true, window: new EventTarget(), location: new URL("https://app.ovis.sh/"),
      document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
      getComputedStyle: () => ({ getPropertyValue: () => "" }), navigator: { languages: ["en"] }, localStorage: { getItem: () => null, setItem: () => {} },
    })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true });
    }
  };
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of globals) {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    globals.clear();
  });
  const LIST = "5c".repeat(32);
  const following: AccountListView = { account: "acct_moved", reached: true, status: { at: "following", list: LIST, standing: "in", head: 5, read_at: 1, trouble: null }, devices: [], pcs: [] };
  const listWith = (notice: MoveNoticeView) => ({ view: () => following, subscribe: () => () => {}, notice: async () => notice, noticeSeen: async () => {} }) as unknown as AccountList;
  const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); }); };

  test("M2: on a device the move carried in, the device that made the list can be answered Not me", async () => {
    setGlobals();
    const notice: MoveNoticeView = { list: LIST, first: { self: false, key: "G", name: { label: "Phone", os: null } }, devices: [], pcs: [], removed: [] };
    const asked: [string, string][] = [];
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(ListMoveNotice, { list: listWith(notice), notMeDevice: (key: string, name: string) => { asked.push([key, name]); } })));
    });
    await settle();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Phone made your account's list.");
    const notMe = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Not me");
    expect(notMe).toHaveLength(1);
    await act(async () => { notMe[0]!.props.onClick(); });
    expect(asked).toEqual([["G", "Phone"]]);
  });
});

describe("M3: a refusal of the caller is no answer about the birth, and gives no list up", () => {
  test("M3: a birth that was placed, then shown as no list and answered `403 frozen` once, is still followed once the service answers again", async () => {
    const { phone, world } = await inUse();
    world.fake.tamperAccount(world.account, { withholdAnswer: true });
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    world.fake.untamperAccount(world.account);
    const placed = world.held().id;
    // one round in which the service says the account has no list and refuses the resend for the sign-in, not for the birth
    phone.device.wire.answer = (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v2/lists/mine") return Response.json({ list: null, migrate: true, now: 0 });
      if (request.method === "POST" && path === "/v2/lists") return Response.json({ error: { code: "frozen", message: "x" }, now: 0 }, { status: 403 });
      return null;
    };
    await phone.device.list.sync();
    phone.device.wire.answer = null;
    world.clock.now += MOVE_AGAIN_SECONDS * 1000;
    const after = await phone.device.list.sync();
    expect(after.status).toMatchObject({ at: "following", standing: "in", list: placed });
  });

  test("M3: a lost answer alone: the kept birth is followed, never given up", async () => {
    const { phone, world } = await inUse();
    world.fake.tamperAccount(world.account, { withholdAnswer: true });
    await phone.device.list.sync();
    world.fake.untamperAccount(world.account);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    expect(readBirth(await phone.device.lists.get("birth" as never, world.account))).toBeNull();
  });
});

describe("LOW-2: a device not in a list reads its first two entries, in one request (ruled: keep limit=2)", () => {
  test("L2: off the migrate switch, a device that is not in the account's list asks its log once, for entries 0 and 1", async () => {
    const world = listWorld();
    world.fake.listMigrateAccounts = "";
    const phone = await world.device({ label: "Phone" });
    expect((await phone.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    world.clock.now += 11 * 60_000;
    const laptop = await world.device({ label: "Laptop", genesis: "never" });
    const limits: (string | null)[] = [];
    laptop.wire.answer = (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/log")) limits.push(url.searchParams.get("limit"));
      return null;
    };
    expect((await laptop.list.sync()).status).toMatchObject({ at: "not_in", why: "not_mine" });
    // entry 1's kind is the only word on whether a move carried this device in: one read of two entries, then no more
    expect(limits).toEqual(["2"]);
  });
});

describe("LOW-3: a PC silent at the join agrees only once it has let the starter in for a day", () => {
  async function joinedOnOnePc() {
    const moving = movingWorld();
    const setting = await inUse(moving, { more: 1 });
    const silent = setting.other;
    const pcs: SeenPcs["pcs"] = { [setting.pc.endpoint]: { since: setting.at, last: setting.at, how: "paired" }, [silent.endpoint]: { since: setting.at, last: setting.at, how: "paired" } };
    setting.phone.record(pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    await setting.phone.device.list.sync();
    setting.laptop.record(pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await setting.laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", asks: [silent.endpoint] });
    return { ...setting, silent };
  }

  test("L3: the late PC that let the key that started the list in for a minute is asked again, as joinVerdict waits on it", async () => {
    const { laptop, phone, silent, world, answer } = await joinedOnOnePc();
    laptop.answers.set(world.account, silent.endpoint, answer([{ key: phone.signIn, wall: 60, ran: 60 }]));
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", asks: [silent.endpoint] });
  });
});

describe("guards the review checked and found sound", () => {
  test("a carried device's hand-over whose answer was lost is sent again as it is, once per head", async () => {
    const { laptop, world } = await moved();
    let lost = false;
    laptop.device.wire.answer = (request) => {
      if (lost || request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      lost = true;
      throw new TypeError("the request never arrived");
    };
    await laptop.device.list.sync();
    laptop.device.wire.answer = null;
    await laptop.device.list.sync();
    const sent = laptop.device.sent.filter((one) => one.route === `POST /v2/lists/${world.held().id}/entries`);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  test("an answer a PC gives for another account makes it no witness and no carried endpoint", async () => {
    const moving = movingWorld();
    const { phone, laptop, pc, world, carriedSent, other } = await inUse(moving, { more: 1 });
    const at = moving.seconds() - 40 * DAY;
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [other.endpoint]: { since: at, last: at, how: "paired" } });
    phone.answers.set(world.account, other.endpoint, { account: "acct_someone_else", pinned: null, admits: [{ key: phone.signIn, ...OLD }, { key: laptop.signIn, ...OLD }], removed: [] });
    await phone.device.list.sync();
    expect(carriedSent(phone.device)).toContain(laptop.signIn);
    expect(listView(world.held().state).pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
  });

  test("a key the account service lists that no PC lets in is never carried (a key it made up)", async () => {
    const { phone, world, carriedSent } = await inUse();
    const madeUp = (await askingPc()).key;
    world.fake.registerSessionKey(world.fake.issueToken(world.account), madeUp, "Tablet");
    await phone.device.list.sync();
    expect(carriedSent(phone.device)).not.toContain(madeUp);
  });
});

describe("LOW-4: a kept birth does not outlive the list another device placed", () => {
  test("L4: a device whose own birth never arrived, and which then joins the list another device placed, keeps no birth to send", async () => {
    const { phone, laptop, world } = await inUse();
    // the laptop plans first; its request never arrives
    laptop.device.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v2/lists") throw new TypeError("the request never arrived");
      return null;
    };
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    laptop.device.wire.answer = null;
    // the phone moves the account meanwhile, carrying the laptop in
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    // the laptop's own birth can never be the account's: what it kept to send is no longer kept
    expect(readBirth(await laptop.device.lists.get("birth" as never, world.account))).toBeNull();
  });
});

describe("the step's refusal and resend paths", () => {
  test("two devices start at once; the one whose birth comes second is told the other's list, drops its own and joins that one", async () => {
    const { phone, laptop, world, birthsSent } = await inUse();
    let raced = false;
    laptop.device.wire.answer = async (request) => {
      if (raced || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      raced = true;
      // the phone's birth is placed while the laptop's is on its way
      expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
      return null;
    };
    await laptop.device.list.sync();
    expect(birthsSent(laptop.device)).toHaveLength(1);
    expect(readBirth(await laptop.device.lists.get("birth" as never, world.account))).toBeNull();
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
  });

  test("a final refusal that is no `403 not_carried` leaves out nobody, whatever `index` it names", async () => {
    const { phone, laptop, world, carriedSent } = await inUse();
    let refused = false;
    phone.device.wire.answer = (request) => {
      if (refused || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      refused = true;
      return Response.json({ error: { code: "entry_refused", message: "x", reason: "birth_shape", index: 1 }, now: 0 }, { status: 400 });
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    world.clock.now += MOVE_AGAIN_SECONDS * 1000;
    phone.device.wire.answer = null;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(carriedSent(phone.device).filter((key) => key === laptop.signIn)).toHaveLength(2);
  });

  test("a `429` keeps the birth, which is sent again as it is", async () => {
    const { phone, birthsSent } = await inUse();
    let limited = false;
    phone.device.wire.answer = (request) => {
      if (limited || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      limited = true;
      return Response.json({ error: { code: "rate_limited", message: "x" }, now: 0 }, { status: 429, headers: { "retry-after": "1" } });
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    phone.device.wire.answer = null;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    const sent = birthsSent(phone.device);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  test("a carried device's refusal of its list clears when the PC that said no agrees", async () => {
    const { laptop, phone, pc, world, answer } = await moved();
    laptop.answers.set(world.account, pc.endpoint, { account: world.account, pinned: "ab".repeat(32), admits: [], removed: [] });
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "not_in", why: "not_mine", refused: { why: "other_list" } });
    laptop.answers.set(world.account, pc.endpoint, answer([{ key: phone.signIn }]));
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  });

  test("a device not in an ordinary list (off the migrate switch) reads its log no further than the first page", async () => {
    const world = listWorld();
    world.fake.listMigrateAccounts = "";
    const phone = await world.device({ label: "Phone" });
    expect((await phone.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    world.clock.now += 11 * 60_000;
    const laptop = await world.device({ label: "Laptop", genesis: "never" });
    expect((await laptop.list.sync()).status).toMatchObject({ at: "not_in", why: "not_mine" });
    expect(laptop.sent.filter((one) => one.route.endsWith("/log"))).toHaveLength(1);
    expect(laptop.sent.some((one) => one.route === "GET /v1/devices")).toBe(false);
  });

  test("a hand-over refused for good is not signed again on the same head within the hour", async () => {
    const { laptop, world } = await moved();
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "not_claimed", message: "x" }, now: 0 }, { status: 403 }) : null;
    await laptop.device.list.sync();
    const route = `POST /v2/lists/${world.held().id}/entries`;
    expect(laptop.device.sent.filter((one) => one.route === route)).toHaveLength(1);
    world.clock.now += 60_000;
    await laptop.device.list.sync();
    expect(laptop.device.sent.filter((one) => one.route === route)).toHaveLength(1);
  });

  test("a kept birth sent again after the service did not name its list yet gets `409 list_exists` naming itself, and is followed", async () => {
    const { phone, world } = await inUse();
    world.fake.tamperAccount(world.account, { withholdAnswer: true });
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    world.fake.untamperAccount(world.account);
    const placed = world.held().id;
    // one answer of GET /v2/lists/mine from before the birth was stored (a slow write), so the very birth is sent again
    let early = true;
    phone.device.wire.answer = (request) => {
      if (!early || request.method !== "GET" || new URL(request.url).pathname !== "/v2/lists/mine") return null;
      early = false;
      return Response.json({ list: null, migrate: true, now: 0 });
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: placed });
  });

  test("a `403 not_carried` at index 0 (this device's own sign-in key) starts nothing more with that sign-in", async () => {
    const { phone, world, birthsSent } = await inUse();
    phone.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname === "/v2/lists"
      ? Response.json({ error: { code: "not_carried", message: "x", index: 0 }, now: 0 }, { status: 403 }) : null;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    phone.device.wire.answer = null;
    world.clock.now += MOVE_AGAIN_SECONDS * 1000;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "self_unlisted" } });
    expect(birthsSent(phone.device)).toHaveLength(1);
  });

  test("a sign-in key kept for an earlier sign-in of the account signs no birth", async () => {
    const { phone, birthsSent } = await inUse();
    const kept = (await phone.device.store.get("signin_key"))!;
    await phone.device.store.set("signin_key", { ...kept, sign_in_id: "an-earlier-sign-in" });
    const view = await phone.device.list.sync();
    expect(view.status).toMatchObject({ at: "none", why: "moving", move: { why: "self_unlisted" } });
    expect(birthsSent(phone.device)).toEqual([]);
  });
});
