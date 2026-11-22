/**
 * How this PC refuses an account-joined sign-in (Step 2, S25). The three account codes go only to an app whose hello
 * named `account-opens-all/1` on a PC with OVIS_ACCOUNT_OPENS_ALL on; an app that predates them reads a code it does
 * not know as a protocol error, so it gets today's `auth_failed` for the same refusal.
 */
import type { HoldState } from "../../shared/account-devices-api.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import type { AccessAnswer } from "./account-devices.ts";

export interface SignInRefusal {
  readonly code: SessionError;
  readonly message: string;
  readonly hold?: HoldState;
}

export function accountSignInRefusal(answer: Exclude<AccessAnswer, { ok: true }>, holdUntil: string | null, knowsAccountCodes: boolean): SignInRefusal {
  if (!knowsAccountCodes) return { code: "auth_failed", message: "auth_failed" };
  switch (answer.refused) {
    case "catching_up": return { code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } };
    case "join_hold": return { code: "held", message: "This device waits for its join hold on this PC", hold: { reason: "join_hold", until: holdUntil } };
    case "catching_up": return { code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } };
    case "expired":
    case "not_listed": return { code: "not_listed", message: "This device is not on this PC's account list" };
    case "admission": return { code: "admission", message: "This PC no longer admits this device" };
  }
}
