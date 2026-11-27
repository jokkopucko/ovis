/**
 * What this device keeps of its accounts' signed lists (docs/account-list.md, "On a device"), by account: its
 * verified copy of the list, the wraps of the epoch keys it was given, a genesis it signed and has not seen placed,
 * what its copy and the account service's answers differed in, when the account service last said that it
 * keeps no list for the account, the entries 0 it signed and gave up, the place in a list that a member who let
 * this device in handed it, when it last read its copy in full, when it first held the entry of each PC that is new
 * to it, and for an account that was in use (listMigrate.ts) the birth it signed and has not seen placed, the last final
 * refusal of one, a carried device's hand-over and its check of the list against its PCs, and the one-time notice of
 * the move. In an IndexedDB database of its own,
 * `ovis-account-list`: `ovis-account` (store.ts) stays at its one version, which a page of an older build still
 * opens, and a copy can grow to megabytes beside records that are read on every request.
 *
 * Nothing here is a key. The device's two private keys are CryptoKeys that cannot be exported and live in
 * `ovis-account`; an epoch key is never stored, only its wrap, which that device's own key opens again.
 *
 * Every record is read back as `unknown`: whoever owns it reads it strictly and reports what is not in its form.
 */

export const LIST_RECORDS = ["copy", "wraps", "genesis", "shadow", "asked", "dropped", "offer", "times", "seen", "sent", "birth", "handover", "notice", "joined"] as const;
export type ListRecord = (typeof LIST_RECORDS)[number];

/** Each call is one transaction. */
export interface ListStore {
  get(record: ListRecord, account: string): Promise<unknown>;
  set(record: ListRecord, account: string, value: unknown): Promise<void>;
  /**
   * Writes `value` only where what is stored is still `expected` (a text, or undefined for nothing), read and written
   * in the one transaction; false, with nothing written, where another page wrote meanwhile. This is what keeps one
   * page's save from going over another's, with Web Locks or without them.
   */
  swap(record: ListRecord, account: string, expected: string | undefined, value: string): Promise<boolean>;
  /**
   * Forgets everything kept for the account, in one transaction. `copy`: only where the stored copy is still that
   * text, so what goes is what the caller read; false, with nothing forgotten, where it is another.
   */
  drop(account: string, copy?: string): Promise<boolean>;
  /** The accounts this device keeps a copy of a list for. */
  accounts(): Promise<string[]>;
}

/** Runs `work` alone among this origin's pages for one account's list (Web Locks), where the browser has them. */
export type ListLock = <T>(account: string, work: () => Promise<T>) => Promise<T>;

export const listLock: ListLock = (account, work) => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(`ovis-account-list:${account}`, work) : work();
};

export function memoryListLock(): ListLock {
  const tails = new Map<string, Promise<unknown>>();
  return (account, work) => {
    const run = (tails.get(account) ?? Promise.resolve()).then(work, work);
    tails.set(account, run.catch(() => undefined));
    return run;
  };
}

const nameOf = (record: ListRecord, account: string): string => `${record}:${account}`;
const accountsOf = (names: Iterable<unknown>): string[] => [...names].flatMap((name) => (typeof name === "string" && name.startsWith("copy:") ? [name.slice("copy:".length)] : []));

/** What IndexedDB does with a value: a copy that shares nothing with the one handed over. */
export function memoryListStore(): ListStore {
  const records = new Map<string, unknown>();
  return {
    async get(record, account) { return structuredClone(records.get(nameOf(record, account))); },
    async set(record, account, value) {
      if (value === undefined) records.delete(nameOf(record, account));
      else records.set(nameOf(record, account), structuredClone(value));
    },
    async swap(record, account, expected, value) {
      if (records.get(nameOf(record, account)) !== expected) return false;
      records.set(nameOf(record, account), value);
      return true;
    },
    async drop(account, copy) {
      if (copy !== undefined && records.get(nameOf("copy", account)) !== copy) return false;
      for (const record of LIST_RECORDS) records.delete(nameOf(record, account));
      return true;
    },
    async accounts() { return accountsOf(records.keys()); },
  };
}

const DATABASE = "ovis-account-list";
const STORE = "list";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const indexedListStore: ListStore = {
  get(record, account) {
    return transact("readonly", (store) => {
      const request = store.get(nameOf(record, account));
      return () => request.result as unknown;
    });
  },
  set(record, account, value) {
    return transact("readwrite", (store) => {
      if (value === undefined) store.delete(nameOf(record, account));
      else store.put(value, nameOf(record, account));
      return () => undefined;
    });
  },
  swap(record, account, expected, value) {
    return transact("readwrite", (store) => {
      let swapped = false;
      const held = store.get(nameOf(record, account));
      held.onsuccess = () => {
        if (held.result !== expected) return;
        store.put(value, nameOf(record, account));
        swapped = true;
      };
      return () => swapped;
    });
  },
  drop(account, copy) {
    return transact("readwrite", (store) => {
      let dropped = false;
      const forget = (): void => { for (const record of LIST_RECORDS) store.delete(nameOf(record, account)); dropped = true; };
      if (copy === undefined) forget();
      else {
        const held = store.get(nameOf("copy", account));
        held.onsuccess = () => { if (held.result === copy) forget(); };
      }
      return () => dropped;
    });
  },
  accounts() {
    return transact("readonly", (store) => {
      const request = store.getAllKeys();
      return () => accountsOf(request.result);
    });
  },
};
