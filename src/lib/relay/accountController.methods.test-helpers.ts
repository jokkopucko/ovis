import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { AccountService } from "../account/service.ts";
import { beginSignIn, finishOwnSignIn } from "../account/signin.ts";
import { memoryAccountStore, type AccountProvider } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";

export const SERVICE = "https://account.example";
export const noDevices: ShellDeviceStore = {
  async get() { return undefined; }, async list() { return []; }, async remove() {}, async removeRow() { return false; },
  async update(_id, change) { return change(undefined); },
};

export async function setup(now: () => number = Date.now, accessTokenTtlS?: number) {
  const fake = new FakeAccountService(now, accessTokenTtlS);
  fake.signInAs("github", "acct_1");
  const store = memoryAccountStore();
  const service = new AccountService({ store, fetch: fake.fetch });
  const accountFetch: typeof fake.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/devices/challenge") return Response.json({ challenge_id: "challenge-1", challenge: "device-key" });
    if (path === "/v1/devices") {
      const { key } = await request.json();
      const token = request.headers.get("authorization")?.slice("Bearer ".length);
      if (typeof key !== "string" || token === undefined) throw new Error("missing key proof");
      return Response.json({ no: fake.registerSessionKey(token, key, "Test phone"), key });
    }
    return fake.fetch(input, init);
  };
  const callback = async (url: string) => new URL((await fake.fetch(url)).headers.get("location") ?? "").hash;
  const signIn = async (provider: AccountProvider) => {
    const url = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT });
    return finishOwnSignIn(url, await callback(url), { store, fetch: fake.fetch });
  };
  const before = await signIn("github");
  const controller = (openSignIn?: (url: string) => void) => createAccountController({
    container: Object.create(null), entryUrl: WEB_REDIRECT, label: "Test phone", store: noDevices, accountStore: store,
    accountService: SERVICE, accountFetch, renderApp: () => ({ render() {}, unmount() {} }),
    ...(openSignIn ? { openSignIn } : {}),
  }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
  return { fake, store, service, before, controller, signIn, callback };
}
