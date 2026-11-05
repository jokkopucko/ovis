/**
 * Browser storage keys were `herdr-web-ui:*` before the rename to `ovis:*`. Imported by main.tsx
 * ahead of every module that reads storage, so settings, drafts and queued messages are under
 * their new keys before anything reads them. The old key goes in the same step: kept, it would bring back a draft or a queue
 * the app has since cleared under the new key.
 */

const LEGACY_PREFIX = "herdr-web-ui:";
const PREFIX = "ovis:";

export function adoptLegacyStorage(storage: Storage): void {
  const legacy: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
  }
  for (const key of legacy) {
    const value = storage.getItem(key);
    // removed first: the copy then fits even in a store near its quota
    storage.removeItem(key);
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
  }
}

export function adoptLegacyStores(stores: { localStorage: Storage | null; sessionStorage: Storage | null }): void {
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      // null in a WebView with DOM storage turned off
      const storage = stores[area];
      if (storage) adoptLegacyStorage(storage);
    } catch (error) {
      // storage blocked (a private window, a site setting) has nothing to move
      if (!(error instanceof DOMException)) throw error;
    }
  }
}

adoptLegacyStores(window);
