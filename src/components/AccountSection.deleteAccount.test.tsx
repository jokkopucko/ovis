import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { AccountSection } from "./AccountSection.tsx";

// Settings → Account → Delete account (docs/account.md, "Deleting the account"). In the desktop app, which signs in
// by redirect, the same button asks before it deletes, and the service's refusals are said in the person's words. On a
// PC's own page in a browser, whose sign-in is a device code or the link page, the service refuses any delete
// (web_sign_in_required): the section says where to delete instead.
const SERVICE = "https://account.ovis.example";
const ACCOUNT = "acct_one";
/** who the next sign-in in this section turns out to be */
let signsInAs = ACCOUNT;
/** the desktop app around the page (its sign-in bridge); false: a PC's own page in a browser */
let desktop = true;
const SIGN_IN = "Continue with GitHub";
/** runs as the service answers a delete, before this page sees the answer */
let onDelete: (() => Promise<void>) | null = null;

describe("deleting the account from Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  let userCode: string | null;
  /** how far the account service's clock runs ahead of this one */
  let ahead: number;

  beforeEach(() => {
    ahead = 0;
    userCode = null;
    signsInAs = ACCOUNT;
    desktop = true;
    onDelete = null;
    fake = new FakeAccountService(() => Date.now() + ahead);
    fake.offerLinkPage(["github", "google"]);
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: "/", origin: "https://workstation.example.ts.net" } });
    const tab = new Map<string, string>();
    // the desktop app's sign-in: the system browser at the provider, back to its loopback server with the code
    const bridge = {
      service: SERVICE, providers: ["github"],
      start: async () => "http://127.0.0.1:4321/callback",
      open: async (url: string) => {
        fake.signInAs("github", signsInAs);
        return new URL((await fake.fetch(url)).headers.get("location") ?? "").search;
      },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      get ovisAccount() { return desktop ? bridge : undefined; },
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      sessionStorage: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } },
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
        if (url.pathname === "/api/relay") return Response.json({ phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
        if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, auth: { required: false, authenticated: true, via: "loopback", role: "drive" }, security: { pairing_gate: "closed", token_configured: false } });
        // this PC is in the account already, so signing in adds nothing and the section shows the account alone
        if (url.pathname === "/api/account/status") return Response.json({ account: ACCOUNT, unlinked: [], removals: [], adds: [], blocked: [] });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      // the code is approved as this page's first poll comes in, on the link page and on a provider's own device page
      if (url.pathname === "/v1/token" && userCode !== null) { fake.approveOnLinkPage(userCode, signsInAs, "github"); fake.approveDevice(userCode, signsInAs); userCode = null; }
      const answer = await fake.fetch(input, init);
      if (url.pathname === "/v1/account" && onDelete !== null) await onDelete();
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
  const shown = (): string => text(renderer!.root);
  const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map(text);
  /** waits, in real time, until the screen shows what is asked for */
  const until = async (holds: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 400 && !holds(); turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(holds()).toBe(true);
  };
  const press = async (label: string): Promise<void> => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node) === label);
    expect(found).toHaveLength(1);
    await act(async () => { (found[0]!.props as { onClick: () => void }).onClick(); });
  };
  const signedIn = async (): Promise<void> => {
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes(SIGN_IN));
    await press(SIGN_IN);
    await until(() => buttons().includes("Delete account"));
  };

  it("asks on the same button, says what goes and what stays, and deletes on the second press", async () => {
    await signedIn();
    expect(shown()).not.toContain("for good");
    await press("Delete account");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(shown()).toContain("This deletes your Ovis account for good: your sign-in methods, your list of PCs and your plan.");
    expect(shown()).toContain("Devices stay paired with your PCs until you revoke them on each PC.");
    await press("Cancel");
    expect(buttons()).toContain("Delete account");
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => shown().includes("Your account was deleted."));
    expect(fake.deleted(ACCOUNT)).toBe(true);
    expect(await indexedAccountStore.get("session")).toBeUndefined();
    expect(buttons()).toContain(SIGN_IN);
    expect(buttons()).not.toContain("Delete account");
  });

  it("asks for a sign-in again when this one is over ten minutes old, then deletes without asking twice", async () => {
    await signedIn();
    ahead = 11 * 60_000;
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => shown().includes("To delete your account, sign in again with GitHub first."));
    expect(fake.deleted(ACCOUNT)).toBe(false);
    await press("Sign in again");
    await until(() => shown().includes("Your account was deleted."));
    expect(fake.deleted(ACCOUNT)).toBe(true);
  });

  it("deletes only the account it asked about: another tab's sign-in to another account meanwhile is left alone", async () => {
    await signedIn();
    await press("Delete account");
    const mine = (await indexedAccountStore.get("session"))!;
    await indexedAccountStore.set("session", { ...mine, account: "acct_two", access_token: fake.issueToken("acct_two"), refresh_token: "rt-two", sign_in_id: "another-sign-in" });
    const before = fake.requests.length;
    await press("Delete account for good?");
    // the next call this section makes: the delete itself, or the read of what is stored now
    await until(() => fake.requests.length > before);
    expect(fake.requests.slice(before)).not.toContain("DELETE /v1/account");
    expect(fake.deleted("acct_two")).toBe(false);
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_two");
  });

  it("drops the question when the person signs out, so the next sign-in starts unarmed", async () => {
    await signedIn();
    await press("Delete account");
    await press("Sign out of GitHub");
    await until(() => buttons().includes(SIGN_IN));
    await press(SIGN_IN);
    await until(() => buttons().includes("Delete account"));
    expect(buttons()).not.toContain("Delete account for good?");
    expect(shown()).not.toContain("for good");
  });

  it("drops a sign-in-again prompt to delete when the person signs out, so it never deletes the next account", async () => {
    await signedIn();
    ahead = 11 * 60_000;
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => shown().includes("To delete your account, sign in again"));
    await press("Sign out of GitHub");
    await until(() => buttons().includes(SIGN_IN));
    signsInAs = "acct_two";
    await press(SIGN_IN);
    await until(() => buttons().includes("Delete account"));
    expect(buttons()).not.toContain("Sign in again");
    expect(shown()).not.toContain("To delete your account, sign in again");
    expect(fake.deleted("acct_two")).toBe(false);
  });

  it("shows the sign-in that took the deleted one's place while the delete was out, not a signed-out page", async () => {
    await signedIn();
    const mine = (await indexedAccountStore.get("session"))!;
    onDelete = () => indexedAccountStore.set("session", { ...mine, account: "acct_two", access_token: fake.issueToken("acct_two"), refresh_token: "rt-two", sign_in_id: "another-sign-in" });
    await press("Delete account");
    await press("Delete account for good?");
    // settled: signed out, or the other sign-in read after the delete and shown
    await until(() => fake.deleted(ACCOUNT) && (buttons().includes(SIGN_IN) || (fake.requests.slice(fake.requests.indexOf("DELETE /v1/account") + 1).some((line) => line.startsWith("GET ")) && buttons().includes("Delete account"))));
    expect(buttons()).not.toContain(SIGN_IN);
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_two");
  });

  it("leaves another tab's sign-in stored after the refusal: the sign-in again neither replaces it nor deletes", async () => {
    await signedIn();
    ahead = 11 * 60_000;
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => shown().includes("To delete your account, sign in again"));
    const mine = (await indexedAccountStore.get("session"))!;
    await indexedAccountStore.set("session", { ...mine, account: "acct_two", access_token: fake.issueToken("acct_two"), refresh_token: "rt-two", sign_in_id: "another-sign-in" });
    const before = fake.requests.length;
    await press("Sign in again");
    // settled: the sign-in again answered, and the section read what is stored after it
    await until(() => fake.requests.slice(before).includes("POST /v1/token") && fake.requests.slice(fake.requests.lastIndexOf("POST /v1/token") + 1).some((line) => line.startsWith("GET ")));
    expect(fake.requests.slice(before)).not.toContain("DELETE /v1/account");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_two");
  });

  it("says on a PC's own page in a browser where to delete, and offers no delete the service would refuse", async () => {
    desktop = false;
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Sign in"));
    await press("Sign in");
    await until(() => buttons().includes("Sign out of GitHub"));
    expect(shown()).toContain("To delete your account, use the Ovis phone app, the desktop app or app.ovis.sh.");
    expect(renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "delete-account")).toHaveLength(0);
    expect(fake.requests).not.toContain("DELETE /v1/account");
  });

  it("holds Delete account while the delete is out: no second question, one DELETE, and the deleted notice", async () => {
    await signedIn();
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    onDelete = async () => { reached.resolve(); await gate.promise; };
    await press("Delete account");
    await press("Delete account for good?");
    await act(async () => { await reached.promise; });
    const button = renderer!.root.find((node) => node.type === "button" && node.props["data-action"] === "delete-account");
    expect(button.props.disabled).toBe(true);
    expect(button.props["aria-busy"]).toBe("true");
    await act(async () => { (button.props as { onClick: () => void }).onClick(); });
    expect(shown()).not.toContain("for good");
    gate.resolve();
    await until(() => shown().includes("Your account was deleted."));
    expect(fake.requests.filter((line) => line === "DELETE /v1/account")).toHaveLength(1);
  });

  it("says to cancel a subscription that still renews, and keeps the account", async () => {
    await signedIn();
    fake.subscribe(ACCOUNT);
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => shown().includes("Cancel your subscription first, then delete the account."));
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(buttons()).toContain("Delete account");
  });
});
