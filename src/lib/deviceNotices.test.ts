import { describe, expect, it } from "bun:test";
import type { DeviceNotice, NoticeKind } from "../../shared/account-devices-api.ts";
import { noticeSeen, withNoticeAcked, withNoticeDecided, withNoticeReplay } from "./deviceNotices.ts";

const notice = (seq: number, kind: NoticeKind = "admit", open = kind === "admit"): DeviceNotice => ({
  seq, id: seq.toString(16).padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind, how: "list", key: "k".repeat(43), no: seq + 1,
  row: `row-${seq}`, label: `Device ${seq}`, by: null, account: "acct", open, method: "github", two_step: "set",
});

describe("device notices from one PC", () => {
  it("T57: a reconnect that replays notices already shown adds each once, in journal order", () => {
    const first = withNoticeReplay(undefined, { notices: [notice(2), notice(1, "method")], cut: 0 });
    expect(first.notices.map((item) => item.seq)).toEqual([1, 2]);
    const again = withNoticeReplay(first, { notices: [notice(2), notice(3, "drop")], cut: 0 });
    expect(again.notices.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("T57: the acknowledgment names the newest notice shown and decides nothing", () => {
    const shown = withNoticeReplay(undefined, { notices: [notice(4), notice(5, "method")], cut: 0 });
    expect(noticeSeen(shown, 5)).toEqual({ type: "notice-seen", seq: 5 });
    const acked = withNoticeAcked(shown, 5);
    expect(noticeSeen(acked, 5)).toBeNull();
    expect(acked.notices.filter((item) => item.open).map((item) => item.seq)).toEqual([4]);
  });

  it("T57: an undecided admission stays answerable after a later replay leaves it out and its row is gone", () => {
    const shown = withNoticeAcked(withNoticeReplay(undefined, { notices: [notice(7)], cut: 0 }), 7);
    const later = withNoticeReplay(shown, { notices: [{ ...notice(8, "drop"), row: null }], cut: 0 });
    expect(later.notices.find((item) => item.seq === 7)?.open).toBe(true);
    expect(withNoticeDecided(later, notice(7).id).notices.map((item) => item.seq)).toEqual([8]);
  });

  it("P15: keeps how many notices the PC trimmed before this device saw them", () => {
    expect(withNoticeReplay(undefined, { notices: [notice(40)], cut: 12 }).cut).toBe(12);
  });
});
