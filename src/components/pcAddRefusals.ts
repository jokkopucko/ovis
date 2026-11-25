/**
 * What a person is told when a PC was not added to the account: by the card of a PC that asks (UnconfirmedPcNotices)
 * and by the Add of a PC the account names that its list does not hold yet (AddPcByNumber).
 */
import type { AddPcOutcome, NumberRefusal } from "../lib/account/listAdd.ts";
import { LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import { AccountServiceError } from "../lib/account/service.ts";
import type { Translate } from "../lib/i18n.ts";

/** `signInAgain`: a fresh own sign-in may pass the refusal, so the card offers it. */
export type Problem = { readonly text: string; readonly signInAgain: boolean };

/** Why no number came for a PC, in the person's words. */
export function numberRefusal(t: Translate, why: NumberRefusal): string {
  switch (why) {
    case "silent": case "gone": return t("The PC did not answer. Start again on the PC.");
    case "spent": return t("Too many tries for this PC. Start again on the PC in a few minutes.");
    default: return t("The PC could not be added. Try again.");
  }
}

/** Why the list did not take a PC, or the account did not admit it. */
export function addRefusal(t: Translate, outcome: Extract<AddPcOutcome, { readonly added: false }>): Problem {
  // the account service's own word on the admission, as for an Add without a list
  if (outcome.why === "admit") return refusal(t, new AccountServiceError(403, outcome.code ?? "refused", ""));
  switch (outcome.why) {
    case "stopped": return { text: t("The account service cannot change the list right now."), signInAgain: false };
    case "clock": return { text: t("This device's clock looks wrong. Check its date and time, then try again."), signInAgain: false };
    case "blocked": return { text: t("This device cannot change your account's list right now."), signInAgain: false };
    case "unknown": return { text: t("The account service did not answer. Try again to check."), signInAgain: false };
    // a request signed for an earlier change still waits: that one's card is shown, to try it again or to cancel it
    case "waiting":
      if (typeof window !== "undefined") window.dispatchEvent(new Event(LIST_WRITE_WAITING_EVENT));
      return { text: t("An earlier change is still waiting: try it again or cancel it first."), signInAgain: false };
    case "behind": return { text: t("Update Ovis on this device, then try again."), signInAgain: false };
    // the invite the PC joined with is over, used or revoked: the PC starts again
    case "invite_ended": return { text: t("This request ran out. To add this PC, start again on the PC."), signInAgain: false };
    default: return { text: t("The PC could not be added. Try again."), signInAgain: false };
  }
}

/** The admit refusals about the sign-in alone (docs/account.md) say so, with Sign in again: a fresh own sign-in may pass them. */
export function refusal(t: Translate, error: Error): Problem {
  switch (error instanceof AccountServiceError ? error.code : null) {
    case "session_not_fresh": return { text: t("Sign in again to add it: your sign-in is more than ten minutes old."), signInAgain: true };
    case "own_sign_in_required": return { text: t("Sign in on this device to add it."), signInAgain: true };
    case "pc_add_cap": return { text: t("This account has added as many PCs as it can today. Try again later."), signInAgain: false };
    // an account service from before 2026-11-23 still asks a used account's admit for two-step, which signing in again does not give
    case "two_step_required": return { text: t("This account has no two-step sign-in to add it here. Add it with the number on the PC's screen."), signInAgain: false };
    default: return { text: t("The PC could not be added. Try again."), signInAgain: false };
  }
}
