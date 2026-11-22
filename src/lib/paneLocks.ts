/**
 * Pinned agent rows locked against a close from this app (#2432): the shared `lockedAgents` setting,
 * by pin key (lib/sidebarPins.ts), so every browser and the phone apps honour it. A lock holds only
 * while its row is pinned. It guards this app's own buttons only: herdr, the Herdr app or a script
 * still close the pane.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSettings } from "./settings.ts";
import { currentSidebarPins, sidebarPinKey, subscribeSidebarPins } from "./sidebarPins.ts";

export function lockedPinKeys(locks: readonly string[], pins: readonly string[], enabled = true): ReadonlySet<string> {
  if (!enabled) return new Set();
  const pinned = new Set(pins);
  return new Set(locks.filter((key) => pinned.has(key)));
}

export function toggleAgentLock(locks: readonly string[], pins: readonly string[], key: string): string[] {
  const pinned = new Set(pins);
  const kept = locks.filter((held) => held !== key && pinned.has(held));
  return !locks.includes(key) && pinned.has(key) ? [...kept, key] : kept;
}

/**
 * The locks after a pin of `key` is flipped (`pins` holds the pins after it): an unpin takes its lock with it, and a
 * fresh pin starts unlocked, so a lock that stayed behind (an unpin from a browser that had not heard of it yet,
 * #2977) does not come back with it.
 */
export function locksAfterPinToggle(locks: readonly string[], pins: readonly string[], key: string): string[] {
  const pinned = new Set(pins);
  return locks.filter((held) => held !== key && pinned.has(held));
}

export function usePaneLocked(machineId: string): (paneId: string) => boolean {
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const { settings } = useSettings();
  const locked = useMemo(() => lockedPinKeys(settings.lockedAgents, pins, settings.agentLocks), [settings.lockedAgents, pins, settings.agentLocks]);
  return useCallback((paneId: string) => locked.has(sidebarPinKey(machineId, paneId)), [locked, machineId]);
}
