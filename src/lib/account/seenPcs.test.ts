import { describe, expect, it } from "bun:test";
import { SEEN_PCS_MAX, clearTried, didFor, forgetSeenPc, howOf, noteAct, noteSession, noteTried, readSeenPcs, seenInSession, withoutPc, type SeenPcs } from "./seenPcs.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const empty = (account = "acct"): SeenPcs => ({ v: 1, account, pcs: {} });
function memory(): Storage {
  const kept = new Map<string, string>();
  return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } as Storage;
}

describe("what a device keeps of the PCs it held sessions with", () => {
  it("writes when it first held a session once, and never moves it, earlier or later", () => {
    const first = seenInSession(empty(), A, 1_000, "none");
    expect(first.pcs).toEqual({ [A]: { since: 1_000, last: 1_000, how: "none" } });
    expect(seenInSession(first, A, 5_000, "none").pcs[A]).toEqual({ since: 1_000, last: 5_000, how: "none" });
    // a clock that was set back moves neither
    expect(seenInSession(seenInSession(first, A, 5_000, "none"), A, 10, "none").pcs[A]).toEqual({ since: 1_000, last: 5_000, how: "none" });
  });

  it("keeps what this device did itself for a PC: from nothing to one act, never back and never to another", () => {
    const paired = seenInSession(seenInSession(empty(), A, 1_000, "none"), A, 2_000, "paired");
    expect(paired.pcs[A]).toEqual({ since: 1_000, last: 2_000, how: "paired" });
    expect(seenInSession(paired, A, 3_000, "none").pcs[A]!.how).toBe("paired");
    expect(didFor(paired, A, "added").pcs[A]!.how).toBe("paired");
    // an act with no session yet: the row says what was done, and has no time until the PC lets this device in
    const added = didFor(empty(), B, "added");
    expect(added.pcs[B]).toEqual({ how: "added" });
    // a PC that joined with this account's invite, proved by the line's own key, and the person's Add: a value of its own, kept like the others
    const invitedPc = didFor(empty(), B, "invited");
    expect(invitedPc.pcs[B]).toEqual({ how: "invited" });
    expect(seenInSession(invitedPc, B, 9_000, "none").pcs[B]).toEqual({ since: 9_000, last: 9_000, how: "invited" });
    // and it reads back from storage as it was written
    const kept = new Map<string, string>([["ovis:seen-pcs:" + invitedPc.account, JSON.stringify(invitedPc)]]);
    expect(readSeenPcs(invitedPc.account, { getItem: (name: string) => kept.get(name) ?? null } as unknown as Storage).pcs[B]).toEqual({ how: "invited" });
    expect(seenInSession(added, B, 9_000, "none").pcs[B]).toEqual({ since: 9_000, last: 9_000, how: "added" });
  });

  it("keeps a row whose `how` this build does not know as it is, through every write, and counts it as none for a decision", async () => {
    const storage = memory();
    // a later build wrote a value this one does not know
    storage.setItem("ovis:seen-pcs:acct", JSON.stringify({ v: 1, account: "acct", pcs: { [A]: { since: 1_000, last: 2_000, how: "vouched_later" } } }));
    expect(readSeenPcs("acct", storage).pcs[A]).toEqual({ since: 1_000, last: 2_000, how: "vouched_later" });
    // a session with another PC, then one with this PC, and an act for it: the row stays, its `how` unchanged
    await noteSession("acct", B, "paired", 3_000_000, storage);
    await noteSession("acct", A, "paired", 4_000_000, storage);
    await noteAct("acct", A, "added", storage);
    const kept = readSeenPcs("acct", storage);
    expect(kept.pcs[A]).toEqual({ since: 1_000, last: 4_000, how: "vouched_later" });
    expect(kept.pcs[B]).toEqual({ since: 3_000, last: 3_000, how: "paired" });
    expect([howOf(kept.pcs[A]), howOf(kept.pcs[B]), howOf(undefined)]).toEqual(["none", "paired", "none"]);
  });

  it("keeps the newest PCs only, by their last session, and a PC it did something for before one it only opened", () => {
    let record = empty();
    for (let n = 0; n < SEEN_PCS_MAX + 2; n += 1) record = seenInSession(record, n.toString(16).padStart(64, "0"), 1_000 + n, "none");
    expect(Object.keys(record.pcs)).toHaveLength(SEEN_PCS_MAX);
    expect(record.pcs["0".repeat(64)]).toBeUndefined();
    expect(record.pcs[(SEEN_PCS_MAX + 1).toString(16).padStart(64, "0")]).toBeDefined();
  });

  it("forgets a PC by its relay key, and leaves the others", () => {
    const record = seenInSession(seenInSession(empty(), A, 1, "none"), B, 2, "none");
    expect(Object.keys(withoutPc(record, A).pcs)).toEqual([B]);
  });
});

describe("the record in this browser's storage", () => {
  it("is kept per account, survives a page that knows nothing, and reads as empty when it is not in its form", async () => {
    const storage = memory();
    await noteSession("acct_one", A, "paired", 5_000_000, storage);
    await noteSession("acct_two", B, "none", 6_000_000, storage);
    expect(readSeenPcs("acct_one", storage)).toEqual({ v: 1, account: "acct_one", pcs: { [A]: { since: 5_000, last: 5_000, how: "paired" } } });
    expect(Object.keys(readSeenPcs("acct_two", storage).pcs)).toEqual([B]);
    expect(readSeenPcs("acct_none", storage)).toEqual(empty("acct_none"));
    storage.setItem("ovis:seen-pcs:acct_bad", "{not json");
    expect(readSeenPcs("acct_bad", storage)).toEqual(empty("acct_bad"));
    storage.setItem("ovis:seen-pcs:acct_other", JSON.stringify({ v: 1, account: "acct_someone_else", pcs: { [A]: { since: 1, last: 1, how: "none" } } }));
    expect(readSeenPcs("acct_other", storage)).toEqual(empty("acct_other"));
    // one row out of form does not cost the others
    storage.setItem("ovis:seen-pcs:acct_mixed", JSON.stringify({ v: 1, account: "acct_mixed", pcs: { [A]: { since: 1, last: 1, how: "none" }, [B]: { since: "soon", how: "paired" }, short: { how: "none" } } }));
    expect(Object.keys(readSeenPcs("acct_mixed", storage).pcs)).toEqual([A]);
  });

  it("takes a relay key only as 64 hex, and writes nothing for anything else", async () => {
    const storage = memory();
    await noteSession("acct", "not-a-key", "none", 1_000, storage);
    await noteAct("acct", "AA".repeat(32), "added", storage);
    expect(readSeenPcs("acct", storage)).toEqual(empty());
  });

  it("forgets a PC by the id its relay key gives, when the person removes it from the account", async () => {
    const storage = memory();
    const key = generateKeyPair().publicKey;
    const endpoint = Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await noteSession("acct", endpoint, "none", 1_000, storage);
    await noteSession("acct", A, "none", 1_000, storage);
    await forgetSeenPc("acct", deriveServerId(key), storage);
    expect(Object.keys(readSeenPcs("acct", storage).pcs)).toEqual([A]);
  });

  it("keeps when this device first tried to start or to join the account's list: written once, gone when the try ends, the PCs untouched", async () => {
    const storage = memory();
    await noteSession("acct", A, "none", 1_000_000, storage);
    await noteTried("acct", 2_000_000, storage);
    await noteTried("acct", 9_000_000, storage);
    expect(readSeenPcs("acct", storage)).toEqual({ v: 1, account: "acct", pcs: { [A]: { since: 1_000, last: 1_000, how: "none" } }, tried: 2_000 });
    await clearTried("acct", storage);
    expect(readSeenPcs("acct", storage)).toEqual({ v: 1, account: "acct", pcs: { [A]: { since: 1_000, last: 1_000, how: "none" } } });
  });

  it("writes nothing where the browser gives no storage, and throws nothing", async () => {
    const none = { getItem: () => { throw new DOMException("no storage", "SecurityError"); }, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} } as unknown as Storage;
    await noteSession("acct", A, "none", 1_000, none);
    expect(readSeenPcs("acct", none)).toEqual(empty());
  });
});
