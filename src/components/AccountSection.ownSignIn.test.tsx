import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { handOverReturn } from "../lib/account/ownWindow.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { AccountSection } from "./AccountSection.tsx";
import { RelayTab } from "./ConnectPhoneDialog.tsx";
import type { RelayState } from "../lib/useRelay.ts";
import type { RelayStatus } from "../../shared/protocol.ts";

// The PC's own window in a browser on the PC signs in at the provider and back (lib/account/ownWindow.ts).
const SERVICE = "https://account.ovis.example";
const PORT = 7317;
const publicKey = exportPublicKey(generateKeyPair().publicKey);
const SERVER = deriveServerId(importPublicKey(publicKey));
const OFFER = encodeOffer({ v: 1, server_id: SERVER, server_public_key: publicKey, relay: "wss://relay.ovis.example", name: "desk" }, "https://app.ovis.example");

describe("signing in on the PC's own window", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  let popupBlocked: boolean;
  let sent: ReturnType<typeof Promise.withResolvers<string>>;
  let links: number;
  let relayPhase: "online" | "off";
  let pcAccount: string | null;
  let enrolling: boolean;
  /** holds the code's exchange until released, and says when it was asked */
  let exchange: { asked: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null;

  beforeEach(() => {
    fake = new FakeAccountService();
    fake.offerLinkPage(["google"]);
    popupBlocked = false;
    sent = Promise.withResolvers<string>();
    links = 0;
    relayPhase = "online";
    pcAccount = null;
    enrolling = false;
    exchange = null;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", maxTouchPoints: 0 } });
    const here = { href: `http://127.0.0.1:${PORT}/`, protocol: "http:", hostname: "127.0.0.1", port: String(PORT), pathname: "/", origin: `http://127.0.0.1:${PORT}` };
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: here });
    const tab = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: here,
      sessionStorage: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      open: () => {
        if (popupBlocked) return null;
        let href = "about:blank";
        return { opener: "ovis", closed: false, close() {}, location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } } };
      },
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false,
      documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), `http://127.0.0.1:${PORT}`);
      if (url.origin !== SERVICE) {
        if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, own_window: { port: PORT }, auth: { required: false, authenticated: true, via: "local", role: "drive" } });
        if (url.pathname === "/api/relay") return Response.json({ phase: relayPhase, relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
        if (url.pathname === "/api/account/status") return Response.json({ account: pcAccount, enrolling, unlinked: [], removals: [], adds: [], blocked: [] });
        if (url.pathname === "/api/relay/link") { links++; return Response.json({ url: OFFER, window_id: "1".repeat(32) }); }
        if (url.pathname === "/api/relay/link/close") return Response.json({ ok: true });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      if (url.pathname === "/v1/token" && exchange !== null) { exchange.asked.resolve(); await exchange.release.promise; }
      return fake.fetch(input, init);
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
  const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());
  const words = (): string => text(renderer!.root);
  const until = async (shown: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!shown()) {
      if (Date.now() > deadline) throw new Error("the screen never showed it");
      await Bun.sleep(5);
      await act(async () => {});
    }
  };
  const press = async (label: string): Promise<void> => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found).toHaveLength(1);
    await act(async () => { (found[0]!.props as { onClick: () => void }).onClick(); });
  };
  const back = async (start: string): Promise<string> => new URL((await fake.fetch(start)).headers.get("location") ?? "").search;

  it("offers the providers, says it adds this PC, and lists the PC once the return comes back", async () => {
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => words().includes("Signing in adds this PC to your account."));
    expect(buttons()).toContain("Continue with Google");
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Continue with Google");
    const start = await sent.promise;
    expect(new URL(start).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${PORT}/callback`);
    const stop = handOverReturn(await back(start), () => undefined);
    await until(() => buttons().includes("Stop waiting"));
    stop();
    expect((await indexedAccountStore.get("session"))?.provider).toBe("google");
    expect(links).toBeGreaterThan(0);
  });

  it("offers the provider's page as a link when the tab was blocked, and keeps no sign-in cancelled while its code was exchanged", async () => {
    popupBlocked = true;
    exchange = { asked: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    await press("Continue with Google");
    await until(() => renderer!.root.findAll((node) => node.type === "a" && text(node) === "Open the sign-in page").length === 1);
    const link = renderer!.root.findAll((node) => node.type === "a" && text(node) === "Open the sign-in page")[0]!;
    const returned = await back(String(link.props.href));
    const stop = handOverReturn(returned, () => undefined);
    await act(async () => { await exchange!.asked.promise; });
    await press("Cancel");
    await act(async () => { exchange!.release.resolve(); });
    await until(() => buttons().includes("Continue with Google"));
    stop();
    expect(await indexedAccountStore.get("session")).toBeUndefined();
    expect(links).toBe(0);
  });
});

describe("the relay tab reopened already signed in", () => {
  const ACCOUNT = "acct_first";
  const status = (phase: "online" | "off"): RelayStatus => ({ phase, relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
  const relayOf = (phase: "online" | "off"): RelayState => ({ status: status(phase), unsupported: false, readFailed: false, pending: false, request: async () => status("online"), reread: () => {} });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let state: { relay: "online" | "off"; pcAccount: string | null; enrolling: boolean };
  let service: FakeAccountService;
  let linkGate: ReturnType<typeof Promise.withResolvers<void>> | null;
  let pressed: string[];

  beforeEach(async () => {
    state = { relay: "off", pcAccount: null, enrolling: false };
    service = new FakeAccountService();
    linkGate = null;
    pressed = [];
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", maxTouchPoints: 0 } });
    const here = { href: `http://127.0.0.1:${PORT}/`, protocol: "http:", hostname: "127.0.0.1", port: String(PORT), pathname: "/", origin: `http://127.0.0.1:${PORT}` };
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: here });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true, location: here,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      open: () => null, addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false,
      documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), `http://127.0.0.1:${PORT}`);
      if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, own_window: { port: PORT }, auth: { required: false, authenticated: true, via: "local", role: "drive" }, security: { pairing_gate: "closed", token_configured: false } });
      if (url.pathname === "/api/relay") return Response.json(status(state.relay));
      if (url.pathname === "/api/relay/start") { state.relay = "online"; return Response.json(status("online")); }
      if (url.pathname === "/api/relay/link") { if (linkGate !== null) await linkGate.promise; return Response.json({ url: OFFER, window_id: "1".repeat(32) }); }
      if (url.pathname === "/api/relay/link/close" || url.pathname === "/api/account/relay-account") return Response.json({ ok: true });
      if (url.pathname === "/api/account/one-press") { pressed.push(url.pathname); state.pcAccount = ACCOUNT; return Response.json({ account: ACCOUNT }); }
      if (url.origin === SERVICE && /^\/v1\/pcs\/[0-9a-f]{32}\/admit$/.test(url.pathname)) { pressed.push("admit"); return Response.json({ server_id: url.pathname.split("/")[3], account: ACCOUNT, admitted_at: new Date().toISOString(), new_until: new Date(Date.now() + 86_400_000).toISOString() }); }
      if (url.pathname === "/api/account/status") return Response.json({ account: state.pcAccount, enrolling: state.enrolling, unlinked: [], removals: [], adds: [], blocked: [] });
      if (url.origin === SERVICE && url.pathname === "/v1/providers") return Response.json({ providers: ["google"], device: ["google"], device_page: ["google"] });
      if (url.origin === SERVICE) return service.fetch(input, init);
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    };
    setTransport({ ...nativeTransport, fetch: fetch as typeof nativeTransport.fetch });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
    spyOn(console, "warn").mockImplementation(() => {});
    await indexedAccountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "google", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3_600_000 });
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
  const until = async (shown: () => boolean, within = 5_000): Promise<void> => {
    const deadline = Date.now() + within;
    while (!shown()) {
      if (Date.now() > deadline) throw new Error("the screen never showed it");
      await Bun.sleep(10);
      await act(async () => {});
    }
  };
  let opensAll = false;
  const account = { service: SERVICE, onOpen: () => undefined, onSignedIn: () => undefined, opensAll: () => opensAll };
  const tabAt = (phase: "online" | "off") => <SettingsProvider><RelayTab relay={relayOf(phase)} closesGate={false} signedIn accountId={ACCOUNT} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>;
  const mount = async (phase: "online" | "off"): Promise<void> => {
    await act(async () => { renderer = create(tabAt(phase), { createNodeMock: () => ({ closest: () => null, querySelector: () => null, focus() {} }) }); });
  };
  const button = (label: string) => renderer!.root.findAll((node) => node.type === "button" && text(node) === label);
  /** Add this PC reads the same either way: the press that also turns the relay on is marked apart */
  const relayButton = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-relay"] === "off");
  const plainButton = () => button("Add this PC to my account").filter((node) => node.props["data-relay"] === undefined);

  it("with the relay off, offers the relay's own add button rather than a plain Add that would fail", async () => {
    await mount("off");
    await until(() => relayButton().length === 1);
    expect(plainButton()).toHaveLength(0);
  });

  it("says the PC is not finished while its enrollment runs, and stops saying so once it ends", async () => {
    state = { relay: "online", pcAccount: ACCOUNT, enrolling: true };
    await mount("online");
    const pending = () => text(renderer!.root).includes("Not finished yet");
    await until(pending);
    state.enrolling = false;
    await until(() => !pending(), 10_000);
  });

  it("offers the add again when the PC left the account before its enrollment ended", async () => {
    state = { relay: "online", pcAccount: ACCOUNT, enrolling: true };
    await mount("online");
    await until(() => text(renderer!.root).includes("Not finished yet"));
    state = { relay: "online", pcAccount: null, enrolling: false };
    await until(() => renderer!.root.findAll((node) => node.type === "button" && text(node) === "Add this PC to my account").length === 1, 10_000);
    expect(text(renderer!.root)).not.toContain("This PC is in your Ovis account");
  });

  it("offers the plain add once the relay's switch turns it on", async () => {
    await mount("off");
    await until(() => relayButton().length === 1);
    await act(async () => { renderer!.update(tabAt("online")); });
    await until(() => plainButton().length === 1);
  });

  it("offers the one press again when the relay's switch turns it off, and that press adds the PC", async () => {
    state.relay = "online";
    await mount("online");
    await until(() => button("Add this PC to my account").length === 1);
    state.relay = "off";
    await act(async () => { renderer!.update(tabAt("off")); });
    await until(() => relayButton().length === 1);
    await act(async () => { relayButton()[0]!.props.onClick(); });
    await until(() => button("Stop waiting").length === 1);
  });

  it("goes on with a press of the add that turns the relay on while the relay's state is read again", async () => {
    await mount("off");
    await until(() => relayButton().length === 1);
    linkGate = Promise.withResolvers<void>();
    await act(async () => { relayButton()[0]!.props.onClick(); });
    await act(async () => { renderer!.update(tabAt("online")); });
    linkGate.resolve();
    await until(() => button("Stop waiting").length === 1);
  });

  it("adds the PC in one press from the relay tab where the PC's step-2 switch is on, as Settings does", async () => {
    opensAll = true;
    state.relay = "online";
    try {
      await mount("online");
      await until(() => button("Add this PC to my account").length === 1);
      await act(async () => { button("Add this PC to my account")[0]!.props.onClick(); });
      await until(() => pressed.includes("/api/account/one-press"));
      expect(pressed).toEqual(["admit", "/api/account/one-press"]);
      expect(button("Stop waiting")).toHaveLength(0);
    } finally { opensAll = false; }
  });
});
