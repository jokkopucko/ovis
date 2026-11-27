import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { AccountService } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";

import { AccountSection } from "./AccountSection.tsx";

// Signing in on a PC's own page adds the PC in the same step (docs/account.md, "Adding a PC"): the sign-in
// that finishes on this screen lists the PC and waits; one that was already there only offers the button.
const SERVICE = "https://account.ovis.example";
const ACCOUNT = "acct_one";
const MARKER = "ovis-add-pc-waiting";
const publicKey = exportPublicKey(generateKeyPair().publicKey);
const SERVER = deriveServerId(importPublicKey(publicKey));
const OFFER = encodeOffer({ v: 1, server_id: SERVER, server_public_key: publicKey, relay: "wss://relay.ovis.example", name: "desk" }, "https://app.ovis.example");

describe("signing in on a PC's own page", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let fake: FakeAccountService;
  let pcAccount: string | null;
  let asked: { path: string; localOnly: boolean }[];
  let userCode: string | null;
  let approveWith: "github" | "google";
  let ahead: number;
  let relay: "online" | "off";
  let role: "drive" | "watch";
  let statusHangs: boolean;
  let refuses: boolean;
  let ended: AccountSession | undefined;
  let directoryWrites: string[];
  let boundOnDirectoryRead: boolean;
  let membershipGate: { afterToken: boolean; requested: boolean; answered: boolean; release: Promise<void> } | undefined;

  beforeEach(() => {
    ahead = 0;
    relay = "online";
    role = "drive";
    statusHangs = false;
    refuses = false;
    ended = undefined;
    approveWith = "github";
    fake = new FakeAccountService(() => Date.now() + ahead);
    fake.offerLinkPage(["github", "google"]);
    pcAccount = null;
    asked = [];
    directoryWrites = [];
    boundOnDirectoryRead = false;
    membershipGate = undefined;
    userCode = null;
    page = openPage("https://workstation.example.ts.net/");
    Object.defineProperty(page.window, "isSecureContext", { configurable: true, value: true });
    for (const key of ["indexedDB", "location", "HTMLElement", "Event", "CustomEvent"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "Event", { configurable: true, value: page.window.Event });
    Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: page.window.CustomEvent });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "location", { configurable: true, value: page.window.location });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
    Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36" });
    const meta = page.window.document.createElement("meta");
    meta.name = "ovis-pc-account-service";
    meta.content = SERVICE;
    page.window.document.head.append(meta);
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net");
      if (url.origin !== SERVICE) {
        asked.push({ path: url.pathname, localOnly: new Headers(input instanceof Request ? input.headers : init?.headers).get("x-ovis-local-only") === "1" });
        if (url.pathname === "/api/account/status" && statusHangs) return new Promise<Response>(() => {});
        if (url.pathname === "/api/relay") return Response.json({ phase: relay, relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
        if (url.pathname === "/api/relay/start") { relay = "online"; return Response.json({ phase: "connecting", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null }); }
        if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, auth: { required: false, authenticated: true, via: "loopback", role }, security: { pairing_gate: "closed", token_configured: false } });
        if (url.pathname === "/api/relay/link" && relay === "off") return Response.json({ error: { code: "relay_off", message: "Start the relay before pairing." } }, { status: 409 });
        if (url.pathname === "/api/account/status") {
          if (membershipGate?.afterToken) {
            membershipGate.requested = true;
            await membershipGate.release;
            membershipGate.answered = true;
          }
          return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
        }
        if (url.pathname === "/api/relay/link") return Response.json({ url: OFFER, window_id: "1".repeat(32) });
        if (url.pathname === "/api/relay/link/close") return Response.json({ ok: true });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      if (refuses) {
        ended ??= await indexedAccountStore.get("session");
        return Response.json({ error: { code: "unauthorized", message: "Sign in again" } }, { status: 401 });
      }
      if (url.pathname === "/v1/token" && userCode !== null) {
        fake.approveOnLinkPage(userCode, ACCOUNT, approveWith);
        fake.approveDevice(userCode, ACCOUNT);
        userCode = null;
        if (membershipGate) membershipGate.afterToken = true;
      }
      const method = input instanceof Request ? input.method : init?.method ?? "GET";
      if (url.pathname === `/v1/pcs/${SERVER}` && (method === "DELETE" || method === "PUT")) directoryWrites.push(method);
      if (url.pathname === "/v1/pcs" && method === "GET" && boundOnDirectoryRead) {
        boundOnDirectoryRead = false;
        pcAccount = ACCOUNT;
      }
      const answer = await fake.fetch(input, init);
      if (!url.pathname.startsWith("/v1/signin/") || !answer.ok) return answer;
      const started = await answer.json() as Record<string, unknown>;
      userCode = String(started["user_code"]);
      return Response.json({ ...started, interval: 0.001 });
    };
    setTransport({ ...nativeTransport, fetch: fetch as typeof nativeTransport.fetch });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await page.close();
    setTransport(nativeTransport);
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: { textContent: string | null }): string => node.textContent ?? "";
  const buttons = (): string[] => [...document.body.querySelectorAll<HTMLButtonElement>("button")].map(text);
  const until = async (shown: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 400 && !shown(); turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(shown()).toBe(true);
  };
  const mount = async (): Promise<void> => {
    await page.render(<SettingsProvider><AccountSection /></SettingsProvider>);
  };
  const recheck = async (count: number): Promise<void> => {
    await page.render(<SettingsProvider><AccountSection recheck={count} /></SettingsProvider>);
  };
  const press = async (label: string): Promise<void> => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((node) => text(node) === label);
    expect(found).toHaveLength(1);
    await act(async () => { found[0]?.click(); });
  };
  /** the one button that also turns the relay on: it reads like the plain one, and is marked apart */
  const relayButtons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button[data-relay="off"]')];
  const links = (): { path: string; localOnly: boolean }[] => asked.filter((request) => request.path === "/api/relay/link");

  it("lists the PC and waits once the sign-in finishes, with no second press, and only then", async () => {
    await mount();
    await until(() => buttons().includes("Sign in and add this PC"));
    expect(links()).toHaveLength(0);
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    expect((await indexedAccountStore.get("session"))?.account).toBe(ACCOUNT);
    expect(text(document.body)).toContain("On another device of your account, choose Add on desk.");
    // listed once in the account's directory, behind a window only this PC approves; the relay was not asked to start
    expect(links()).toEqual([{ path: "/api/relay/link", localOnly: true }]);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect((await new AccountService({ store: indexedAccountStore }).listPcs()).map((pc) => pc.server_id)).toEqual([SERVER]);
    expect(JSON.parse(page.window.sessionStorage.getItem(MARKER)!)).toMatchObject({ name: "desk", serverId: SERVER, account: ACCOUNT });

    await press("Stop waiting");
    await until(() => asked.some((request) => request.path === "/api/relay/link/close"));
    expect(buttons()).toContain("Add this PC to my account");

    await page.render(null);
    const before = asked.length;
    await mount();
    await until(() => buttons().includes("Add this PC to my account"));
    expect(text(document.body)).not.toContain("Signed in. Adding this PC to your account…");
    expect(asked.slice(before).map((request) => request.path).filter((path) => path !== "/api/account/status" && path !== "/api/health")).toEqual([]);
  });

  it.each([true, false])("retrying a stale listing uses the local binding at write time (bound: %s)", async (bound) => {
    // an account service from before listings had IDs: a stale invitation is renewed by listing the PC again
    fake.completions = false;
    await mount();
    await until(() => buttons().includes("Sign in and add this PC"));
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    await press("Stop waiting");

    const service = new AccountService({ store: indexedAccountStore });
    const [listed] = await service.listPcs();
    // Start with an actually stale row in the fake: the browser and service use the same time for this retry.
    const realNow = Date.now;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60_000);
    try {
      directoryWrites.length = 0;
      boundOnDirectoryRead = bound;
      await press("Add this PC to my account");
      await until(() => text(document.body).includes("Added") || buttons().includes("Stop waiting"));
      expect(directoryWrites).toEqual(bound ? [] : ["DELETE", "PUT"]);
      const [after] = await service.listPcs();
      expect(after?.server_id).toBe(SERVER);
      if (bound) {
        expect(after?.added_at).toBe(listed?.added_at);
        expect(pcAccount).toBe(ACCOUNT);
        expect(text(document.body)).toContain("Added");
        expect(buttons()).not.toContain("Stop waiting");
      } else {
        expect(Date.parse(after?.added_at ?? "")).toBeGreaterThan(Date.parse(listed?.added_at ?? ""));
        expect(buttons()).toContain("Stop waiting");
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("a sign-in again for the same account, to change its sign-in methods, lists nothing by itself", async () => {
    await mount();
    await until(() => buttons().includes("Sign in and add this PC"));
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    await press("Stop waiting");
    await press("Sign out");
    await until(() => buttons().includes("Sign in and add this PC"));
    approveWith = "google";
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    await press("Stop waiting");
    await until(() => buttons().includes("Manage account"));
    await press("Manage account");
    await until(() => buttons().includes("Remove GitHub"));

    // later than the service takes a sign-in for recent: removing a method asks for a sign-in again
    ahead = 11 * 60_000;
    await press("Remove GitHub");
    await until(() => buttons().includes("Sign in again"));
    const before = asked.length;
    await press("Sign in again");
    // The list must reflect the completed removal, not the empty state while reloading.
    await until(() => {
      const screen = text(document.body);
      return screen.includes("Google, connected") && !screen.includes("GitHub, connected") && buttons().includes("Add this PC to my account");
    });
    expect(buttons()).not.toContain("Stop waiting");
    expect(text(document.body)).not.toContain("Signed in. Adding this PC to your account…");
    // Manage account's own device list reads this PC's devices; nothing writes to the PC or lists it
    expect(asked.slice(before).map((request) => request.path).filter((path) => path !== "/api/account/status" && path !== "/api/health" && path !== "/api/devices")).toEqual([]);
  });

  it("says only Sign in on a PC already in an account, and adds nothing after it", async () => {
    pcAccount = "acct_other";
    await mount();
    await until(() => buttons().includes("Sign in"));
    expect(buttons()).not.toContain("Sign in and add this PC");
    const { promise, resolve } = Promise.withResolvers<void>();
    const gate = { afterToken: false, requested: false, answered: false, release: promise };
    membershipGate = gate;
    await press("Sign in");
    await until(() => buttons().includes("Sign out") && gate.requested);
    // Deliver the post-sign-in membership answer. Everything after it (this fake fetch, the answer's body, the fake
    // IndexedDB session read, the state update) is microtasks only, so once a setImmediate runs the answer is applied.
    await act(async () => { resolve(); await new Promise<void>((done) => { setImmediate(done); }); });
    expect(gate.answered).toBe(true);
    expect(links()).toHaveLength(0);
    expect(buttons()).not.toContain("Stop waiting");
    expect(buttons()).not.toContain("Add this PC to my account");
  });

  it("says only Sign in while the relay is off: the sign-in then offers the one button that turns it on and adds the PC", async () => {
    relay = "off";
    await mount();
    await until(() => buttons().includes("Sign in"));
    // fixed wait: proves the button does not come to promise what this sign-in will not do
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Sign in");
    await until(() => relayButtons().length === 1);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(await new AccountService({ store: indexedAccountStore }).listPcs()).toEqual([]);
    await act(async () => { relayButtons()[0]!.click(); });
    await until(() => buttons().includes("Stop waiting"));
    expect(asked.filter((request) => request.path === "/api/relay/start")).toHaveLength(1);
    expect(links().every((request) => request.localOnly)).toBe(true);
    expect((await new AccountService({ store: indexedAccountStore }).listPcs()).map((pc) => pc.server_id)).toEqual([SERVER]);
  });

  it("says only Sign in to a device that only watches this PC", async () => {
    role = "watch";
    await mount();
    await until(() => buttons().includes("Sign in"));
    // fixed wait: proves the button does not come to promise what this sign-in will not do
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(buttons()).not.toContain("Sign in and add this PC");
  });

  it("a watching device's sign-in lists nothing and is offered no button to add the PC", async () => {
    role = "watch";
    await mount();
    await until(() => buttons().includes("Sign in"));
    await press("Sign in");
    await until(() => buttons().includes("Sign out"));
    // fixed wait: proves that nothing is listed, opened or offered after the sign-in
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(links()).toHaveLength(0);
    expect(text(document.body)).not.toContain("Adding this PC");
    expect(text(document.body)).not.toContain("could not be listed");
    expect(buttons()).not.toContain("Add this PC to my account");
    expect(relayButtons()).toHaveLength(0);
  });

  it("a press of a button that read only Sign in adds nothing, though the relay was turned on since the button was drawn", async () => {
    relay = "off";
    await mount();
    await until(() => buttons().includes("Sign in"));
    relay = "online";
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Sign in");
    await until(() => buttons().includes("Add this PC to my account"));
    // fixed wait: proves that nothing is listed or opened by itself
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(text(document.body)).not.toContain("Signed in. Adding this PC to your account…");
    expect(buttons()).not.toContain("Stop waiting");
    expect(links()).toHaveLength(0);
    expect(await new AccountService({ store: indexedAccountStore }).listPcs()).toEqual([]);
    expect((page.window.sessionStorage.getItem(MARKER) !== null)).toBe(false);
  });

  it("the button's words follow the relay: read again when Settings asks, and by itself", async () => {
    relay = "off";
    await mount();
    await until(() => buttons().includes("Sign in"));
    relay = "online";
    await recheck(1);
    await until(() => buttons().includes("Sign in and add this PC"));
    relay = "off";
    const deadline = Date.now() + 8_000;
    while (!buttons().includes("Sign in") && Date.now() < deadline) await act(async () => { await Bun.sleep(25); });
    expect(buttons()).toContain("Sign in");
    expect(links()).toHaveLength(0);
  });

  it("a provider's own button says nothing of adding the PC, so its sign-in adds nothing: the offer stays", async () => {
    fake = new FakeAccountService(() => Date.now() + ahead);
    await mount();
    await until(() => buttons().includes("Continue with GitHub"));
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Continue with GitHub");
    await until(() => buttons().includes("Add this PC to my account"));
    // fixed wait: proves that nothing is listed or opened by itself
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(text(document.body)).not.toContain("Signed in. Adding this PC to your account…");
    expect(buttons()).not.toContain("Stop waiting");
    expect(links()).toHaveLength(0);
    expect(await new AccountService({ store: indexedAccountStore }).listPcs()).toEqual([]);
  });

  it("a sign-in that ended before the PC was read is none that just finished: the same account stored again later lists nothing by itself", async () => {
    await mount();
    await until(() => buttons().includes("Sign in and add this PC"));
    statusHangs = true;
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Sign out"));
    refuses = true;
    await recheck(1);
    await until(() => text(document.body).includes("Your sign-in ended."));
    expect(ended?.account).toBe(ACCOUNT);
    expect(links()).toHaveLength(0);

    refuses = false;
    statusHangs = false;
    await indexedAccountStore.set("session", ended);
    await recheck(2);
    await until(() => buttons().includes("Add this PC to my account"));
    // fixed wait: proves that nothing is listed or opened by itself
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(buttons()).not.toContain("Stop waiting");
    expect(links()).toHaveLength(0);
    expect(await new AccountService({ store: indexedAccountStore }).listPcs()).toEqual([]);
  });
});
