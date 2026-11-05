/** The subscriptions whose plan limits GET /api/usage can read from a CLI's own sign-in. */
export type UsageProviderId = "claude" | "codex" | "cursor" | "copilot" | "grok" | "antigravity" | "opencode";

/** One limit of a plan: how much of it is used and when it starts over. */
export interface UsageWindow {
  /** the span the limit counts over: a rolling session (5 hours), a day, a week or a billing month */
  readonly kind: "session" | "day" | "week" | "month";
  /** the model or quota a plan limits on its own ("Sonnet", "Premium"); null for the plan-wide limit */
  readonly scope: string | null;
  /** 0 to 100 */
  readonly used_percent: number;
  /** ISO 8601; null when the provider does not say */
  readonly resets_at: string | null;
  /** ISO 8601 time this window began counting; null when the provider states neither it nor the window's length */
  readonly starts_at: string | null;
}

/**
 * Why a provider's numbers are missing or old: its sign-in expired or was refused; the provider
 * asked to slow down; the request failed; the macOS keychain holding the sign-in could not be
 * read from this server's session.
 */
export type UsageProblem = "expired" | "rate_limited" | "failed" | "locked";

export interface ProviderUsage {
  readonly id: UsageProviderId;
  /**
   * One account of one provider, stable across reads: the provider and its account id, or, for a
   * sign-in that does not say whose it is, the provider and where it was found. A PC signed in to
   * two accounts of one provider lists both.
   */
  readonly key: string;
  /** whose plan this is, as its owner knows the account: an email, or a GitHub login; null when unknown */
  readonly account: string | null;
  /** the plan's name as the provider states it ("max", "pro"), when it does */
  readonly plan: string | null;
  /** the last numbers read; kept through a later failure, which `problem` then names */
  readonly windows: readonly UsageWindow[];
  readonly problem: UsageProblem | null;
  /** ISO 8601 time `windows` were read; null when they never were */
  readonly checked_at: string | null;
  /**
   * Claude refused a sign-in whose token has not expired (a 403, as a blocked network answers, not a
   * real expiry), and Claude's limits are not read from its status line on this PC yet: turning that
   * on (POST /api/usage/statusline) can stand in. Absent otherwise.
   */
  readonly statusline_offer?: true;
}

/** GET and POST /api/usage/statusline: whether Claude's limits are read from its status line on this PC. */
export interface StatuslineState {
  /** Claude Code's status line is wrapped (server/statusline-install.ts), and can be put back */
  readonly installed: boolean;
  /** false where the wrapper cannot run (Windows) */
  readonly supported: boolean;
}

/** GET /api/usage: only providers a CLI on this PC is signed in to are listed, once per account. */
export interface UsageReport {
  readonly providers: readonly ProviderUsage[];
  /**
   * Providers with no account found on this PC (a hub's accounts may still be listed) whose sign-in may be kept where this PC cannot look: the
   * command that reads it is not installed (Antigravity's Linux keyring item needs `secret-tool`).
   * Absent when there are none.
   */
  readonly missing_commands?: readonly MissingCommand[];
  /** Accounts this PC still lists that were removed from Ovis (POST /api/usage/accounts restores one). Absent when there are none. */
  readonly removed?: readonly ProviderUsage[];
}

export interface MissingCommand {
  readonly provider: UsageProviderId;
  readonly command: string;
}
