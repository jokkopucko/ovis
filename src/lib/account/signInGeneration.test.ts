import { expect, it } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { AccountService, SignedOutError } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock, type AccountStore } from "./store.ts";

const SERVICE = "https://account.example";

async function start(fake: FakeAccountService, store: AccountStore, provider: "github" | "google" = "github", linkToken?: string) {
  const url = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT, ...(linkToken === undefined ? {} : { linkToken }) });
  const returned = signInReturn(new URL((await fake.fetch(url)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("The fake service sent no sign-in return");
  return returned;
}

async function setup() {
  const fake = new FakeAccountService();
  fake.signInAs("github", "acct_1");
  const store = memoryAccountStore();
  const signIn = async () => finishSignIn(await start(fake, store), { store, fetch: fake.fetch });
  const session = await signIn();
  return { fake, store, signIn, session, account: new AccountService({ store, fetch: fake.fetch, lock: memoryLock() }) };
}

it("does not send the first account request after sign-out and same-account sign-in", async () => {
  const { fake, store, signIn, session, account } = await setup();
  const locked = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const read = new AccountService({
    store, fetch: fake.fetch, now: () => session.expires_at,
    lock: async (work) => { locked.resolve(); await proceed.promise; return work(); },
  }).identities();
  await locked.promise;
  await account.signOut();
  await signIn();
  proceed.resolve();

  await expect(read).rejects.toBeInstanceOf(SignedOutError);
  expect(fake.requests).not.toContain("GET /v1/identities");
});

it.each([200, 401])("drops a delayed %i instead of returning or retrying it under a later sign-in", async (status) => {
  const { fake, store, signIn, account } = await setup();
  const sent = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  let held = false;
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname !== "/v1/identities" || held) return fake.fetch(request);
    held = true;
    sent.resolve();
    return response.promise;
  };
  const read = new AccountService({ store, fetch, lock: memoryLock() }).identities();
  await sent.promise;
  await account.signOut();
  const replacement = await signIn();
  response.resolve(Response.json({ identities: [] }, { status }));

  await expect(read).rejects.toBeInstanceOf(SignedOutError);
  expect(fake.requests).not.toContain("GET /v1/identities");
  expect(await store.get("session")).toEqual(replacement);
});

it("does not redeem a sign-in that returns after sign-out", async () => {
  const { fake, store, account } = await setup();
  const returned = await start(fake, store);
  await account.signOut();

  await expect(finishSignIn(returned, { store, fetch: fake.fetch })).rejects.toBeInstanceOf(SignedOutError);
  expect(fake.requests.filter((request) => request === "POST /v1/token")).toHaveLength(1);
  expect(await store.get("session")).toBeUndefined();
});

it("lets a pending redirect finish after signing out with no stored session", async () => {
  const fake = new FakeAccountService();
  fake.signInAs("github", "acct_1");
  const store = memoryAccountStore();
  const returned = await start(fake, store);

  await new AccountService({ store, fetch: fake.fetch, lock: memoryLock() }).signOut();

  const session = await finishSignIn(returned, { store, fetch: fake.fetch });
  expect(await store.get("session")).toEqual(session);
  expect(fake.requests).not.toContain("POST /v1/signout");
});

it("redeems a pending sign-in from the previous build exactly once", async () => {
  const { fake, store } = await setup();
  const legacy = memoryAccountStore();
  const returned = await start(fake, legacy);
  const pending = (await legacy.get("pending"))?.[returned.state];
  if (pending === undefined) throw new Error("The fake sign-in is not pending");
  const { generation: _notSavedByPreviousBuild, ...old } = pending;
  await store.set("pending", { [returned.state]: old });

  const session = await finishSignIn(returned, { store, fetch: fake.fetch });
  expect(await store.get("session")).toEqual(session);
  await expect(finishSignIn(returned, { store, fetch: fake.fetch })).rejects.toMatchObject({ code: "no_sign_in" });
  expect(fake.requests.filter((request) => request === "POST /v1/token")).toHaveLength(2);
});

it("revokes a sign-in whose token answer arrives after sign-out instead of storing it", async () => {
  const { fake, store, account } = await setup();
  const returned = await start(fake, store);
  const issued = Promise.withResolvers<Response>();
  const proceed = Promise.withResolvers<void>();
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const answer = await fake.fetch(request);
    if (new URL(request.url).pathname === "/v1/token") { issued.resolve(answer.clone()); await proceed.promise; }
    return answer;
  };
  const finishing = finishSignIn(returned, { store, fetch });
  const { access_token } = await (await issued.promise).json();
  await account.signOut();
  proceed.resolve();

  await expect(finishing).rejects.toBeInstanceOf(SignedOutError);
  expect(await store.get("session")).toBeUndefined();
  expect((await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${access_token}` } }))).status).toBe(401);
});

it("keeps a successful link when revoking the replaced sign-in returns 503", async () => {
  const { fake, store } = await setup();
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/v1/signout") return new Response(null, { status: 503 });
    return fake.fetch(request);
  };
  const account = new AccountService({ store, fetch, lock: memoryLock() });

  const linked = await account.addMethod("google", async (linkToken, bearer) =>
    finishSignIn(await start(fake, store, "google", linkToken), { store, fetch: fake.fetch, bearer }));

  expect(linked.provider).toBe("google");
  expect(await store.get("session")).toEqual(linked);
  expect((await account.identities()).identities.map((identity) => identity.provider)).toContain("google");
});

it("reports a failed revoke of a link discarded after sign-out", async () => {
  const { fake, store, account } = await setup();
  const issued = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname === "/v1/signout" ? new Response(null, { status: 429 }) : fake.fetch(request);
  };
  const linking = new AccountService({ store, fetch, lock: memoryLock() }).addMethod("google", async (linkToken, bearer) => {
    const session = await finishSignIn(await start(fake, store, "google", linkToken), { store, fetch: fake.fetch, bearer });
    issued.resolve();
    await proceed.promise;
    return session;
  });
  await issued.promise;
  await account.signOut();
  proceed.resolve();

  await expect(linking).rejects.toMatchObject({ status: 429 });
  expect(await store.get("session")).toBeUndefined();
});
