/**
 * Returns to the top-level history entry beneath an overlay. A page in an iframe can add its own
 * history entries (including hash links), so a one-step `history.back()` may only move the frame.
 * Navigation API entries belong to this window and let the close action skip those frame entries.
 * Browsers without the Navigation API fall back to one history step (`steps` of them).
 */
interface NavigationApi {
  currentEntry?: { index: number } | null;
  entries(): Array<{ key: string }>;
  traverseTo(key: string): { committed: Promise<unknown> };
}

export function backUnderCurrentEntry(steps = 1): Promise<unknown> | undefined {
  const navigation = (window as unknown as { navigation?: NavigationApi }).navigation;
  const index = navigation?.currentEntry?.index ?? 0;
  const below = navigation?.entries()[index - steps];
  if (navigation === undefined || below === undefined) { window.history.go(-steps); return undefined; }
  return navigation.traverseTo(below.key).committed;
}
