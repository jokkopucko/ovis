import { useEffect, useState } from "react";

import { shownOf, type EverywhereAsked, type Shown } from "./listLeave.ts";
import { pageAccountList } from "./pageList.ts";
import { ACCOUNT_SIGN_OUT_EVENT } from "./service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, type AccountProvider, type AccountSession } from "./store.ts";

/** A fresh own sign-in in `from`'s place, for the same account: the sign-in stored, or null when none was. */
export type FreshSignIn = (from: AccountSession, blocked: (link: string) => void) => Promise<AccountSession | null>;

/**
 * What this device leaving the account says: why it did not leave (`left` false), or the PCs that kept this device
 * after it left; no message once it left everywhere, or when the leave was called off.
 */
export interface LeaveOutcome {
  readonly left: boolean;
  readonly message: string | null;
}

/**
 * The mounted hosted shell's account actions (accountController): Sign out, this device leaving the account, and
 * Delete account, which answers why it did not delete (null once it did, or when the delete was called off), and Sign
 * out every device, which answers the same way.
 */
export interface ShellAccount {
  /** `shown`: the account (and its list and this device's key in it) the person signed out of, as the page showed it. */
  readonly signOut: (shown?: Shown) => void;
  /** `shown`: what the Disconnect question was drawn for. */
  readonly leave: (shown?: Shown) => Promise<LeaveOutcome>;
  readonly deleteAccount: () => Promise<string | null>;
  /** `asked`: on an account with a signed list, the other devices the question named, which leave the list first, and what it was drawn for. */
  readonly signOutEverywhere: (asked?: EverywhereAsked) => Promise<string | null>;
  /** a fresh own sign-in with `provider`, whose return comes back to the PC page that asked for it */
  readonly signInAgain?: (provider: AccountProvider) => void;
  /** the phone app's fresh own sign-in in place (accountController); a browser has none, it signs in by leaving the page */
  readonly freshSignIn?: FreshSignIn | undefined;
}

export interface HostedSignIn extends ShellAccount {
  readonly provider: AccountProvider;
  readonly account: string;
}

// null outside the hosted app or where it offers no account
let shellAccount: ShellAccount | null = null;

/** Kept by the hosted shell as it mounts: the PC page it opens acts on the account through the shell's own actions, nothing else. */
export function keepShellAccount(actions: ShellAccount | null): void {
  shellAccount = actions;
}

/** The hosted shell's account actions this page may use now, or null. */
export function shellAccountActions(): ShellAccount | null {
  return shellAccount;
}

/**
 * The hosted app's sign-in, on its start screen and on a PC page it opened (app.ovis.sh/pc/…), read again on every write
 * to the stored sign-in, on a sign-out and on focus (another tab's): null off the hosted app and while signed out. Its Sign out ends the hosted
 * sign-in alone, never the PC's account or this device's pairing, and keeps every unsent block (AccountService.signOut).
 */
export function useHostedSignIn(): HostedSignIn | null {
  const [signedIn, setSignedIn] = useState<{ readonly provider: AccountProvider; readonly account: string } | null>(null);
  const actions = shellAccountActions();
  useEffect(() => {
    if (actions === null) { setSignedIn(null); return; }
    let version = 0;
    const read = (): void => {
      const mine = ++version;
      // read, never written: AccountService.session() writes the stored sign-in, whose event would read it again
      indexedAccountStore.get("session").then((session) => { if (mine === version) setSignedIn(session === undefined ? null : { provider: session.provider, account: session.account }); }, (error: unknown) => {
        if (mine !== version) return;
        console.warn("Ovis: the hosted sign-in could not be read", error instanceof Error ? error.name : error);
        setSignedIn(null);
      });
    };
    read();
    for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.addEventListener(name, read);
    return () => {
      version++;
      for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.removeEventListener(name, read);
    };
  }, [actions]);
  // its Sign out names the account it shows, so a sign-in another tab stored meanwhile is not the one ended
  return actions === null || signedIn === null ? null : { ...actions, ...signedIn, signOut: () => actions.signOut(shownOf(pageAccountList(), signedIn.account)) };
}
