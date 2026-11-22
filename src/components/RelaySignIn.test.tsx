import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { useLinkPageSignIn } from "../lib/account/useLinkPageSignIn.ts";
import { handOverReturn } from "../lib/account/ownWindow.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { RelayState } from "../lib/useRelay.ts";
import { RelayTab } from "./ConnectPhoneDialog.tsx";

const SERVICE = "https://account.ovis.example";
const ONLINE: RelayStatus = { phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null };
const relay: RelayState = { status: ONLINE, unsupported: false, readFailed: false, pending: false, request: async () => ONLINE, reread: () => {} };

interface FakeTab { opener: unknown; closed: boolean; location: { href: string }; close(): void }

describe("the relay tab's Sign in", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
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
  let focusTargets: string[];
  let startGate: Promise<void>;
  let failStart: boolean;
  let linkPageAvailable: boolean;
  /** the port the PC reports for its own window, null for any other window */
  let ownPort: number | null;

  beforeEach(() => {
    fake = new FakeAccountService();
    fake.offerLinkPage(["github", "google"]);
    popupBlocked = false;
    opened = [];
    tab = null;
    approveOnPoll = false;
    userCode = null;
    polls = [];
    settings = [];
    focusTargets = [];
    startGate = Promise.resolve();
    failStart = false;
    linkPageAvailable = true;
    ownPort = null;
    const sent = Promise.withResolvers<string>();
    navigated = sent.promise;
    const polled = Promise.withResolvers<void>();
    firstPoll = polled.promise;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      open: (url: string) => {
        opened.push(url);
        if (popupBlocked) return null;
        let href = url;
        tab = {
          opener: "ovis", closed: false, close() { this.closed = true; },
          location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } },
        };
        return tab;
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
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

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (onSignedIn: () => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => { settings.push("account"); }, onSignedIn };
    await act(async () => {
      renderer = create(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>, {
        createNodeMock: ({ props }) => ({ closest: () => null, querySelector: () => null, focus() {
          if (typeof props === "object" && props !== null && "children" in props && typeof props.children === "string") focusTargets.push(props.children);
        } }),
      });
    });
  };
  const signIn = async () => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === "Sign in to Ovis");
    expect(found).toHaveLength(1);
    await act(async () => { found[0]!.props.onClick(); });
  };

  it.each(["starting", "waiting", "cancel", "failure"])("keeps keyboard focus usable after %s", async (phase) => {
    const gate = Promise.withResolvers<void>();
    startGate = gate.promise;
    failStart = phase === "failure";
    await mount();
    await signIn();
    if (phase === "starting") {
      const starting = renderer?.root.findByProps({ className: "btn btn-primary connect-signin-button" });
      expect(starting?.props.disabled).not.toBe(true);
      expect(starting?.props["aria-disabled"]).toBe(true);
      await act(async () => { starting?.props.onClick(); });
      expect(opened).toEqual(["about:blank"]);
    }
    await act(async () => { gate.resolve(); });
    if (phase === "starting") return;
    if (phase === "failure") {
      expect(renderer?.root.findByProps({ role: "alert" })).toBeDefined();
      expect(focusTargets.at(-1)).toBe("Sign in to Ovis");
      expect(tab?.closed).toBe(true);
      return;
    }
    await act(async () => { await firstPoll; });
    if (phase === "cancel") {
      await act(async () => { renderer?.root.findAllByType("button").find((node) => text(node) === "Cancel")?.props.onClick(); });
    }
    expect(focusTargets.at(-1)).toBe(phase === "waiting" ? "Open the sign-in page" : "Sign in to Ovis");
  });

  it.each([
    ["starting", "cancel"], ["starting", "restart"], ["starting", "unmount"],
    ["waiting", "cancel"], ["waiting", "restart"], ["waiting", "unmount"],
  ] as const)("cleans up a %s attempt on %s, closing only an unsent tab", async (phase, action) => {
    let actions: ReturnType<typeof useLinkPageSignIn> | undefined;
    const gate = Promise.withResolvers<void>();
    if (phase === "starting") startGate = gate.promise;
    function SignInHarness() { actions = useLinkPageSignIn(SERVICE, () => undefined); return null; }
    await act(async () => { renderer = create(<SignInHarness />); });
    await act(async () => { actions?.start(); });
    if (phase === "waiting") await act(async () => { await firstPoll; });
    const abandoned = tab;
    await act(async () => {
      switch (action) {
        case "cancel": actions?.cancel(); break;
        case "restart": actions?.start(); break;
        case "unmount": renderer?.unmount(); renderer = undefined; break;
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
    const before = renderer?.root.findAllByProps({ "aria-live": "polite" });
    await signIn();
    await act(async () => { await finished.promise; });
    const account = { service: SERVICE, onOpen() {}, onSignedIn() {} };
    await act(async () => { renderer?.update(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn joinBySignIn={false} account={account} phone={false} /></SettingsProvider>); });
    const after = renderer?.root.findAllByProps({ "aria-live": "polite" }) ?? [];
    expect(after.map(text)).toContain("Signed in with GitHub");
    expect(after[0]).toBe(before?.[0]);
  });

  it("offers each provider's device page as its own button where the service has no link page", async () => {
    fake.offerSignIns(["google"], ["google"]);
    linkPageAvailable = false;
    await mount();
    expect(renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === "Sign in to Ovis")).toHaveLength(0);
    const google = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === "Continue with Google");
    expect(google).toHaveLength(1);
    await act(async () => { google[0]!.props.onClick(); });
    await act(async () => { await firstPoll; });
    expect(tab?.location.href).toBe("https://www.google.com/device");
    expect(renderer?.root.findAllByType("a").map(text)).toEqual(["Open Google"]);
  });

  it("starts one device sign-in when a provider's button is pressed twice while it starts", async () => {
    fake.offerSignIns(["google"], ["google"]);
    linkPageAvailable = false;
    const gate = Promise.withResolvers<void>();
    startGate = gate.promise;
    await mount();
    const google = () => renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === "Continue with Google")[0]!;
    await act(async () => { google().props.onClick(); });
    // the second press, as a double click lands, before the first one's answer
    await act(async () => { google().props.onClick(); });
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
    const page = await navigated;
    expect(page).toBe(`${SERVICE}/link?code=${userCode}`);
    expect(tab!.opener).toBeNull();
    expect(settings).toEqual([]);
    await act(async () => { await signedIn.promise; });
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_one");
    expect(text(renderer!.root)).toContain("Signed in with GitHub");
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    expect(tab?.closed).toBe(false);
  });

  it("shows the link page and its code here when the browser blocks the new tab", async () => {
    popupBlocked = true;
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    const links = renderer!.root.findAll((node) => node.type === "a" && node.props.href === `${SERVICE}/link?code=${userCode}`);
    expect(links.map((link) => text(link))).toEqual(["Open the sign-in page"]);
    expect(text(renderer!.root)).toContain(userCode!);
    expect(settings).toEqual([]);
  });

  it("ends the waiting sign-in when the sheet closes, keeping no session", async () => {
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((signal) => !signal.aborted)).toBe(true);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(polls.every((signal) => signal.aborted)).toBe(true);
    fake.approveOnLinkPage(userCode!, "acct_one", "github");
    expect(await indexedAccountStore.get("session")).toBeUndefined();
  });
});

describe("the relay tab's Sign in on the PC's own window", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
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
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent, maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "http://127.0.0.1:7317/", protocol: "http:", hostname: "127.0.0.1", port: "7317" },
      open: () => {
        if (popupBlocked) return null;
        let href = "about:blank";
        tab = { opener: "ovis", closed: false, close() { this.closed = true; }, location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } } };
        return tab;
      },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
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

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const buttons = () => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());
  const mount = async (onSignedIn: () => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => undefined, onSignedIn };
    await act(async () => {
      renderer = create(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>,
        { createNodeMock: () => ({ closest: () => null, querySelector: () => null, focus() {} }) });
    });
  };
  const press = async (label: string) => {
    const button = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label)[0]!;
    await act(async () => { button.props.onClick(); });
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
    const link = renderer!.root.findAll((node) => node.type === "a" && text(node) === "Open the sign-in page")[0]!;
    const back = new URL((await fake.fetch(String(link.props.href))).headers.get("location") ?? "");
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
    const update = indexedAccountStore.update.bind(indexedAccountStore);
    spyOn(indexedAccountStore, "update").mockImplementation((async (name: string, change: never) => {
      if (name === "session") { writing.resolve(); await release.promise; }
      return update(name as never, change);
    }) as never);
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
    const update = indexedAccountStore.update.bind(indexedAccountStore);
    spyOn(indexedAccountStore, "update").mockImplementation(((name: string, change: never) => name === "session" ? Promise.reject(new Error("disk full")) : update(name as never, change)) as never);
    spyOn(console, "warn").mockImplementation(() => {});
    await mount();
    await press("Continue with Google");
    const start = await sent.promise;
    const stop = handOverReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").search, () => undefined);
    const deadline = Date.now() + 5_000;
    while (renderer!.root.findAll((node) => node.props.role === "alert").length === 0) {
      if (Date.now() > deadline) throw new Error("no failure was shown");
      await Bun.sleep(5);
      await act(async () => {});
    }
    stop();
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);
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
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  let opened: ReturnType<typeof Promise.withResolvers<string>>;
  let answer: ReturnType<typeof Promise.withResolvers<string>>;

  beforeEach(() => {
    fake = new FakeAccountService();
    fake.offerLinkPage(["google"]);
    opened = Promise.withResolvers<string>();
    answer = Promise.withResolvers<string>();
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Electron/33.0 Chrome/130.0", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "http://127.0.0.1:7317/", protocol: "http:", hostname: "127.0.0.1", port: "7317" },
      open: () => null,
      // the desktop app's bridge (app/electron/src/accountSignIn.ts): its loopback server brings the provider's return back
      ovisAccount: { service: SERVICE, providers: ["google"], start: async () => "http://127.0.0.1:53117/callback", open: (url: string) => { opened.resolve(url); return answer.promise; } },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7317");
      if (url.origin !== SERVICE) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      return fake.fetch(input, init);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const buttons = () => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());
  const press = async (label: string) => {
    const button = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label)[0]!;
    await act(async () => { button.props.onClick(); });
  };
  const mount = async (onSignedIn: () => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => undefined, onSignedIn };
    await act(async () => {
      renderer = create(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>,
        { createNodeMock: () => ({ closest: () => null, querySelector: () => null, focus() {} }) });
    });
  };
  const returned = async (url: string): Promise<string> => new URL((await fake.fetch(url)).headers.get("location") ?? "").search;

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
