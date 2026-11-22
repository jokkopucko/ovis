/**
 * Test support for account-joined rows: real P-256 keys under short names, so a test reads "k-1" while the store
 * and its file see a key every parser accepts.
 */
import { exportAccountKey } from "../../shared/account-records.ts";
import type { AdmissionOrigin } from "../../shared/account-snapshot.ts";
import type { ListCommit } from "./account-devices.ts";

export const SERVER = "0123456789abcdef0123456789abcdef";
export const ACCOUNT = "acct_1";

const POOL = await Promise.all(Array.from({ length: 128 }, async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return await exportAccountKey(pair.publicKey);
}));
const keys = new Map<string, string>();
const names = new Map<string, string>();

/** The key a test calls `name`: the same key for the same name in one test file. */
export function keyOf(name: string): string {
  let key = keys.get(name);
  if (key === undefined) {
    key = POOL[keys.size];
    if (key === undefined) throw new Error("The key pool is used up");
    keys.set(name, key);
    names.set(key, name);
  }
  return key;
}

export function nameOf(key: string): string {
  return names.get(key) ?? "?";
}

/** A whole read naming `listed` (numbered in that order) and `removed`, as one snapshot of `version`. */
export function snapshotList(listed: readonly string[], removed: readonly string[] = [], version = 1, eligible: (name: string) => boolean = () => true): ListCommit {
  return {
    account: ACCOUNT, snapshot: version.toString(16).padStart(32, "0"), version,
    devices: listed.map((name, index) => ({ key: keyOf(name), no: index + 1, label: name, eligible: eligible(name) })),
    removed: removed.map((name, index) => ({ key: keyOf(name), no: listed.length + index + 1 })),
  };
}

/** What PcAccountState.admit gives a list admission: the next number on this PC, from the account's list. */
export function listOrigins(): (at: number) => AdmissionOrigin {
  let next = 0;
  return (at) => ({ from: "remote", how: "list", by: null, admit_no: ++next, at: new Date(at).toISOString() });
}
