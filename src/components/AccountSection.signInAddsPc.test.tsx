import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { AccountService } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";

// a portal is drawn in place, so the test renderer sees Manage account's sheet
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => createElement("div", { "data-portal": "" }, node) }));
const { AccountSection } = await import("./AccountSection.tsx");

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
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  let pcAccount: string | null;
  let asked: { path: string; localOnly: boolean }[];
  let tab: Map<string, string>;
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
    tab = new Map();
    userCode = null;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    // Manage account's sheet keeps the focus in it, which asks what an element is
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: "/", origin: "https://workstation.example.ts.net" } });
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      sessionStorage: storage,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false,
      documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net");
      if (url.origin !== SERVICE) {
        asked.push({ path: url.pathname, localOnly: new Headers(input instanceof Request ? input.headers : init?.headers).get("x-ovis-local-only") === "1" });
        if (url.pathname === "/api/account/status" && statusHangs) return new Promise<Response>(() => {});
        if (url.pathname === "/api/relay") return Response.json({ phase: relay, relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
        if (url.pathname === "/api/relay/start") { relay = "online"; return Response.json({ phase: "connecting", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null }); }
        if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, auth: { required: false, authenticated: true, via: "loopback", role }, security: { pairing_gate: "closed", token_configured: false } });
        if (url.pathname === "/api/relay/link" && relay === "off") return Response.json({ error: { code: "relay_off", message: "Start the relay before pairing." } }, { status: 409 });
        if (url.pathname === "/api/account/status") return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
        if (url.pathname === "/api/relay/link") return Response.json({ url: OFFER, window_id: "1".repeat(32) });
        if (url.pathname === "/api/relay/link/close") return Response.json({ ok: true });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      if (refuses) {
        ended ??= await indexedAccountStore.get("session");
        return Response.json({ error: { code: "unauthorized", message: "Sign in again" } }, { status: 401 });
      }
      if (url.pathname === "/v1/token" && userCode !== null) { fake.approveOnLinkPage(userCode, ACCOUNT, approveWith); fake.approveDevice(userCode, ACCOUNT); userCode = null; }
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
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    setTransport(nativeTransport);
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map(text);
  const until = async (shown: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 400 && !shown(); turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(shown()).toBe(true);
  };
  const mount = async (): Promise<void> => {
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
  };
  const recheck = async (count: number): Promise<void> => {
    await act(async () => { renderer!.update(<SettingsProvider><AccountSection recheck={count} /></SettingsProvider>); });
  };
  const press = async (label: string): Promise<void> => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node) === label);
    expect(found).toHaveLength(1);
    await act(async () => { (found[0]!.props as { onClick: () => void }).onClick(); });
  };
  /** the one button that also turns the relay on: it reads like the plain one, and is marked apart */
  const relayButtons = (): ReactTestInstance[] => renderer!.root.findAll((node) => node.type === "button" && node.props["data-relay"] === "off");
  const links = (): { path: string; localOnly: boolean }[] => asked.filter((request) => request.path === "/api/relay/link");

  it("lists the PC and waits once the sign-in finishes, with no second press, and only then", async () => {
    await mount();
    await until(() => buttons().includes("Sign in and add this PC"));
    expect(links()).toHaveLength(0);
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    expect((await indexedAccountStore.get("session"))?.account).toBe(ACCOUNT);
    expect(text(renderer!.root)).toContain("On another device of your account, choose Add on desk.");
    // listed once in the account's directory, behind a window only this PC approves; the relay was not asked to start
    expect(links()).toEqual([{ path: "/api/relay/link", localOnly: true }]);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect((await new AccountService({ store: indexedAccountStore }).listPcs()).map((pc) => pc.server_id)).toEqual([SERVER]);
    expect(JSON.parse(tab.get(MARKER)!)).toMatchObject({ name: "desk", serverId: SERVER, account: ACCOUNT });

    await press("Stop waiting");
    await until(() => asked.some((request) => request.path === "/api/relay/link/close"));
    expect(buttons()).toContain("Add this PC to my account");

    await act(async () => { renderer?.unmount(); });
    const before = asked.length;
    await mount();
    await until(() => buttons().includes("Add this PC to my account"));
    expect(text(renderer!.root)).not.toContain("Signed in. Adding this PC to your account…");
    expect(asked.slice(before).map((request) => request.path).filter((path) => path !== "/api/account/status" && path !== "/api/health")).toEqual([]);
  });

  it.each([true, false])("retrying a stale listing uses the local binding at write time (bound: %s)", async (bound) => {
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
      await until(() => text(renderer!.root).includes("Added") || buttons().includes("Stop waiting"));
      expect(directoryWrites).toEqual(bound ? [] : ["DELETE", "PUT"]);
      const [after] = await service.listPcs();
      expect(after?.server_id).toBe(SERVER);
      if (bound) {
        expect(after?.added_at).toBe(listed?.added_at);
        expect(pcAccount).toBe(ACCOUNT);
        expect(text(renderer!.root)).toContain("Added");
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
    await until(() => !buttons().includes("Remove GitHub") && buttons().includes("Add this PC to my account"));
    // fixed wait: proves that nothing is listed or opened after the sign-in again
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(buttons()).not.toContain("Stop waiting");
    expect(text(renderer!.root)).not.toContain("Signed in. Adding this PC to your account…");
    expect(asked.slice(before).map((request) => request.path).filter((path) => path !== "/api/account/status" && path !== "/api/health")).toEqual([]);
  });

  it("says only Sign in on a PC already in an account, and adds nothing after it", async () => {
    pcAccount = "acct_other";
    await mount();
    await until(() => buttons().includes("Sign in"));
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Sign in");
    await until(() => buttons().includes("Sign out"));
    // fixed wait: proves that nothing is listed or opened after the sign-in
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
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
    await act(async () => { (relayButtons()[0]!.props as { onClick: () => void }).onClick(); });
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
    expect(text(renderer!.root)).not.toContain("Adding this PC");
    expect(text(renderer!.root)).not.toContain("could not be listed");
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
    expect(text(renderer!.root)).not.toContain("Signed in. Adding this PC to your account…");
    expect(buttons()).not.toContain("Stop waiting");
    expect(links()).toHaveLength(0);
    expect(await new AccountService({ store: indexedAccountStore }).listPcs()).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
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
    expect(text(renderer!.root)).not.toContain("Signed in. Adding this PC to your account…");
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
    await until(() => text(renderer!.root).includes("Your sign-in ended."));
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
