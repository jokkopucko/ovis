import { createShellTestPage } from "./shell.test.tsx";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";

import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import type { ShellDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";

const SERVICE = "https://account.ovis.sh";
const ACCOUNT = "acct-test";

async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}

describe("deleting the account from the hosted shell", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(() => { browser.dispose(); });

  const noDevices: ShellDeviceStore = {
    async get() { return undefined; }, async list() { return []; }, async remove() {}, async removeRow() { return false; },
    async update(_serverId, change) { return change(undefined); },
  };
  const shellProps = (element: ReactElement): RelayShellProps => {
    let node = element;
    while (node.type !== RelayShell) node = (node.props as { children: ReactElement }).children;
    return node.props as RelayShellProps;
  };
  const last = (): RelayShellProps => shellProps(rendered.at(-1)!);
  const accountView = () => { const { state } = last(); return state.kind === "list" || state.kind === "empty" ? state.account ?? null : null; };

  async function signedInShell(clock: () => number = Date.now, provider: "github" | "apple" = "github", onDelete?: (store: ReturnType<typeof memoryAccountStore>, fake: FakeAccountService) => Promise<void>, beforeDelete?: () => Promise<void>) {
    const fake = new FakeAccountService(clock);
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider, access_token: fake.issueToken(ACCOUNT), refresh_token: "refresh", expires_at: clock() + 3_600_000 });
    const mount: RelayShellMount = {
      container: {} as HTMLElement, entryUrl: "https://app.ovis.sh/", shellVersion: "0.0.0-test", label: "Test phone",
      renderApp: () => { throw new Error("the app is not expected here"); },
      createRoot: () => ({ render(element: ReactElement) { rendered.push(element); }, unmount() {} }),
      open: () => Promise.reject(new Error("no connection is expected here")),
      checkPc: async () => ({ kind: "offline", reason: "relay" }),
      reload: async () => {},
      accountService: SERVICE, accountProviders: ["github", "apple"], accountStore, store: noDevices,
      accountFetch: async (input, init) => {
        if (beforeDelete !== undefined && new Request(input, init).method === "DELETE") await beforeDelete();
        const answer = await fake.fetch(input, init);
        if (onDelete !== undefined && new Request(input, init).method === "DELETE") await onDelete(accountStore, fake);
        return answer;
      },
    };
    await mountRelayShell(mount);
    await until(() => accountView()?.kind === "signed-in", "the signed-in front page");
    return { fake, accountStore };
  }

  it("deletes the account at the service, signs this device out and says so", async () => {
    const { fake, accountStore } = await signedInShell();
    last().onDeleteAccount?.();
    await until(() => accountView()?.kind === "signed-out", "the signed-out front page");
    expect(fake.deleted(ACCOUNT)).toBe(true);
    expect(accountView()).toEqual({ kind: "signed-out", error: null, notice: "Your account was deleted." });
    expect(await accountStore.get("session")).toBeUndefined();
  });

  it("asks for a fresh sign-in in a browser when this one is over ten minutes old, and deletes nothing", async () => {
    let now = Date.now();
    const { fake, accountStore } = await signedInShell(() => now);
    now += 11 * 60_000;
    last().onDeleteAccount?.();
    await until(() => { const view = accountView(); return view?.kind === "signed-in" && view.deleteError !== undefined; }, "the refusal");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(accountView()).toMatchObject({ kind: "signed-in", error: null, deleteError: "To delete your account, sign out, sign in again, then delete it within ten minutes." });
    expect(await accountStore.get("session")).toBeDefined();
  });

  it("deletes only the sign-in on screen: another tab's sign-in to another account meanwhile is left alone", async () => {
    const { fake, accountStore } = await signedInShell();
    const shown = (await accountStore.get("session"))!;
    await accountStore.set("session", { ...shown, account: "acct-two", access_token: fake.issueToken("acct-two"), refresh_token: "refresh-two", sign_in_id: "another-sign-in" });
    const before = fake.requests.length;
    await (last().onDeleteAccount?.() as Promise<void> | undefined);
    expect(fake.requests.slice(before)).not.toContain("DELETE /v1/account");
    expect(fake.deleted("acct-two")).toBe(false);
    expect(accountView()).toMatchObject({ kind: "signed-in", error: null });
    expect((await accountStore.get("session"))?.account).toBe("acct-two");
  });

  it("shows the sign-in that took the deleted one's place while the delete was out, not a signed-out page", async () => {
    const { fake, accountStore } = await signedInShell(Date.now, "github", async (store, service) => {
      const mine = (await store.get("session"))!;
      await store.set("session", { ...mine, account: "acct-two", access_token: service.issueToken("acct-two"), refresh_token: "refresh-two", sign_in_id: "another-sign-in" });
    });
    last().onDeleteAccount?.();
    const readAfter = () => fake.requests.slice(fake.requests.indexOf("DELETE /v1/account") + 1).includes("GET /v1/pcs");
    await until(() => fake.deleted(ACCOUNT) && (accountView()?.kind === "signed-out" || (readAfter() && (accountView() as { pcs?: unknown }).pcs != null)), "the delete settled");
    expect(accountView()?.kind).toBe("signed-in");
    expect((await accountStore.get("session"))?.account).toBe("acct-two");
  });

  it("draws the signed-out page when another tab signed out before the press, and sends nothing", async () => {
    const { fake, accountStore } = await signedInShell();
    await accountStore.set("session", undefined);
    const before = fake.requests.length;
    await (last().onDeleteAccount?.() as Promise<void> | undefined);
    expect(fake.requests.slice(before)).not.toContain("DELETE /v1/account");
    expect(accountView()?.kind).toBe("signed-out");
  });

  it("after a delete whose answer was lost, the next press finds the sign-in gone: signed out, saying so, and the key kept", async () => {
    let deletes = 0;
    const { fake, accountStore } = await signedInShell(Date.now, "github", async () => {
      if (++deletes === 1) throw new TypeError("network connection lost");
    });
    const key = (await accountStore.key()).public_spki;
    await (last().onDeleteAccount?.() as Promise<void> | undefined);
    expect(fake.deleted(ACCOUNT)).toBe(true);
    expect(accountView()).toMatchObject({ kind: "signed-in", deleteError: "The account could not be deleted. Try again." });
    await (last().onDeleteAccount?.() as Promise<void> | undefined);
    expect(accountView()).toMatchObject({ kind: "signed-out", error: "Your sign-in ended. Sign in again to see every PC of your account." });
    expect(await accountStore.get("session")).toBeUndefined();
    // a 401 is no proof the account went: the key stays rather than risk a live account's
    expect((await accountStore.key()).public_spki).toBe(key);
  });

  it("keeps the key of an account that still exists: a delete that never left the device, then a sign-out in another tab", async () => {
    let deletes = 0;
    const { fake, accountStore } = await signedInShell(Date.now, "github", undefined, async () => {
      if (++deletes === 1) throw new TypeError("offline");
    });
    const key = (await accountStore.key()).public_spki;
    await (last().onDeleteAccount?.() as Promise<void> | undefined);
    expect(fake.deleted(ACCOUNT)).toBe(false);
    await accountStore.set("session", undefined);
    await (last().onDeleteAccount?.() as Promise<void> | undefined);
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(accountView()).toMatchObject({ kind: "signed-out", error: "Your sign-in ended. Sign in again to see every PC of your account." });
    expect((await accountStore.key()).public_spki).toBe(key);
  });

  describe("in the phone app, with a sign-in over ten minutes old", () => {
    const savedFetch = globalThis.fetch;
    afterEach(() => { Reflect.deleteProperty(globalThis, "Capacitor"); globalThis.fetch = savedFetch; });
    const nativeSignInTo = (fake: FakeAccountService, to: string): Promise<void> => {
      const tokened = Promise.withResolvers<void>();
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }], nativePromise: async () => ({ idToken: "apple-id-token" }) } });
      globalThis.fetch = Object.assign(async () => { tokened.resolve(); return Response.json({ access_token: fake.issueToken(to), refresh_token: `refresh-${to}`, expires_in: 3600, account: to, provider: "apple" }); }, { preconnect: savedFetch.preconnect });
      return tokened.promise;
    };

    it("signs in again in place with the same method and deletes the same account", async () => {
      let now = Date.now();
      const { fake, accountStore } = await signedInShell(() => now, "apple");
      now += 11 * 60_000;
      const tokened = nativeSignInTo(fake, ACCOUNT);
      last().onDeleteAccount?.();
      await tokened;
      await until(() => accountView()?.kind === "signed-out", "the signed-out front page");
      expect(fake.deleted(ACCOUNT)).toBe(true);
      expect(fake.requests.filter((line) => line === "DELETE /v1/account")).toHaveLength(2);
      expect(await accountStore.get("session")).toBeUndefined();
    });

    it("signs in again over nothing another tab stored after the refusal, and deletes nothing", async () => {
      let now = Date.now();
      const { fake, accountStore } = await signedInShell(() => now, "apple", async (store, service) => {
        const mine = (await store.get("session"))!;
        await store.set("session", { ...mine, account: "acct-two", access_token: service.issueToken("acct-two"), refresh_token: "refresh-two", sign_in_id: "another-sign-in" });
      });
      now += 11 * 60_000;
      const tokened = nativeSignInTo(fake, ACCOUNT);
      let signedInAgain = false;
      void tokened.then(() => { signedInAgain = true; });
      await (last().onDeleteAccount?.() as Promise<void> | undefined);
      expect(signedInAgain).toBe(false);
      expect(accountView()).toMatchObject({ kind: "signed-in", error: null });
      expect(fake.deleted(ACCOUNT)).toBe(false);
      expect(fake.deleted("acct-two")).toBe(false);
      expect((await accountStore.get("session"))?.account).toBe("acct-two");
    });

    it("calls the delete off when the person signs out while the sign-in sheet is open: its answer deletes and stores nothing", async () => {
      let now = Date.now();
      const { fake, accountStore } = await signedInShell(() => now, "apple");
      now += 11 * 60_000;
      const sheet = Promise.withResolvers<{ idToken: string }>();
      const opened = Promise.withResolvers<void>();
      const tokened = Promise.withResolvers<void>();
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }], nativePromise: () => { opened.resolve(); return sheet.promise; } } });
      globalThis.fetch = Object.assign(async () => { tokened.resolve(); return Response.json({ access_token: fake.issueToken(ACCOUNT), refresh_token: "refresh-again", expires_in: 3600, account: ACCOUNT, provider: "apple" }); }, { preconnect: savedFetch.preconnect });
      let settled = false;
      const done = (last().onDeleteAccount?.() as Promise<void> | undefined);
      void done?.then(() => { settled = true; });
      await opened.promise;
      last().onSignOut?.();
      await until(() => accountView()?.kind === "signed-out", "the signed-out front page");
      sheet.resolve({ idToken: "apple-id-token" });
      await tokened.promise;
      await until(() => settled, "the delete to end");
      expect(fake.requests.filter((line) => line === "DELETE /v1/account")).toHaveLength(1);
      expect(fake.deleted(ACCOUNT)).toBe(false);
      expect(await accountStore.get("session")).toBeUndefined();
      expect(accountView()).toMatchObject({ kind: "signed-out", error: null });
    });

    it("calls the delete off when the person signs out while the sign-in again is being stored", async () => {
      let now = Date.now();
      const { fake, accountStore } = await signedInShell(() => now, "apple");
      now += 11 * 60_000;
      let armed = false;
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const update = accountStore.update.bind(accountStore);
      accountStore.update = (async (name, change) => {
        if (name === "session" && armed) { armed = false; reached.resolve(); await gate.promise; }
        return update(name, change);
      }) as typeof accountStore.update;
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }], nativePromise: async () => ({ idToken: "apple-id-token" }) } });
      globalThis.fetch = Object.assign(async () => { armed = true; return Response.json({ access_token: fake.issueToken(ACCOUNT), refresh_token: "refresh-again", expires_in: 3600, account: ACCOUNT, provider: "apple" }); }, { preconnect: savedFetch.preconnect });
      const done = last().onDeleteAccount?.() as Promise<void> | undefined;
      await reached.promise;
      last().onSignOut?.();
      gate.resolve();
      await done;
      expect(fake.requests.filter((line) => line === "DELETE /v1/account")).toHaveLength(1);
      expect(fake.deleted(ACCOUNT)).toBe(false);
      expect((await accountStore.get("session"))?.refresh_token).not.toBe("refresh-again");
    });

    it("deletes nothing when the sign-in again lands in another account", async () => {
      let now = Date.now();
      const { fake } = await signedInShell(() => now, "apple");
      now += 11 * 60_000;
      const tokened = nativeSignInTo(fake, "acct-other");
      last().onDeleteAccount?.();
      await tokened;
      await until(() => { const view = accountView(); return view?.kind === "signed-in" && view.deleteError !== undefined; }, "the refusal");
      expect(fake.deleted(ACCOUNT)).toBe(false);
      expect(fake.deleted("acct-other")).toBe(false);
      expect(accountView()).toMatchObject({ error: null, deleteError: "You signed in to another account. Nothing was deleted." });
    });
  });

  it("says to cancel a subscription that still renews first", async () => {
    const { fake } = await signedInShell();
    fake.subscribe(ACCOUNT);
    last().onDeleteAccount?.();
    await until(() => { const view = accountView(); return view?.kind === "signed-in" && view.deleteError !== undefined; }, "the refusal");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(accountView()).toMatchObject({ kind: "signed-in", error: null, deleteError: "Cancel your subscription first, then delete the account." });
  });
});
