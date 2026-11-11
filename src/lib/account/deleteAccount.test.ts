import { describe, expect, it } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { deleteAccount } from "./deleteAccount.ts";
import { AccountService, SignedOutError } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import type { AccountProvider, AccountStore } from "./store.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";

async function listPc(service: AccountService): Promise<void> {
  const key = generateKeyPair().publicKey;
  await service.putPc(deriveServerId(key), { label: "Desk", public_key: Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
}

async function signIn(fake: FakeAccountService, provider: AccountProvider, store: AccountStore) {
  const start = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  return finishSignIn(returned, { store, fetch: fake.fetch });
}

async function signedIn(account = "acct_1", clock: () => number = Date.now) {
  const fake = new FakeAccountService(clock);
  fake.signInAs("github", account);
  const store = memoryAccountStore();
  const session = await signIn(fake, "github", store);
  const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: clock });
  return { fake, store, session, service };
}

describe("deleting the account", () => {
  it("erases the account at the service, ends the sign-in here and forgets the account key", async () => {
    const { fake, store, session, service } = await signedIn();
    await listPc(service);
    expect(fake.pcs(session.account)).toHaveLength(1);
    const key = (await store.key()).public_spki;
    await deleteAccount({ service, accountStore: store, session });
    expect(fake.requests).toContain("DELETE /v1/account");
    expect(fake.pcs(session.account)).toEqual([]);
    expect(fake.deleted(session.account)).toBe(true);
    expect(await store.get("session")).toBeUndefined();
    expect((await store.key()).public_spki).not.toBe(key);
    await expect(service.listPcs()).rejects.toBeInstanceOf(SignedOutError);
  });

  it("ends the account's other sign-ins too", async () => {
    const { fake, store, session, service } = await signedIn();
    const elsewhere = memoryAccountStore();
    await signIn(fake, "github", elsewhere);
    const other = new AccountService({ store: elsewhere, fetch: fake.fetch, lock: memoryLock() });
    expect(await other.listPcs()).toEqual([]);
    await deleteAccount({ service, accountStore: store, session });
    await expect(other.listPcs()).rejects.toBeInstanceOf(SignedOutError);
  });

  it("deletes nothing and stays signed in when the sign-in is over ten minutes old", async () => {
    let now = Date.now();
    const { fake, store, session, service } = await signedIn("acct_1", () => now);
    now += 11 * 60_000;
    await expect(deleteAccount({ service, accountStore: store, session })).rejects.toMatchObject({ status: 403, code: "reauth_required" });
    expect(fake.deleted(session.account)).toBe(false);
    expect(await store.get("session")).toBeDefined();
    await signIn(fake, "github", store);
    const again = await service.session();
    await deleteAccount({ service, accountStore: store, session: again! });
    expect(fake.deleted(session.account)).toBe(true);
  });

  it("deletes nothing while a subscription still renews", async () => {
    const { fake, store, session, service } = await signedIn();
    fake.subscribe(session.account);
    const key = (await store.key()).public_spki;
    await expect(deleteAccount({ service, accountStore: store, session })).rejects.toMatchObject({ status: 409, code: "subscription_active" });
    expect(fake.deleted(session.account)).toBe(false);
    expect(await store.get("session")).toBeDefined();
    expect((await store.key()).public_spki).toBe(key);
  });

  it("keeps the key of a sign-in that took the deleted one's place while the delete was out", async () => {
    const { fake, store, session } = await signedIn();
    const elsewhere = memoryAccountStore();
    fake.signInAs("github", "acct_2");
    const next = await signIn(fake, "github", elsewhere);
    const key = await store.key();
    // another tab signs in to acct_2 in this store while the service answers the delete
    const fetch: typeof fake.fetch = async (input, init) => {
      const answer = await fake.fetch(input, init);
      if (new Request(input, init).method === "DELETE") await store.set("session", next);
      return answer;
    };
    const service = new AccountService({ store, fetch, lock: memoryLock() });
    await deleteAccount({ service, accountStore: store, session });
    expect(fake.deleted(session.account)).toBe(true);
    expect((await store.get("session"))?.account).toBe("acct_2");
    expect((await store.key()).public_spki).toBe(key.public_spki);
  });

  it("forgets the deleted account's key when another tab's refused request ended the sign-in before the answer came", async () => {
    const { store, session, fake } = await signedIn();
    const key = (await store.key()).public_spki;
    const fetch: typeof fake.fetch = async (input, init) => {
      const answer = await fake.fetch(input, init);
      if (new Request(input, init).method === "DELETE") await store.set("session", undefined);
      return answer;
    };
    const service = new AccountService({ store, fetch, lock: memoryLock() });
    await deleteAccount({ service, accountStore: store, session });
    expect(fake.deleted(session.account)).toBe(true);
    expect((await store.key()).public_spki).not.toBe(key);
  });

  it("keeps a sign-in another tab began while the delete was out", async () => {
    const { store, session, fake } = await signedIn();
    const fetch: typeof fake.fetch = async (input, init) => {
      const answer = await fake.fetch(input, init);
      if (new Request(input, init).method === "DELETE") await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT });
      return answer;
    };
    const service = new AccountService({ store, fetch, lock: memoryLock() });
    await deleteAccount({ service, accountStore: store, session });
    expect(fake.deleted(session.account)).toBe(true);
    expect(await store.get("session")).toBeUndefined();
    expect(Object.keys(await store.get("pending") ?? {})).toHaveLength(1);
  });

  it("never deletes or forgets a sign-in made meanwhile", async () => {
    const { fake, store, session, service } = await signedIn();
    await service.signOut();
    fake.signInAs("github", "acct_2");
    const next = await signIn(fake, "github", store);
    await expect(deleteAccount({ service, accountStore: store, session })).rejects.toBeInstanceOf(SignedOutError);
    expect(fake.deleted("acct_2")).toBe(false);
    expect((await store.get("session"))?.account).toBe(next.account);
  });
});
