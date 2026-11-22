import { useEffect, useState } from "react";

import { ACCOUNT_SIGN_OUT_EVENT } from "./service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, type AccountProvider } from "./store.ts";

export interface HostedSignIn {
  readonly provider: AccountProvider;
  readonly signOut: () => void;
}

// the mounted hosted shell's Sign out (accountController.signOut), null outside the hosted app or where it offers no account
let shellSignOut: (() => void) | null = null;

/** Kept by the hosted shell as it mounts: the PC page it opens signs out through the overview's own action, nothing else. */
export function keepShellSignOut(signOut: (() => void) | null): void {
  shellSignOut = signOut;
}

/**
 * The hosted app's sign-in on a PC page it opened (app.ovis.sh/pc/…), read again on every write to the stored sign-in,
 * on a sign-out and on focus (another tab's): null on any other page and while signed out. Its Sign out ends the hosted
 * sign-in alone, never the PC's account or this device's pairing, and keeps every unsent block (AccountService.signOut).
 */
export function useHostedSignIn(): HostedSignIn | null {
  const [provider, setProvider] = useState<AccountProvider | null>(null);
  const signOut = shellSignOut;
  useEffect(() => {
    if (signOut === null) { setProvider(null); return; }
    let version = 0;
    const read = (): void => {
      const mine = ++version;
      // read, never written: AccountService.session() writes the stored sign-in, whose event would read it again
      indexedAccountStore.get("session").then((session) => { if (mine === version) setProvider(session?.provider ?? null); }, (error: unknown) => {
        if (mine !== version) return;
        console.warn("Ovis: the hosted sign-in could not be read", error instanceof Error ? error.name : error);
        setProvider(null);
      });
    };
    read();
    for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.addEventListener(name, read);
    return () => {
      version++;
      for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT, "focus"]) window.removeEventListener(name, read);
    };
  }, [signOut]);
  return signOut === null || provider === null ? null : { provider, signOut };
}
