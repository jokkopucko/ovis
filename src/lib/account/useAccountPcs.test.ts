import { afterEach, beforeEach, expect, it } from "bun:test";
import { SignedOutError, type AccountService } from "./service.ts";
import type { AccountSession } from "./store.ts";
import { signedInAccount } from "./useAccountPcs.ts";

const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
beforeEach(() => { Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } }); });
afterEach(() => { if (saved) Object.defineProperty(globalThis, "navigator", saved); else Reflect.deleteProperty(globalThis, "navigator"); });

const session = (account: string, no: number): AccountSession => ({ service: "https://account.test", account, provider: "github", access_token: `a-${no}`, refresh_token: `r-${no}`, expires_at: Date.now() + 3_600_000 });

/** The account service as the sidebar uses it: one stored sign-in, and a bound service that refuses once another is stored. */
function service(first: AccountSession) {
  let stored: AccountSession | undefined = first;
  const admitted: string[] = [];
  const made = {
    session: async () => stored,
    forSignIn: (signIn: AccountSession) => ({
      listPcs: async () => [],
      postAdmission: async () => { if (stored?.refresh_token !== signIn.refresh_token) throw new SignedOutError(); admitted.push(signIn.refresh_token); },
    }),
  } as unknown as AccountService;
  return { made, admitted, store: (next: AccountSession | undefined) => { stored = next; } };
}

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
