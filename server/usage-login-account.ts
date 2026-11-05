import { homeSignIn, type CredentialHome, type UsageContext } from "./usage.ts";

/** The credential home a followed sign-in's CLI writes, as its environment points it there. */
export interface LoginTarget {
  readonly provider: "claude" | "codex";
  readonly home: CredentialHome;
}

/** The account a followed sign-in signed in, as the list keys and names it; never a token or a path. */
export interface LoginAccount {
  readonly key: string;
  readonly label: string | null;
}

/**
 * What the login's home holds before its CLI starts: the digests of every token its sources hold (none
 * when it holds no sign-in), undefined when it could not be read (locked, unreadable: then no end of this
 * login can be told from what was there, and none is counted as signed in).
 */
export async function homeBefore(ctx: UsageContext, target: LoginTarget): Promise<readonly string[] | undefined> {
  try {
    const found = await homeSignIn(ctx, target.provider, target.home);
    return found === "unknown" ? undefined : found?.digests ?? [];
  } catch {
    // never put a credential reader's contents in an error
    console.warn("Could not read a credential home before its sign-in");
    return undefined;
  }
}

/**
 * The account a CLI that exited 0 signed in: its own home now holds a usable sign-in it wrote, a token none
 * of the home's sources held before it started (one only moved from its keychain to its file is not new). An exit code alone proves nothing (a CLI can exit 0 having signed
 * nothing in), nor does a sign-in that was there already or one written in another home.
 */
export async function loginAccount(ctx: UsageContext, target: LoginTarget, before: readonly string[] | undefined): Promise<LoginAccount | null> {
  if (before === undefined) return null;
  const after = await homeSignIn(ctx, target.provider, target.home);
  if (after === null || after === "unknown" || before.includes(after.digest) || (after.expiresAt !== null && after.expiresAt <= ctx.now())) return null;
  return { key: after.key, label: after.label };
}
