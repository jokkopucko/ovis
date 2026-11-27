/**
 * This client's account state (docs/account.md, rule 2): its one account key, made by WebCrypto as
 * non-extractable, its sign-in with the account service, and a sign-in on its way through the
 * provider's pages. In an IndexedDB database of its own, `ovis-account`: the shell's `ovis-relay`
 * (relay/device.ts) is shared with the service worker at a fixed version, and the worker never
 * opens this one.
 */
import { exportAccountKey } from "../../../shared/account-records.ts";
import type { UnsentBlocks } from "./unsentBlocks.ts";
import type { AddRecord, RemoveRecord } from "../../../shared/account-records.ts";
import type { MemberEncryptionKey } from "../../../shared/account-list-seal.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";

export interface AccountKey {
  readonly private_key: CryptoKey;
  /** P-256 SPKI, base64url: the device's `relay_public_key` on every PC of the account */
  readonly public_spki: string;
}

export const ACCOUNT_PROVIDERS = ["github", "google", "apple"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
export type EmailHintProvider = Exclude<AccountProvider, "apple">;

export interface AccountSession {
  readonly service: string;
  readonly account: string;
  readonly provider: AccountProvider;
  readonly access_token: string;
  readonly refresh_token: string;
  /** when the access token runs out, in ms since the epoch */
  readonly expires_at: number;
  /** which sign-in this is, kept by every refresh: random for one made by this build (sessionOf), a digest of the saved refresh token for one saved before sign-ins had an id (service.ts, session) */
  readonly sign_in_id?: string;
  /** The local sign-out generation a newly issued session may be installed under. */
  readonly sign_in_generation?: string;
  /** when this sign-in was made, in ms by this device's clock (sessionOf), kept by every refresh; absent from one saved before it was kept */
  readonly signed_in_at?: number;
}

/** The sign-in a redirect link belongs to, without any credentials. */
export interface LinkSignIn {
  readonly account: string;
  readonly sign_in_id: string;
  readonly fromHint?: true;
}

export interface ResumeAdd {
  readonly account: string;
  readonly provider: AccountProvider;
}

/** A sign-in sent to the provider's pages: what its return must match (OAuth `state`) and prove (PKCE verifier). */
export interface PendingSignIn {
  readonly service: string;
  readonly provider: AccountProvider;
  readonly state: string;
  readonly verifier: string;
  readonly redirect_uri: string;
  readonly started_at: number;
  readonly generation?: string;
  readonly link?: LinkSignIn;
  /** The Add which asked for a new sign-in; only a return for this account may continue it. */
  readonly resume_add?: ResumeAdd;
  readonly create?: "ask";
  /** Add this method only after this connect sign-in succeeds. */
  readonly then_add?: EmailHintProvider;
  readonly connect_epoch?: string;
  /** the marked pairing this sign-in was started for (relay/shell.tsx): it goes with the sign-in, whatever its end */
  readonly pairing?: PendingPairing;
  /**
   * the PC whose own page started this sign-in (its relay ID; relay/shell.tsx): a browser's sign-in comes back on the
   * front page alone, which goes on to that page once this very sign-in succeeded
   */
  readonly pc?: string;
  /** the account whose sign-out of every device asked for this sign-in again: its return signs them out, for that account only */
  readonly sign_out_everywhere?: string;
}

/** A scanned offer waiting on a sign-in; `at`: when the code was scanned, which bounds how long it is tried. */
export interface PendingPairing {
  readonly offer: RelayOffer;
  readonly at: number;
}

interface Records {
  key: AccountKey;
  /**
   * The key this device opens its lists' epoch keys with (account/listKeys.ts): made on first need and kept as the
   * CryptoKey it is, which cannot be exported. Beside `key`, so that it is forgotten with it: a device with a new
   * account key is a new member, which names a key of its own.
   */
  enc_key: MemberEncryptionKey;
  session: AccountSession;
  generation: string;
  /** An empty sign-in slot reserved by Connect. Every actual change to `session` drops it. */
  connect_epoch: string;
  /** by `state`, so a return consumes only its own sign-in and two tabs can each have one */
  pending: Readonly<Record<string, PendingSignIn>>;
  /** by record id: an `add` this device signed that some PCs' mailboxes have not taken yet (account/join.ts) */
  adds: Readonly<Record<string, QueuedAdd>>;
  /**
   * By key: the latest record this device signed for a device of the account, an `add` for one it
   * approved itself (docs/account.md, rule 6) or a `remove` for one it removed: what it hands a PC it
   * brings into the account (account/join.ts, enrollPc)
   */
  devices: Readonly<Record<string, AddRecord | RemoveRecord>>;
  /**
   * By record id: other members' signed `remove`s that a PC of the account listed and this device
   * checked (account/join.ts, keepRemovals), kept verbatim to relay to a PC it brings into the account
   */
  removals: Readonly<Record<string, RemoveRecord>>;
  enrolls: Readonly<Record<string, PlannedEnroll>>;
  /**
   * By leave id: the account key a leave of this device started for (account/leave.ts). It outlives
   * the leave, so a link that read that key earlier never goes out; a leave that failed takes its own back.
   */
  leaving: Readonly<Record<string, string>>;
  /** by link id: the PC a link of this device's account key may be on its way to, read by a leave's snapshot */
  linking: Readonly<Record<string, string>>;
  /** the key this sign-in registered with the account service (account/signInKey.ts) and its place in the account's order */
  signin_key: SignInKey;
  /** by the ids of the records: Not me's signed blocks the account service has not confirmed (account/unsentBlocks.ts) */
  unsent_blocks: Readonly<Record<string, UnsentBlocks>>;
  /**
   * By account: every key a Not me of this device signed a block against, whatever the service answered, which the
   * account's move never carries into its list (R-F; listMigrate.ts ownRemovals). It outlives a sign-out, as `leaving` does.
   */
  own_blocks: Readonly<Record<string, readonly string[]>>;
}

export interface SignInKey {
  readonly account: string;
  readonly sign_in_id: string;
  readonly key: AccountKey;
  /** its place in the account's order; null while the service has not confirmed the registration */
  readonly no: number | null;
}

export interface PlannedEnroll {
  readonly account: string;
  readonly done: readonly string[];
  /** keys an earlier, unfinished attempt let in, to be introduced once the enrollment ends */
  readonly admitted?: readonly string[];
  readonly introduce?: { readonly keys: readonly string[]; readonly pc: { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string }; readonly to: readonly string[] };
}

export interface QueuedAdd {
  readonly account: string;
  readonly record: AddRecord;
  readonly to: readonly string[];
}
type Name = keyof Records;
type Many<N extends Exclude<Name, "key">> = { [K in N]?: Records[K] };

/** Each read and write is one transaction; `key` is made at most once, between tabs too. */
export interface AccountStore {
  key(): Promise<AccountKey>;
  get<N extends Exclude<Name, "key">>(name: N): Promise<Records[N] | undefined>;
  set<N extends Exclude<Name, "key">>(name: N, value: Records[N] | undefined): Promise<void>;
  /** Reads and writes `name` in one transaction; `change` runs synchronously inside it. */
  update<N extends Exclude<Name, "key">>(name: N, change: (current: Records[N] | undefined) => Records[N] | undefined): Promise<void>;
  updateMany<N extends Exclude<Name, "key">>(names: readonly N[], change: (current: Many<N>) => Many<N>): Promise<void>;
  /**
   * Forgets the key, the sign-in and every record but `leaving` and `own_blocks`, in one transaction: a new key is made
   * on next use, which no PC knows. A sign-in `keep` accepts stays with its generation. With `only`,
   * nothing is cleared unless it accepts the sign-in and the key stored then (read in the same transaction); the records
   * `spare` names stay as `leaving` does, and so do the unsent blocks `unsent` accepts (another sign-in's, S32-1).
   */
  clear(keep?: (session: AccountSession) => boolean, options?: { readonly only?: (session: AccountSession | undefined, key: AccountKey | undefined) => boolean; readonly spare?: readonly Exclude<Name, "key" | "session">[]; readonly unsent?: (entry: UnsentBlocks) => boolean }): Promise<void>;
}

function keptUnsent(current: Records["unsent_blocks"] | undefined, accept: ((entry: UnsentBlocks) => boolean) | undefined): Records["unsent_blocks"] | undefined {
  if (current === undefined || accept === undefined) return undefined;
  const kept = Object.fromEntries(Object.entries(current).filter(([, entry]) => accept(entry)));
  return Object.keys(kept).length === 0 ? undefined : kept;
}

export async function newKey(): Promise<AccountKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_spki: await exportAccountKey(pair.publicKey) };
}

export function memoryAccountStore(): AccountStore {
  const records = new Map<Name, Records[Name]>();
  let making: Promise<AccountKey> | null = null;
  return {
    key() {
      const saved = records.get("key") as AccountKey | undefined;
      if (saved) return Promise.resolve(saved);
      making ??= newKey().then((key) => { records.set("key", key); making = null; return key; });
      return making;
    },
    async get(name) { return records.get(name) as never; },
    async set(name, value) {
      if (name === "session") records.delete("connect_epoch");
      if (value === undefined) records.delete(name); else records.set(name, value);
    },
    async update(name, change) {
      const current = records.get(name);
      const next = change(current as never);
      if (name === "session" && next !== current) records.delete("connect_epoch");
      if (next === undefined) records.delete(name); else records.set(name, next);
    },
    async updateMany(names, change) {
      const next = change(Object.fromEntries(names.map((name) => [name, records.get(name)])) as never) as Record<string, Records[Name] | undefined>;
      const sessionChanged = names.some((name) => name === "session" && next.session !== records.get(name));
      for (const name of names) {
        if (next[name] === undefined) records.delete(name); else records.set(name, next[name]);
      }
      if (sessionChanged) records.delete("connect_epoch");
    },
    async clear(keep, options) {
      const session = records.get("session") as AccountSession | undefined;
      if (options?.only !== undefined && !options.only(session, records.get("key") as AccountKey | undefined)) return;
      const kept = (["leaving", "own_blocks", ...options?.spare ?? []] as const).map((name) => [name, records.get(name)] as const);
      const generation = records.get("generation");
      const unsent = keptUnsent(records.get("unsent_blocks") as Records["unsent_blocks"] | undefined, options?.unsent);
      records.clear();
      for (const [name, value] of kept) if (value !== undefined) records.set(name, value);
      if (unsent !== undefined) records.set("unsent_blocks", unsent);
      if (session !== undefined && keep?.(session) === true) {
        records.set("session", session);
        if (generation !== undefined) records.set("generation", generation);
      }
    },
  };
}

/** Runs `work` alone among this origin's tabs (Web Locks), where the browser has them. */
export type AccountLock = <T>(work: () => Promise<T>) => Promise<T>;

export const accountLock: AccountLock = (work) => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request("ovis-account-session", work) : work();
};

export function memoryLock(): AccountLock {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

const DATABASE = "ovis-account";
const STORE = "account";

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

/**
 * Fired on this page's window once a write that may change the stored sign-in is done (a sign-in, a refresh, a sign-out,
 * one ended by the service): what reads the sign-in reads it again. Another tab's write is read again on focus.
 */
export const ACCOUNT_SESSION_EVENT = "ovis:account-session";

function sessionWritten<T>(written: Promise<T>): Promise<T> {
  return written.finally(() => { globalThis.window?.dispatchEvent?.(new Event(ACCOUNT_SESSION_EVENT)); });
}

export const indexedAccountStore: AccountStore = {
  async key() {
    // made outside the transaction, which would commit while WebCrypto works; another tab's key, saved first, wins
    const made = await newKey();
    return transact("readwrite", (store) => {
      const request: IDBRequest<AccountKey | undefined> = store.get("key");
      request.onsuccess = () => { if (request.result === undefined) store.put(made, "key"); };
      return () => request.result ?? made;
    });
  },
  get(name) {
    return transact("readonly", (store) => {
      const request = store.get(name);
      return () => request.result as never;
    });
  },
  set(name, value) {
    const written = transact("readwrite", (store) => {
      if (name === "session") store.delete("connect_epoch");
      if (value === undefined) store.delete(name);
      else store.put(value, name);
      return () => undefined;
    });
    return name === "session" ? sessionWritten(written) : written;
  },
  update(name, change) {
    const written = transact("readwrite", (store) => {
      const request = store.get(name);
      request.onsuccess = () => {
        const next = change(request.result as never);
        if (name === "session" && next !== request.result) store.delete("connect_epoch");
        if (next === undefined) store.delete(name);
        else store.put(next, name);
      };
      return () => undefined;
    });
    return name === "session" ? sessionWritten(written) : written;
  },
  updateMany(names, change) {
    let sessionChanged = false;
    const written = transact("readwrite", (store) => {
      const current: Record<string, unknown> = {};
      let left = names.length;
      for (const name of names) {
        const request = store.get(name);
        request.onsuccess = () => {
          current[name] = request.result;
          if (--left > 0) return;
          const next = change(current as never) as Record<string, unknown>;
          for (const each of names) {
            if (next[each] === current[each]) continue;
            if (each === "session") sessionChanged = true;
            if (next[each] === undefined) store.delete(each);
            else store.put(next[each], each);
          }
          if (sessionChanged) store.delete("connect_epoch");
        };
      }
      return () => undefined;
    });
    return written.then(() => {
      if (sessionChanged) globalThis.window?.dispatchEvent?.(new Event(ACCOUNT_SESSION_EVENT));
    });
  },
  clear(keep, options) {
    return sessionWritten(transact("readwrite", (store) => {
      const kept = (["leaving", "own_blocks", ...options?.spare ?? []] as const).map((name) => [name, store.get(name)] as const);
      const unsent: IDBRequest<Records["unsent_blocks"] | undefined> = store.get("unsent_blocks");
      const key: IDBRequest<AccountKey | undefined> = store.get("key");
      const generation: IDBRequest<string | undefined> = store.get("generation");
      const session: IDBRequest<AccountSession | undefined> = store.get("session");
      // requests run in order: every read is done when the last answers
      session.onsuccess = () => {
        if (options?.only !== undefined && !options.only(session.result, key.result)) return;
        store.clear();
        for (const [name, read] of kept) if (read.result !== undefined) store.put(read.result, name);
        const others = keptUnsent(unsent.result, options?.unsent);
        if (others !== undefined) store.put(others, "unsent_blocks");
        if (session.result !== undefined && keep?.(session.result) === true) {
          store.put(session.result, "session");
          if (generation.result !== undefined) store.put(generation.result, "generation");
        }
      };
      return () => undefined;
    }));
  },
};
