/**
 * Test support, never shipped: the part of IndexedDB the hosted shell uses (lib/relay/device.ts and
 * public/sw.js) and the account store (lib/account/store.ts): open with a version and an upgrade,
 * object stores keyed by `server_id` or by the key `put` names, and one
 * transaction's get, put, delete and clear, each answered asynchronously as a browser's is. Values are
 * structured-cloned in and out, so a test sees what a later reader would.
 */

type Row = { server_id: string };

export interface FakeIndexedDB {
  readonly factory: { open(name: string, version: number): unknown };
  /** a store's rows as they stand, keyed by server_id */
  rows(store: string): Map<string, unknown>;
  /** the version the database was last opened at */
  version(): number;
}

export function fakeIndexedDB(): FakeIndexedDB {
  const stores = new Map<string, Map<string, unknown>>();
  let current = 0;
  const later = (run: () => void): void => { queueMicrotask(run); };

  const transaction = () => {
    let pending = 0;
    let finished = false;
    const tx: { oncomplete: (() => void) | null; onabort: (() => void) | null; error: null; objectStore(name: string): unknown } = {
      oncomplete: null, onabort: null, error: null,
      objectStore(name: string) {
        const rows = stores.get(name);
        if (!rows) throw new DOMException(`no object store ${name}`, "NotFoundError");
        const request = <T>(answer: () => T) => {
          const req: { result?: T; onsuccess: (() => void) | null } = { onsuccess: null };
          pending += 1;
          later(() => { req.result = answer(); req.onsuccess?.(); pending -= 1; settle(); });
          return req;
        };
        return {
          get: (key: string) => request(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
          getAll: () => request(() => [...rows.values()].map((row) => structuredClone(row))),
          // an out-of-line key (the account store's `put(value, name)`), else the row's server_id
          put: (value: Row, key?: string) => request(() => { const id = key ?? value.server_id; rows.set(id, structuredClone(value)); return id; }),
          delete: (key: string) => request(() => { rows.delete(key); return undefined; }),
          clear: () => request(() => { rows.clear(); return undefined; }),
        };
      },
    };
    const settle = (): void => {
      later(() => {
        if (pending !== 0 || finished) return;
        finished = true;
        tx.oncomplete?.();
      });
    };
    settle();
    return tx;
  };

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => { stores.set(name, new Map()); },
    transaction,
    close: () => undefined,
  };

  return {
    factory: {
      open(_name: string, version: number) {
        const request: { result?: typeof db; error: null; onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null } = { error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        later(() => {
          request.result = db;
          if (version > current) {
            current = version;
            request.onupgradeneeded?.();
          }
          request.onsuccess?.();
        });
        return request;
      },
    },
    rows: (store) => stores.get(store) ?? new Map(),
    version: () => current,
  };
}
