import { describe, expect, it } from "bun:test";
import { ListWriteError, signListEntries, signListEntry } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { addListPc, listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import { deviceListKeys } from "./listKeys.ts";
import { removeListPc } from "./listRemove.ts";
import { placeOf, resendWaiting, signedOn, writeToList } from "./listWrite.ts";
import { memoryAccountStore } from "./store.ts";

type World = ReturnType<typeof listWorld>;

const noWait = { wait: async () => {} };
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));

/** An account whose first device let a borrowed browser in: power `bound`, for a day. */
async function borrowed(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const browser = await w.device({ label: "A borrowed browser" });
  await browser.list.sync();
  const writer = first.list.writer()!;
  const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key !== writer.keys.key)!;
  const written = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: writer.issued_at + 86_400, enc: claim.enc, card: claim.card, sealed: null, rotates: false },
    { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
  await writer.service.placeEntries(writer.list, [written.text], []);
  await browser.list.adopt({ list: writer.list, ...placeOf(written.state) });
  expect(browser.list.view().status).toMatchObject({ at: "following", standing: "in" });
  return { w, first, browser };
}

describe("a device that may sign for nobody else", () => {
  it("has no writer, and has one for the removal of its own key alone", async () => {
    const { w, first, browser } = await borrowed();
    expect(browser.list.writer()).toBeNull();
    const own = browser.list.writer({ self: true });
    expect(own).toMatchObject({ list: w.held().id, account: w.account });
    expect(own!.keys.key).toBe((await browser.keys()).key);
    // and the device of power `full` gets the same writer either way
    expect(first.list.writer({ self: true })).toEqual(first.list.writer());
  });

  it("puts itself out through the one write loop, with the writer it is handed", async () => {
    const { w, first, browser } = await borrowed();
    const key = (await browser.keys()).key;
    const outcome = await writeToList(browser.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), { ...noWait, writer: () => browser.list.writer({ self: true }) });
    expect(outcome).toMatchObject({ written: true, list: w.held().id });
    expect(readBody(entryFromText(w.held().entries.at(-1)!).body)).toMatchObject({ kind: "remove", signer: key, ends: key });
    expect((await first.list.sync()).devices.map((device) => device.key)).toEqual([(await first.keys()).key]);
    expect(browser.list.view().status).toMatchObject({ at: "following", standing: "out" });
  });

  it("signs nothing for anybody else, whatever writer it is handed: the kinds refuse it", async () => {
    const { w, first, browser } = await borrowed();
    const before = w.held().entries.length;
    const outcome = await writeToList(browser.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: (await first.keys()).key }]) }), { ...noWait, writer: () => browser.list.writer({ self: true }) });
    expect(outcome).toEqual({ written: false, why: "refused", retryAfterMs: null });
    expect([placements(browser), w.held().entries.length]).toEqual([[], before]);
  });
});

describe("a write that is over once the account service took it", () => {
  it("reads nothing after the request, and is told the place it signed", async () => {
    const { browser } = await borrowed();
    const key = (await browser.keys()).key;
    let place: { seq: number; hash: string } | undefined;
    // the account service ends this device's sign-in with the placement: no read of the list answers after it
    browser.wire.answer = (request) => request.method === "GET" && placements(browser).length > 0 ? Response.json({ error: { code: "unauthorized", message: "" } }, { status: 401 }) : null;
    const outcome = await writeToList(browser.list, async (writer) => {
      const request = await signedOn(writer, [{ kind: "remove", ends: key }]);
      ({ place } = request);
      return { request };
    }, { ...noWait, writer: () => browser.list.writer({ self: true }), trustPlaced: true });
    expect(outcome).toMatchObject({ written: true, place: place! });
    expect(placements(browser).length).toBe(1);
  });

  it("without that word, a request the service took and a list that then does not read is no write", async () => {
    const { browser } = await borrowed();
    const key = (await browser.keys()).key;
    browser.wire.answer = (request) => request.method === "GET" && placements(browser).length > 0 ? new Response("away", { status: 503 }) : null;
    const outcome = await writeToList(browser.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), { ...noWait, writer: () => browser.list.writer({ self: true }) });
    expect(outcome.written).toBe(false);
  });
});

describe("a device that is behind", () => {
  it("says so where the kinds refuse to sign somebody in on what it holds, and sends nothing", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    const outcome = await writeToList(first.list, async (writer) => {
      const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key !== writer.keys.key)!;
      // what this device holds once a member of a later level wrote at place 1: the kinds sign nobody in on it
      const behind = { ...writer.state, behind: 1 };
      const signed = await signListEntries(behind, [{ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: false }],
        { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
      return { request: { entries: signed.entries.map((entry) => entry.text), wraps: [], place: placeOf(signed.state) } };
    }, noWait);
    expect(outcome).toEqual({ written: false, why: "behind", retryAfterMs: null });
    expect(placements(first)).toEqual([]);
    // any other entry the kinds do not sign stays a plain refusal
    expect(await writeToList(first.list, async () => { throw new ListWriteError(null, "not that key's card"); }, noWait)).toMatchObject({ written: false, why: "refused" });
  });
});

describe("a signed request that still waits, and another change", () => {
  /** A device in its list that let a second device in and has a third to let in, and a PC in the list to remove. */
  async function waitingAllow() {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const pc = await addListPc(w, first, "Desk");
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    const newcomer = { key: (await second.keys()).key, label: "Dana's tablet", os: "android" as const };
    // the service answers every placement `409 head_moved`, and the device's own read shows the same head: the Allow's request stays kept
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
    const kept = placements(first).at(-1)!.body!.entries as string[];
    return { w, first, second, pc, newcomer, kept };
  }
  const entriesSent = (from: WorldDevice): string[][] => placements(from).map((each) => each.body!.entries as string[]);

  it("is sent again by the same operation, and never by another: a Remove is refused while the Allow's request is younger than ten minutes", async () => {
    const { w, first, pc, newcomer, kept } = await waitingAllow();
    const before = placements(first).length;
    // another change, at the same head: nothing is signed and nothing of the Allow's is sent for it
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: false, why: "waiting", retryAfterMs: null });
    expect(placements(first).length).toBe(before);
    expect(await first.list.waiting()).toMatchObject({ for: `allow:${newcomer.key}` });
    // the same Allow, tried again, sends what it signed
    w.fake.untamperList(w.held().id);
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: true });
    expect(entriesSent(first).at(-1)).toEqual(kept);
    // and now the Remove goes
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: true });
  });

  it("is over once the head moved: another change is then signed on the new head, and the old request is never placed", async () => {
    const { w, first, pc, kept } = await waitingAllow();
    w.fake.untamperList(w.held().id);
    // another page of the account writes meanwhile: the head moves under the kept request
    const writer = first.list.writer()!;
    const invite = await deviceListKeys(memoryAccountStore());
    const moved = await signListEntry(writer.state, { kind: "invite", key: invite.key, exp: writer.issued_at + 600, uses: 1, auto: false, sealed: null }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [moved.text], []);
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: true });
    expect(w.held().entries).not.toContain(kept[0]);
    expect(await first.list.waiting()).toBeNull();
  });

  it("is sent again from the card of a change whose page is gone: Try again there sends what waits, as its own change", async () => {
    const { w, first, kept } = await waitingAllow();
    const shown = (await first.list.waiting())!;
    // still refused: it waits on
    expect(await resendWaiting(first.list, shown, noWait)).toBe(false);
    w.fake.untamperList(w.held().id);
    expect(await resendWaiting(first.list, shown, noWait)).toBe(true);
    expect([w.held().entries.at(-1), await first.list.waiting()]).toEqual([kept[0]!, null]);
    // with nothing waiting it sends nothing
    const before = placements(first).length;
    expect(await resendWaiting(first.list, shown, noWait)).toBe(true);
    expect(placements(first).length).toBe(before);
  });

  it("is dropped after ten minutes, or at the person's Cancel, and the other change is signed", async () => {
    const { w, first, pc, kept } = await waitingAllow();
    w.fake.untamperList(w.held().id);
    // nine minutes on it still waits
    w.clock.now += 9 * 60_000;
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toMatchObject({ removed: false, why: "waiting" });
    // past ten it is an attempt left behind: the Remove is signed on that head, and the Allow's request is never sent again
    w.clock.now += 2 * 60_000;
    expect(await removeListPc(first.list, pc.endpoint, noWait)).toEqual({ removed: true });
    expect(entriesSent(first).filter((entries) => entries[0] === kept[0])).toHaveLength(3);
    expect(await first.list.waiting()).toBeNull();

    const again = await waitingAllow();
    again.w.fake.untamperList(again.w.held().id);
    expect(await removeListPc(again.first.list, again.pc.endpoint, noWait)).toMatchObject({ removed: false, why: "waiting" });
    await again.first.list.cancel((await again.first.list.waiting())!);
    expect(await again.first.list.waiting()).toBeNull();
    expect(await removeListPc(again.first.list, again.pc.endpoint, noWait)).toEqual({ removed: true });
  });
});

describe("a write called off", () => {
  it("sends nothing once called off while it looked for an alarm right before the send", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const desk = await addListPc(w, first, "Desk");
    const before = placements(first).length;
    const off = new AbortController();
    let looks = 0;
    // the second look is the one right before the request goes: the person cancels while it reads the saved copy
    const writer = () => {
      const real = first.list.writer();
      return real === null ? null : { ...real, live: async () => { looks += 1; const live = await real.live(); if (looks === 2) off.abort(); return live; } };
    };
    const writing = removeListPc(first.list, desk.endpoint, { ...noWait, writer, signal: off.signal });
    expect(await writing.then(() => "went", (error: unknown) => error instanceof DOMException ? error.name : "other")).toBe("AbortError");
    expect([looks, placements(first).length]).toEqual([2, before]);
  });
});
