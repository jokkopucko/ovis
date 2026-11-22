import { describe, expect, it } from "bun:test";
import { exportAccountKey, registerSigningBytes } from "../../../shared/account-records.ts";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { AccountService, AccountServiceError, SignedOutError } from "./service.ts";
import { signInKey } from "./signInKey.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The account service's S2-19 routes, in front of the fake: a challenge per sign-in, one key per sign-in, a key once per account. */
function withDeviceRoutes(fake: FakeAccountService, options: { opensAll: boolean }) {
  const challenges = new Map<string, string>();
  const registered: { key: string; signature: string; challenge_id: string; challenge: string }[] = [];
  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.pathname.startsWith("/v1/devices")) return fake.fetch(input, init);
    if (!options.opensAll) return Response.json({ error: "not_found", message: "Unknown request" }, { status: 404 });
    if (url.pathname === "/v1/devices/challenge") {
      const id = crypto.randomUUID().replaceAll("-", "");
      challenges.set(id, `challenge-${id}`);
      return Response.json({ challenge_id: id, challenge: `challenge-${id}`, expires_in: 60 });
    }
    const body = JSON.parse(String(init?.body)) as { challenge_id: string; key: string; signature: string };
    const challenge = challenges.get(body.challenge_id) ?? "";
    challenges.delete(body.challenge_id);
    if (registered.length > 0 && registered[0]!.key !== body.key) return Response.json({ error: "session_has_key", message: "no" }, { status: 409 });
    registered.push({ ...body, challenge });
    return Response.json({ no: 3, key: body.key });
  };
  return { fetch, registered };
}

async function signedIn(fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>, fake: FakeAccountService, store = memoryAccountStore()) {
  fake.signInAs("github", "acct_1");
  const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  await finishSignIn(returned!, { store, fetch });
  return new AccountService({ store, fetch, lock: memoryLock() });
}

async function deviceKey() {
  const pair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_key: pair.publicKey, public_spki: await exportAccountKey(pair.publicKey) };
}

describe("registering this sign-in's device key", () => {
  it("T34: proves the key by signing this sign-in's challenge and gets its place in the account's order", async () => {
    const fake = new FakeAccountService();
    const routes = withDeviceRoutes(fake, { opensAll: true });
    const service = await signedIn(routes.fetch, fake);
    const key = await deviceKey();
    expect(await service.registerDeviceKey(key)).toEqual({ no: 3, key: key.public_spki });
    const [sent] = routes.registered;
    const bytes = registerSigningBytes("acct_1", key.public_spki, sent!.challenge_id, sent!.challenge);
    const signature = Uint8Array.from(atob(sent!.signature.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.public_key, signature, bytes)).toBe(true);
  });

  it("G5: a service with the release off answers nothing to register, and the QR or digits path stays", async () => {
    const fake = new FakeAccountService();
    const service = await signedIn(withDeviceRoutes(fake, { opensAll: false }).fetch, fake);
    expect(await service.registerDeviceKey(await deviceKey())).toBeNull();
  });

  it("T40: a sign-in that registered a key cannot move to another one", async () => {
    const fake = new FakeAccountService();
    const service = await signedIn(withDeviceRoutes(fake, { opensAll: true }).fetch, fake);
    await service.registerDeviceKey(await deviceKey());
    await expect(service.registerDeviceKey(await deviceKey())).rejects.toBeInstanceOf(AccountServiceError);
  });
});


describe("this sign-in's own key", () => {
  it("T34, P18: a sign-in makes its own key, apart from the account key, registers it once and keeps its number", async () => {
    const fake = new FakeAccountService();
    const routes = withDeviceRoutes(fake, { opensAll: true });
    const store = memoryAccountStore();
    const service = await signedIn(routes.fetch, fake, store);
    const first = await signInKey(store, service);
    expect(first?.no).toBe(3);
    expect(first?.key.public_spki).not.toBe((await store.key()).public_spki);
    expect((await signInKey(store, service))?.key.public_spki).toBe(first!.key.public_spki);
    expect(routes.registered).toHaveLength(1);
  });

  it("P18: when the service took the key but its answer was lost, the retry registers that same key, never a second one", async () => {
    const fake = new FakeAccountService();
    const routes = withDeviceRoutes(fake, { opensAll: true });
    let lose = true;
    const lossy = async (input: Request | string | URL, init?: RequestInit) => {
      const answer = await routes.fetch(input, init);
      if (lose && new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/devices") { lose = false; throw new TypeError("connection lost"); }
      return answer;
    };
    const store = memoryAccountStore();
    const service = await signedIn(lossy, fake, store);
    await expect(signInKey(store, service)).rejects.toThrow();
    const kept = await signInKey(store, service);
    expect(kept?.no).toBe(3);
    expect(new Set(routes.registered.map((entry) => entry.key))).toEqual(new Set([kept!.key.public_spki]));
  });

  it("P18: two calls at once for one sign-in register one key", async () => {
    const fake = new FakeAccountService();
    const routes = withDeviceRoutes(fake, { opensAll: true });
    const store = memoryAccountStore();
    const service = await signedIn(routes.fetch, fake, store);
    const [one, two] = await Promise.all([signInKey(store, service), signInKey(store, service)]);
    expect(one!.key.public_spki).toBe(two!.key.public_spki);
    expect(new Set(routes.registered.map((entry) => entry.key)).size).toBe(1);
  });

  it("P21: a new sign-in gets a new key, since a key registers once per account", async () => {
    const fake = new FakeAccountService();
    const store = memoryAccountStore();
    const before = await signInKey(store, await signedIn(withDeviceRoutes(fake, { opensAll: true }).fetch, fake, store));
    const after = await signInKey(store, await signedIn(withDeviceRoutes(fake, { opensAll: true }).fetch, fake, store));
    expect(after!.key.public_spki).not.toBe(before!.key.public_spki);
  });

  it("T34, P18: an old tab cannot overwrite the key registered by a newer sign-in", async () => {
    const fake = new FakeAccountService();
    const store = memoryAccountStore();
    const oldService = await signedIn(withDeviceRoutes(fake, { opensAll: true }).fetch, fake, store);
    const readKey = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const oldTab: typeof store = {
      ...store,
      async get(name) {
        const value = await store.get(name);
        if (name === "signin_key") {
          readKey.resolve();
          await resume.promise;
        }
        return value;
      },
    };
    const stale = signInKey(oldTab, oldService).catch((error: unknown) => error);
    await readKey.promise;
    const newService = await signedIn(withDeviceRoutes(fake, { opensAll: true }).fetch, fake, store);
    const newer = await signInKey(store, newService);
    resume.resolve();
    expect(await stale).toBeInstanceOf(SignedOutError);
    if (newer === null) throw new TypeError("The new sign-in did not register");
    expect(newer.no).toBe(3);
    expect(await store.get("signin_key")).toEqual(newer);
  });

  it("G5: with the release off nothing is made or kept", async () => {
    const fake = new FakeAccountService();
    const store = memoryAccountStore();
    expect(await signInKey(store, await signedIn(withDeviceRoutes(fake, { opensAll: false }).fetch, fake, store))).toBeNull();
    expect(await store.get("signin_key")).toBeUndefined();
  });
});
