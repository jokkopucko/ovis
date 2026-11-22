import { describe, expect, test } from "bun:test";
import { exportAccountKey, newRecordId, signSafetyRecord } from "./account-records.ts";
import {
  AccountDevicesApiError, OVIS_ACCOUNT_OPENS_ALL, accountOpensAll, blockOutcome, parseBlockReceipt, parseHoldState, parseNoticeAnswer, parseRecoveryAction, type HoldState, type PcBlockOutcome,
} from "./account-devices-api.ts";

async function key() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

const [older, newer] = [await key(), await key()];
const at = "2026-11-05T01:02:03.456Z";
const paired = await key();
const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: newer.spki, target_no: 2, signer: older.spki, signer_no: 1, signed_at: at, nonce: newRecordId() }, older.pair.privateKey);

test.each([
  [undefined, true], ["0", false], ["1", true], ["", true], ["false", true],
  ["true", true], ["on", true], [" 1", true], [" 0", true],
] as const)("the PC Step 2 flag %j enables Step 2: %s", (value, enabled) => {
  const saved = process.env[OVIS_ACCOUNT_OPENS_ALL];
  if (value === undefined) delete process.env[OVIS_ACCOUNT_OPENS_ALL];
  else process.env[OVIS_ACCOUNT_OPENS_ALL] = value;
  try {
    expect(accountOpensAll()).toBe(enabled);
  } finally {
    if (saved === undefined) delete process.env[OVIS_ACCOUNT_OPENS_ALL];
    else process.env[OVIS_ACCOUNT_OPENS_ALL] = saved;
  }
});

describe("notice answers (device table T51, T57)", () => {
  test("It's me and Not me survive JSON", () => {
    const answers = [
      { type: "notice-answer", id: newRecordId(), answer: "its_me" },
      { type: "notice-answer", id: newRecordId(), answer: "not_me", blocks: [block] },
    ];
    for (const answer of answers) expect(parseNoticeAnswer(JSON.parse(JSON.stringify(answer)))).toEqual(answer as never);
  });

  test("Not me takes the app's own block, and a second only from the app's other key for the same target (P16)", async () => {
    const second = await signSafetyRecord({ ...block, signer: paired.spki, nonce: newRecordId() } as never, paired.pair.privateKey);
    const otherTarget = await signSafetyRecord({ ...block, target: paired.spki, target_no: 3, nonce: newRecordId() } as never, older.pair.privateKey);
    const sameSigner = await signSafetyRecord({ ...block, nonce: newRecordId() } as never, older.pair.privateKey);
    const answer = (blocks: unknown[]) => ({ type: "notice-answer", id: newRecordId(), answer: "not_me", blocks });
    const two = answer([block, second]);
    expect(parseNoticeAnswer(JSON.parse(JSON.stringify(two)))).toEqual(two as never);
    for (const blocks of [[block, sameSigner], [block, otherTarget], [block, second, sameSigner]]) expect(() => parseNoticeAnswer(answer(blocks))).toThrow(AccountDevicesApiError);
  });

  test("malformed answers are refused", () => {
    const id = newRecordId();
    const lift = { v: 1, kind: "lift", id: newRecordId(), account: "acct_1", target: block.id, signer: "pc", signed_at: at, forget: false, signature: "" };
    const bad: unknown[] = [
      null, { type: "notice-seen", id, answer: "its_me" }, { type: "notice-answer", id: "x", answer: "its_me" },
      { type: "notice-answer", id, answer: "its_me", blocks: [block] }, { type: "notice-answer", id, answer: "not_me" },
      { type: "notice-answer", id, answer: "not_me", blocks: [] }, { type: "notice-answer", id, answer: "not_me", blocks: [lift] },
      { type: "notice-answer", id, answer: "maybe" }, { type: "notice-answer", id, answer: "its_me", extra: 1 },
      { type: "notice-answer", id, answer: "not_me", blocks: [{ ...block, id: "c".repeat(64) }] }, { type: "notice-answer", id, answer: "not_me", blocks: [null] },
    ];
    for (const value of bad) expect(() => parseNoticeAnswer(value)).toThrow(AccountDevicesApiError);
  });
});

describe("block receipts (device table T51, T60)", () => {
  test("applied carries the log number and already_applied none", () => {
    const refusals = ["signer_not_older", "signer_not_member", "frozen", "unknown_target"].map((reason) => ({ outcome: "refused", id: block.id, reason }));
    for (const receipt of [{ outcome: "applied", id: block.id, n: 3 }, { outcome: "already_applied", id: block.id }, ...refusals]) {
      expect(parseBlockReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt as never);
    }
    const bad: unknown[] = [
      { outcome: "applied", id: block.id }, { outcome: "applied", id: block.id, n: 0 }, { outcome: "already_applied", id: block.id, n: 3 },
      { outcome: "unchanged", id: block.id }, { outcome: "applied", id: "a".repeat(32), n: 1 }, { outcome: "applied", id: block.id, n: 1, more: true },
      { outcome: "refused", id: block.id }, { outcome: "refused", id: block.id, reason: "older_device" }, { outcome: "refused", id: block.id, reason: "frozen", n: 1 },
      { outcome: "applied", id: block.id, n: 1, reason: "frozen" },
    ];
    for (const value of bad) expect(() => parseBlockReceipt(value)).toThrow(AccountDevicesApiError);
  });

  test("what the app shows for a PC is the PC's own receipt, so a refusal is never done (T60)", () => {
    const serverId = "0123456789abcdef0123456789abcdef";
    const receipts = [{ outcome: "applied", id: block.id, n: 3 }, { outcome: "already_applied", id: block.id }, { outcome: "refused", id: block.id, reason: "frozen" }] as const;
    expect(receipts.map((receipt) => blockOutcome(serverId, receipt).state)).toEqual(["applied", "already_applied", "refused"]);
    // @ts-expect-error an applied state never carries a refused receipt
    const wrong: PcBlockOutcome = { server_id: serverId, state: "applied", receipt: receipts[2] };
    expect(wrong.state).toBe("applied");
  });
});

test("a join hold has no deadline until its notice is durably published (P17, T34)", () => {
  const holds: HoldState[] = [{ reason: "join_hold", until: null }, { reason: "join_hold", until: at }];
  expect(holds.map((hold) => hold.reason === "join_hold" && hold.until)).toEqual([null, at]);
});

describe("recovery actions (device table R11)", () => {
  test("every act survives JSON", () => {
    const acts = [
      { act: "list" }, { act: "release", rows: ["0123456789abcdef"] }, { act: "undo", rows: null }, { act: "undo", rows: ["0123456789abcdef"] },
      { act: "remove", targets: [older.spki, "0123456789abcdef"] }, { act: "revoke_all" }, { act: "lift", blocks: [block.id] }, { act: "admit", pending: newRecordId(), fingerprint: "AB12-CD34" },
    ];
    for (const act of acts) expect(parseRecoveryAction(JSON.parse(JSON.stringify(act)))).toEqual(act as never);
  });

  test("malformed acts are refused", () => {
    const bad: unknown[] = [
      null, { act: "lock" }, { act: "unlock" }, { act: "list", rows: ["a"] }, { act: "release", rows: [] }, { act: "release" },
      { act: "release", rows: Array.from({ length: 65 }, (_, i) => `row${i}`) }, { act: "lift", blocks: ["a".repeat(32)] },
      { act: "admit", pending: "x" }, { act: "admit", pending: newRecordId() }, { act: "admit", pending: newRecordId(), fingerprint: "ab12-cd34" },
      { act: "admit", pending: newRecordId(), fingerprint: "AB12-CD34", extra: 1 }, { act: "revoke_all", targets: ["a"] }, { act: "remove", targets: ["../x"] },
      // R11, T70: a target is a row id or an account key, nothing in between
      { act: "remove", targets: ["a".repeat(121)] }, { act: "remove", targets: ["a".repeat(65)] }, { act: "remove", targets: ["not_a_row"] }, { act: "remove", targets: ["a".repeat(64)] }, { act: "release", rows: ["not_a_row"] }, { act: "undo", rows: ["ABCDEF0123456789"] },
    ];
    for (const value of bad) expect(() => parseRecoveryAction(value)).toThrow(AccountDevicesApiError);
  });
});

describe("hold states (device table S22, S25, T53, T56)", () => {
  test("S25: the three hold states parse back as sent, a join hold with or without its deadline", () => {
    const holds: HoldState[] = [
      { reason: "join_hold", until: null },
      { reason: "join_hold", until: "2026-11-20T05:00:10.000Z" },
      { reason: "catching_up" },
      { reason: "frozen", block: "a".repeat(64) },
    ];
    for (const hold of holds) expect(parseHoldState(JSON.parse(JSON.stringify(hold)))).toEqual(hold);
  });

  test("S25: anything else is refused", () => {
    for (const hold of [
      null, [], { reason: "join_hold" }, { reason: "join_hold", until: "soon" }, { reason: "join_hold", until: null, block: "a".repeat(64) },
      { reason: "catching_up", until: null }, { reason: "frozen", block: "a".repeat(63) }, { reason: "frozen" }, { reason: "expired" },
    ]) expect(() => parseHoldState(hold)).toThrow(AccountDevicesApiError);
  });
});
