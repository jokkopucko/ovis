import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, reactProps, type Page } from "../lib/page.fixture.ts";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { type AccountSession, indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";

import { AccountSection } from "./AccountSection.tsx";

// In the desktop app, which signs in by redirect, the same button asks before it deletes, and the service's
// refusals are said in the person's words. On a PC's own page in a browser, whose sign-in is a device code or the
// link page, the service refuses any delete (web_sign_in_required): the section says where to delete instead.
const SERVICE = "https://account.ovis.example";
const ACCOUNT = "acct_one";
let signsInAs = ACCOUNT;
let desktop = true;
const SIGN_IN = "Continue with GitHub";
let onDelete: (() => Promise<void>) | null = null;
/** the account service's answer to a Not me block post, when a test sets one */
let safetyAnswer: ((id: string) => Response | Promise<Response>) | null = null;
/** this PC explicitly withdrew the account release (its last feature list lacked it) */
let withdrawnNow = false;
let safetyPosts = 0;
/** the desktop app's providers, and whether the account service refuses to start a link */
let bridgeProviders: string[] = ["github"];
let linkFails = false;
/** the changes to the account's ways in the account service lists, newest first, when a test sets some */
let methodChanges: unknown[] = [];

describe("deleting the account from Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let fake: FakeAccountService;
  let userCode: string | null;
  let ahead: number;

  beforeEach(() => {
    ahead = 0;
    userCode = null;
    signsInAs = ACCOUNT;
    desktop = true;
    onDelete = null;
    safetyAnswer = null;
    withdrawnNow = false;
    safetyPosts = 0;
    bridgeProviders = ["github"];
    linkFails = false;
    methodChanges = [];
    fake = new FakeAccountService(() => Date.now() + ahead);
    fake.offerLinkPage(["github", "google"]);
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
    // the desktop app's sign-in: the system browser at the provider, back to its loopback server with the code
    const bridge = {
      service: SERVICE, get providers() { return bridgeProviders; },
      start: async () => "http://127.0.0.1:4321/callback",
      open: async (url: string) => {
        fake.signInAs("github", signsInAs);
        return new URL((await fake.fetch(url)).headers.get("location") ?? "").search;
      },
    };
    Object.defineProperty(page.window, "ovisAccount", { configurable: true, get: () => desktop ? bridge : undefined });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net");
      if (url.origin !== SERVICE) {
        if (url.pathname === "/api/relay") return Response.json({ phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
        if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, auth: { required: false, authenticated: true, via: "loopback", role: "drive" }, security: { pairing_gate: "closed", token_configured: false } });
        if (url.pathname === "/api/account/status") return Response.json({ account: ACCOUNT, unlinked: [], removals: [], adds: [], blocked: [] });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      if (url.pathname === "/v1/identities/link" && linkFails) return Response.json({ error: { code: "unavailable", message: "down" } }, { status: 503 });
      if (url.pathname === "/v1/safety-records") safetyPosts++;
      if (url.pathname === "/v1/safety-records" && safetyAnswer !== null) return safetyAnswer(String((JSON.parse(String(init?.body)) as { record: { id: unknown } }).record.id));
      if (url.pathname === "/v1/token" && userCode !== null) { fake.approveOnLinkPage(userCode, signsInAs, "github"); fake.approveDevice(userCode, signsInAs); userCode = null; }
      const answer = await fake.fetch(input, init);
      if (url.pathname === "/v1/identities" && answer.ok && methodChanges.length > 0) return Response.json({ ...await answer.json() as object, history: methodChanges });
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
  const shown = (): string => text(document.body);
  const buttons = (): string[] => [...document.body.querySelectorAll<HTMLButtonElement>("button")].map(text);
  const until = async (holds: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 400 && !holds(); turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(holds()).toBe(true);
  };
  const press = async (label: string): Promise<void> => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((node) => text(node) === label);
    expect(found).toHaveLength(1);
    await act(async () => { found[0]?.click(); });
  };
  const inSheet = (node: Element): boolean => node.closest('[data-testid="manage-account"]') !== null;
  const sheet = (): string => text(document.body.querySelector('[data-testid="manage-account"]')!);
  const button = (label: string): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((node) => text(node) === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  /** signed in, with Manage account's sheet open: Delete account is in it */
  const signedIn = async (): Promise<void> => {
    await page.render(<SettingsProvider><AccountSection withdrawn={() => withdrawnNow} /></SettingsProvider>);
    await until(() => buttons().includes(SIGN_IN));
    await press(SIGN_IN);
    await until(() => buttons().includes("Manage account"));
    await press("Manage account");
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
    await until(() => fake.requests.length > before);
    expect(fake.requests.slice(before)).not.toContain("DELETE /v1/account");
    expect(fake.deleted("acct_two")).toBe(false);
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_two");
  });

  it("S32-1: signing out with a block the account has not confirmed says so first, signs out only when asked again, and keeps the block", async () => {
    await signedIn();
    const session = await indexedAccountStore.get("session");
    if (session === undefined) throw new Error("Not signed in");
    await indexedAccountStore.set("unsent_blocks", { b1: { account: session.account, sign_in_id: session.sign_in_id, records: [{ id: "b1" } as never] } });
    await press("Sign out");
    await until(() => shown().includes("A block has not reached the account yet."));
    expect(buttons()).toEqual(expect.arrayContaining(["Send it now", "Sign out anyway"]));
    expect((await indexedAccountStore.get("session"))?.account).toBe(ACCOUNT);
    await press("Sign out anyway");
    await until(() => buttons().includes(SIGN_IN));
    expect(Object.keys(await indexedAccountStore.get("unsent_blocks") ?? {})).toEqual(["b1"]);
  });

  const queueFor = async (sign: { account: string; sign_in_id?: string | undefined }, id: string) => {
    await indexedAccountStore.update("unsent_blocks", (current) => ({ ...current, [id]: { account: sign.account, sign_in_id: sign.sign_in_id, records: [{ id } as never] } }));
  };

  it("S32-1: the sign-out question belongs to the sign-in that asked: after a switch to another sign-in it signs nobody out and keeps that one's queue", async () => {
    await signedIn();
    const a = (await indexedAccountStore.get("session"))!;
    await queueFor(a, "a1");
    await press("Sign out");
    await until(() => shown().includes("A block has not reached the account yet."));
    const b = { ...a, sign_in_id: "another-sign-in", refresh_token: "r-b" };
    await indexedAccountStore.set("session", b);
    await queueFor(b, "b1");
    await press("Sign out anyway");
    await until(() => !shown().includes("A block has not reached the account yet."));
    expect((await indexedAccountStore.get("session"))?.sign_in_id).toBe("another-sign-in");
    expect(Object.keys(await indexedAccountStore.get("unsent_blocks") ?? {})).toContain("b1");
  });

  it("S32-1: a queue that cannot be read is not empty: sign-out asks, keeps the session, and offers to check again", async () => {
    await signedIn();
    const get = indexedAccountStore.get;
    const failing = spyOn(indexedAccountStore, "get").mockImplementation((async (name: string) => {
      if (name === "unsent_blocks") throw new DOMException("busy", "UnknownError");
      return await get.call(indexedAccountStore, name as never);
    }) as typeof indexedAccountStore.get);
    await press("Sign out");
    await until(() => shown().includes("Could not check whether a block still waits to reach the account."));
    expect(buttons()).toEqual(expect.arrayContaining(["Check again", "Sign out anyway"]));
    expect(await get.call(indexedAccountStore, "session")).toBeDefined();
    await queueFor((await get.call(indexedAccountStore, "session")) as AccountSession, "kept-1");
    await press("Sign out anyway");
    await until(() => buttons().includes(SIGN_IN));
    failing.mockRestore();
    // the sign-out ended the session and took no block with it
    expect(Object.keys(await indexedAccountStore.get("unsent_blocks") ?? {})).toContain("kept-1");
  });

  it.each([
    ["a passing failure keeps the session and offers Try again", 503, true],
    ["a final refusal says so once and does not sign out by itself", 403, false],
  ] as const)("S32-1: Send it now uses its result: %s", async (_name, status, retry) => {
    await signedIn();
    const a = (await indexedAccountStore.get("session"))!;
    await queueFor(a, "a1");
    safetyAnswer = () => Response.json({ error: { code: status === 403 ? "signer_not_older" : "unavailable", message: "x" } }, { status });
    await press("Sign out");
    await until(() => buttons().includes("Send it now"));
    await press("Send it now");
    await until(() => shown().includes(retry ? "The block did not go through yet." : "The account service did not take this block, so a PC that was off may still let that device in. Block it from an older device, or use Sign out every device."));
    expect((await indexedAccountStore.get("session"))?.sign_in_id).toBe(a.sign_in_id);
    expect(buttons().includes("Try again")).toBe(retry);
    expect(buttons()).toContain("Sign out anyway");
  });

  it("S32-1: a final refusal for one block is still said after a Try again sends the other, and leaves only once said", async () => {
    await signedIn();
    const a = (await indexedAccountStore.get("session"))!;
    await queueFor(a, "refused-1");
    await queueFor(a, "busy-1");
    let busy = 503;
    safetyAnswer = (id) => id === "refused-1" ? Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 })
      : busy === 200 ? Response.json({ id }) : Response.json({ error: { code: "unavailable", message: "x" } }, { status: busy });
    await press("Sign out");
    await until(() => buttons().includes("Send it now"));
    await press("Send it now");
    await until(() => buttons().includes("Try again"));
    busy = 200;
    await press("Try again");
    await until(() => !buttons().includes("Try again"));
    expect(shown()).toContain("The account service did not take this block, so a PC that was off may still let that device in. Block it from an older device, or use Sign out every device.");
    expect(buttons()).toContain("Sign out anyway");
    expect((await indexedAccountStore.get("session"))?.sign_in_id).toBe(a.sign_in_id);
    // the refusal stays queued until its owner presses OK
    expect(Object.keys(await indexedAccountStore.get("unsent_blocks") ?? {})).toEqual(["refused-1"]);
    await press("OK");
    await until(() => !shown().includes("The account service did not take this block, so a PC that was off may still let that device in. Block it from an older device, or use Sign out every device."));
    expect(await indexedAccountStore.get("unsent_blocks")).toBeUndefined();
  });

  it("S32-1: a final refusal that answers after Sign out anyway is said to nobody, so the block stays for its account's next sign-in", async () => {
    await signedIn();
    const a = (await indexedAccountStore.get("session"))!;
    await queueFor(a, "late-1");
    const answer = Promise.withResolvers<Response>();
    const asked = Promise.withResolvers<void>();
    safetyAnswer = () => { asked.resolve(); return answer.promise; };
    await press("Sign out");
    await until(() => buttons().includes("Send it now"));
    await press("Send it now");
    await asked.promise;
    await press("Sign out anyway");
    await until(() => buttons().includes(SIGN_IN));
    // the send's answer is written, then the sign-in it asked for is read again before anything is said
    const { update, get } = indexedAccountStore;
    let written = false;
    const checked = Promise.withResolvers<void>();
    spyOn(indexedAccountStore, "update").mockImplementation((async (name: string, change: never) => {
      await update.call(indexedAccountStore, name as never, change);
      if (name === "unsent_blocks") written = true;
    }) as typeof indexedAccountStore.update);
    spyOn(indexedAccountStore, "get").mockImplementation((async (name: string) => {
      const value = await get.call(indexedAccountStore, name as never);
      if (written && name === "session") checked.resolve();
      return value;
    }) as typeof indexedAccountStore.get);
    await act(async () => {
      answer.resolve(Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 }));
      await checked.promise;
    });
    await act(async () => {});
    expect(shown()).not.toContain("The account service did not take this block, so a PC that was off may still let that device in. Block it from an older device, or use Sign out every device.");
    expect(Object.values(await indexedAccountStore.get("unsent_blocks") ?? {}).map((entry) => [entry.records[0]?.id, entry.refused])).toEqual([["late-1", true]]);
  });

  it("S32-1: Send it now posts nothing once this PC explicitly withdrew the account release, and keeps the block", async () => {
    await signedIn();
    const a = (await indexedAccountStore.get("session"))!;
    await queueFor(a, "w1");
    safetyAnswer = (id) => Response.json({ id });
    withdrawnNow = true;
    await press("Sign out");
    await until(() => buttons().includes("Send it now"));
    await press("Send it now");
    await until(() => buttons().includes("Try again"));
    expect(safetyPosts).toBe(0);
    expect(Object.keys(await indexedAccountStore.get("unsent_blocks") ?? {})).toEqual(["w1"]);
    expect((await indexedAccountStore.get("session"))?.sign_in_id).toBe(a.sign_in_id);
  });

  it("drops the question when the person signs out, so the next sign-in starts unarmed", async () => {
    await signedIn();
    await press("Delete account");
    await press("Sign out");
    await until(() => buttons().includes(SIGN_IN));
    await press(SIGN_IN);
    await until(() => buttons().includes("Manage account"));
    await press("Manage account");
    expect(buttons()).not.toContain("Delete account for good?");
    expect(shown()).not.toContain("for good");
  });

  it("drops a sign-in-again prompt to delete when the person signs out, so it never deletes the next account", async () => {
    await signedIn();
    ahead = 11 * 60_000;
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => shown().includes("To delete your account, sign in again"));
    await press("Sign out");
    await until(() => buttons().includes(SIGN_IN));
    signsInAs = "acct_two";
    await press(SIGN_IN);
    await until(() => buttons().includes("Manage account"));
    await press("Manage account");
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
    await until(() => fake.deleted(ACCOUNT) && (buttons().includes(SIGN_IN) || (fake.requests.slice(fake.requests.indexOf("DELETE /v1/account") + 1).some((line) => line.startsWith("GET ")) && buttons().includes("Manage account"))));
    expect(buttons()).not.toContain(SIGN_IN);
    // Manage account was the deleted account's: it does not stay open for the sign-in that took its place
    expect(document.body.querySelectorAll('[data-testid="manage-account"]')).toHaveLength(0);
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
    await until(() => fake.requests.slice(before).includes("POST /v1/token") && fake.requests.slice(fake.requests.lastIndexOf("POST /v1/token") + 1).some((line) => line.startsWith("GET ")));
    expect(fake.requests.slice(before)).not.toContain("DELETE /v1/account");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_two");
  });

  it("says on a PC's own page in a browser where to delete, and offers no delete the service would refuse", async () => {
    desktop = false;
    await page.render(<SettingsProvider><AccountSection /></SettingsProvider>);
    await until(() => buttons().includes("Sign in"));
    await press("Sign in");
    await until(() => buttons().includes("Sign out"));
    expect(shown()).not.toContain("To delete your account");
    await press("Manage account");
    expect(sheet()).toContain("To delete your account, use the Ovis phone app, the desktop app or app.ovis.sh.");
    expect(document.body.querySelectorAll('button[data-action="delete-account"]')).toHaveLength(0);
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
    const button = document.body.querySelector<HTMLButtonElement>('button[data-action="delete-account"]')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => { button.click(); });
    // React drops the click on the disabled button: the handler's own check must hold too
    await act(async () => { (reactProps(button).onClick as () => void)(); });
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

  it("keeps Delete account off the page: asks, cancels and says a refusal in Manage account's sheet, and a sign-out takes the sheet away", async () => {
    await page.render(<SettingsProvider><AccountSection withdrawn={() => withdrawnNow} /></SettingsProvider>);
    await until(() => buttons().includes(SIGN_IN));
    await press(SIGN_IN);
    await until(() => buttons().includes("Manage account"));
    expect(buttons()).not.toContain("Delete account");
    await press("Manage account");
    expect(inSheet(button("Delete account"))).toBe(true);
    await press("Delete account");
    expect(inSheet(button("Delete account for good?"))).toBe(true);
    expect(sheet()).toContain("This deletes your Ovis account for good");
    await press("Cancel");
    expect(sheet()).not.toContain("for good");
    fake.subscribe(ACCOUNT);
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => sheet().includes("Cancel your subscription first, then delete the account."));
    expect(fake.deleted(ACCOUNT)).toBe(false);
    await press("Sign out");
    await until(() => buttons().includes(SIGN_IN));
    expect(document.body.querySelectorAll('[data-testid="manage-account"]')).toHaveLength(0);
    expect(shown()).not.toContain("Cancel your subscription first");
  });

  it("drops the delete question when Manage account closes, so the next opening starts unarmed", async () => {
    await signedIn();
    await press("Delete account");
    expect(buttons()).toContain("Delete account for good?");
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    expect(document.body.querySelectorAll('[data-testid="manage-account"]')).toHaveLength(0);
    await press("Manage account");
    expect(buttons()).toContain("Delete account");
    expect(buttons()).not.toContain("Delete account for good?");
    expect(fake.deleted(ACCOUNT)).toBe(false);
  });

  it("asks nothing after Manage account closed while the press still read the sign-in", async () => {
    await signedIn();
    const { indexedAccountService } = await import("../lib/account/service.ts");
    const read = Promise.withResolvers<void>();
    const session = indexedAccountService.session.bind(indexedAccountService);
    const held = spyOn(indexedAccountService, "session").mockImplementationOnce(async () => { await read.promise; return await session(); });
    await press("Delete account");
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    await act(async () => { read.resolve(); });
    held.mockRestore();
    await press("Manage account");
    expect(buttons()).toContain("Delete account");
    expect(buttons()).not.toContain("Delete account for good?");
    expect(fake.deleted(ACCOUNT)).toBe(false);
  });

  it("keeps Manage account open through adding a way in, and asks for the sign-in again there", async () => {
    bridgeProviders = ["github", "google"];
    await signedIn();
    ahead = 11 * 60_000;
    await press("Add Google");
    await until(() => document.body.querySelectorAll('[data-testid="manage-account"]').length === 1 && sheet().includes("To change how you sign in, sign in again with GitHub first."));
    expect(inSheet(button("Sign in again"))).toBe(true);
  });

  it("says why a change made in Manage account failed inside the sheet, not behind it", async () => {
    bridgeProviders = ["github", "google"];
    linkFails = true;
    await signedIn();
    await press("Add Google");
    await until(() => document.body.querySelectorAll('[data-testid="manage-account"]').length === 1 && sheet().includes("The sign-in did not finish. Try again."));
    const alerts = [...document.body.querySelectorAll('[role="alert"]')].filter((node) => text(node).includes("The sign-in did not finish"));
    expect(alerts).toHaveLength(1);
    expect(inSheet(alerts[0]!)).toBe(true);
  });

  it("shows the latest changes to the ways in under the chips in Manage account's sheet", async () => {
    methodChanges = [{ kind: "add", provider: "google", at: new Date(2026, 10, 27, 12).toISOString(), device_no: 3 }];
    await signedIn();
    const changes = (): string[] => [...document.body.querySelectorAll('[data-testid="manage-account"] .account-methods [data-testid="account-method-history"] li')].map(text);
    await until(() => changes().length > 0);
    expect(changes()).toEqual(["Nov 27 · Google added · Device 3"]);
  });

  it("asks for a sign-in again in Manage account's sheet, then deletes", async () => {
    await signedIn();
    ahead = 11 * 60_000;
    await press("Delete account");
    await press("Delete account for good?");
    await until(() => sheet().includes("To delete your account, sign in again with GitHub first."));
    expect(inSheet(button("Sign in again"))).toBe(true);
    await press("Sign in again");
    await until(() => shown().includes("Your account was deleted."));
    expect(fake.deleted(ACCOUNT)).toBe(true);
  });
});
