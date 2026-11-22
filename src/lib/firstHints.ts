export const FIRST_HINTS_KEY = "ovis:first-hints";

type HintsStorage = Pick<Storage, "getItem" | "setItem">;

export function hintsPending(storage: HintsStorage): boolean {
  try { return storage.getItem(FIRST_HINTS_KEY) === "pending"; } catch { return false; }
}

export function armHints(storage: HintsStorage): void {
  try { if (storage.getItem(FIRST_HINTS_KEY) === null) storage.setItem(FIRST_HINTS_KEY, "pending"); } catch { /* private mode: no hints */ }
}

export function finishHints(storage: HintsStorage): void {
  try { storage.setItem(FIRST_HINTS_KEY, "done"); } catch { /* private mode */ }
}

export const SETUP_ROW_KEY = "ovis:setup-row";

export function setupRowState(storage: Pick<Storage, "getItem">): "on" | "hidden" | null {
  try { const value = storage.getItem(SETUP_ROW_KEY); return value === "on" || value === "hidden" ? value : null; } catch { return null; }
}

export function setupRowOn(storage: HintsStorage): void {
  try { if (storage.getItem(SETUP_ROW_KEY) === null) storage.setItem(SETUP_ROW_KEY, "on"); } catch { /* private mode: no row */ }
}

export function hideSetupRow(storage: HintsStorage): void {
  try { storage.setItem(SETUP_ROW_KEY, "hidden"); } catch { /* private mode: hidden for this page */ }
}

/** This browser's storage, or null where it is blocked: reading `window.localStorage` itself throws there (Safari with cookies blocked, a sandboxed frame). */
export function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * This browser's user pressed Continue on the setup guide's agent step: only then may the guide read the plan usage, and
 * turn it on ("1"). Once usage is on, "on": the guide reads it only while it stays on, and only once the server's
 * shared settings were read (`known`), so usage turned off on another device while this browser was closed is not read
 * again from this browser's stale copy.
 */
export const USAGE_ARMED_KEY = "ovis:setup-usage-armed";

export function usageReadAllowed(armed: string | null, showUsage: boolean, known: boolean): boolean {
  return armed === "1" || (armed === "on" && showUsage && known);
}
