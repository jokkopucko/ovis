import { describe, expect, it, setSystemTime } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { nativeSignIn, NATIVE_REDIRECT } from "./native.ts";
import { AccountService } from "./service.ts";
import { beginSignIn, finishOwnSignIn } from "./signin.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";
const AT = "2026-11-27T09:42:00.000Z";

async function setup(accessTokenTtlS?: number) {
  const fake = new FakeAccountService(Date.now, accessTokenTtlS);
  const store = memoryAccountStore();
  const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT });
  const callback = new URL((await fake.fetch(start)).headers.get("location") ?? "").hash;
  const before = await finishOwnSignIn(start, callback, { store, fetch: fake.fetch });
  return { fake, store, before };
}

describe("sign-in methods", () => {
  it("reads valid history and drops unknown or malformed history entries", async () => {
    const { store } = await setup();
    const add = { kind: "add", provider: "github", at: AT, device_no: 2 } as const;
    const remove = { kind: "remove", provider: "apple", at: "2026-11-27T09:42:00.000Z", device_no: null } as const;
    const merge = { kind: "merge_in", provider: "google", at: AT, device_no: 1 } as const;
    const identities = [{ provider: "github" as const, added_at: AT }];
    const service = new AccountService({ store, fetch: async () => Response.json({ identities, history: [
      add, { ...add, kind: "future" }, remove, { ...add, provider: "future" }, { ...add, at: "yesterday" },
      { ...add, at: "2026-02-30T09:42:00.000Z" }, { ...add, device_no: "2" }, { ...add, device_no: 2.5 },
      { ...add, device_no: undefined }, null, merge,
    ] }) });

    expect(await service.identities()).toEqual({ identities, history: [add, remove, merge] });
  });

  it("reads an older identity response with no history as an empty history", async () => {
    const { store } = await setup();
    const identities = [{ provider: "github" as const, added_at: AT }];
    const service = new AccountService({ store, fetch: async () => Response.json({ identities }) });

    expect(await service.identities()).toEqual({ identities, history: [] });
  });

  it("adds Apple through the iOS linking sheet even if the access token expires while it is open", async () => {
    const { fake, store, before } = await setup(120);
    const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (plugin: string, method: string, options: { url: string }) => {
        expect([plugin, method]).toEqual(["OvisAuth", "authenticate"]);
        const url = new URL(options.url);
        expect(url.searchParams.get("link_token")).toBeTruthy();
        expect(url.searchParams.get("redirect_uri")).toBe(NATIVE_REDIRECT);
        setSystemTime(new Date(before.expires_at + 1));
        return { url: (await fake.fetch(url)).headers.get("location") };
      },
    } });
    try {
      const started = await service.startMethodLink("apple");
      const redeemed = await nativeSignIn("apple", { store, service: SERVICE, fetch: fake.fetch, link: started });
      expect(await store.get("session")).toMatchObject({ sign_in_id: before.sign_in_id, provider: "github" });
      const after = await service.installMethodLink(started, redeemed);
      expect(after).toMatchObject({ account: before.account, provider: "apple" });
    } finally {
      setSystemTime();
      if (capacitor === undefined) Reflect.deleteProperty(globalThis, "Capacitor");
      else Object.defineProperty(globalThis, "Capacitor", capacitor);
    }
  });
});
