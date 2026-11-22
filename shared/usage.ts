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

/** One-off resets of a plan's limits that the account can still use, as the provider lists them (Codex). */
export interface UsageResets {
  /** how many are left to use; sent only when at least one is */
  readonly available: number;
  /** ISO 8601 time the soonest of them expires; null when the provider does not say */
  readonly expires_at: string | null;
}

/**
 * Usage paid for beyond the plan's limits, as the provider states it. `spend`: money spent this
 * billing period, in `currency` (ISO 4217) and its major units, against a monthly `limit` (null when
 * uncapped; Claude's extra usage). `balance`: credits left to spend (Codex); `balance` is null when
 * the provider says only that there are some, and `unlimited` when they do not run out.
 */
export type UsageCredits =
  | { readonly kind: "spend"; readonly currency: string; readonly used: number | null; readonly limit: number | null; readonly used_percent: number | null }
  | { readonly kind: "balance"; readonly balance: number | null; readonly unlimited: boolean };

/**
 * Why a provider's numbers are missing or old: its sign-in expired or was refused; the provider
 * asked to slow down; the request failed; the macOS keychain holding the sign-in could not be
 * read from this server's session.
 */
export type UsageProblem = "expired" | "rate_limited" | "failed" | "locked";

/** A tool on the server's PC whose own record of an account's limits the server reads: Oh My Pi, Gajae Code. */
export type UsageRecorder = "omp" | "gjc";

/**
 * How long a tool may go without reading an account's limits before its record is one it has stopped updating. Either
 * tool reads again five minutes after its last read, give or take a quarter: this is three reads missed. The server
 * says so in `stale` with each report; a page ages the records of the report it holds against the same time.
 */
export const RECORDED_STALE_AFTER_MS: Readonly<Record<UsageRecorder, number>> = { omp: 15 * 60_000, gjc: 15 * 60_000 };

/**
 * Numbers the server did not read itself: another tool on its PC read them with that tool's own sign-in and kept
 * them in its store, and the server read that record. No sign-in of that tool is read and nothing is asked of the
 * provider for it, so the numbers are as old as that tool's last read.
 */
export interface UsageRecorded {
  readonly by: UsageRecorder;
  /** that tool has not read the limits for longer than it leaves between reads while it runs: they may have moved since */
  readonly stale: boolean;
  /**
   * Whether the server's PC also holds a sign-in of this account. True: `plan` and `problem` are that sign-in's, and
   * the record stands in for its numbers only. False: the account is known from the record alone.
   */
  readonly signed_in: boolean;
}

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
  /** limit resets left to use; absent when there are none. Kept through a later failure, like `windows` */
  readonly resets?: UsageResets;
  /** usage beyond the plan's limits; absent when the provider has none to show. Kept like `windows` */
  readonly credits?: UsageCredits;
  readonly problem: UsageProblem | null;
  /** ISO 8601 time `windows` were read; null when they never were */
  readonly checked_at: string | null;
  /**
   * Present when `windows` are another tool's record of this account's limits, read at `checked_at` by that tool, and
   * not a reading the server made with a sign-in of its own: `resets` and `credits`, no part of a record, are then absent.
   * Absent for every reading the server made itself.
   */
  readonly recorded?: UsageRecorded;
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
  /**
   * The PC's clock, which the times are on (ISO time). A page ages a record by it: the record's age as the PC saw it
   * (this less `checked_at`) plus the time gone by on the device, never the device's clock against the PC's.
   * Absent from an older server, for whose records the page has only its own clock to ask.
   */
  readonly server_time?: string;
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
