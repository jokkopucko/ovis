import { describe, expect, it } from "bun:test";
import { signCard } from "../../../shared/account-list.ts";
import { readJoinLine, writeJoinLine } from "../../../shared/account-list-join.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { askingPc, listWorld, postPcKeys, type AskingPc, type WorldDevice } from "./accountList.test-helpers.ts";
import type { ListPost } from "./listAnswers.ts";
import { lineChallenge } from "../../../shared/account-list-invite.ts";
import { listView, signListEntry } from "../../../shared/account-list.ts";
import { deviceListKeys } from "./listKeys.ts";
import { memoryAccountStore } from "./store.ts";
import type { AccountList } from "./accountList.ts";
import { addPostedPc } from "./listAdd.ts";
import { addInvitedPc, invitedPcs } from "./listInvited.ts";
import { invitesOf, makeInvite, revokeInvite, type MadeInvite } from "./listInvite.ts";

type World = ReturnType<typeof listWorld>;
const noWait = { wait: async () => {} };

/** A device that is in its list and made an invite that waits for Add, and a PC that holds the line. */
async function invited(auto = false) {
  const w = listWorld();
  const first = await w.device({ label: "Dana's Mac" });
  await first.list.sync();
  const made = await makeInvite(first.list, { auto, ...noWait });
  if (!made.made) throw new Error(`no invite was made: ${made.why}`);
  const pc = await askingPc();
  return { w, first, invite: made.invite, pc };
}

/** The PC's post as it reaches the device: its card for the list, and the line's proof that whoever holds the line named this very card. */
async function posted(w: World, first: WorldDevice, invite: MadeInvite, pc: AskingPc, more: { signedFor?: AskingPc } = {}): Promise<ListPost> {
  const list = first.list.writer()!.list;
  const card = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, pc.signs);
  const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
  const named = more.signedFor ?? pc;
  const proof = await line.signLineProof({ server_id: named.server_id, card: { key: named.key, enc: named.enc, endpoint: named.endpoint } });
  return { endpoint: pc.endpoint, server_id: pc.server_id, key: pc.key, enc: pc.enc, card, attempt: null, invite: invite.key, invite_proof: proof };
}

describe("a PC that joined with an invite a device of the account made", () => {
  it("is offered for Add only where the line itself signed for that PC's card, for an invite the list holds open that waits for Add", async () => {
    const { w, first, invite, pc } = await invited();
    const post = await posted(w, first, invite, pc);
    expect((await invitedPcs(first.list, [post], w.clock.now)).map((each) => [each.endpoint, each.invite, each.by])).toEqual([[pc.endpoint, invite.key, (await first.keys()).key]]);
  });

  it("is not offered on the account service's word: a post with no proof, another PC's proof, or a proof for another list", async () => {
    const { w, first, invite, pc } = await invited();
    const other = await askingPc();
    const good = await posted(w, first, invite, pc);
    const { invite: _key, invite_proof: _proof, ...bare } = good;
    for (const post of [
      bare,
      // the line signed for another PC, and the service shows that proof beside this PC's card
      await posted(w, first, invite, pc, { signedFor: other }),
      { ...good, invite_proof: "A".repeat(86) },
      // a key that is no invite of the list
      { ...good, invite: (await first.keys()).key },
    ] as ListPost[]) {
      expect(await invitedPcs(first.list, [post], w.clock.now)).toEqual([]);
    }
  });

  it("is not offered on a redeem signature of the line: a lying account service chooses the challenge of a redeem, so it could have the line sign the challenge of a card of its own", async () => {
    const { w, first, invite, pc } = await invited();
    const list = first.list.writer()!.list;
    // the service's own keys, under the PC's real relay key and id
    const service = await askingPc();
    const card = await signCard({ key: service.key, enc: service.enc, list, endpoint: pc.endpoint, invite: null }, service.signs);
    const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
    const redeemed = await line.signRedeem({ server_id: pc.server_id, public_key: pc.endpoint, challenge_id: lineChallenge(list, { key: service.key, enc: service.enc, endpoint: pc.endpoint }) });
    const lie: ListPost = { endpoint: pc.endpoint, server_id: pc.server_id, key: service.key, enc: service.enc, card, attempt: null, invite: invite.key, invite_proof: redeemed };
    expect(await invitedPcs(first.list, [lie], w.clock.now)).toEqual([]);
  });

  it("is not offered on the line's proof for another list, with this very invite's key", async () => {
    const { w, first, pc } = await invited();
    const list = first.list.writer()!.list;
    // an invite of this list whose private key the test holds, so the same key can sign for another list
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const here = await readJoinLine(await writeJoinLine(w.origin, w.account, list, pair.privateKey), { service: w.origin, followsLists: true });
    const elsewhere = await readJoinLine(await writeJoinLine(w.origin, w.account, "6d".repeat(32), pair.privateKey), { service: w.origin, followsLists: true });
    expect(elsewhere.key).toBe(here.key);
    const keys = await first.keys();
    const at = Math.floor(w.clock.now / 1000);
    const placed = await signListEntry(w.held().state, { kind: "invite", key: here.key, exp: at + 840, uses: 1, auto: false, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
    await first.service.placeEntries(w.held().id, [placed.text], []);
    await first.list.sync();
    const card = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, pc.signs);
    const post = (proof: string): ListPost => ({ endpoint: pc.endpoint, server_id: pc.server_id, key: pc.key, enc: pc.enc, card, attempt: null, invite: here.key, invite_proof: proof });
    const signed = (line: typeof here) => line.signLineProof({ server_id: pc.server_id, card: { key: pc.key, enc: pc.enc, endpoint: pc.endpoint } });
    // the same key's proof for this list is offered; for another list, it is not
    expect((await invitedPcs(first.list, [post(await signed(here))], w.clock.now)).map((each) => each.invite)).toEqual([here.key]);
    expect(await invitedPcs(first.list, [post(await signed(elsewhere))], w.clock.now)).toEqual([]);
  });

  it("is not offered for an invite that is over, was revoked, or lets a PC join by itself", async () => {
    const { w, first, invite, pc } = await invited();
    const post = await posted(w, first, invite, pc);
    expect(await invitedPcs(first.list, [post], (invite.exp + 1) * 1000)).toEqual([]);
    expect(await revokeInvite(first.list, invite.key, noWait)).toEqual({ revoked: true });
    expect(await invitedPcs(first.list, [post], w.clock.now)).toEqual([]);
    // an invite a PC joins with by itself needs no Add, and gives nobody one
    const auto = await invited(true);
    expect(await invitedPcs(auto.first.list, [await posted(auto.w, auto.first, auto.invite, auto.pc)], auto.w.clock.now)).toEqual([]);
  });
});

describe("Add for a PC that joined with an invite", () => {
  it("has the account admit the PC, signs its entry with no number, and ends the invite in the same request", async () => {
    const { w, first, invite, pc } = await invited();
    // the PC used the invite at the account service: it is listed, and waits to be admitted
    await w.fake.fetch(`${w.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${w.fake.issueToken(w.account, { device: true })}`, "content-type": "application/json" }, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }) });
    await postPcKeys(w.fake.fetch, w.origin, w.fake.issueToken(w.account, { device: true }), pc, first.list.writer()!.list);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    let admitted = 0;
    const outcome = await addInvitedPc(first.list, found!, { label: "Studio PC", os: "linux" }, { ...noWait, admit: async () => { admitted += 1; await first.service.admitPc(pc.server_id); } });
    expect([outcome, admitted]).toEqual([{ added: true }, 1]);
    const sent = first.sent.filter((each) => each.route.endsWith("/entries")).at(-1)!.body!.entries as string[];
    expect(sent.map((text) => readBody(entryFromText(text).body).kind)).toEqual(["pc", "remove"]);
    expect(first.list.view().pcs.map((row) => [row.endpoint, row.name?.label])).toEqual([[pc.endpoint, "Studio PC"]]);
    // the invite is spent: no second PC is offered for it, whatever proof is shown
    const other = await askingPc();
    expect(await invitedPcs(first.list, [await posted(w, first, invite, other)], w.clock.now)).toEqual([]);
    // and the device's screen of invites says it was used, not revoked
    expect(invitesOf(first.list, w.clock.now).map((row) => [row.key, row.state])).toEqual([[invite.key, "used"]]);
  });

  /** The PC used the invite at the account service: it is listed and posted its keys. */
  async function listedAndPosted(w: World, first: WorldDevice, pc: AskingPc): Promise<void> {
    await w.fake.fetch(`${w.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${w.fake.issueToken(w.account, { device: true })}`, "content-type": "application/json" }, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }) });
    await postPcKeys(w.fake.fetch, w.origin, w.fake.issueToken(w.account, { device: true }), pc, first.list.writer()!.list);
  }

  it("is done only once the invite ended too: a PC another Add placed meanwhile gets the invite's removal alone", async () => {
    const { w, first, invite, pc } = await invited();
    await listedAndPosted(w, first, pc);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    // the same PC was placed by an Add of its own (another tab's, by the number) before this press signed
    expect(await addPostedPc(first.list, found!, null, { ...noWait, admit: async () => { await first.service.admitPc(pc.server_id); } })).toEqual({ added: true });
    expect(listView(w.held().state).invites.map((row) => row.refusal)).toEqual([null]);
    expect(await addInvitedPc(first.list, found!, null, { ...noWait, admit: async () => {} })).toEqual({ added: true });
    const sent = first.sent.filter((each) => each.route.endsWith("/entries")).at(-1)!.body!.entries as string[];
    expect(sent.map((text) => readBody(entryFromText(text).body).kind)).toEqual(["remove"]);
    expect(listView(w.held().state).invites.map((row) => row.refusal)).toEqual(["invite_revoked"]);
  });

  it("reports nothing as its own where a Revoke took its place at the same head (C1)", async () => {
    const { w, first, invite, pc } = await invited();
    await listedAndPosted(w, first, pc);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    const entries = w.held().entries.length;
    let raced = false;
    // another page revokes the invite between this Add's look at the head and its own keep: the Revoke's request is
    // kept for that head (the account service turns it away for now), and this Add's keep gets it back
    const page: AccountList = { ...first.list, keep: async (writer, request) => {
      if (!raced) {
        raced = true;
        w.fake.tamperList(w.held().id, { headMoved: true });
        await revokeInvite(first.list, invite.key, noWait);
        w.fake.untamperList(w.held().id);
      }
      return first.list.keep(writer, request);
    } };
    expect(await addInvitedPc(page, found!, null, { ...noWait, admit: async () => {} })).toMatchObject({ added: false, why: "waiting" });
    expect(w.held().entries.length).toBe(entries);
    expect((await first.list.sync()).pcs).toEqual([]);
  });

  it("places the invite's removal in the very request that opens an epoch for the PC's entry (C5)", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's Mac" });
    await first.list.sync();
    // an invite a PC joins with by itself holds the epoch's key, and runs out unused within a minute: the next name
    // needs a new epoch
    const keys = await first.keys();
    const unusedKey = (await deviceListKeys(memoryAccountStore())).key;
    const at = Math.floor(w.clock.now / 1000);
    const unused = await signListEntry(w.held().state, { kind: "invite", key: unusedKey, exp: at + 60, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
    await first.service.placeEntries(w.held().id, [unused.text], []);
    await first.list.sync();
    w.clock.now += 2 * 60_000;
    const made = await makeInvite(first.list, { auto: false, ...noWait });
    if (!made.made) throw new Error(`${made.why} ${made.code}`);
    const pc = await askingPc();
    await listedAndPosted(w, first, pc);
    const [found] = await invitedPcs(first.list, [await posted(w, first, made.invite, pc)], w.clock.now);
    expect(await addInvitedPc(first.list, found!, { label: "Studio PC", os: "linux" }, { ...noWait, admit: async () => { await first.service.admitPc(pc.server_id); } })).toEqual({ added: true });
    const sent = first.sent.filter((each) => each.route.endsWith("/entries")).at(-1)!.body!.entries as string[];
    expect(sent.map((text) => readBody(entryFromText(text).body).kind)).toEqual(["remove", "epoch", "pc", "remove"]);
    expect(invitesOf(first.list, w.clock.now).find((row) => row.key === made.invite.key)?.state).toBe("used");
  });

  it("signs nothing where the member key is not the one the press was made with (C2)", async () => {
    const { w, first, invite, pc } = await invited();
    await listedAndPosted(w, first, pc);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    const entries = w.held().entries.length;
    let admitted = 0;
    expect(await addInvitedPc(first.list, found!, null, { ...noWait, admit: async () => { admitted += 1; }, member: "a-key-another-tab-replaced", expect: { account: w.account, list: found!.list } })).toMatchObject({ added: false, why: "changed" });
    expect([admitted, w.held().entries.length]).toEqual([0, entries]);
  });

  it("judges the invite again on the state it signs on: one that ran out while the admission was on its way signs nothing", async () => {
    const { w, first, invite, pc } = await invited();
    await listedAndPosted(w, first, pc);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    const entries = w.held().entries.length;
    const outcome = await addInvitedPc(first.list, found!, null, { ...noWait, admit: async () => { w.clock.now = (invite.exp + 1) * 1000; } });
    expect(outcome).toMatchObject({ added: false, why: "invite_ended" });
    expect(w.held().entries.length).toBe(entries);
  });
});
