import { useCallback, useEffect, useState } from "react";

export function readDismissedList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writeDismissedList(key: string, dismissed: readonly string[]): void {
  try {
    if (dismissed.length) window.localStorage.setItem(key, JSON.stringify(dismissed));
    else window.localStorage.removeItem(key);
  } catch {}
}

/**
 * Persists per-scope notice dismissals in localStorage.
 * - `value === undefined`: status not known yet; leaves stored entries alone.
 * - `value === null`: condition cleared; removes any stored dismissal for `scope`.
 * - `value` (string): keeps only the matching `${scope} ${value}` dismissal for `scope`.
 */
export function useScopedDismissal(key: string, scope: string, value: string | null | undefined): { dismissed: boolean; dismiss: () => void } {
  const entry = value != null ? `${scope} ${value}` : null;
  const [dismissed, setDismissed] = useState(() => readDismissedList(key));
  useEffect(() => {
    if (value === undefined) return;
    const stored = readDismissedList(key);
    const kept = stored.filter((item) => !item.startsWith(`${scope} `) || (entry !== null && item === entry));
    if (kept.length !== stored.length) writeDismissedList(key, kept);
    setDismissed(kept);
  }, [key, scope, value, entry]);
  const dismiss = useCallback(() => {
    if (entry === null) return;
    const next = [...readDismissedList(key).filter((item) => item !== entry), entry];
    setDismissed(next);
    writeDismissedList(key, next);
  }, [key, entry]);
  return { dismissed: entry !== null && dismissed.includes(entry), dismiss };
}
