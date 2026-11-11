/**
 * Deleting the account (docs/account.md, "Deleting the account"): the account service erases the
 * account and everything it keeps under it, and this device forgets the sign-in and its account key.
 * Nothing is revoked on a PC: its own device list decides who gets in (rule 1), so every pairing,
 * this device's included, stays until it is revoked on that PC, as one made by QR code stays.
 */
import { sameSignIn, type AccountService } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/**
 * `session` is the sign-in the person deleted from, read when they asked: only that account is
 * deleted, and a sign-in made meanwhile is neither deleted nor forgotten (SignedOutError).
 */
export async function deleteAccount(options: { service: AccountService; accountStore: AccountStore; session: AccountSession }): Promise<void> {
  await options.service.forSignIn(options.session).deleteAccount();
  // the sign-in, the key and the records were the deleted account's: a later sign-in gets a new key (a kept pairing
  // holds its own copy). A sign-in that took its place while the delete was out keeps all of it, the session included,
  // and a sign-in another tab began (its `pending` state) is no account's: it stays to finish.
  // No sign-in stored at all is the deleted one ended meanwhile (another tab's request refused once the account was gone):
  // its key and records are still the deleted account's, so they go too.
  await options.accountStore.clear(undefined, { only: (current) => current === undefined || sameSignIn(current, options.session), spare: ["pending"] });
}

/**
 * `store`, except that a sign-in is not stored through it: a sign-in again made to delete an account is held back
 * until installSignInAgain finds the deleted one still stored, so it never replaces a sign-out or another sign-in
 * made meanwhile.
 */
export function holdingSessionStore(store: AccountStore): AccountStore {
  return { ...store, set: (async (name, value) => { if (name !== "session") await store.set(name, value as never); }) as AccountStore["set"] };
}

/**
 * Stores `again` in the place of `from`, in one update, only while `from` is the sign-in stored and `stillOn` (the
 * delete it is for has not been called off), both asked inside that update; whether it did.
 */
export async function installSignInAgain(store: AccountStore, from: AccountSession, again: AccountSession, stillOn: () => boolean): Promise<boolean> {
  let installed = false;
  await store.update("session", (current) => {
    if (!stillOn() || current === undefined || !sameSignIn(current, from)) return current;
    installed = true;
    return again;
  });
  return installed;
}
