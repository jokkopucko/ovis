/**
 * Returns to the top-level history entry beneath an overlay. A page in an iframe can add its own
 * history entries (including hash links), so a one-step `history.back()` may only move the frame.
 * Navigation API entries belong to this window and let the close action skip those frame entries.
 * Browsers without the Navigation API fall back to one history step (`steps` of them).
 */
import { sheetStep } from "./historyKeys.ts";

interface NavigationApi {
  currentEntry?: { index: number } | null;
  entries(): Array<{ key: string }>;
  traverseTo(key: string): { committed: Promise<unknown> };
}

export function backUnderCurrentEntry(steps = 1): Promise<unknown> | undefined {
  const by = steps + (sheetStep.goingBack(window.history.state) ? 1 : 0);
  const navigation = (window as unknown as { navigation?: NavigationApi }).navigation;
  const index = navigation?.currentEntry?.index ?? 0;
  const below = navigation?.entries()[index - by];
  if (navigation === undefined || below === undefined) { window.history.go(-by); return undefined; }
  const landed = navigation.traverseTo(below.key).committed;
  // a traversal the browser refuses lands nowhere: the sheets stop waiting for it
  landed.catch(() => sheetStep.dropped());
  return landed;
}
