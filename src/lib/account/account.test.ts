import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_CODE_TTL_S, FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { startDeviceSignIn, startLinkPageSignIn } from "./deviceSignIn.ts";
import type { RelayDevice } from "../relay/device.ts";
import { myPcs, OFFLINE_AFTER_MS } from "./myPcs.ts";
import { accountProvidersOf, AccountService, AccountServiceError, accountServiceOf, pcAccountServiceOf, shellAccountServiceOf, SignedOutError } from "./service.ts";
import { beginSignIn, finishOwnSignIn, finishSignIn, SignInError, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";
import { desktopProviders } from "./desktop.ts";

const SERVICE = "https://account.example";
const REDIRECT = WEB_REDIRECT;
const PC_A = "a".repeat(32);
const PC_B = "b".repeat(32);

function serviceWithSignIn() {
  const fake = new FakeAccountService();
  fake.signInAs("github", "acct_1");
  fake.signInAs("apple", "acct_1");
  return { fake, fetch: fake.fetch };
}

async function signIn(service: ReturnType<typeof serviceWithSignIn>, store = memoryAccountStore(), now = Date.now) {
  const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT, now });
  const location = (await service.fetch(start)).headers.get("location") ?? "";
  const returned = signInReturn(new URL(location).hash);
  if (returned === null) throw new Error("no sign-in came back");
  return { store, session: await finishSignIn(returned, { store, fetch: service.fetch, now }), returned };
}

function paired(serverId: string, name: string): RelayDevice {
  return { server_id: serverId, device_id: "0".repeat(16), private_key: {} as CryptoKey, public_spki: "", label: "Phone", server_public_key: "", relay: "wss://relay.example", name };
}

describe("signing in", () => {
  it("lists the account's PCs once the code comes back with the verifier that started it", async () => {
    const service = serviceWithSignIn();
    const { store, session } = await signIn(service);
    expect(session.account).toBe("acct_1");
    const client = new AccountService({ store, fetch: service.fetch });
    const { generateKeyPair } = await import("../../../shared/relay-e2ee.ts");
    const { deriveServerId } = await import("../../../shared/relay-server-proof.ts");
    const key = generateKeyPair().publicKey;
    const hex = Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await client.putPc(deriveServerId(key), { label: "p620", public_key: hex, relay: "wss://relay.example" });
    expect((await client.listPcs()).map((pc) => pc.label)).toEqual(["p620"]);
  });

  it("refuses a return opened twice, and one it never started without touching a sign-in still waiting", async () => {
    const service = serviceWithSignIn();
    const { store, returned } = await signIn(service);
    await expect(finishSignIn(returned, { store, fetch: service.fetch })).rejects.toMatchObject({ code: "no_sign_in" });
    const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT });
    const forged = await finishSignIn({ code: "x", state: "someone-else" }, { store, fetch: service.fetch }).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(SignInError);
    // the real return still finishes after the forged one
    const real = signInReturn(new URL((await service.fetch(start)).headers.get("location") ?? "").hash);
    expect((await finishSignIn(real ?? { error: "x", state: "" }, { store, fetch: service.fetch })).account).toBe("acct_1");
  });

  it("refuses an older sign-in's return in place of the one just started, and drops the one just started", async () => {
    const service = serviceWithSignIn();
    const store = memoryAccountStore();
    const older = await beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT });
    const olderBack = new URL((await service.fetch(older)).headers.get("location") ?? "").hash;
    const now = await beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT });
    await expect(finishOwnSignIn(now, olderBack, { store, fetch: service.fetch })).rejects.toBeInstanceOf(SignInError);
    expect(Object.keys(await store.get("pending") ?? {})).toEqual([new URL(older).searchParams.get("state") ?? ""]);
    expect(await store.get("session")).toBeUndefined();
  });

  it("lets two tabs sign in at once, each finishing its own", async () => {
    const service = serviceWithSignIn();
    const store = memoryAccountStore();
    const [first, second] = await Promise.all([1, 2].map(() => beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT })));
    const back = async (start: string) => signInReturn(new URL((await service.fetch(start)).headers.get("location") ?? "").hash) ?? { error: "x", state: "" };
    const [b1, b2] = [await back(first ?? ""), await back(second ?? "")];
    await finishSignIn(b1, { store, fetch: service.fetch });
    expect((await finishSignIn(b2, { store, fetch: service.fetch })).account).toBe("acct_1");
  });

  it("refuses a sign-in that came back after its time ran out", async () => {
    const service = serviceWithSignIn();
    const store = memoryAccountStore();
    let now = 1_000_000;
    const start = await beginSignIn("apple", { store, service: SERVICE, redirectUri: REDIRECT, now: () => now });
    const returned = signInReturn(new URL((await service.fetch(start)).headers.get("location") ?? "").hash);
    now += 11 * 60_000;
    await expect(finishSignIn(returned ?? { error: "x", state: "" }, { store, fetch: service.fetch, now: () => now })).rejects.toMatchObject({ code: "expired" });
  });

  it("refreshes an access token about to run out, and signs out when the refresh is refused", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store, session } = await signIn(service, memoryAccountStore(), () => now);
    const client = new AccountService({ store, fetch: service.fetch, now: () => now });
    now = session.expires_at;
    await client.listPcs();
    expect((await store.get("session"))?.access_token).not.toBe(session.access_token);
    // the spent refresh token comes back, as a leaked copy would: the service ends the whole sign-in
    const refreshed = await store.get("session");
    if (refreshed === undefined) throw new Error("the refresh kept no session");
    await store.set("session", { ...refreshed, refresh_token: session.refresh_token, expires_at: 0 });
    await expect(client.listPcs()).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
  });
});

describe("a sign-in shared by tabs", () => {
  it("refreshes once when two tabs find the access token run out together, and stays signed in", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store, session } = await signIn(service, memoryAccountStore(), () => now);
    const lock = memoryLock();
    const tabs = [1, 2].map(() => new AccountService({ store, fetch: service.fetch, now: () => now, lock }));
    now = session.expires_at;
    await Promise.all(tabs.map((tab) => tab.listPcs()));
    expect(service.fake.requests.filter((request) => request === "POST /v1/token")).toHaveLength(2);
    expect(await store.get("session")).toBeDefined();
  });

  it("keeps a sign-in saved without an id the same one across its first refresh, for a call bound to a copy read before it", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store, session } = await signIn(service, memoryAccountStore(), () => now);
    // as a build from before sign-ins had an id stored it
    const { sign_in_id: _later, ...old } = session;
    await store.set("session", old);
    const account = new AccountService({ store, fetch: service.fetch, now: () => now, lock: memoryLock() });
    const read = await account.session();
    expect(read?.sign_in_id).toBeDefined();
    expect((await store.get("session"))?.sign_in_id).toBe(read!.sign_in_id);
    // two readers agree on the id
    expect((await account.session())?.sign_in_id).toBe(read!.sign_in_id);
    // the access token runs out: any call refreshes it, which changes the refresh token
    now = session.expires_at;
    await account.listPcs();
    expect((await store.get("session"))?.refresh_token).not.toBe(read!.refresh_token);
    // a call bound to the copy read before the refresh still acts: it is the same sign-in
    expect(await account.forSignIn(read!).listPcs()).toEqual([]);
  });

  it("reads and names a sign-in saved without an id in one update of the store, so another tab's refresh cannot fall between", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store: inner, session } = await signIn(service, memoryAccountStore(), () => now);
    const { sign_in_id: _later, ...old } = session;
    await inner.set("session", old);
    now = session.expires_at;
    const lock = memoryLock();
    const other = new AccountService({ store: inner, fetch: service.fetch, now: () => now, lock });
    // a store that would let another tab name and refresh the session after any plain read of it
    let reads = 0;
    const store: typeof inner = { ...inner, get: (async (name: Parameters<typeof inner.get>[0]) => {
      const value = await inner.get(name);
      if (name === "session" && ++reads === 1) await other.listPcs();
      return value;
    }) as typeof inner.get };
    const tab = new AccountService({ store, fetch: service.fetch, now: () => now, lock });
    const read = await tab.session();
    // no plain read came first, and what this tab holds is the session as the store has it, id and all
    expect(reads).toBe(0);
    expect(read!.sign_in_id).toBeDefined();
    expect(read).toEqual((await inner.get("session"))!);
    // after the other tab's refresh, this tab's copy is still that sign-in: its sign-out ends the refreshed one
    await other.listPcs();
    expect((await inner.get("session"))?.refresh_token).not.toBe(read!.refresh_token);
    await tab.forSignIn(read!).signOut();
    expect(await inner.get("session")).toBeUndefined();
  });

  it("keeps the id another tab already stored for a saved sign-in, and still reads a store that takes no write", async () => {
    const service = serviceWithSignIn();
    const { store: inner, session } = await signIn(service);
    const { sign_in_id: _later, ...old } = session;
    await inner.set("session", { ...old, sign_in_id: "given-by-the-earlier-build" });
    expect((await new AccountService({ store: inner, fetch: service.fetch, lock: memoryLock() }).session())?.sign_in_id).toBe("given-by-the-earlier-build");
    await inner.set("session", old);
    const full: typeof inner = { ...inner, update: (async () => { throw new DOMException("full", "QuotaExceededError"); }) as typeof inner.update };
    expect(await new AccountService({ store: full, fetch: service.fetch, lock: memoryLock() }).session()).toEqual(old);
  });

  it("ends the sign-in on the service even when its access token has run out", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store, session } = await signIn(service, memoryAccountStore(), () => now);
    now = session.expires_at;
    await new AccountService({ store, fetch: service.fetch, now: () => now }).signOut();
    expect(await store.get("session")).toBeUndefined();
    // a copy of the refresh token kept elsewhere no longer works
    const reuse = await service.fetch(new URL("/v1/token", SERVICE), { method: "POST", body: JSON.stringify({ grant_type: "refresh_token", refresh_token: session.refresh_token }) });
    expect(reuse.status).toBe(400);
  });

  it("never brings a session back once signed out, whatever a refresh in flight answers", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store, session } = await signIn(service, memoryAccountStore(), () => now);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/v1/token") await held;
      return service.fetch(request);
    };
    const lock = memoryLock();
    const tab = new AccountService({ store, fetch: slow, now: () => now, lock });
    now = session.expires_at;
    const listing = tab.listPcs().catch((error: unknown) => error);
    const leaving = new AccountService({ store, fetch: service.fetch, now: () => now, lock }).signOut();
    release();
    await Promise.all([listing, leaving]);
    expect(await store.get("session")).toBeUndefined();
  });

  it("keeps a new sign-in that lands while an earlier sign-out is still out", async () => {
    const service = serviceWithSignIn();
    const { store } = await signIn(service);
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const slow = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/v1/signout") { asked.resolve(); await answer.promise; }
      return service.fetch(request);
    };
    const leaving = new AccountService({ store, fetch: slow }).signOut();
    await asked.promise;
    const { session } = await signIn(service, store);
    answer.resolve();
    await leaving;
    expect(await store.get("session")).toEqual(session);
  });

  it("keeps the service's own words out of its errors, which could echo a token", async () => {
    const store = memoryAccountStore();
    await store.set("session", { service: SERVICE, account: "acct_1", provider: "github", access_token: "secret-token", refresh_token: "r", expires_at: Date.now() + 3600_000 });
    const echo = async () => Response.json({ error: { code: "bad_request", message: "Bearer secret-token" } }, { status: 400 });
    const error = await new AccountService({ store, fetch: echo }).listPcs().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountServiceError);
    expect((error as Error).message).not.toContain("secret-token");
    expect((error as AccountServiceError).code).toBe("bad_request");
  });
});

describe("signing in on a PC's own page, with GitHub's device flow", () => {
  function setup() {
    let now = 1_000_000;
    const fake = new FakeAccountService(() => now);
    const store = memoryAccountStore();
    const polls: string[] = [];
    const fetch = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/v1/token") polls.push(String(now));
      return fake.fetch(request);
    };
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); now += ms; };
    return { fake, store, fetch, wait, waits, polls, advance: (ms: number) => { now += ms; }, options: { service: SERVICE, store, fetch, wait, now: () => now, lock: memoryLock() } };
  }

  it("shows GitHub's code, polls at its interval with the verifier, and keeps the session once approved", async () => {
    const { fake, store, options, waits } = setup();
    const started = await startDeviceSignIn(options);
    expect(started.verificationUri).toBe("https://github.com/login/device");
    const finishing = started.finish(new AbortController().signal);
    fake.approveDevice(started.userCode, "acct_page");
    const session = await finishing;
    expect(session.account).toBe("acct_page");
    expect((await store.get("session"))?.account).toBe("acct_page");
    expect(waits[0]).toBe(5_000);
  });

  it("shows no code and polls nothing when the service did not bind the sign-in to this page", async () => {
    const { fake, polls, options } = setup();
    const unbound = async (input: Request | string | URL, init?: RequestInit) => {
      const answer = await fake.fetch(input instanceof Request ? input : new Request(input, init));
      const body = await answer.json() as Record<string, unknown>;
      delete body["code_challenge_method"];
      return Response.json(body, { status: answer.status });
    };
    await expect(startDeviceSignIn({ ...options, fetch: unbound })).rejects.toMatchObject({ code: "unsupported" });
    expect(polls).toEqual([]);
  });

  it("waits as long as a 429 asks, then keeps polling", async () => {
    const { fake, options, waits } = setup();
    let limited = false;
    const fetch = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!limited && new URL(request.url).pathname === "/v1/token") {
        limited = true;
        return Response.json({ error: { code: "rate_limited", message: "" } }, { status: 429, headers: { "retry-after": "30" } });
      }
      return fake.fetch(request);
    };
    const started = await startDeviceSignIn({ ...options, fetch });
    fake.approveDevice(started.userCode, "acct_page");
    expect((await started.finish(new AbortController().signal)).account).toBe("acct_page");
    expect(waits).toEqual([5_000, 30_000]);
  });

  it("ends with denied when GitHub refused, and expired once the code ran out", async () => {
    const denied = setup();
    const refused = await startDeviceSignIn(denied.options);
    denied.fake.denyDevice(refused.userCode);
    await expect(refused.finish(new AbortController().signal)).rejects.toMatchObject({ code: "denied" });
    const late = setup();
    const lapsed = await startDeviceSignIn(late.options);
    late.advance(DEVICE_CODE_TTL_S * 1000);
    await expect(lapsed.finish(new AbortController().signal)).rejects.toMatchObject({ code: "expired" });
    expect(await late.store.get("session")).toBeUndefined();
  });

  it("keeps no session from a sign-in cancelled while it waited", async () => {
    const { fake, store, options } = setup();
    const cancel = new AbortController();
    const started = await startDeviceSignIn({ ...options, wait: async () => { fake.approveDevice(started.userCode, "acct_page"); cancel.abort(); } });
    await expect(started.finish(cancel.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.get("session")).toBeUndefined();
    expect(fake.requests).toContain("POST /v1/signout");
  });

  it("takes back the session of a sign-in cancelled while it was being written", async () => {
    const { fake, store, options } = setup();
    const cancel = new AbortController();
    const slow = { ...store, set: async (...args: Parameters<typeof store.set>) => { await store.set(...args); cancel.abort(); } };
    const started = await startDeviceSignIn({ ...options, store: slow });
    fake.approveDevice(started.userCode, "acct_page");
    await expect(started.finish(cancel.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.get("session")).toBeUndefined();
  });

  it("never waits past the code's lifetime, however long a 429 asks", async () => {
    const { fake, options, waits } = setup();
    const fetch = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).pathname === "/v1/token"
        ? Response.json({ error: { code: "rate_limited", message: "" } }, { status: 429, headers: { "retry-after": "3600" } })
        : fake.fetch(request);
    };
    const started = await startDeviceSignIn({ ...options, fetch });
    await expect(started.finish(new AbortController().signal)).rejects.toMatchObject({ code: "expired" });
    expect(waits).toEqual([5_000, DEVICE_CODE_TTL_S * 1000 - 5_000]);
  });

  it("links only to GitHub's own device page, whatever the service names", async () => {
    const { fake, options } = setup();
    const elsewhere = async (input: Request | string | URL, init?: RequestInit) => {
      const answer = await fake.fetch(input instanceof Request ? input : new Request(input, init));
      const body = await answer.json() as Record<string, unknown>;
      return Response.json({ ...body, verification_uri: "https://github.com.evil.example/login/device" }, { status: answer.status });
    };
    expect((await startDeviceSignIn({ ...options, fetch: elsewhere })).verificationUri).toBe("https://github.com/login/device");
  });
});

describe("signing in on a PC's own page, with the Ovis link page", () => {
  function setup() {
    let now = 1_000_000;
    const fake = new FakeAccountService(() => now);
    fake.offerLinkPage(["github", "google"]);
    const store = memoryAccountStore();
    const wait = async (ms: number) => { now += ms; };
    return { fake, store, options: { service: SERVICE, store, fetch: fake.fetch, wait, now: () => now, lock: memoryLock(), provider: "ovis" as const } };
  }

  it("tells the link page which PC is asking, and a provider's own device page nothing it would refuse", async () => {
    const { fake, options } = setup();
    const started = await startDeviceSignIn({ ...options, requester: { label: "Desk", os: "linux" } });
    expect(fake.linkRequester(started.userCode)).toEqual({ label: "Desk", os: "linux" });
    // GitHub's device start takes only the challenge: a name sent there would be refused
    expect((await startDeviceSignIn({ ...options, provider: "github", requester: { label: "Desk", os: "linux" } })).userCode).not.toBe("");
  });

  it("starts without the name on an account service that does not take one yet", async () => {
    const { fake, options } = setup();
    fake.linkPageTakesRequester = false;
    const started = await startDeviceSignIn({ ...options, requester: { label: "Desk", os: "linux" } });
    expect(started.verificationUri).toBe(`${SERVICE}/link`);
    expect(fake.linkRequester(started.userCode)).toEqual({ label: null, os: null });
  });

  it("shows the Ovis code with the service's own link page, and keeps the session the page approved", async () => {
    const { fake, store, options } = setup();
    const started = await startDeviceSignIn(options);
    expect(started.verificationUri).toBe(`${SERVICE}/link`);
    expect(started.verificationUriComplete).toBe(`${SERVICE}/link?code=${started.userCode}`);
    const finishing = started.finish(new AbortController().signal);
    fake.approveOnLinkPage(started.userCode, "acct_page", "google");
    expect(await finishing).toMatchObject({ account: "acct_page", provider: "google" });
    expect((await store.get("session"))?.provider).toBe("google");
  });

  it("falls back to the provider's device page when the link page is busy or down", async () => {
    const { fake, options } = setup();
    for (const answer of [
      () => Response.json({ error: { code: "rate_limited", message: "" } }, { status: 429, headers: { "retry-after": "60" } }),
      () => Response.json({ error: { code: "internal", message: "" } }, { status: 503 }),
      () => { throw new TypeError("offline"); },
    ]) {
      const fetch = async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return new URL(request.url).pathname === "/v1/signin/ovis/device" ? answer() : fake.fetch(request);
      };
      const started = await startLinkPageSignIn({ ...options, fetch }, "google");
      expect(started.provider).toBe("google");
      expect(started.verificationUri).toBe("https://www.google.com/device");
    }
    const working = await startLinkPageSignIn(options, "google");
    expect(working.provider).toBe("ovis");
  });

  it("does not fall back when the link page answers with a binding it cannot take: a bad answer cannot force the provider's page", async () => {
    const { fake, options } = setup();
    const evil = async (input: Request | string | URL, init?: RequestInit) => {
      const answer = await fake.fetch(input instanceof Request ? input : new Request(input, init));
      const body = await answer.json() as Record<string, unknown>;
      return Response.json({ ...body, verification_uri: "https://evil.example/link" }, { status: answer.status });
    };
    await expect(startLinkPageSignIn({ ...options, fetch: evil }, "google")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("follows no redirect: the device code and verifier never go to another address", async () => {
    const { fake, options } = setup();
    const elsewhere: string[] = [];
    // as fetch does: a 307 is followed with the same body unless the call says redirect "manual" or "error"
    const redirecting = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/token" || path === "/v1/signin/ovis/device") {
        if (init?.redirect === "manual") return new Response(null, { status: 307, headers: { location: "https://evil.example/collect" } });
        if (init?.redirect === "error") throw new TypeError("redirect refused");
        elsewhere.push(await request.text());
        return Response.json({ error: { code: "authorization_pending", message: "" } }, { status: 400 });
      }
      return fake.fetch(request);
    };
    await expect(startDeviceSignIn({ ...options, fetch: redirecting })).rejects.toBeDefined();
    const tokenOnly = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).pathname === "/v1/token" ? redirecting(input, init) : fake.fetch(request);
    };
    const started = await startDeviceSignIn({ ...options, fetch: tokenOnly });
    await expect(started.finish(new AbortController().signal)).rejects.toBeDefined();
    expect(elsewhere).toEqual([]);
  });

  it("refuses a link page on another address, and shows no QR code for a link carrying another code", async () => {
    const { fake, options } = setup();
    const rewrite = (fields: Record<string, string>) => async (input: Request | string | URL, init?: RequestInit) => {
      const answer = await fake.fetch(input instanceof Request ? input : new Request(input, init));
      const body = await answer.json() as Record<string, unknown>;
      return Response.json({ ...body, ...fields }, { status: answer.status });
    };
    await expect(startDeviceSignIn({ ...options, fetch: rewrite({ verification_uri: "https://account.evil.example/link" }) })).rejects.toMatchObject({ code: "unsupported" });
    const other = await startDeviceSignIn({ ...options, fetch: rewrite({ verification_uri_complete: `${SERVICE}/link?code=BBBB-BBBB` }) });
    expect(other.verificationUri).toBe(`${SERVICE}/link`);
    expect(other.verificationUriComplete).toBeNull();
  });
});

describe("which account service a page signs in with", () => {
  const page = (content: string | null) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } });

  it("signs in on the PC's own page only with the PC's own meta, an https service and a secure page", () => {
    const named = (name: string) => (content: string | null) => ({ querySelector: (selector: string) => selector === `meta[name="${name}"]` && content !== null ? { getAttribute: () => content } : null });
    const pc = named("ovis-pc-account-service");
    expect(pcAccountServiceOf(pc("https://account.example/"), true)).toBe("https://account.example");
    expect(pcAccountServiceOf(pc("https://account.example"), false)).toBeNull();
    expect(pcAccountServiceOf(pc("http://account.example"), true)).toBeNull();
    expect(pcAccountServiceOf(pc(null), true)).toBeNull();
    // the hosted shell's meta is not the PC's: that page signs in with its own redirect
    expect(pcAccountServiceOf(named("ovis-account-service")("https://account.example"), true)).toBeNull();
  });

  it("offers no sign-in without a service named, or with one reached over plain http beyond this machine", () => {
    expect(accountServiceOf(page(null))).toBeNull();
    expect(accountServiceOf(page("http://account.example"))).toBeNull();
    expect(accountServiceOf(page("not a url"))).toBeNull();
  });

  it("takes an https origin, or http on loopback, without its path", () => {
    expect(accountServiceOf(page("https://account.example/v1/"))).toBe("https://account.example");
    expect(accountServiceOf(page("http://127.0.0.1:8787"))).toBe("http://127.0.0.1:8787");
  });

  it("signs a browser in from app.ovis.sh alone, the one page the service sends it back to, and the phone app anywhere", () => {
    const hosted = page("https://account.ovis.sh");
    expect(shellAccountServiceOf(hosted, "https://app.ovis.sh", false)).toBe("https://account.ovis.sh");
    for (const copy of ["https://app-ap.ovis.sh", "https://preview.ovis-app.pages.dev", "http://127.0.0.1:7421"]) {
      expect(shellAccountServiceOf(hosted, copy, false)).toBeNull();
      expect(shellAccountServiceOf(hosted, copy, true)).toBe("https://account.ovis.sh");
    }
    expect(shellAccountServiceOf(page(null), "https://app.ovis.sh", true)).toBeNull();
  });
  it("offers GitHub alone unless the page names Apple too", () => {
    const named = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) });
    expect(accountProvidersOf(named(null))).toEqual(["github"]);
    expect(accountProvidersOf(named("apple"))).toEqual(["apple"]);
    expect(accountProvidersOf(named("apple, github"))).toEqual(["github", "apple"]);
    expect(accountProvidersOf(named("gitlab"))).toEqual(["github"]);
  });
  it("offers GitHub alone in the desktop app unless its service names Apple too", () => {
    const bridge = (providers?: string[]) => ({ service: SERVICE, start: async () => "", open: async () => "", ...(providers ? { providers } : {}) });
    expect(desktopProviders(bridge())).toEqual(["github"]);
    expect(desktopProviders(bridge(["apple", "github"]))).toEqual(["github", "apple"]);
  });


});

describe("the account key", () => {
  it("is made once, cannot be exported, and stays the same", async () => {
    const store = memoryAccountStore();
    const [first, second] = await Promise.all([store.key(), store.key()]);
    expect(second).toBe(first);
    expect(first.private_key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", first.private_key)).rejects.toThrow();
  });

  it("lives in its own database: the service worker opens only ovis-relay, at the version the shell does", () => {
    const root = join(import.meta.dir, "../../..");
    const opens = (file: string) => [...readFileSync(join(root, file), "utf8").matchAll(/indexedDB\.open\(([^)]*)\)/g)].map(([, args]) => args);
    expect(opens("public/sw.js")).toEqual(['"ovis-relay", 2']);
    expect(opens("src/lib/relay/device.ts")).toEqual(['"ovis-relay", 2']);
    expect(opens("src/lib/account/store.ts")).toEqual(["DATABASE, 1"]);
  });
});

describe("My PCs", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const recent = new Date(now - 60_000).toISOString();
  const stale = new Date(now - OFFLINE_AFTER_MS - 1).toISOString();

  it("marks a listed PC this device is not paired with as needing approval, and keeps a paired PC the account does not list", () => {
    const rows = myPcs([{ server_id: PC_B, label: "nuc", added_at: recent, last_seen_at: recent, public_key: null, relay: null }], [paired(PC_A, "p620")], { now });
    expect(rows.map(({ name, state, listed }) => [name, state, listed])).toEqual([["p620", "paired", false], ["nuc", "needs-approval", true]]);
  });

  it("calls a PC offline once it stops coming by the service, and never one it has not seen", () => {
    const rows = myPcs([
      { server_id: PC_A, label: "p620", added_at: recent, last_seen_at: stale, public_key: null, relay: null },
      { server_id: PC_B, label: "nuc", added_at: recent, last_seen_at: null, public_key: null, relay: null },
    ], [paired(PC_A, "p620"), paired(PC_B, "nuc")], { now });
    expect(rows.map(({ name, state }) => [name, state])).toEqual([["nuc", "paired"], ["p620", "offline"]]);
  });

  it("offers to compare digits with a listed PC only when its key is the one its id comes from", async () => {
    const { deriveServerId } = await import("../../../shared/relay-server-proof.ts");
    const { generateKeyPair } = await import("../../../shared/relay-e2ee.ts");
    const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const real = generateKeyPair().publicKey;
    const other = generateKeyPair().publicKey;
    const id = deriveServerId(real);
    const listed = (key: Uint8Array) => myPcs([{ server_id: id, label: "nuc", added_at: recent, last_seen_at: recent, public_key: hex(key), relay: "wss://relay.example" }], [], { now })[0];
    expect(listed(real)?.join?.relay).toBe("wss://relay.example");
    // a directory that hands out another key for this id gets no way in
    expect(listed(other)?.join).toBeUndefined();
  });

  it("says a PC needs an update when its Ovis has no accounts", () => {
    const rows = myPcs([], [paired(PC_A, "p620")], { now, outdated: new Set([PC_A]) });
    expect(rows[0]?.state).toBe("needs-update");
  });

  it("names a paired PC by its own name, never the directory's label, even when it has none", () => {
    const rows = myPcs([{ server_id: PC_A, label: "renamed by anyone", added_at: recent, last_seen_at: recent, public_key: null, relay: null }], [paired(PC_A, "p620")], { now });
    expect(rows[0]?.name).toBe("p620");
    const { name: _unnamed, ...nameless } = paired(PC_A, "p620");
    expect(myPcs([{ server_id: PC_A, label: "renamed by anyone", added_at: recent, last_seen_at: recent, public_key: null, relay: null }], [nameless], { now })[0]?.name).toBe(PC_A.slice(0, 8));
  });
});
