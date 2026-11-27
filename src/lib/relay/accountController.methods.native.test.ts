import { expect, it } from "bun:test";
import { WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { openPage } from "../page.fixture.ts";
import { setup } from "./accountController.methods.test-helpers.ts";

it.each(["unchanged", "same account", "another account", "cancelled"] as const)("only finishes a phone Add for the asking sign-in (%s)", async (change) => {
  const browser = openPage(WEB_REDIRECT);
  const { fake, store, before, controller, signIn, service } = await setup();
  const page = controller();
  const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
  Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
    isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }],
    nativePromise: async (_plugin: string, _method: string, { url }: { url: string }) => {
      if (change === "cancelled") throw new DOMException("Closed", "AbortError");
      if (change === "another account") fake.signInAs("github", "acct_other");
      if (change !== "unchanged") await signIn("github");
      return { url: (await fake.fetch(url)).headers.get("location") };
    },
  } });
  try {
    await page.addMethod("apple", before);

    const tokens = fake.requests.filter((request) => request === "POST /v1/token");
    expect(tokens).toHaveLength(change === "cancelled" ? 1 : 2);
    expect(Object.keys(await store.get("pending") ?? {})).toEqual([]);
    const providers = (await service.identities()).identities.map(({ provider }) => provider).sort();
    expect(providers).toEqual(change === "unchanged" ? ["apple", "github"] : ["github"]);
    if (change === "unchanged") {
      const installed = await store.get("session");
      expect(installed?.provider).toBe("apple");
      expect(page.openKey).toMatchObject({ account: before.account, sign_in_id: installed?.sign_in_id, no: 1 });
    }
  } finally {
    if (capacitor === undefined) Reflect.deleteProperty(globalThis, "Capacitor");
    else Object.defineProperty(globalThis, "Capacitor", capacitor);
    page.dispose();
    await browser.close();
  }
});
