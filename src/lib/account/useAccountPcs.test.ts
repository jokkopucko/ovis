import { afterEach, beforeEach, expect, it } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { AccountService, SignedOutError, type DirectoryPc } from "./service.ts";
import { memoryAccountStore, type AccountSession } from "./store.ts";
import { signedInAccount } from "./useAccountPcs.ts";

const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
beforeEach(() => { Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } }); });
afterEach(() => { if (saved) Object.defineProperty(globalThis, "navigator", saved); else Reflect.deleteProperty(globalThis, "navigator"); });

const session = (account: string, no: number): AccountSession => ({ service: "https://account.test", account, provider: "github", access_token: `a-${no}`, refresh_token: `r-${no}`, expires_at: Date.now() + 3_600_000 });

/** The account service as the sidebar uses it: one stored sign-in, and a bound service that refuses once another is stored. */
function service(first: AccountSession, pcs: readonly DirectoryPc[] = []) {
  let stored: AccountSession | undefined = first;
  const admitted: string[] = [];
  const made = {
    session: async () => stored,
    forSignIn: (signIn: AccountSession) => ({
      listPcs: async () => pcs,
      postAdmission: async () => { if (stored?.refresh_token !== signIn.refresh_token) throw new SignedOutError(); admitted.push(signIn.refresh_token); },
    }),
  } as unknown as AccountService;
  return { made, admitted, store: (next: AccountSession | undefined) => { stored = next; } };
}

it("offers only PCs whose account join completed or whose mailbox has checked in", async () => {
  const dir = (name: string, completed: boolean, seen: boolean): DirectoryPc => {
    const key = generateKeyPair().publicKey;
    const at = new Date().toISOString();
    return {
      server_id: deriveServerId(key), public_key: bytesToHex(key), relay: "wss://relay.ovis.sh",
      label: name, added_at: at, last_seen_at: seen ? at : null, completed_at: completed ? at : null,
      admitted_at: at, admitted_before_you: true, new_until: null,
    };
  };
  const pcs = [dir("Only listed", false, false), dir("Completed", true, false), dir("Checked in", false, true)];
  const source = signedInAccount(service(session("acct", 1), pcs).made);

  expect((await source.list())?.pcs.map((pc) => pc.name).sort()).toEqual(["Checked in", "Completed"]);
});

it("does not offer a directory PC with malformed check-in timestamps", async () => {
  const store = memoryAccountStore();
  await store.set("session", session("acct", 1));
  const pcs = ["", "not a date", "0", "2026-02-30T00:00:00.000Z"].map((timestamp) => {
    const key = generateKeyPair().publicKey;
    return {
      server_id: deriveServerId(key), public_key: bytesToHex(key), relay: "wss://relay.ovis.sh",
      label: `PC (${timestamp})`, added_at: new Date().toISOString(), last_seen_at: timestamp,
      completed_at: null,
    };
  });
  const account = new AccountService({ store, fetch: async () => Response.json({ pcs }) });

  expect(await signedInAccount(account).list()).toEqual({ account: "acct", pcs: [] });
});

it("admits under the sign-in stored now when the page signed in again to the account the list was read for", async () => {
  const account = service(session("acct", 1));
  const source = signedInAccount(account.made);
  expect(await source.list()).toMatchObject({ account: "acct" });
  // signed out and in again to the same account: the retry the sidebar makes then needs no new read of the list
  account.store(session("acct", 2));
  await source.admit("a".repeat(32), "Ovis on desk", "key");
  expect(account.admitted).toEqual(["r-2"]);
});

it("admits nothing once the page is signed in to another account, or to none: the row asks to sign in again", async () => {
  const account = service(session("acct", 1));
  const source = signedInAccount(account.made);
  await source.list();
  for (const now of [session("other", 3), undefined]) {
    account.store(now);
    await expect(source.admit("a".repeat(32), "Ovis on desk", "key")).rejects.toBeInstanceOf(SignedOutError);
  }
  expect(account.admitted).toEqual([]);
});
