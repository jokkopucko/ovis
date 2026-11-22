import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ListEntryError, entryFromText, entryHash, entryHolds, entryToText, firstState, isListHash, isListKeyEncoding, readFields, signEntry, verifySignature,
  type EntryBody, type HeldEntry, type ListRefusalCode, type SignerPower,
} from "./account-list-entry.ts";
import {
  firstSignersState as firstSignersStateOf, judgeEntry as judgeEntryOf, replayEntries as replayEntriesOf, shownEntries as shownEntriesOf,
  isBehind, listHead, readSignersState, signerPower, signingPlace,
  type KeyProof, type ListMember, type ListPlace, type ListStop, type PassedOverCode, type ShownAnswer, type SignerRow, type SignersState, type TakenEntry, type TakenOutcome,
} from "./account-list-signers.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const T0 = 1767225600;

const made = new Map<string, string>();
const readsAgain = (state: SignersState): boolean => {
  try {
    return readSignersState(JSON.parse(JSON.stringify(state)), state.level) !== null;
  } catch {
    return false;
  }
};
const firstSignersState: typeof firstSignersStateOf = (first, level) => {
  const state = firstSignersStateOf(first, level);
  made.set(JSON.stringify(state), "firstSignersState");
  return state;
};
const mayFollow = (state: SignersState, { body, list }: HeldEntry): boolean =>
  list === state.list && body.seq > state.footing.seq && [body.signer, body.adds?.key, body.ends].every((key) => key === undefined || isListKeyEncoding(key));
const judgeEntry: typeof judgeEntryOf = (state, held, proof) => {
  const judged = judgeEntryOf(state, held, proof);
  if (readsAgain(state) && mayFollow(state, held)) made.set(JSON.stringify(judged.state), "judgeEntry");
  return judged;
};
const shownEntries: typeof shownEntriesOf = async (member, answer, proof) => {
  const result = await shownEntriesOf(member, answer, proof);
  if (readsAgain(member.state)) made.set(JSON.stringify(result.member.state), "shownEntries");
  return result;
};
const replayEntries: typeof replayEntriesOf = async (entries, level, options) => {
  const result = await replayEntriesOf(entries, level, options);
  if (result.member !== null) made.set(JSON.stringify(result.member.state), "replayEntries");
  return result;
};

interface Key { readonly name: string; readonly key: string; readonly pair: CryptoKeyPair }
const names = new Map<string, string>();
async function newKey(name: string): Promise<Key> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const key = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  names.set(key, name);
  return { name, key, pair };
}
const owner = await newKey("owner");
const phone = await newKey("phone");
const watch = await newKey("watch");
const invite = await newKey("invite");
const late = await newKey("late");
const service = await newKey("service");
const stranger = await newKey("stranger");
const machine = await newKey("machine");
const login = await newKey("login");

interface Link { readonly text: string; readonly seq: number; readonly hash: string; readonly list: string }
interface Draft {
  readonly kind?: string;
  readonly v?: number;
  readonly adds?: readonly [Key, SignerPower];
  readonly ends?: Key;
  readonly change?: Partial<EntryBody>;
  readonly signedWith?: Key;
}
async function sign(by: Key, body: EntryBody, signedWith: Key = by): Promise<Link> {
  const entry = await signEntry(body, signedWith.pair.privateKey);
  const hash = entryHash(entry.body);
  return { text: entryToText(entry), seq: body.seq, hash, list: body.seq === 0 ? hash : body.list };
}
const genesis = (by: Key = owner, v = 1) => sign(by, { issued_at: T0, kind: "genesis", list: "", prev: "", seq: 0, signer: by.key, v, own: [] });
function on(before: Link, by: Key, draft: Draft = {}): Promise<Link> {
  return sign(by, {
    issued_at: T0 + 60 * (before.seq + 1), kind: draft.kind ?? "remove", list: before.list, prev: before.hash, seq: before.seq + 1, signer: by.key, v: draft.v ?? 1,
    ...(draft.adds ? { adds: { key: draft.adds[0].key, power: draft.adds[1] } } : {}),
    ...(draft.ends ? { ends: draft.ends.key } : {}),
    own: [], ...draft.change,
  }, draft.signedWith);
}
async function row(before: Link, ...steps: readonly (readonly [Key, Draft?])[]): Promise<Link[]> {
  const links: Link[] = [];
  let head = before;
  for (const [by, draft] of steps) {
    head = await on(head, by, draft);
    links.push(head);
  }
  return links;
}
function badlySigned(link: Link): string {
  const entry = entryFromText(link.text);
  const signature = entry.signature.slice();
  signature[7] = (signature[7] ?? 0) ^ 1;
  return entryToText({ body: entry.body, signature });
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}
const last = <T>(items: readonly T[]): T => at(items, items.length - 1);
const texts = (links: readonly Link[]) => links.map((link) => link.text);
const place = (link: Link): ListPlace => ({ seq: link.seq, hash: link.hash });
const replay = (links: readonly Link[], level = 1, proof?: KeyProof) => replayEntries(texts(links), level, proof ? { saved: null, proof } : { saved: null });
async function memberOf(links: readonly Link[], level = 1, proof?: KeyProof): Promise<ListMember> {
  const { member, stopped } = await replay(links, level, proof);
  if (member === null || stopped !== null || member.entries.length !== links.length) throw new Error("the entries do not all hold");
  return member;
}
const stateOf = async (links: readonly Link[], level = 1, proof?: KeyProof) => (await memberOf(links, level, proof)).state;
const outcomesOf = async (links: readonly Link[], level = 1, proof?: KeyProof) => (await replay(links, level, proof)).took.map((taken) => taken.outcome);
const outcomeOf = async (links: readonly Link[], level = 1, proof?: KeyProof) => last(await outcomesOf(links, level, proof));
const who = (state: SignersState) => Object.fromEntries(Object.entries(state.signers).filter(([, row]) => row.ended === null).map(([key, row]) => [names.get(key) ?? key, row.power]));
const madeOf = (state: SignersState) => Object.entries(state.signers).filter(([, row]) => row.by !== null).map(([key]) => names.get(key) ?? key);
const rowBy = (power: SignerPower, at: Link, by: Key | null, ended: Link | null = null): SignerRow => ({ power, seq: at.seq, by: by?.key ?? null, ended: ended?.seq ?? null });
const passedOver = (code: PassedOverCode): TakenOutcome => ({ outcome: "passed_over", code, loose: code === "signer_unknown" });
const reads = (power: SignerPower | null = "full", behind = false): TakenOutcome => ({ outcome: "reads", power, behind });
const answer = (after: Link, shown: readonly Link[], head: ListPlace = place(shown.length > 0 ? last(shown) : after)): ShownAnswer => ({ after: after.seq, entries: texts(shown), head });
const quiet = { dropped_from: null, took: [], stopped: null, stuck: false, asks_after: null };
async function whileVerifying<T>(meanwhile: () => void, work: () => Promise<T>): Promise<T> {
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  let called = false;
  const changing = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    const verified = await verify(...args);
    if (!called) meanwhile();
    called = true;
    return verified;
  });
  try {
    const result = await work();
    if (!called) throw new Error("no signature was verified");
    return result;
  } finally {
    changing.mockRestore();
  }
}

const g = await genesis();
const addPhone = await on(g, owner, { kind: "device", adds: [phone, "full"] });
const addWatch = await on(addPhone, owner, { kind: "device", adds: [watch, "bound"] });
const addInvite = await on(addWatch, owner, { kind: "invite", adds: [invite, "bound"] });
const base = [g, addPhone, addWatch, addInvite];
const everyone: Readonly<Record<string, SignerPower>> = { owner: "full", phone: "full", watch: "bound", invite: "bound" };
const otherList = (await genesis(phone)).hash;

describe("the signers", () => {
  test("entry 0 makes its own signer the first signer, with power full", async () => {
    const { member, took } = await replay([g]);
    if (member === null) throw new Error("entry 0 does not hold");
    expect(member.state).toEqual({ level: 1, list: g.hash, footing: place(g), needs: 1, behind: null, signers: { [owner.key]: { power: "full", seq: 0, by: owner.key, ended: null } } });
    expect(Object.keys(member.state).sort()).toEqual(["behind", "footing", "level", "list", "needs", "signers"]);
    expect(took.map((taken) => taken.outcome)).toEqual([reads()]);
    expect(firstSignersState(at(took, 0).held, 1)).toEqual(member.state);
  });

  test("every member keeps the signers from adds, power and ends alone, whatever the kind and whether it can read the entry", async () => {
    for (const draft of [{}, { kind: "genesis" }, { kind: "no_such_kind" }, { v: 2 }, { v: 999 }]) {
      const entries = await row(addInvite, [owner, { ...draft, adds: [late, "bound"] }], [phone, { ...draft, ends: watch }]);
      for (const level of [1, 2, 1000]) expect(who(await stateOf([...base, ...entries], level))).toEqual({ owner: "full", phone: "full", invite: "bound", late: "bound" });
    }
  });

  test("the state has one row for each key that was made a signer, never deleted: the entry that made it one, that entry's signer, and the entry that ended it", async () => {
    const entries = await row(addInvite,
      [phone, { kind: "device", adds: [late, "full"] }], [watch, { kind: "device", adds: [stranger, "full"] }], [phone, { ends: watch }],
      [watch, { ends: invite }], [phone, { ends: phone }], [late, { ends: owner }], [owner, { ends: late }]);
    const state = await stateOf([...base, ...entries]);
    expect(state.signers).toEqual({
      [owner.key]: rowBy("full", g, owner, at(entries, 5)),
      [phone.key]: rowBy("full", addPhone, owner, at(entries, 4)),
      [watch.key]: rowBy("bound", addWatch, owner, at(entries, 2)),
      [invite.key]: rowBy("bound", addInvite, owner),
      [late.key]: rowBy("full", at(entries, 0), phone),
    });
    expect(who(state)).toEqual({ invite: "bound", late: "full" });
    expect([signerPower(state, owner.key), signerPower(state, late.key), signerPower(state, stranger.key), signerPower(state, "toString")]).toEqual([null, "full", null, null]);
  });

  test("only a row of its own counts: a name that every object answers to is no signer and has no row", async () => {
    const { took, member } = await replay(base);
    if (member === null) throw new Error("entry 0 does not hold");
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];
    for (const name of names) expect([name, signerPower(member.state, name)]).toEqual([name, null]);
    // An entry that holds never names such a key (a key has its form); a held entry made by hand shows that only a row of the state's own decides.
    const { held } = last(took);
    for (const name of names) {
      const naming: HeldEntry = { ...held, body: { ...held.body, seq: held.body.seq + 1, signer: owner.key, adds: { key: name, power: "bound" } } };
      const judged = judgeEntry(member.state, naming);
      expect([name, judged.outcome]).toEqual([name, reads()]);
      expect([name, signerPower(judged.state, name), Object.keys(judged.state.signers).length]).toEqual([name, "bound", 5]);
      expect([name, judgeEntry(judged.state, { ...naming, body: { ...naming.body, seq: naming.body.seq + 1 } }).outcome]).toEqual([name, passedOver("key_reused")]);
    }
  });

  test("a row is frozen when it is made, and so is every state, with its footing and its rows: writing through a state that a function gives throws, and changes no state it was given", async () => {
    const out = await on(addInvite, owner, { ends: watch });
    const { took, member } = await replay([...base, out]);
    if (member === null) throw new Error("entry 0 does not hold");
    expect(Object.values(firstSignersState(at(took, 0).held, 1).signers).map((row) => Object.isFrozen(row))).toEqual([true]);
    expect(Object.entries(member.state.signers).map(([key, row]) => [names.get(key), row.ended, Object.isFrozen(row)])).toEqual([["owner", null, true], ["phone", null, true], ["watch", 4, true], ["invite", null, true]]);
    const before = await stateOf(base);
    const after = judgeEntry(before, last(took).held).state;
    expect([after.signers === before.signers, after.signers[phone.key] === before.signers[phone.key], after.signers[phone.key], after.signers[watch.key] === before.signers[watch.key]]).toEqual([false, false, rowBy("full", addPhone, owner), false]);
    expect([Object.isFrozen(after.signers[watch.key]), before.signers[watch.key]]).toEqual([true, rowBy("bound", addWatch, owner)]);
    const kept = JSON.stringify(before);
    const copied: { ended: number | null; power: SignerPower } = after.signers[phone.key] ?? { ended: null, power: "bound" };
    expect(() => {
      copied.ended = 5;
    }).toThrow(TypeError);
    expect(() => {
      copied.power = "bound";
    }).toThrow(TypeError);
    expect([JSON.stringify(before), after.signers[phone.key]]).toEqual([kept, rowBy("full", addPhone, owner)]);
    const shown = await shownEntries(await memberOf(base), answer(addInvite, [out]));
    expect(Object.values(shown.member.state.signers).map((row) => Object.isFrozen(row))).toEqual([true, true, true, true]);
    const again = readSignersState(JSON.parse(JSON.stringify(before)), before.level);
    if (again === null) throw new Error("the saved state does not read");
    for (const state of [member.state, firstSignersState(at(took, 0).held, 1), before, after, shown.member.state, again]) {
      expect([Object.isFrozen(state), Object.isFrozen(state.footing), Object.isFrozen(state.signers)]).toEqual([true, true, true]);
    }
  });

  describe("an entry that carries adds and power", () => {
    test("is lawful when its signer is full and the key was never made a signer: the key is a signer with that power from the next entry on", async () => {
      const state = await stateOf(base);
      expect(who(state)).toEqual(everyone);
      expect(madeOf(state)).toEqual(["owner", "phone", "watch", "invite"]);
      expect(state.signers).toEqual({ [owner.key]: rowBy("full", g, owner), [phone.key]: rowBy("full", addPhone, owner), [watch.key]: rowBy("bound", addWatch, owner), [invite.key]: rowBy("bound", addInvite, owner) });
      expect(await outcomesOf(base)).toEqual(base.map(() => reads()));
      const byPhone = await on(addInvite, phone, { kind: "device", adds: [late, "full"] });
      const signs = await on(byPhone, late, { ends: watch });
      expect(who(await stateOf([...base, byPhone, signs]))).toEqual({ owner: "full", phone: "full", invite: "bound", late: "full" });
    });

    test("a key does not sign the entry that adds it", async () => {
      const own = await on(g, phone, { kind: "device", adds: [phone, "full"] });
      expect(await outcomeOf([g, own])).toEqual(passedOver("signer_unknown"));
      expect(who(await stateOf([g, own]))).toEqual({ owner: "full" });
    });

    test("adds by a bound signer is passed over, and the key can still be added", async () => {
      for (const bound of [watch, invite]) {
        const byBound = await on(addInvite, bound, { kind: "device", adds: [late, "full"] });
        expect(await outcomeOf([...base, byBound])).toEqual(passedOver("signer_not_allowed"));
        const state = await stateOf([...base, byBound]);
        expect(who(state)).toEqual(everyone);
        expect(madeOf(state)).not.toContain("late");
        const byOwner = await on(byBound, owner, { kind: "device", adds: [late, "full"] });
        expect(who(await stateOf([...base, byBound, byOwner]))).toEqual({ ...everyone, late: "full" });
      }
    });

    test("of a key that is a signer it is passed over, and the key keeps its power", async () => {
      for (const [key, power] of [[watch, "full"], [phone, "bound"], [owner, "bound"], [phone, "full"]] as const) {
        const again = await on(addInvite, owner, { kind: "device", adds: [key, power] });
        expect(await outcomeOf([...base, again])).toEqual(passedOver("key_reused"));
        expect(who(await stateOf([...base, again]))).toEqual(everyone);
      }
    });

    test("a key coming back: one that an adds made a signer and an ends ended is never made one again", async () => {
      const entries = await row(addInvite, [owner, { ends: phone }], [owner, { kind: "device", adds: [phone, "full"] }], [owner, { kind: "device", adds: [phone, "bound"] }], [phone, { ends: watch }]);
      expect((await outcomesOf([...base, ...entries])).slice(4)).toEqual([reads(), passedOver("key_reused"), passedOver("key_reused"), passedOver("signer_unknown")]);
      const state = await stateOf([...base, ...entries]);
      expect(who(state)).toEqual({ owner: "full", watch: "bound", invite: "bound" });
      expect(state.signers[phone.key]).toEqual(rowBy("full", addPhone, owner, at(entries, 0)));
    });

    test("entry 0's own key is never made a signer again, also after it ended itself", async () => {
      const entries = await row(addInvite, [owner, { ends: owner }], [phone, { kind: "device", adds: [owner, "full"] }]);
      expect(await outcomeOf([...base, ...entries])).toEqual(passedOver("key_reused"));
      expect(who(await stateOf([...base, ...entries]))).toEqual({ phone: "full", watch: "bound", invite: "bound" });
    });
  });

  describe("an entry that carries ends", () => {
    test("is lawful when its signer is full and the key is a signer: the key is no signer from the next entry on", async () => {
      for (const key of [watch, invite, owner]) {
        const out = await on(addInvite, phone, { ends: key });
        expect(await outcomeOf([...base, out])).toEqual(reads());
        expect(who(await stateOf([...base, out]))).toEqual(Object.fromEntries(Object.entries(everyone).filter(([name]) => name !== key.name)));
        expect(await outcomeOf([...base, out, await on(out, key, {})])).toEqual(passedOver("signer_unknown"));
      }
    });

    test("is lawful when its signer is that key itself, full or bound", async () => {
      for (const [key, power] of [[watch, "bound"], [invite, "bound"], [phone, "full"], [owner, "full"]] as const) {
        const out = await on(addInvite, key, { ends: key });
        expect(await outcomeOf([...base, out])).toEqual(reads(power));
        expect(who(await stateOf([...base, out]))).not.toHaveProperty(key.name);
      }
    });

    test("ends of another key by a bound signer is passed over", async () => {
      for (const [by, key] of [[watch, phone], [watch, invite], [invite, owner], [invite, watch]] as const) {
        const out = await on(addInvite, by, { ends: key });
        expect(await outcomeOf([...base, out])).toEqual(passedOver("signer_not_allowed"));
        expect(who(await stateOf([...base, out]))).toEqual(everyone);
      }
    });

    test("of a key that is no signer it is passed over: one never added, and one already ended", async () => {
      const never = await on(addInvite, owner, { ends: late });
      expect(await outcomeOf([...base, never])).toEqual(passedOver("already_out"));
      const twice = await row(addInvite, [owner, { ends: watch }], [owner, { ends: watch }]);
      expect(await outcomeOf([...base, ...twice])).toEqual(passedOver("already_out"));
    });

    test("an ended key never signs again: out is out", async () => {
      const entries = await row(addInvite, [owner, { ends: phone }], [phone, { ends: owner }], [phone, { kind: "device", adds: [late, "full"] }], [phone, { ends: phone }]);
      expect((await outcomesOf([...base, ...entries])).slice(5)).toEqual([passedOver("signer_unknown"), passedOver("signer_unknown"), passedOver("signer_unknown")]);
      expect(who(await stateOf([...base, ...entries]))).toEqual({ owner: "full", watch: "bound", invite: "bound" });
    });

    test("the ends of the last full signer is lawful, and the list then takes no further change", async () => {
      const entries = await row(addInvite, [owner, { ends: phone }], [owner, { ends: owner }], [watch, { kind: "device", adds: [late, "full"] }], [invite, { ends: watch }], [owner, { kind: "device", adds: [late, "full"] }]);
      expect((await outcomesOf([...base, ...entries])).slice(5)).toEqual([reads(), passedOver("signer_not_allowed"), passedOver("signer_not_allowed"), passedOver("signer_unknown")]);
      expect(who(await stateOf([...base, ...entries]))).toEqual({ watch: "bound", invite: "bound" });
    });
  });

  describe("adds and ends are both judged on the state before the entry", () => {
    test("an entry in which both are lawful applies both", async () => {
      const both = await on(addInvite, owner, { kind: "device", adds: [late, "bound"], ends: watch });
      const state = await stateOf([...base, both]);
      expect(who(state)).toEqual({ owner: "full", phone: "full", invite: "bound", late: "bound" });
      expect([state.signers[late.key], state.signers[watch.key]]).toEqual([rowBy("bound", both, owner), rowBy("bound", addWatch, owner, both)]);
      const handsOver = await on(addInvite, owner, { kind: "device", adds: [late, "full"], ends: owner });
      expect(who(await stateOf([...base, handsOver]))).toEqual({ phone: "full", watch: "bound", invite: "bound", late: "full" });
    });

    test("an entry of which one is not lawful is passed over whole", async () => {
      const endsNot = await on(addInvite, owner, { kind: "device", adds: [late, "full"], ends: stranger });
      expect(await outcomeOf([...base, endsNot])).toEqual(passedOver("already_out"));
      const state = await stateOf([...base, endsNot]);
      expect(who(state)).toEqual(everyone);
      expect(madeOf(state)).not.toContain("late");
      const addsNot = await on(addInvite, owner, { kind: "device", adds: [phone, "full"], ends: watch });
      expect(await outcomeOf([...base, addsNot])).toEqual(passedOver("key_reused"));
      expect(who(await stateOf([...base, addsNot]))).toEqual(everyone);
    });

    test("the key an entry adds is not yet a signer for that entry's ends", async () => {
      const both = await on(addInvite, owner, { kind: "device", adds: [late, "full"], ends: late });
      expect(await outcomeOf([...base, both])).toEqual(passedOver("already_out"));
      expect(who(await stateOf([...base, both]))).toEqual(everyone);
    });

    test("the code is that of the first clause that is not lawful: its signer, then adds, then ends, in each the signer's power before the key", async () => {
      const cases: readonly (readonly [Key, Draft, PassedOverCode])[] = [
        [stranger, { adds: [phone, "full"], ends: late }, "signer_unknown"],
        [watch, { adds: [phone, "full"] }, "signer_not_allowed"],
        [watch, { adds: [late, "full"], ends: watch }, "signer_not_allowed"],
        [watch, { ends: late }, "signer_not_allowed"],
        [owner, { adds: [phone, "full"], ends: late }, "key_reused"],
        [owner, { adds: [late, "full"], ends: stranger }, "already_out"],
      ];
      for (const [by, draft, code] of cases) expect(await outcomeOf([...base, await on(addInvite, by, draft)])).toEqual(passedOver(code));
    });
  });

  test("an entry signed by a key that no full signer added changes nothing: the service's own, a stranger's, one a machine made for itself", async () => {
    const plain = await stateOf(base);
    for (const by of [service, stranger, machine]) {
      const entries = await row(addInvite, [by, { kind: "device", adds: [by, "full"] }], [by, { ends: owner }], [by, { kind: "device", adds: [late, "full"] }], [by, { v: 2 }]);
      expect((await outcomesOf([...base, ...entries])).slice(4)).toEqual(entries.map(() => passedOver("signer_unknown")));
      expect(await stateOf([...base, ...entries])).toEqual(plain);
    }
  });

  test("a key that only a passed-over entry named in adds is no signer", async () => {
    const entries = await row(addInvite, [watch, { kind: "device", adds: [late, "full"] }], [late, { ends: owner }]);
    expect(await outcomeOf([...base, ...entries])).toEqual(passedOver("signer_unknown"));
  });
});

describe("the four things a member does with one entry", () => {
  const head = addInvite;

  describe("an entry that does not hold stops it there", () => {
    const stoppedAt = async (shown: readonly string[]) => {
      const member = await memberOf(base);
      const result = await shownEntries(member, { after: head.seq, entries: shown, head: place(head) });
      expect(result.member).toEqual(member);
      expect(result.took).toEqual([]);
      expect(result.dropped_from).toBeNull();
      return { stopped: result.stopped, stuck: result.stuck, asks_after: result.asks_after };
    };
    const stopped = (code: ListRefusalCode) => ({ stopped: { seq: head.seq + 1, code }, stuck: false, asks_after: null });

    test("in its form", async () => {
      const good = await on(head, owner, {});
      for (const text of [`${good.text}=`, good.text.replace(".", ".."), good.text.slice(0, -1), "", ` ${good.text}`]) expect(await stoppedAt([text])).toEqual(stopped("entry_malformed"));
    });

    test("in its signature: a changed byte, a signature by another key", async () => {
      expect(await stoppedAt([badlySigned(await on(head, owner, {}))])).toEqual(stopped("signature_invalid"));
      expect(await stoppedAt([(await on(head, owner, { signedWith: phone })).text])).toEqual(stopped("signature_invalid"));
    });

    test("in its place: a wrong seq or list, also when it names the head in prev", async () => {
      for (const change of [{ seq: head.seq + 2 }, { seq: head.seq }, { list: otherList }, { prev: "" }]) {
        expect(await stoppedAt([(await on(head, owner, { change })).text])).toEqual(stopped("chain_broken"));
      }
    });

    test("it takes neither that entry nor any after it, and goes on when it is shown one that holds", async () => {
      const member = await memberOf(base);
      const entries = await row(head, [owner, { ends: watch }], [phone, { kind: "device", adds: [late, "full"] }], [late, { ends: invite }]);
      const first = await shownEntries(member, { after: head.seq, entries: [at(entries, 0).text, badlySigned(at(entries, 1)), at(entries, 2).text], head: place(last(entries)) });
      expect(first.stopped).toEqual({ seq: 5, code: "signature_invalid" });
      expect(first.stuck).toBe(false);
      expect(first.member).toEqual(await memberOf([...base, at(entries, 0)]));
      const second = await shownEntries(first.member, answer(at(entries, 0), entries.slice(1)));
      expect(second.stopped).toBeNull();
      expect(second.member).toEqual(await memberOf([...base, ...entries]));
    });
  });

  describe("an entry that holds and is passed over", () => {
    test("is taken, and the head moves on", async () => {
      for (const by of [stranger, watch]) {
        const over = await on(head, by, { kind: "device", adds: [late, "full"] });
        const result = await shownEntries(await memberOf(base), answer(head, [over]));
        expect(listHead(result.member)).toEqual(place(over));
        expect(result.member.entries).toEqual(texts([...base, over]));
        expect(result.took.map((taken) => taken.outcome.outcome)).toEqual(["passed_over"]);
      }
    });

    test("has no effect: nobody in, nobody out, the member is not behind, and it does not count for what the list needs", async () => {
      const plain = await stateOf(base);
      const byStranger = await on(head, stranger, { kind: "later", v: 9, adds: [late, "full"], ends: owner });
      expect(await outcomeOf([...base, byStranger])).toEqual(passedOver("signer_unknown"));
      expect(await stateOf([...base, byStranger])).toEqual(plain);
      const notLawful = await on(head, owner, { kind: "later", v: 9, adds: [late, "full"], ends: stranger });
      expect(await outcomeOf([...base, notLawful])).toEqual(passedOver("already_out"));
      expect(await stateOf([...base, notLawful])).toEqual({ ...plain, footing: place(notLawful) });
    });

    test("is loose when its signer is no signer for the member, and not when a signer signed it", async () => {
      const loose = await on(head, service, {});
      expect(await outcomeOf([...base, loose])).toEqual({ outcome: "passed_over", code: "signer_unknown", loose: true });
      expect((await stateOf([...base, loose])).footing).toEqual(place(head));
      const signed = await on(head, invite, { ends: owner });
      expect(await outcomeOf([...base, signed])).toEqual({ outcome: "passed_over", code: "signer_not_allowed", loose: false });
      expect((await stateOf([...base, signed])).footing).toEqual(place(signed));
    });
  });

  describe("an entry that holds, is not passed over, and whose v is above its level", () => {
    test("it cannot read: adds and ends have applied, and it is behind from this entry on when its signer is full", async () => {
      const later = await on(head, phone, { kind: "later", v: 2, adds: [late, "bound"], ends: watch });
      expect(await outcomeOf([...base, later])).toEqual({ outcome: "cannot_read", power: "full", behind: true });
      const state = await stateOf([...base, later]);
      expect(who(state)).toEqual({ owner: "full", phone: "full", invite: "bound", late: "bound" });
      expect([state.behind, state.needs, isBehind(state)]).toEqual([4, 2, true]);
    });

    test("signed by a bound signer it does not make the member behind, and its ends still applies", async () => {
      for (const bound of [watch, invite]) {
        const later = await on(head, bound, { kind: "later", v: 2, ends: bound });
        expect(await outcomeOf([...base, later])).toEqual({ outcome: "cannot_read", power: "bound", behind: false });
        const state = await stateOf([...base, later]);
        expect(who(state)).not.toHaveProperty(bound.name);
        expect([state.behind, state.needs, isBehind(state)]).toEqual([null, 1, false]);
      }
    });
  });

  describe("an entry that holds, is not passed over, and whose v is at most its level", () => {
    test("it reads, whatever the kind: the entry is its kind's to judge", async () => {
      for (const kind of ["remove", "device", "genesis", "no_such_kind"]) {
        const entry = await on(head, phone, { kind, ends: watch });
        expect(await outcomeOf([...base, entry])).toEqual(reads());
        expect(isBehind(await stateOf([...base, entry]))).toBe(false);
      }
      expect(await outcomeOf([...base, await on(head, invite, { kind: "join" })])).toEqual(reads("bound"));
    });

    test("the level alone decides between reading and not: v L is read, v L + 1 is not", async () => {
      for (const level of [1, 2, 7]) {
        const zero = await genesis(owner, level);
        const same = await on(zero, owner, { kind: "later", v: level });
        const above = await on(zero, owner, { kind: "later", v: level + 1 });
        expect((await outcomeOf([zero, same], level)).outcome).toBe("reads");
        expect((await outcomeOf([zero, above], level)).outcome).toBe("cannot_read");
        expect((await outcomeOf([zero, above], level + 1)).outcome).toBe("reads");
      }
    });
  });

  test("in the last three the head moves on", async () => {
    const entries = await row(head, [stranger, {}], [owner, { kind: "later", v: 2 }], [phone, {}]);
    const result = await shownEntries(await memberOf(base), answer(head, entries));
    expect(result.took.map((taken) => taken.outcome.outcome)).toEqual(["passed_over", "cannot_read", "reads"]);
    expect(listHead(result.member)).toEqual(place(last(entries)));
  });
});

const fell = await on(addInvite, owner, { kind: "later", v: 2 });
const afterFell = await row(fell, [owner, { kind: "device", adds: [late, "full"] }], [invite, { kind: "join" }], [owner, { ends: phone }], [late, { ends: watch }], [late, {}]);
const behindLog = [...base, fell, ...afterFell];

describe("behind", () => {
  test("the member is behind from the entry on that it cannot read and a full signer signed, and says that it needs an update", async () => {
    const state = await stateOf(behindLog);
    expect([state.behind, state.needs, isBehind(state)]).toEqual([4, 2, true]);
    expect(isBehind(await stateOf(base))).toBe(false);
  });

  test("it lets nobody new in: every entry after that one is read as by a member that is behind", async () => {
    const outcomes = await outcomesOf(behindLog);
    expect(outcomes.slice(0, 4)).toEqual(base.map(() => reads()));
    expect(outcomes.slice(4)).toEqual([{ outcome: "cannot_read", power: "full", behind: true }, reads("full", true), reads("bound", true), reads("full", true), reads("full", true), reads("full", true)]);
  });

  test("it keeps following the chain and the signers, also for keys that came in after it fell behind, and applies every removal", async () => {
    expect(who(await stateOf([...base, fell, at(afterFell, 0)]))).toEqual({ ...everyone, late: "full" });
    expect(who(await stateOf(behindLog))).toEqual({ owner: "full", invite: "bound", late: "full" });
    expect(listHead(await memberOf(behindLog))).toEqual(place(last(afterFell)));
  });

  test("a later kind signed by an unknown key, or by an invite's key, does not make it behind", async () => {
    for (const by of [stranger, service, invite, watch]) {
      const state = await stateOf([...base, await on(addInvite, by, { kind: "later", v: 2 })]);
      expect([state.behind, state.needs]).toEqual([null, 1]);
    }
  });

  test("a kind that its level does not define, written at v 1, does not make it behind, and its ends still applies", async () => {
    const entry = await on(addInvite, owner, { kind: "later", v: 1, ends: phone });
    expect(await outcomeOf([...base, entry])).toEqual(reads());
    expect(who(await stateOf([...base, entry]))).toEqual({ owner: "full", watch: "bound", invite: "bound" });
  });

  test("a known kind at a higher v, signed by a drive device, makes it behind, and its adds still applies", async () => {
    const entry = await on(addInvite, owner, { kind: "device", v: 2, adds: [late, "full"] });
    expect(await outcomeOf([...base, entry])).toEqual({ outcome: "cannot_read", power: "full", behind: true });
    expect(who(await stateOf([...base, entry]))).toEqual({ ...everyone, late: "full" });
  });

  test("with its level raised it replays every entry it kept, from entry 0, and is not behind", async () => {
    const member = await memberOf(behindLog);
    const updated = await replayEntries(member.entries, 2, { saved: member.state, given: member.state.list });
    expect(updated.stopped).toBeNull();
    expect(updated.took.map((taken) => taken.outcome)).toEqual([reads(), reads(), reads(), reads(), reads(), reads(), reads("bound"), reads(), reads(), reads()]);
    expect(updated.member).toEqual({ entries: member.entries, state: { ...member.state, level: 2, behind: null } });
  });
});

describe("what a list needs", () => {
  test("is the highest v among its entries that are not passed over and that a full signer signed", async () => {
    const entries = await row(addInvite,
      [owner, { kind: "later", v: 3 }], [watch, { kind: "later", v: 5 }], [stranger, { kind: "later", v: 7 }],
      [owner, { kind: "later", v: 4, ends: stranger }], [phone, { kind: "later", v: 2 }], [invite, { kind: "later", v: 6, ends: invite }]);
    const needs: number[] = [];
    for (let count = 0; count <= entries.length; count++) needs.push((await stateOf([...base, ...entries.slice(0, count)])).needs);
    expect(needs).toEqual([1, 3, 3, 3, 3, 3, 3]);
  });

  test("full is judged after the entries before it: the entry in which a full signer ends itself counts, its next one does not", async () => {
    const entries = await row(addInvite, [phone, { kind: "later", v: 4, ends: phone }], [phone, { kind: "later", v: 9 }]);
    expect((await stateOf([...base, ...entries])).needs).toBe(4);
  });

  test("every reader works it out from its own copy, also from entries it cannot read: it is behind exactly when its level is below it", async () => {
    const entries = await row(addInvite, [owner, { kind: "later", v: 3 }], [phone, { kind: "later", v: 2 }]);
    for (const level of [1, 2, 3, 4]) {
      const state = await stateOf([...base, ...entries], level);
      expect([level, state.needs, isBehind(state), state.behind]).toEqual([level, 3, level < 3, level < 3 ? 4 : null]);
    }
  });

  test("entry 0 is the first that its first signer signed", async () => {
    const zero = await genesis(owner, 2);
    expect(await outcomesOf([zero], 1)).toEqual([{ outcome: "cannot_read", power: "full", behind: true }]);
    const lower = await stateOf([zero], 1);
    const same = await stateOf([zero], 2);
    expect([lower.needs, lower.behind, same.needs, same.behind]).toEqual([2, 0, 2, null]);
  });
});

const root = [g, addPhone];
const real = await row(addPhone, [owner, { kind: "device", adds: [watch, "bound"] }], [phone, { kind: "invite", adds: [invite, "bound"] }], [owner, { ends: watch }], [phone, {}]);
const padding = await row(addPhone, [service, { kind: "device", adds: [service, "full"] }], [service, { ends: owner }], [service, { kind: "device", adds: [late, "full"] }]);
const fork = await row(g, [owner, { kind: "device", adds: [late, "full"] }], [owner, {}], [owner, {}], [owner, {}], [owner, {}], [owner, {}]);

describe("loose entries and the footing", () => {
  test("the footing is the last entry it holds that is not loose, entry 0 at the least", async () => {
    expect((await stateOf([g])).footing).toEqual(place(g));
    expect((await stateOf([g, await on(g, service, {})])).footing).toEqual(place(g));
    expect((await stateOf(root)).footing).toEqual(place(addPhone));
    expect((await stateOf([...root, ...padding])).footing).toEqual(place(addPhone));
    expect((await stateOf([...root, ...real])).footing).toEqual(place(last(real)));
  });

  test("the entries after the footing are all loose, and none of them had an effect", async () => {
    const member = await memberOf([...root, ...padding]);
    expect(member.state).toEqual(await stateOf(root));
    expect((await outcomesOf([...root, ...padding])).slice(2)).toEqual(padding.map(() => passedOver("signer_unknown")));
    expect(listHead(member)).toEqual(place(last(padding)));
  });

  test("an entry by a signer on top of loose entries makes them part of the list, and none of them is dropped", async () => {
    const onTop = await on(last(padding), owner, { kind: "device", adds: [watch, "bound"] });
    const result = await shownEntries(await memberOf([...root, ...padding]), answer(last(padding), [onTop]));
    expect(result.dropped_from).toBeNull();
    expect(result.member.entries).toEqual(texts([...root, ...padding, onTop]));
    expect(result.member.state.footing).toEqual(place(onTop));
    expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", watch: "bound" });
    const later = await shownEntries(result.member, answer(addPhone, real, place(onTop)));
    expect(later).toEqual({ ...quiet, member: result.member, stopped: { seq: 2, code: "chain_broken" }, stuck: true });
  });

  test("so does an entry that a signer signed and that is passed over for a field that is not lawful", async () => {
    const onTop = await on(last(padding), phone, { ends: stranger });
    const result = await shownEntries(await memberOf([...root, ...padding]), answer(last(padding), [onTop]));
    expect(result.took.map((taken) => taken.outcome)).toEqual([passedOver("already_out")]);
    expect(result.member.state).toEqual({ ...(await stateOf(root)), footing: place(onTop) });
  });
});

describe("going back", () => {
  const padded = () => memberOf([...root, ...padding]);

  describe("it learns of another continuation", () => {
    test("when the first entry it is shown does not continue its head: it asks for the entries after its footing, and nothing changes yet", async () => {
      const member = await padded();
      const next = await on(last(real), owner, {});
      for (const shown of [[last(real)], [last(real), next]]) {
        expect(await shownEntries(member, answer(last(padding), shown))).toEqual({ ...quiet, member, asks_after: 1 });
      }
    });

    test("when the answer's head lies at or before its own head with another hash than its own entry at that place", async () => {
      const member = await padded();
      for (const head of [place(at(real, 2)), place(at(real, 1)), place(at(real, 0))]) {
        expect(await shownEntries(member, { after: last(padding).seq, entries: [], head })).toEqual({ ...quiet, member, asks_after: 1 });
      }
    });

    test("not when the answer's head is its own entry at that place: the log is only shorter, and it keeps its loose entries", async () => {
      const member = await padded();
      for (const head of [place(last(padding)), place(at(padding, 0)), place(addPhone), place(g)]) {
        expect(await shownEntries(member, { after: last(padding).seq, entries: [], head })).toEqual({ ...quiet, member });
      }
      expect(await shownEntries(member, { after: addPhone.seq, entries: [], head: place(addPhone) })).toEqual({ ...quiet, member });
    });

    test("and not from a head past its own, which says nothing about what it holds", async () => {
      const member = await padded();
      expect(await shownEntries(member, { after: last(padding).seq, entries: [], head: place(last(real)) })).toEqual({ ...quiet, member });
    });

    test("the head is held again after each entry: at a loose entry it has just taken, with another hash, it takes no further entry of that answer and goes back", async () => {
      const loose = await row(addPhone, [service, {}], [service, {}]);
      const result = await shownEntries(await memberOf(root), answer(addPhone, loose, place(at(real, 0))));
      expect(result.took.map((item) => [item.held.hash, item.outcome.outcome])).toEqual([[at(loose, 0).hash, "passed_over"]]);
      expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(loose, 0)]), asks_after: 1 });
      const plain = await shownEntries(await memberOf(root), answer(addPhone, loose, place(at(loose, 0))));
      expect([plain.asks_after, plain.stopped, plain.member]).toEqual([null, null, await memberOf([...root, ...loose])]);
    });

    test("the head is not held again after an entry that is the same as its own: shown its true loose entry again and then the list's entry in the place of a stale one, it comes to that entry and takes it", async () => {
      const true2 = await on(addPhone, stranger, {});
      const stale3 = await on(true2, service, {});
      const list3 = await on(true2, owner, { kind: "device", adds: [watch, "bound"] });
      const member = await memberOf([...root, true2, stale3]);
      const after = await memberOf([...root, true2, list3]);
      expect([member.state.footing, listHead(member), after.state.footing]).toEqual([place(addPhone), place(stale3), place(list3)]);
      const whole = await shownEntries(member, answer(addPhone, [true2, list3]));
      expect(whole.took.map((item) => item.held.hash)).toEqual([list3.hash]);
      expect({ ...whole, took: [] }).toEqual({ ...quiet, member: after, dropped_from: 3 });
      const first = await shownEntries(member, answer(addPhone, [true2], place(list3)));
      expect(first).toEqual({ ...quiet, member });
      const second = await shownEntries(first.member, answer(true2, [list3]));
      expect({ ...second, took: [] }).toEqual({ ...quiet, member: after, dropped_from: 3 });
    });

    test("nor after its own last entry: an answer that shows all its loose entries again and goes on, under a head that names another entry among them, is taken on, and the head is held after the entry it takes", async () => {
      const member = await padded();
      const onTop = await on(last(padding), owner, {});
      const lying = place(at(real, 1));
      const whole = await shownEntries(member, answer(addPhone, [...padding, onTop], lying));
      expect(whole.took.map((item) => item.held.hash)).toEqual([onTop.hash]);
      expect({ ...whole, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, ...padding, onTop]), stopped: { seq: 3, code: "chain_broken" }, stuck: true });
      expect(await shownEntries(member, answer(addPhone, padding, lying))).toEqual({ ...quiet, member });
      expect(await shownEntries(member, answer(last(padding), [onTop], lying))).toEqual({ ...quiet, member, asks_after: 1 });
    });
  });

  describe("it is shown the entries after its footing", () => {
    test("padding shown and then the true list: it follows the true list, and its state is as if it had never seen the padding", async () => {
      for (const count of [1, 2, 3]) {
        const member = await memberOf([...root, ...padding.slice(0, count)]);
        const top = last(padding.slice(0, count));
        const learns = await shownEntries(member, answer(top, real.slice(count)));
        expect(learns).toEqual({ ...quiet, member, asks_after: 1 });
        const result = await shownEntries(member, answer(addPhone, real));
        expect(result.dropped_from).toBe(2);
        expect(result.stopped).toBeNull();
        expect(result.took.map((taken) => taken.held.hash)).toEqual(real.map((link) => link.hash));
        expect(result.member).toEqual(await memberOf([...root, ...real]));
      }
    });

    test("an entry that is the same entry as its own at that place changes nothing, whatever its signature", async () => {
      const member = await padded();
      expect(await shownEntries(member, answer(addPhone, padding))).toEqual({ ...quiet, member });
      expect(await shownEntries(member, answer(addPhone, padding.slice(0, 2)))).toEqual({ ...quiet, member });
      const first = entryFromText(at(padding, 0).text);
      const signedAgain = entryToText({ body: first.body, signature: new Uint8Array(await crypto.subtle.sign(SIGN, service.pair.privateKey, new Uint8Array(first.body))) });
      expect(signedAgain).not.toBe(at(padding, 0).text);
      expect(await shownEntries(member, { after: 1, entries: [signedAgain, badlySigned(at(padding, 1))], head: place(last(padding)) })).toEqual({ ...quiet, member });
    });

    test("at the first place where it is another entry that holds there, it drops its own entries from that place on and takes what it is shown", async () => {
      const member = await padded();
      const other = await row(at(padding, 0), [owner, { kind: "device", adds: [watch, "bound"] }], [stranger, {}]);
      const result = await shownEntries(member, answer(addPhone, [at(padding, 0), ...other]));
      expect(result.dropped_from).toBe(3);
      expect(result.member.entries).toEqual(texts([...root, at(padding, 0), ...other]));
      expect(result.took.map((taken) => taken.outcome)).toEqual([reads(), passedOver("signer_unknown")]);
      expect(result.member.state.footing).toEqual(place(at(other, 0)));
      expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", watch: "bound" });
    });

    test("it drops all of its own entries from that place on, also those past the head it is shown", async () => {
      const result = await shownEntries(await padded(), answer(addPhone, real.slice(0, 1)));
      expect(result.dropped_from).toBe(2);
      expect(result.member).toEqual(await memberOf([...root, at(real, 0)]));
    });

    test("nothing it drops had an effect: a key that only a dropped entry named can still be added", async () => {
      const adds = await on(addPhone, owner, { kind: "device", adds: [late, "bound"] });
      const result = await shownEntries(await padded(), answer(addPhone, [adds]));
      expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", late: "bound" });
      expect(madeOf(result.member.state)).toEqual(["owner", "phone", "late"]);
    });

    test("it is done entry by entry: after an entry that does not hold, its head stands at the last entry it took, and what it dropped stays dropped", async () => {
      const other = await row(at(padding, 0), [phone, {}], [owner, {}], [phone, {}]);
      const first = await shownEntries(await padded(), { after: 1, entries: [at(padding, 0).text, at(other, 0).text, badlySigned(at(other, 1)), at(other, 2).text], head: place(last(other)) });
      expect(first.stopped).toEqual({ seq: 4, code: "signature_invalid" });
      expect(first.dropped_from).toBe(3);
      expect(first.member).toEqual(await memberOf([...root, at(padding, 0), at(other, 0)]));
      const second = await shownEntries(first.member, answer(at(other, 0), other.slice(1)));
      expect(second.member).toEqual(await memberOf([...root, at(padding, 0), ...other]));
    });

    test("after a page that breaks off, its own entries before the first place that differed stay", async () => {
      const member = await padded();
      expect(await shownEntries(member, answer(addPhone, padding.slice(0, 1), place(last(real))))).toEqual({ ...quiet, member });
      const other = await row(at(padding, 0), [phone, {}]);
      const next = await shownEntries(member, answer(at(padding, 0), other));
      expect(next.dropped_from).toBe(3);
      expect(next.member).toEqual(await memberOf([...root, at(padding, 0), ...other]));
    });

    test("an entry that does not hold in the place of a loose one stops it, and nothing is dropped", async () => {
      const member = await padded();
      const cases: readonly (readonly [string, ListRefusalCode])[] = [
        [`${at(real, 0).text}=`, "entry_malformed"],
        [badlySigned(at(real, 0)), "signature_invalid"],
        [(await on(addPhone, owner, { change: { seq: 5 } })).text, "chain_broken"],
        [(await on(addPhone, owner, { change: { list: otherList } })).text, "chain_broken"],
      ];
      for (const [text, code] of cases) {
        expect(await shownEntries(member, { after: 1, entries: [text, at(real, 1).text], head: place(last(real)) })).toEqual({ ...quiet, member, stopped: { seq: 2, code } });
      }
    });

    test("an entry further on that does not continue a loose entry before it makes it go back, as the first entry of an answer does", async () => {
      const member = await padded();
      const stray = await on(at(real, 0), owner, {});
      expect(await shownEntries(member, answer(addPhone, [at(padding, 0), stray]))).toEqual({ ...quiet, member, asks_after: 1 });
      expect(await shownEntries(member, answer(at(padding, 0), [stray]))).toEqual({ ...quiet, member, asks_after: 1 });
      const loose = await on(at(real, 0), service, {});
      const result = await shownEntries(await memberOf(root), answer(addPhone, [at(real, 0), loose, await on(at(real, 1), owner, {})]));
      expect(result.took.map((taken) => [taken.held.hash, taken.outcome.outcome])).toEqual([[at(real, 0).hash, "reads"], [loose.hash, "passed_over"]]);
      expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(real, 0), loose]), asks_after: 2 });
      expect([result.member.state.footing, listHead(result.member)]).toEqual([place(at(real, 0)), place(loose)]);
    });

    test("when a later page does not continue the entry it follows, it asks for the entries after its footing again", async () => {
      const member = await padded();
      expect(await shownEntries(member, answer(at(padding, 0), real.slice(1)))).toEqual({ ...quiet, member, asks_after: 1 });
    });
  });

  describe("it is shown another history under its footing", () => {
    const stuckAt = (seq: number): { stopped: ListStop; stuck: boolean } => ({ stopped: { seq, code: "chain_broken" }, stuck: true });

    test("the first entry after its footing does not continue the footing: it stops and says stuck, and keeps its head and its state", async () => {
      for (const links of [root, [...root, ...padding], [...root, ...real]]) {
        const member = await memberOf(links);
        const { seq } = member.state.footing;
        const shown = fork.slice(seq);
        expect(await shownEntries(member, { after: seq, entries: texts(shown), head: place(last(shown)) })).toEqual({ ...quiet, member, ...stuckAt(seq + 1) });
      }
    });

    test("the answer's head lies at or before the footing with another hash than its own entry there", async () => {
      const member = await memberOf([...root, ...real]);
      for (const link of fork.slice(0, 5)) {
        for (const after of [last(real).seq, at(real, 1).seq]) expect(await shownEntries(member, { after, entries: [], head: place(link) })).toEqual({ ...quiet, member, ...stuckAt(link.seq) });
      }
      const loose = await padded();
      expect(await shownEntries(loose, { after: last(padding).seq, entries: [], head: place(at(fork, 0)) })).toEqual({ ...quiet, member: loose, ...stuckAt(1) });
    });

    test("no member goes back under its footing: another entry in the place of one a signer signed is not taken, and nothing is dropped", async () => {
      const member = await memberOf([...root, ...real]);
      const own = place(last(real));
      const other = await row(addPhone, [owner, { ends: phone }], [owner, {}]);
      expect(await shownEntries(member, answer(addPhone, other, own))).toEqual({ ...quiet, member, ...stuckAt(2) });
      expect(await shownEntries(member, answer(at(real, 0), other.slice(1), own))).toEqual({ ...quiet, member, ...stuckAt(3) });
      expect(await shownEntries(member, answer(addPhone, other))).toEqual({ ...quiet, member, ...stuckAt(3) });
      expect(await shownEntries(member, answer(addPhone, real))).toEqual({ ...quiet, member });
    });

    test("the footing moves with each entry it takes, also inside one answer: an entry further on that does not continue it stops the member at once, stuck", async () => {
      const elsewhere = await on(at(padding, 0), owner, {});
      const taken = await memberOf([...root, at(real, 0)]);
      const whole = await shownEntries(await memberOf(root), answer(addPhone, [at(real, 0), elsewhere]));
      expect(whole.took.map((item) => [item.held.hash, item.outcome.outcome])).toEqual([[at(real, 0).hash, "reads"]]);
      expect({ ...whole, took: [] }).toEqual({ ...quiet, member: taken, ...stuckAt(3) });
      expect([taken.state.footing, listHead(taken)]).toEqual([place(at(real, 0)), place(at(real, 0))]);
      const first = await shownEntries(await memberOf(root), answer(addPhone, [at(real, 0)]));
      expect([first.stopped, first.asks_after, first.member]).toEqual([null, null, taken]);
      expect(await shownEntries(first.member, answer(at(real, 0), [elsewhere]))).toEqual({ ...quiet, member: taken, ...stuckAt(3) });
      const member = await memberOf([...root, ...real]);
      expect(await shownEntries(member, answer(addPhone, [at(real, 0), elsewhere], place(last(real))))).toEqual({ ...quiet, member, ...stuckAt(3) });
      expect(await shownEntries(member, answer(addPhone, [at(real, 0), at(real, 1), await on(elsewhere, owner, {})], place(last(real))))).toEqual({ ...quiet, member, ...stuckAt(4) });
    });

    test("the answer's head is held against the footing as it stands after each entry it takes: at an entry it has just taken, with another hash, it stops there, stuck, and takes no further entry", async () => {
      const [other2, other3] = [place(at(padding, 0)), place(at(padding, 1))];
      const fresh = () => memberOf(root);
      for (const shown of [real.slice(0, 2), real.slice(0, 3), real.slice(0, 1)]) {
        const result = await shownEntries(await fresh(), answer(addPhone, shown, other2));
        expect(result.took.map((item) => item.held.hash)).toEqual([at(real, 0).hash]);
        expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(real, 0)]), ...stuckAt(2) });
      }
      const atSecond = await shownEntries(await fresh(), answer(addPhone, real.slice(0, 3), other3));
      expect(atSecond.took.map((item) => item.held.hash)).toEqual([at(real, 0).hash, at(real, 1).hash]);
      expect({ ...atSecond, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, ...real.slice(0, 2)]), ...stuckAt(3) });
      for (const head of [place(at(real, 0)), place(at(real, 1)), place(at(real, 2))]) {
        expect(await shownEntries(await fresh(), answer(addPhone, real.slice(0, 3), head))).toMatchObject({ stopped: null, stuck: false, asks_after: null, member: await memberOf([...root, ...real.slice(0, 3)]) });
      }
    });

    test("once an entry by a signer has made its own loose entry part of the list, a head that names another entry there is another history under its footing: the stop names the head's place", async () => {
      const member = await memberOf([...root, ...padding.slice(0, 2)]);
      const onLoose = await on(at(padding, 0), owner, { kind: "device", adds: [watch, "bound"] });
      const result = await shownEntries(member, answer(addPhone, [at(padding, 0), onLoose, await on(onLoose, phone, {})], place(at(real, 0))));
      expect(result.took.map((item) => item.held.hash)).toEqual([onLoose.hash]);
      expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(padding, 0), onLoose]), dropped_from: 3, ...stuckAt(2) });
      expect([result.member.state.footing, listHead(result.member)]).toEqual([place(onLoose), place(onLoose)]);
    });

    test("asked after a place below its footing and shown another entry at the footing's own place, it stops there, stuck, also when the answer's head lies past its own", async () => {
      const member = await memberOf([...root, ...real]);
      const atFooting = await on(at(real, 2), owner, { kind: "device", adds: [late, "full"] });
      const beyond = await on(atFooting, owner, {});
      expect([atFooting.seq, member.state.footing.seq, atFooting.hash === last(real).hash]).toEqual([5, 5, false]);
      for (const head of [place(beyond), place(atFooting)]) {
        expect(await shownEntries(member, { after: 4, entries: texts([atFooting, beyond]), head })).toEqual({ ...quiet, member, ...stuckAt(5) });
        expect(await shownEntries(member, { after: 1, entries: texts([...real.slice(0, 3), atFooting]), head })).toEqual({ ...quiet, member, ...stuckAt(5) });
      }
    });

    test("an entry that fails in more than that is no other history: it stops there, and is not stuck", async () => {
      const member = await memberOf(root);
      const elsewhere = at(fork, 0);
      const cases = [
        await on(elsewhere, owner, { signedWith: phone }),
        await on(elsewhere, owner, { change: { seq: 3 } }),
        await on(elsewhere, owner, { change: { list: otherList } }),
        await on(addPhone, owner, { change: { prev: "" } }),
      ];
      for (const link of cases) expect(await shownEntries(member, { after: 1, entries: [link.text], head: { seq: 2, hash: link.hash } })).toEqual({ ...quiet, member, stopped: { seq: 2, code: "chain_broken" } });
    });

    test("it lasts until it is shown its own history again", async () => {
      const member = await memberOf(root);
      const stuck = await shownEntries(member, answer(addPhone, fork.slice(1)));
      expect([stuck.stuck, stuck.member]).toEqual([true, member]);
      const again = await shownEntries(stuck.member, answer(addPhone, real));
      expect([again.stuck, again.stopped]).toEqual([false, null]);
      expect(again.member).toEqual(await memberOf([...root, ...real]));
    });
  });

  test("what a member does never depends on where an answer was cut: each answer here, cut in two at every place, ends as it does whole", async () => {
    const elsewhere = await on(at(padding, 0), owner, {});
    const onElsewhere = await on(elsewhere, owner, {});
    const loose = await on(at(real, 0), service, {});
    const onReal = await on(at(real, 1), owner, {});
    const stray = await on(at(real, 0), owner, {});
    const onLoose = await row(at(padding, 0), [owner, { kind: "device", adds: [watch, "bound"] }], [stranger, {}]);
    const onTop = await row(last(padding), [owner, { kind: "device", adds: [watch, "bound"] }], [phone, {}]);
    const wrongSeq = await on(at(real, 0), owner, { change: { seq: 9 } });
    const wrongList = await on(at(real, 0), owner, { change: { list: otherList } });
    const onPadding = await on(at(padding, 1), service, {});
    const true2 = await on(addPhone, stranger, {});
    const stale3 = await on(true2, service, {});
    const list3 = await on(true2, owner, { kind: "device", adds: [watch, "bound"] });
    const withPadding = [...root, ...padding];
    const cases: readonly (readonly [string, readonly Link[], Link, readonly string[], ListPlace, "stuck" | "asks" | "stopped" | "took"])[] = [
      ["another entry 3 after an entry it takes", root, addPhone, texts([at(real, 0), elsewhere]), place(elsewhere), "stuck"],
      ["another entry 4 after two entries it takes", root, addPhone, texts([at(real, 0), at(real, 1), onElsewhere]), place(onElsewhere), "stuck"],
      ["another entry 4 after its own entries under the footing", [...root, ...real], addPhone, texts([at(real, 0), at(real, 1), onElsewhere]), place(last(real)), "stuck"],
      ["an entry on another entry 2 after its own loose entry", withPadding, addPhone, texts([at(padding, 0), stray]), place(stray), "asks"],
      ["an entry on another entry 3 after a loose entry it takes", root, addPhone, texts([at(real, 0), loose, onReal]), place(onReal), "asks"],
      ["the true list in the place of its padding", withPadding, addPhone, texts(real), place(last(real)), "took"],
      ["other entries from the second place on", withPadding, addPhone, texts([at(padding, 0), ...onLoose]), place(last(onLoose)), "took"],
      ["entries on top of its loose entries", withPadding, last(padding), texts(onTop), place(last(onTop)), "took"],
      ["a signature that does not verify, further on", root, addPhone, [at(real, 0).text, at(real, 1).text, badlySigned(at(real, 2)), at(real, 3).text], place(last(real)), "stopped"],
      ["a wrong seq after an entry it takes", root, addPhone, texts([at(real, 0), wrongSeq, at(real, 1)]), place(at(real, 1)), "stopped"],
      ["another list after an entry it takes", root, addPhone, texts([at(real, 0), wrongList]), place(at(real, 1)), "stopped"],
      ["a head at the first entry it takes, with another hash", root, addPhone, texts(real.slice(0, 3)), place(at(padding, 0)), "stuck"],
      ["a head at the second entry it takes, with another hash", root, addPhone, texts(real.slice(0, 3)), place(at(padding, 1)), "stuck"],
      ["a head at the last entry it takes, with another hash", root, addPhone, texts(real.slice(0, 3)), place(at(padding, 2)), "stuck"],
      ["a head at a loose entry it takes, with another hash", root, addPhone, texts([...padding.slice(0, 2), onPadding]), place(at(real, 0)), "asks"],
      ["its true loose entry again, then the list's entry in the place of a stale one", [...root, true2, stale3], addPhone, texts([true2, list3]), place(list3), "took"],
      ["a head at its own loose entry, with another hash, once an entry by a signer has taken the place of the next", [...root, ...padding.slice(0, 2)], addPhone, texts([at(padding, 0), ...onLoose]), place(at(real, 0)), "stuck"],
    ];
    const cameTo = (result: Awaited<ReturnType<typeof shownEntries>>) => ({ ...result, took: result.took.map((item) => [item.held.hash, item.outcome.outcome]) });
    for (const [name, links, after, shown, head, end] of cases) {
      const whole = await shownEntries(await memberOf(links), { after: after.seq, entries: shown, head });
      expect([name, whole.stuck ? "stuck" : whole.stopped !== null ? "stopped" : whole.asks_after !== null ? "asks" : "took"]).toEqual([name, end]);
      for (let cut = 1; cut < shown.length; cut++) {
        const first = await shownEntries(await memberOf(links), { after: after.seq, entries: shown.slice(0, cut), head });
        const second = first.stopped !== null || first.asks_after !== null ? null : await shownEntries(first.member, { after: after.seq + cut, entries: shown.slice(cut), head });
        const inTwo = second === null ? cameTo(first) : { ...cameTo(second), took: [...cameTo(first).took, ...cameTo(second).took], dropped_from: first.dropped_from ?? second.dropped_from };
        expect([name, cut, inTwo]).toEqual([name, cut, cameTo(whole)]);
      }
    }
  });

  test("a lying service cannot turn its own entries into a member's footing", async () => {
    let member = await memberOf(root);
    let head = addPhone;
    for (let round = 0; round < 3; round++) {
      const more = await row(head, [service, { kind: "device", adds: [service, "full"] }], [service, { ends: owner }]);
      member = (await shownEntries(member, answer(head, more))).member;
      head = last(more);
      expect(member.state).toEqual(await stateOf(root));
    }
    expect(member.entries.length).toBe(8);
    expect((await shownEntries(member, answer(addPhone, real))).member).toEqual(await memberOf([...root, ...real]));
  });

  test("a state whose footing is not the member's own entry at that place is the caller's mistake", async () => {
    const member = await memberOf([...root, ...real]);
    const other = await on(at(real, 2), owner, {});
    const states: SignersState[] = [
      { ...member.state, footing: { seq: 6, hash: last(real).hash } },
      { ...member.state, footing: { seq: 5, hash: other.hash } },
      { ...member.state, footing: { seq: 4, hash: last(real).hash } },
    ];
    for (const state of states) await expect(shownEntries({ entries: member.entries, state }, answer(last(real), []))).rejects.toBeInstanceOf(RangeError);
    await expect(shownEntries({ entries: member.entries.slice(0, 3), state: member.state }, answer(at(real, 0), []))).rejects.toBeInstanceOf(RangeError);
    expect(await shownEntries(member, answer(last(real), []))).toEqual({ ...quiet, member });
  });

  test("a proof is handed a state of its own: what it keeps is as it was when it was asked, whatever a later entry of the same answer, or of the same replay, writes, and what it tries to write into it changes nothing", async () => {
    const entries = await row(addPhone,
      [owner, { kind: "device", v: 2, adds: [watch, "bound"] }], [stranger, { kind: "later_login", v: 2 }], [owner, { kind: "device", adds: [late, "bound"] }], [stranger, { kind: "later_login", v: 2 }]);
    for (const through of ["an answer", "a replay"] as const) {
      const handed: SignersState[] = [];
      const written: boolean[] = [];
      const keeps: KeyProof = (_held, state) => {
        handed.push(state);
        written.push(Reflect.set(state.signers, stranger.key, { power: "full", seq: 0, by: null, ended: null }));
        return null;
      };
      const result = through === "an answer" ? (await shownEntries(await memberOf(root, 2), answer(addPhone, entries), keeps)).member : (await replayEntries(texts([...root, ...entries]), 2, { saved: null, proof: keeps })).member;
      const [first, second] = handed;
      if (!first || !second || result === null) throw new Error("the rule was not asked twice");
      expect([through, handed.length, first.footing.seq, second.footing.seq]).toEqual([through, 2, 2, 4]);
      expect([through, first.signers === second.signers, Object.keys(first.signers).map((key) => names.get(key)), Object.keys(second.signers).map((key) => names.get(key))])
        .toEqual([through, false, ["owner", "phone", "watch"], ["owner", "phone", "watch", "late"]]);
      expect([through, Object.isFrozen(first), Object.isFrozen(first.signers), written, signerPower(result.state, stranger.key)]).toEqual([through, true, true, [false, false], null]);
    }
  });

  test("an answer changes nothing it was given: the member's state and its rows stay as they were, also when they are frozen", async () => {
    const member = await memberOf(base);
    const before = JSON.stringify(member);
    Object.freeze(member.state.signers);
    Object.freeze(member.state);
    const entries = await row(addInvite, [owner, { ends: watch }], [phone, { kind: "device", adds: [late, "full"] }], [late, { ends: invite }]);
    const result = await shownEntries(member, answer(addInvite, entries));
    expect(JSON.stringify(member)).toBe(before);
    expect(result.member).toEqual(await memberOf([...base, ...entries]));
    expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", late: "full" });
    const kept = JSON.stringify(result.member);
    const more = await row(last(entries), [owner, { ends: late }], [phone, { kind: "device", adds: [stranger, "bound"] }]);
    expect(who((await shownEntries(result.member, answer(last(entries), more))).member.state)).toEqual({ owner: "full", phone: "full", stranger: "bound" });
    expect(JSON.stringify(result.member)).toBe(kept);
  });

  test("an answer is taken as the member and the answer were handed over: changed while a signature is checked, they change nothing that comes back", async () => {
    const shown = await row(addPhone, [phone, {}], [owner, {}]);
    const elsewhere = "f".repeat(64);
    const handed = async () => {
      const { entries, state } = await memberOf(root);
      const signers = Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, { ...row }]));
      return {
        member: { entries: [...entries], state: { ...state, footing: { ...state.footing }, signers } },
        answer: { after: addPhone.seq, entries: texts(shown), head: { ...place(last(shown)) } },
      };
    };
    const plain = await handed();
    const unchanged = await shownEntries(plain.member, plain.answer);
    expect(unchanged.took.map((taken) => taken.held.hash)).toEqual(shown.map((link) => link.hash));
    const changes: readonly (readonly [string, (given: Awaited<ReturnType<typeof handed>>) => void])[] = [
      ["the state's list id", ({ member }) => { member.state.list = elsewhere; }],
      ["the state's footing", ({ member }) => { member.state.footing.seq = 5; }],
      ["a row taken out of the state", ({ member }) => { delete member.state.signers[phone.key]; }],
      ["each row written", ({ member }) => { for (const row of Object.values(member.state.signers)) row.ended = 1; }],
      ["the answer's entries", ({ answer }) => { answer.entries.length = 1; }],
      ["the answer's head", ({ answer }) => { answer.head.hash = elsewhere; }],
    ];
    for (const [what, change] of changes) {
      const given = await handed();
      const result = await whileVerifying(() => change(given), () => shownEntries(given.member, given.answer));
      expect([what, result]).toEqual([what, unchanged]);
    }
  });

  test("a member's rows are read once, frozen ones too: a row whose power reads otherwise while a signature is checked is taken as it first read", async () => {
    const byWatch = await on(addInvite, watch, { kind: "device", adds: [late, "full"] });
    const member = await memberOf(base);
    const unchanged = await shownEntries(member, answer(addInvite, [byWatch]));
    expect(unchanged.took.map((taken) => taken.outcome)).toEqual([passedOver("signer_not_allowed")]);
    const live: { power: SignerPower } = { power: "bound" };
    const row = Object.freeze(Object.defineProperty(rowBy("bound", addWatch, owner), "power", { get: () => live.power, enumerable: true }));
    const given = { entries: member.entries, state: { ...member.state, signers: { ...member.state.signers, [watch.key]: row } } };
    expect([Object.isFrozen(row), signerPower(given.state, watch.key)]).toEqual([true, "bound"]);
    const result = await whileVerifying(() => { live.power = "full"; }, () => shownEntries(given, answer(addInvite, [byWatch])));
    expect(result).toEqual(unchanged);
  });

  test("an answer that follows a place the member does not hold is the caller's mistake", async () => {
    const member = await memberOf(root);
    for (const after of [2, -1, 0.5, Number.NaN]) await expect(shownEntries(member, { after, entries: [], head: place(addPhone) })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("what a caller hands in is read as its type names it, whatever carries its fields", () => {
  const getters = (data: object) => Object.fromEntries(Object.keys(data).map((name) => [name, { get: (): unknown => Reflect.get(data, name) }]));
  /** The same data as an object whose fields are getters: inherited from its prototype, or its own and not enumerable. A spread finds no field of either. */
  const carried: readonly (readonly [string, <T extends object>(data: T) => T])[] = [
    ["inherited", (data) => Object.create(Object.create(Object.prototype, getters(data)))],
    ["its own, not enumerable", (data) => Object.create(Object.prototype, getters(data))],
  ];

  test("an answer's head: one that names another entry under the footing stops the member, stuck", async () => {
    const member = await memberOf([g]);
    const other = { seq: 0, hash: otherList };
    const stuck = await shownEntries(member, { after: 0, entries: [], head: other });
    expect([stuck.stuck, stuck.stopped]).toEqual([true, { seq: 0, code: "chain_broken" }]);
    for (const [how, as] of carried) expect([how, await shownEntries(member, { after: 0, entries: [], head: as(other) })]).toEqual([how, stuck]);
  });

  test("a member's state, its footing and its rows: an entry by a signer is read", async () => {
    const member = await memberOf(root);
    const next = await on(addPhone, phone, {});
    const taken = await shownEntries(member, answer(addPhone, [next]));
    expect(taken.took.map((item) => item.outcome)).toEqual([reads()]);
    const { state } = member;
    for (const [how, as] of carried) {
      const states: readonly (readonly [string, SignersState])[] = [
        ["its footing", { ...state, footing: as(state.footing) }],
        ["its rows", { ...state, signers: Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, as(row)])) }],
        ["its state", as(state)],
      ];
      for (const [what, given] of states) expect([how, what, await shownEntries({ entries: member.entries, state: given }, answer(addPhone, [next]))]).toEqual([how, what, taken]);
    }
  });

  test("a row that a state's rows hold as a property of their own that is not enumerable is a row: for an answer, for judgeEntry and for a saved state", async () => {
    const member = await memberOf(root);
    const { state } = member;
    /** The phone's row is of the rows' own and not enumerable: signerPower finds it, Object.entries and a spread do not. */
    const hidden = { ...state, signers: Object.defineProperty({ ...state.signers }, phone.key, { enumerable: false }) };
    expect([Object.keys(hidden.signers).length, signerPower(hidden, phone.key)]).toEqual([1, "full"]);
    const next = await on(addPhone, phone, { kind: "device", adds: [watch, "bound"] });
    const taken = await shownEntries(member, answer(addPhone, [next]));
    expect(taken.took.map((item) => item.outcome)).toEqual([reads()]);
    expect(await shownEntries({ entries: member.entries, state: hidden }, answer(addPhone, [next]))).toEqual(taken);
    expect(judgeEntry(hidden, at(taken.took, 0).held).state.signers).toEqual(taken.member.state.signers);
    expect(readSignersState(hidden, state.level)).toEqual(state);
  });

  test("judgeEntry: the state it gives has the level and the list of the one it was given, and a key it ends keeps the rest of its row", async () => {
    const out = await on(addInvite, owner, { ends: watch });
    const state = await stateOf(base);
    const { held } = last((await replay([...base, out])).took);
    const plain = judgeEntry(state, held);
    expect(plain.state.signers[watch.key]).toEqual(rowBy("bound", addWatch, owner, out));
    for (const [how, as] of carried) {
      expect([how, judgeEntry(as(state), held)]).toEqual([how, plain]);
      const rows = Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, as(row)]));
      expect([how, judgeEntry({ ...state, signers: rows }, held).state.signers[watch.key]]).toEqual([how, rowBy("bound", addWatch, owner, out)]);
    }
  });
});

describe("what a caller hands in is taken once, when it is handed over", () => {
  const isData = (value: unknown): value is object => typeof value === "object" && value !== null && !(value instanceof Uint8Array);
  function frozen<T>(value: T): T {
    if (!isData(value)) return value;
    const copy: T & object = Array.isArray(value) ? Object.assign([], value) : { ...value };
    for (const name of Object.keys(copy)) Reflect.set(copy, name, frozen(Reflect.get(copy, name)));
    Object.freeze(copy);
    return copy;
  }
  function shifting<T extends object>(first: T, later: T, turned: () => boolean): T {
    const read = new Set<string>();
    const born = turned();
    const target: T = Array.isArray(first) ? Object.assign([], first) : { ...first };
    return new Proxy(target, {
      get(_target, name) {
        if (typeof name === "symbol") return Reflect.get(first, name);
        const [now, then] = read.has(name) || (!born && turned()) ? [later, first] : [first, later];
        read.add(name);
        const value: unknown = Reflect.get(now, name);
        const other: unknown = Reflect.get(then, name);
        return isData(value) ? shifting(value, isData(other) ? other : value, turned) : value;
      },
    });
  }
  type Handed = <T extends object>(first: T, later: T) => T;

  test("every function gives, for objects that read otherwise at each reading after the first, what it gives for plain frozen data of what they first read: so also when they read otherwise from the moment a signature is being checked", async () => {
    const more = await row(addInvite, [owner, { kind: "device", adds: [late, "full"] }], [phone, { ends: watch }]);
    const a = await memberOf(base);
    const tookA = (await replay([...base, ...more])).took;
    const otherZero = await genesis(phone);
    const others = [otherZero, ...(await row(otherZero,
      [phone, { kind: "device", adds: [watch, "full"] }], [phone, { kind: "device", adds: [owner, "bound"] }], [watch, { v: 5 }], [phone, { ends: owner }], [watch, {}], [phone, {}], [watch, {}]))];
    const b = await memberOf(others.slice(0, 5), 3);
    const tookB = (await replay(others, 3)).took;
    const shownA = answer(addInvite, more);
    const shownB = answer(at(others, 4), others.slice(5));
    const rises = await on(addInvite, owner, { kind: "later", v: 2 });
    const above = await memberOf([...base, rises], 2);
    const enters = await on(rises, login, { kind: "later_login", v: 2 });
    const byLogin = await on(enters, login, { kind: "device", adds: [late, "bound"] });
    const entersHeld = at((await replay([...base, rises, enters], 2)).took, 5).held;
    let heard = 0;
    const lets = (handed: Handed): KeyProof => (held, state) => {
      if (!(held.hash === enters.hash && held.body.signer === login.key && state.level === 2 && state.footing.seq === rises.seq)) return null;
      heard++;
      return handed<NonNullable<ReturnType<KeyProof>>>({ key: login.key, power: "full" }, { key: stranger.key, power: "bound" });
    };
    const behindYet = await stateOf([...base, rises]);
    const entry = (link: Link) => entryFromText(link.text);
    const saved = (state: SignersState): SignersState => JSON.parse(JSON.stringify(state));

    const calls: readonly (readonly [string, boolean, (handed: Handed) => unknown])[] = [
      ["signerPower", false, (handed) => signerPower(handed(a.state, b.state), watch.key)],
      ["isBehind", false, (handed) => isBehind(handed(a.state, b.state))],
      ["firstSignersState", false, (handed) => firstSignersState(handed(at(tookA, 0).held, at(tookB, 0).held), 1)],
      ["judgeEntry", false, (handed) => judgeEntry(handed(a.state, b.state), handed(at(tookA, 4).held, at(tookB, 1).held))],
      ["judgeEntry, its state alone", false, (handed) => judgeEntry(handed(a.state, b.state), frozen(at(tookA, 4).held))],
      ["judgeEntry, its entry alone", false, (handed) => judgeEntry(frozen(a.state), handed(at(tookA, 4).held, at(tookB, 1).held))],
      ["judgeEntry, with a proof", false, (handed) => judgeEntry(handed(above.state, b.state), handed(entersHeld, at(tookB, 1).held), lets(handed))],
      ["judgeEntry, of a member that is behind", false, (handed) => judgeEntry(handed(behindYet, above.state), frozen(entersHeld))],
      ["listHead", false, (handed) => listHead(handed(a, b))],
      ["signingPlace", false, (handed) => signingPlace(handed(a, b), handed(place(addInvite), place(at(others, 4))))],
      ["readSignersState", false, (handed) => readSignersState(handed(saved(a.state), saved(b.state)), 3)],
      ["shownEntries", true, (handed) => shownEntries(handed(a, b), handed(shownA, shownB))],
      ["shownEntries, with a proof", true, (handed) => shownEntries(handed(above, b), handed(answer(rises, [enters, byLogin]), shownB), lets(handed))],
      ["shownEntries, shown its own entry again", false, (handed) => shownEntries(handed(a, b), handed(answer(addWatch, [addInvite]), shownB))],
      ["replayEntries", true, (handed) => replayEntries(handed(texts([...base, ...more]), texts(others)), 1, handed<{ given: string; saved: SignersState | null }>({ given: g.hash, saved: a.state }, { given: otherZero.hash, saved: b.state }))],
      ["replayEntries, with a proof", true, (handed) => replayEntries(handed(texts([...base, rises, enters, byLogin]), texts(others)), 2, handed<{ saved: null; proof: KeyProof }>({ saved: null, proof: lets(handed) }, { saved: null, proof: () => null }))],
      ["replayEntries, of what is no entry", false, (handed) => replayEntries(handed(["not an entry"], texts(others)), 1, handed<{ saved: null; given?: string }>({ saved: null }, { saved: null, given: otherZero.hash }))],
      ["entryHolds", true, (handed) => entryHolds(handed(entry(addPhone), entry(at(others, 2))), handed(at(tookA, 0).held, at(tookB, 1).held))],
      ["entryHolds, of an entry out of its place", false, (handed) => entryHolds(handed(entry(addWatch), entry(at(others, 2))), handed(at(tookA, 0).held, at(tookB, 1).held))],
      ["firstState", true, (handed) => firstState(handed(entry(g), entry(otherZero)), g.hash)],
    ];
    const cameTo = async (work: () => unknown): Promise<unknown> => {
      try {
        return await work();
      } catch (error) {
        return { thrown: error instanceof ListEntryError ? error.code : String(error) };
      }
    };
    const blind: string[] = [];
    const differs: string[] = [];
    for (const [name, verifies, call] of calls) {
      const plain = await cameTo(() => call((first) => frozen(first)));
      if (isDeepStrictEqual(await cameTo(() => call((_first, later) => frozen(later))), plain)) blind.push(name);
      if (!isDeepStrictEqual(await cameTo(() => call((first, later) => shifting(first, later, () => false))), plain)) differs.push(name);
      if (!verifies) continue;
      let turned = false;
      const pending = await cameTo(() => whileVerifying(() => { turned = true; }, async () => call((first, later) => shifting(first, later, () => turned))));
      if (!isDeepStrictEqual(pending, plain)) differs.push(`${name}, while a signature is checked`);
    }
    expect({ blind, differs }).toEqual({ blind: [], differs: [] });
    expect(heard).toBe(8);
  });
});

describe("where a member signs", () => {
  test("only on its footing: the place after it, on its hash", async () => {
    const member = await memberOf([...root, ...real]);
    expect(signingPlace(member, place(last(real)))).toEqual({ list: g.hash, prev: last(real).hash, seq: 6 });
  });

  test("when the head it is shown lies past its footing, it places nothing", async () => {
    const member = await memberOf([...root, ...padding]);
    expect(signingPlace(member, place(last(padding)))).toBeNull();
    expect(signingPlace(member, place(at(padding, 0)))).toBeNull();
    expect(signingPlace(await memberOf(root), place(at(real, 0)))).toBeNull();
  });

  test("shown another entry at or under its footing, it places nothing: that is another history, which an answer stops as stuck", async () => {
    const zero = await memberOf([g]);
    const other = { seq: 0, hash: otherList };
    expect(signingPlace(zero, other)).toBeNull();
    expect(await shownEntries(zero, { after: 0, entries: [], head: other })).toMatchObject({ stopped: { seq: 0, code: "chain_broken" }, stuck: true });
    const member = await memberOf([...root, ...real]);
    for (const link of fork.slice(0, 5)) expect([link.seq, signingPlace(member, place(link))]).toEqual([link.seq, null]);
    expect(signingPlace(member, place(at(real, 1)))).toEqual({ list: g.hash, prev: last(real).hash, seq: 6 });
    for (const seq of [-1, 0.5, Number.NaN]) expect([seq, signingPlace(member, { seq, hash: g.hash })]).toEqual([seq, null]);
  });

  test("with loose entries of its own and a log that ends at its footing, it signs on its footing; its entry takes their place when the log shows it", async () => {
    const member = await memberOf([...root, ...padding]);
    expect(signingPlace(member, place(addPhone))).toEqual({ list: g.hash, prev: addPhone.hash, seq: 2 });
    const placed = at(real, 0);
    expect((await shownEntries(member, { after: last(padding).seq, entries: [], head: place(placed) })).asks_after).toBe(1);
    expect((await shownEntries(member, answer(addPhone, [placed]))).member).toEqual(await memberOf([...root, placed]));
  });
});

const turnsOn = await on(addPhone, owner, { kind: "later", v: 2 });
const enters = await on(turnsOn, login, { kind: "later_login", v: 2 });
const byLogin = await row(enters, [login, { kind: "device", adds: [late, "bound"] }], [login, { ends: phone }]);
const loginLog = [...root, turnsOn, enters, ...byLogin];
const letsIn = (power: SignerPower, key: Key = login, entry: Link = enters): KeyProof => (held) => (held.hash === entry.hash ? { key: key.key, power } : null);

describe("a member of a higher level, and a key that a later kind lets in on a proof of its own", () => {
  test("it holds the key as a signer from the next entry on, with the power that kind names, and applies what the key signs", async () => {
    const member = await memberOf(loginLog, 2, letsIn("full"));
    expect(who(member.state)).toEqual({ owner: "full", login: "full", late: "bound" });
    expect(madeOf(member.state)).toEqual(["owner", "phone", "late"]);
    expect(member.state.signers[login.key]).toEqual(rowBy("full", enters, null));
    expect(Object.isFrozen(member.state.signers[login.key])).toBe(true);
    expect([member.state.signers[late.key], member.state.signers[phone.key]]).toEqual([rowBy("bound", at(byLogin, 0), login), rowBy("full", addPhone, owner, at(byLogin, 1))]);
    expect(member.state.footing).toEqual(place(last(byLogin)));
    expect((await outcomesOf(loginLog, 2, letsIn("full"))).slice(3)).toEqual([reads(null), reads(), reads()]);
    expect(who(await stateOf([...root, turnsOn, enters], 2, letsIn("bound")))).toEqual({ owner: "full", phone: "full", login: "bound" });
    expect((await outcomesOf(loginLog, 2, letsIn("bound"))).slice(4)).toEqual([passedOver("signer_not_allowed"), passedOver("signer_not_allowed")]);
  });

  test("an older member is behind before the key appears, and stops at the key's first entry: it takes neither that entry nor any after it", async () => {
    const older = await replay(loginLog, 1);
    if (older.member === null) throw new Error("entry 0 does not hold");
    expect([older.stopped, older.member.entries, older.took.length]).toEqual([{ seq: enters.seq, code: "needs_replay" }, texts([...root, turnsOn]), 3]);
    const { state } = older.member;
    expect([who(state), state.behind, state.footing, state.needs_replay]).toEqual([{ owner: "full", phone: "full" }, turnsOn.seq, place(turnsOn), place(enters)]);
    const { held } = at((await replay([...root, turnsOn, enters], 2)).took, 3);
    expect(judgeEntry(state, held)).toEqual({ outcome: { outcome: "stops", code: "needs_replay" }, state });
    expect((await outcomesOf(loginLog, 2)).slice(3)).toEqual([passedOver("signer_unknown"), passedOver("signer_unknown"), passedOver("signer_unknown")]);
    expect(await stateOf(loginLog, 2)).toEqual({ ...(await stateOf([...root, turnsOn], 1)), level: 2, behind: null });
  });

  test("a proof is asked only for an entry of a level above 1 that the list already needs: where no signer signed an entry of that level before it, or it carries v 1, no member hears a proof, so the older member, which is not behind there, takes nothing that the other passes over", async () => {
    for (const v of [2, 1]) {
      const early = await on(addPhone, login, { kind: "later_login", v });
      const tail = await row(early, [owner, { ends: login }], [owner, { kind: "device", adds: [login, "full"] }], [login, { ends: owner }]);
      const links = [...root, early, ...tail];
      const proof = letsIn("full", login, early);
      expect([v, isBehind(await stateOf(links, 1, proof))]).toEqual([v, false]);
      for (const level of [1, 2]) {
        expect([v, level, (await outcomesOf(links, level, proof)).slice(2)]).toEqual([v, level, [passedOver("signer_unknown"), passedOver("already_out"), reads(), reads()]]);
        expect([v, level, who(await stateOf(links, level, proof))]).toEqual([v, level, { phone: "full", login: "full" }]);
      }
    }
    expect([(await stateOf([...root, turnsOn], 1)).behind, (await outcomesOf([...root, turnsOn, enters], 2, letsIn("full")))[3]]).toEqual([turnsOn.seq, reads(null)]);
  });

  describe("a member that is behind goes on only while it holds what a member that reads everything holds", () => {
    async function besideLevel2(links: readonly Link[], proof?: KeyProof) {
      const older = await replay(links, 1, proof);
      if (older.member === null) throw new Error("entry 0 does not hold");
      const far = older.member.entries.length;
      const newer = await replay(links.slice(0, far), 2, proof);
      if (newer.member === null || newer.stopped !== null) throw new Error("the member of level 2 does not take them all");
      const passed = (took: typeof older.took) => took.map(({ outcome }) => (outcome.outcome === "passed_over" ? outcome.code : "taken"));
      expect(passed(older.took)).toEqual(passed(newer.took));
      expect([older.member.state.signers, older.member.state.footing]).toEqual([newer.member.state.signers, newer.member.state.footing]);
      return { far, stopped: older.stopped, signers: who(older.member.state) };
    }

    test("a key that a proof lets in ends itself, the owner adds it, and it ends the owner: the older member stops at the key's first entry, where a proof may let it in, and takes nothing after it", async () => {
      const tail = await row(enters, [login, { ends: login }], [owner, { kind: "device", adds: [login, "full"] }], [login, { ends: owner }]);
      const links = [...root, turnsOn, enters, ...tail];
      expect((await outcomesOf(links, 2, letsIn("full"))).slice(3)).toEqual([reads(null), reads(), passedOver("key_reused"), passedOver("signer_unknown")]);
      expect(await besideLevel2(links, letsIn("full"))).toEqual({ far: 3, stopped: { seq: enters.seq, code: "needs_replay" }, signers: { owner: "full", phone: "full" } });
    });

    test("two devices end one key, and an entry that puts another key in its place lands after it has ended; the owner adds that key, and it ends the phone: the older member passes over and takes what the other does, to the end", async () => {
      const tail = await row(turnsOn,
        [owner, { kind: "device", adds: [watch, "full"] }], [owner, { ends: watch }], [phone, { kind: "device", adds: [late, "bound"], ends: watch }],
        [owner, { kind: "device", adds: [late, "full"] }], [late, { ends: phone }]);
      const links = [...root, turnsOn, ...tail];
      expect((await outcomesOf(links, 2)).slice(5)).toEqual([passedOver("already_out"), reads(), reads()]);
      expect(await besideLevel2(links)).toEqual({ far: links.length, stopped: null, signers: { owner: "full", late: "full" } });
    });

    test("a signer ends a key that never was a signer, then adds it and ends its own key in one entry, and signs again: the older member takes the removal as the other does, and passes over what the old key signs", async () => {
      const tail = await row(turnsOn, [owner, { ends: late }], [owner, { kind: "device", adds: [late, "full"], ends: owner }], [owner, { kind: "device", adds: [watch, "full"] }]);
      const links = [...root, turnsOn, ...tail];
      expect((await outcomesOf(links, 2)).slice(3)).toEqual([passedOver("already_out"), reads(), passedOver("signer_unknown")]);
      expect(await besideLevel2(links)).toEqual({ far: links.length, stopped: null, signers: { phone: "full", late: "full" } });
    });

    test("a member that stopped for a replay stays stopped: shown another entry in the place where it stopped, it takes nothing and answers the same again; it places no entry to sign; its state, saved and read again, is still stopped; a replay keeps the stop unless it takes the entry at that place", async () => {
      const rises = await on(g, owner, { kind: "later", v: 2 });
      const key = await on(rises, login, { kind: "later_login", v: 2 });
      const other = await on(rises, owner, { kind: "device", adds: [watch, "bound"] });
      const stoppedAt: ListStop = { seq: key.seq, code: "needs_replay" };
      const first = await shownEntries(await memberOf([g], 1), answer(g, [rises, key]));
      expect([first.stopped, first.stuck, first.member.entries.length, first.member.state.needs_replay]).toEqual([stoppedAt, true, 2, place(key)]);
      expect(await shownEntries(first.member, answer(rises, [other]))).toEqual({ ...quiet, member: first.member, stopped: stoppedAt, stuck: true });
      expect(signingPlace(first.member, place(rises))).toBeNull();
      const { held } = at((await replay([g, rises, other], 2)).took, 2);
      expect(judgeEntry(first.member.state, held)).toEqual({ outcome: { outcome: "stops", code: "needs_replay" }, state: first.member.state });
      const loaded = readSignersState(JSON.parse(JSON.stringify(first.member.state)), first.member.state.level);
      if (loaded === null) throw new Error("the saved state does not read");
      expect([loaded, Object.keys(loaded)]).toEqual([first.member.state, ["level", "list", "footing", "needs", "behind", "signers", "needs_replay"]]);
      expect((await shownEntries({ entries: first.member.entries, state: loaded }, answer(rises, [other]))).stopped).toEqual(stoppedAt);
      for (const level of [1, 2]) {
        const again = await replayEntries(first.member.entries, level, { saved: loaded, proof: letsIn("full", login, key) });
        if (again.member === null) throw new Error("the replay holds no entry");
        expect([level, again.stopped, again.stuck, again.member.state.needs_replay, signingPlace(again.member, place(rises))]).toEqual([level, stoppedAt, true, place(key), null]);
        expect([level, signerPower(again.member.state, owner.key), isBehind(again.member.state)]).toEqual([level, null, true]);
        expect([level, (await shownEntries(again.member, answer(rises, [other]))).stopped]).toEqual([level, stoppedAt]);
      }
      const list = texts([g, rises, key]);
      const updated = await replayEntries(list, 2, { saved: loaded, proof: letsIn("full", login, key) });
      if (updated.member === null) throw new Error("the replay holds no entry");
      expect([updated.stopped, updated.member.state.needs_replay, last(updated.took).outcome, signingPlace(updated.member, place(key))]).toEqual([null, undefined, reads(null), { list: g.hash, prev: key.hash, seq: 3 }]);
      expect([updated.stuck, signerPower(updated.member.state, owner.key), isBehind(updated.member.state)]).toEqual([false, "full", false]);
      const same = await replayEntries(list, 1, { saved: loaded });
      expect([same.stopped, same.stuck, same.member?.state.needs_replay, same.member?.entries.length]).toEqual([stoppedAt, true, place(key), 2]);
    });

    test("a replay that brings another entry in the place where the member stopped is another history: it stops there, stuck, and keeps the stop, by the member's own level and by a higher one", async () => {
      const rises = await on(g, owner, { kind: "later", v: 2 });
      const key = await on(rises, login, { kind: "later_login", v: 2 });
      const other = await on(rises, owner, { kind: "device", adds: [watch, "bound"] });
      const { member } = await shownEntries(await memberOf([g], 1), answer(g, [rises, key]));
      const stop = member.state.needs_replay ?? null;
      expect(stop).toEqual(place(key));
      for (const level of [1, 2]) {
        const again = await replayEntries(texts([g, rises, other]), level, { saved: member.state, proof: letsIn("full", login, key) });
        if (again.member === null) throw new Error("the replay holds no entry");
        expect([level, again.stopped, again.stuck, again.member.entries.length, again.member.state.needs_replay, signingPlace(again.member, listHead(again.member))]).toEqual([level, { seq: 2, code: "chain_broken" }, true, 2, stop, null]);
        expect([level, (await shownEntries(again.member, answer(rises, [other]))).took]).toEqual([level, []]);
      }
    });

    test("a member that stops in the place of a loose entry of its own drops that entry, as for any entry that holds there: its copy ends before the stop, and a replay of it by the same level leaves it stopped", async () => {
      const rises = await on(g, owner, { kind: "later", v: 2 });
      const loose = await on(rises, stranger, {});
      const key = await on(rises, login, { kind: "later_login", v: 2 });
      const shown = await shownEntries(await memberOf([g, rises, loose], 1), answer(rises, [key]));
      expect([shown.stopped, shown.stuck]).toEqual([{ seq: 2, code: "needs_replay" }, true]);
      const saved = readSignersState(JSON.parse(JSON.stringify(shown.member.state)), shown.member.state.level);
      if (saved === null) throw new Error("the saved state does not read");
      const again = await replayEntries(shown.member.entries, 1, { saved });
      if (again.member === null) throw new Error("the replay holds no entry");
      expect([again.stopped, again.stuck, again.member.state.needs_replay, signingPlace(again.member, place(rises))]).toEqual([{ seq: 2, code: "needs_replay" }, true, place(key), null]);
      expect([shown.dropped_from, shown.member.entries, again.member]).toEqual([2, texts([g, rises]), shown.member]);
    });

    test("a replay that is told a stop and cannot place an entry before that place makes no member: the stop stays with the member that the caller has saved, so no other history gets past it later", async () => {
      const [rises, key, higher, asks] = await row(g, [owner, { kind: "later", v: 2 }], [login, { kind: "later_login", v: 2 }], [owner, { kind: "later", v: 3 }], [machine, { kind: "later_login", v: 2 }]);
      if (!rises || !key || !higher || !asks) throw new Error("the row is short");
      const proof = letsIn("full", login, key);
      const second = await replay([g, rises, key, higher, asks], 2, proof);
      const stop = second.member?.state.needs_replay ?? null;
      const savedState = second.member?.state ?? null;
      expect([second.stopped, stop]).toEqual([{ seq: 4, code: "needs_replay" }, place(asks)]);
      expect(await replayEntries(texts([g, rises, key, higher]), 1, { saved: savedState, proof })).toEqual({ member: null, took: [], stopped: { seq: 4, code: "needs_replay" }, stuck: true });
      const other = await on(higher, owner, { kind: "device", adds: [watch, "bound"] });
      const wrong = await replayEntries(texts([g, rises, key, higher, other]), 3, { saved: savedState, proof });
      expect([wrong.stopped, wrong.stuck, wrong.member?.state.needs_replay]).toEqual([{ seq: 4, code: "chain_broken" }, true, stop]);
      const right = await replayEntries(texts([g, rises, key, higher, asks]), 3, { saved: savedState, proof });
      expect([right.stopped, right.stuck, right.member?.state.needs_replay, right.member?.entries.length]).toEqual([null, false, undefined, 5]);
    });

    test("a downgrade makes no state: a replay by a lower level that is told the stop and cannot place an entry before it gives no member, so the saved one stays; and while a member is stopped no reader answers a power, not for a key that its copy ended and not for any other", async () => {
      const [adds, rises, loose, ends, higher, asks] = await row(g,
        [owner, { kind: "device", adds: [watch, "full"] }], [owner, { kind: "later", v: 2 }], [stranger, { kind: "later_login", v: 2 }], [owner, { ends: watch }], [owner, { kind: "later", v: 3 }], [machine, { kind: "later_login", v: 2 }]);
      if (!adds || !rises || !loose || !ends || !higher || !asks) throw new Error("the row is short");
      const log = [g, adds, rises, loose, ends, higher, asks];
      const second = await replay(log, 2);
      if (second.member === null) throw new Error("the replay holds no entry");
      const saved = second.member;
      const stop = saved.state.needs_replay ?? null;
      expect([second.stopped, stop, saved.entries.length, saved.state.signers[watch.key]?.ended]).toEqual([{ seq: 6, code: "needs_replay" }, place(asks), 6, ends.seq]);
      expect(await replayEntries(saved.entries, 1, { saved: saved.state })).toEqual({ member: null, took: [], stopped: { seq: 6, code: "needs_replay" }, stuck: true });
      expect([signerPower(saved.state, watch.key), signerPower(saved.state, owner.key), isBehind(saved.state), signingPlace(saved, listHead(saved))]).toEqual([null, null, true, null]);
      const { needs_replay: _stop, ...bare } = saved.state;
      const without = readSignersState(JSON.parse(JSON.stringify(bare)), bare.level);
      if (without === null) throw new Error("the state does not read");
      const fork = await row(rises, [owner, { kind: "device", adds: [late, "full"] }], [watch, { kind: "device", adds: [stranger, "full"] }]);
      const shown = await shownEntries({ entries: saved.entries, state: without }, answer(rises, fork));
      expect([shown.stopped, shown.stuck, shown.took, signerPower(shown.member.state, watch.key)]).toEqual([{ seq: 4, code: "chain_broken" }, true, [], null]);
      const third = await replayEntries([...saved.entries, asks.text], 3, { saved: saved.state });
      expect([third.stopped, third.member, third.member && signerPower(third.member.state, watch.key), third.member && signerPower(third.member.state, owner.key)]).toEqual([null, await memberOf(log, 3), null, "full"]);
    });

    test("a lower build that replays a member that is not stopped makes no member of a shorter history: told the saved state, a level that cannot reach its footing gives no member, and the saved member stands", async () => {
      const [rises, enters, adds] = await row(g, [owner, { kind: "later", v: 2 }], [login, { kind: "later_login", v: 2 }], [login, { kind: "device", adds: [watch, "full"] }]);
      if (!rises || !enters || !adds) throw new Error("the row is short");
      const proof = letsIn("full", login, enters);
      const second = await replay([g, rises, enters, adds], 2, proof);
      if (second.member === null) throw new Error("the replay holds no entry");
      const saved = second.member;
      expect([second.stopped, saved.state.footing, signerPower(saved.state, watch.key)]).toEqual([null, place(adds), "full"]);
      const first = await replayEntries(saved.entries, 1, { saved: saved.state, proof });
      expect(first).toEqual({ member: null, took: [], stopped: { seq: 3, code: "needs_replay" }, stuck: true });
      const other = await on(enters, owner, { kind: "device", adds: [late, "full"] });
      const shown = await shownEntries(saved, answer(enters, [other]), proof);
      expect([shown.stopped, shown.stuck, shown.member, signerPower(shown.member.state, watch.key)]).toEqual([{ seq: 3, code: "chain_broken" }, true, saved, "full"]);
      expect([(await replayEntries(saved.entries, 2, { saved: saved.state, proof })).member, (await replayEntries(saved.entries, 3, { saved: saved.state, proof })).member?.state.footing]).toEqual([saved, place(adds)]);
      // Told null, which only a first replay of a member that has no saved state is, level 1 gives the member of the shorter history: null is the caller's word.
      const careless = await replayEntries(saved.entries, 1, { saved: null, proof });
      expect([careless.member?.state.footing, careless.member?.entries.length]).toEqual([place(rises), 2]);
    });

    test("a saved state of a higher level, read back by a lower build, is stopped at its footing: it takes nothing, judges nothing, places nothing to sign and answers for no key, until a replay by a level that can reach that footing takes it; read by its own level or a higher one it is as it was", async () => {
      const [rises, enters, adds] = await row(g, [owner, { kind: "later", v: 2 }], [login, { kind: "later_login", v: 2 }], [login, { kind: "device", adds: [watch, "full"] }]);
      if (!rises || !enters || !adds) throw new Error("the row is short");
      const proof = letsIn("full", login, enters);
      const saved = await memberOf([g, rises, enters, adds], 2, proof);
      const text = JSON.stringify(saved.state);
      expect([saved.state.needs_replay, signerPower(saved.state, watch.key)]).toEqual([undefined, "full"]);
      const lower = readSignersState(JSON.parse(text), 1);
      if (lower === null) throw new Error("the saved state does not read");
      expect([lower.needs_replay, lower.level, lower.footing, lower.signers]).toEqual([place(adds), 2, place(adds), saved.state.signers]);
      const member: ListMember = { entries: saved.entries, state: lower };
      expect([signerPower(lower, watch.key), signerPower(lower, owner.key), isBehind(lower), signingPlace(member, listHead(member))]).toEqual([null, null, true, null]);
      const next = await on(adds, owner, {});
      expect(await shownEntries(member, answer(adds, [next]))).toEqual({ ...quiet, member, stopped: { seq: adds.seq, code: "needs_replay" }, stuck: true });
      const { held } = at((await replay([g, rises, enters, adds, next], 2, proof)).took, 4);
      expect(judgeEntry(lower, held).outcome).toEqual({ outcome: "stops", code: "needs_replay" });
      expect(await replayEntries(saved.entries, 1, { saved: lower, proof })).toEqual({ member: null, took: [], stopped: { seq: adds.seq, code: "needs_replay" }, stuck: true });
      expect([readSignersState(JSON.parse(text), 2), readSignersState(JSON.parse(text), 3)]).toEqual([saved.state, saved.state]);
      expect((await replayEntries(saved.entries, 2, { saved: lower, proof })).member).toEqual(saved);
      expect(() => readSignersState(JSON.parse(text), 0)).toThrow(RangeError);
    });

    test("a replay must be told the member's saved state, or null for a first replay of a member that has none: one that is told nothing is refused, so no member comes back from a replay not stopped, or shorter, by an oversight", async () => {
      const rises = await on(g, owner, { kind: "later", v: 2 });
      const key = await on(rises, login, { kind: "later_login", v: 2 });
      const { member } = await shownEntries(await memberOf([g], 1), answer(g, [rises, key]));
      const stop = member.state.needs_replay ?? null;
      expect(stop).toEqual(place(key));
      // @ts-expect-error A replay that is told nothing of the saved state does not compile, and is refused when it runs;
      await expect(replayEntries(member.entries, 1, {})).rejects.toBeInstanceOf(RangeError);
      // @ts-expect-error so is one that is handed no options at all,
      await expect(replayEntries(member.entries, 1)).rejects.toThrow();
      // @ts-expect-error and one that is handed a stop, or anything else that is no state.
      await expect(replayEntries(member.entries, 1, { saved: stop })).rejects.toBeInstanceOf(RangeError);
      await expect(replayEntries(member.entries, 1, { saved: { ...member.state, behind: null } })).rejects.toBeInstanceOf(RangeError);
      await expect(replayEntries(member.entries.slice(0, 1), 1, { saved: member.state })).rejects.toBeInstanceOf(RangeError);
      const again = await replayEntries(member.entries, 1, { saved: member.state });
      expect([again.stopped, again.stuck, again.member?.state.needs_replay]).toEqual([{ seq: 2, code: "needs_replay" }, true, stop]);
    });
  });

  test("what a login key signed is not loose for it, and it never drops it; the older member holds none of it, and stops again when it is shown it in the place of other entries", async () => {
    const other = await row(turnsOn, [service, {}], [service, {}], [service, {}], [service, {}]);
    const higher = await memberOf(loginLog, 2, letsIn("full"));
    expect(await shownEntries(higher, answer(last(byLogin), other.slice(3)), letsIn("full"))).toEqual({ ...quiet, member: higher, stopped: { seq: 6, code: "chain_broken" }, stuck: true });
    expect(await shownEntries(higher, answer(turnsOn, other), letsIn("full"))).toEqual({ ...quiet, member: higher, stopped: { seq: 3, code: "chain_broken" }, stuck: true });
    const older = await memberOf([...root, turnsOn], 1);
    const loose = await shownEntries(older, answer(turnsOn, other));
    expect([loose.stopped, loose.member]).toEqual([null, await memberOf([...root, turnsOn, ...other], 1)]);
    expect(await shownEntries(loose.member, answer(turnsOn, [enters, ...byLogin]))).toEqual({ ...quiet, dropped_from: enters.seq, member: { entries: texts([...root, turnsOn]), state: { ...loose.member.state, needs_replay: place(enters) } }, stopped: { seq: enters.seq, code: "needs_replay" }, stuck: true });
  });

  test("the entry that lets the key in is part of the list for it: it is not dropped either", async () => {
    const higher = await memberOf([...root, turnsOn, enters], 2, letsIn("full"));
    expect(higher.state.footing).toEqual(place(enters));
    const other = await row(turnsOn, [service, {}]);
    expect(await shownEntries(higher, answer(turnsOn, other), letsIn("full"))).toEqual({ ...quiet, member: higher, stopped: { seq: 3, code: "chain_broken" }, stuck: true });
  });

  test("an older member holds, where it stops, what the other holds there; after its update it replays its copy and the rest of the log, and holds what the other holds", async () => {
    const older = await replay(loginLog, 1);
    const higher = await memberOf(loginLog, 2, letsIn("full"));
    if (older.member === null) throw new Error("entry 0 does not hold");
    expect(older.member.state).toEqual({ ...(await stateOf([...root, turnsOn], 2)), level: 1, behind: turnsOn.seq, needs_replay: place(enters) });
    const updated = await replayEntries(texts(loginLog), 2, { proof: letsIn("full"), saved: older.member.state });
    expect([updated.stopped, updated.member]).toEqual([null, higher]);
    expect(signerPower(higher.state, phone.key)).toBeNull();
  });

  test("an update turns no entry that a member took loose: what it could not read it reads, and its rows and its footing are as they were", async () => {
    const links = [...root, turnsOn, ...(await row(turnsOn, [owner, { kind: "device", adds: [watch, "bound"] }], [phone, { kind: "later", v: 2, ends: watch }], [stranger, {}], [owner, {}]))];
    const older = await replay(links, 1);
    if (older.member === null || older.stopped !== null) throw new Error("the older member does not take them all");
    const updated = await replayEntries(older.member.entries, 2, { saved: older.member.state });
    if (updated.member === null) throw new Error("the replay holds no entry");
    expect(updated.took.map(({ outcome }) => outcome.outcome)).toEqual(older.took.map(({ outcome }) => (outcome.outcome === "cannot_read" ? "reads" : outcome.outcome)));
    expect(older.took.map(({ outcome }) => outcome.outcome)).toEqual(["reads", "reads", "cannot_read", "reads", "cannot_read", "passed_over", "reads"]);
    expect(updated.member.state).toEqual({ ...older.member.state, level: 2, behind: null });
  });

  describe("a proof lets in the signer of its own entry only, and only a key that was never made a signer", () => {
    test("a proof that names another key than the signer of its entry lets nobody in: the entry is passed over, and loose", async () => {
      const links = [...root, turnsOn, enters];
      const plain = await stateOf([...root, turnsOn], 2);
      for (const key of [stranger, late, phone, owner]) {
        for (const power of ["full", "bound"] as const) {
          expect(await outcomeOf(links, 2, letsIn(power, key))).toEqual(passedOver("signer_unknown"));
          expect(await stateOf(links, 2, letsIn(power, key))).toEqual(plain);
        }
      }
      expect((await outcomesOf(loginLog, 2, letsIn("full", stranger))).slice(3)).toEqual([passedOver("signer_unknown"), passedOver("signer_unknown"), passedOver("signer_unknown")]);
      expect(await stateOf(loginLog, 2, letsIn("full", stranger))).toEqual(plain);
    });

    test("a key that a proof made a signer and an ends ended does not come back by an adds either, as a key that an adds made does not: out is out", async () => {
      const out = await on(enters, owner, { ends: login });
      const again = await on(out, owner, { kind: "device", adds: [login, "full"] });
      const byIt = await on(again, login, { ends: owner });
      const links = [...root, turnsOn, enters, out, again, byIt];
      expect((await outcomesOf(links, 2, letsIn("full"))).slice(4)).toEqual([reads(), passedOver("key_reused"), passedOver("signer_unknown")]);
      const state = await stateOf(links, 2, letsIn("full"));
      expect([who(state), state.signers[login.key], state.footing]).toEqual([{ owner: "full", phone: "full" }, rowBy("full", enters, null, out), place(again)]);
    });

    test("a key that a proof made a signer and an ends ended does not come back by a second proof: out is out", async () => {
      const out = await on(enters, owner, { ends: login });
      const again = await on(out, login, { kind: "later_login", v: 2 });
      const signs = await on(again, login, { ends: phone });
      const proof: KeyProof = (held) => (held.hash === enters.hash || held.hash === again.hash ? { key: login.key, power: "full" } : null);
      const links = [...root, turnsOn, enters, out, again, signs];
      expect((await outcomesOf(links, 2, proof)).slice(3)).toEqual([reads(null), reads(), passedOver("signer_unknown"), passedOver("signer_unknown")]);
      const state = await stateOf(links, 2, proof);
      expect(state.signers[login.key]).toEqual(rowBy("full", enters, null, out));
      expect([state.footing, who(state)]).toEqual([place(out), { owner: "full", phone: "full" }]);
    });

    test("a proof for a key that an adds made a signer and an ends ended lets nobody in, and its entry is loose: the footing stays, and the entry can be dropped", async () => {
      const out = await on(turnsOn, owner, { ends: phone });
      const again = await on(out, phone, { kind: "later_login", v: 2 });
      const links = [...root, turnsOn, out, again];
      const under = await stateOf(links.slice(0, 4), 2);
      for (const power of ["full", "bound"] as const) {
        const proof = letsIn(power, phone, again);
        expect(await outcomeOf(links, 2, proof)).toEqual(passedOver("signer_unknown"));
        const state = await stateOf(links, 2, proof);
        expect(state).toEqual(under);
        expect([state.footing, state.signers[phone.key]]).toEqual([place(out), rowBy("full", addPhone, owner, out)]);
      }
      const proof = letsIn("full", phone, again);
      const other = await on(out, owner, {});
      const result = await shownEntries(await memberOf(links, 2, proof), answer(out, [other]), proof);
      expect([result.dropped_from, result.stuck, result.stopped, listHead(result.member)]).toEqual([4, false, null, place(other)]);
    });

    test("a proof changes no key that is a signer: an entry that a signer signed is read as any entry of its signer's, and the key keeps its power", async () => {
      const cases = [[watch, "bound", "full"], [phone, "full", "bound"], [owner, "full", "bound"]] as const;
      for (const [key, has, named] of cases) {
        const byIt = await on(addInvite, key, { kind: "later_login", v: 1 });
        const proof = letsIn(named, key, byIt);
        expect(await outcomeOf([...base, byIt], 2, proof)).toEqual(reads(has));
        const state = await stateOf([...base, byIt], 2, proof);
        expect(state).toEqual(await stateOf([...base, byIt], 2));
        expect([state.footing, signerPower(state, key.key)]).toEqual([place(byIt), has]);
      }
    });
  });

  test("an adds that names such a key is judged as it is written, whatever power the proof named: the key ends with the power of the adds", async () => {
    for (const power of ["full", "bound"] as const) {
      const named = await on(enters, owner, { kind: "device", adds: [login, power] });
      const links = [...root, turnsOn, enters, named];
      const [asFull, asBound] = [await stateOf(links, 2, letsIn("full")), await stateOf(links, 2, letsIn("bound"))];
      expect([signerPower(asFull, login.key), signerPower(asBound, login.key)]).toEqual([power, power]);
      expect([madeOf(asFull), madeOf(asBound)]).toEqual([["owner", "phone", "login"], ["owner", "phone", "login"]]);
      expect(asFull.signers[login.key]).toEqual(rowBy(power, named, owner));
      expect(asFull.signers).toEqual(asBound.signers);
      expect((await replay(links, 1)).stopped).toEqual({ seq: enters.seq, code: "needs_replay" });
    }
  });

  test("a full signer, or the key itself, ends such a key as it ends any other", async () => {
    for (const by of [owner, login]) {
      const out = await on(enters, by, { ends: login });
      const state = await stateOf([...root, turnsOn, enters, out], 2, letsIn("bound"));
      expect(who(state)).toEqual({ owner: "full", phone: "full" });
      expect(state.signers[login.key]).toEqual(rowBy("bound", enters, null, out));
    }
  });

  test("an entry that names such a key in adds and in ends applies both: the key is out, and is never made a signer again", async () => {
    const both = await on(enters, owner, { kind: "device", adds: [login, "full"], ends: login });
    const back = await on(both, owner, { kind: "device", adds: [login, "full"] });
    const links = [...root, turnsOn, enters, both, back];
    expect((await outcomesOf(links, 2, letsIn("full"))).slice(4)).toEqual([reads(), passedOver("key_reused")]);
    const state = await stateOf(links, 2, letsIn("full"));
    expect(who(state)).toEqual({ owner: "full", phone: "full" });
    expect(madeOf(state)).toEqual(["owner", "phone", "login"]);
    expect(state.signers[login.key]).toEqual(rowBy("full", both, owner, both));
  });

  test("a proof is handed bytes of its own: what it does to them, when it is asked or later, changes no entry that comes back and no entry it was judged from", async () => {
    const token = Uint8Array.from([7, 1, 7, 2, 7, 3]);
    const rises = await on(addInvite, owner, { kind: "later", v: 2 });
    const first = await on(rises, login, { kind: "later_login", v: 2, change: { own: [{ name: "token", value: token }] } });
    const second = await on(first, stranger, { kind: "later_login", v: 2, change: { own: [{ name: "token", value: token }] } });
    const handed: HeldEntry[] = [];
    const spoils: KeyProof = (held) => {
      handed.push(held);
      for (const { entry, body } of handed) for (const bytes of [entry.body, entry.signature, ...body.own.map((field) => field.value)]) bytes.fill(0);
      return held.hash === first.hash ? { key: login.key, power: "full" } : null;
    };
    const above = await memberOf([...base, rises], 2);
    const shown = await shownEntries(above, answer(rises, [first, second]), spoils);
    const replayed = await replayEntries(texts([...base, rises, first, second]), 2, { saved: null, proof: spoils });
    for (const took of [shown.took, replayed.took.slice(base.length + 1)]) {
      expect(took.map(({ held, outcome }) => [outcome.outcome, entryToText(held.entry), entryHash(held.entry.body) === held.hash, held.body.own.map((field) => [field.name, [...field.value]])]))
        .toEqual([["reads", first.text, true, [["token", [...token]]]], ["passed_over", second.text, true, [["token", [...token]]]]]);
    }
    expect(handed.length).toBe(4);
    const { held } = at((await replay([...base, rises, first], 2)).took, base.length + 1);
    judgeEntry(above.state, held, spoils);
    expect([handed.length, entryToText(held.entry), [...(at(held.body.own, 0).value)]]).toEqual([5, first.text, [...token]]);
  });

  test("the proof is asked only for an entry of a level above 1 that the list already needs: for one that the member reads, whose signer has no row and that carries no adds and no ends; a member that is behind is not asked, and stops there", async () => {
    const asked: string[] = [];
    const never: KeyProof = (held) => {
      asked.push(held.hash);
      return null;
    };
    const out = await on(turnsOn, owner, { ends: phone });
    const entries = await row(out,
      [login, { kind: "later_login", v: 2 }], [login, { kind: "later_login", v: 3 }], [login, { kind: "later_login", v: 2, adds: [late, "full"] }],
      [login, { kind: "later_login", v: 2, ends: owner }], [owner, { kind: "later_login", v: 2 }], [phone, { kind: "later_login", v: 2 }], [stranger, { kind: "later_login", v: 1 }],
      [stranger, { kind: "later_login", v: 2 }], [owner, { kind: "later", v: 3 }], [machine, { kind: "later_login", v: 2 }]);
    const links = [...root, turnsOn, out, ...entries];
    const higher = await replay(links, 2, never);
    expect([asked, higher.stopped, higher.member?.state.behind]).toEqual([[at(entries, 0).hash, at(entries, 7).hash], { seq: at(entries, 9).seq, code: "needs_replay" }, at(entries, 8).seq]);
    expect((await replay(links, 2, letsIn("full", machine, at(entries, 9)))).stopped).toEqual(higher.stopped);
    asked.length = 0;
    const highest = await stateOf(links, 3, never);
    expect([asked, highest.behind]).toEqual([[at(entries, 0).hash, at(entries, 7).hash, at(entries, 9).hash], null]);
    asked.length = 0;
    const lower = await replay(links, 1, never);
    expect([asked, lower.stopped, lower.member !== null && isBehind(lower.member.state)]).toEqual([[], { seq: at(entries, 0).seq, code: "needs_replay" }, true]);
  });
});

describe("a saved state", () => {
  test("is plain data: JSON saves it, readSignersState reads it again, and the member goes on from it", async () => {
    const member = await memberOf([...base, fell]);
    const saved = JSON.stringify(member.state);
    const loaded = readSignersState(JSON.parse(saved), member.state.level);
    if (loaded === null) throw new Error("the saved state does not read");
    expect(loaded).toEqual(member.state);
    expect(JSON.stringify(loaded)).toBe(saved);
    expect(Object.values(loaded.signers).map((row) => Object.isFrozen(row))).toEqual(Object.keys(member.state.signers).map(() => true));
    const fromLoaded = await shownEntries({ entries: member.entries, state: loaded }, answer(fell, afterFell));
    expect(fromLoaded).toEqual(await shownEntries(member, answer(fell, afterFell)));
    expect(fromLoaded.member).toEqual(await memberOf(behindLog));
  });

  test("a state of a higher level reads again: a row that a proof made, and one whose key came in and went in one entry", async () => {
    const both = await on(enters, owner, { kind: "device", adds: [login, "bound"], ends: login });
    const added = await row(at(byLogin, 0), [owner, { kind: "device", adds: [login, "bound"] }]);
    const byItself = await on(enters, login, { kind: "device", adds: [login, "bound"] });
    const later = await stateOf([...root, turnsOn, enters, at(byLogin, 0), ...added], 2, letsIn("full"));
    expect([later.signers[late.key], later.signers[login.key]]).toEqual([rowBy("bound", at(byLogin, 0), login), rowBy("bound", at(added, 0), owner)]);
    const itself = await stateOf([...root, turnsOn, enters, byItself], 2, letsIn("full"));
    expect(itself.signers[login.key]).toEqual(rowBy("bound", byItself, login));
    for (const state of [await stateOf(loginLog, 2, letsIn("full")), await stateOf([...root, turnsOn, enters, both], 2, letsIn("full")), later, itself]) {
      const saved = JSON.stringify(state);
      expect(readSignersState(JSON.parse(saved), state.level)).toEqual(state);
      expect(JSON.stringify(readSignersState(JSON.parse(saved), state.level))).toBe(saved);
    }
  });

  test("members it does not name are left out, also those of a state that begins with it", async () => {
    const state = await stateOf(base);
    const fuller = {
      ...state, head: place(addInvite), first_signer: owner.key, footing: { ...state.footing, text: "x" },
      signers: Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, { ...row, as: "device", label: "x" }])),
    };
    expect(readSignersState(fuller, state.level)).toEqual(state);
  });

  test("anything that has not its form, or does not agree with itself, is null", async () => {
    const state = await stateOf([...base, ...(await row(addInvite, [owner, { kind: "later", v: 3 }], [owner, { ends: watch }]))]);
    expect(readSignersState(state, state.level)).toEqual(state);
    expect([state.level, state.needs, state.behind, state.footing.seq, state.signers[watch.key]?.ended]).toEqual([1, 3, 4, 5, 5]);
    const hash = "ab".repeat(32);
    const first = state.signers[owner.key];
    const withRow = (key: Key, change: object): unknown => ({ ...state, signers: { ...state.signers, [key.key]: { ...state.signers[key.key], ...change } } });
    const broken: readonly unknown[] = [
      null, undefined, "state", 7, [], [state],
      { ...state, level: 0 }, { ...state, level: 1.5 }, { ...state, level: "1" }, { ...state, level: -1 }, { ...state, level: 2 ** 53 },
      { ...state, list: hash.toUpperCase() }, { ...state, list: "" }, { ...state, list: 7 },
      { ...state, footing: null }, { ...state, footing: { seq: -1, hash } }, { ...state, footing: { seq: 5, hash: "x" } }, { ...state, footing: { seq: "5", hash } },
      { ...state, footing: { seq: 0, hash }, behind: 0, signers: { [owner.key]: first } },
      { ...state, needs: 0 }, { ...state, needs: "3" }, { ...state, needs: 1 }, { ...state, behind: null }, { ...state, level: 3 },
      { ...state, behind: 6 }, { ...state, behind: -1 }, { ...state, behind: 1.5 }, { ...state, behind: "4" }, { ...state, behind: undefined },
      { ...state, signers: null }, { ...state, signers: "x" }, { ...state, signers: [] }, { ...state, signers: [first] }, { ...state, signers: {} },
      { ...state, signers: { ...state.signers, x: rowBy("bound", addPhone, owner) } },
      { ...state, signers: { ...state.signers, [late.key]: null } }, { ...state, signers: { ...state.signers, [late.key]: "full" } }, { ...state, signers: { ...state.signers, [late.key]: [] } },
      withRow(phone, { power: "admin" }), withRow(phone, { power: undefined }),
      withRow(phone, { seq: -1 }), withRow(phone, { seq: 1.5 }), withRow(phone, { seq: "1" }), withRow(phone, { seq: 6 }),
      withRow(phone, { by: "x" }), withRow(phone, { by: undefined }), withRow(phone, { by: 7 }), withRow(phone, { by: "constructor" }), withRow(phone, { by: "__proto__" }),
      withRow(phone, { by: stranger.key }),
      // A row's by is the signer of the entry that made its key a signer: a key that was a signer of power full then. At level 1 it is never null.
      withRow(phone, { by: null }), withRow(phone, { by: watch.key }), withRow(invite, { by: watch.key }), withRow(invite, { by: invite.key }),
      { ...state, signers: { ...state.signers, [phone.key]: { ...state.signers[phone.key], ended: 2 }, [invite.key]: { ...state.signers[invite.key], by: phone.key } } },
      withRow(phone, { ended: -1 }), withRow(phone, { ended: "2" }), withRow(phone, { ended: undefined }), withRow(phone, { ended: 0 }), withRow(phone, { ended: 6 }),
      withRow(owner, { by: phone.key }), withRow(owner, { by: null }), withRow(owner, { power: "bound" }), withRow(owner, { seq: 1 }),
      withRow(phone, { seq: 0, by: phone.key }),
    ];
    for (const value of broken) expect([value, readSignersState(value, 3)]).toEqual([value, null]);
    for (const name of Object.keys(state)) expect([name, readSignersState(Object.fromEntries(Object.entries(state).filter(([key]) => key !== name)), 3)]).toEqual([name, null]);
    for (const change of [{ ended: 1 }, { ended: 5 }, { seq: 5, ended: 5 }, { power: "bound" }]) {
      const value: unknown = withRow(phone, change);
      const read: unknown = readSignersState(value, state.level);
      expect([change, read]).toEqual([change, value]);
    }
    for (const ended of [null, 3]) {
      const value: unknown = { ...state, signers: { ...state.signers, [phone.key]: { ...state.signers[phone.key], ended }, [invite.key]: { ...state.signers[invite.key], by: phone.key } } };
      const read: unknown = readSignersState(value, state.level);
      expect([ended, read]).toEqual([ended, value]);
    }
  });

  test("a stop at its footing is that very entry: one that names another hash in that place does not read", async () => {
    const lower = readSignersState(JSON.parse(JSON.stringify(await stateOf(base, 2))), 1);
    if (lower === null) throw new Error("the saved state does not read");
    expect([lower.needs_replay, lower.footing]).toEqual([place(addInvite), place(addInvite)]);
    for (const level of [1, 2, 3]) {
      expect([level, readSignersState(JSON.parse(JSON.stringify(lower)), level)]).toEqual([level, lower]);
      expect([level, readSignersState({ ...lower, needs_replay: { seq: addInvite.seq, hash: addPhone.hash } }, level)]).toEqual([level, null]);
    }
  });
});

describe("one entry judged", () => {
  test("an entry of another list is the caller's mistake: judgeEntry refuses it, and no footing moves onto it", async () => {
    const elsewhere = await genesis(phone);
    const { held } = at((await replay([elsewhere, await on(elsewhere, phone, {})])).took, 1);
    const state = await stateOf(base);
    expect([held.list === state.list, signerPower(state, phone.key)]).toEqual([false, "full"]);
    expect(() => judgeEntry(state, held)).toThrow(RangeError);
  });

  test("an entry at or under the state's footing is the caller's mistake too: judgeEntry refuses it, and the footing does not move back onto it", async () => {
    const { member, took } = await replay(base);
    if (member === null) throw new Error("the replay holds no entry");
    const { state } = member;
    expect(state.footing.seq).toBe(base.length - 1);
    for (const { held } of took) expect(() => judgeEntry(state, held)).toThrow(RangeError);
    const next = await on(last(base), owner, {});
    expect(judgeEntry(state, await entryHolds(entryFromText(next.text), last(took).held)).state.footing).toEqual(place(next));
  });
});

describe("a level", () => {
  test("is a whole number from 1 for every function that makes a state, as it is for readSignersState: any other is the caller's mistake, and no state is made", async () => {
    const member = await memberOf(base);
    const { held } = at((await replay([g])).took, 0);
    const next = at((await replay([...base, await on(addInvite, owner, {})])).took, base.length).held;
    for (const level of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const state = { ...member.state, level };
      expect([level, readSignersState(state, 3)]).toEqual([level, null]);
      await expect(replayEntries(texts(base), level, { saved: null })).rejects.toBeInstanceOf(RangeError);
      await expect(replayEntries([], level, { saved: null })).rejects.toBeInstanceOf(RangeError);
      expect(() => firstSignersState(held, level)).toThrow(RangeError);
      expect(() => judgeEntry(state, next)).toThrow(RangeError);
      await expect(shownEntries({ entries: member.entries, state }, answer(addInvite, []))).rejects.toBeInstanceOf(RangeError);
    }
    for (const level of [1, 2, 1000, Number.MAX_SAFE_INTEGER]) {
      const first = firstSignersState(held, level);
      const replayed = await stateOf(base, level);
      expect([level, first.level, replayed.level, readSignersState(JSON.parse(JSON.stringify(first)), level), readSignersState(JSON.parse(JSON.stringify(replayed)), level)]).toEqual([level, level, level, first, replayed]);
    }
  });
});

describe("replaying from entry 0", () => {
  test("no entry, an entry 0 that does not hold, and one that is not the list it was given", async () => {
    expect(await replayEntries([], 1, { saved: null })).toEqual({ member: null, took: [], stopped: null, stuck: false });
    expect(await replayEntries([`${g.text}=`, addPhone.text], 1, { saved: null })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "entry_malformed" }, stuck: false });
    expect(await replayEntries([addPhone.text], 1, { saved: null })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "chain_broken" }, stuck: false });
    expect(await replayEntries(texts(root), 1, { saved: null, given: "ab".repeat(32) })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "list_mismatch" }, stuck: false });
    expect((await replayEntries(texts(root), 1, { saved: null, given: g.hash })).member).toEqual(await memberOf(root));
  });

  test("told the saved state, a replay that begins with another entry 0 than the saved member's is of another list: it makes no member, and names list_mismatch", async () => {
    const saved = await memberOf([g]);
    expect(saved.state.footing).toEqual(place(g));
    expect(await replayEntries(texts([await genesis(phone)]), 1, { saved: saved.state })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "list_mismatch" }, stuck: true });
    expect((await replayEntries(texts([g]), 1, { saved: saved.state })).member).toEqual(saved);
  });

  test("told the saved state, a replay in which an entry under the saved footing does not hold makes no member: those are not the member's entries, and what comes before that entry is a shorter history than its own", async () => {
    const saved = await memberOf(base);
    expect(saved.state.footing).toEqual(place(addInvite));
    expect(await replayEntries([g.text, addPhone.text, badlySigned(addWatch), addInvite.text], 1, { saved: saved.state })).toEqual({ member: null, took: [], stopped: { seq: 2, code: "signature_invalid" }, stuck: true });
    const past = await replayEntries([...texts(base), badlySigned(await on(addInvite, owner, {}))], 1, { saved: saved.state });
    expect([past.member, past.stopped, past.stuck]).toEqual([saved, { seq: 4, code: "signature_invalid" }, false]);
  });

  test("told the saved state, a replay that brings another entry at the saved footing, one that holds, is another history under it: it makes no member, and names chain_broken", async () => {
    const saved = await memberOf(base);
    const other = await on(addWatch, owner, { kind: "device", adds: [late, "bound"] });
    expect(await replayEntries(texts([g, addPhone, addWatch, other]), 1, { saved: saved.state })).toEqual({ member: null, took: [], stopped: { seq: 3, code: "chain_broken" }, stuck: true });
  });

  test("it stops at the first entry that does not hold and keeps the ones before it", async () => {
    const result = await replayEntries([...texts(base), at(real, 0).text, at(real, 1).text], 1, { saved: null });
    expect(result.stopped).toEqual({ seq: 4, code: "chain_broken" });
    expect(result.member).toEqual(await memberOf(base));
  });

  test("a replay never goes back: an entry that does not continue the one before it stops it there, also after a loose entry, and its result names the stop", async () => {
    const loose2 = await on(addPhone, stranger, {});
    const signed2 = await on(addPhone, phone, {});
    const on3 = await on(await on(addPhone, owner, { kind: "device", adds: [watch, "bound"] }), owner, {});
    const replayed = await replayEntries(texts([...root, loose2, on3]), 1, { saved: null });
    expect([replayed.stopped, replayed.took.length, replayed.member]).toEqual([{ seq: 3, code: "chain_broken" }, 3, await memberOf([...root, loose2])]);
    expect(replayed.took.map((taken) => taken.outcome.outcome)).toEqual(["reads", "reads", "passed_over"]);
    const afterSigned = await replayEntries(texts([...root, signed2, on3]), 1, { saved: null });
    expect([afterSigned.stopped, afterSigned.stuck, afterSigned.took.length, Object.keys(afterSigned).sort()]).toEqual([{ seq: 3, code: "chain_broken" }, false, 3, ["member", "stopped", "stuck", "took"]]);
    expect(await shownEntries(await memberOf(root), answer(addPhone, [loose2, on3]))).toMatchObject({ stopped: null, stuck: false, asks_after: 1 });
    expect(await shownEntries(await memberOf(root), answer(addPhone, [signed2, on3]))).toMatchObject({ stopped: { seq: 3, code: "chain_broken" }, stuck: true, asks_after: null });
  });

  test("a replay's proof is read once: another put in its place while a signature is checked decides nothing", async () => {
    const list = texts([...root, turnsOn, enters]);
    const never: KeyProof = () => null;
    const unchanged = await replayEntries(list, 2, { saved: null, proof: never });
    expect(last(unchanged.took).outcome).toEqual(passedOver("signer_unknown"));
    expect(last((await replayEntries(list, 2, { saved: null, proof: letsIn("full") })).took).outcome).toEqual(reads(null));
    const options: { saved: null; proof: KeyProof } = { saved: null, proof: never };
    const result = await whileVerifying(() => { options.proof = letsIn("full"); }, () => replayEntries(list, 2, options));
    expect(result).toEqual(unchanged);
  });

  test("over random lists, a replay by a member that reads every entry either takes every entry it was given or names where it stopped: exactly where the envelope says that an entry does not hold on the one before it", async () => {
    let seed = 20261115;
    const next = (below: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 2 ** 32) * below);
    };
    const pick = <T>(items: readonly T[]): T => at(items, next(items.length));
    async function firstFault(list: readonly string[]): Promise<ListStop | null> {
      let before: HeldEntry | null = null;
      for (const [seq, text] of list.entries()) {
        try {
          const entry = entryFromText(text);
          before = before === null ? (await firstState(entry)).first : await entryHolds(entry, before);
        } catch (error) {
          if (!(error instanceof ListEntryError)) throw error;
          return { seq, code: error.code };
        }
      }
      return null;
    }
    const FAULTS = { prev: "chain_broken", seq: "chain_broken", list: "chain_broken", signature: "signature_invalid", form: "entry_malformed" } as const;
    const insiders = [owner, phone, watch];
    const counts = { lists: 0, whole: 0, stopped: 0, prevAfterLoose: 0, prevAfterSigned: 0 };
    for (let round = 0; round < 150; round++) {
      const links: Link[] = [g, addPhone, addWatch];
      const length = 2 + next(6);
      for (let index = 0; index < length; index++) {
        const by = next(3) === 0 ? pick([stranger, service]) : pick(insiders);
        const draft: Draft = next(4) === 0 ? { kind: "later", v: 2 }
          : next(3) === 0 ? { ends: pick([watch, invite, late]) }
          : next(3) === 0 ? { kind: "device", adds: [pick([invite, late, machine]), pick(["full", "bound"] as const)] }
          : {};
        links.push(await on(last(links), by, draft));
      }
      const list = texts(links);
      let fault: keyof typeof FAULTS | null = null;
      let place = -1;
      if (next(3) > 0) {
        place = 3 + next(links.length - 3);
        fault = pick(["prev", "prev", "prev", "seq", "list", "signature", "form"] as const);
        const before = at(links, place - 1);
        const by = pick(insiders);
        const elsewhere = await on(at(links, place - 2), owner, { kind: "device", adds: [login, "bound"] });
        const put = fault === "prev" ? await on(elsewhere, by, {})
          : fault === "seq" ? await on(before, by, { change: { seq: place + 1 } })
          : fault === "list" ? await on(before, by, { change: { list: otherList } })
          : fault === "signature" ? await on(before, by, { signedWith: stranger })
          : await on(before, by, {});
        list[place] = fault === "form" ? `${put.text}=` : put.text;
      }
      const level = 2 + (round % 2);
      const stop = await firstFault(list);
      expect([round, stop]).toEqual([round, fault === null ? null : { seq: place, code: FAULTS[fault] }]);
      const result = await replayEntries(list, level, { saved: null });
      const taken = stop === null ? list.length : stop.seq;
      expect([round, result.stopped, result.member?.entries.length, result.took.length]).toEqual([round, stop, taken, taken]);
      if (stop !== null) expect([round, result.member]).toEqual([round, (await replayEntries(list.slice(0, stop.seq), level, { saved: null })).member]);
      counts.lists++;
      if (stop === null) counts.whole++;
      else counts.stopped++;
      const beforeIt = fault === "prev" ? result.took[place - 1]?.outcome : undefined;
      if (beforeIt !== undefined) counts[beforeIt.outcome === "passed_over" && beforeIt.loose ? "prevAfterLoose" : "prevAfterSigned"]++;
    }
    expect([counts.lists, counts.whole, counts.stopped, counts.prevAfterLoose + counts.prevAfterSigned, counts.prevAfterLoose >= 13]).toEqual([150, 44, 106, 51, true]);
  }, 60_000);

  test("judgeEntry turns on no row but those the entry names: on those rows alone it gives the same outcome and the same rows", async () => {
    const entries = await row(addInvite,
      [stranger, { ends: owner }], [owner, { kind: "later", v: 2, adds: [late, "full"], ends: watch }], [invite, { kind: "join" }], [watch, {}],
      [late, { kind: "device", adds: [phone, "full"] }], [phone, { ends: phone }], [late, { ends: stranger }], [invite, { ends: invite }]);
    const { took } = await replay([...base, ...entries]);
    let state = firstSignersState(at(took, 0).held, 1);
    for (const { held } of took.slice(1)) {
      const { signer, adds, ends } = held.body;
      const namedKeys = [signer, ...(adds ? [adds.key] : []), ...(ends === undefined ? [] : [ends])];
      const whole = judgeEntry(state, held);
      const onNamed = judgeEntry({ ...state, signers: Object.fromEntries(Object.entries(state.signers).filter(([key]) => namedKeys.includes(key))) }, held);
      expect(onNamed.outcome).toEqual(whole.outcome);
      expect({ ...onNamed.state, signers: {} }).toEqual({ ...whole.state, signers: {} });
      expect(onNamed.state.signers).toEqual(Object.fromEntries(Object.entries(whole.state.signers).filter(([key]) => namedKeys.includes(key))));
      state = whole.state;
    }
    expect(took.map((taken) => taken.outcome.outcome)).toEqual(["reads", "reads", "reads", "reads", "passed_over", "cannot_read", "reads", "passed_over", "passed_over", "reads", "passed_over", "reads"]);
  });

  test("judgeEntry gives the state that replaying gives, entry by entry", async () => {
    const entries = await row(addInvite, [stranger, {}], [owner, { kind: "later", v: 2, ends: watch }], [invite, { kind: "join" }], [phone, { kind: "device", adds: [late, "full"] }]);
    const { took, member } = await replay([...base, ...entries]);
    if (member === null) throw new Error("entry 0 does not hold");
    let state = firstSignersState(at(took, 0).held, 1);
    for (const taken of took.slice(1)) {
      const judged = judgeEntry(state, taken.held);
      expect(judged.outcome).toEqual(taken.outcome);
      state = judged.state;
    }
    expect(took.length).toBe(8);
    expect(state).toEqual(member.state);
  });

  test("the envelope's vectors stop a member where the envelope says, and it takes every entry of the ones that hold", async () => {
    const dir = join(import.meta.dir, "account-list-vectors", "envelope");
    interface EnvelopeVector { given_list?: string; entries: { text: string }[]; expect: { stops?: ListStop } }
    const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    const stopped: string[] = [];
    for (const file of files) {
      const vector = JSON.parse(readFileSync(join(dir, file), "utf8")) as EnvelopeVector;
      const result = await replayEntries(vector.entries.map((entry) => entry.text), 1, vector.given_list === undefined ? { saved: null } : { saved: null, given: vector.given_list });
      const { stops } = vector.expect;
      if (stops === undefined) {
        expect([file, result.stopped, result.member?.entries.length]).toEqual([file, null, vector.entries.length]);
      } else {
        stopped.push(file);
        expect([file, result.stopped, result.member?.entries.length ?? 0]).toEqual([file, stops, stops.seq]);
      }
    }
    expect(stopped.length).toBeGreaterThan(30);
    expect(files.length).toBeGreaterThan(stopped.length);
  });
});

describe("the vectors of signers/ and unreadable/", () => {
  const SIGNERS = [
    "signer-unknown", "signer-service-key", "signer-ended", "signer-machine-key", "adds-by-bound", "adds-key-again", "ends-other-by-bound", "ends-self", "ends-not-a-signer",
    "adds-and-ends-one-entry", "ends-last-full", "signer-not-device",
    "loose-one-then-list", "loose-several-then-list", "loose-same-again", "loose-under-signer", "loose-head-before", "footing-other-history", "footing-head-before",
    "head-other-at-shown-entry", "loose-same-then-list", "loose-not-at-higher-level",
  ];
  const SIGNERS_SECOND = [
    "seq-wrong-after-footing", "other-list-after-footing", "prev-other-after-footing", "footing-replaced", "head-before-footing-no-entry", "head-before-past-footing",
    "same-entry-other-signature", "forged-in-place-of-loose",
    "proof-entry-not-loose", "proof-cannot-change-made-key", "adds-and-ends-one-key", "proof-names-another-key", "proof-key-ended-stays-out", "proof-for-ended-adds-key", "adds-for-ended-proof-key",
    "device-out-of-form-signs", "took-every-name",
  ];
  const UNREADABLE = [
    "later-kind-by-drive-device", "later-kind-by-unknown-key", "later-kind-by-invite-key", "later-kind-v1", "known-kind-higher-v", "needs-from-copy",
    "remove-after-later-kind", "remove-by-device-added-after", "replay-after-update",
  ];
  const UNREADABLE_SECOND = ["adds-and-ends-one-key-level-1", "needs-passed-over", "replay-by-a-lower-level"];
  const GOING_BACK = [...SIGNERS.slice(12), ...SIGNERS_SECOND.slice(0, 8)];
  const SHOWS = [...GOING_BACK, "adds-and-ends-one-key-level-1", "replay-by-a-lower-level"];
  const ASKS_AFTER: Readonly<Record<string, number>> = { "head-before-past-footing": 1 };

  interface VectorEntry { fields: [string, string][]; body: string; signature: string; text: string; hash: string }
  interface Vector {
    name: string;
    keys: Record<string, { pkcs8: string; spki: string }>;
    entries: VectorEntry[];
    shown?: { entries: VectorEntry[]; head: ListPlace };
    lets_in?: { seq: number; key: string; power: SignerPower }[];
    replay?: { level: number };
    expect: {
      took: { seq: number; outcome: TakenOutcome["outcome"]; code?: PassedOverCode }[]; state: SignersState; head?: ListPlace; stops?: ListStop; stuck?: boolean;
      replay?: { member: SignersState | null; stops: ListStop | null; stuck: boolean };
    };
  }
  const load = (folder: string) => {
    const dir = join(import.meta.dir, "account-list-vectors", folder);
    const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    return { files, vectors: files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Vector) };
  };
  const signers = load("signers");
  const unreadable = load("unreadable");
  const vectors = [...signers.vectors, ...unreadable.vectors];
  const named = (name: string): Vector => {
    const vector = vectors.find((item) => item.name === name);
    if (vector === undefined) throw new Error(`no vector ${name}`);
    return vector;
  };
  const GENERATED = 150;
  const GENERATED_SEED = 20261118;
  const proofOf = (vector: Vector): KeyProof => (held) => {
    const found = vector.lets_in?.find((item) => item.seq === held.body.seq);
    return found ? { key: found.key, power: found.power } : null;
  };
  async function run(vector: Vector, level = vector.expect.state.level) {
    const held = await replayEntries(vector.entries.map((entry) => entry.text), level, { saved: null, proof: proofOf(vector) });
    if (held.member === null || held.stopped !== null) throw new Error(`${vector.name}: its entries do not all hold`);
    const { shown } = vector;
    if (shown === undefined) return { member: held.member, took: held.took, shown: null };
    const first = shown.entries[0];
    const after = first === undefined ? held.member.entries.length - 1 : Number(new Map(first.fields).get("seq")) - 1;
    return { member: held.member, took: held.took, shown: await shownEntries(held.member, { after, entries: shown.entries.map((entry) => entry.text), head: shown.head }, proofOf(vector)) };
  }

  test("there is one file for every vector named, and no other", () => {
    expect(signers.files).toEqual([...SIGNERS, ...SIGNERS_SECOND].map((name) => `${name}.json`).sort());
    expect(unreadable.files).toEqual([...UNREADABLE, ...UNREADABLE_SECOND].map((name) => `${name}.json`).sort());
    for (const [index, vector] of signers.vectors.entries()) expect(`${vector.name}.json`).toBe(signers.files[index] ?? "");
    for (const [index, vector] of unreadable.vectors.entries()) expect(`${vector.name}.json`).toBe(unreadable.files[index] ?? "");
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      const { member, took, shown } = await run(vector);
      const { expect: expected } = vector;
      expect(readSignersState(expected.state, expected.state.level)).toEqual(expected.state);
      const did = took.slice(1).map(({ held, outcome }) => ({ seq: held.body.seq, outcome: outcome.outcome, ...(outcome.outcome === "passed_over" ? { code: outcome.code } : {}) }));
      expect(did).toEqual(expected.took);
      expect(expected.took.map((item) => item.seq)).toEqual(vector.entries.slice(1).map((_, index) => index + 1));
      for (const item of expected.took) expect(Object.keys(item)).toEqual(item.outcome === "passed_over" ? ["seq", "outcome", "code"] : ["seq", "outcome"]);
      if (shown === null) {
        expect(SHOWS).not.toContain(vector.name);
        expect(Object.keys(expected)).toEqual(["took", "state"]);
        expect(member.state).toEqual(expected.state);
        expect(member.entries.length).toBe(vector.entries.length);
      } else {
        expect(SHOWS).toContain(vector.name);
        expect(Object.keys(vector.shown ?? {})).toEqual(["entries", "head"]);
        expect(Object.keys(expected)).toEqual([...(shown.stopped === null ? ["took", "head", "state"] : ["took", "head", "state", "stops", "stuck"]), ...(vector.replay === undefined ? [] : ["replay"])]);
        expect(expected.head).toBeDefined();
        expect(listHead(shown.member)).toEqual(expected.head ?? { seq: -1, hash: "" });
        expect(shown.member.state).toEqual(expected.state);
        expect(shown.stopped).toEqual(expected.stops ?? null);
        expect(shown.stuck).toBe(expected.stuck ?? false);
        expect(shown.asks_after).toBe(ASKS_AFTER[vector.name] ?? null);
        if (vector.replay !== undefined) {
          const again = await replayEntries(shown.member.entries, vector.replay.level, { saved: shown.member.state, proof: proofOf(vector) });
          expect({ member: again.member === null ? null : again.member.state, stops: again.stopped, stuck: again.stuck }).toEqual(expected.replay ?? { member: null, stops: null, stuck: false });
        }
      }
    });
  }

  test("adds-for-ended-proof-key at level 1: behind from entry 1, the member stops at the key's first entry, for which a proof may be asked; as far as it goes it holds what the member of level 2 holds", async () => {
    const vector = named("adds-for-ended-proof-key");
    const list = vector.entries.map((entry) => entry.text);
    const older = await replayEntries(list, 1, { saved: null, proof: proofOf(vector) });
    expect([older.stopped, older.member?.entries.length]).toEqual([{ seq: 2, code: "needs_replay" }, 2]);
    const newer = await replayEntries(list.slice(0, 2), 2, { saved: null, proof: proofOf(vector) });
    expect([older.member?.state.signers, older.member?.state.footing]).toEqual([newer.member?.state.signers, newer.member?.state.footing]);
  });

  test("every vector, taken by a member of every level from 1 to the highest that it or one of its entries names: as far as a member goes it has passed over what a member of a higher level has, and holds the same rows and the same footing; it stops short of the other only for a replay", async () => {
    const faults: string[] = [];
    let pairs = 0;
    let short = 0;
    const trace = (took: readonly TakenEntry[]) => took.map(({ held, outcome }) => `${held.hash} ${outcome.outcome === "passed_over" ? outcome.code : "taken"}`);
    const holds = ({ signers, footing, needs }: SignersState) => ({ signers, footing, needs });
    for (const vector of vectors) {
      const list = vector.entries.map((entry) => entry.text);
      const proof = proofOf(vector);
      const { shown } = vector;
      const top = Math.max(vector.expect.state.level, ...[...vector.entries, ...(shown?.entries ?? [])].map((entry) => Number(new Map(entry.fields).get("v"))));
      for (let low = 1; low < top; low++) {
        for (let high = low + 1; high <= top; high++) {
          pairs++;
          const where = `${vector.name}, level ${low} beside level ${high}`;
          const lower = await replayEntries(list, low, { saved: null, proof });
          if (lower.member === null) throw new Error(`${vector.name}: entry 0 does not hold`);
          const far = lower.member.entries.length;
          if (lower.stopped !== null) {
            short++;
            if (lower.stopped.code !== "needs_replay" || !isBehind(lower.member.state)) faults.push(`${where}: the lower member stops, and not for a replay`);
          }
          const higher = await replayEntries(list.slice(0, far), high, { saved: null, proof });
          if (higher.member === null || higher.stopped !== null || !isDeepStrictEqual([trace(lower.took), holds(lower.member.state)], [trace(higher.took), holds(higher.member.state)])) {
            faults.push(`${where}: their own copies differ`);
            continue;
          }
          if (shown === undefined || far < list.length) continue;
          const first = shown.entries[0];
          const after = first === undefined ? far - 1 : Number(new Map(first.fields).get("seq")) - 1;
          const show = (member: ListMember) => shownEntries(member, { after, entries: shown.entries.map((entry) => entry.text), head: shown.head }, proof);
          const [below, above] = [await show(lower.member), await show(higher.member)];
          if (below.stopped?.code === "needs_replay") {
            short++;
            if (!isBehind(below.member.state) || !isDeepStrictEqual(trace(below.took), trace(above.took).slice(0, below.took.length))) faults.push(`${where}: before it stops for a replay, the lower member takes the answer otherwise`);
            continue;
          }
          const ends = (result: typeof below) => [trace(result.took), result.stopped, result.stuck, result.asks_after, result.dropped_from, result.member.entries, holds(result.member.state)];
          if (!isDeepStrictEqual(ends(below), ends(above))) faults.push(`${where}: the answer ends otherwise`);
        }
      }
    }
    expect(faults).toEqual([]);
    expect([pairs > 0, short > 0]).toEqual([true, true]);
  });

  test("every entry of a vector is its text, hashes to its hash and shows its fields; every key it names is a TEST ONLY pair of its own", async () => {
    const encoder = new TextEncoder();
    for (const vector of vectors) {
      const known = Object.values(vector.keys).map((key) => key.spki);
      const named = [...Object.entries(vector.expect.state.signers).flatMap(([key, row]) => (row.by === null ? [key] : [key, row.by])), ...(vector.lets_in ?? []).map((item) => item.key)];
      for (const item of [...vector.entries, ...(vector.shown?.entries ?? [])]) {
        expect(item.text).toBe(`${item.body}.${item.signature}`);
        const entry = entryFromText(item.text);
        expect(entryHash(entry.body)).toBe(item.hash);
        expect(readFields(entry.body).map(({ name, value }) => [name, new TextDecoder().decode(value)])).toEqual(item.fields);
        named.push(...item.fields.filter(([name]) => name === "signer" || name === "adds" || name === "ends").map(([, value]) => value));
      }
      expect(named.length).toBeGreaterThan(2);
      for (const key of named) expect([vector.name, known.includes(key)]).toEqual([vector.name, true]);
      expect(new Set(named).size).toBe(known.length);
      for (const [name, { pkcs8, spki }] of Object.entries(vector.keys)) {
        expect(name).toStartWith("TEST-ONLY-");
        expect(isListKeyEncoding(spki)).toBe(true);
        const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(pkcs8)), P256, false, ["sign"]);
        const message = encoder.encode(vector.name);
        expect(await verifySignature(message, new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, message)), spki)).toBe(true);
      }
    }
  });

  const outcomes = async (name: string) => (await run(named(name))).took.map(({ outcome }) => (outcome.outcome === "passed_over" ? outcome.code : `${outcome.outcome}${outcome.behind ? " behind" : ""}`));

  test("signers/: each entry that is passed over, and why", async () => {
    expect(await outcomes("signer-unknown")).toEqual(["reads", "signer_unknown", "reads"]);
    expect(await outcomes("signer-service-key")).toEqual(["reads", "signer_unknown", "signer_unknown"]);
    expect(await outcomes("signer-ended")).toEqual(["reads", "reads", "reads", "signer_unknown"]);
    expect(await outcomes("signer-machine-key")).toEqual(["reads", "reads", "reads", "signer_unknown"]);
    expect(await outcomes("adds-by-bound")).toEqual(["reads", "reads", "signer_not_allowed"]);
    expect(await outcomes("adds-key-again")).toEqual(["reads", "reads", "reads", "key_reused", "reads", "key_reused"]);
    expect(await outcomes("ends-other-by-bound")).toEqual(["reads", "reads", "reads", "signer_not_allowed"]);
    expect(await outcomes("ends-self")).toEqual(["reads", "reads", "reads"]);
    expect(await outcomes("ends-not-a-signer")).toEqual(["reads", "already_out", "reads", "reads", "already_out"]);
    expect(await outcomes("adds-and-ends-one-entry")).toEqual(["reads", "reads", "already_out", "reads"]);
    expect(await outcomes("ends-last-full")).toEqual(["reads", "reads", "reads", "signer_not_allowed", "signer_unknown"]);
    expect(await outcomes("signer-not-device")).toEqual(["reads", "reads", "reads"]);
  });

  test("signer-not-device: a device entry that is out of its kind's form still makes its key a signer, and that key's adds applies", () => {
    const { entries, expect: expected } = named("signer-not-device");
    const fields = entries.map((entry) => new Map(entry.fields));
    const [first, outOfForm, byIt] = [at(fields, 0), at(fields, 1), at(fields, 2)];
    expect([outOfForm.get("kind"), outOfForm.get("power"), [...outOfForm.keys()].filter((name) => !["adds", "issued_at", "kind", "label", "list", "power", "prev", "seq", "signer", "v"].includes(name)).length]).toEqual(["device", "full", 1]);
    expect(byIt.get("signer")).toBe(outOfForm.get("adds") ?? "");
    expect(expected.state.signers).toEqual({
      [first.get("signer") ?? ""]: { power: "full", seq: 0, by: first.get("signer") ?? "", ended: null },
      [outOfForm.get("adds") ?? ""]: { power: "full", seq: 1, by: first.get("signer") ?? "", ended: null },
      [byIt.get("adds") ?? ""]: { power: "bound", seq: 2, by: outOfForm.get("adds") ?? "", ended: null },
    });
  });

  test("unreadable/: what a member of the vector's level does with each entry", async () => {
    const behind = "reads behind";
    expect(await outcomes("later-kind-by-drive-device")).toEqual(["reads", "reads", "reads", "reads", "reads", "cannot_read behind", behind, behind, behind, behind, behind]);
    expect(await outcomes("replay-after-update")).toEqual(new Array<string>(11).fill("reads"));
    expect(named("replay-after-update").entries).toEqual(named("later-kind-by-drive-device").entries);
    expect([named("later-kind-by-drive-device").expect.state.level, named("replay-after-update").expect.state.level]).toEqual([1, 2]);
    expect(await outcomes("later-kind-by-unknown-key")).toEqual(["reads", "reads", "signer_unknown", "reads"]);
    expect(await outcomes("later-kind-by-invite-key")).toEqual(["reads", "reads", "cannot_read"]);
    expect(await outcomes("later-kind-v1")).toEqual(["reads", "reads", "reads"]);
    expect(await outcomes("known-kind-higher-v")).toEqual(["reads", "cannot_read behind"]);
    expect(await outcomes("needs-from-copy")).toEqual(["reads", "reads", "cannot_read behind", "cannot_read behind", "signer_unknown", "cannot_read behind"]);
    expect(await outcomes("remove-after-later-kind")).toEqual(["reads", "reads", "cannot_read behind", behind]);
    expect(await outcomes("remove-by-device-added-after")).toEqual(["reads", "reads", "cannot_read behind", behind, behind]);
  });

  test("going back: what each vector's member holds, drops and takes", async () => {
    const story = async (name: string) => {
      const { member, shown } = await run(named(name));
      if (shown === null) throw new Error(`${name} shows nothing`);
      return { held: member.entries.length, footing: member.state.footing.seq, dropped: shown.dropped_from, took: shown.took.length, now: shown.member.entries.length, stuck: shown.stuck };
    };
    expect(await story("loose-one-then-list")).toEqual({ held: 3, footing: 1, dropped: 2, took: 2, now: 4, stuck: false });
    expect(await story("loose-several-then-list")).toEqual({ held: 5, footing: 1, dropped: 2, took: 4, now: 6, stuck: false });
    expect(await story("loose-same-again")).toEqual({ held: 4, footing: 1, dropped: null, took: 0, now: 4, stuck: false });
    expect(await story("loose-under-signer")).toEqual({ held: 4, footing: 1, dropped: null, took: 1, now: 5, stuck: false });
    expect(await story("loose-head-before")).toEqual({ held: 5, footing: 1, dropped: 2, took: 2, now: 4, stuck: false });
    expect(await story("footing-other-history")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("footing-head-before")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("loose-not-at-higher-level")).toEqual({ held: 4, footing: 3, dropped: null, took: 0, now: 4, stuck: true });
    expect(await story("seq-wrong-after-footing")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: false });
    expect(await story("other-list-after-footing")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: false });
    expect(await story("prev-other-after-footing")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: true });
    expect(await story("head-other-at-shown-entry")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: true });
    expect(await story("loose-same-then-list")).toEqual({ held: 4, footing: 2, dropped: 3, took: 1, now: 4, stuck: false });
    expect(await story("footing-replaced")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("head-before-footing-no-entry")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("head-before-past-footing")).toEqual({ held: 4, footing: 1, dropped: null, took: 0, now: 4, stuck: false });
    expect(await story("same-entry-other-signature")).toEqual({ held: 4, footing: 1, dropped: null, took: 0, now: 4, stuck: false });
    expect(await story("forged-in-place-of-loose")).toEqual({ held: 3, footing: 1, dropped: null, took: 0, now: 3, stuck: false });
    expect(named("loose-same-again").shown?.entries).toEqual(named("loose-same-again").entries.slice(2));
    expect(named("loose-under-signer").expect.state.footing.seq).toBe(4);
    expect(named("loose-not-at-higher-level").expect.state.level).toBe(2);
  });

  test("the head of each answer: the last entry it shows, but for the one that names another entry than it shows; four lie before the member's own head", () => {
    for (const name of GOING_BACK) {
      const { shown, entries } = named(name);
      if (shown === undefined) throw new Error(`${name} shows nothing`);
      const lastShown = shown.entries[shown.entries.length - 1];
      if (lastShown !== undefined && name !== "head-other-at-shown-entry") expect([name, shown.head]).toEqual([name, { seq: Number(new Map(lastShown.fields).get("seq")), hash: lastShown.hash }]);
      expect([name, shown.head.seq < entries.length - 1]).toEqual([name, ["loose-head-before", "footing-head-before", "head-before-footing-no-entry", "head-before-past-footing"].includes(name)]);
    }
    const stop = named("footing-head-before");
    expect([stop.shown?.entries, stop.expect.stops, stop.expect.stuck]).toEqual([[], { seq: stop.shown?.head.seq ?? -1, code: "chain_broken" }, true]);
    expect((stop.shown?.head.seq ?? 9) < stop.expect.state.footing.seq).toBe(true);
    expect(stop.shown?.head.hash).not.toBe(at(stop.entries, stop.shown?.head.seq ?? 0).hash);
  });

  test("the state after going back is as if the member had never seen the loose entries", async () => {
    for (const name of ["loose-one-then-list", "loose-several-then-list", "loose-head-before"]) {
      const vector = named(name);
      const clean = await replayEntries([...vector.entries.slice(0, 2), ...(vector.shown?.entries ?? [])].map((entry) => entry.text), 1, { saved: null });
      expect([name, clean.stopped, clean.member?.state]).toEqual([name, null, vector.expect.state]);
    }
  });

  test("the three vectors of an entry that fails right after one the member has just taken: only the one that fails in its prev alone is stuck", async () => {
    const bySeq = named("seq-wrong-after-footing");
    const byList = named("other-list-after-footing");
    const byPrev = named("prev-other-after-footing");
    const hashes = (items: readonly VectorEntry[]) => items.map((item) => item.hash);
    const list = at(byPrev.entries, 0).hash;
    for (const [vector, wrong, stuck] of [[bySeq, "seq", false], [byList, "list", false], [byPrev, "prev", true]] as const) {
      const [third, fourth] = vector.shown?.entries ?? [];
      if (!third || !fourth) throw new Error(`${vector.name} shows no two entries`);
      expect([vector.name, hashes(vector.entries), third.hash]).toEqual([vector.name, hashes(byPrev.entries), at(byPrev.shown?.entries ?? [], 0).hash]);
      expect([vector.name, vector.expect.head, vector.expect.state, vector.expect.stops]).toEqual([vector.name, { seq: 3, hash: third.hash }, byPrev.expect.state, { seq: 4, code: "chain_broken" }]);
      expect([vector.name, vector.expect.state.footing]).toEqual([vector.name, { seq: 3, hash: third.hash }]);
      const fields = new Map(fourth.fields);
      expect([vector.name, await verifySignature(fromBase64Url(fourth.body), fromBase64Url(fourth.signature), fields.get("signer") ?? "")]).toEqual([vector.name, true]);
      const outOfOrder = [fields.get("seq") === "4" ? "" : "seq", fields.get("list") === list ? "" : "list", fields.get("prev") === third.hash ? "" : "prev"].join("");
      expect([vector.name, outOfOrder, vector.expect.stuck]).toEqual([vector.name, wrong, stuck]);
    }
    expect(isListHash(new Map(at(byPrev.shown?.entries ?? [], 1).fields).get("prev") ?? "")).toBe(true);
  });

  test("head-other-at-shown-entry: its head names another entry than the one it shows there; whole and cut in two, the member takes that entry, stops at the head's place, stuck, and takes no further entry", async () => {
    const vector = named("head-other-at-shown-entry");
    const { member, shown: whole } = await run(vector);
    const shown = vector.shown;
    const [third, fourth] = shown?.entries ?? [];
    if (whole === null || shown === undefined || !third || !fourth) throw new Error("it shows no two entries");
    expect([new Map(third.fields).get("seq"), new Map(fourth.fields).get("seq"), new Map(fourth.fields).get("prev") === third.hash]).toEqual(["3", "4", true]);
    for (const item of [third, fourth]) expect(await verifySignature(fromBase64Url(item.body), fromBase64Url(item.signature), new Map(item.fields).get("signer") ?? "")).toBe(true);
    expect([shown.head.seq, shown.head.hash === third.hash, isListHash(shown.head.hash)]).toEqual([3, false, true]);
    const cameTo = (result: Awaited<ReturnType<typeof shownEntries>>) => ({ ...result, took: result.took.map((item) => item.held.hash) });
    expect(cameTo(whole)).toMatchObject({ took: [third.hash], stopped: { seq: 3, code: "chain_broken" }, stuck: true, asks_after: null, dropped_from: null });
    expect([listHead(whole.member), whole.member.state.footing]).toEqual([{ seq: 3, hash: third.hash }, { seq: 3, hash: third.hash }]);
    expect(cameTo(await shownEntries(member, { after: 2, entries: [third.text], head: shown.head }))).toEqual(cameTo(whole));
    const honest = await shownEntries(member, { after: 2, entries: [third.text, fourth.text], head: { seq: 4, hash: fourth.hash } });
    expect([honest.stopped, honest.stuck, honest.asks_after, cameTo(honest).took]).toEqual([null, false, null, [third.hash, fourth.hash]]);
  });

  test("loose-same-then-list: the answer shows the member's entry 2 again and names as its head another entry 3 than its own; whole and cut in two, the member ends on that entry", async () => {
    const vector = named("loose-same-then-list");
    const { member, shown: whole } = await run(vector);
    const shown = vector.shown;
    const [second, third] = shown?.entries ?? [];
    if (whole === null || shown === undefined || !second || !third) throw new Error("it shows no two entries");
    expect([member.state.level, member.state.footing.seq, member.entries.length, second.hash === at(vector.entries, 2).hash, third.hash === at(vector.entries, 3).hash]).toEqual([2, 2, 4, true, false]);
    expect(shown.head).toEqual({ seq: 3, hash: third.hash });
    const ends = (result: Awaited<ReturnType<typeof shownEntries>>) => [result.stopped, result.stuck, result.asks_after, listHead(result.member), result.member.state.footing];
    expect(ends(whole)).toEqual([null, false, null, shown.head, shown.head]);
    expect([whole.dropped_from, whole.took.map((item) => item.held.hash)]).toEqual([3, [third.hash]]);
    const first = await shownEntries(member, { after: 1, entries: [second.text], head: shown.head }, proofOf(vector));
    expect([first.took.length, first.dropped_from, first.asks_after, first.stopped, first.member]).toEqual([0, null, null, null, member]);
    expect(ends(await shownEntries(first.member, { after: 2, entries: [third.text], head: shown.head }, proofOf(vector)))).toEqual(ends(whole));
  });

  test("an honest answer is never caught by its head: each answer whose head is the last entry it shows ends the same under a head that lies past everything, and cut in two at every place", async () => {
    const honest = GOING_BACK.filter((name) => {
      const { shown } = named(name);
      const lastShown = shown?.entries[shown.entries.length - 1];
      return shown !== undefined && lastShown !== undefined && shown.head.hash === lastShown.hash;
    });
    expect(honest).toEqual(GOING_BACK.filter((name) => !["footing-head-before", "head-before-footing-no-entry", "head-before-past-footing", "head-other-at-shown-entry"].includes(name)));
    expect(honest.length).toBe(14);
    const far = { seq: 1000, hash: "ab".repeat(32) };
    const cameTo = (result: Awaited<ReturnType<typeof shownEntries>>) => ({ ...result, took: result.took.map((item) => item.held.hash) });
    let cuts = 0;
    for (const name of honest) {
      const vector = named(name);
      const { member, shown: whole } = await run(vector);
      const shown = vector.shown;
      if (whole === null || shown === undefined) throw new Error(`${name} shows nothing`);
      const texts = shown.entries.map((entry) => entry.text);
      const after = Number(new Map(at(shown.entries, 0).fields).get("seq")) - 1;
      expect([name, cameTo(await shownEntries(member, { after, entries: texts, head: far }, proofOf(vector)))]).toEqual([name, cameTo(whole)]);
      for (let cut = 1; cut < texts.length; cut++) {
        const first = await shownEntries(member, { after, entries: texts.slice(0, cut), head: shown.head }, proofOf(vector));
        const second = first.stopped !== null || first.asks_after !== null ? null : await shownEntries(first.member, { after: after + cut, entries: texts.slice(cut), head: shown.head }, proofOf(vector));
        const inTwo = second === null ? cameTo(first) : { ...cameTo(second), took: [...cameTo(first).took, ...cameTo(second).took], dropped_from: first.dropped_from ?? second.dropped_from };
        expect([name, cut, inTwo]).toEqual([name, cut, cameTo(whole)]);
        cuts++;
      }
    }
    expect(cuts).toBe(11);
  });

  test("same-entry-other-signature and forged-in-place-of-loose are what their names say", async () => {
    const same = named("same-entry-other-signature");
    for (const [index, shownEntry] of (same.shown?.entries ?? []).entries()) {
      const own = at(same.entries, index + 2);
      expect([shownEntry.hash, shownEntry.body, shownEntry.signature === own.signature]).toEqual([own.hash, own.body, false]);
      const signer = new Map(shownEntry.fields).get("signer") ?? "";
      for (const item of [own, shownEntry]) expect(await verifySignature(fromBase64Url(item.body), fromBase64Url(item.signature), signer)).toBe(true);
    }
    expect(same.shown?.entries.length).toBe(2);
    const forged = at(named("forged-in-place-of-loose").shown?.entries ?? [], 0);
    expect(await verifySignature(fromBase64Url(forged.body), fromBase64Url(forged.signature), new Map(forged.fields).get("signer") ?? "")).toBe(false);
    expect(forged.hash).toBe(at(named("footing-replaced").shown?.entries ?? [], 0).hash);
  });

  test("the three cases of a proof that lets nobody in: each entry is passed over, and the footing stays under it", () => {
    for (const [name, place] of [["proof-names-another-key", 2], ["proof-key-ended-stays-out", 4], ["proof-for-ended-adds-key", 4]] as const) {
      const { entries, lets_in, expect: expected } = named(name);
      const entry = new Map(at(entries, place).fields);
      expect([name, entries.length - 1, lets_in?.some((item) => item.seq === place)]).toEqual([name, place, true]);
      expect([name, at(expected.took, place - 1)]).toEqual([name, { seq: place, outcome: "passed_over", code: "signer_unknown" }]);
      expect([name, expected.state.footing.seq, expected.state.level]).toEqual([name, place - 1, 2]);
      expect([name, expected.state.signers[entry.get("signer") ?? ""]?.ended ?? "no row"]).toEqual([name, name === "proof-names-another-key" ? "no row" : 3]);
    }
  });

  test("loose-not-at-higher-level: a member of level 1 holds what the login key signed as loose entries", async () => {
    const vector = named("loose-not-at-higher-level");
    const lower = await replayEntries(vector.entries.map((entry) => entry.text), 1, { saved: null });
    expect([lower.member?.state.footing.seq, Object.keys(lower.member?.state.signers ?? {}).length, lower.member?.state.behind]).toEqual([1, 1, 1]);
  });

  async function vectorKeys(): Promise<Map<string, Key>> {
    const keys = new Map<string, Key>();
    for (const vector of vectors) {
      for (const [name, { pkcs8, spki }] of Object.entries(vector.keys)) {
        if (keys.has(name)) continue;
        const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(pkcs8)), P256, false, ["sign"]);
        const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(spki)), P256, true, ["verify"]);
        keys.set(name, { name, key: spki, pair: { privateKey, publicKey } });
      }
    }
    return keys;
  }

  test("generated histories, the same in every run, each taken by every level below the one that reads everything, as a replay, as answers, and after loose entries that the log has since replaced, and saved and read back by every lower build, which replays it: a member that has not stopped holds the signers and the footing of a member that reads everything and holds the same entries; a member that has stopped places no entry to sign, takes none and answers for no key, through answers, a saved state and replays, also by a lower level, until a replay takes the entry it stopped at; and no member answers a power for a key that its copy has ended", async () => {
    const keys = await vectorKeys();
    const keyOf = (name: string): Key => {
      const key = keys.get(`TEST-ONLY-${name}`);
      if (key === undefined) throw new Error(`the vectors have no key ${name}`);
      return key;
    };
    const first = keyOf("owner");
    const others = ["device", "watch", "late-device", "login", "machine-own", "invite"].map(keyOf);
    const nobody = keyOf("service");
    const everyKey = [first, ...others, nobody].map((key) => key.key);
    let seed = GENERATED_SEED;
    const next = (below: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 2 ** 32) * below);
    };
    const pick = <T>(items: readonly T[]): T => at(items, next(items.length));
    const saved = (state: SignersState) => readSignersState(JSON.parse(JSON.stringify(state)), state.level);
    const counts = { cases: 0, free: 0, members: 0, stopped: 0, stoppedAtLoose: 0, downgrades: 0, noMember: 0, lowered: 0, loweredNoMember: 0, behindToTheEnd: 0, letIn: 0, endedProofKeyAdded: 0, keysEnded: 0, races: 0, looseReplaced: 0 };
    for (let round = 0; round < GENERATED; round++) {
      const here = `seed ${GENERATED_SEED}, case ${round}`;
      const lets = new Map<string, SignerPower>();
      const proof: KeyProof = (held) => {
        const power = lets.get(held.hash);
        return power === undefined ? null : { key: held.body.signer, power };
      };
      const insiders: Key[] = [first];
      const log: Link[] = [await genesis(first)];
      const asks: number[] = [];
      let named: Draft | null = null;
      let top = 1;
      const entry = async (v: number, ending: readonly Key[]) => {
        const what = next(9);
        const added = pick(others);
        const draft: Draft = what < 2 ? { kind: "later", v }
          : what < 4 ? { kind: "device", v, adds: [added, pick(["full", "full", "bound"] as const)] }
          : what === 4 ? { v, ends: pick(ending) }
          : what === 5 ? { kind: "device", v, adds: [added, "full"], ends: pick(ending) }
          : what === 6 && named !== null ? named
          : { kind: "later_login", v: Math.max(2, v) };
        const asksProof = draft.kind === "later_login";
        const by = asksProof || next(5) === 0 ? pick(others) : pick(insiders);
        if (draft === named) counts.races++;
        named = draft.adds !== undefined || draft.ends !== undefined ? draft : null;
        if (draft.adds !== undefined) insiders.push(draft.adds[0]);
        if (asksProof) asks.push(log.length);
        const link = await on(last(log), by, draft);
        log.push(link);
        top = Math.max(top, draft.v ?? 1);
        if (!asksProof || next(5) >= 3) return;
        lets.set(link.hash, next(3) === 0 ? "bound" : "full");
        insiders.push(by);
        if (next(2) === 1) return;
        counts.endedProofKeyAdded++;
        named = null;
        for (const [signer, step] of [[first, { ends: by }], [first, { kind: "device", adds: [by, "full"] }], [by, { ends: first }]] as const) log.push(await on(last(log), signer, step));
      };
      if (round % 3 === 2) {
        counts.free++;
        for (let length = 4 + next(7); length > 0; length--) await entry(next(3) === 0 ? 2 : next(4) === 0 ? 3 : 1, [...insiders, ...others]);
        if (top === 1) log.push(await on(last(log), first, { kind: "later", v: 2 }));
        top = Math.max(top, 2);
      } else {
        const rises = 2 + next(2);
        for (let needs = 1; needs <= rises; needs++) {
          if (needs > 1) log.push(await on(last(log), first, { kind: "later", v: needs }));
          for (let length = (needs === 1 ? 0 : 1) + next(2); length > 0; length--) await entry(1 + next(needs), needs < rises ? [...insiders.slice(1), ...others] : [...insiders, ...others]);
        }
        top = rises;
      }
      const byHash = new Map(log.map((link) => [link.hash, link]));
      const list = texts(log);
      const logHead = place(last(log));
      const read = new Map<string, { member: ListMember; took: readonly TakenEntry[] }>();
      const upToDate = async (entries: readonly string[]) => {
        const key = `${entries.length} ${last(entries)}`;
        let found = read.get(key);
        if (found === undefined) {
          const { member, took, stopped } = await replayEntriesOf(entries, top, { saved: null, proof });
          if (member === null || stopped !== null || isBehind(member.state)) throw new Error(`${here}: the member that reads everything does not take these ${entries.length} entries`);
          found = { member, took };
          read.set(key, found);
        }
        return found;
      };
      /** The keys that these entries ended: each entry that names one in `ends` and is not passed over. They are out for good. */
      const endedBy = (took: readonly TakenEntry[]) => took.flatMap(({ held, outcome }) => (held.body.ends !== undefined && outcome.outcome !== "passed_over" ? [held.body.ends] : []));
      const whole = await upToDate(list);
      if (whole.took.some(({ outcome }) => outcome.outcome === "reads" && outcome.power === null)) counts.letIn++;
      counts.keysEnded += new Set(endedBy(whole.took)).size;

      /**
       * A member, after any step, beside the member that reads everything and holds the same entries: the same rows, the same footing, the same need. Its state, saved and read again, is as
       * it was. No reader answers a power for a key that its copy has ended, for neither of the two. One that has not stopped signs where the other signs; one that has stopped answers for
       * no key at all, is behind, and places nothing.
       */
      const beside = async (member: ListMember, where: string) => {
        counts.members++;
        const { state } = member;
        const { member: other, took } = await upToDate(member.entries);
        expect([where, state.signers, state.footing, state.needs, saved(state)]).toEqual([where, other.state.signers, other.state.footing, other.state.needs, state]);
        for (const key of endedBy(took)) expect([where, key, signerPower(state, key), signerPower(other.state, key)]).toEqual([where, key, null, null]);
        const places = signingPlace(member, listHead(member));
        if (state.needs_replay === undefined) expect([where, places, everyKey.map((key) => signerPower(state, key))]).toEqual([where, signingPlace({ entries: member.entries, state: other.state }, listHead(member)), everyKey.map((key) => signerPower(other.state, key))]);
        else expect([where, places, isBehind(state), everyKey.filter((key) => signerPower(state, key) !== null)]).toEqual([where, null, true, []]);
      };

      const stopped = async (member: ListMember, level: number, where: string) => {
        counts.stopped++;
        const { entries, state } = member;
        const stop = state.needs_replay;
        const stoppedAt = stop === undefined ? undefined : byHash.get(stop.hash);
        if (stop === undefined || stoppedAt === undefined) throw new Error(`${where}: not stopped at an entry of this case`);
        const stays: ListStop = { seq: stop.seq, code: "needs_replay" };
        const head = listHead(member);
        expect([where, entries.length, signingPlace(member, head), signingPlace(member, logHead)]).toEqual([where, stop.seq, null, null]);
        const other = await on({ text: last(entries), seq: head.seq, hash: head.hash, list: state.list }, first, { kind: "later" });
        const nothing: Awaited<ReturnType<typeof shownEntriesOf>> = { ...quiet, member, stopped: stays, stuck: true };
        for (const shown of [[stoppedAt.text], [other.text], list.slice(stop.seq)]) expect([where, await shownEntriesOf(member, { after: head.seq, entries: shown, head: logHead }, proof)]).toEqual([where, nothing]);
        const before = last((await upToDate(entries)).took).held;
        expect([where, judgeEntryOf(state, await entryHolds(entryFromText(other.text), before), proof)]).toEqual([where, { outcome: { outcome: "stops", code: "needs_replay" }, state }]);
        expect([where, await replayEntriesOf(entries, level, { saved: state, proof })]).toEqual([where, { member, took: expect.anything(), stopped: stays, stuck: true }]);
        const higher = await replayEntriesOf(entries, top, { saved: state, proof });
        if (higher.member === null) throw new Error(`${where}: the replay holds no entry`);
        expect([where, higher.stopped, higher.stuck, higher.member.state.needs_replay]).toEqual([where, stays, true, stop]);
        await beside(higher.member, `${where}, replayed by the level that reads everything`);
        expect([where, (await shownEntriesOf(higher.member, { after: head.seq, entries: list.slice(stop.seq), head: logHead }, proof)).member]).toEqual([where, higher.member]);
        for (let lower = 1; lower < level; lower++) {
          for (const given of [entries, [...entries, stoppedAt.text]]) {
            expect([where, lower, readSignersState(JSON.parse(JSON.stringify(state)), lower)]).toEqual([where, lower, state]);
            const below = await replayEntriesOf(given, lower, { saved: state, proof });
            counts.downgrades++;
            expect([where, lower, below.stopped, below.stuck]).toEqual([where, lower, stays, true]);
            if (below.member === null) {
              counts.noMember++;
              expect([where, lower, below.took]).toEqual([where, lower, []]);
            } else {
              expect([where, lower, below.member.entries, below.member.state.needs_replay]).toEqual([where, lower, entries, stop]);
              await beside(below.member, `${where}, replayed by level ${lower}`);
            }
          }
        }
        for (const by of new Set([level, top])) {
          const wrong = await replayEntriesOf([...entries, other.text], by, { saved: state, proof });
          expect([where, by, wrong.stopped, wrong.stuck, wrong.member?.entries, wrong.member?.state.needs_replay]).toEqual([where, by, { seq: stop.seq, code: "chain_broken" }, true, entries, stop]);
        }
        expect([where, await replayEntriesOf([...entries, stoppedAt.text], level, { saved: state, proof })]).toEqual([where, { member, took: expect.anything(), stopped: stays, stuck: true }]);
        const on2 = await replayEntriesOf([...entries, stoppedAt.text], top, { saved: state, proof });
        if (on2.member === null) throw new Error(`${where}: the replay holds no entry`);
        expect([where, on2.stopped, on2.stuck, on2.member.state.needs_replay]).toEqual([where, null, false, undefined]);
        await beside(on2.member, `${where}, gone on`);
        const after = on2.member.state.footing.seq;
        const caught = await shownEntriesOf(on2.member, { after, entries: list.slice(after + 1), head: logHead }, proof);
        expect([where, caught.stopped, caught.asks_after, caught.member]).toEqual([where, null, null, whole.member]);
      };

      /**
       * A member that is not stopped, saved by its level and read back by every lower build, as the app of an older build does at start: stopped at its footing, with the same rows, so
       * that build acts on nothing through it. Its replay by that level, told the state it read: no member, where that level cannot reach the footing, or the member of the same history,
       * with the same rows and the same footing; never a shorter one. A replay by the member's own level, told the state that the lower build read, gives the member back.
       */
      const lowered = async (member: ListMember, from: number, where: string) => {
        const text = JSON.stringify(member.state);
        for (let lower = 1; lower < from; lower++) {
          const reloaded = readSignersState(JSON.parse(text), lower);
          if (reloaded === null) throw new Error(`${where}: the saved state does not read by level ${lower}`);
          expect([where, lower, reloaded.needs_replay, reloaded.level, reloaded.footing, reloaded.signers]).toEqual([where, lower, member.state.footing, member.state.level, member.state.footing, member.state.signers]);
          await beside({ entries: member.entries, state: reloaded }, `${where}, read by level ${lower}`);
          expect([where, lower, (await replayEntriesOf(member.entries, from, { saved: reloaded, proof })).member]).toEqual([where, lower, member]);
          const below = await replayEntriesOf(member.entries, lower, { saved: reloaded, proof });
          counts.lowered++;
          if (below.member === null) {
            counts.loweredNoMember++;
            expect([where, lower, below.took, below.stuck, below.stopped?.code]).toEqual([where, lower, [], true, "needs_replay"]);
          } else {
            expect([where, lower, below.member.state.footing, below.member.state.signers]).toEqual([where, lower, member.state.footing, member.state.signers]);
            await beside(below.member, `${where}, replayed by level ${lower}`);
          }
        }
      };
      await lowered(whole.member, top, `${here}, the member that reads everything`);

      for (let level = 1; level < top; level++) {
        const where = `${here}, level ${level} beside ${top}`;
        const own = await replayEntriesOf(list, level, { saved: null, proof });
        if (own.member === null) throw new Error(`${where}: entry 0 does not hold`);
        await beside(own.member, `${where}, a replay`);
        const stop = own.member.state.needs_replay;
        expect([where, own.stopped, own.stuck, own.member.entries.length]).toEqual(stop === undefined ? [where, null, false, list.length] : [where, { seq: stop.seq, code: "needs_replay" }, true, stop.seq]);
        if (stop !== undefined) await stopped(own.member, level, `${where}, a replay`);
        else {
          if (isBehind(own.member.state)) counts.behindToTheEnd++;
          await lowered(own.member, level, `${where}, a replay`);
        }

        let { member } = await replayEntriesOf(list.slice(0, 1), level, { saved: null, proof });
        while (member !== null && member.entries.length < list.length && member.state.needs_replay === undefined) {
          const from = member.entries.length;
          const answer = await shownEntriesOf(member, { after: from - 1, entries: list.slice(from, from + 1 + next(3)), head: logHead }, proof);
          expect([where, answer.asks_after, answer.dropped_from, answer.stopped === null || answer.stopped.code === "needs_replay"]).toEqual([where, null, null, true]);
          member = answer.member;
          await beside(member, `${where}, as answers, at ${member.entries.length}`);
        }
        expect([`${where}, as answers`, member]).toEqual([`${where}, as answers`, own.member]);

        const from = asks.length > 0 && next(2) === 0 ? pick(asks) : 1 + next(log.length - 1);
        const loose: Link[] = [];
        for (let count = 1 + next(2); count > 0; count--) {
          const link = await on(loose.length > 0 ? last(loose) : at(log, from - 1), nobody, next(2) === 0 ? {} : { kind: "later_login", v: 2 });
          loose.push(link);
          byHash.set(link.hash, link);
        }
        const whereLoose = `${where}, loose entries from ${from}`;
        const held = await replayEntriesOf([...list.slice(0, from), ...texts(loose)], level, { saved: null, proof });
        if (held.member === null) throw new Error(`${where}: entry 0 does not hold`);
        await beside(held.member, whereLoose);
        const footing = held.member.state.footing.seq;
        const shown = await shownEntriesOf(held.member, { after: footing, entries: list.slice(footing + 1), head: logHead }, proof);
        const heldStop = held.member.state.needs_replay;
        if (heldStop === undefined) {
          expect([whereLoose, shown.asks_after, shown.member]).toEqual([whereLoose, null, own.member]);
          if (shown.dropped_from !== null) counts.looseReplaced++;
        } else {
          expect([whereLoose, shown.took, shown.member]).toEqual([whereLoose, [], held.member]);
          if (loose.some((link) => link.hash === heldStop.hash)) {
            counts.stoppedAtLoose++;
            await stopped(held.member, level, `${whereLoose}, stopped at one of them`);
          }
        }
      }
      counts.cases++;
    }
    expect(counts).toEqual({ cases: GENERATED, free: 50, members: 1975, stopped: 148, stoppedAtLoose: 53, downgrades: 80, noMember: 26, lowered: 278, loweredNoMember: 81, behindToTheEnd: 88, letIn: 44, endedProofKeyAdded: 53, keysEnded: 55, races: 25, looseReplaced: 148 });
  }, 120_000);
});

describe("every state that a test of this file was given", () => {
  test("reads again from its saved form, as it was", async () => {
    await memberOf(base);
    expect(made.size).toBeGreaterThan(0);
    const unread = [...made].filter(([saved]) => !isDeepStrictEqual(readSignersState(JSON.parse(saved), JSON.parse(saved).level), JSON.parse(saved))).map(([saved, maker]) => [maker, saved]);
    expect(unread).toEqual([]);
  });
});
