import { describe, expect, it } from "bun:test";
import type { DeviceNotice } from "../../../shared/account-devices-api.ts";
import { noticeSeen, withNoticeReplay } from "../deviceNotices.ts";
import { holdWaitMs, itsMeAnswer } from "./joinHold.ts";

const NOW = Date.parse("2026-11-20T04:00:00.000Z");
const ID = "c".repeat(32);

describe("the ten-second wait", () => {
  it("T53: follows the PC's own deadline, never a timer the app starts", () => {
    expect(holdWaitMs({ reason: "join_hold", until: "2026-11-20T04:00:07.500Z" }, NOW)).toBe(7_500);
    expect(holdWaitMs({ reason: "join_hold", until: "2026-11-20T03:59:59.000Z" }, NOW)).toBe(0);
  });

  it("T53: a hold that is not the join hold has no countdown", () => {
    expect(holdWaitMs({ reason: "catching_up" }, NOW)).toBeNull();
    expect(holdWaitMs({ reason: "frozen", block: "d".repeat(64) }, NOW)).toBeNull();
  });

  it("P17: a join hold whose notice is not yet published has no countdown yet", () => {
    expect(holdWaitMs({ reason: "join_hold", until: null }, NOW)).toBeNull();
  });

  it("T67: a PC that sends no hold has no wait", () => {
    expect(holdWaitMs(undefined, NOW)).toBe(0);
  });
});

describe("It's me", () => {
  const admit: DeviceNotice = { seq: 3, id: ID, at: "2026-11-20T04:00:00.000Z", kind: "admit", how: "list", key: "k".repeat(43), no: 5, row: "r1", label: "New phone", by: null, account: "acct", open: true, method: "github", two_step: "set" };

  it("T57: answering is its own message and leaves the seen acknowledgment as it was", () => {
    const shown = withNoticeReplay(undefined, { notices: [admit], cut: 0 });
    expect(itsMeAnswer(admit)).toEqual({ type: "notice-answer", id: ID, answer: "its_me" });
    expect(noticeSeen(shown, 3)).toEqual({ type: "notice-seen", seq: 3 });
  });

});
