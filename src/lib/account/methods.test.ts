import { describe, expect, it } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { desktopSignIn } from "./desktop.ts";
import { startDeviceSignIn } from "./deviceSignIn.ts";
import { AccountService, offeredProviders, parseAccountLimits, SignedOutError } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import type { AccountProvider, AccountStore } from "./store.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";

async function redirectSignIn(fake: FakeAccountService, provider: AccountProvider, store: AccountStore, link?: { linkToken: string; bearer?: string }) {
  const start = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT, ...(link ? { linkToken: link.linkToken } : {}) });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  return finishSignIn(returned, { store, fetch: fake.fetch, ...(link?.bearer ? { bearer: link.bearer } : {}) });
}

async function linkToken(fake: FakeAccountService, bearer: string, provider: AccountProvider): Promise<string> {
  const answer = await fake.fetch(new Request(`${SERVICE}/v1/identities/link`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ provider }) }));
  return (await answer.json() as { link_token: string }).link_token;
}

describe("the sign-ins a service offers", () => {
  it("lists Google only when the service says it is set up for it, and a PC's page only the device ones", async () => {
    const fake = new FakeAccountService();
    fake.offer(["github", "google"], ["github"]);
    expect(await offeredProviders(SERVICE, ["github"], { fetch: fake.fetch })).toEqual({ providers: ["github", "google"], device: ["github"], page: [] });
    fake.offer(["github"], ["github"]);
    expect(await offeredProviders(SERVICE, ["github"], { fetch: fake.fetch })).toEqual({ providers: ["github"], device: ["github"], page: [] });
  });

  it("names the sign-ins the Ovis link page offers, only among those set up", async () => {
    const fake = new FakeAccountService();
    fake.offer(["github", "google"], ["github"]);
    fake.offerLinkPage(["github", "google", "apple"]);
    expect((await offeredProviders(SERVICE, ["github"], { fetch: fake.fetch })).page).toEqual(["github", "google"]);
  });

  it("keeps the build's own list when the service cannot say, so no Google button leads nowhere", async () => {
    const down = async () => new Response("", { status: 404 });
    expect(await offeredProviders(SERVICE, ["github", "apple"], { fetch: down })).toEqual({ providers: ["github", "apple"], device: ["github"], page: [] });
    const offline = async (): Promise<Response> => { throw new TypeError("offline"); };
    expect(await offeredProviders(SERVICE, ["github"], { fetch: offline })).toEqual({ providers: ["github"], device: ["github"], page: [] });
    const odd = async () => Response.json({ providers: ["gitlab"], device: "google" });
    expect(await offeredProviders(SERVICE, ["github"], { fetch: odd })).toEqual({ providers: ["github"], device: ["github"], page: [] });
  });
});

describe("signing in with Google", () => {
  it("signs in through the redirect with PKCE, as GitHub does", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("google", "acct_g");
    const session = await redirectSignIn(fake, "google", memoryAccountStore());
    expect(session).toMatchObject({ account: "acct_g", provider: "google" });
  });

  it("signs in a PC's own page with Google's device flow and links only to Google's device page", async () => {
    const fake = new FakeAccountService();
    const store = memoryAccountStore();
    const started = await startDeviceSignIn({ service: SERVICE, store, fetch: fake.fetch, provider: "google", wait: async () => undefined, lock: memoryLock() });
    expect(started.verificationUri).toBe("https://www.google.com/device");
    fake.approveDevice(started.userCode, "acct_g");
    expect(await started.finish(new AbortController().signal)).toMatchObject({ account: "acct_g", provider: "google" });
    expect(fake.requests).toContain("POST /v1/signin/google/device");
  });
});

describe("sign-in methods", () => {
  it("adds Google to the signed-in account on purpose, keeps the account, and ends the sign-in it replaced", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const before = await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    const after = await service.addMethod("google", (linkToken, bearer) => redirectSignIn(fake, "google", store, { linkToken, bearer }));
    expect(after).toMatchObject({ account: "acct_1", provider: "google" });
    expect((await service.identities()).map((identity) => identity.provider).sort()).toEqual(["github", "google"]);
    expect(fake.requests).toContain("POST /v1/signout");
    // the replaced sign-in's tokens are over
    expect((await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${before.access_token}` } }))).status).toBe(401);
  });

  it("never joins a Google identity another account already has, and leaves both accounts as they were", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("google", "acct_other");
    await redirectSignIn(fake, "google", memoryAccountStore());
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.addMethod("google", (linkToken, bearer) => redirectSignIn(fake, "google", store, { linkToken, bearer }))).rejects.toMatchObject({ code: "in_use" });
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["github"]);
    expect((await store.get("session"))?.account).toBe("acct_1");
  });

  it("removes a method while another remains, and refuses to remove the last one", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await service.addMethod("google", (linkToken, bearer) => redirectSignIn(fake, "google", store, { linkToken, bearer }));
    await service.removeIdentity("github");
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["google"]);
    await expect(service.removeIdentity("google")).rejects.toMatchObject({ status: 409, code: "last_identity" });
  });

  it("links nothing until the link's own account redeems the code, so a link token in someone else's sign-in adds nobody", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_attacker");
    const attacker = memoryAccountStore();
    const session = await redirectSignIn(fake, "github", attacker);
    const token = await linkToken(fake, session.access_token, "google");
    // the victim opens the attacker's link URL: their own Google identity, their own client, no attacker token
    fake.signInAs("google", "acct_victim");
    const victim = memoryAccountStore();
    await expect(redirectSignIn(fake, "google", victim, { linkToken: token })).rejects.toMatchObject({ code: "invalid_grant" });
    const service = new AccountService({ store: attacker, fetch: fake.fetch, lock: memoryLock() });
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["github"]);
    // the victim's own Google sign-in still lands in their own account
    expect((await redirectSignIn(fake, "google", memoryAccountStore())).account).toBe("acct_victim");
  });

  it("refuses a spent link token instead of signing in plainly, and keeps the session and the account", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const before = await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.addMethod("google", async (token, bearer) => {
      await redirectSignIn(fake, "google", memoryAccountStore(), { linkToken: token, bearer });
      return redirectSignIn(fake, "google", store, { linkToken: token, bearer });
    })).rejects.toMatchObject({ code: "expired" });
    expect(await store.get("session")).toEqual(before);
  });

  it("ends and refuses an answer for another account, keeping the session it had", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    fake.signInAs("google", "acct_other");
    const store = memoryAccountStore();
    const before = await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.addMethod("google", () => redirectSignIn(fake, "google", memoryAccountStore()))).rejects.toMatchObject({ code: "invalid_answer" });
    expect(await store.get("session")).toEqual(before);
    expect(fake.requests.filter((request) => request === "POST /v1/signout")).toHaveLength(1);
  });

  it("adds a method from the desktop app through its loopback return, redeemed with the account's token", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const bridge = {
      service: SERVICE,
      start: async () => "http://127.0.0.1:4567/callback",
      open: async (url: string) => new URL((await fake.fetch(url)).headers.get("location") ?? "").search.slice(1),
    };
    // the page redeems with the browser's fetch, as the desktop app's page does
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(fake.fetch, { preconnect: real.preconnect });
    try {
      await desktopSignIn("github", bridge, store);
      const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
      const after = await service.addMethod("google", (token, bearer) => desktopSignIn("google", bridge, store, { linkToken: token, bearer }));
      expect(after).toMatchObject({ account: "acct_1", provider: "google" });
    } finally {
      globalThis.fetch = real;
    }
  });


  it("redeems a link only with the very sign-in that asked for it, not another sign-in of the same account", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const asking = await redirectSignIn(fake, "github", memoryAccountStore());
    const other = await redirectSignIn(fake, "github", memoryAccountStore());
    const token = await linkToken(fake, asking.access_token, "google");
    await expect(redirectSignIn(fake, "google", memoryAccountStore(), { linkToken: token, bearer: other.access_token })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("asks for a fresh sign-in to add or remove a method once the sign-in is over ten minutes old, and lists methods with no name", async () => {
    let now = Date.now();
    const fake = new FakeAccountService(() => now);
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
    await service.addMethod("google", (token, bearer) => redirectSignIn(fake, "google", store, { linkToken: token, bearer }));
    expect(await service.identities()).toEqual([{ provider: "github", added_at: expect.any(String) }, { provider: "google", added_at: expect.any(String) }]);
    now += 11 * 60_000;
    await expect(service.removeIdentity("github")).rejects.toMatchObject({ status: 403, code: "reauth_required" });
    await expect(service.addMethod("apple", async () => { throw new Error("no sign-in should start"); })).rejects.toMatchObject({ code: "reauth_required" });
    await redirectSignIn(fake, "google", store);
    await service.removeIdentity("github");
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["google"]);
  });

  it("stores nothing and ends the new sign-in when the account was signed out while the link finished", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const lock = memoryLock();
    const service = new AccountService({ store, fetch: fake.fetch, lock });
    let linked: Awaited<ReturnType<typeof redirectSignIn>> | undefined;
    await expect(service.addMethod("google", async (token, bearer) => {
      linked = await redirectSignIn(fake, "google", store, { linkToken: token, bearer });
      // another tab signs out while the token answer is still on its way
      await new AccountService({ store, fetch: fake.fetch, lock }).signOut();
      return linked;
    })).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
    expect((await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${linked?.access_token}` } }))).status).toBe(401);
  });
});

describe("the account's limits", () => {
  it("reads them from the session's own service, and none when it reports none", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.limits()).rejects.toMatchObject({ status: 404 });
    fake.setLimits("acct_1", { plan: "personal", pcs_max: 3, data_cap_bytes: 5_000, data_used_bytes: 500, data_metering: "on" });
    expect(await service.limits()).toEqual({ plan: "personal", pcs_max: 3, data_cap_bytes: 5_000, data_used_bytes: 500 });
  });

  it("drops used data while metering is off, and refuses a malformed answer", () => {
    expect(parseAccountLimits({ plan: "personal", pcs_max: 3, data_cap_bytes: 5_000, data_used_bytes: 1_000, data_metering: "off" })).toEqual({ plan: "personal", pcs_max: 3, data_cap_bytes: 5_000 });
    expect(parseAccountLimits({ plan: "", pcs_max: 3 })).toBeNull();
    expect(parseAccountLimits({ plan: "personal", pcs_max: -1 })).toBeNull();
    expect(parseAccountLimits(null)).toBeNull();
  });

  it("keeps the limits when the plan name is long, shortening only the name", () => {
    expect(parseAccountLimits({ plan: "p".repeat(40), pcs_max: 3 })).toEqual({ plan: `${"p".repeat(31)}…`, pcs_max: 3 });
  });
});
