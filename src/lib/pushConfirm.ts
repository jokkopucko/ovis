/**
 * Kept for where the PC cannot say (the open LAN signs in as no device and gets no delivery record, an older server
 * has no record at all): the setup guide's rule then reads it (lib/setupGuideFlow.ts alertsHere).
 */
import { ApiError } from "./api.ts";
import { browserStorage } from "./firstHints.ts";

export const PUSH_CONFIRM_KEY = "ovis:push-confirmed";

type ConfirmStorage = Pick<Storage, "getItem" | "setItem">;

export function recordConfirmation(endpoint: string, sent: boolean, storage: ConfirmStorage | null = browserStorage()): void {
  try { storage?.setItem(PUSH_CONFIRM_KEY, JSON.stringify({ endpoint, sent })); } catch {}
}

/** what `/api/push/test` itself answers when it could not push (server/push.ts): the push service refused or retired the subscription, or the PC does not hold it */
const COULD_NOT_PUSH = new Set(["push_failed", "subscription_gone", "subscription_not_found"]);

/**
 * A Send test that failed is kept only when the push route answered that it could not push. Anything else (the
 * network, a restart or a proxy in between, a lapsed sign-in, a watching device, the PC's catch-all 500, which any
 * route can answer before the push is tried) says nothing of delivery, and an earlier result stays.
 */
export function recordTestFailure(endpoint: string, error: unknown, storage: ConfirmStorage | null = browserStorage()): void {
  if (error instanceof ApiError && error.code !== null && COULD_NOT_PUSH.has(error.code)) recordConfirmation(endpoint, false, storage);
}

export function confirmation(endpoint: string | null, storage: ConfirmStorage | null = browserStorage()): boolean | null {
  if (endpoint === null || storage === null) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(PUSH_CONFIRM_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { endpoint: kept, sent } = value as { endpoint?: unknown; sent?: unknown };
    return kept === endpoint && typeof sent === "boolean" ? sent : null;
  } catch { return null; }
}
