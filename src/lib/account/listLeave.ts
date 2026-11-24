/**
 * This device's place in its account's signed list when it goes (docs/account-list.md, "Putting a member out"): a
 * device that signs out or leaves puts itself out of the list first, and a device the list shows out, by its own
 * act or another member's, forgets its account key and its copy of the list. Its key never comes back: signing in
 * again makes a new one, which a member allows anew.
 *
 * And the tidying a device of power `full` does by itself while it reads the list: what is over its time goes.
 */
import type { AccountList, AccountListView } from "./accountList.ts";
import { removeOtherDevices, removeSelf, scopeOf, tidyList, type RemoveOutcome, type WriteScope } from "./listRemoveDevice.ts";
import { sameSignIn } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/**
 * What a question was drawn for (the lead's X3, and dev13b's first finding): the account it named, and the list and
 * the member key this device was in it with as the page showed it (null where the page showed no list). A sign-out, a
 * leave or Sign out every device carries it from the press into the controller, and ends with nothing signed where the
 * sign-in, the list or the key is another by any later step.
 */
export interface Shown {
  readonly account: string;
  readonly scope: WriteScope | null;
}

/** What the page shows now for `account`: its list and this device's key in it, where the list it shows is that account's. */
export function shownOf(list: AccountList | null, account: string): Shown {
  const view = list?.view() ?? null;
  return { account, scope: view === null || view.account !== account ? null : scopeOf(view) };
}

/** Sign out every device's question as it was drawn: the other devices it named, and what it was drawn for. */
export interface EverywhereAsked {
  readonly confirmed: readonly string[];
  readonly shown: Shown;
}

const sameScope = (a: WriteScope, b: WriteScope): boolean => a.account === b.account && a.list === b.list && a.member === b.member;
const CHANGED: RemoveOutcome = { removed: false, why: "changed", retryAfterMs: null, placed: 0 };

/** Whether this device follows the account's list and is in it, as the view says. */
export function inList(view: AccountListView, account: string): boolean {
  return view.account === account && view.status.at === "following" && view.status.standing === "in";
}

/**
 * The view of `account`'s list that a sign-out or a leave goes by. A page that has not read its list yet, but whose
 * store keeps a copy of that account's list, reads it first (the lead's X6): such a device goes by its copy whether or
 * not the account service answers, and never takes the path of a device in no list. Null only where the store says
 * it keeps no copy; `unread` where the store did not answer, or the copy it keeps could not be read.
 */
async function viewFor(list: AccountList, account: string): Promise<AccountListView | null | "unread"> {
  const view = list.view();
  if (view.account === account && view.status.at === "following") return view;
  let follows: boolean;
  try { follows = await list.follows(account); } catch { return "unread"; }
  if (!follows) return null;
  const read = await list.sync().catch(() => list.view());
  return read.account === account ? read : "unread";
}

const UNREAD: RemoveOutcome = { removed: false, why: "unread", retryAfterMs: null, placed: 0 };

/**
 * A device that signs out of `account`, or leaves it, puts itself out of the account's list while its sign-in still
 * stands, as the key it is in the list with, in that list alone (the lead's X3). Null for a device that keeps no copy
 * of that account's list: nothing is asked of the list, and its sign-out is what it always was. A device the list
 * already shows out is out (`removed`). One whose copy cannot be written to says so (`no_list`).
 */
export async function leaveList(list: AccountList, account: string, options: { readonly wait?: (ms: number) => Promise<void>; readonly scope?: WriteScope | null } = {}): Promise<RemoveOutcome | null> {
  const view = await viewFor(list, account);
  if (view === null || view === "unread") return view === null ? null : UNREAD;
  if (view.status.at === "following" && view.status.standing === "out") return { removed: true };
  const scope = scopeOf(view);
  if (scope === null) return { removed: false, why: "no_list", retryAfterMs: null, placed: 0 };
  // the list or the key the question was drawn for is no longer the one this device is in by
  if (options.scope != null && !sameScope(options.scope, scope)) return CHANGED;
  return removeSelf(list, scope, options);
}

/** The keys of the devices other than this one that the page's list holds for `account`: what Sign out every device's question names. */
export function otherDevices(view: AccountListView, account: string): string[] {
  return inList(view, account) ? view.devices.filter((device) => !device.self).map((device) => device.key) : [];
}

/**
 * Sign out every device, on an account whose list this device is in: every other device the list holds leaves it
 * first, in one request with the epoch after it, since a device that is only signed out still holds a key that opens
 * the account's PCs. This device stays. `confirmed`: the devices the person's question named; a device it did not name
 * ends the removal with nothing signed (`unconfirmed`). Null for a device that keeps no copy of that account's list.
 */
export async function removeOthers(list: AccountList, account: string, confirmed: readonly string[], options: { readonly wait?: (ms: number) => Promise<void>; readonly scope?: WriteScope | null } = {}): Promise<RemoveOutcome | null> {
  const view = await viewFor(list, account);
  if (view === null || view === "unread") return view === null ? null : UNREAD;
  const scope = scopeOf(view);
  if (scope === null) return { removed: false, why: "no_list", retryAfterMs: null, placed: 0 };
  if (options.scope != null && !sameScope(options.scope, scope)) return CHANGED;
  return removeOtherDevices(list, scope, confirmed, options);
}

/**
 * Forgets what made this device a member of `session`'s account: its account key (and its encryption key with it),
 * the sign-in, and its copy of the list. Only while the store still holds that sign-in, or none, and the key the
 * device was a member with (`member`, where known), checked in the same transaction (the lead's X3): a sign-in and a
 * key that took their place since, and the copy that goes with them, stay. The copy goes only while it is pinned to
 * that key, compared in the transaction that drops it. A pairing this device made keeps its own copy of the key, as
 * it does at every sign-out.
 *
 * The device has one account key for every account it signs in to: where another account's saved copy still holds
 * it, the keys stay, and only this sign-in and this account's copy go. (The two are kept in two databases, so the
 * look at the other copies is made right before the keys would be cleared, not in that transaction.) Answers whether
 * anything was forgotten.
 */
export async function forgetMembership(accountStore: AccountStore, list: AccountList, session: AccountSession, member: string | null): Promise<boolean> {
  const departing = member ?? (await accountStore.key()).public_spki;
  // a copy that cannot be looked at may hold the key: it is kept
  const elsewhere = await list.pinnedElsewhere(session.account, departing).then((other) => other !== null, () => true);
  let mine = false;
  if (elsewhere) {
    await accountStore.update("session", (stored) => {
      mine = stored === undefined || sameSignIn(stored, session);
      return stored !== undefined && sameSignIn(stored, session) ? undefined : stored;
    });
  } else {
    await accountStore.clear((current) => !sameSignIn(current, session), {
      unsent: () => true,
      only: (stored, key) => (mine = (stored === undefined || sameSignIn(stored, session)) && (key === undefined || key.public_spki === departing)),
    });
  }
  if (mine) await list.forget(session.account, departing);
  return mine;
}

/**
 * Hears, once for each time it happens, that the list shows this device out of `account`: another member removed
 * it, or it removed itself on another page.
 */
export function watchRemoval(list: AccountList, onOut: (account: string) => void): () => void {
  let told: string | null = null;
  return list.subscribe((view) => {
    const out = view.account !== null && view.status.at === "following" && view.status.standing === "out" ? view.account : null;
    if (out === null) { told = null; return; }
    if (out === told) return;
    told = out;
    onOut(out);
  });
}

/**
 * Tidies the list after each read that reached the account service and finds this device in it (listRemoveDevice.ts,
 * tidyList): quietly, one round at a time, each key tried once by this page.
 */
export function tidyOnRead(list: AccountList): () => void {
  const tried = new Set<string>();
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const outcome = await tidyList(list, tried);
        if (outcome !== null && !outcome.removed) console.info(`Ovis: what is over its time stays in the account's list for now (${outcome.why})`);
      } while (again);
    } finally { running = false; }
  };
  return list.subscribe((view) => {
    if (!view.reached || view.account === null || !inList(view, view.account)) return;
    void run().catch((error: unknown) => console.warn("Ovis: the account's list was not tidied", error instanceof Error ? error.name : error));
  });
}
