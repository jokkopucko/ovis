import { describe, expect, it } from "bun:test";
import { readKind, signCard } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { askingPc, listWorld, pcComparing, postPcKeys, type AskingPc, type WorldDevice } from "./accountList.test-helpers.ts";
import type { AccountList } from "./accountList.ts";
import { addPostedPc, numberWith, postedPcs, type AddNumber } from "./listAdd.ts";
import { allowDevice } from "./listAllow.ts";

type World = ReturnType<typeof listWorld>;

/** An account with a list and one device in it, and a PC that asks to be added: it posted its keys and its card. */
async function asking(w: World = listWorld()) {
  const phone = await w.device({ label: "Dana's phone" });
  await phone.list.sync();
  const pc = await askingPc();
  await postPcKeys(w.fake.fetch, w.origin, phone.session.access_token, pc, w.held().id);
  return { w, phone, pc, play: pcComparing(w, pc, w.held().id) };
}
/** The PC answers as soon as it is asked: every wait of the device is the PC's turn. */
const pcTurn = (play: ReturnType<typeof pcComparing>) => ({ wait: async () => { await play.answer(); } });
const shown = (outcome: Awaited<ReturnType<typeof numberWith>>): AddNumber => {
  if (!outcome.shown) throw new Error(`no number: ${outcome.why}`);
  return outcome.number;
};
const sentTo = (from: WorldDevice, suffix: string) => from.sent.filter((each) => each.route.endsWith(suffix));

describe("the PCs that ask to be added", () => {
  it("are those whose card holds for this device's list and their own relay key, and no other", async () => {
    const { w, phone, pc } = await asking();
    expect(await postedPcs(phone.list)).toEqual([{ list: w.held().id, endpoint: pc.endpoint, server_id: pc.server_id, key: pc.key, enc: pc.enc, card: await postedCard(phone, pc) }]);
    // the service shows a card that is another key's, a card for another list, and an id that the relay key does not give
    const other = await askingPc();
    const forged = await signCard({ key: other.key, enc: pc.enc, list: w.held().id, endpoint: pc.endpoint, invite: null }, other.signs);
    const elsewhere = await signCard({ key: pc.key, enc: pc.enc, list: "ef".repeat(32), endpoint: pc.endpoint, invite: null }, pc.signs);
    for (const lie of [{ card: forged }, { card: elsewhere }, { server_id: other.server_id }, { enc: other.enc }]) {
      phone.wire.answer = async (request) => {
        if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/posts")) return null;
        const body = await (await w.fake.fetch(request)).json() as { posts: Record<string, unknown>[] };
        return Response.json({ posts: body.posts.map((post) => ({ ...post, ...lie })) });
      };
      expect(await postedPcs(phone.list)).toEqual([]);
    }
  });

  it("are none for a device that may not write to the list", async () => {
    const { w, pc } = await asking();
    const waiting = await w.device({ label: "Tablet" });
    await waiting.list.sync();
    expect([await postedPcs(waiting.list), sentTo(waiting, "/posts"), pc.endpoint.length]).toEqual([[], [], 64]);
  });
});

async function postedCard(phone: WorldDevice, pc: AskingPc): Promise<string> {
  const post = (await phone.service.listPosts((await phone.list.sync()).status.at === "following" ? phone.list.writer()!.list : "")).find((each) => each.endpoint === pc.endpoint);
  return post!.card;
}

describe("the number for a PC that asks to be added", () => {
  it("is the same on both ends, worked out from the PC's own card, and shown here only after the PC answered", async () => {
    const { phone, play } = await asking();
    const [post] = await postedPcs(phone.list);
    const number = shown(await numberWith(phone.list, post!, pcTurn(play)));
    expect(number.digits).toMatch(/^[0-9]{6}$/);
    expect(await play.digits()).toBe(number.digits);
    // the device committed before the PC's nonce was known, and revealed only after it
    const messages = sentTo(phone, "/attempt").map((each) => Object.keys(each.body!).sort().join(" "));
    expect(messages).toEqual(["adder commitment key", "adder commitment key reveal"]);
    expect(sentTo(phone, "/attempt")[0]!.body!.adder).toBe((await phone.keys()).key);
  });

  it("differs for a PC whose own card is another than the one this device was shown: nothing between the two can make them agree", async () => {
    const { w, phone, pc } = await asking();
    const [post] = await postedPcs(phone.list);
    // the PC really holds another encryption key than the card the service showed this device: its binding is another
    const other = await askingPc();
    const play = pcComparing(w, { ...pc, enc: other.enc }, w.held().id);
    const number = shown(await numberWith(phone.list, post!, pcTurn(play)));
    expect(await play.digits()).not.toBe(number.digits);
  });

  it("can still show after the PC was unable to answer for a full rate-limit window", async () => {
    const { phone, play } = await asking();
    const [post] = await postedPcs(phone.list);
    if (post === undefined) throw new Error("no PC post");
    let clock = 0;

    const result = await numberWith(phone.list, post, { now: () => clock, wait: async (ms) => {
      clock += ms;
      if (clock >= 63_000) await play.answer();
    } });

    expect(await play.digits()).toBe(shown(result).digits);
  });

  it("is not shown where the PC does not answer in time", async () => {
    const { phone } = await asking();
    const [post] = await postedPcs(phone.list);
    let clock = 0;
    expect(await numberWith(phone.list, post!, { wait: async () => { clock += 20_000; }, now: () => clock })).toEqual({ shown: false, why: "silent" });
  });

  it("is not shown where another device of the account asked for a number meanwhile: one attempt stands, the later one", async () => {
    const { w, phone, play } = await asking();
    const [post] = await postedPcs(phone.list);
    const second = await w.device({ label: "Tablet" });
    await second.list.sync();
    const outcome = await allowDevice(phone.list, { key: (await second.keys()).key, label: "Tablet", os: null }, { wait: async () => {} });
    if (!outcome.allowed) throw new Error(outcome.why);
    await second.list.adopt(outcome.offer);
    const theirs = (await postedPcs(second.list))[0]!;
    let other: Promise<unknown> | undefined;
    expect(await numberWith(phone.list, post!, { wait: async () => { other ??= numberWith(second.list, theirs, pcTurn(play)); await other; } })).toEqual({ shown: false, why: "gone" });
  });

  it("is not shown where the PC posted other keys since, or asked too often", async () => {
    const { w, phone, pc, play } = await asking();
    const [post] = await postedPcs(phone.list);
    const again = { ...pc, enc: (await askingPc()).enc };
    await postPcKeys(w.fake.fetch, w.origin, phone.session.access_token, again, w.held().id);
    expect(await numberWith(phone.list, post!, pcTurn(play))).toEqual({ shown: false, why: "gone" });
    phone.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/attempt") ? Response.json({ error: { code: "attempts_spent", message: "" } }, { status: 429 }) : null;
    expect(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play))).toEqual({ shown: false, why: "spent" });
  });

  it("ends at its deadline where the account service holds the commitment and never answers it", async () => {
    const { phone } = await asking();
    const [post] = await postedPcs(phone.list);
    phone.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/attempt") ? new Promise<Response>(() => {}) : null;
    expect(await numberWith(phone.list, post!, { waitMs: 50 })).toEqual({ shown: false, why: "silent" });
  });

  it("ends at its deadline where a read of the posts never answers", async () => {
    const { phone } = await asking();
    const [post] = await postedPcs(phone.list);
    phone.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/posts") ? new Promise<Response>(() => {}) : null;
    expect(await numberWith(phone.list, post!, { waitMs: 50 })).toEqual({ shown: false, why: "silent" });
  });

  it("is not shown from an answer that came after its deadline, and times its two minutes from before the PC could have answered", async () => {
    /** a device whose every read of the posts after the first takes `slow` ms by its own clock to come back */
    const slowly = async (slow: number) => {
      const { w, phone, play } = await asking();
      const [post] = await postedPcs(phone.list);
      let clock = 0;
      let reads = 0;
      phone.wire.answer = async (request) => {
        if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/posts")) return null;
        if (reads++ > 0) clock += slow;
        return w.fake.fetch(request);
      };
      return numberWith(phone.list, post!, { wait: async () => { clock += 1_500; await play.answer(); }, now: () => clock });
    };
    // the PC's nonce was not there at the first read, sent at 0, and was at the next: it can have been put there right after 0
    expect(shown(await slowly(20_000)).until).toBe(120_000);
    // the same, where the late read came back after the device's deadline: no number at all
    expect(await slowly(80_000)).toEqual({ shown: false, why: "silent" });
  });

  it("ends at its deadline where the reveal is never answered, the number's two minutes notwithstanding", async () => {
    const { w, phone, play } = await asking();
    const [post] = await postedPcs(phone.list);
    // the PC answers at once; then the account service holds the reveal and never answers it
    phone.wire.answer = async (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/attempt")) return null;
      const body = await request.clone().json() as { reveal?: string };
      if (body.reveal !== undefined) return new Promise<Response>(() => {});
      const answer = await w.fake.fetch(request);
      await play.answer();
      return answer;
    };
    expect(await numberWith(phone.list, post!, { waitMs: 100 })).toEqual({ shown: false, why: "silent" });
  });

  it("can be given up while it waits for the PC", async () => {
    const { phone } = await asking();
    const [post] = await postedPcs(phone.list);
    const stop = new AbortController();
    const waiting = numberWith(phone.list, post!, { signal: stop.signal, wait: (_ms, signal) => new Promise((_, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason as Error)); stop.abort(new DOMException("closed", "AbortError")); }) });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Add, beside the number", () => {
  it("admits the PC and signs a pc entry with the very card the number came from, its name sealed and the key wrapped to it", async () => {
    const { w, phone, pc, play } = await asking();
    const number = shown(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play)));
    const admitted: string[] = [];
    expect(await addPostedPc(phone.list, number.post, { label: "Desk in the study", os: "linux" }, { wait: async () => {}, admit: async () => { admitted.push(number.post.server_id); } })).toEqual({ added: true });
    expect(admitted).toEqual([pc.server_id]);
    const body = readBody(entryFromText(w.held().entries.at(-1)!).body);
    expect([body.signer, readKind(body)]).toMatchObject([(await phone.keys()).key, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card: number.post.card }]);
    const view = await phone.list.sync();
    expect(view.pcs.map((row) => [row.endpoint, row.server_id, row.name])).toEqual([[pc.endpoint, pc.server_id, { label: "Desk in the study", os: "linux" }]]);
    const placed = sentTo(phone, "/entries").at(-1)!.body!;
    expect((placed.wraps as { member: string }[]).map((wrap) => wrap.member)).toEqual([pc.enc]);
    // pressed again (the answer was slow): nothing more is admitted or signed
    const before = w.held().entries.length;
    expect(await addPostedPc(phone.list, number.post, null, { wait: async () => {}, admit: async () => { admitted.push("again"); } })).toEqual({ added: true });
    expect([admitted, w.held().entries.length]).toEqual([[pc.server_id], before]);
  });

  it("is not done for a card of the same key with another encryption key than the one the list holds for that PC", async () => {
    const { w, phone, pc, play } = await asking();
    const number = shown(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play)));
    expect(await addPostedPc(phone.list, number.post, null, { wait: async () => {}, admit: async () => {} })).toEqual({ added: true });
    // the same key signs another card for the same relay key, with another encryption key
    const other = await askingPc();
    const card = await signCard({ key: pc.key, enc: other.enc, list: w.held().id, endpoint: pc.endpoint, invite: null }, pc.signs);
    const outcome = await addPostedPc(phone.list, { ...number.post, enc: other.enc, card }, null, { wait: async () => {}, admit: async () => {} });
    expect(outcome.added).toBe(false);
    expect(w.held().state.pcs[pc.endpoint]).toMatchObject({ enc: pc.enc });
  });

  it("signs nothing where the account service does not admit the PC, and says what it said", async () => {
    const { w, phone, play } = await asking();
    const number = shown(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play)));
    const before = w.held().entries.length;
    const { AccountServiceError } = await import("./service.ts");
    expect(await addPostedPc(phone.list, number.post, null, { wait: async () => {}, admit: async () => { throw new AccountServiceError(403, "session_not_fresh", "x"); } }))
      .toEqual({ added: false, why: "admit", code: "session_not_fresh", retryAfterMs: null });
    expect(w.held().entries.length).toBe(before);
  });

  it("signs nothing, and admits nothing, where this device holds another member key than the one the number was worked out with", async () => {
    const { w, phone, play } = await asking();
    const number = shown(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play)));
    expect(number.member).toBe((await phone.keys()).key);
    const before = w.held().entries.length;
    const admitted: string[] = [];
    expect(await addPostedPc(phone.list, number.post, null, { wait: async () => {}, admit: async () => { admitted.push("admitted"); }, member: "another-key" })).toMatchObject({ added: false, why: "changed" });
    // and an account other than the one the card was shown for is refused before the admission too
    expect(await addPostedPc(phone.list, number.post, null, { wait: async () => {}, admit: async () => { admitted.push("admitted"); }, expect: { account: "acct_another", list: number.post.list } })).toMatchObject({ added: false, why: "changed" });
    expect([admitted, w.held().entries.length]).toEqual([[], before]);
  });

  it("reports nothing as its own where another Add took its place at the same head: two Adds at once, one PC placed at most (C1)", async () => {
    const { w, phone, play } = await asking();
    const first = shown(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play)));
    // a second PC asks too, and its number is compared on this device
    const other = await askingPc();
    await postPcKeys(w.fake.fetch, w.origin, phone.session.access_token, other, w.held().id);
    const otherPlay = pcComparing(w, other, w.held().id);
    const second = shown(await numberWith(phone.list, (await postedPcs(phone.list)).find((each) => each.endpoint === other.endpoint)!, pcTurn(otherPlay)));
    const entries = w.held().entries.length;
    let raced = false;
    // another page of this device presses Add for the first PC between this Add's look at the head and its own keep:
    // its request is kept for that head (the account service turns it away for now), and this Add's keep gets it back
    const page: AccountList = { ...phone.list, keep: async (writer, request) => {
      if (!raced) {
        raced = true;
        w.fake.tamperList(w.held().id, { headMoved: true });
        await addPostedPc(phone.list, first.post, null, { wait: async () => {}, admit: async () => {} });
        w.fake.untamperList(w.held().id);
      }
      return phone.list.keep(writer, request);
    } };
    const outcome = await addPostedPc(page, second.post, null, { wait: async () => {}, admit: async () => {}, member: second.member, expect: { account: w.account, list: second.post.list } });
    expect(outcome).toMatchObject({ added: false, why: "waiting" });
    // nothing was placed for either: the other page's request waits for its own Try again
    expect(w.held().entries.length).toBe(entries);
    expect((await phone.list.sync()).pcs).toEqual([]);
  });

  it("signs nothing for another account or list than the one the card was shown for", async () => {
    const { w, phone, play } = await asking();
    const number = shown(await numberWith(phone.list, (await postedPcs(phone.list))[0]!, pcTurn(play)));
    const before = w.held().entries.length;
    expect(await addPostedPc(phone.list, number.post, null, { wait: async () => {}, admit: async () => {}, expect: { account: "acct_another", list: number.post.list } })).toMatchObject({ added: false, why: "changed" });
    expect(await addPostedPc(phone.list, { ...number.post, list: "ef".repeat(32) }, null, { wait: async () => {}, admit: async () => {} })).toMatchObject({ added: false, why: "changed" });
    expect(w.held().entries.length).toBe(before);
  });
});
