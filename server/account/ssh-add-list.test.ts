/**
 * The adding PC's steps of an add over SSH by the account's signed list (ssh-add-list.ts), with the take and the list
 * stood in for: what goes to the other PC, what is signed, when it says added, and when the forward is closed.
 */
import { beforeAll, expect, test } from "bun:test";
import { signCard } from "../../shared/account-list.ts";
import { exportAccountKey } from "../../shared/account-records.ts";
import type { AccountAddNamed } from "../account-add-channel.ts";
import { AccountAddError, type AccountAddCard } from "../machines.ts";
import type { AddedPc, AllowOutcome, AllowRefusal } from "./list-follow.ts";
import { addOverSshByList, type SshListDeps, type SshListTaken } from "./ssh-add-list.ts";

const LIST = "a".repeat(64);
const OTHER_LIST = "e".repeat(64);
const ADDER = "adder-key";
/** That PC's relay key, as this PC's inspect read it over the SSH session. */
const ENDPOINT = "b".repeat(64);
const ADDED: SshListTaken = { account: "acct_1", relay: { phase: "online", blocked: null } };

/** That PC's real keys and its card for `list` at `endpoint`, signed by its own key. */
async function cardOf(list = LIST, endpoint = ENDPOINT): Promise<AccountAddCard> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const enc = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = await exportAccountKey(pair.publicKey);
  const encKey = await exportAccountKey(enc.publicKey);
  return { key, enc: encKey, card: await signCard({ key, enc: encKey, list, endpoint, invite: null }, pair.privateKey), endpoint, label: "Other PC", standing: "waiting" };
}

let CARD: AccountAddCard;
beforeAll(async () => { CARD = await cardOf(); });

/**
 * A list this PC follows as a full signer, and a take that answers from `answers` in turn; what each was asked is kept.
 * `holds`: whether this PC's own copy, read again, holds the PC at that relay key.
 */
function fixture(options: { refusal?: AllowRefusal | null; answers: (SshListTaken | { waiting: AccountAddCard })[]; added?: AllowOutcome; holds?: boolean }) {
  const takes: AccountAddNamed[] = [];
  const signed: AddedPc[] = [];
  const looked: string[] = [];
  let ended = 0;
  const deps: SshListDeps = {
    endpoint: ENDPOINT,
    list: {
      allowRefusal: () => options.refusal ?? null,
      status: () => ({ pinned_list: LIST }) as ReturnType<SshListDeps["list"]["status"]>,
      own: async () => ({ serverId: "0".repeat(32), endpoint: "c".repeat(64), keys: { key: ADDER } }) as Awaited<ReturnType<SshListDeps["list"]["own"]>>,
      addPc: async (pc) => { signed.push(pc); return options.added ?? { allowed: { id: LIST, seq: 3, hash: "d".repeat(64) } }; },
      holdsPcRead: async (endpoint) => { looked.push(endpoint); return options.holds ?? true; },
    },
    take: async (named) => { takes.push(named); const next = options.answers.shift(); if (next === undefined) throw new Error("no more answers"); return next; },
    end: async () => { ended++; },
    wait: async () => {},
  };
  return { deps, takes, signed, looked, ended: () => ended };
}

test("a PC that cannot sign names no list to the other PC: no take goes, nothing is signed", async () => {
  for (const refusal of ["not_pinned", "not_signer", "alarm", "behind", "stopped", "unavailable"] as const) {
    const made = fixture({ refusal, answers: [] });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "list_cannot_add", status: 409 } });
    expect(made.takes).toEqual([]);
    expect(made.signed).toEqual([]);
  }
});

test("the take names this PC's list and its own key; the card that comes back is signed with the name and relay key the inspect read", async () => {
  const made = fixture({ answers: [{ waiting: CARD }, { ...ADDED, listJoined: true }] });
  expect(await addOverSshByList(made.deps)).toEqual({ ...ADDED, listJoined: true });
  expect(made.takes).toEqual([{ list: LIST, adder: ADDER }, { list: LIST, adder: ADDER }]);
  expect(made.signed).toEqual([CARD]);
  expect(made.ended()).toBe(0);
});

test("a card that is not that key's own for this list and the relay key the inspect read is not signed, and the forward closes", async () => {
  const otherList = await cardOf(OTHER_LIST);
  const otherEndpoint = await cardOf(LIST, "f".repeat(64));
  for (const card of [otherList, otherEndpoint, { ...CARD, enc: otherList.enc }]) {
    // whatever relay key the answer names, the one the inspect read is the one it is held to
    const made = fixture({ answers: [{ waiting: { ...card, endpoint: ENDPOINT } }] });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "list_not_added" } });
    expect(made.signed).toEqual([]);
    expect(made.takes).toHaveLength(1);
    expect(made.ended()).toBe(1);
  }
});

test("the other PC in the list already: nothing is signed, and it is added only once this PC's own copy holds it", async () => {
  const made = fixture({ answers: [ADDED] });
  expect(await addOverSshByList(made.deps)).toEqual(ADDED);
  expect(made.signed).toEqual([]);
  expect(made.looked).toEqual([ENDPOINT]);
  expect(made.takes).toHaveLength(1);
});

test("the other PC says it joined, and this PC's own copy, read again, does not hold it: never said added", async () => {
  for (const answers of [[ADDED], [{ waiting: CARD }, ADDED]]) {
    const made = fixture({ answers, holds: false });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "take_unanswered" } });
    expect(made.looked).toEqual([ENDPOINT]);
  }
});

test("a PC that joined the list by this add is said to have joined it; one that was in it already is not, also after this PC placed an entry (PR #4645 review)", async () => {
  const joined = fixture({ answers: [{ waiting: CARD }, { ...ADDED, listJoined: true }] });
  expect(await addOverSshByList(joined.deps)).toEqual({ ...ADDED, listJoined: true });
  const there = fixture({ answers: [ADDED] });
  expect(await addOverSshByList(there.deps)).toEqual(ADDED);
  // it followed the list by the time of the next take (another way in): this take joined it to nothing
  const meanwhile = fixture({ answers: [{ waiting: CARD }, ADDED] });
  expect(await addOverSshByList(meanwhile.deps)).toEqual(ADDED);
});

test("added is held to the list this add named: this PC's own copy is read for that very list (PR #4645 review)", async () => {
  const made = fixture({ answers: [{ waiting: CARD }, { ...ADDED, listJoined: true }] });
  const asked: string[] = [];
  made.deps.list.holdsPcRead = async (endpoint, list) => { asked.push(`${endpoint} ${list}`); return true; };
  expect(await addOverSshByList(made.deps)).toEqual({ ...ADDED, listJoined: true });
  expect(asked).toEqual([`${ENDPOINT} ${LIST}`]);
});

test("the account service's budget of additions: said as a time to wait, apart from an entry it refused", async () => {
  const made = fixture({ answers: [{ waiting: CARD }], added: { refused: "refused", detail: "429 entry_budget" } });
  expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "list_budget" } });
  expect(made.ended()).toBe(1);
});

test("an entry this PC could not place ends the add there: the forward is closed and no second take goes", async () => {
  for (const [refused, code] of [["not_written", "list_not_added"], ["refused", "list_not_added"], ["head_lost", "list_not_added"], ["service_away", "take_unanswered"], ["alarm", "list_cannot_add"]] as const) {
    const made = fixture({ answers: [{ waiting: CARD }], added: { refused, detail: null } });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code } });
    expect(made.takes).toHaveLength(1);
    expect(made.ended()).toBe(1);
  }
});

test("a PC that has not taken its entry after the last take: in the list, not following it yet, and said so as a step to finish; the forward is closed", async () => {
  const made = fixture({ answers: [{ waiting: CARD }, { waiting: CARD }, { waiting: CARD }, { waiting: CARD }, { waiting: CARD }, { waiting: CARD }] });
  expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "list_unbound" } });
  expect(made.signed).toHaveLength(1);
  expect(made.takes).toHaveLength(6);
  expect(made.ended()).toBe(1);
});

test("a take the other PC refuses is thrown on as it came", async () => {
  const made = fixture({ answers: [] });
  made.deps.take = async () => { throw Object.assign(new Error("That PC is in another account"), { code: "other_account" }); };
  await expect(addOverSshByList(made.deps)).rejects.toMatchObject({ code: "other_account" });
});

test("a take lost before anything was signed is not known; one lost or refused after the entry is placed is in the list and not taken yet, never not added", async () => {
  const lost = () => new AccountAddError("take_lost", "That PC's answer to the take was lost");
  const before = fixture({ answers: [] });
  before.deps.take = async () => { throw lost(); };
  expect(await addOverSshByList(before.deps)).toMatchObject({ refused: { code: "take_unanswered" } });
  expect(before.signed).toEqual([]);
  for (const error of [lost(), new AccountAddError("identity_changed", "reset"), new AccountAddError("refused", "That PC did not take the account")]) {
    const made = fixture({ answers: [{ waiting: CARD }] });
    const take = made.deps.take;
    made.deps.take = async (named) => made.takes.length === 0 ? await take(named) : (() => { made.takes.push(named); throw error; })();
    // whether it took the entry is not known (its answer may be what was lost): said so, never "has not taken it"
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "list_unbound", message: expect.stringContaining("could not be confirmed") } });
    expect(made.signed).toHaveLength(1);
    expect(made.ended()).toBe(1);
  }
});

test("a PC that cannot read the list, or that the list put out, is signed nothing: what to do is said, and the forward closes", async () => {
  for (const [standing, code] of [["stopped", "that_pc_behind"], ["out", "list_removed"]] as const) {
    const made = fixture({ answers: [{ waiting: { ...CARD, standing } }] });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code } });
    expect(made.signed).toEqual([]);
    expect(made.ended()).toBe(1);
  }
});

test("an error of any other kind once that PC answered with its card closes the forward and is thrown on", async () => {
  const made = fixture({ answers: [{ waiting: CARD }] });
  made.deps.list.addPc = async () => { throw new TypeError("the disk went away"); };
  await expect(addOverSshByList(made.deps)).rejects.toThrow("the disk went away");
  expect(made.ended()).toBe(1);
});
