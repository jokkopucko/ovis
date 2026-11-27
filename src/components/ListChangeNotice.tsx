/**
 * The card of a change to the account's signed list that did not go through: a device a PC let in that the list did
 * not take (AccountApprovals.tsx), or a change whose signed request still waits at this device's head (listWrite.ts).
 * It is drawn inside an opened PC and on the start screen alike, so it brings its own styles and nothing of the app.
 */
import "./AccountApprovalPrompt.css";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { sameWaiting, type WaitingRequest } from "../lib/account/accountList.ts";
import type { AllowRefusal } from "../lib/account/listAllow.ts";
import { LIST_WRITE_WAITING_EVENT, resendWaiting } from "../lib/account/listWrite.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

/** The card of a change that waits and that this page did not make: one at a time, under this name. */
export const WAITING = "waiting";

/** A device this PC let in that the account's signed list did not take: who it is (`key`, its account key), why, and what trying again does. */
export interface Stalled {
  readonly key: string; readonly device: string; readonly pc: string; readonly why: AllowRefusal; readonly retryAfterMs?: number | null; readonly retry: () => Promise<void>;
  /** The PC let the device in by a pairing of its own: false on a PC that lets devices in by the list alone, which made none. */
  readonly pairedAtPc: boolean;
  /** The list took the device, and what stopped is what was to follow its entry: it is in the list, whatever else is said. */
  readonly placed?: boolean;
  /**
   * A request signed for it still waits at this device's head: Cancel lets it go, so that another change can be made.
   * It throws where nothing was let go (the log could not be read): the card then stays.
   */
  readonly cancel?: () => Promise<void>;
}

/** `kept` with what is said of the device `key` now: its card where it stood, a new one after the others, or none (`next` null: let in, or closed). */
export function keepStalled(kept: readonly Stalled[], key: string, next: Stalled | null): readonly Stalled[] {
  const at = kept.findIndex((each) => each.key === key);
  if (next === null) return at < 0 ? kept : kept.filter((each) => each.key !== key);
  return at < 0 ? [...kept, next] : kept.map((each) => (each.key === key ? next : each));
}

/** What the person is told, by why the list did not take the device. */
export function stalledReason(t: ReturnType<typeof useT>, why: AllowRefusal, retryAfterMs: number | null = null): string {
  switch (why) {
    // the request went out and no answer came: whether the list took the device is read from the list, by Try again
    case "unknown": return t("The account service did not answer. Try again to check.");
    case "clock": return t("This device's clock looks wrong. Check its date and time, then try again.");
    case "blocked": return t("This device cannot change your account's list right now.");
    case "behind": return t("Update Ovis on this device, then try again.");
    case "waiting": return t("It was not confirmed by your account yet. Try it again, or cancel it.");
    case "changed": return t("The sign-in on this device changed since you approved it. Sign in to that account again, then try again.");
    case "not_claimed": return t("Update Ovis on that device and sign in there, then try again.");
    case "removed": return t("That device was removed from your account. Sign in again on it first.");
    case "stopped": return t("The account service cannot change the list right now.");
    // the wait the account service named: a budget that opens again within the hour, or one that takes longer
    case "budget": return retryAfterMs !== null && retryAfterMs > 60 * 60_000 ? t("Too many devices were added. Try again tomorrow.") : t("Too many devices were added just now. Try again in a few minutes.");
    default: return t("It could not be added to your account. Try again.");
  }
}

/** The card for a device that was let in at this PC and not into the account: Try again signs it into the list again; Close leaves it paired with this PC alone. */
export function ListAllowNotice({ stalled, onClose }: { stalled: Stalled; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Back closes it, as Close does, unless a try is under way
  usePhoneSheetBack(() => { if (busy) return false; onClose(); });
  const retry = async (): Promise<void> => {
    setBusy(true);
    // what the list answers is drawn by whoever owns this card; anything else leaves the card as it is, to try again
    try { await stalled.retry(); }
    catch (error) { console.warn("Ovis: the device was not added to the account", error instanceof Error ? error.name : error); }
    finally { setBusy(false); }
  };
  // "added to this PC only" is said only when it is known: after an answer that never came, it is not, and a PC that
  // lets devices in by the list made no pairing for the device at all
  const title = stalled.why === "waiting" ? t("An earlier change is still waiting")
    : stalled.why === "unknown" ? t("Not known yet: is {device} in your account?", { device: stalled.device })
    : stalled.placed === true ? t("{device} was added to your account's list", { device: stalled.device })
    : stalled.pairedAtPc ? t("{device} was added to {pc} only", { device: stalled.device, pc: stalled.pc }) : t("{device} is not in your account", { device: stalled.device });
  const cancel = async (): Promise<void> => {
    setBusy(true);
    try { await stalled.cancel?.(); onClose(); }
    catch (error) { console.warn("Ovis: the change that waits was not cancelled", error instanceof Error ? error.name : error); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-scrim">
      <div className="modal account-approval" role="alertdialog" aria-modal="true" aria-label={title} data-testid="list-allow-notice" data-why={stalled.why}>
        <h2 className="account-approval-title">{title}</h2>
        <p className="account-approval-error" role="alert">{stalledReason(t, stalled.why, stalled.retryAfterMs ?? null)}</p>
        <div className="account-approval-actions">
          {stalled.cancel === undefined
            ? <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Close")}</button>
            : <button type="button" className="btn" disabled={busy} onClick={() => void cancel()}>{t("Cancel")}</button>}
          {stalled.why !== "removed" && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retry()}>{t("Try again")}</button>}
        </div>
      </div>
    </div>
  );
}

/**
 * The card of a change that waits and that this page did not make (it was made before a reload, or on another page):
 * put up when another change was refused for it (LIST_WRITE_WAITING_EVENT). It is the card of the very request that
 * waited then: Try again sends that request and Cancel lets that request go, and neither touches one that took its
 * place since.
 */
export function useWaitingChange(): { readonly stalled: Stalled | null; readonly close: () => void } {
  const [shown, setShown] = useState<WaitingRequest | null>(null);
  useEffect(() => {
    let live = true;
    const heard = (): void => {
      const list = pageAccountList();
      if (list === null) return;
      void list.waiting().then((request) => { if (live && request !== null) setShown((now) => (sameWaiting(now, request) ? now : request)); },
        (error: unknown) => { console.warn("Ovis: the change that waits could not be read", error instanceof Error ? error.name : error); });
    };
    window.addEventListener(LIST_WRITE_WAITING_EVENT, heard);
    return () => { live = false; window.removeEventListener(LIST_WRITE_WAITING_EVENT, heard); };
  }, []);
  if (shown === null) return { stalled: null, close: () => {} };
  const close = (): void => setShown((now) => (now === shown ? null : now));
  return { close, stalled: waitingCard(shown, close) };
}

/** Cancel could not read the log: whether the request was placed is not known, so nothing was let go. */
export class NotReadError extends Error {
  constructor() {
    super("The account's list could not be read, so nothing was cancelled");
    this.name = "NotReadError";
  }
}

/** The card for `request`, a request that waits: what its two buttons do, to that request alone. */
export function waitingCard(request: WaitingRequest, done: () => void): Stalled {
  return {
    key: WAITING, device: "", pc: "", pairedAtPc: false, why: "waiting",
    retry: async () => { const list = pageAccountList(); if (list === null || await resendWaiting(list, request)) done(); },
    cancel: async () => { if (await pageAccountList()?.cancel(request) === "unread") throw new NotReadError(); },
  };
}

/** The waiting change's card where nothing else draws it: the start screen. */
export function ListWaitingNotice() {
  const { stalled, close } = useWaitingChange();
  return stalled === null ? null : createPortal(<ListAllowNotice stalled={stalled} onClose={close} />, document.body);
}
