import { useState, type ReactNode } from "react";

import { shellAccountActions, type FreshSignIn } from "../lib/account/hostedSignIn.ts";
import { pageListPc, pageListUnread, readPageList } from "../lib/account/listPcs.ts";
import { removeListPc } from "../lib/account/listRemove.ts";
import { writeScope, type WriteScope, LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { forgetSeenPc } from "../lib/account/seenPcs.ts";
import { AccountServiceError, listingChanged, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { useSignInAgainHere } from "./AccountSection.tsx";

/** PCR-1: the account service removes a PC only for this device's own sign-in made in the last ten minutes. */
type Refusal = "reauth_required" | "own_sign_in_required";

const refusalOf = (error: unknown): Refusal | null =>
  error instanceof AccountServiceError && (error.code === "reauth_required" || error.code === "own_sign_in_required") ? error.code : null;

/** The list did not take the removal of a PC (listWrite.ts, WriteRefusal): the PC is in the account as before. */
export class ListPcRemovalError extends Error {
  constructor(readonly why: string) {
    super(`The PC was not removed from the account's list (${why})`);
    this.name = "ListPcRemovalError";
  }
}

/** What to say of a removal that failed: what the list said where that tells the person more, the surface's own words otherwise. */
export function pcRemovalFailure(error: unknown, t: ReturnType<typeof useT>, otherwise: string): string {
  if (!(error instanceof ListPcRemovalError)) return otherwise;
  if (error.why === "stopped") return t("The account service cannot change the list right now.");
  // a request signed for an earlier change still waits: that one is tried again or cancelled first, on its own card
  if (error.why === "waiting") return t("An earlier change is still waiting: try it again or cancel it first.");
  if (error.why === "not_following") return t("This device cannot use your account's list right now, so the PC was not removed. Try again in a moment.");
  return otherwise;
}

type Asked = {
  readonly session: AccountSession;
  readonly serverId: string;
  readonly listingId: string | undefined;
  readonly refusal: Refusal;
  readonly step: "offered" | "signing-in" | "failed";
  readonly link: string | null;
};

/**
 * What a Remove is bound to from the press that asks its question: the row of this device's list it was pressed on.
 * The relay key the list holds for the PC, and the account, the list and this device's member key then.
 */
export interface HeldRemoval { readonly scope: WriteScope; readonly endpoint: string }

/** The list row a Remove of this PC is for, read now; null for a PC that no list of this device holds (it leaves by the account service). */
export function heldRemoval(account: string, serverId: string): HeldRemoval | null {
  const list = pageAccountList();
  const endpoint = list === null ? null : pageListPc(account, serverId);
  const view = list?.view();
  if (list === null || endpoint === null || view === undefined || view.status.at !== "following") return null;
  return { endpoint, scope: { account, list: view.status.list, key: writeScope(list)?.key } };
}

/**
 * A PC's removal from the account. `remove` removes it as `session` and then tells `removed`; when the service wants a
 * fresh own sign-in first it resolves false, and `prompt` says so with Sign in again. That press signs in again in place
 * (the desktop app, the PC's own window, the phone app) and removes the same PC with the fresh sign-in: the removal was
 * already asked for. Where the page signs in only by leaving (the hosted app in a browser), Sign in again leaves, and the
 * PC is removed by a press after the return. A removal naming the listing its card showed (`listingId`, account#67) that
 * the service refuses as `listing_changed` removed nothing and is no failure: it resolves false and the account's PCs are
 * read again, so the card shows what is there now. Any other failure throws.
 *
 * A PC that this device's list of the account holds leaves by an entry of that list, which this device signs
 * (listRemove.ts): the account service removes nothing for it, and asks for no sign-in.
 */
export function usePcRemoval(service: Pick<AccountService, "forSignIn">, removed: (serverId: string, how: "list" | "directory") => void | Promise<void>): {
  /**
   * `held`: what the question was asked for (heldRemoval), where one was asked first; absent, the row is read at the
   * press. `byList`: the row the question was asked on was drawn as one the list holds: it leaves by the list or not at
   * all, never by the account service's directory (ListPcRemovalError `not_following` where no list row is found now).
   */
  readonly remove: (session: AccountSession, serverId: string, listingId?: string, held?: HeldRemoval | null, byList?: boolean) => Promise<boolean>;
  readonly prompt: ReactNode;
  /** the PC \`prompt\` speaks of, for a surface that draws one row per PC; null with no prompt */
  readonly promptFor: string | null;
} {
  const t = useT();
  const here = useSignInAgainHere();
  const [asked, setAsked] = useState<Asked | null>(null);
  const shell = shellAccountActions();
  const fresh: FreshSignIn | undefined = shell !== null ? shell.freshSignIn
    : here === undefined ? undefined : (from, blocked) => here(from, { signal: new AbortController().signal, wanted: () => true, blocked });
  const leaving = shell?.signInAgain;

  const remove = async (session: AccountSession, serverId: string, listingId?: string, held?: HeldRemoval | null, byList = false): Promise<boolean> => {
    setAsked(null);
    // A device that holds a copy of its account's list goes by it also on a page that has not read it yet: the read
    // is waited for. Where none ends, nothing is removed: not by an entry it cannot sign on, and never by the account
    // service's directory, which would leave the PC in the list and show it as gone.
    await readPageList(session.account);
    if (pageListUnread(session.account)) throw new ListPcRemovalError("blocked");
    const list = pageAccountList();
    // the row the question was asked for; where the page had not read its list then, the row as that read shows it
    const bound = held ?? heldRemoval(session.account, serverId);
    if (list !== null && bound !== null) {
      // For the account, the list, the member key and the relay key of the row the person pressed: another tab's
      // sign-in changes none of them under it, and a PC that another member put out meanwhile is found out already.
      // Nothing of it goes to the account service's directory.
      if (bound.scope.account !== session.account) throw new ListPcRemovalError("changed");
      const outcome = await removeListPc(list, bound.endpoint, { expect: bound.scope });
      if (!outcome.removed && outcome.why === "waiting") window.dispatchEvent(new Event(LIST_WRITE_WAITING_EVENT));
      if (!outcome.removed) throw new ListPcRemovalError(outcome.why);
      await removed(serverId, "list");
      return true;
    }
    // the list holds this PC as far as the row said, and this device no longer goes by it: the directory would drop the
    // PC from the account's PCs and leave it in the list, which the question said it leaves
    if (byList) throw new ListPcRemovalError("not_following");
    try { await service.forSignIn(session).deletePc(serverId, listingId); }
    catch (error) {
      if (listingChanged(error)) { window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT)); return false; }
      const refusal = refusalOf(error);
      if (refusal === null) throw error;
      setAsked({ session, serverId, listingId, refusal, step: "offered", link: null });
      return false;
    }
    // the person took the PC out of the account here: this device's own record of it goes too
    void forgetSeenPc(session.account, serverId).catch(() => undefined);
    await removed(serverId, "directory");
    return true;
  };

  const signInAgain = (shown: Asked): void => {
    if (fresh === undefined) { leaving?.(shown.session.provider); return; }
    setAsked({ ...shown, step: "signing-in" });
    const still = (now: Asked | null): boolean => now?.session === shown.session && now.serverId === shown.serverId;
    fresh(shown.session, (link) => setAsked((now) => still(now) ? { ...now!, link } : now)).then(async (again) => {
      if (again === null) { setAsked((now) => still(now) ? { ...shown, step: "failed" } : now); return; }
      await remove(again, shown.serverId, shown.listingId);
    }).catch((error: unknown) => {
      console.warn("Ovis: the PC was not removed after signing in again", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      setAsked((now) => still(now) || now === null ? { ...shown, step: "failed" } : now);
    });
  };

  const offers = asked !== null && (fresh !== undefined || leaving !== undefined);
  const prompt = asked === null ? null : (
    <span className="pc-removal-sign-in" data-pc-removal={asked.serverId}>
      <span className="account-error" role="alert">
        {asked.step === "failed" ? t("The PC could not be removed. Try again.")
          : asked.step === "signing-in" ? t("Finish signing in in your browser.")
          : asked.refusal === "reauth_required" ? t("Sign in again to remove it: your sign-in is more than ten minutes old.")
          : t("Sign in on this device to remove it.")}
      </span>
      {offers && asked.step !== "signing-in" && <button type="button" className="btn" onClick={() => signInAgain(asked)}>{t("Sign in again")}</button>}
      {asked.step === "signing-in" && asked.link !== null && <ExternalLink kind="sign-in" className="btn" href={asked.link}>{t("Open the sign-in page")}</ExternalLink>}
    </span>
  );
  return { remove, prompt, promptFor: asked?.serverId ?? null };
}
