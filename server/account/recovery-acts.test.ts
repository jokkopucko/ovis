/**
 * What the recovery socket does with each act of `ovis recover` (device-row-states rows T70, R11, P7, P23, S22): it
 * parses the act with the shared contract, lists the waiting rows with why each can or cannot be released, releases
 * only releasable rows (journal first), and undoes releases whole.
 */
import { expect, test } from "bun:test";
import { RecoveryReleases, type RecoveryCandidate, type RecoveryJournalEntry } from "./recovery.ts";
import { recoveryActs, type RecoverySeams } from "./recovery-acts.ts";

const row = (id: string, extra: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({
  id, key: `key-${id}`, label: `Row ${id}`, origin: { from: "remote", how: "list" }, waiting: "catching_up",
  joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null, ...extra,
});

function setup(options: { logReadable?: boolean; failJournal?: boolean } = {}) {
  const journal: RecoveryJournalEntry[] = [];
  const releases = new RecoveryReleases({ journal: (entry) => { if (options.failJournal) throw new Error("disk full"); journal.push(entry); } });
  releases.registerRecoverySource(() => [row("0123456789abcdef"), row("fedcba9876543210", { frozen: true }), row("aaaaaaaaaaaaaaaa", { waiting: null })]);
  const acts = recoveryActs({ releases, logReadable: () => options.logReadable ?? true, user: "owner" });
  return { acts, releases, journal };
}

test("T70: list names every waiting row and why it can or cannot be released", async () => {
  const { acts } = setup();
  const answer = await acts({ act: "list" }) as { rows: { id: string; refusal: string | null }[] };
  expect(answer.rows.map((entry) => [entry.id, entry.refusal])).toEqual([["0123456789abcdef", null], ["fedcba9876543210", "frozen"]]);
});

test("T70: release lets in only releasable rows, journalled under this PC's user", async () => {
  const { acts, releases, journal } = setup();
  expect(await acts({ act: "release", rows: ["0123456789abcdef"] })).toEqual({ released: ["0123456789abcdef"] });
  expect(releases.releaseOf("0123456789abcdef")).not.toBeNull();
  expect(journal[0]).toMatchObject({ kind: "release", by: "owner" });
  expect(await acts({ act: "release", rows: ["fedcba9876543210"] })).toEqual({ error: "fedcba9876543210 cannot be released: frozen" });
  expect(await acts({ act: "release", rows: ["bbbbbbbbbbbbbbbb"] })).toEqual({ error: "bbbbbbbbbbbbbbbb does not wait here" });
  expect(releases.releaseOf("fedcba9876543210")).toBeNull();
});

test("P23: nothing is released while the log cannot be read", async () => {
  const { acts, releases } = setup({ logReadable: false });
  expect(await acts({ act: "release", rows: ["0123456789abcdef"] })).toEqual({ error: "0123456789abcdef cannot be released: log_unreadable" });
  expect(releases.releaseOf("0123456789abcdef")).toBeNull();
});

test("T70: a failed journal write releases nobody", async () => {
  const { acts, releases } = setup({ failJournal: true });
  const answer = await acts({ act: "release", rows: ["0123456789abcdef"] }) as { error?: string };
  expect(answer.error).toContain("nothing was released");
  expect(releases.releaseOf("0123456789abcdef")).toBeNull();
});

test("T70: undo ends releases, and an act the contract does not parse is refused", async () => {
  const { acts, releases } = setup();
  await acts({ act: "release", rows: ["0123456789abcdef"] });
  expect(await acts({ act: "undo", rows: null })).toMatchObject({ releases: [expect.any(String)] });
  expect(releases.releaseOf("0123456789abcdef")).toBeNull();
  expect(await acts({ act: "release", rows: ["not-a-row-id"] })).toEqual({ error: "Invalid recovery action" });
  expect(await acts({ act: "remove", targets: ["0123456789abcdef"] })).toEqual({ error: "remove is not available on this PC yet" });
});

test("T70/E46: a row already released is not released again, so an undo still ends every session the first release let in", async () => {
  const { acts, releases } = setup();
  expect(await acts({ act: "release", rows: ["0123456789abcdef"] })).toEqual({ released: ["0123456789abcdef"] });
  const closed: string[] = [];
  releases.watch(releases.releaseOf("0123456789abcdef")!, () => { closed.push("first"); });
  expect(await acts({ act: "release", rows: ["0123456789abcdef"] })).toEqual({ error: "0123456789abcdef is released already" });
  await acts({ act: "undo", rows: null });
  expect(closed).toEqual(["first"]);
});

test("T70: list says when this PC last saw each waiting row", async () => {
  const journal: RecoveryJournalEntry[] = [];
  const releases = new RecoveryReleases({ journal: (entry) => { journal.push(entry); } });
  releases.registerRecoverySource(() => [row("0123456789abcdef", { lastSeenAt: "2026-11-19T10:00:00.000Z" })]);
  const acts = recoveryActs({ releases, logReadable: () => true, user: "owner" });
  const answer = await acts({ act: "list" }) as { rows: { last_seen_at: string | null }[] };
  expect(answer.rows[0]!.last_seen_at).toBe("2026-11-19T10:00:00.000Z");
});

function seams(options: { fingerprint?: string; admitted?: boolean } = {}) {
  const calls: string[] = [];
  const pending = { id: "0123456789abcdef0123456789abcdef", label: "Phone", fingerprint: options.fingerprint ?? "AB12-CD34" };
  const made: RecoverySeams = {
    pendingList: () => [{ id: pending.id, label: pending.label, fingerprint: pending.fingerprint }],
    standing: () => [],
    admitPending: (id, fingerprint) => {
      if (id !== pending.id) return "unknown";
      if (fingerprint !== pending.fingerprint) return "mismatch";
      calls.push(`admit ${id} recover`);
      return options.admitted === false ? null : { id: "fedcba9876543210", label: "Phone", role: "drive" };
    },
    removeKey: ({ target, user }) => { calls.push(`remove ${target} ${user}`); return { removed: [target] }; },
    appendLift: (block, forget, user) => { calls.push(`lift ${block} ${forget} ${user}`); return { outcome: "applied" }; },
    revokeAll: (user) => { calls.push(`revoke_all ${user}`); return ["a", "b"]; },
    accountStatus: () => ({ account: null, members: 0 }),
  };
  return { made, calls, pending };
}

function withSeams(options: { logReadable?: boolean; fingerprint?: string; admitted?: boolean } = {}) {
  const releases = new RecoveryReleases({ journal: () => {} });
  const s = seams(options);
  const acts = recoveryActs({ releases, logReadable: () => options.logReadable ?? true, user: "owner", seams: s.made });
  return { acts, ...s };
}

test("P22/T70: admit lets in the waiting key only when the fingerprint the terminal showed is that key's, with origin recover", async () => {
  const { acts, calls, pending } = withSeams();
  expect(await acts({ act: "admit", pending: pending.id, fingerprint: "ZZ99-ZZ99" })).toEqual({ error: "The fingerprint does not match the waiting device" });
  expect(calls.filter((call) => call.startsWith("admit"))).toEqual([]);
  expect(await acts({ act: "admit", pending: pending.id, fingerprint: "AB12-CD34" })).toEqual({ admitted: "fedcba9876543210" });
  expect(calls.at(-1)).toBe(`admit ${pending.id} recover`);
});

test("P22: an admission the PC refuses (locked, strict, frozen) admits nobody", async () => {
  const { acts, pending } = withSeams({ admitted: false });
  expect(await acts({ act: "admit", pending: pending.id, fingerprint: "AB12-CD34" })).toEqual({ error: "This PC refused to admit the key (locked, frozen, or its log cannot be read)" });
});

test("T37/T69/T70: remove, lift and revoke-all go through this PC's own seams", async () => {
  const { acts, calls } = withSeams();
  expect(await acts({ act: "remove", targets: ["0123456789abcdef"] })).toEqual({ removed: ["0123456789abcdef"] });
  expect(await acts({ act: "lift", blocks: ["a".repeat(64)] })).toEqual({ lifted: ["a".repeat(64)] });
  expect(await acts({ act: "revoke_all" })).toEqual({ revoked: 2 });
  expect(calls).toEqual(["remove 0123456789abcdef owner", `lift ${"a".repeat(64)} false owner`, "revoke_all owner"]);
});

test("T69: lift reports earlier successes when a later ID is refused", async () => {
  const { acts, made } = withSeams();
  const first = "a".repeat(64);
  const unknown = `f:${"b".repeat(64)}`;
  made.appendLift = (id) => ({ outcome: id === first ? "applied" : "refused" });
  expect(await acts({ act: "lift", blocks: [first, unknown] })).toEqual({
    lifted: [first], error: `${unknown} was not lifted: refused`,
  });
});

test("P23: while the log cannot be read, every act that writes refuses, and list still answers", async () => {
  const { acts, calls, pending } = withSeams({ logReadable: false });
  for (const act of [{ act: "remove", targets: ["0123456789abcdef"] }, { act: "lift", blocks: ["a".repeat(64)] }, { act: "revoke_all" }, { act: "admit", pending: pending.id, fingerprint: "AB12-CD34" }]) {
    expect(await acts(act)).toEqual({ error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" });
  }
  expect(calls).toEqual([]);
  expect(await acts({ act: "list" })).toHaveProperty("rows");
});
