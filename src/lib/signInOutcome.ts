import type { UsageLoginPrompt } from "../../shared/usage-login.ts";

/**
 * How a browser-followed sign-in came out once its CLI exited, from the provider's sign-ins on the PC
 * before and after (GET /api/usage/login?provider=: local files only, nothing sent to the provider).
 * A new sign-in is a success that names it; signing in again keeps the same name, so its end only
 * says it finished (the account's state comes with the next usage read); anything else did not sign in.
 */
export type SignInOutcome =
  | { kind: "signed-in"; account: string | null }
  | { kind: "finished" }
  | { kind: "not-signed-in" };

/**
 * How a followed sign-in came out, as the server that ran it says: whether its CLI signed in its own home,
 * and to which account. Only a server too old to say is judged from the sign-ins before and after, which
 * can name another home's account.
 */
export function followedOutcome(ended: Pick<UsageLoginPrompt, "succeeded" | "account">, before: readonly (string | null)[], after: readonly (string | null)[], again: boolean): SignInOutcome {
  if (ended.succeeded === undefined) return signInOutcome(before, after, again);
  return ended.succeeded ? { kind: "signed-in", account: ended.account ?? null } : { kind: "not-signed-in" };
}

export function signInOutcome(before: readonly (string | null)[], after: readonly (string | null)[], again: boolean): SignInOutcome {
  const known = new Set(before.map((account) => account ?? ""));
  const added = after.find((account) => !known.has(account ?? ""));
  if (added !== undefined) return { kind: "signed-in", account: added };
  if (after.length > before.length) return { kind: "signed-in", account: null };
  return again && after.length > 0 ? { kind: "finished" } : { kind: "not-signed-in" };
}
