import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The limits Claude Code hands its status line, kept by the wrapper that
 * server/statusline-install.ts installs when the user turns it on in Settings. Read here instead of asking
 * Anthropic: these are the numbers Claude's own line draws from, they need no token, and they
 * never leave the machine — the usage endpoint answers
 * 403 from some networks, where this file still holds the numbers.
 *
 * The capture keeps only these fields (as Claude Code 2.1.308 writes them), and adds
 * `_herdr.account`, the account of the CLI that drew it:
 *   rate_limits.five_hour  { used_percentage, resets_at }   resets_at in epoch SECONDS
 *   rate_limits.seven_day  { used_percentage, resets_at }
 */
export interface StatuslinePayload {
  /** when the file was last written: the status line renders on activity, so an idle pane's is old */
  readAt: number;
  /** Captured from the rendering CLI's config; absent in older or unidentifiable captures. */
  account: { id: string; label: string | null } | null;
  /** null when the payload names none */
  fiveHour: StatuslineWindow | null;
  sevenDay: StatuslineWindow | null;
}

export interface StatuslineWindow {
  usedPercent: number;
  /** ISO time, from the payload's epoch seconds; null when it names none */
  resetsAt: string | null;
}

/**
 * A payload older than this is not a reading: the five-hour window has turned over, so its number
 * describes a window that is gone. The file survives a sleeping laptop, so its age is checked.
 */
export const STALE_MS = 6 * 60 * 60_000;

export const statuslinePath = (home: string): string => join(home, ".herdr", "statusline-last.json");

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const percent = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);

function window(value: unknown): StatuslineWindow | null {
  const found = record(value);
  const used = percent(found["used_percentage"]);
  if (used === null) return null;
  const resets = found["resets_at"];
  const resetsAt = typeof resets === "number" && Number.isFinite(resets) && resets > 0 ? new Date(resets * 1000).toISOString() : null;
  return { usedPercent: used, resetsAt };
}

export function parseStatusline(payload: unknown, readAt: number): StatuslinePayload | null {
  const body = record(payload);
  const limits = record(body["rate_limits"]);
  const fiveHour = window(limits["five_hour"]);
  const sevenDay = window(limits["seven_day"]);
  const account = record(record(body["_herdr"])["account"]);
  const accountId = text(account["id"]);
  // a payload with nothing this reader shows is not a reading (an older Claude Code, a stub)
  if (fiveHour === null && sevenDay === null) return null;
  return { account: accountId === null ? null : { id: accountId, label: text(account["label"]) }, readAt, fiveHour, sevenDay };
}

/** The newest payload under `home`, with reset windows removed even while the file is fresh. */
export function readStatusline(home: string, now: number = Date.now()): StatuslinePayload | null {
  const path = statuslinePath(home);
  try {
    const stat = statSync(path);
    if (now - stat.mtimeMs > STALE_MS) return null;
    const payload = parseStatusline(JSON.parse(readFileSync(path, "utf8")), stat.mtimeMs);
    if (payload === null) return null;
    if (payload.fiveHour && payload.fiveHour.resetsAt !== null && Date.parse(payload.fiveHour.resetsAt) <= now) payload.fiveHour = null;
    if (payload.sevenDay && payload.sevenDay.resetsAt !== null && Date.parse(payload.sevenDay.resetsAt) <= now) payload.sevenDay = null;
    return payload;
  } catch {
    return null;
  }
}

/** The exact context limit for one Claude session and model, even below 200k tokens.
 * Usage remains the transcript's input/cache total. No subscription or account is required. */
export function readStatuslineContext(home: string, sessionId: string, model: string | null, now = Date.now()): number | null {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId) || model === null) return null;
  const path = join(home, ".herdr", "statusline-context", sessionId + ".json");
  try {
    const stat = statSync(path);
    if (stat.size > 4096 || now - stat.mtimeMs > STALE_MS || stat.mtimeMs - now > 60_000) return null;
    const body = record(JSON.parse(readFileSync(path, "utf8")));
    const capacity = body["window"];
    return body["session_id"] === sessionId && body["model"] === model
      && typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null;
  } catch { return null; }
}
