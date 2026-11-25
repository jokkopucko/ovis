/** A world of an account that was in use, for the tests of its move onto its signed list (listMigrate.ts). */
import type { PcAnswer } from "../../../shared/account-list-migrate.ts";
import { askingPc, listWorld, type AskingPc, type WorldDevice } from "./accountList.test-helpers.ts";
import { accountList } from "./accountList.ts";
import { pcAnswers } from "./listMigrate.ts";
import { memoryListLock, type ListStore } from "./listStore.ts";
import type { SeenPcs } from "./seenPcs.ts";

const DAY = 86400;
const OLD = { wall: 30 * DAY, ran: 30 * DAY };

/** A Storage in memory, where a device keeps its record of its PCs (seenPcs.ts). */
export function memoryStorage(): Storage {
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

/** A world of one account that was in use: its devices, each with its own record of its PCs and its own answers from this run. */
export function movingWorld() {
  const world = listWorld();
  world.fake.listMigrateAccounts = world.account;
  const json = (body: unknown, bearer: string): RequestInit => ({ headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
  const seconds = () => Math.floor(world.clock.now / 1000);
  /** A device of the account, signed in long ago (no new account's genesis is its to make), with its record and its answers. */
  const member = async (label: string, scale = 1, removed: () => readonly string[] = () => [], durable?: () => boolean) => {
    const storage = memoryStorage();
    const answers = pcAnswers();
    const device = await world.device({ label, migration: { answers, storage, scale: () => scale, removed: async () => removed() }, ...(durable === undefined ? {} : { durable }) });
    const signIn = (await device.store.get("signin_key"))!.key.public_spki;
    const member = (await device.store.key()).public_spki;
    const record = (pcs: SeenPcs["pcs"], tried?: number) => storage.setItem(`ovis:seen-pcs:${world.account}`, JSON.stringify({ v: 1, account: world.account, pcs, ...(tried === undefined ? {} : { tried }) }));
    const kept = () => JSON.parse(storage.getItem(`ovis:seen-pcs:${world.account}`) ?? "null") as SeenPcs | null;
    /** Another tab of this very device: the same stores and the same record, its own lock, as where the browser has no Web Locks. */
    const tab = (lists: ListStore = device.lists) => accountList({
      service: device.service, accountStore: device.store, listStore: lists, lock: memoryListLock(), now: () => world.clock.now,
      names: () => ({ label, os: "ios" }), linkedPcs: async () => 0, genesis: () => "first-device", durable: async () => true,
      migration: { answers, storage, scale: () => scale, removed: async () => removed() },
    });
    return { device, storage, answers, signIn, member, record, kept, label, tab };
  };
  /** A PC the account lists as let in (listed by an own sign-in). */
  const pcOf = async (by: WorldDevice): Promise<AskingPc> => {
    const pc = await askingPc();
    const listed = await world.fake.fetch(`${world.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", ...json({ label: "Desk", public_key: pc.endpoint, relay: "wss://relay.test" }, by.session.access_token) });
    if (!listed.ok) throw new Error(`The account did not list the PC: ${listed.status}`);
    return pc;
  };
  const answer = (admits: readonly { key: string; wall?: number; ran?: number; idle?: number }[], rest: Partial<PcAnswer> = {}): PcAnswer =>
    ({ account: world.account, pinned: null, admits: admits.map((row) => ({ ...OLD, idle: null, ...row })), removed: [], ...rest });
  const birthsSent = (device: WorldDevice) => device.sent.filter((one) => one.route === "POST /v2/lists" && Array.isArray(one.body?.entries));
  return { world, member, pcOf, answer, seconds, birthsSent };
}

export type Moving = ReturnType<typeof movingWorld>;
export type Member = Awaited<ReturnType<Moving["member"]>>;

/**
 * A phone and a laptop of the account, both let in for a month by one PC each knows by its own pairing. `silent`: a
 * second PC both know as well, listed as let in, that answers nobody in this run.
 */
export async function inUse(moving: Moving = movingWorld(), given: { readonly silent?: boolean; readonly durable?: () => boolean } = {}) {
  const phone = await moving.member("Phone", 1, () => [], given.durable);
  const laptop = await moving.member("Laptop");
  const pc = await moving.pcOf(phone.device);
  const silent = given.silent === true ? await moving.pcOf(phone.device) : null;
  // signed in more than ten minutes ago: this is an account in use, which no first device's genesis is for
  moving.world.clock.now += 11 * 60_000;
  const at = moving.seconds() - 40 * DAY;
  const pcs: SeenPcs["pcs"] = { [pc.endpoint]: { since: at, last: at, how: "paired" }, ...(silent === null ? {} : { [silent.endpoint]: { since: at, last: at, how: "paired" } }) };
  phone.record(pcs);
  laptop.record(pcs);
  const said = moving.answer([{ key: phone.signIn }, { key: laptop.signIn }]);
  phone.answers.set(moving.world.account, pc.endpoint, said);
  laptop.answers.set(moving.world.account, pc.endpoint, said);
  return { ...moving, phone, laptop, pc, silent };
}

/** The phone moved the account; the laptop was carried in. */
export async function moved() {
  const setting = await inUse();
  await setting.phone.device.list.sync();
  return setting;
}
