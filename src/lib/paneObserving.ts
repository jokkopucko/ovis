import { useSyncExternalStore } from "react";

/**
 * Whether this page can only watch a pane right now (herdr's observer, the server's "watch":
 * another window types in it), by `paneStorageId`. Each mounted PaneTerminal of the pane (a split
 * may mount it twice, on two connections) reports its own connection's role, and the pane counts
 * as watched only while every mount watches it: a note waits for a composer, which a mount that
 * types still shows. What opens outside the pane (a diff's line notes, #1603) reads it.
 */
export class PaneObserving {
  private mounts = new Map<string, Map<symbol, boolean>>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** whether a mount of the pane has reported its role: until then nothing is known of it */
  known = (key: string): boolean => (this.mounts.get(key)?.size ?? 0) > 0;
  has = (key: string): boolean => {
    const roles = this.mounts.get(key);
    return roles !== undefined && roles.size > 0 && [...roles.values()].every(Boolean);
  };
  /** `mount`'s role for `key`; null when it unmounts or moves to another pane */
  set(key: string, mount: symbol, observing: boolean | null): void {
    const before = `${this.known(key)}:${this.has(key)}`;
    const roles = this.mounts.get(key) ?? new Map<symbol, boolean>();
    if (observing === null) roles.delete(mount);
    else roles.set(mount, observing);
    if (roles.size === 0) this.mounts.delete(key);
    else this.mounts.set(key, roles);
    if (`${this.known(key)}:${this.has(key)}` !== before) for (const listener of this.listeners) listener();
  }
}

/**
 * The role a mount reports, or null while its connection has not said (connecting, or gone): only
 * an acknowledged observe watches, and only an attach ready for input types.
 */
export function mountRole({ observing, inputReady }: { observing: boolean; inputReady: boolean }): boolean | null {
  return observing ? true : inputReady ? false : null;
}

export const paneObserving = new PaneObserving();

/** "unknown" while no mount of the pane has reported (fail closed), else whether this page only watches it */
export function usePaneObserving(key: string | null): "unknown" | "watching" | "typing" {
  return useSyncExternalStore(paneObserving.subscribe, () => key === null || !paneObserving.known(key) ? "unknown" : paneObserving.has(key) ? "watching" : "typing");
}
