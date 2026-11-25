import { describe, expect, it } from "bun:test";
import { readKind, signCard } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { askingPc, listWorld, type AskingPc } from "./accountList.test-helpers.ts";
import type { PcFetch } from "./join.ts";
import { NAMED_ASKS, nameListToPc } from "./listNamed.ts";

type World = ReturnType<typeof listWorld>;

/** A device in its account's list, and the PC whose QR code it scanned, as that PC answers over the pairing's session. */
async function scanned(w: World = listWorld()) {
  const phone = await w.device({ label: "Dana's phone" });
  await phone.list.sync();
  const pc = await askingPc();
  const asked: Record<string, unknown>[] = [];
  /** what the PC answers: its card for the list it is named, and `added` once the list holds its own key at its relay key */
  const answers = {
    status: 200 as number, code: "", card: null as string | null, key: pc.key, reads: true,
    /** the PC says at once that it read an entry, whatever the list holds */
    addedAtOnce: false,
    /** what the PC answers once the list holds its entry, in place of `added` */
    later: null as { readonly status: number; readonly code: string } | null,
    /** the PC's session drops once the list holds its entry: no answer at all */
    dropsLater: false,
  };
  const fetch: PcFetch = async (path, init) => {
    if (path !== "/api/account/list/named") return new Response(null, { status: 404 });
    const body = JSON.parse(String(init?.body)) as { account: string; list: string };
    asked.push(body);
    if (answers.status !== 200) return Response.json({ error: { code: answers.code } }, { status: answers.status });
    if (answers.addedAtOnce) return Response.json({ state: "added", account: body.account });
    const held = w.held();
    const row = held.state.pcs[pc.endpoint];
    if (row !== undefined && row.removed === null && row.key === pc.key && answers.dropsLater) throw new TypeError("The session ended");
    if (row !== undefined && row.removed === null && row.key === pc.key && answers.later !== null) return Response.json({ error: { code: answers.later.code } }, { status: answers.later.status });
    if (answers.reads && row !== undefined && row.removed === null && row.key === pc.key) return Response.json({ state: "added", account: body.account });
    const card = answers.card ?? await signCard({ key: pc.key, enc: pc.enc, list: body.list, endpoint: pc.endpoint, invite: null }, pc.signs);
    // as the PC does: it posts the same card to the account service (the second lock), listed by the scan's admission
    await postKeys(w, phone.session.access_token, pc, body.list);
    return Response.json({ state: "waiting", standing: "waiting", key: answers.key, enc: pc.enc, card });
  };
  const name = (more: Partial<Parameters<typeof nameListToPc>[0]> = {}) => nameListToPc({
    fetch, list: phone.list, account: w.account, endpoint: pc.endpoint, names: { label: "Desk", os: "linux" }, admit: async () => { admitted.push(pc.server_id); }, wait: async () => {}, ...more,
  });
  const admitted: string[] = [];
  return { w, phone, pc, asked, answers, admitted, name };
}

async function postKeys(w: World, bearer: string, pc: AskingPc, list: string): Promise<void> {
  const { postPcKeys } = await import("./accountList.test-helpers.ts");
  await postPcKeys(w.fake.fetch, w.origin, bearer, pc, list);
}

describe("naming the account's list to a PC whose QR code this device scanned", () => {
  it("takes the PC's card from the session, signs the PC into the list with it, and hears from the PC that it read the entry", async () => {
    const { w, phone, pc, asked, admitted, name } = await scanned();
    expect(await name()).toEqual({ outcome: "added" });
    expect(asked).toEqual([{ account: w.account, list: w.held().id }, { account: w.account, list: w.held().id }]);
    expect(admitted).toEqual([pc.server_id]);
    const body = readBody(entryFromText(w.held().entries.at(-1)!).body);
    expect([body.signer, readKind(body)]).toMatchObject([(await phone.keys()).key, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc }]);
    expect((await phone.list.sync()).pcs.map((row) => row.name?.label)).toEqual(["Desk"]);
  });

  it("says the entry is placed where the PC does not say in time that it read it, and asks it no more often than it counts", async () => {
    const { w, asked, answers, name } = await scanned();
    answers.reads = false;
    expect(await name()).toEqual({ outcome: "placed" });
    expect([asked.length, w.held().entries.length]).toEqual([NAMED_ASKS, 2]);
  });

  it("sends the link as before to a PC that has no such call, and signs nothing", async () => {
    const { w, admitted, answers, name } = await scanned();
    answers.status = 404;
    answers.code = "not_found";
    expect(await name()).toEqual({ outcome: "none" });
    expect([admitted, w.held().entries.length]).toEqual([[], 1]);
  });

  it("takes an older PC's 403 link_required at the first ask for no such call: its pairing's session lets only the status and the link through, and the link goes as before", async () => {
    const { w, admitted, answers, name } = await scanned();
    answers.status = 403;
    answers.code = "link_required";
    expect(await name()).toEqual({ outcome: "none" });
    expect([admitted, w.held().entries.length]).toEqual([[], 1]);
  });

  it("does not take the PC's word that it read an entry this device's own copy does not hold: nothing is spent and nothing signed", async () => {
    const { w, phone, admitted, answers, name } = await scanned();
    answers.addedAtOnce = true;
    expect(await name()).toEqual({ outcome: "refused", why: "not_in_list" });
    expect([admitted, w.held().entries.length, phone.list.holdsPc((await askingPc()).endpoint)]).toEqual([[], 1, false]);
  });

  it("says placed where the session drops at a later ask, once the entry is in the list: the pairing is not spent and no failure is recorded", async () => {
    const { w, answers, name } = await scanned();
    answers.dropsLater = true;
    expect(await name()).toEqual({ outcome: "placed" });
    expect(w.held().entries.length).toBe(2);
  });

  it("says not known yet where the PC says it read an entry and this device's copy cannot be read to tell", async () => {
    const { phone, answers, name } = await scanned();
    answers.addedAtOnce = true;
    // the log cannot be read: whether the list holds the PC is not known, never that it does not
    phone.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname.startsWith("/v2/") ? new Response("down", { status: 503 }) : null;
    expect(await name()).toEqual({ outcome: "unknown" });
  });

  it("says the PC's refusal at a later ask as a refusal, never as placed", async () => {
    const { w, answers, name } = await scanned();
    answers.later = { status: 409, code: "other_adder" };
    expect(await name()).toEqual({ outcome: "refused", why: "other_adder" });
    // the entry is in the list: the PC turned it away
    expect(w.held().entries.length).toBe(2);
  });

  it("signs nothing once the person cancelled: Cancel is checked after the admission, before anything is signed", async () => {
    const { w, admitted, name, pc } = await scanned();
    const cancel = new AbortController();
    const ended = await name({ signal: cancel.signal, admit: async () => { admitted.push(pc.server_id); cancel.abort(new DOMException("Cancelled", "AbortError")); } }).catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(DOMException);
    expect([admitted, w.held().entries.length]).toEqual([[pc.server_id], 1]);
  });

  it("signs nothing for a card that is not the PC's own for this list and this session's relay key", async () => {
    const { w, pc, admitted, answers, name } = await scanned();
    const other = await askingPc();
    // a card for another relay key, and a key that did not sign the card
    answers.card = await signCard({ key: pc.key, enc: pc.enc, list: w.held().id, endpoint: other.endpoint, invite: null }, pc.signs);
    expect(await name()).toEqual({ outcome: "refused", why: "card_invalid" });
    answers.card = null;
    answers.key = other.key;
    expect(await name()).toEqual({ outcome: "refused", why: "card_invalid" });
    // the session is bound to another PC's relay key than the card names
    answers.key = pc.key;
    expect(await name({ endpoint: other.endpoint })).toEqual({ outcome: "refused", why: "card_invalid" });
    expect([admitted, w.held().entries.length]).toEqual([[], 1]);
  });

  it("says what the PC refused, and signs nothing", async () => {
    const { w, answers, name } = await scanned();
    for (const [status, code] of [[409, "account_mismatch"], [409, "list_removed"], [409, "pairing_ended"], [503, "account_unavailable"]] as const) {
      answers.status = status;
      answers.code = code;
      expect(await name()).toEqual({ outcome: "refused", why: code });
    }
    expect(w.held().entries.length).toBe(1);
  });

  it("names nothing from a device that may not write to its list", async () => {
    const { w, asked, name } = await scanned();
    const waiting = await w.device({ label: "Tablet" });
    await waiting.list.sync();
    expect(await name({ list: waiting.list })).toEqual({ outcome: "none" });
    expect(asked).toEqual([]);
  });
});
