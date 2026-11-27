import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { FakeAccountService, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { indexedAccountStore, memoryAccountStore } from "../lib/account/store.ts";
import { beginSignIn, finishOwnSignIn } from "../lib/account/signin.ts";
import { useLinkPageSignIn } from "../lib/account/useLinkPageSignIn.ts";
import { handOverReturn } from "../lib/account/ownWindow.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { RelayState } from "../lib/useRelay.ts";
import { closedBySignIn, RelayTab } from "./ConnectPhoneDialog.tsx";

const SERVICE = "https://account.ovis.example";
const ONLINE: RelayStatus = { phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null };
const relay: RelayState = { status: ONLINE, unsupported: false, readFailed: false, pending: false, request: async () => ONLINE, reread: () => {} };

interface FakeTab { opener: unknown; closed: boolean; location: { href: string }; close(): void }

let page: Page;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

function openSignInPage(url: string, userAgent: string, advertiseService: boolean): Page {
  const view = openPage(url);
  Object.defineProperty(view.window.navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(view.window, "isSecureContext", { configurable: true, value: true });
  if (advertiseService) {
    const meta = view.window.document.createElement("meta");
    meta.name = "ovis-pc-account-service";
    meta.content = SERVICE;
    view.window.document.head.append(meta);
  }
  for (const [key, value] of Object.entries({ indexedDB: fakeIndexedDB().factory, Event: view.window.Event })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return view;
}

afterEach(async () => {
  await page.close();
  mock.restore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const text = (node: { readonly textContent: string | null }): string => node.textContent ?? "";
const buttonNodes = () => [...page.container.querySelectorAll("button")];
const links = () => [...page.container.querySelectorAll("a")];
const alerts = () => page.container.querySelectorAll('[role="alert"]');
const buttons = () => buttonNodes().map((node) => text(node).trim());
const press = async (label: string) => {
  const button = buttonNodes().find((node) => text(node).trim() === label);
  if (!button) throw new Error(`No button says ${label}`);
  await act(async () => button.click());
};

describe("the relay tab's Sign in", () => {
  let fake: FakeAccountService;
  /** what window.open answers: a tab, or null for a blocked popup */
  let popupBlocked: boolean;
  let opened: string[];
  let tab: FakeTab | null;
  let navigated: Promise<string>;
  let approveOnPoll: boolean;
  let userCode: string | null;
  let polls: AbortSignal[];
  let firstPoll: Promise<void>;
  let settings: string[];
  let startGate: Promise<void>;
  let failStart: boolean;
  let linkPageAvailable: boolean;
  /** the port the PC reports for its own window, null for any other window */
  let ownPort: number | null;
  /** the account this PC says it is in (/api/account/status), null for none */
  let pcAccountId: string | null;

  beforeEach(() => {
    pcAccountId = null;
    fake = new FakeAccountService();
    fake.offerLinkPage(["github", "google"]);
    popupBlocked = false;
    opened = [];
    tab = null;
    approveOnPoll = false;
    userCode = null;
    polls = [];
    settings = [];
    startGate = Promise.resolve();
    failStart = false;
    linkPageAvailable = true;
    ownPort = null;
    const sent = Promise.withResolvers<string>();
    navigated = sent.promise;
    const polled = Promise.withResolvers<void>();
    firstPoll = polled.promise;
    page = openSignInPage("https://workstation.example.ts.net/", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", true);
    Object.defineProperty(page.window, "open", { configurable: true, value: (url: string) => {
      opened.push(url);
      if (popupBlocked) return null;
      let href = url;
      tab = {
        opener: "ovis", closed: false, close() { this.closed = true; },
        location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } },
      };
      return tab;
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("/api/account/status")) return Response.json({ account: pcAccountId, unlinked: [] });
      if (String(input).startsWith("/api/health")) return Response.json({ ok: true, auth: { required: false, authenticated: true }, bridge_protocol: 1, ...(ownPort === null ? {} : { own_window: { port: ownPort } }) });
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin !== SERVICE) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      if (url.pathname === "/v1/signin/ovis/device" && !linkPageAvailable) return Response.json({ error: { code: "not_found", message: "no link page" } }, { status: 404 });
      if (url.pathname.startsWith("/v1/signin/")) {
        await startGate;
        if (failStart) return Response.json({ error: { code: "invalid_request", message: "refused" } }, { status: 400 });
      }
      if (url.pathname === "/v1/token") {
        if (init?.signal) polls.push(init.signal);
        if (approveOnPoll && userCode !== null) fake.approveOnLinkPage(userCode, "acct_one", "github");
        polled.resolve();
      }
      const answer = await fake.fetch(input, init);
      if (!url.pathname.startsWith("/v1/signin/") || !answer.ok) return answer;
      const started = await answer.json() as Record<string, unknown>;
      userCode = String(started["user_code"]);
      return Response.json({ ...started, interval: 0.001 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  const mount = async (onSignedIn: (home: boolean) => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => { settings.push("account"); }, onSignedIn };
    await page.render(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>);
  };
  const signIn = async () => {
    const found = buttonNodes().filter((node) => text(node).trim() === "Sign in to Ovis");
    expect(found).toHaveLength(1);
    await act(async () => { found[0]!.click(); });
  };

  it.each(["starting", "waiting", "cancel", "failure"])("keeps keyboard focus usable after %s", async (phase) => {
    const gate = Promise.withResolvers<void>();
    startGate = gate.promise;
    failStart = phase === "failure";
    await mount();
    await signIn();
    if (phase === "starting") {
      const starting = page.one<HTMLButtonElement>('button[class="btn btn-primary connect-signin-button"]');
      expect(starting.disabled).not.toBe(true);
      expect(starting.getAttribute("aria-disabled")).toBe("true");
      await act(async () => { starting.click(); });
      expect(opened).toEqual(["about:blank"]);
    }
    await act(async () => { gate.resolve(); });
    if (phase === "starting") return;
    if (phase === "failure") {
      expect(page.one('[role="alert"]')).toBeDefined();
      expect(page.window.document.activeElement?.textContent).toBe("Sign in to Ovis");
      expect(tab?.closed).toBe(true);
      return;
    }
    await act(async () => { await firstPoll; });
    if (phase === "cancel") {
      await act(async () => { buttonNodes().find((node) => text(node) === "Cancel")?.click(); });
    }
    expect(page.window.document.activeElement?.textContent).toBe(phase === "waiting" ? "Open the sign-in page" : "Sign in to Ovis");
  });

  it.each([
    ["starting", "cancel"], ["starting", "restart"], ["starting", "unmount"],
    ["waiting", "cancel"], ["waiting", "restart"], ["waiting", "unmount"],
  ] as const)("cleans up a %s attempt on %s, closing only an unsent tab", async (phase, action) => {
    let actions: ReturnType<typeof useLinkPageSignIn> | undefined;
    const gate = Promise.withResolvers<void>();
    if (phase === "starting") startGate = gate.promise;
    function SignInHarness() { actions = useLinkPageSignIn(SERVICE, () => undefined); return null; }
    await page.render(<SignInHarness />);
    await act(async () => { actions?.start(); });
    if (phase === "waiting") await act(async () => { await firstPoll; });
    const abandoned = tab;
    if (action === "unmount") await page.render(null);
    else await act(async () => {
      switch (action) {
        case "cancel": actions?.cancel(); break;
        case "restart": actions?.start(); break;
        default: action satisfies never;
      }
    });
    expect(abandoned?.closed).toBe(phase === "starting");
    if (phase === "waiting") expect(polls[0]?.aborted).toBe(true);
    await act(async () => { actions?.cancel(); gate.resolve(); });
    if (phase === "starting") expect(abandoned?.location.href).toBe("about:blank");
  });

  it("announces completion in the same polite region after the account replaces the sign-in", async () => {
    approveOnPoll = true;
    const finished = Promise.withResolvers<void>();
    await mount(() => finished.resolve());
    const before = [...page.container.querySelectorAll('[aria-live="polite"]')];
    await signIn();
    await act(async () => { await finished.promise; });
    const account = { service: SERVICE, onOpen() {}, onSignedIn() {} };
    await page.render(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn joinBySignIn={false} account={account} phone={false} /></SettingsProvider>);
    const after = [...page.container.querySelectorAll('[aria-live="polite"]')];
    expect(after.map(text)).toContain("Signed in with GitHub");
    expect(after[0]).toBe(before[0]);
  });

  // the owner's sign-out and sign-in on a PC already in the account: nothing is left to add, so the sheet closes (closedBySignIn)
  for (const [name, pcIn, home] of [["already in that account", "acct_one", true], ["in another account", "acct_two", false], ["in no account", null, false]] as const) {
    it(`a sign-in on a PC ${name} ${home ? "says nothing is left to add" : "stays on the tab"}`, async () => {
      pcAccountId = pcIn;
      approveOnPoll = true;
      const finished = Promise.withResolvers<boolean>();
      await mount((goesHome) => finished.resolve(goesHome));
      await signIn();
      expect(await finished.promise).toBe(home);
    });
  }

  it("a sign-in on a PC already in that account with its relay off stays on the tab, with the relay's switch", async () => {
    pcAccountId = "acct_one";
    approveOnPoll = true;
    const off: RelayState = { ...relay, status: { ...ONLINE, phase: "off" } };
    const finished = Promise.withResolvers<boolean>();
    const account = { service: SERVICE, onOpen() {}, onSignedIn: (home: boolean) => finished.resolve(home) };
    const tab = (signedIn: boolean) => <SettingsProvider><RelayTab relay={off} closesGate={false} signedIn={signedIn} accountId={signedIn ? "acct_one" : null} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>;
    await page.render(tab(false));
    await signIn();
    expect(await finished.promise).toBe(false);
    await page.render(tab(true));
    expect(page.container.querySelectorAll('[role="switch"], input[type="checkbox"]').length).toBeGreaterThan(0);
    expect(text(page.container)).toContain("Let this PC be reached from anywhere");
  });

  it("offers each provider's device page as its own button where the service has no link page", async () => {
    fake.offerSignIns(["google"], ["google"]);
    linkPageAvailable = false;
    await mount();
    expect(buttonNodes().filter((node) => text(node).trim() === "Sign in to Ovis")).toHaveLength(0);
    const google = buttonNodes().filter((node) => text(node).trim() === "Continue with Google");
    expect(google).toHaveLength(1);
    await act(async () => { google[0]!.click(); });
    await act(async () => { await firstPoll; });
    expect(tab?.location.href).toBe("https://www.google.com/device");
    expect(links().map(text)).toEqual(["Open Google"]);
  });

  it("starts one device sign-in when a provider's button is pressed twice while it starts", async () => {
    fake.offerSignIns(["google"], ["google"]);
    linkPageAvailable = false;
    const gate = Promise.withResolvers<void>();
    startGate = gate.promise;
    await mount();
    const google = () => buttonNodes().filter((node) => text(node).trim() === "Continue with Google")[0]!;
    await act(async () => { google().click(); });
    // the second press, as a double click lands, before the first one's answer
    await act(async () => { google().click(); });
    expect(opened).toEqual(["about:blank"]);
    await act(async () => { gate.resolve(); });
    await act(async () => { await firstPoll; });
    expect(tab?.location.href).toBe("https://www.google.com/device");
  });

  it("opens the link page with its code filled in, in a new tab, and comes back signed in here", async () => {
    approveOnPoll = true;
    const signedIn = Promise.withResolvers<void>();
    await mount(() => signedIn.resolve());
    await signIn();
    // the tab opens in the click itself, so no popup blocker takes it
    expect(opened).toEqual(["about:blank"]);
    const address = await navigated;
    expect(address).toBe(`${SERVICE}/link?code=${userCode}`);
    expect(tab!.opener).toBeNull();
    expect(settings).toEqual([]);
    await act(async () => { await signedIn.promise; });
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_one");
    expect(text(page.container)).toContain("Signed in with GitHub");
    await page.render(null);
    expect(tab?.closed).toBe(false);
  });

  it("shows the link page and its code here when the browser blocks the new tab", async () => {
    popupBlocked = true;
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    const matching = links().filter((node) => node.getAttribute("href") === `${SERVICE}/link?code=${userCode}`);
    expect(matching.map((link) => text(link))).toEqual(["Open the sign-in page"]);
    expect(text(page.container)).toContain(userCode!);
    expect(settings).toEqual([]);
  });

  it("ends the waiting sign-in when the sheet closes, keeping no session", async () => {
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((signal) => !signal.aborted)).toBe(true);
    await page.render(null);
    expect(polls.every((signal) => signal.aborted)).toBe(true);
    fake.approveOnLinkPage(userCode!, "acct_one", "github");
    expect(await indexedAccountStore.get("session")).toBeUndefined();
  });
});

describe("the relay tab's Sign in on the PC's own window", () => {
  let fake: FakeAccountService;
  let tab: { opener: unknown; closed: boolean; location: { href: string }; close(): void } | null;
  let sent: ReturnType<typeof Promise.withResolvers<string>>;
  let popupBlocked: boolean;
  let exchange: { asked: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null;

  const setUp = (userAgent: string) => {
    exchange = null;
    fake = new FakeAccountService();
    fake.offerLinkPage(["google"]);
    tab = null;
    popupBlocked = false;
    sent = Promise.withResolvers<string>();
    page = openSignInPage("http://127.0.0.1:7317/", userAgent, true);
    Object.defineProperty(page.window, "open", { configurable: true, value: () => {
      if (popupBlocked) return null;
      let href = "about:blank";
      tab = { opener: "ovis", closed: false, close() { this.closed = true; }, location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } } };
      return tab;
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("/api/health")) return Response.json({ ok: true, auth: { required: false, authenticated: true }, bridge_protocol: 1, own_window: { port: 7317 } });
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin !== SERVICE) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      if (url.pathname === "/v1/token" && exchange !== null) { exchange.asked.resolve(); await exchange.release.promise; }
      return fake.fetch(input, init);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  };

  const mount = async (onSignedIn: () => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => undefined, onSignedIn };
    await page.render(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>);
  };

  it("signs in at the provider and back, with the return handed over by the callback tab", async () => {
    setUp("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0");
    const signedIn = Promise.withResolvers<void>();
    await mount(() => signedIn.resolve());
    expect(buttons()).toContain("Continue with Google");
    expect(buttons()).not.toContain("Sign in to Ovis");
    await press("Continue with Google");
    const start = await sent.promise;
    const back = new URL((await fake.fetch(start)).headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:7317/callback");
    const stop = handOverReturn(back.search, () => undefined);
    await act(async () => { await signedIn.promise; });
    stop();
    expect((await indexedAccountStore.get("session"))?.provider).toBe("google");
  });

  it("offers the provider's page as a link when the tab was blocked, and keeps no sign-in cancelled while its code was exchanged", async () => {
    setUp("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0");
    exchange = { asked: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    await mount();
    popupBlocked = true;
    await press("Continue with Google");
    const link = links().filter((node) => text(node) === "Open the sign-in page")[0]!;
    const back = new URL((await fake.fetch(link.href)).headers.get("location") ?? "");
    const stop = handOverReturn(back.search, () => undefined);
    await act(async () => { await exchange!.asked.promise; });
    await press("Cancel");
    await act(async () => { exchange!.release.resolve(); for (let turn = 0; turn < 20; turn++) await Promise.resolve(); });
    stop();
    expect(await indexedAccountStore.get("session")).toBeUndefined();
    expect(buttons()).toContain("Continue with Google");
  });

  it("keeps no sign-in cancelled while it was being written", async () => {
    setUp("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0");
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const updateMany = indexedAccountStore.updateMany.bind(indexedAccountStore);
    let installs = 0;
    spyOn(indexedAccountStore, "updateMany").mockImplementation(async (names, change) => {
      // The first transaction checks the generation of the held session; the second installs it.
      if (names.some((name) => name === "session") && ++installs === 2) { writing.resolve(); await release.promise; }
      return updateMany(names, change);
    });
    await mount();
    await press("Continue with Google");
    const start = await sent.promise;
    const stop = handOverReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").search, () => undefined);
    await act(async () => { await writing.promise; });
    await press("Cancel");
    await act(async () => { release.resolve(); for (let turn = 0; turn < 20; turn++) await Promise.resolve(); });
    stop();
    expect(await indexedAccountStore.get("session")).toBeUndefined();
    expect(buttons()).toContain("Continue with Google");
  });

  it("shows the failure, not a stuck page, when the sign-in could not be kept", async () => {
    setUp("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0");
    const updateMany = indexedAccountStore.updateMany.bind(indexedAccountStore);
    let installs = 0;
    spyOn(indexedAccountStore, "updateMany").mockImplementation(async (names, change) => {
      if (names.some((name) => name === "session") && ++installs === 2) throw new Error("disk full");
      return updateMany(names, change);
    });
    const failed = Promise.withResolvers<void>();
    spyOn(console, "warn").mockImplementation((message) => {
      if (message === "Ovis: the sign-in did not finish") failed.resolve();
    });
    await mount();
    await press("Continue with Google");
    const start = await sent.promise;
    const stop = handOverReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").search, () => undefined);
    try {
      await act(async () => { await failed.promise; });
    } finally {
      stop();
    }
    expect(alerts()).toHaveLength(1);
    expect(buttons()).toContain("Continue with Google");
  });

  it("keeps the code in the Mac app, whose sign-in page opens in the system browser", async () => {
    setUp("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 OvisMac/0.5.7");
    await mount();
    expect(buttons()).toContain("Sign in to Ovis");
    expect(buttons()).not.toContain("Continue with Google");
  });
});

describe("the relay tab's Sign in in the desktop app", () => {
  let fake: FakeAccountService;
  let opened: ReturnType<typeof Promise.withResolvers<string>>;
  let answer: ReturnType<typeof Promise.withResolvers<string>>;
  /** the account this PC says it is in (/api/account/status) */
  let pcAccountId: string | null;

  beforeEach(() => {
    pcAccountId = null;
    fake = new FakeAccountService();
    fake.offerLinkPage(["google"]);
    opened = Promise.withResolvers<string>();
    answer = Promise.withResolvers<string>();
    page = openSignInPage("http://127.0.0.1:7317/", "Mozilla/5.0 (X11; Linux x86_64) Electron/33.0 Chrome/130.0", false);
    Object.defineProperty(page.window, "open", { configurable: true, value: () => null });
    // the desktop app's bridge (app/electron/src/accountSignIn.ts): its loopback server brings the provider's return back
    Object.defineProperty(page.window, "ovisAccount", { configurable: true, value: {
      service: SERVICE, providers: ["google"], start: async () => "http://127.0.0.1:53117/callback",
      open: (url: string) => { opened.resolve(url); return answer.promise; },
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7317");
      if (url.pathname === "/api/account/status") return Response.json({ account: pcAccountId, unlinked: [] });
      if (url.origin !== SERVICE) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      return fake.fetch(input, init);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  const mount = async (onSignedIn: (home: boolean) => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => undefined, onSignedIn };
    await page.render(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>);
  };
  const returned = async (url: string): Promise<string> => new URL((await fake.fetch(url)).headers.get("location") ?? "").search;
  const seedGitHub = async (store = memoryAccountStore()) => {
    const url = await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT });
    const back = new URL((await fake.fetch(url)).headers.get("location") ?? "").hash;
    return finishOwnSignIn(url, back, { store, fetch: fake.fetch });
  };

  it("does not ask to create an account while switching from a stored sign-in", async () => {
    const session = await seedGitHub(indexedAccountStore);
    pcAccountId = "acct_pc";
    await page.render(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn accountId={session.account}
      joinBySignIn={false} account={{ service: SERVICE, onOpen() {}, onSignedIn() {} }} phone={false} /></SettingsProvider>);
    await press("Continue with Google");
    expect(new URL(await opened.promise).searchParams.has("create")).toBe(false);
  });

  it.each(["merge_open", "cancel"] as const)("keeps the existing sign-in and only displays real link refusals (%s)", async (outcome) => {
    const existing = await seedGitHub();
    pcAccountId = existing.account;
    fake.emailMatches = { google: "github" };
    if (outcome === "merge_open") fake.methodLinkRefusal = outcome;
    const finished = Promise.withResolvers<ReturnType<typeof closedBySignIn>>();
    const account = { service: SERVICE, onOpen() {}, onSignedIn: (home: boolean) => finished.resolve(closedBySignIn(home, "relay")) };
    const tab = (signedIn: boolean) => <SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={signedIn} accountId={signedIn ? existing.account : null}
      joinBySignIn={false} account={account} phone={false} /></SettingsProvider>;
    await page.render(tab(false));
    await press("Continue with Google");
    const first = await opened.promise;
    const firstAnswer = answer;
    opened = Promise.withResolvers<string>();
    answer = Promise.withResolvers<string>();
    await act(async () => { firstAnswer.resolve(await returned(first)); });
    await press("Sign in with GitHub to connect");
    await act(async () => {
      const connectAnswer = answer;
      const connectUrl = await opened.promise;
      opened = Promise.withResolvers<string>();
      answer = Promise.withResolvers<string>();
      connectAnswer.resolve(await returned(connectUrl));
      if (outcome === "cancel") {
        expect(new URL(await opened.promise).searchParams.has("link_token")).toBe(true);
        answer.reject(new DOMException("Cancelled by the user", "AbortError"));
      }
      await finished.promise;
    });
    expect(await finished.promise).toBe(outcome === "cancel" ? "settings" : "nothing");
    await page.render(tab(true));
    expect([...alerts()].map(text)).toEqual(outcome === "cancel" ? [] : ["Finish or cancel the account merge before adding another sign-in method."]);
    expect(await indexedAccountStore.get("session")).toMatchObject({ account: existing.account, provider: "github" });
  });

  it("offers the providers and signs in through the app's own loopback", async () => {
    const signedIn = Promise.withResolvers<void>();
    await mount(() => signedIn.resolve());
    expect(buttons()).toContain("Continue with Google");
    expect(buttons()).not.toContain("Sign in to Ovis");
    await press("Continue with Google");
    answer.resolve(await returned(await opened.promise));
    await act(async () => { await signedIn.promise; });
    expect((await indexedAccountStore.get("session"))?.provider).toBe("google");
  });

  // owner #25 (packaged Mac app): signing in again on a PC that is already in that account leaves no connect dialog
  it("a sign-in through the app's loopback on a PC already in that account says nothing is left to add", async () => {
    pcAccountId = "acct_mine";
    fake.signInAs("google", "acct_mine");
    const home = Promise.withResolvers<boolean>();
    await mount((goesHome) => home.resolve(goesHome));
    await act(async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); });
    await press("Continue with Google");
    answer.resolve(await returned(await opened.promise));
    expect(await home.promise).toBe(true);
  });

  // owner #25: a sign-in that lands in another account (an identity the PC's account does not have makes a new one)
  // stays on the tab with the sign-in buttons alone, so the right one can be picked
  it("a sign-in through the app's loopback that lands in another account stays, with the sign-in buttons alone", async () => {
    pcAccountId = "acct_mine";
    fake.signInAs("google", "acct_new");
    const home = Promise.withResolvers<boolean>();
    const account = { service: SERVICE, onOpen: () => undefined, onSignedIn: (goesHome: boolean) => home.resolve(goesHome) };
    const tab = (signedIn: boolean) => <SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={signedIn} accountId={signedIn ? "acct_new" : null} joinBySignIn={false} account={account} phone={false} machines={[{ id: "local", kind: "local", name: "Mac", server_id: "srv_mac" } as never]} pcAddFromAccount onConnectMachine={() => {}} /></SettingsProvider>;
    await page.render(tab(false));
    await act(async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); });
    await press("Continue with Google");
    answer.resolve(await returned(await opened.promise));
    expect(await home.promise).toBe(false);
    await page.render(tab(true));
    await act(async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); });
    expect(buttons()).toContain("Continue with Google");
    expect(buttons()).not.toContain("Add from account");
    expect(text(page.container)).not.toContain("Sign in to this PC's account.");
    expect(text(page.container)).not.toContain("If that account is not yours");
    expect(text(page.container)).not.toContain("This PC is in an account.");
  });

  it("keeps no sign-in that comes back after Cancel", async () => {
    await mount();
    await press("Continue with Google");
    const url = await opened.promise;
    await press("Cancel");
    answer.resolve(await returned(url));
    await act(async () => { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); });
    expect(await indexedAccountStore.get("session")).toBeUndefined();
    expect(buttons()).toContain("Continue with Google");
  });
});
