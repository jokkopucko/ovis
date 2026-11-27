import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LINK_TOKEN_TTL_S, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { keepShellAccount, shellAccountActions } from "../account/hostedSignIn.ts";
import { AccountService } from "../account/service.ts";
import { beginSignIn, signInReturn } from "../account/signin.ts";
import { noDevices, SERVICE, setup as signInSetup } from "./accountController.methods.test-helpers.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { mountRelayShell } from "./shell.tsx";
import { takePairingReturn } from "./shellState.ts";

const PC = "a".repeat(32);
async function setup(now: () => number = Date.now) {
  const signedIn = await signInSetup(now);
  const { before, fake, store, callback } = signedIn;
  // Drive a real OAuth return independently of the controller's start, so these cases can
  // distinguish sending a redemption from refusing one before it reaches the service.
  const pendingLink = async () => {
    if (before.sign_in_id === undefined) throw new Error("the sign-in has no id");
    const answer = await fake.fetch(`${SERVICE}/v1/identities/link`, {
      method: "POST", headers: { authorization: `Bearer ${before.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "google" }),
    });
    const { link_token } = await answer.json();
    if (typeof link_token !== "string") throw new Error("the service issued no link token");
    const url = await beginSignIn("google", {
      store, service: SERVICE, redirectUri: WEB_REDIRECT, linkToken: link_token,
      link: { account: before.account, sign_in_id: before.sign_in_id },
    });
    return signInReturn(await callback(url));
  };
  return { ...signedIn, pendingLink };
}

describe("linking sign-in methods in the hosted shell", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => { setSystemTime(); browser.dispose(); });

  it.each([
    { scope: "PC page", phase: "start" }, { scope: "QR pairing", phase: "start" },
    { scope: "PC page", phase: "return" }, { scope: "QR pairing", phase: "return" },
  ] as const)("keeps the existing sign-in and handles a method refusal ($scope, $phase)", async ({ scope, phase }) => {
    const { fake, store, before, callback } = await signInSetup();
    const { publicKey } = generateKeyPair();
    const serverId = deriveServerId(publicKey);
    const context = scope === "PC page" ? { pc: serverId } : {
      pairing: { at: Date.now(), offer: { v: 1 as const, server_id: serverId, server_public_key: exportPublicKey(publicKey), relay: "wss://relay.example", name: "Desk", code: "123456", admission: 1 as const } },
    };
    let params: string;
    if (phase === "start") {
      await store.set("session", undefined);
      fake.methodLinkRefusal = "merge_open";
      params = await callback(await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT, create: "never", thenAdd: "google", ...context }));
    } else {
      const link = await new AccountService({ store, fetch: fake.fetch }).forSignIn(before).startMethodLink("google");
      const url = await beginSignIn("google", {
        store, service: SERVICE, redirectUri: WEB_REDIRECT, generation: link.generation,
        linkToken: link.linkToken, link: { ...link.link, fromHint: true }, ...context,
      });
      params = `#error=identity_in_use&state=${new URL(url).searchParams.get("state")}`;
    }
    const navigations: string[] = [];
    let screen = "";
    try {
      await mountRelayShell({
        container: Object.create(null), entryUrl: `${WEB_REDIRECT}${params}`, shellVersion: "0.0.0-test", label: "Test phone", store: noDevices,
        renderApp: () => { throw new Error("the PC must not open"); },
        createRoot: () => ({ render(element) { screen = renderToStaticMarkup(element); }, unmount() {} }),
        navigate: (path) => { navigations.push(path); }, navigatedSinceEntry: () => false,
        open: () => Promise.reject(new Error("the PC must not connect")), checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
        accountService: SERVICE, accountStore: store, accountFetch: fake.fetch,
      });
      if (phase === "return" && "pairing" in context && context.pairing !== undefined) {
        expect(navigations).toHaveLength(1);
        expect(takePairingReturn(context.pairing.offer)).toMatchObject({ at: context.pairing.at, refused: null });
      } else {
        expect(screen).toContain(phase === "start" ? "Finish or cancel the account merge" : "This Google account is linked to another Ovis account.");
        expect(navigations).toEqual([]);
      }
      expect(await store.get("session")).toMatchObject({ account: before.account, provider: "github" });
    } finally { keepShellAccount(null); }
  });

  it("finishes a web link after the access token expires, then opens PCs with the new sign-in's key", async () => {
    setSystemTime(new Date());
    const { fake, store, before, controller, callback } = await signInSetup(Date.now, 120);
    const key = await store.key();
    if (before.sign_in_id === undefined) throw new Error("the sign-in has no id");
    const signInKey = { account: before.account, sign_in_id: before.sign_in_id, key, no: fake.registerSessionKey(before.access_token, key.public_spki, "Test phone") };
    await store.set("signin_key", signInKey);
    let went: string | undefined;
    const first = controller((url) => { went = url; });
    await first.load(null);
    expect(first.openKey).toEqual(signInKey);
    await first.addMethod("google", before, PC);
    first.dispose();
    if (went === undefined) throw new Error("the browser did not start the link");
    const state = new URL(went).searchParams.get("state") ?? "";
    expect((await store.get("pending"))?.[state]).toMatchObject({ pc: PC, link: { account: before.account, sign_in_id: before.sign_in_id } });
    setSystemTime(new Date(before.expires_at + 1));
    const returned = signInReturn(await callback(went));
    const second = controller();
    let resumed: string | undefined;
    let refused: string | null | undefined;
    await second.load(returned, undefined, (outcome) => { refused = outcome?.refused; }, (id) => { resumed = id; });

    expect(resumed).toBe(PC);
    expect(refused).toBeNull();
    expect(second.methodsChange).toEqual({ account: before.account, provider: "google", error: null });
    const installed = await store.get("session");
    if (installed === undefined) throw new Error("the linked sign-in was not installed");
    expect(installed).toMatchObject({ account: before.account, provider: "google" });
    expect(installed.access_token).not.toBe(before.access_token);
    expect(second.openKey).toMatchObject({ account: before.account, sign_in_id: installed.sign_in_id, no: 2 });
    expect(second.openKey?.key.public_spki).not.toBe(key.public_spki);
    const { identities, history } = await second.methods(installed);
    expect(identities.map(({ provider }) => provider).sort()).toEqual(["github", "google"]);
    expect(history).toEqual([{ kind: "add", provider: "google", at: expect.any(String), device_no: null }]);
  });

  it.each(["add", "remove"] as const)("does not %s a method for a replacement sign-in when the sheet showed the old one", async (action) => {
    const { fake, before, signIn, controller } = await setup();
    const opened: string[] = [];
    const page = controller((url) => { opened.push(url); });
    await page.load(null);
    fake.signInAs("google", "acct_other");
    await signIn("google");
    fake.signInAs("apple", "acct_other");
    const replacement = await signIn("apple");
    const requests = fake.requests.length;

    if (action === "add") await page.addMethod("github", before);
    else await page.removeMethod("google", before);

    expect(fake.requests.slice(requests)).not.toContain(action === "add" ? "POST /v1/identities/link" : "DELETE /v1/identities/google");
    expect(opened).toEqual([]);
    expect(page.methodsChange?.error).toBe("signed_out");
    expect(page.signedInAs).toEqual(replacement);
  });

  it("moves both tabs to the linked sign-in and revokes the family another tab refreshed", async () => {
    const { fake, before, store, controller, callback } = await setup();
    const urls: string[] = [];
    const first = controller((url) => { urls.push(url); });
    await first.addMethod("google", before);
    const [url] = urls;
    if (url === undefined) throw new Error("the browser did not start the link");
    const returned = signInReturn(await callback(url));
    const service = new AccountService({ store, fetch: fake.fetch, now: () => before.expires_at });
    await service.listPcs();
    const refreshed = await store.get("session");
    if (refreshed === undefined) throw new Error("the other tab did not refresh the sign-in");
    expect(refreshed.sign_in_id).toBe(before.sign_in_id);
    expect(refreshed.access_token).not.toBe(before.access_token);
    const otherTab = controller();
    await otherTab.load(null);
    expect(otherTab.signedInAs).toEqual(refreshed);

    await controller().load(returned);
    await otherTab.reread();

    const installed = await store.get("session");
    expect(installed?.provider).toBe("google");
    expect(otherTab.signedInAs).toEqual(installed);
    expect((await fake.fetch(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(401);
  });

  it.each(["acct_1", "acct_other"])("resumes the requested Add only if signing in again returns for the asking account (%s)", async (account) => {
    let now = Date.now();
    const { fake, before, controller, callback, service } = await setup(() => now);
    const opened: string[] = [];
    const first = controller((url) => { opened.push(url); });
    now += 11 * 60_000;
    expect(await first.addMethod("google", before, PC)).toBe(false);
    expect(first.methodsChange?.error).toBe("reauth_required");
    await first.signInAgainForMethod(before, "google", PC);
    const signInAgain = opened.shift();
    if (signInAgain === undefined) throw new Error("the browser did not start reauthentication");
    fake.signInAs("github", account);
    const resumedPc: string[] = [];
    const reloaded = controller((url) => { opened.push(url); });
    const continued = await reloaded.load(signInReturn(await callback(signInAgain)), undefined, undefined, (id) => { resumedPc.push(id); });

    if (account !== before.account) {
      expect(continued).toBeUndefined();
      expect(opened).toEqual([]);
      expect(resumedPc).toEqual([PC]);
      expect(fake.requests.filter((request) => request === "POST /v1/identities/link")).toHaveLength(1);
      return;
    }
    expect(continued).toBe(true);
    expect(reloaded.signedInAs).toMatchObject({ account, provider: "github" });
    expect(resumedPc).toEqual([]);
    expect(opened).toHaveLength(1);
    const [link] = opened;
    if (link === undefined) throw new Error("the browser did not resume Add");
    const finished = controller();
    await finished.load(signInReturn(await callback(link)));
    expect((await service.identities()).identities.map(({ provider }) => provider).sort()).toEqual(["github", "google"]);
  });

  it.each(["signed out", "another account", "another sign-in of the same account"])("never redeems a web link after %s replaces its sign-in", async (change) => {
    const { fake, store, service, signIn, controller, pendingLink } = await setup();
    const returned = await pendingLink();
    if (change === "signed out") await service.signOut();
    else if (change === "another account") {
      fake.signInAs("apple", "acct_other");
      await signIn("apple");
    } else await signIn("github");
    const replacement = await store.get("session");
    const requests = fake.requests.length;

    const reloaded = controller();
    await reloaded.load(returned);

    expect(fake.requests.slice(requests)).not.toContain("POST /v1/token");
    expect(await store.get("session")).toEqual(replacement);
    expect(reloaded.methodsChange).toEqual({ account: "acct_1", provider: "google", error: "signed_out" });
  });

  it("reports a web link's in_use refusal and keeps the existing account and methods", async () => {
    const { fake, store, before, service, signIn, controller, pendingLink } = await setup();
    fake.signInAs("google", "acct_other");
    await signIn("google");
    await store.set("session", before);
    const returned = await pendingLink();

    const reloaded = controller();
    await reloaded.load(returned);

    expect(reloaded.methodsChange).toEqual({ account: before.account, provider: "google", error: "in_use" });
    expect(await store.get("session")).toEqual(before);
    expect(await service.identities()).toMatchObject({ identities: [{ provider: "github" }], history: [] });
  });

  it.each(["identity_exists", "reauth_required"])("reports %s without leaving the page", async (error) => {
    let now = Date.now();
    const { before, store, controller } = await setup(() => now);
    if (error === "reauth_required") now += 11 * 60_000;
    const opened: string[] = [];
    const page = controller((url) => { opened.push(url); });
    const provider = error === "identity_exists" ? "github" : "google";

    await page.addMethod(provider, before);

    expect(page.methodsChange).toEqual({ account: before.account, provider, error });
    expect(opened).toEqual([]);
    expect(await store.get("session")).toEqual(before);
  });

  it("reports an expired web link without replacing the existing session", async () => {
    let now = Date.now();
    const { before, store, controller, callback } = await setup(() => now);
    let went: string | undefined;
    await controller((url) => { went = url; }).addMethod("google", before);
    if (went === undefined) throw new Error("the browser did not start the link");
    now += LINK_TOKEN_TTL_S * 1000;
    const reloaded = controller();

    await reloaded.load(signInReturn(await callback(went)));

    expect(reloaded.methodsChange).toEqual({ account: before.account, provider: "google", error: "expired" });
    expect(await store.get("session")).toEqual(before);
  });

  it.each([{ offered: ["github", "google", "apple"] }, { offered: [] }] as const)("hands Manage account the service's provider list ($offered), even when empty", async ({ offered }) => {
    const { fake, store } = await setup();
    fake.offerSignIns([...offered], []);
    try {
      await mountRelayShell({
        container: Object.create(null), entryUrl: WEB_REDIRECT, shellVersion: "0.0.0-test", label: "Test phone", store: noDevices,
        renderApp: () => ({ render() {}, unmount() {} }), createRoot: () => ({ render() {}, unmount() {} }),
        open: () => Promise.reject(new Error("no connection is expected here")), checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
        accountService: SERVICE, accountProviders: ["github"], accountStore: store, accountFetch: fake.fetch,
      });
      expect(await shellAccountActions()?.offered?.()).toEqual(offered);
    } finally {
      keepShellAccount(null);
    }
  });
});
