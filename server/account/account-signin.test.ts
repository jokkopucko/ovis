import { describe, expect, test } from "bun:test";
import { accountSignInRefusal } from "./account-signin.ts";

describe("S2-25 how a PC refuses an account-joined sign-in (S25)", () => {
  test("S25: an app that knows the account codes reads held with its hold state, or not_listed", () => {
    expect(accountSignInRefusal({ refused: "join_hold", seconds: null }, null, true)).toEqual({ code: "held", message: "This device waits for its join hold on this PC", hold: { reason: "join_hold", until: null } });
    expect(accountSignInRefusal({ refused: "join_hold", seconds: 4 }, "2026-11-20T05:00:10.000Z", true)).toEqual({ code: "held", message: "This device waits for its join hold on this PC", hold: { reason: "join_hold", until: "2026-11-20T05:00:10.000Z" } });
    expect(accountSignInRefusal({ refused: "not_listed" }, null, true)).toEqual({ code: "not_listed", message: "This device is not on this PC's account list" });
    expect(accountSignInRefusal({ refused: "catching_up" }, null, true)).toEqual({ code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } });
    expect(accountSignInRefusal({ refused: "expired" }, null, true)).toEqual({ code: "not_listed", message: "This device is not on this PC's account list" });
    expect(accountSignInRefusal({ refused: "admission" }, null, true)).toEqual({ code: "admission", message: "This PC no longer admits this device" });
  });

  test("S25: an old-app hello gets today's code for the same refusal", () => {
    for (const answer of [{ refused: "join_hold", seconds: null } as const, { refused: "not_listed" } as const]) {
      expect(accountSignInRefusal(answer, null, false)).toEqual({ code: "auth_failed", message: "auth_failed" });
    }
  });
});
