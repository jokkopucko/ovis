import type { UsageProviderId } from "./protocol.ts";

export type LocalUsageProvider = Exclude<UsageProviderId, "antigravity">;

/** Local account sign-in never accepts a command or a credential path from the browser. A Claude or Codex
 * request with `follow: true` runs in the server's own PTY for the browser to follow (UsageLoginFollowed). */
export type UsageLoginRequest =
  | { readonly provider: "claude" | "codex"; readonly name: string; readonly follow?: true }
  | { readonly provider: Exclude<LocalUsageProvider, "claude" | "codex">; readonly replace?: true }
  /** Signs in again to an account GET /api/usage lists, by its key: the server finds its credential home. */
  | { readonly provider: "claude" | "codex"; readonly account: string; readonly follow?: true }
  /** A first sign-in in the CLI's own home, the one its plain command reads; `replace` once the PC has a sign-in. */
  | { readonly provider: "claude" | "codex"; readonly default: true; readonly replace?: true; readonly follow?: true };

/** Local PATH and credential discovery only, never a provider usage request or a credential. */
export interface UsageLoginProvider {
  readonly id: UsageProviderId;
  readonly cli: string;
  readonly installed: boolean;
  readonly local: boolean;
  readonly separate_home: boolean;
}

export interface UsageLoginAccounts {
  readonly accounts: readonly (string | null)[];
}

/** DELETE /api/usage/accounts removes a listed account from Ovis, POST restores a removed one: never revokes or deletes CLI credentials. */
export interface UsageAccountRemoval {
  readonly account: string;
}

/** What a login pane asks of its user, read from its screen: never a token, only what the CLI shows to type or open. */
export interface UsageLoginPromptText {
  /** the sign-in page to open, on the provider's own host; null until the CLI prints it */
  readonly url: string | null;
  /** the one-time code to enter on that page (Codex's device code) */
  readonly user_code: string | null;
  /** the CLI waits for the code the page shows to be pasted back (Claude Code) */
  readonly wants_code: boolean;
}

/** GET /api/usage/login/prompt?login=: a sign-in the browser follows, as its CLI's screen shows it. */
export interface UsageLoginPrompt extends UsageLoginPromptText {
  readonly provider: "claude" | "codex";
  /** the CLI has exited */
  readonly ended: boolean;
  /**
   * Present once ended: the CLI exited 0 and wrote a usable sign-in in its own credential home, one other
   * than the one there before it started. Absent from an older server, whose end only the accounts tell.
   */
  readonly succeeded?: boolean;
  /** Present once ended: the account that sign-in is to, as GET /api/usage/login?provider= names it; null when it names none */
  readonly account?: string | null;
}

/** POST /api/usage/login/code: the code a sign-in page showed, typed into that login's CLI. */
export interface UsageLoginCode {
  readonly login: string;
  readonly code: string;
}

/** POST /api/usage/login with `follow: true`: the sign-in runs in the server's own PTY, reached by this id alone. */
export interface UsageLoginFollowed {
  readonly login_id: string;
  readonly device_auth: boolean;
}

export interface UsageLoginStarted {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly manual: boolean;
  readonly device_auth: boolean;
}
