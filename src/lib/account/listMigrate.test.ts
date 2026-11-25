import { describe, expect, test } from "bun:test";
import { heldNaming, heldVouches, MIGRATION_ANSWER_SECONDS, standsFor, type KnownPc, type PcAnswer, type PcHow } from "../../../shared/account-list-migrate.ts";
import { listView, readKind } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { readSave, writeSave } from "../../../shared/account-list-follower.ts";
import { askingPc, listWorld, postPcKeys } from "./accountList.test-helpers.ts";
import { inUse, moved, movingWorld } from "./listMigrate.test-helpers.ts";
import { keysForCarriedPc } from "./listCarriedPc.ts";
import { leaveList, removeOthers } from "./listLeave.ts";
import type { ListStore } from "./listStore.ts";
import { AccountServiceError } from "./service.ts";
import { newKey } from "./store.ts";
import { keepUnsent, postKept } from "./unsentBlocks.ts";
import { joinedRecord, listDoubt, MOVE_AGAIN_SECONDS, pcAgrees, readBirth, readJoined, readNotice } from "./listMigrate.ts";

const DAY = 86400;
const OLD = { wall: 30 * DAY, ran: 30 * DAY };
describe("an account that is on no migrate switch, or has no list, behaves as before", () => {
  test("off the migrate switch: no birth, no read of the device list, and the device starts nothing", async () => {
    const moving = movingWorld();
    moving.world.fake.listMigrateAccounts = "";
    const { phone } = await inUse(moving);
    const view = await phone.device.list.sync();
    expect(view.status).toEqual({ at: "none", why: "not_new" });
    expect(moving.birthsSent(phone.device)).toEqual([]);
    expect(phone.device.sent.some((one) => one.route === "GET /v1/devices")).toBe(false);
    expect(phone.kept()?.tried).toBeUndefined();
  });

  test("an account the service keeps no list for is asked nothing more than before", async () => {
    const moving = movingWorld();
    moving.world.fake.listAccounts = "";
    const { phone } = await inUse(moving);
    const view = await phone.device.list.sync();
    expect(view.status).toEqual({ at: "off" });
    expect(phone.device.sent.map((one) => one.route)).toEqual(["GET /v2/lists/mine"]);
  });
});

describe("the first device moves the account onto its list", () => {
  test("every PC it knows let both devices in for a day: one request, the pin after the 201, and the notice", async () => {
    const { phone, laptop, pc, world, birthsSent } = await inUse();
    const view = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(view.status).toMatchObject({ at: "following", standing: "in", trouble: null });
    const held = world.held();
    const rows = listView(held.state);
    // the phone is in by its member key; the laptop by its sign-in key, carried; the PC carried as an endpoint with no key
    expect(rows.devices.filter((row) => row.ended === null).map((row) => row.key).sort()).toEqual([phone.member, laptop.signIn].sort());
    expect(view.devices.find((row) => row.self)?.key).toBe(phone.member);
    expect(rows.pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    // the birth was let go once it was in the copy; the notice waits to be seen
    expect(readBirth(await phone.device.lists.get("birth" as never, world.account))).toBeNull();
    const notice = readNotice(await phone.device.lists.get("notice" as never, world.account));
    expect(notice).toMatchObject({ list: held.id, first: phone.signIn, devices: [laptop.signIn], pcs: [pc.endpoint], seen: false });
    // the carried laptop is named by the name its sign-in registered (GET /v1/devices `label`), sealed in its entry
    expect((await phone.device.list.notice!(world.account))?.devices).toEqual([{ key: laptop.signIn, name: { label: "Laptop", os: null } }]);
    // the try ended in a start
    expect(phone.kept()?.tried).toBeUndefined();
  });

  test("a lost answer: the device learns from the account service's own word that its birth was placed, and follows it", async () => {
    const { phone, world, birthsSent } = await inUse();
    world.fake.tamperAccount(world.account, { withholdAnswer: true });
    const first = await phone.device.list.sync();
    expect(first.status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    world.fake.untamperAccount(world.account);
    const again = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(again.status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
  });

  test("a request that never arrived: the very request it kept is sent again, never a second one", async () => {
    const { phone, world, birthsSent } = await inUse();
    let dropped = false;
    phone.device.wire.answer = (request) => {
      if (dropped || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      dropped = true;
      throw new TypeError("the request never arrived");
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    phone.device.wire.answer = null;
    const again = await phone.device.list.sync();
    const sent = birthsSent(phone.device);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(again.status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
  });

  test("a PC it knows that has not answered holds the start back for three days from its first try", async () => {
    const moving = movingWorld();
    const { phone, birthsSent, silent } = await inUse(moving, { silent: true });
    const view = await phone.device.list.sync();
    expect(view.status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", wait: MIGRATION_ANSWER_SECONDS, asks: [silent!.endpoint] } });
    expect(birthsSent(phone.device)).toEqual([]);
    expect(phone.kept()?.tried).toBe(moving.seconds());
    // its first try was nearly three days ago (a session token outlives no such wait here, so the record says it)
    phone.record(phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS + 60);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", wait: 60 } });
    phone.record(phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(birthsSent(phone.device)).toHaveLength(1);
  });

  test("in the QA twin the device's own waits are turned down by its factor", async () => {
    const moving = movingWorld();
    const phone = await moving.member("Phone", 3600);
    const laptop = await moving.member("Laptop");
    const pc = await moving.pcOf(phone.device);
    const silent = await moving.pcOf(phone.device);
    moving.world.clock.now += 11 * 60_000;
    const at = moving.seconds() - 40 * DAY;
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [silent.endpoint]: { since: at, last: at, how: "paired" } });
    phone.answers.set(moving.world.account, pc.endpoint, moving.answer([{ key: phone.signIn }, { key: laptop.signIn }]));
    // three days are 72 seconds there
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", wait: 72 } });
    moving.world.clock.now += 72_000;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  });

  test("a final refusal: the birth is dropped, nothing is sent for an hour, then a plan without the key the refusal named", async () => {
    const { phone, laptop, world, birthsSent } = await inUse();
    // the honest case of the ruling: GET /v1/devices calls the laptop eligible, the birth's carried check does not
    world.fake.removeDevice(world.account, laptop.signIn);
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptop.signIn] });
    const refusedOnce = await phone.device.list.sync();
    expect(refusedOnce.status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(readBirth(await phone.device.lists.get("birth" as never, world.account))).toBeNull();
    world.clock.now += (MOVE_AGAIN_SECONDS - 60) * 1000;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    expect(birthsSent(phone.device)).toHaveLength(1);
    world.clock.now += 60_000;
    const moved = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(2);
    expect(moved.status).toMatchObject({ at: "following", standing: "in" });
    expect(listView(world.held().state).devices.some((row) => row.key === laptop.signIn)).toBe(false);
  });

  test("a key this device itself blocked or removed, sent or not, is never carried (R-F)", async () => {
    const moving = movingWorld();
    let blocked: readonly string[] = [];
    const phone = await moving.member("Phone", 1, () => blocked);
    const laptop = await moving.member("Laptop");
    const pc = await moving.pcOf(phone.device);
    moving.world.clock.now += 11 * 60_000;
    const at = moving.seconds() - 40 * DAY;
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" } });
    phone.answers.set(moving.world.account, pc.endpoint, moving.answer([{ key: phone.signIn }, { key: laptop.signIn }]));
    blocked = [laptop.signIn];
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(listView(moving.world.held().state).devices.some((row) => row.key === laptop.signIn)).toBe(false);
  });

  test("a key a PC holds a removal against is never carried, whatever the service lists", async () => {
    const { phone, laptop, pc, world } = await inUse();
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptop.signIn] });
    phone.answers.set(world.account, pc.endpoint, { account: world.account, pinned: null, admits: [{ key: phone.signIn, ...OLD }, { key: laptop.signIn, ...OLD }], removed: [laptop.signIn] });
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(listView(world.held().state).devices.some((row) => row.key === laptop.signIn)).toBe(false);
  });
});

describe("a device that was carried in", () => {
  test("its PCs let in the key that started the list: it follows, hands its place to its member key, and says so once", async () => {
    const { laptop, phone, pc, world } = await moved();
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    // the hand-over is placed with the link of its member key to its sign-in key
    const handed = laptop.device.sent.find((one) => one.route === `POST /v2/lists/${world.held().id}/entries`);
    expect(handed?.body?.link).toBeDefined();
    await laptop.device.list.sync();
    const rows = listView(world.held().state).devices.filter((row) => row.ended === null).map((row) => row.key);
    expect(rows.sort()).toEqual([phone.member, laptop.member].sort());
    const notice = readNotice(await laptop.device.lists.get("notice" as never, world.account));
    expect(notice).toMatchObject({ first: phone.signIn, pcs: [pc.endpoint], seen: false });
  });

  test("after its hand-over, its copy is its own by the member key it handed to: forgetting by that key drops it, and another account sees the key held", async () => {
    const { laptop, world } = await moved();
    await laptop.device.list.sync();
    await laptop.device.list.sync({ read: true });
    const copy = await laptop.device.lists.get("copy", world.account);
    const read = await readSave(copy as string);
    // the copy stays pinned under the sign-in key it was carried in by, which the list shows handed to the member key
    expect(read.read && read.copy.me.key).toBe(laptop.signIn);
    expect(await laptop.device.list.pinnedElsewhere("acct_other", laptop.member)).toBe(world.account);
    // another key's forget keeps it
    await laptop.device.list.forget(world.account, (await newKey()).public_spki);
    expect(await laptop.device.lists.get("copy", world.account)).toBe(copy);
    await laptop.device.list.forget(world.account, laptop.member);
    expect(await laptop.device.lists.get("copy", world.account)).toBeUndefined();
  });

  test("once it has put itself out of the list, its copy goes with the member key it left by, though no read showed the removal", async () => {
    const { laptop, world } = await moved();
    await laptop.device.list.sync();
    await laptop.device.list.sync({ read: true });
    // the removal is placed and the sign-in ends with it: no read follows, so whether it counted is not known
    expect(await leaveList(laptop.device.list, world.account, { wait: async () => {} })).toMatchObject({ removed: false, why: "unknown" });
    expect(readBody(entryFromText(world.held().entries.at(-1)!).body).kind).toBe("remove");
    expect(await laptop.device.lists.get("copy", world.account)).toBeDefined();
    await laptop.device.list.forget(world.account, laptop.member);
    expect(await laptop.device.lists.get("copy", world.account)).toBeUndefined();
  });

  test("put out by another member after its hand-over, and shown so by a read: its copy goes with the member key that was put out", async () => {
    const { laptop, phone, world } = await moved();
    await laptop.device.list.sync();
    await laptop.device.list.sync({ read: true });
    await phone.device.list.sync({ read: true });
    expect(await removeOthers(phone.device.list, world.account, [laptop.member], { wait: async () => {} })).toEqual({ removed: true });
    // the service signs the laptop out with its removal: it learns of it from a peer, as a copy that shows it out
    await phone.device.list.sync({ read: true });
    const shown = await readSave((await phone.device.lists.get("copy", world.account)) as string);
    const own = await readSave((await laptop.device.lists.get("copy", world.account)) as string);
    if (!shown.read || !own.read) throw new Error("a copy did not read");
    // nothing stands for its sign-in key any more: only the hand-over ties the copy to the member key put out
    expect(own.copy.me.key).toBe(laptop.signIn);
    expect(shown.copy.state!.signers[laptop.member]?.ended).not.toBeNull();
    expect(standsFor(shown.copy.state!, laptop.signIn)).toBeNull();
    await laptop.device.lists.set("copy", world.account, writeSave({ ...shown.copy, me: own.copy.me, pin: own.copy.pin }));
    await laptop.device.list.forget(world.account, laptop.member);
    expect(await laptop.device.lists.get("copy", world.account)).toBeUndefined();
  });

  test("a list the account service made with a key of its own is refused: the PCs never let that key in", async () => {
    const { laptop, pc, world } = await inUse();
    const forged = await world.fake.forgeBirth(world.account, { endpoints: [pc.endpoint] });
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "not_in", list: forged, why: "not_mine", refused: { why: "first_signer_unknown", pcs: [pc.endpoint] } });
    expect(laptop.device.sent.some((one) => one.route === `POST /v2/lists/${forged}/entries`)).toBe(false);
  });

  test("a PC it knows follows another list: it refuses and names that PC", async () => {
    const { laptop, pc, world } = await moved();
    laptop.answers.set(world.account, pc.endpoint, { account: world.account, pinned: "ab".repeat(32), admits: [], removed: [] });
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "not_in", why: "not_mine", refused: { why: "other_list", pcs: [pc.endpoint] } });
  });

  test("a PC it knows has not answered: it waits, and goes by those that did three days after its first try", async () => {
    const moving = movingWorld();
    const setting = await inUse(moving, { silent: true });
    // the phone went by the PC that answered, three days after its own first try
    setting.phone.record(setting.phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    await setting.phone.device.list.sync();
    const waiting = await setting.laptop.device.list.sync();
    expect(waiting.status).toMatchObject({ at: "not_in", why: "carried", join: { why: "pcs_silent", wait: MIGRATION_ANSWER_SECONDS, pcs: [setting.silent!.endpoint] } });
    expect(setting.laptop.kept()?.tried).toBe(moving.seconds());
    setting.laptop.record(setting.laptop.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await setting.laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(setting.laptop.kept()?.tried).toBeUndefined();
  });
});

describe("what a device that follows its moved list says to a PC that follows none", () => {
  test("a naming of the list by its member key, bound to the session's key and the PC, and a vouch of its sign-in key", async () => {
    const { phone, pc, world } = await moved();
    const said = await phone.device.list.naming!({ account: world.account, session: phone.signIn, endpoint: pc.endpoint, signIn: phone.signIn });
    expect(said).not.toBeNull();
    const held = await heldNaming(world.account, pc.endpoint, phone.signIn, said!.naming);
    expect(held).toEqual({ list: world.held().id, key: phone.member, session: phone.signIn });
    expect(await heldVouches(world.account, world.held().id, said!.vouches)).toEqual([{ key: phone.member, device: phone.signIn }]);
  });

  test("a list that was never moved names nothing to any PC", async () => {
    const world = listWorld();
    const phone = await world.device({ label: "Phone" });
    await phone.list.sync();
    const pc = await askingPc();
    expect(await phone.list.naming!({ account: world.account, session: (await phone.keys()).key, endpoint: pc.endpoint, signIn: null })).toBeNull();
  });
});

describe("a PC the move carried in with no key, met over a session while it follows the list", () => {
  /** The PC's own answer to `POST /api/account/list/card` over the session (W4), after it posted those keys for the list. */
  const cardWire = (card: { key: string; enc: string; card: string; endpoint: string; list: string }) => async (path: string, init?: RequestInit): Promise<Response> =>
    path === "/api/account/list/card" && init?.method === "POST" ? Response.json(card) : Response.json({ error: { code: "not_found" } }, { status: 404 });

  test("a device that paired with it at the PC signs its `pc` entry with the card the PC gave over the session", async () => {
    const { phone, pc, world } = await moved();
    const list = world.held().id;
    const card = await postPcKeys(world.fake.fetch, world.origin, phone.device.session.access_token, pc, list);
    const added = await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: pc.key, enc: pc.enc, card, endpoint: pc.endpoint, list }), account: world.account, endpoint: pc.endpoint, record: phone.kept()!, names: null });
    expect(added).toBe("added");
    const row = listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint);
    expect(row).toMatchObject({ key: pc.key, removed: null });
  });

  test("a device that only opened it signs nothing: that PC gets its keys by the number at it", async () => {
    const { phone, pc, world } = await moved();
    const list = world.held().id;
    const card = await postPcKeys(world.fake.fetch, world.origin, phone.device.session.access_token, pc, list);
    const none = { ...phone.kept()!, pcs: { [pc.endpoint]: { since: 1, last: 2, how: "none" as const } } };
    expect(await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: pc.key, enc: pc.enc, card, endpoint: pc.endpoint, list }), account: world.account, endpoint: pc.endpoint, record: none, names: null })).toBe("no_evidence");
    expect(listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint)?.key).toBeNull();
  });

  test("a card for another relay key, another list, or one that does not hold, is no card", async () => {
    const { phone, pc, world } = await moved();
    const list = world.held().id;
    const card = await postPcKeys(world.fake.fetch, world.origin, phone.device.session.access_token, pc, list);
    const other = await askingPc();
    for (const shown of [{ endpoint: other.endpoint, list }, { endpoint: pc.endpoint, list: "ab".repeat(32) }]) {
      expect(await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: pc.key, enc: pc.enc, card, ...shown }), account: world.account, endpoint: pc.endpoint, record: phone.kept()!, names: null })).toBe("no_card");
    }
    expect(await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: other.key, enc: pc.enc, card, endpoint: pc.endpoint, list }), account: world.account, endpoint: pc.endpoint, record: phone.kept()!, names: null })).toBe("no_card");
    expect(listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint)?.key).toBeNull();
  });
});

describe("the one-time notice of the move", () => {
  test("who made the list and whom it carried in, each by the key that stands for it now, until the person saw it", async () => {
    const { phone, laptop, pc, world } = await moved();
    const first = await phone.device.list.notice!(world.account);
    expect(first).toMatchObject({ list: world.held().id, first: { self: true }, devices: [{ key: laptop.signIn }], pcs: [{ endpoint: pc.endpoint }] });
    // the laptop follows and hands its place on: the phone's notice names it by its member key from then on
    await laptop.device.list.sync();
    await laptop.device.list.sync();
    await phone.device.list.sync({ read: true });
    // a carried device's name is sealed only where the account service names it (GET /v1/devices carries no label yet)
    // the name the birth sealed for it stays its name after its hand-over (astra-migapp, others)
    expect((await phone.device.list.notice!(world.account))?.devices).toEqual([{ key: laptop.member, name: { label: "Laptop", os: null } }]);
    const theirs = await laptop.device.list.notice!(world.account);
    expect(theirs).toMatchObject({ first: { self: false, key: phone.member }, devices: [], pcs: [{ endpoint: pc.endpoint }] });
    await phone.device.list.noticeSeen!(world.account, world.held().id);
    expect(await phone.device.list.notice!(world.account)).toBeNull();
    expect(await laptop.device.list.notice!(world.account)).not.toBeNull();
  });
});

describe("a carried device before its hand-over is placed", () => {
  test("is in its list by its sign-in key: that is the row of its own (R-E), whatever key it goes on with later", async () => {
    const { laptop, world } = await moved();
    // the hand-over does not get through yet: the account service is busy
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "list_rebuilding", message: "x" } }, { status: 503, headers: { "retry-after": "1" } }) : null;
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    expect(view.devices.filter((row) => row.self).map((row) => row.key)).toEqual([laptop.signIn]);
    // once it is placed, the row of its own is its account key's
    laptop.device.wire.answer = null;
    await laptop.device.list.sync();
    const after = await laptop.device.list.sync({ read: true });
    expect(after.devices.filter((row) => row.self).map((row) => row.key)).toEqual([laptop.member]);
    void world;
  });
});

describe("a device that followed a list its PCs turn out not to know (V4-6)", () => {
  /** The laptop joins three days after its first try, going by the one PC that answered; the other was silent then. */
  async function joinedOnOnePc() {
    const moving = movingWorld();
    const setting = await inUse(moving, { silent: true });
    setting.phone.record(setting.phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    await setting.phone.device.list.sync();
    setting.laptop.record(setting.laptop.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    const joined = await setting.laptop.device.list.sync();
    expect(joined.status).toMatchObject({ at: "following", standing: "in" });
    return { ...setting, joined };
  }

  test("it goes on asking the PC that was silent when it joined", async () => {
    const { joined, silent } = await joinedOnOnePc();
    expect(joined.status).toMatchObject({ at: "following", asks: [silent!.endpoint] });
    expect(joined.status).not.toHaveProperty("doubt");
  });

  test("that PC lets in the key that started the list: nothing is wrong, and it is asked no more", async () => {
    const { laptop, phone, silent, world, answer } = await joinedOnOnePc();
    laptop.answers.set(world.account, silent!.endpoint, answer([{ key: phone.signIn }]));
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in", trouble: null });
    expect(view.status).not.toHaveProperty("doubt");
    expect(view.status).not.toHaveProperty("asks");
  });

  test("that PC never let the key that started the list in: the device says so, names the list to no PC, and its reset leads to an Allow", async () => {
    const { laptop, silent, pc, world, answer } = await joinedOnOnePc();
    laptop.answers.set(world.account, silent!.endpoint, answer([]));
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in", doubt: { why: "first_signer_unknown", pcs: [silent!.endpoint] } });
    expect(await laptop.device.list.naming!({ account: world.account, session: laptop.signIn, endpoint: pc.endpoint, signIn: laptop.signIn })).toBeNull();
    // the person resets this device's copy: it follows that list no more, says why, and asks to be let in as a new device does
    await laptop.device.list.forget(world.account);
    const reset = await laptop.device.list.sync();
    expect(reset.status).toMatchObject({ at: "not_in", why: "not_mine", refused: { why: "first_signer_unknown", pcs: [silent!.endpoint] } });
  });

  test("a PC it knows follows another list of the account: the device says which", async () => {
    const { laptop, pc, world } = await joinedOnOnePc();
    laptop.answers.set(world.account, pc.endpoint, { account: world.account, pinned: "ab".repeat(32), admits: [], removed: [] });
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", doubt: { why: "other_list", pcs: [pc.endpoint] } });
  });

  test("while a PC it knows says against its list, it hands its place on to no member key; once none does, it does (review U2)", async () => {
    const moving = movingWorld();
    const setting = await inUse(moving, { silent: true });
    const { laptop, phone, world } = setting;
    const silent = setting.silent!;
    phone.record(phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    await phone.device.list.sync();
    laptop.record(laptop.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    // the join's hand-over gets no answer: it is kept, to be sent again
    const handOvers = () => laptop.device.sent.filter((one) => one.route === `POST /v2/lists/${world.held().id}/entries`).length;
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }) : null;
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    laptop.device.wire.answer = null;
    const tried = handOvers();
    laptop.answers.set(world.account, silent.endpoint, moving.answer([]));
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", doubt: { why: "first_signer_unknown" } });
    expect(handOvers()).toBe(tried);
    laptop.answers.set(world.account, silent.endpoint, moving.answer([{ key: phone.signIn }]));
    expect((await laptop.device.list.sync()).status).not.toHaveProperty("doubt");
    expect(handOvers()).toBeGreaterThan(tried);
  });

  test("a device that started the list, or was let in by an Allow, is asked nothing of this", async () => {
    const { phone } = await joinedOnOnePc();
    const view = await phone.device.list.sync();
    expect(view.status).not.toHaveProperty("asks");
    expect(view.status).not.toHaveProperty("doubt");
  });
});

/** The Codex read of the app's part (astra-migapp.md) and the lead's rulings on it: each a failing test first. */
describe("one birth per account on a device, whatever happens to its answer (astra-migapp 1, 3, 4, 6, 7)", () => {
  test("1: two tabs with no Web Locks sign one birth between them; the one that lost sends the winner's bytes, and both follow the list", async () => {
    const { phone, world, birthsSent } = await inUse();
    const other = phone.tab();
    const [one, two] = await Promise.all([phone.device.list.sync(), other.sync()]);
    const bodies = birthsSent(phone.device).map((sent) => JSON.stringify(sent.body));
    expect(new Set(bodies).size).toBe(1);
    const list = world.held().id;
    const settled = [await phone.device.list.sync(), await other.sync()];
    for (const view of [one, two, ...settled].slice(2)) expect(view.status).toMatchObject({ at: "following", standing: "in", list });
  });

  test("3: an answer that is not the exact success keeps the birth and drops nothing: the device follows the list it made", async () => {
    const { phone, world, birthsSent } = await inUse();
    phone.device.wire.answer = async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      const placed = await world.fake.fetch(request);
      return new Response(await placed.text(), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    expect(readBirth(await phone.device.lists.get("birth", world.account))).not.toBeNull();
    expect(await phone.device.lists.get("dropped", world.account)).toBeUndefined();
    phone.device.wire.answer = null;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    expect(birthsSent(phone.device)).toHaveLength(1);
  });

  test("3: a list_exists that names no list is no answer either", async () => {
    const { phone, world } = await inUse();
    phone.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname === "/v2/lists"
      ? Response.json({ error: { code: "list_exists", message: "x" } }, { status: 409 }) : null;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    expect(readBirth(await phone.device.lists.get("birth", world.account))).not.toBeNull();
    expect(await phone.device.lists.get("dropped", world.account)).toBeUndefined();
  });

  test("a refusal of the caller, and a 400 that names nothing, keep the birth as it is and give nothing up (review M3)", async () => {
    const answers: (() => Response)[] = [
      () => Response.json({ error: { code: "frozen", message: "x" } }, { status: 403 }),
      () => Response.json({ error: { code: "own_sign_in_required", message: "x" } }, { status: 403 }),
      () => Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 }),
      () => new Response("<html>bad gateway</html>", { status: 400, headers: { "content-type": "text/html" } }),
    ];
    for (const answer of answers) {
      const { phone, world, birthsSent } = await inUse();
      phone.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname === "/v2/lists" ? answer() : null;
      expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
      expect(readBirth(await phone.device.lists.get("birth", world.account))).not.toBeNull();
      expect(await phone.device.lists.get("dropped", world.account)).toBeUndefined();
      phone.device.wire.answer = null;
      expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
      expect(new Set(birthsSent(phone.device).map((sent) => JSON.stringify(sent.body))).size).toBe(1);
    }
  });

  test("a device whose storage may be cleared signs no new birth, and says why; a birth it kept already is still sent (#4652)", async () => {
    let lasts = false;
    const { phone, world, birthsSent } = await inUse(undefined, { durable: () => lasts });
    expect((await phone.device.list.sync()).status).toEqual({ at: "none", why: "storage" });
    expect(birthsSent(phone.device)).toEqual([]);
    // signed and kept while its storage lasted, the request lost; then the storage may be cleared
    lasts = true;
    phone.device.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v2/lists") throw new TypeError("the request never arrived");
      return null;
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    phone.device.wire.answer = null;
    lasts = false;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    expect(new Set(birthsSent(phone.device).map((sent) => JSON.stringify(sent.body))).size).toBe(1);
  });

  test("a kept birth that carries a key this device has since blocked waits for the service's answer to the block, then goes as it is (#4652)", async () => {
    const { phone, laptop, world, birthsSent } = await inUse();
    phone.device.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v2/lists") throw new TypeError("the request never arrived");
      return null;
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    phone.device.wire.answer = null;
    const first = birthsSent(phone.device).map((sent) => JSON.stringify(sent.body));
    // Not me on the laptop: its block is kept before it goes to the account service, which has not answered yet
    const block = { v: 1, kind: "block", id: "e".repeat(64), account: world.account, target: laptop.signIn, target_no: 2, signer: phone.signIn, signer_no: 1, signed_at: "2026-11-25T00:00:00Z", nonce: "n", signature: "s" } as never;
    expect(await keepUnsent(phone.device.store, phone.device.session, [block])).toBe(true);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    expect(birthsSent(phone.device).map((sent) => JSON.stringify(sent.body))).toEqual(first);
    // the service answered the block: the birth goes, byte for byte
    await postKept(phone.device.store, phone.device.session, [block], async () => {});
    await phone.device.list.sync();
    expect(birthsSent(phone.device).map((sent) => JSON.stringify(sent.body))).toEqual([...first, first[0]!]);
  });

  test("4: with the migrate switch withdrawn, a kept birth is kept as it is and not sent", async () => {
    const { phone, world, birthsSent } = await inUse();
    let dropped = false;
    phone.device.wire.answer = (request) => {
      if (dropped || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      dropped = true;
      throw new TypeError("the request never arrived");
    };
    await phone.device.list.sync();
    const kept = readBirth(await phone.device.lists.get("birth", world.account));
    expect(kept).not.toBeNull();
    world.fake.listMigrateAccounts = "";
    phone.device.wire.answer = null;
    const view = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(view.status).toMatchObject({ at: "none", why: "moving", move: { why: "paused" } });
    expect(readBirth(await phone.device.lists.get("birth", world.account))).toEqual(kept);
    // the switch back on: those very bytes go
    world.fake.listMigrateAccounts = world.account;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(JSON.stringify(birthsSent(phone.device)[1]!.body)).toBe(JSON.stringify(birthsSent(phone.device)[0]!.body));
  });

  test("6: a log read that fails after the 201 decides nothing: the birth stays until the copy holds it whole, and the notice names everybody", async () => {
    const { phone, laptop, pc, world } = await inUse();
    let failed = false;
    phone.device.wire.answer = (request) => {
      const url = new URL(request.url);
      if (failed || request.method !== "GET" || !url.pathname.endsWith("/log") || url.searchParams.get("after") === null) return null;
      failed = true;
      return Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 });
    };
    const first = await phone.device.list.sync();
    expect(first.status).not.toMatchObject({ at: "following" });
    expect(readBirth(await phone.device.lists.get("birth", world.account))).not.toBeNull();
    expect(await phone.device.lists.get("notice", world.account)).toBeUndefined();
    phone.device.wire.answer = null;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(readNotice(await phone.device.lists.get("notice", world.account))).toMatchObject({ devices: [laptop.signIn], pcs: [pc.endpoint] });
  });

  test("6: a carried device whose read of the list fails is not refused: it reads again at the next round", async () => {
    const { laptop } = await moved();
    let failed = false;
    laptop.device.wire.answer = (request) => {
      const url = new URL(request.url);
      if (failed || request.method !== "GET" || !url.pathname.endsWith("/log") || url.searchParams.get("limit") === "2") return null;
      failed = true;
      return Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 });
    };
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "not_in", why: "unread" });
    laptop.device.wire.answer = null;
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  });

  test("7: a storage fault right after a final refusal is written never sends the refused bytes again", async () => {
    const { phone, laptop, world, birthsSent } = await inUse();
    world.fake.removeDevice(world.account, laptop.signIn);
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptop.signIn] });
    // every write after the refusal's first one fails, as when the page is closed in the middle
    const lists = phone.device.lists;
    let refusedAt: number | null = null;
    const faulty: ListStore = {
      get: (record, account) => lists.get(record, account),
      accounts: () => lists.accounts(),
      drop: (account, copy) => lists.drop(account, copy),
      async set(record, account, value) {
        if (refusedAt !== null) throw new Error("the page went");
        await lists.set(record, account, value);
        // a refusal kept in a record of its own, before the birth is let go
        if ((record as string) === "move" && value !== undefined) refusedAt = Date.now();
      },
      async swap(record, account, expected, value) {
        if (refusedAt !== null) throw new Error("the page went");
        const done = await lists.swap(record, account, expected, value);
        if (done && record === "birth" && value.includes("refused_at")) refusedAt = Date.now();
        return done;
      },
    };
    const tab = phone.tab(faulty);
    await tab.sync().catch(() => undefined);
    expect(birthsSent(phone.device)).toHaveLength(1);
    await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
  });

  test("7: a clock that moved back counts as no time passed: the hour after a final refusal is waited out", async () => {
    const { phone, laptop, world, birthsSent } = await inUse();
    world.fake.removeDevice(world.account, laptop.signIn);
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptop.signIn] });
    await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    world.clock.now -= 1000;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "refused", wait: MOVE_AGAIN_SECONDS } });
    expect(birthsSent(phone.device)).toHaveLength(1);
  });
});

describe("a carried device's hand-over across a sign-in or a key that changed (astra-migapp 2)", () => {
  const busy = (request: Request): Response | null => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
    ? Response.json({ error: { code: "list_rebuilding", message: "x" } }, { status: 503, headers: { "retry-after": "1" } }) : null;

  test("a sign-in that changes after the hand-over was placed and before it was read keeps the copy: the next read shows the device in by its account key", async () => {
    const { laptop, world } = await moved();
    await laptop.device.list.sync();
    // signed in again: another key registered for the same account, before this device read its own hand-over
    const session = (await laptop.device.store.get("session"))!;
    await laptop.device.store.set("signin_key", { account: world.account, sign_in_id: session.sign_in_id!, key: await newKey(), no: 9 });
    const view = await laptop.device.list.sync({ read: true });
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    expect(view.devices.filter((row) => row.self).map((row) => row.key)).toEqual([laptop.member]);
  });

  test("a hand-over kept for one account key is not sent for another: it ends, and the key the device holds now is the one handed to", async () => {
    const { laptop, world } = await moved();
    laptop.device.wire.answer = busy;
    await laptop.device.list.sync();
    // the device's account key changes while that hand-over waits (its sign-in key stays)
    const kept = (await laptop.device.store.get("signin_key"))!;
    const session = (await laptop.device.store.get("session"))!;
    await laptop.device.store.clear(() => true);
    await laptop.device.store.set("session", session);
    await laptop.device.store.set("signin_key", kept);
    const renewed = (await laptop.device.store.key()).public_spki;
    expect(renewed).not.toBe(laptop.member);
    laptop.device.wire.answer = null;
    await laptop.device.list.sync();
    await laptop.device.list.sync({ read: true });
    const held = listView(world.held().state).devices.filter((row) => row.ended === null).map((row) => row.key);
    expect(held).not.toContain(laptop.member);
    expect(held).toContain(renewed);
  });
});

describe("a carried device whose copy holds a fork alarm (#4652)", () => {
  test("signs and sends no hand-over while the alarm stands", async () => {
    const { laptop, world } = await moved();
    const handOvers = () => laptop.device.sent.filter((one) => one.route === `POST /v2/lists/${world.held().id}/entries`).length;
    // the join's hand-over gets no answer: it is kept, to be sent again at the next round
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }) : null;
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    laptop.device.wire.answer = null;
    const tried = handOvers();
    // the copy holds the alarm another history a member signed leaves (read by a page of its own, as after a reload)
    const saved = await readSave(await laptop.device.lists.get("copy", world.account) as string);
    if (!saved.read || saved.copy.state === null) throw new Error("the laptop saved no copy");
    const alarm = { code: "fork" as const, source: "service" as const, seq: saved.copy.state.footing.seq, by: saved.copy.me.key, at: Math.floor(world.clock.now / 1000), devices: [], pcs: [] };
    await laptop.device.lists.set("copy", world.account, writeSave({ ...saved.copy, alarm }));
    const page = laptop.tab();
    expect((await page.sync()).status).toMatchObject({ at: "following", trouble: "fork" });
    expect(handOvers()).toBe(tried);
  });
});

describe("the planner hears every witness it heard (astra-migapp 5)", () => {
  test("a PC the directory omits still counts as a witness: its removal keeps a key out, and it is not carried", async () => {
    const moving = movingWorld();
    const { phone, laptop, world } = await inUse(moving);
    const hidden = await askingPc();
    phone.record({ ...phone.kept()!.pcs, [hidden.endpoint]: { since: moving.seconds() - 40 * DAY, last: moving.seconds(), how: "paired" } });
    phone.answers.set(world.account, hidden.endpoint, moving.answer([{ key: phone.signIn }, { key: laptop.signIn }], { removed: [laptop.signIn] }));
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    const rows = listView(world.held().state);
    expect(rows.devices.some((row) => row.key === laptop.signIn)).toBe(false);
    expect(rows.pcs.some((row) => row.endpoint === hidden.endpoint)).toBe(false);
  });
});

describe("naming by the key the list holds now (astra-migapp 8)", () => {
  test("a carried device whose hand-over is not placed yet names its list by its sign-in key", async () => {
    const { laptop, pc, world } = await moved();
    laptop.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "list_rebuilding", message: "x" } }, { status: 503, headers: { "retry-after": "1" } }) : null;
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    const said = await laptop.device.list.naming!({ account: world.account, session: laptop.signIn, endpoint: pc.endpoint, signIn: laptop.signIn });
    expect(said).not.toBeNull();
    expect(await heldNaming(world.account, pc.endpoint, laptop.signIn, said!.naming)).toEqual({ list: world.held().id, key: laptop.signIn, session: laptop.signIn });
    expect(said!.vouches).toEqual([]);
  });

  test("a naming asked for another account than the one the device follows now is none", async () => {
    const { phone, pc, world } = await moved();
    expect(await phone.device.list.naming!({ account: "acct_other", session: phone.signIn, endpoint: pc.endpoint, signIn: phone.signIn })).toBeNull();
    expect(await phone.device.list.naming!({ account: world.account, session: phone.signIn, endpoint: pc.endpoint, signIn: phone.signIn })).not.toBeNull();
  });
});

/** Guards the independent review's mutants left standing (review-migrate-app.md, "Mutants"), each pinned. */
describe("the guards of a carried device's check, its asks and its sign-in", () => {
  const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
  const known = (n: number, says: PcAnswer | null, how: PcHow = "paired", seen: number | null = null): KnownPc => ({ endpoint: E(n), how, known: seen, says, names: null });

  test("listDoubt counts only the account's own PCs this device knows, spares one that agreed, and knows the starter by its heir too (M18 to M22)", async () => {
    const { phone, world, answer } = await moved();
    const { state } = world.held();
    const other = "ab".repeat(32);
    // an answer for another account, and one of a PC this device's own record does not vouch for, say nothing
    expect(listDoubt(state, [known(1, answer([], { account: "acct_else", pinned: other }))], [])).toBeNull();
    expect(listDoubt(state, [known(1, answer([], { pinned: other }), "none", 60)], [])).toBeNull();
    expect(listDoubt(state, [known(1, answer([], { pinned: other }))], [])).toEqual({ why: "other_list", pcs: [E(1)] });
    // a PC that agreed is no doubt for letting no key of the starter in now
    expect(listDoubt(state, [known(2, answer([]))], [E(2)])).toBeNull();
    expect(listDoubt(state, [known(2, answer([]))], [])).toEqual({ why: "first_signer_unknown", pcs: [E(2)] });
    // the member key the starter handed its place on to is the starter too
    expect(listDoubt(state, [known(3, answer([{ key: phone.member }]))], [])).toBeNull();
    expect(listDoubt(state, [known(3, answer([{ key: phone.member }], { removed: [phone.member] }))], [])).toEqual({ why: "first_signer_removed", pcs: [E(3)] });
  });

  test("pcAgrees asks a day by both counters of the starter's key, its shorter stretch where it is named twice (review L3)", async () => {
    const { phone, world, answer } = await moved();
    const { state } = world.held();
    expect(pcAgrees(state, answer([{ key: phone.member }]))).toBe(true);
    expect(pcAgrees(state, answer([{ key: phone.signIn }]))).toBe(true);
    expect(pcAgrees(state, answer([{ key: phone.member, wall: 60, ran: 60 }]))).toBe(false);
    expect(pcAgrees(state, answer([{ key: phone.member, wall: DAY, ran: 60 }]))).toBe(false);
    expect(pcAgrees(state, answer([{ key: phone.member, wall: 60, ran: DAY }]))).toBe(false);
    expect(pcAgrees(state, answer([{ key: phone.member }, { key: phone.member, wall: 60, ran: 60 }]))).toBe(false);
    expect(pcAgrees(state, answer([{ key: phone.member }], { removed: [phone.signIn] }))).toBe(false);
    expect(pcAgrees(state, answer([], { pinned: state.list }))).toBe(true);
    expect(pcAgrees(state, answer([{ key: phone.member }], { pinned: "ab".repeat(32) }))).toBe(false);
  });

  test("a carried device asks the PCs that have not agreed for three days after its join, and remembers the ones that did (A24, A25)", async () => {
    const moving = movingWorld();
    const setting = await inUse(moving, { silent: true });
    const { laptop, phone, world } = setting;
    const silent = setting.silent!;
    phone.record(phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    await phone.device.list.sync();
    laptop.record(laptop.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await laptop.device.list.sync()).status).toMatchObject({ at: "following", asks: [silent.endpoint] });
    // it agrees once; what it says later of the starter (it lets no key of it in) is no doubt from a PC that agreed
    laptop.answers.set(world.account, silent.endpoint, moving.answer([{ key: phone.signIn }]));
    expect((await laptop.device.list.sync()).status).not.toHaveProperty("asks");
    laptop.answers.set(world.account, silent.endpoint, moving.answer([]));
    expect((await laptop.device.list.sync()).status).not.toHaveProperty("doubt");
    // another device, joined the same way, whose PC stays silent: asked for three days, then no more (the join is
    // moved back rather than the clock, which the account service's sign-in would not outlive)
    const late = await inUse(movingWorld(), { silent: true });
    late.phone.record(late.phone.kept()!.pcs, late.seconds() - MIGRATION_ANSWER_SECONDS);
    await late.phone.device.list.sync();
    late.laptop.record(late.laptop.kept()!.pcs, late.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await late.laptop.device.list.sync()).status).toMatchObject({ asks: [late.silent!.endpoint] });
    const joined = readJoined(await late.laptop.device.lists.get("joined" as never, late.world.account))!;
    await late.laptop.device.lists.set("joined" as never, late.world.account, joinedRecord({ ...joined, at: joined.at - MIGRATION_ANSWER_SECONDS - 60 }));
    expect((await late.laptop.device.list.sync()).status).not.toHaveProperty("asks");
  });

  test("a start that waits asks only the PCs its own record vouches for, not one it was only shown, for less than a week (M08)", async () => {
    const moving = movingWorld();
    const { phone, silent } = await inUse(moving, { silent: true });
    const shown = await askingPc();
    phone.record({ ...phone.kept()!.pcs, [shown.endpoint]: { since: moving.seconds() - 60, last: moving.seconds() - 60, how: "none" } });
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", asks: [silent!.endpoint] } });
  });

  test("only a session signed in with this sign-in's key vouches for the account key (A28)", async () => {
    const { phone, pc, world } = await moved();
    const said = await phone.device.list.naming!({ account: world.account, session: phone.member, endpoint: pc.endpoint, signIn: phone.signIn });
    expect(said).not.toBeNull();
    expect(said!.vouches).toEqual([]);
  });

  test("a sign-in key the account service has not confirmed signs no birth (A35)", async () => {
    const { phone, birthsSent } = await inUse();
    const kept = (await phone.device.store.get("signin_key"))!;
    await phone.device.store.set("signin_key", { ...kept, no: null });
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "self_unlisted" } });
    expect(birthsSent(phone.device)).toEqual([]);
  });

  test("the keys of a carried PC are signed only for the account the device follows (C06)", async () => {
    const { phone, pc, world } = await moved();
    let asked = 0;
    const fetch = async (): Promise<Response> => { asked += 1; return Response.json({ error: { code: "not_found" } }, { status: 404 }); };
    expect(await keysForCarriedPc({ list: phone.device.list, fetch, account: "acct_other", endpoint: pc.endpoint, record: phone.kept()!, names: null })).toBe("blocked");
    expect(asked).toBe(0);
    expect(listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint)?.key).toBeNull();
  });
});

/**
 * A kept birth against a later Not me, as ruled on #4652 (b2): X5 stands, and once the device follows the list its birth
 * made, its first write there removes every key of its own blocks that the list holds.
 */
describe("a key this device blocked after its birth was signed, carried in all the same (#4652, b2)", () => {
  /** The phone keeps a birth that carries the laptop and whose request never arrives; then it blocks the laptop. */
  async function blockedAfterTheBirth(given: { readonly stored?: boolean } = {}) {
    const setting = await inUse();
    const { phone, laptop, world } = setting;
    if (given.stored === true) world.fake.tamperAccount(world.account, { withholdAnswer: true });
    else {
      phone.device.wire.answer = (request) => {
        if (request.method === "POST" && new URL(request.url).pathname === "/v2/lists") throw new TypeError("the request never arrived");
        return null;
      };
    }
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    phone.device.wire.answer = null;
    world.fake.untamperAccount(world.account);
    const block = { v: 1, kind: "block", id: "f".repeat(64), account: world.account, target: laptop.signIn, target_no: 2, signer: phone.signIn, signer_no: 1, signed_at: "2026-11-25T00:00:00Z", nonce: "n", signature: "s" } as never;
    expect(await keepUnsent(phone.device.store, phone.device.session, [block])).toBe(true);
    return { ...setting, block };
  }
  /** The kinds of the entries after the birth's, with who signed each. */
  const after = (texts: readonly string[], from: number) => texts.slice(from).map((text) => { const body = readBody(entryFromText(text).body); return { signer: body.signer, kind: readKind(body) }; });

  test("the block refused for good: the birth goes as it is, and the device's first entry in the list removes the laptop", async () => {
    const { phone, laptop, world, block, birthsSent } = await blockedAfterTheBirth();
    // the account service refuses the block for good: it never freezes the laptop's sign-in
    await postKept(phone.device.store, phone.device.session, [block], async () => { throw new AccountServiceError(403, "signer_not_older", "x"); });
    const view = await phone.device.list.sync();
    expect(new Set(birthsSent(phone.device).map((sent) => JSON.stringify(sent.body))).size).toBe(1);
    expect(view.status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    const born = (birthsSent(phone.device)[0]!.body!.entries as string[]).length + 1;
    const written = after(world.held().entries, born);
    expect(written[0]).toMatchObject({ signer: phone.member, kind: { kind: "remove", ends: laptop.signIn } });
    expect(written.slice(1).every((entry) => entry.kind?.kind === "epoch" || entry.kind?.kind === "remove")).toBe(true);
    expect(listView(world.held().state).devices.find((row) => row.key === laptop.signIn)?.ended).not.toBeNull();
  });

  test("the service placed the birth it was never sent again: the device follows it, and its first entry there removes the laptop", async () => {
    const { phone, laptop, world, birthsSent } = await blockedAfterTheBirth({ stored: true });
    // the block has no answer yet: the kept birth is held, but the service placed the first request all the same
    const view = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(view.status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
    const born = (birthsSent(phone.device)[0]!.body!.entries as string[]).length + 1;
    expect(after(world.held().entries, born)[0]).toMatchObject({ signer: phone.member, kind: { kind: "remove", ends: laptop.signIn } });
    // the notice says the laptop was removed, and offers no Not me on it
    const notice = await phone.device.list.notice!(world.account);
    expect(notice?.devices.map((row) => row.key)).not.toContain(laptop.signIn);
    expect(notice?.removed).toEqual([{ key: laptop.signIn, name: { label: "Laptop", os: null } }]);
  });

  test("until the removal is placed, the device signs nothing else in the list", async () => {
    const { phone, world, block } = await blockedAfterTheBirth();
    await postKept(phone.device.store, phone.device.session, [block], async () => { throw new AccountServiceError(403, "signer_not_older", "x"); });
    // the removal's request gets no answer
    phone.device.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }) : null;
    await phone.device.list.sync();
    expect(phone.device.list.writer()).toBeNull();
    phone.device.wire.answer = null;
    await phone.device.list.sync();
    expect(phone.device.list.writer()).not.toBeNull();
    const removals = phone.device.sent.filter((one) => one.route === `POST /v2/lists/${world.held().id}/entries`).map((one) => JSON.stringify(one.body));
    // kept and sent again as it is
    expect(removals.length).toBeGreaterThanOrEqual(2);
    expect(new Set(removals).size).toBe(1);
  });
});

