import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ReactElement } from "react";

import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { ACCOUNT_READ_WAIT_MS, ACCOUNT_STEPS_WAIT_MS, mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { RelayTransport, type RelayTransportOptions } from "./transport.ts";
import { RelayAdmissionTimeoutError, RelayPcOfflineError } from "./channel.ts";
import { MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";

const AP = "wss://relay-ap.ovis.sh";
const SERVICE = "https://account.ovis.sh";
const SHEET_JOIN = "ovis-add-pc-sheet";

const keyFor = () => { const pair = generateKeyPair(); return { server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey) }; };

async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}
async function settleSigned(): Promise<void> {
  for (let turn = 0; turn < 2_000; turn++) await crypto.subtle.digest("SHA-256", new Uint8Array(1));
}
let waiting: (() => void)[] = [];
/** Told by a test's device store (deviceStore) whenever it writes or removes a record. */
const stored = (): void => { for (const wake of waiting.splice(0)) wake(); };
/**
 * Settles once `holds`, looked at again at each write of the device store: for a record that work which signs writes,
 * which no count of turns bounds. The test's own timeout does, which no faked clock holds.
 */
async function untilStored(holds: () => boolean): Promise<void> {
  for (;;) {
    const next = new Promise<void>((resolve) => { waiting.push(resolve); });
    if (holds()) return;
    await next;
  }
}
const drain = async (): Promise<void> => { for (let turn = 0; turn < 500; turn++) await Promise.resolve(); };

export function createShellTestPage() {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let visibility: "visible" | "hidden" = "visible";
  const page = new EventTarget();
  // a tab past its launch: a front page stays on screen instead of opening the PC saved last (shell.tsx, launchPc)
  const sessionStore = new Map<string, string>([["ovis-launched", "1"]]);
    for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "matchMedia"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const storage = (store: Map<string, string>) => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() });
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage(new Map()) });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage(sessionStore) });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://app.ovis.sh/", search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/" },
      history: { state: null, replaceState() {} },
      matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page), dispatchEvent: page.dispatchEvent.bind(page),
    } });
  return { page, sessionStore, setVisibility: (next: typeof visibility) => { visibility = next; }, dispose: () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  } };
}

describe("the hosted shell's front page", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(() => { jest.useRealTimers(); setTransport(nativeTransport); browser.dispose(); waiting = []; });

  const deviceStore = (devices: RelayDevice[]): ShellDeviceStore => ({
    async get(serverId) { return devices.find((device) => device.server_id === serverId); },
    async list() { return [...devices]; },
    async remove(serverId) { const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices.splice(at, 1); stored(); },
    async removeRow(serverId, row) { const at = devices.findIndex((device) => device.server_id === serverId && device.device_id === row); if (at < 0) return false; devices.splice(at, 1); stored(); return true; },
    async update(serverId, change) { const next = change(devices.find((device) => device.server_id === serverId)); const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices[at] = next; else devices.push(next); stored(); return next; },
  });
  const mountFor = (over: Partial<RelayShellMount>): RelayShellMount => ({
    container: {} as HTMLElement, entryUrl: "https://app.ovis.sh/", shellVersion: "0.0.0-test", label: "Test phone",
    renderApp: () => { throw new Error("the app is not expected here"); },
    createRoot: () => ({ render(element: ReactElement) { rendered.push(element); }, unmount() {} }),
    open: () => Promise.reject(new Error("no connection is expected here")),
    checkPc: async () => ({ kind: "offline", reason: "relay" }),
    reload: async () => {},
    accountService: null,
    ...over,
  });
  const shellProps = (element: ReactElement): RelayShellProps => {
    let node = element;
    while (node.type !== RelayShell) node = (node.props as { children: ReactElement }).children;
    return node.props as RelayShellProps;
  };
  const last = (): RelayShellProps => shellProps(rendered.at(-1)!);
  const account = () => { const { state } = last(); if ((state.kind !== "list" && state.kind !== "empty") || state.account?.kind !== "signed-in") throw new Error(`not the signed-in front page: ${state.kind}`); return state.account; };

  it("starts a fresh typed challenge after wrong digits and ignores repeated pending submissions", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const challenges: RelayTransportOptions[] = [];
    browser.sessionStore.set("ovis-typed-join", offer.server_id);
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]),
      open: async (_offer, options = {}) => {
        challenges.push(options);
        await options.compare?.(challenges.length === 1 ? "123456" : "654321");
        throw new MuxProtocolError("auth_failed", "fixture declined");
      },
    }));
    last().onPair();
    await until(() => last().state.kind === "compare", "first challenge");
    last().onPair();
    await drain();
    expect(challenges).toHaveLength(1);
    last().onMatch("000000");
    expect(challenges[0]?.signal?.aborted).toBe(true);
    last().onRetry();
    await until(() => challenges.length === 2 && last().state.kind === "compare", "fresh challenge");
    expect(last().state).toMatchObject({ kind: "compare", typed: true, confirmed: false });
    expect(JSON.stringify(last().state)).not.toContain("654321");
    expect([...browser.sessionStore.values()].join()).not.toMatch(/123456|654321|000000/);
    last().onMatch("123456");
    expect(challenges[1]?.signal?.aborted).toBe(true);
  });

  it("suppresses a cancelled failure even when its saved-key lookup finishes late", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const held = Promise.withResolvers<RelayDevice | undefined>();
    const store = deviceStore([]);
    let reading = false;
    store.get = () => { reading = true; return held.promise; };
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store, navigate() {},
      open: async () => { throw new MuxProtocolError("auth_revoked", "fixture revoked"); },
    }));
    last().onPair();
    await until(() => reading, "revocation lookup");
    last().onCancel();
    const count = rendered.length;
    held.resolve(undefined);
    await drain();
    expect(rendered).toHaveLength(count);
  });

  it("enters the PC as soon as a fresh code pairing is admitted, with no Ready screen", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP, code: "123456" };
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
    }
    const opened = new Admitted(offer);
    let apps = 0;
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), shellVersion: "1.0.0",
      open: async () => opened,
      renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} },
    }));
    expect(last().state.kind).toBe("confirm");
    last().onPair();
    await until(() => apps === 1, "the app");
    await drain();
    expect(apps).toBe(1);
    expect(rendered.map((element) => shellProps(element).state.kind)).not.toContain("ready");
    opened.close();
  });

  // the account service's provider list landing while a PC that turned this phone away is still being cleaned up draws
  // nothing: the app is gone, and the screen it left behind (Connecting) is not the one to bring back
  it("draws no stale screen when the provider list lands while a revoked PC's failure is still being read", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP, code: "123456" };
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
    }
    const providers = Promise.withResolvers<Response>();
    const reading = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const devices = deviceStore([]);
    let holding = false, roots = 0, apps = 0;
    let fatal: ((error: Error) => void) | undefined;
    const opened: RelayTransport[] = [];
    await mountRelayShell(mountFor({
      store: { ...devices, async get(serverId) { if (holding) { reading.resolve(); await held.promise; } return devices.get(serverId); } },
      shellVersion: "1.0.0", navigate() {}, accountStore: memoryAccountStore(), accountService: SERVICE, accountProviders: ["github"],
      accountFetch: async (input) => new URL(String(input)).pathname === "/v1/providers" ? providers.promise : Response.json({ pcs: [] }),
      createRoot: () => { roots++; return { render(element: ReactElement) { rendered.push(element); }, unmount() {} }; },
      renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} },
      open: async (_offer, options = {}) => { fatal = options.onFatal; const transport = new Admitted(offer); opened.push(transport); return transport; },
    }));
    expect(last().accountProviders).toEqual(["github"]);
    const link = new URL(encodeOffer(offer, "https://app.ovis.sh"));
    Object.assign(window.location, { href: link.href, hash: link.hash });
    window.dispatchEvent(new Event("hashchange"));
    await until(() => last().state.kind === "confirm", "the confirm");
    last().onPair();
    await until(() => apps === 1, "the app");
    holding = true;
    fatal!(new MuxProtocolError("auth_revoked", "fixture revoked"));
    await reading.promise;
    const before = { roots, drawn: rendered.length };
    providers.resolve(Response.json({ providers: ["github", "apple"], device: ["github"] }));
    await drain();
    expect({ roots, drawn: rendered.length }).toEqual(before);
    held.resolve();
    await until(() => last().state.kind === "failed", "the reason");
    expect(last().accountProviders).toEqual(["github", "apple"]);
    for (const transport of opened) transport.close();
  });

  // REGRESSION GUARD: only a consent stored one navigation earlier (the typed code's ID match, the Add-a-PC sheet)
  // skips the confirm. A link someone sends, with a code or without, never pairs by itself.
  it.each([["a code", "123456", false], ["no code", undefined, false], ["a code, signed in", "123456", true], ["no code, signed in", undefined, true]] as const)(
    "stops a link opened by navigation with %s at the confirm, and pairs only after the button", async (_what, code, signedIn) => {
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", ...(code === undefined ? {} : { code }) };
      const accountStore = memoryAccountStore();
      if (signedIn) await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
      let attempts = 0;
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        ...(signedIn ? { accountStore, accountService: SERVICE, accountProviders: ["github"] as const, accountFetch: async () => Response.json({ pcs: [] }) } : {}),
        open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await drain();
      expect(attempts).toBe(0);
      expect(last().state).toEqual({ kind: "confirm", offer, ...(signedIn ? { account: "unlisted" } : {}) });
      last().onPair();
      await until(() => attempts === 1, "the pairing");
    });

  // the confirm is the consent: what it said is what the pairing does to the account, whatever changed since it was drawn
  it("asks again, and pairs nothing, when a Pair press finds a sign-in stored after the confirm was drawn", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const accountStore = memoryAccountStore();
    const prepared: RelayTransportOptions[] = [];
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
      accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
      open: async (_offer, options = {}) => { prepared.push(options); throw new MuxProtocolError("auth_failed", "fixture declined"); },
    }));
    await until(() => last().state.kind === "confirm" && !("account" in last().state), "the signed-out confirm");
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    await drain();
    expect(last().state).toEqual({ kind: "confirm", offer });
    last().onPair();
    expect(last().state).toEqual({ kind: "confirm", offer, account: "checking", pressed: "own" });
    last().onPair();
    await until(() => last().state.kind === "confirm" && (last().state as { account?: string }).account === "unlisted", "the confirm asked again");
    await drain();
    expect(prepared).toHaveLength(0);
    last().onPair();
    await until(() => prepared.length === 1, "the pairing");
    expect(prepared[0]?.accountKey).toBeDefined();
  });

  it("asks again when the PC left the account's directory since the confirm said it was listed", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    let pcs: unknown[] = [{ server_id: offer.server_id, label: "Desk PC", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: AP }];
    let attempts = 0;
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
      accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs }),
      open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "fixture declined"); },
    }));
    const variant = () => { const { state } = last(); return state.kind === "confirm" ? state.account : state.kind; };
    await until(() => variant() === "listed", "the listed confirm");
    pcs = [];
    last().onPair();
    await until(() => variant() === "unlisted", "the confirm asked again");
    await drain();
    expect(attempts).toBe(0);
    last().onPair();
    await until(() => attempts === 1, "the pairing");
  });

  it("lets nothing be confirmed on a link pasted while a sign-in's return is still finishing, then asks as the signed-in device", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const accountStore = memoryAccountStore();
    await accountStore.set("pending", { "state-1": { service: SERVICE, provider: "github", state: "state-1", verifier: "verifier-123", redirect_uri: "https://app.ovis.sh/", started_at: Date.now() } });
    const token = Promise.withResolvers<Response>();
    let exchanging = false, attempts = 0;
    const mounted = mountRelayShell(mountFor({
      entryUrl: "https://app.ovis.sh/#code=good-code&state=state-1", store: deviceStore([]), navigate() {},
      accountStore, accountService: SERVICE, accountProviders: ["github"],
      accountFetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/pcs") return Response.json({ pcs: [] });
        if (new URL(String(input)).pathname === "/v1/providers") return new Response(null, { status: 404 });
        exchanging = true; return token.promise;
      },
      open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "fixture declined"); },
    }));
    await until(() => exchanging, "the token exchange");
    const link = new URL(encodeOffer(offer, "https://app.ovis.sh"));
    Object.assign(window.location, { href: link.href, hash: link.hash });
    window.dispatchEvent(new Event("hashchange"));
    await drain();
    expect(last().state).toEqual({ kind: "confirm", offer, account: "checking" });
    last().onPair();
    await drain();
    expect(attempts).toBe(0);
    token.resolve(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, account: "acct-test", provider: "github" }));
    await until(() => { const { state } = last(); return state.kind === "confirm" && state.account === "unlisted"; }, "the signed-in confirm");
    expect(attempts).toBe(0);
    await mounted;
  });

  it("pairs with a key of the device's own, and adds nothing to an account, when the confirm said so and a sign-in lands after the press", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const accountStore = memoryAccountStore();
    const session = { service: SERVICE, account: "acct-test", provider: "github" as const, access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 };
    const devices: RelayDevice[] = [];
    const store = deviceStore(devices);
    const prepared: RelayTransportOptions[] = [];
    let accountRequests = 0, apps = 0;
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
      override async fetch(): Promise<Response> { accountRequests++; return Response.json({}); }
    }
    const opened = new Admitted(offer);
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store, navigate() {}, shellVersion: "1.0.0",
      createRoot: () => ({ render(element: ReactElement) { rendered.push(element); if (shellProps(element).state.kind === "connecting") void accountStore.set("session", session); }, unmount() {} }),
      accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => { accountRequests++; return Response.json({ pcs: [] }); },
      renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
      open: async (_offer, options = {}) => {
        prepared.push(options);
        devices.push({ ...offer, device_id: "12".repeat(8), private_key: {} as CryptoKey, public_spki: "device-key", label: "Test phone" });
        return opened;
      },
    }));
    await until(() => last().state.kind === "confirm" && !("account" in last().state), "the signed-out confirm");
    last().onPair();
    await until(() => apps === 1, "the app");
    await drain();
    expect(await accountStore.get("session")).toEqual(session);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.accountKey).toBeUndefined();
    expect(accountRequests).toBe(0);
    expect(browser.sessionStore.has("ovis-device-only-pc")).toBe(false);
    opened.close();
  });

  it("keeps a pairing confirmed with a key of the device's own out of an account signed in meanwhile when the page reloads for a newer shell", async () => {
    browser.setVisibility("hidden");
    (window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage;
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const accountStore = memoryAccountStore();
    const session = { service: SERVICE, account: "acct-test", provider: "github" as const, access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 };
    const devices: RelayDevice[] = [];
    const store = deviceStore(devices);
    const prepared: RelayTransportOptions[] = [];
    const transports: RelayTransport[] = [];
    let accountRequests = 0, apps = 0, reloads = 0;
    class Newer extends RelayTransport {
      override get server() { return { version: "1.1.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
      override async renew() {}
      override async fetch(): Promise<Response> { accountRequests++; return Response.json({}); }
    }
    const page = (entryUrl: string, over: Partial<RelayShellMount> = {}) => mountRelayShell(mountFor({
      entryUrl, store, navigate() {}, shellVersion: "1.0.0", reload: async () => { reloads++; },
      accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => { accountRequests++; return Response.json({ pcs: [] }); },
      renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
      open: async (_offer, options = {}) => {
        prepared.push(options);
        if (devices.length === 0) devices.push({ ...offer, device_id: "12".repeat(8), private_key: {} as CryptoKey, public_spki: "device-key", label: "Test phone" });
        const opened = new Newer(offer); transports.push(opened); return opened;
      },
      ...over,
    }));
    await page(encodeOffer(offer, "https://app.ovis.sh"), {
      createRoot: () => ({ render(element: ReactElement) { rendered.push(element); if (shellProps(element).state.kind === "connecting") void accountStore.set("session", session); }, unmount() {} }),
    });
    await until(() => last().state.kind === "confirm" && !("account" in last().state), "the signed-out confirm");
    last().onPair();
    await until(() => reloads === 1, "the reload for the newer shell");
    expect(apps).toBe(0);
    expect(await accountStore.get("session")).toEqual(session);
    await page(`https://app.ovis.sh/s/${offer.server_id}/`);
    await until(() => apps === 1, "the app");
    await drain();
    expect(reloads).toBe(1);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.accountKey).toBeUndefined();
    expect(prepared[1]?.accountKey).toBeUndefined();
    expect(accountRequests).toBe(0);
    await page(`https://app.ovis.sh/s/${offer.server_id}/`);
    await until(() => apps === 2, "the app, on a later load");
    expect(prepared[2]?.accountKey).toBeDefined();
    for (const transport of transports) transport.close();
  });

  describe("a Pair press is held to the confirm it was made on", () => {
    const sessionOf = (who: string) => ({ service: SERVICE, account: `acct-${who}`, provider: "github" as const, access_token: who, refresh_token: `refresh-${who}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${who}` });
    const bearerOf = (input: Request | string | URL, init?: RequestInit): string => new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
    const variant = () => { const { state } = last(); return state.kind === "confirm" ? state.account : state.kind; };
    const listing = (offer: { server_id: string }) => [{ server_id: offer.server_id, label: "Desk PC", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: AP }];

    it("pairs nothing when Not now is pressed while the press reads the sign-in again", async () => {
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const held = Promise.withResolvers<Response>();
      const paths: string[] = [];
      let reads = 0, attempts = 0;
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate: (path) => { paths.push(path); },
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => ++reads === 1 ? Response.json({ pcs: [] }) : held.promise,
        open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      await until(() => reads === 2, "the press's read");
      expect(variant()).toBe("checking");
      last().onCancel();
      expect(paths).toEqual(["/"]);
      held.resolve(Response.json({ pcs: [] }));
      await drain();
      expect(attempts).toBe(0);
      expect(rendered.map((element) => shellProps(element).state.kind)).not.toContain("connecting");
    });

    it("asks again when another tab signed in as another account since the confirm was drawn, though neither lists the PC", async () => {
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const read: string[] = [];
      const prepared: RelayTransportOptions[] = [];
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async (input, init) => { read.push(bearerOf(input, init)); return Response.json({ pcs: [] }); },
        open: async (_offer, options = {}) => { prepared.push(options); throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await until(() => variant() === "unlisted", "the confirm for the first account");
      await accountStore.set("session", sessionOf("b"));
      last().onPair();
      await until(() => read.includes("Bearer b") && variant() === "unlisted", "the confirm asked again for the second account");
      await drain();
      expect(prepared).toHaveLength(0);
      last().onPair();
      await until(() => prepared.length === 1, "the pairing");
      expect(prepared[0]?.accountKey).toBeDefined();
    });

    it("reads the directory of a sign-in that took the place of the one a press was reading, and asks again", async () => {
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const held = Promise.withResolvers<Response>();
      const read: string[] = [];
      let attempts = 0;
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input, init) => { const bearer = bearerOf(input, init); read.push(bearer); return bearer === "Bearer b" ? Response.json({ pcs: listing(offer) }) : read.length === 1 ? Response.json({ pcs: [] }) : held.promise; },
        open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await until(() => variant() === "unlisted", "the confirm for the first account");
      last().onPair();
      await until(() => read.length === 2, "the press's read");
      await accountStore.set("session", sessionOf("b"));
      held.resolve(Response.json({ pcs: [] }));
      await until(() => variant() === "listed", "the confirm for the second account");
      expect(read).toEqual(["Bearer a", "Bearer a", "Bearer b"]);
      await drain();
      expect(attempts).toBe(0);
    });

    it("pairs nothing, and asks again, when the sign-in changes between the press's read and the pairing", async () => {
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      let attempts = 0, switched = false;
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        createRoot: () => ({ render(element: ReactElement) { rendered.push(element); if (!switched && shellProps(element).state.kind === "connecting") { switched = true; void accountStore.set("session", sessionOf("b")); } }, unmount() {} }),
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
        open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      await until(() => switched && variant() === "unlisted", "the confirm asked again");
      await drain();
      expect(attempts).toBe(0);
      last().onPair();
      await until(() => attempts === 1, "the pairing, confirmed for the sign-in stored now");
    });

    it("opens a PC this page paired again with the key it holds, and no account, once the sign-in the confirm named is gone", async () => {
      browser.setVisibility("hidden");
      const { code: _code, ...pc } = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const offer = { ...pc, code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const key = await accountStore.key();
      const devices: RelayDevice[] = [];
      const prepared: RelayTransportOptions[] = [];
      const transports: RelayTransport[] = [];
      const putPcs: string[] = [];
      let apps = 0;
      class Admitted extends RelayTransport {
        override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
        override async renew() {}
        override async fetch(path: string): Promise<Response> {
          if (path === "/api/account/status") return Response.json({ account: "acct-a", unlinked: [], removals: [], enrolling: false });
          if (path === "/api/account/introduction") return Response.json({ pcs: [] });
          throw new TypeError(`Unexpected PC request: ${path}`);
        }
      }
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore(devices), navigate() {}, shellVersion: "1.0.0",
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input, init) => { if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "PUT") putPcs.push(bearerOf(input, init)); return Response.json({ pcs: [] }); },
        renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
        open: async (_offer, options = {}) => {
          prepared.push(options);
          if (devices.length === 0) devices.push({ ...pc, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Test phone" });
          const opened = new Admitted(pc); transports.push(opened); return opened;
        },
      }));
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      await until(() => (devices[0] as { account_enrollment?: { state: string } } | undefined)?.account_enrollment?.state === "complete", "the enrollment");
      expect(apps).toBe(1);
      const listed = putPcs.length;
      await accountStore.set("session", sessionOf("b"));
      prepared.find((options) => options.onFatal)!.onFatal!(new Error("the session ended"));
      await until(() => last().state.kind === "failed", "the reason");
      last().onRetry();
      await until(() => apps === 2, "the PC, opened again");
      await drain();
      expect(prepared.at(-1)?.accountKey).toBeUndefined();
      expect(putPcs).toHaveLength(listed);
      expect(putPcs).not.toContain("Bearer b");
      for (const transport of transports) transport.close();
    });

    it("stops saying checking, and still pairs, when the account service never answers", async () => {
      jest.useFakeTimers();
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const prepared: RelayTransportOptions[] = [];
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: () => new Promise<Response>(() => {}),
        open: async (_offer, options = {}) => { prepared.push(options); throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await drain();
      expect(variant()).toBe("checking");
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => variant() === "unlisted", "the confirm without the directory");
      last().onPair();
      await drain();
      expect(variant()).toBe("checking");
      expect(prepared).toHaveLength(0);
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => prepared.length === 1, "the pairing");
      expect(prepared[0]?.accountKey).toBeDefined();
    });

    /**
     * The new row has no account (server/devices.ts, enrollRelay), so the status lists it as unlinked until its
     * `link` (accountRows), and the link ends the row's other sessions, the app's among them (linkAccountKey,
     * onLinked: `auth_changed`).
     */
    const accountPc = (account: string, deviceId: string, linked: () => void) => {
      let member = false;
      return (path: string): Response | undefined => {
        if (path === "/api/account/status") return Response.json({ account, unlinked: member ? [] : [deviceId], removals: [], adds: [], blocked: [], enrolling: false });
        if (path === "/api/account/link") { member = true; linked(); return Response.json({}); }
        if (path === "/api/account/introduction") return Response.json({ pcs: [] }, { status: 404 });
        return undefined;
      };
    };
    const pathOf = (input: RequestInfo | URL): string => typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;

    it("links and signs a fresh account pairing in again before the app opens, so nothing ends a terminal after it", async () => {
      browser.setVisibility("hidden");
      const { code: _code, ...pc } = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const offer = { ...pc, code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const key = await accountStore.key();
      const deviceId = "12".repeat(8);
      const devices: RelayDevice[] = [{ ...pc, device_id: null, private_key: key.private_key, public_spki: "own-key", label: "Test phone" }];
      const renewedAt: number[] = [], linkedAt: number[] = [];
      const transports: RelayTransport[] = [];
      let apps = 0;
      const answer = accountPc("acct-a", deviceId, () => { linkedAt.push(apps); });
      class Admitted extends RelayTransport {
        override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
        override async renew() { renewedAt.push(apps); }
        override async fetch(input: RequestInfo | URL): Promise<Response> {
          const response = answer(pathOf(input));
          if (response === undefined) throw new TypeError(`Unexpected PC request: ${pathOf(input)}`);
          return response;
        }
      }
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore(devices), navigate() {}, shellVersion: "1.0.0",
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
        renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
        open: async () => {
          devices[0] = { ...devices[0]!, device_id: deviceId, public_spki: key.public_spki };
          const opened = new Admitted(pc); transports.push(opened); return opened;
        },
      }));
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      await untilStored(() => (devices[0] as { account_enrollment?: { state: string } }).account_enrollment?.state === "complete");
      expect(apps).toBe(1);
      expect(linkedAt).toEqual([0]);
      expect(renewedAt).toEqual([0]);
      expect(rendered.map((element) => shellProps(element).state.kind)).not.toContain("ready");
      for (const transport of transports) transport.close();
    });

    it.each([["opens the PC anyway when the account's steps before it do not finish in time", false], ["opens nothing once Cancel is pressed while the account's steps run", true]] as const)("%s", async (_what, cancelled) => {
      jest.useFakeTimers();
      browser.setVisibility("hidden");
      const { code: _code, ...pc } = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const offer = { ...pc, code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const key = await accountStore.key();
      const devices: RelayDevice[] = [{ ...pc, device_id: null, private_key: key.private_key, public_spki: "own-key", label: "Test phone" }];
      const transports: RelayTransport[] = [];
      let apps = 0, asked = 0;
      class Admitted extends RelayTransport {
        override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
        override async renew() {}
        override fetch(): Promise<Response> { asked++; return new Promise<Response>(() => {}); }
      }
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore(devices), navigate() {}, shellVersion: "1.0.0",
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
        renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
        open: async () => {
          devices[0] = { ...devices[0]!, device_id: "12".repeat(8), public_spki: key.public_spki };
          const opened = new Admitted(pc); transports.push(opened); return opened;
        },
      }));
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      await until(() => asked === 1, "the account's status, asked of the PC");
      await drain();
      expect(apps).toBe(0);
      expect(last().state.kind).toBe("connecting");
      if (cancelled) last().onCancel();
      jest.advanceTimersByTime(ACCOUNT_STEPS_WAIT_MS);
      await drain();
      expect(apps).toBe(cancelled ? 0 : 1);
      for (const transport of transports) transport.close();
    });

    for (const then of ["another", "the same", "no"] as const) {
      it(`${then === "the same" ? "goes on adding the PC to the account its confirm named" : "adds the PC to no account"} when the page reloads for a newer shell with ${then} sign-in stored by then`, async () => {
        browser.setVisibility("hidden");
        (window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage;
        const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
        const accountStore = memoryAccountStore();
        await accountStore.set("session", sessionOf("a"));
        const devices: RelayDevice[] = [];
        const store = deviceStore(devices);
        const prepared: RelayTransportOptions[] = [];
        const transports: RelayTransport[] = [];
        const written: string[] = [];
        let asked = 0, apps = 0, reloads = 0;
        class Newer extends RelayTransport {
          override get server() { return { version: "1.1.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
          override async renew() {}
          override async fetch(): Promise<Response> { asked++; return Response.json({}); }
        }
        const page = (entryUrl: string) => mountRelayShell(mountFor({
          entryUrl, store, navigate() {}, shellVersion: "1.0.0",
          reload: async () => { reloads++; if (then === "another") await accountStore.set("session", sessionOf("b")); else if (then === "no") await accountStore.set("session", undefined); },
          accountStore, accountService: SERVICE, accountProviders: ["github"],
          accountFetch: async (input, init) => {
            const method = input instanceof Request ? input.method : init?.method ?? "GET";
            if (method !== "GET") written.push(`${bearerOf(input, init)} ${method} ${new URL(String(input instanceof Request ? input.url : input)).pathname}`);
            return Response.json({ pcs: [] });
          },
          renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
          open: async (_offer, options = {}) => {
            prepared.push(options);
            if (devices.length === 0) devices.push({ ...offer, device_id: "12".repeat(8), private_key: {} as CryptoKey, public_spki: "device-key", label: "Test phone" });
            const opened = new Newer(offer); transports.push(opened); return opened;
          },
        }));
        await page(encodeOffer(offer, "https://app.ovis.sh"));
        await until(() => variant() === "unlisted", "the confirm, drawn for the first sign-in");
        last().onPair();
        await until(() => reloads === 1, "the reload for the newer shell");
        expect(apps).toBe(0);
        expect(prepared[0]?.accountKey).toBeDefined();
        // what crosses the reload names the sign-in, and holds none of its tokens
        expect([...browser.sessionStore.values()].join()).toContain("sign-in-a");
        expect([...browser.sessionStore.values()].join()).not.toMatch(/refresh-a|"a"/);
        const before = { written: written.length, asked };
        await page(`https://app.ovis.sh/s/${offer.server_id}/`);
        await until(() => apps === 1, "the app");
        await settleSigned();
        expect(prepared).toHaveLength(2);
        if (then === "the same") {
          expect(prepared[1]?.accountKey).toBeDefined();
          expect(asked).toBeGreaterThan(before.asked);
        } else {
          // the confirm was drawn for the first sign-in: the one stored now gets nothing of this pairing
          expect(prepared[1]?.accountKey).toBeUndefined();
          expect(asked).toBe(before.asked);
          expect(written.slice(before.written)).toEqual([]);
        }
        expect(browser.sessionStore.has("ovis-confirmed-sign-in")).toBe(false);
        for (const transport of transports) transport.close();
      });
    }

    for (const confirm of ["a sign-in", "a key of the device's own"] as const) {
      it(`adds the PC to no account when the reloaded page is itself interrupted while it connects, and another sign-in is stored by the load after it (the confirm named ${confirm})`, async () => {
        browser.setVisibility("hidden");
        (window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage;
        const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
        const accountStore = memoryAccountStore();
        if (confirm === "a sign-in") await accountStore.set("session", sessionOf("a"));
        const devices: RelayDevice[] = [];
        const store = deviceStore(devices);
        const prepared: RelayTransportOptions[] = [];
        const transports: RelayTransport[] = [];
        const written: string[] = [];
        let asked = 0, apps = 0, reloads = 0, hangs = 0;
        class Newer extends RelayTransport {
          override get server() { return { version: "1.1.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
          override async renew() {}
          override async fetch(): Promise<Response> { asked++; return Response.json({}); }
        }
        const page = (entryUrl: string, hang = false) => mountRelayShell(mountFor({
          entryUrl, store, navigate() {}, shellVersion: "1.0.0", reload: async () => { reloads++; },
          accountStore, accountService: SERVICE, accountProviders: ["github"],
          accountFetch: async (input, init) => {
            const method = input instanceof Request ? input.method : init?.method ?? "GET";
            if (method !== "GET") written.push(`${bearerOf(input, init)} ${method} ${new URL(String(input instanceof Request ? input.url : input)).pathname}`);
            return Response.json({ pcs: [] });
          },
          renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
          open: async (_offer, options = {}) => {
            if (hang) { hangs++; return new Promise<RelayTransport>(() => {}); }
            prepared.push(options);
            if (devices.length === 0) devices.push({ ...offer, device_id: "12".repeat(8), private_key: {} as CryptoKey, public_spki: "device-key", label: "Test phone" });
            const opened = new Newer(offer); transports.push(opened); return opened;
          },
        }));
        await page(encodeOffer(offer, "https://app.ovis.sh"));
        await until(() => confirm === "a sign-in" ? variant() === "unlisted" : last().state.kind === "confirm" && !("account" in last().state), "the confirm");
        last().onPair();
        await until(() => reloads === 1, "the reload for the newer shell");
        expect(prepared[0]?.accountKey !== undefined).toBe(confirm === "a sign-in");
        const before = { written: written.length, asked };
        void page(`https://app.ovis.sh/s/${offer.server_id}/`, true);
        await until(() => hangs === 1, "the connecting that never ends");
        await accountStore.set("session", sessionOf("b"));
        await page(`https://app.ovis.sh/s/${offer.server_id}/`);
        await until(() => apps === 1, "the app");
        await settleSigned();
        expect(prepared).toHaveLength(2);
        expect(prepared[1]?.accountKey).toBeUndefined();
        expect(asked).toBe(before.asked);
        expect(written.slice(before.written)).toEqual([]);
        expect(browser.sessionStore.has("ovis-confirmed-sign-in")).toBe(false);
        expect(browser.sessionStore.has("ovis-device-only-pc")).toBe(false);
        for (const transport of transports) transport.close();
      });
    }

    it("opens a signed-in fresh pairing's PC once the update it needed is installed", async () => {
      jest.useFakeTimers();
      browser.setVisibility("hidden");
      const { code: _code, ...pc } = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const offer = { ...pc, code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const key = await accountStore.key();
      const deviceId = "12".repeat(8);
      const devices: RelayDevice[] = [{ ...pc, device_id: null, private_key: key.private_key, public_spki: "own-key", label: "Test phone" }];
      const transports: RelayTransport[] = [];
      let apps = 0, version = "0.1.0", installs = 0;
      const answer = accountPc("acct-a", deviceId, () => undefined);
      class Admitted extends RelayTransport {
        override get server() { return { version, relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
        override async renew() {}
        override async fetch(input: RequestInfo | URL): Promise<Response> {
          const path = pathOf(input);
          if (path === "/api/updates") return Response.json({ managed: true, available: true, latest_revision: "rev-2", phase: "idle" });
          if (path === "/api/updates/install") { installs++; return Response.json({}); }
          const response = answer(path);
          if (response === undefined) throw new TypeError(`Unexpected PC request: ${path}`);
          return response;
        }
      }
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore(devices), navigate() {}, shellVersion: "1.0.0",
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
        renderApp: () => { apps++; return { render() {}, unmount() {} }; }, pendingPush: { get: async () => undefined, clear: async () => {} },
        open: async () => {
          devices[0] = { ...devices[0]!, device_id: deviceId, public_spki: key.public_spki };
          const opened = new Admitted(pc); transports.push(opened); return opened;
        },
      }));
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      const update = () => { const { state } = last(); return state.kind === "outdated" ? state.update.phase : state.kind; };
      await until(() => update() === "offer", "the Update button");
      last().onUpdate();
      await until(() => installs === 1, "the install");
      await drain();
      version = "1.0.0";
      jest.advanceTimersByTime(1_000);
      // the PC opens once the link and the renewal are done, before the enrollment records itself complete
      await untilStored(() => (devices[0] as { account_enrollment?: { state: string } }).account_enrollment?.state === "complete");
      expect(apps).toBe(1);
      for (const transport of transports) transport.close();
    });

    it("stops saying checking, and pairs with a key of the device's own, when the sign-in on this device cannot be read", async () => {
      jest.useFakeTimers();
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const memory = memoryAccountStore();
      const accountStore = { ...memory, update: () => new Promise<void>(() => {}) };
      const prepared: RelayTransportOptions[] = [];
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
        open: async (_offer, options = {}) => { prepared.push(options); throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      await drain();
      expect(variant()).toBe("checking");
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => last().state.kind === "confirm" && variant() === undefined, "the confirm without a sign-in");
      last().onPair();
      await drain();
      expect(variant()).toBe("checking");
      expect(prepared).toHaveLength(0);
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => prepared.length === 1, "the pairing");
      expect(prepared[0]?.accountKey).toBeUndefined();
    });

    it("keeps the wording a press was made on while the press is checked", async () => {
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", sessionOf("a"));
      const held = Promise.withResolvers<Response>();
      let reads = 0;
      await mountRelayShell(mountFor({
        entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), navigate() {},
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => ++reads === 1 ? Response.json({ pcs: [] }) : held.promise,
        open: async () => { throw new MuxProtocolError("auth_failed", "fixture declined"); },
      }));
      expect(rendered.map((element) => shellProps(element).state).filter((state) => state.kind === "confirm" && state.account === "checking")).not.toHaveLength(0);
      expect(rendered.map((element) => shellProps(element).state).some((state) => state.kind === "confirm" && state.pressed !== undefined)).toBe(false);
      await until(() => variant() === "unlisted", "the confirm");
      last().onPair();
      await until(() => reads === 2, "the press's read");
      expect(last().state).toEqual({ kind: "confirm", offer, account: "checking", pressed: "unlisted" });
      last().onCancel();
      held.resolve(Response.json({ pcs: [] }));
      await drain();
    });
  });

  it("says on the confirm whether the pairing adds the PC to the account: nothing confirmable until the sign-in is read, then by the directory", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const confirm = () => { const { state } = last(); if (state.kind !== "confirm") throw new Error(`not the confirm: ${state.kind}`); return state; };
    const signedInMount = async (pcs: unknown[], signedIn = true) => {
      const accountStore = memoryAccountStore();
      if (signedIn) await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
      const directory = Promise.withResolvers<Response>();
      rendered = [];
      await mountRelayShell(mountFor({ entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: () => directory.promise }));
      return () => directory.resolve(Response.json({ pcs }));
    };
    const answer = await signedInMount([{ server_id: offer.server_id, label: "Desk PC", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: AP }]);
    expect(shellProps(rendered[0]!).state).toMatchObject({ kind: "confirm", account: "checking" });
    await drain();
    expect(confirm().account).toBe("checking");
    last().onPair();
    await drain();
    expect(confirm().account).toBe("checking");
    answer();
    await until(() => confirm().account === "listed", "the directory");
    const failing = Promise.withResolvers<Response>();
    rendered = [];
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    await mountRelayShell(mountFor({ entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: () => failing.promise }));
    await drain();
    expect(confirm().account).toBe("checking");
    failing.reject(new TypeError("offline"));
    await until(() => confirm().account === "unlisted", "the failed read");
    await signedInMount([], false);
    expect(shellProps(rendered[0]!).state).toMatchObject({ kind: "confirm", account: "checking" });
    await until(() => confirm().account === undefined, "the missing sign-in");
  });

  describe("a launch", () => {
    const pcs = async (...ids: string[]): Promise<RelayDevice[]> => {
      const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      return ids.map((server_id) => ({ server_id, server_public_key: "k", relay: AP, device_id: "paired", private_key: key.privateKey, public_spki: "fixture", label: "Phone" }));
    };
    const launch = (): void => { browser.sessionStore.delete("ovis-launched"); };
    // every saved PC answers its check, unless a test says which do not
    const answering = (off: readonly string[] = []): RelayShellMount["checkPc"] => async (device) => off.includes(device.server_id) ? { kind: "offline", reason: "pc" } : { kind: "answered", route: "relay", relay: AP, rttMs: 20 };

    it("opens the PC this device opened last, by its saved pairing, once per tab", async () => {
      launch();
      localStorage.setItem("ovis-last-pc", "b".repeat(32));
      const went: string[] = [];
      const store = deviceStore(await pcs("a".repeat(32), "b".repeat(32)));
      await mountRelayShell(mountFor({ store, navigate: (path) => { went.push(path); }, checkPc: answering() }));
      expect(went).toEqual([`/s/${"b".repeat(32)}/`]);
      // only the wait for its answer was drawn, never the front page
      expect(rendered.map((element) => shellProps(element).state.kind)).toEqual(["connecting"]);
      // Back from that PC: the front page stays
      await mountRelayShell(mountFor({ store, navigate: (path) => { went.push(path); }, checkPc: answering() }));
      expect(went).toHaveLength(1);
      expect(rendered.length).toBeGreaterThan(0);
    });

    it("opens only a finished pairing, never a row still waiting for one", async () => {
      launch();
      const went: string[] = [];
      const [unfinished, done] = await pcs("a".repeat(32), "b".repeat(32));
      localStorage.setItem("ovis-last-pc", "a".repeat(32));
      await mountRelayShell(mountFor({ store: deviceStore([{ ...unfinished!, device_id: null }, done!]), navigate: (path) => { went.push(path); }, checkPc: answering() }));
      expect(went).toEqual([`/s/${"b".repeat(32)}/`]);
    });

    it("opens the first saved PC when the one opened last is gone, and nothing with none saved", async () => {
      launch();
      localStorage.setItem("ovis-last-pc", "f".repeat(32));
      const went: string[] = [];
      await mountRelayShell(mountFor({ store: deviceStore(await pcs("a".repeat(32))), navigate: (path) => { went.push(path); }, checkPc: answering() }));
      expect(went).toEqual([`/s/${"a".repeat(32)}/`]);
      launch();
      await mountRelayShell(mountFor({ store: deviceStore([]), navigate: (path) => { went.push(path); } }));
      expect(went).toHaveLength(1);
    });

    it("opens the next saved PC that answers when the one opened last is off, and Add a PC when none answers", async () => {
      const [a, b, c] = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
      const went: string[] = [];
      launch();
      localStorage.setItem("ovis-last-pc", b);
      await mountRelayShell(mountFor({ store: deviceStore(await pcs(a, b, c)), navigate: (path) => { went.push(path); }, checkPc: answering([b]) }));
      expect(went).toEqual([`/s/${a}/`]);
      launch();
      await mountRelayShell(mountFor({ store: deviceStore(await pcs(a, b)), navigate: (path) => { went.push(path); }, checkPc: answering([a, b]) }));
      expect(went).toHaveLength(1);
      expect(last().state.kind).toBe("list");
    });

    it("opens the PC opened last when its check says nothing of it (the relay refused or could not be reached), as before", async () => {
      const went: string[] = [];
      launch();
      localStorage.setItem("ovis-last-pc", "b".repeat(32));
      await mountRelayShell(mountFor({ store: deviceStore(await pcs("a".repeat(32), "b".repeat(32))), navigate: (path) => { went.push(path); }, checkPc: async () => ({ kind: "offline", reason: "relay" }) }));
      expect(went).toEqual([`/s/${"b".repeat(32)}/`]);
    });

    it("goes on to the front page when the PC a launch opened turns out off, and keeps the card for a PC a person opened", async () => {
      const { server_id, server_public_key } = keyFor();
      const [saved] = await pcs(server_id);
      const scope = `https://app.ovis.sh/s/${server_id}/`;
      const off = async (): Promise<never> => { throw new RelayPcOfflineError(); };
      for (const [launched, expected] of [[true, ["/"]], [false, []]] as const) {
        const went: string[] = [];
        if (launched) browser.sessionStore.set("ovis-launched-pc", server_id);
        await mountRelayShell(mountFor({ entryUrl: scope, store: deviceStore([{ ...saved!, server_public_key }]), navigate: (path) => { went.push(path); }, open: off }));
        // the launch goes on at the front page with the account's PCs; a PC a person opened leaves nothing behind
        expect(browser.sessionStore.get("ovis-launch-account")).toBe(launched ? "1" : undefined);
        browser.sessionStore.delete("ovis-launch-account");
        if (!launched) await until(() => rendered.length > 0 && last().state.kind === "failed", "the PC's failure card");
        expect(went).toEqual([...expected]);
        expect(browser.sessionStore.has("ovis-launched-pc")).toBe(false);
      }
    });

    it("keeps the card of a launched PC that answered but did not finish connecting in time: it is on, maybe busy", async () => {
      const { server_id, server_public_key } = keyFor();
      const [saved] = await pcs(server_id);
      const went: string[] = [];
      browser.sessionStore.set("ovis-launched-pc", server_id);
      await mountRelayShell(mountFor({ entryUrl: `https://app.ovis.sh/s/${server_id}/`, store: deviceStore([{ ...saved!, server_public_key }]), navigate: (path) => { went.push(path); },
        open: async () => { throw new RelayAdmissionTimeoutError("welcome"); } }));
      await until(() => rendered.length > 0 && last().state.kind === "failed", "the PC's failure card");
      expect([went, (last().state as { failure?: string }).failure, browser.sessionStore.has("ovis-launch-account")]).toEqual([[], "pc-unresponsive", false]);
    });

    it.each(["auth_changed", "internal_error", "timeout"])("keeps the card of a launched PC that answered and refused (%s): it is on", async (code) => {
      const { server_id, server_public_key } = keyFor();
      const [saved] = await pcs(server_id);
      const went: string[] = [];
      browser.sessionStore.set("ovis-launched-pc", server_id);
      await mountRelayShell(mountFor({ entryUrl: `https://app.ovis.sh/s/${server_id}/`, store: deviceStore([{ ...saved!, server_public_key }]), navigate: (path) => { went.push(path); },
        open: async () => { throw new MuxProtocolError(code, "the PC refused"); } }));
      await until(() => rendered.length > 0 && last().state.kind === "failed", "the PC's failure card");
      expect([went, browser.sessionStore.has("ovis-launch-account")]).toEqual([[], false]);
    });

    it("drops a launch's mark on a front page that comes back first, so a PC opened by a person later keeps its card", async () => {
      browser.sessionStore.set("ovis-launched-pc", "a".repeat(32));
      await mountRelayShell(mountFor({ store: deviceStore([]), navigate: () => {} }));
      expect(browser.sessionStore.has("ovis-launched-pc")).toBe(false);
    });

    it("takes the phone app's #pcs as its way to the front page, never the dashboard, and opens no PC from it", async () => {
      const replaced: string[] = [];
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true } });
      (window.history as unknown as { replaceState: (state: unknown, title: string, url: string) => void }).replaceState = (_state, _title, url) => { replaced.push(url); };
      const went: string[] = [];
      launch();
      try {
        await mountRelayShell(mountFor({ store: deviceStore(await pcs("a".repeat(32))), entryUrl: "https://app.ovis.sh/#pcs", navigate: (path) => { went.push(path); }, checkPc: answering() }));
      } finally { Reflect.deleteProperty(globalThis, "Capacitor"); }
      expect(replaced).toEqual(["/"]);
      expect(went).toEqual([]);
    });

    it("lets an address taken while the launch waits (the dashboard's) win over the PC that answers", async () => {
      const went: string[] = [];
      let navigated = false;
      const answer = Promise.withResolvers<void>();
      launch();
      const mounted = mountRelayShell(mountFor({
        store: deviceStore(await pcs("a".repeat(32))), navigate: (path) => { went.push(path); }, navigatedSinceEntry: () => navigated,
        checkPc: async () => { await answer.promise; return { kind: "answered", route: "relay", relay: AP, rttMs: 20 }; },
      }));
      await until(() => rendered.length > 0 && last().state.kind === "connecting", "the launch's wait");
      navigated = true;
      answer.resolve();
      await mounted;
      expect(went).toEqual([]);
      expect(last().state.kind).toBe("list");
    });

    it("draws the front page again, not the launch's wait, when Back restores it whole from the browser's cache", async () => {
      const reloads: string[] = [];
      const location = window.location as unknown as { reload: () => void };
      location.reload = () => { reloads.push("reload"); };
      launch();
      await mountRelayShell(mountFor({ store: deviceStore(await pcs("a".repeat(32))), navigate: () => {}, checkPc: answering() }));
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
      expect(reloads).toEqual(["reload"]);
    });

    // the page a sign-in returns to (#code=…) opens the saved PC once its sign-in is read, as the launch it continues would
    const returned = async (store: ShellDeviceStore, went: string[], listed: unknown[] = [], checkPc: RelayShellMount["checkPc"] = answering()): Promise<void> => {
      const accountStore = memoryAccountStore();
      await accountStore.set("pending", { "state-1": { service: SERVICE, provider: "github", state: "state-1", verifier: "verifier-123", redirect_uri: "https://app.ovis.sh/", started_at: Date.now() } });
      let exchanged = 0;
      await mountRelayShell(mountFor({
        entryUrl: "https://app.ovis.sh/#code=good-code&state=state-1", store, navigate: (path) => { went.push(path); }, checkPc,
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/pcs") return Response.json({ pcs: listed });
          if (["/v1/devices/challenge", "/v1/providers"].includes(new URL(String(input)).pathname)) return new Response(null, { status: 404 });
          exchanged++;
          return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, account: "acct-test", provider: "github" });
        },
      }));
      expect(exchanged).toBe(1);
      expect(await accountStore.get("session")).toMatchObject({ account: "acct-test" });
    };

    it("opens the saved PC once a sign-in's return is read, exactly once, and a reload after it stays on the front page", async () => {
      browser.setVisibility("hidden");
      const went: string[] = [];
      const store = deviceStore(await pcs("a".repeat(32)));
      // the launch that started the sign-in already passed this tab's first front page
      await returned(store, went);
      expect(went).toEqual([`/s/${"a".repeat(32)}/`]);
      await mountRelayShell(mountFor({ store, navigate: (path) => { went.push(path); }, checkPc: answering() }));
      expect(went).toHaveLength(1);
    });

    it("opens the saved PC that answers a check already under way when a sign-in returns, and asks it once", async () => {
      const went: string[] = [];
      const asked: string[] = [];
      const answers: (() => void)[] = [];
      // a key that names its id, as a real pairing's does: the regular sweep checks it too, so its check is under way first
      const { server_id, server_public_key } = keyFor();
      const [saved] = await pcs(server_id);
      const store = deviceStore([{ ...saved!, server_public_key }]);
      const checkPc: RelayShellMount["checkPc"] = (device) => { asked.push(device.server_id); return new Promise((resolve) => { answers.push(() => resolve({ kind: "answered", route: "relay", relay: AP, rttMs: 20 })); }); };
      const mounted = returned(store, went, [], checkPc);
      // the launch waits on the check the sweep started before it, which answers only now
      await until(() => answers.length > 0 && rendered.length > 0 && last().state.kind === "connecting", "the launch's wait on the PC's check");
      for (const answer of answers.splice(0)) answer();
      await mounted;
      await until(() => went.length > 0, "the PC opened");
      expect(went).toEqual([`/s/${server_id}/`]);
      expect(asked).toHaveLength(1);
    });

    it("asks the saved PCs once a page: a sign-in landing after a launch that found none answering asks none again", async () => {
      const went: string[] = [];
      const asked: string[] = [];
      const store = deviceStore(await pcs("a".repeat(32)));
      await returned(store, went, [], async (device) => { asked.push(device.server_id); return { kind: "offline", reason: "pc" }; });
      expect(went).toEqual([]);
      expect(asked).toHaveLength(1);
      expect(last().state.kind).toBe("list");
    });

    it("opens nothing after a sign-in's return with no saved pairing, though the account lists PCs", async () => {
      browser.setVisibility("hidden");
      const went: string[] = [];
      await returned(deviceStore([]), went, [{ server_id: "b".repeat(32), label: "Desk PC", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: AP }]);
      expect(went).toEqual([]);
      expect(last().state.kind).toBe("empty");
    });

    it("opens the account's PC this device is not in yet after a sign-in, to join it on its own page, the one seen last first", async () => {
      browser.setVisibility("hidden");
      const went: string[] = [];
      const row = (label: string, seenAgo: number | null) => {
        const pair = generateKeyPair();
        return { server_id: deriveServerId(pair.publicKey), label, added_at: new Date(Date.now() - 864e5).toISOString(), last_seen_at: seenAgo === null ? null : new Date(Date.now() - seenAgo).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      };
      const older = row("Older", 5 * 60_000), recent = row("Recent", 60_000), off = row("Off", null);
      // new in the account: never picked by itself, however recently seen (security-triage condition 3)
      const fresh = { ...row("New", 1_000), new_until: new Date(Date.now() + 3_600_000).toISOString() };
      await returned(deviceStore([]), went, [off, older, fresh, recent]);
      await until(() => went.length > 0, "the account's PC opened");
      expect(went).toEqual([expect.stringMatching(new RegExp(`^/s/${recent.server_id}/#offer=`))]);
      // its join card waits for the person's press: nothing was confirmed for it
      expect(browser.sessionStore.get("ovis-confirmed-pc")).toBeUndefined();
    });

    it("opens the account's PC on a cold launch with a stored sign-in and nothing saved here, once both are read", async () => {
      browser.setVisibility("hidden");
      launch();
      const went: string[] = [];
      const pair = generateKeyPair();
      const listed = { server_id: deriveServerId(pair.publicKey), label: "Desk", added_at: new Date(Date.now() - 864e5).toISOString(), last_seen_at: new Date(Date.now() - 60_000).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
      await mountRelayShell(mountFor({
        store: deviceStore([]), navigate: (path) => { went.push(path); }, accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/pcs") return Response.json({ pcs: [listed] });
          return new Response(null, { status: 404 });
        },
      }));
      await until(() => went.length > 0, "the account's PC opened");
      expect(went).toEqual([expect.stringMatching(new RegExp(`^/s/${listed.server_id}/#offer=`))]);
    });

    it("goes on to the join card of an account PC this device is not in yet when every saved PC is off", async () => {
      launch();
      const went: string[] = [];
      const pair = generateKeyPair();
      const listed = { server_id: deriveServerId(pair.publicKey), label: "Office", added_at: new Date(Date.now() - 864e5).toISOString(), last_seen_at: new Date(Date.now() - 60_000).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
      await mountRelayShell(mountFor({
        store: deviceStore(await pcs("a".repeat(32))), navigate: (path) => { went.push(path); }, checkPc: answering(["a".repeat(32)]),
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => new URL(String(input)).pathname === "/v1/pcs" ? Response.json({ pcs: [listed] }) : new Response(null, { status: 404 }),
      }));
      await until(() => went.length > 0, "the account PC's join card");
      expect(went).toEqual([expect.stringMatching(new RegExp(`^/s/${listed.server_id}/#offer=`))]);
    });

    it("goes on to an account PC's join card when the saved PC a launch opened turned out off on its own page", async () => {
      // the tab's launch is past (ovis-launched): only the mark the off PC's page left sends the front page on
      browser.sessionStore.set("ovis-launch-account", "1");
      const went: string[] = [];
      const pair = generateKeyPair();
      const listed = { server_id: deriveServerId(pair.publicKey), label: "Office", added_at: new Date(Date.now() - 864e5).toISOString(), last_seen_at: new Date(Date.now() - 60_000).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
      await mountRelayShell(mountFor({
        store: deviceStore(await pcs("a".repeat(32))), navigate: (path) => { went.push(path); },
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => new URL(String(input)).pathname === "/v1/pcs" ? Response.json({ pcs: [listed] }) : new Response(null, { status: 404 }),
      }));
      await until(() => went.length > 0, "the account PC's join card");
      expect(went).toEqual([expect.stringMatching(new RegExp(`^/s/${listed.server_id}/#offer=`))]);
      expect(browser.sessionStore.has("ovis-launch-account")).toBe(false);
    });

    it("takes a just-added account PC no device is in yet to its new-PC card, typing the number its screen shows", async () => {
      launch();
      const went: string[] = [];
      const pair = generateKeyPair();
      const fresh = { server_id: deriveServerId(pair.publicKey), label: "Fresh", added_at: new Date(Date.now() - 60_000).toISOString(), last_seen_at: null, public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      const accountStore = memoryAccountStore();
      await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
      await mountRelayShell(mountFor({
        store: deviceStore([]), navigate: (path) => { went.push(path); }, accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => new URL(String(input)).pathname === "/v1/pcs" ? Response.json({ pcs: [fresh] }) : new Response(null, { status: 404 }),
      }));
      await until(() => went.length > 0, "the new PC's card");
      expect(JSON.parse(browser.sessionStore.get(SHEET_JOIN) ?? "null")).toMatchObject({ mode: "new", server_id: fresh.server_id, alone: true });
      expect(browser.sessionStore.get("ovis-typed-join")).toBe(fresh.server_id);
    });

    it("opens no account PC once Cancel was pressed on the launch's wait for the account's PCs", async () => {
      browser.setVisibility("hidden");
      const went: string[] = [];
      const pair = generateKeyPair();
      const listed = { server_id: deriveServerId(pair.publicKey), label: "Desk", added_at: new Date(Date.now() - 864e5).toISOString(), last_seen_at: new Date(Date.now() - 60_000).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      const directory = Promise.withResolvers<Response>();
      const accountStore = memoryAccountStore();
      await accountStore.set("pending", { "state-1": { service: SERVICE, provider: "github", state: "state-1", verifier: "verifier-123", redirect_uri: "https://app.ovis.sh/", started_at: Date.now() } });
      const mounted = mountRelayShell(mountFor({
        entryUrl: "https://app.ovis.sh/#code=good-code&state=state-1", store: deviceStore([]), navigate: (path) => { went.push(path); },
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/pcs") return directory.promise;
          if (["/v1/devices/challenge", "/v1/providers"].includes(path)) return new Response(null, { status: 404 });
          return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, account: "acct-test", provider: "github" });
        },
      }));
      await until(() => rendered.length > 0 && last().state.kind === "connecting", "the launch's wait for the account's PCs");
      last().onCancel();
      directory.resolve(Response.json({ pcs: [listed] }));
      await mounted;
      await drain();
      expect(went).toEqual([]);
      expect(last().state.kind).not.toBe("connecting");
    });

    it("opens no account PC when the account's PCs answer after the launch's wait gave up", async () => {
      browser.setVisibility("hidden");
      const went: string[] = [];
      const pair = generateKeyPair();
      const listed = { server_id: deriveServerId(pair.publicKey), label: "Desk", added_at: new Date(Date.now() - 864e5).toISOString(), last_seen_at: new Date(Date.now() - 60_000).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
      const directory = Promise.withResolvers<Response>();
      const accountStore = memoryAccountStore();
      await accountStore.set("pending", { "state-1": { service: SERVICE, provider: "github", state: "state-1", verifier: "verifier-123", redirect_uri: "https://app.ovis.sh/", started_at: Date.now() } });
      jest.useFakeTimers();
      const mounted = mountRelayShell(mountFor({
        entryUrl: "https://app.ovis.sh/#code=good-code&state=state-1", store: deviceStore([]), navigate: (path) => { went.push(path); },
        accountStore, accountService: SERVICE, accountProviders: ["github"],
        accountFetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/pcs") return directory.promise;
          if (["/v1/devices/challenge", "/v1/providers"].includes(path)) return new Response(null, { status: 404 });
          return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, account: "acct-test", provider: "github" });
        },
      }));
      await until(() => rendered.length > 0 && last().state.kind === "connecting", "the launch's wait for the account's PCs");
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => last().state.kind !== "connecting", "the front page after the wait");
      directory.resolve(Response.json({ pcs: [listed] }));
      await mounted;
      await drain();
      expect(went).toEqual([]);
      expect(last().state.kind).not.toBe("connecting");
    });

    const directoryRow = (server_id: string, newFor: number | null) => ({ server_id, label: "Desk PC", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: AP,
      new_until: newFor === null ? null : new Date(Date.now() + newFor).toISOString() });
    const signedInLaunch = async (store: ShellDeviceStore, last: string, accountFetch: NonNullable<RelayShellMount["accountFetch"]>): Promise<string[]> => {
      launch();
      localStorage.setItem("ovis-last-pc", last);
      const accountStore = memoryAccountStore();
      await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000, sign_in_id: "launch-test" });
      const went: string[] = [];
      await mountRelayShell(mountFor({ store, navigate: (path) => { went.push(path); }, accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch }));
      return went;
    };

    // security-triage ruling (a): a launch reopens only a pairing this device made by hand, whatever the account service says
    it("C3: a launch never opens a PC that only an account introduction saved here, and still opens one paired by hand", async () => {
      const [introduced, byHand] = await pcs("c".repeat(32), "d".repeat(32));
      // the PC opened last is gone (forgotten): the fallback must not be the introduced one
      expect(await signedInLaunch(deviceStore([{ ...introduced!, introduced_at: Date.now() }]), "e".repeat(32), async () => new Response(null, { status: 503 }))).toEqual([]);
      expect(await signedInLaunch(deviceStore([{ ...introduced!, introduced_at: Date.now() }, byHand!]), "e".repeat(32), async () => new Response(null, { status: 503 }))).toEqual([`/s/${"d".repeat(32)}/`]);
    });

    it("C3: a launch whose account list read fails still reopens the PC this device paired with by hand", async () => {
      const went = await signedInLaunch(deviceStore(await pcs("a".repeat(32))), "a".repeat(32), async () => new Response(null, { status: 503 }));
      expect(went).toEqual([`/s/${"a".repeat(32)}/`]);
    });

    it("C3: a launch never opens a PC this device reaches only through the account, new or not, the list read failing or not", async () => {
      // after a one-press add of PC X elsewhere, this device has no saved pairing for X: nothing makes one without a hand action here
      const account = "b".repeat(32);
      expect(await signedInLaunch(deviceStore([]), account, async (input) => new URL(String(input)).pathname === "/v1/pcs" ? Response.json({ pcs: [directoryRow(account, 3_600_000)] }) : new Response(null, { status: 404 }))).toEqual([]);
      expect(await signedInLaunch(deviceStore([]), account, async () => new Response(null, { status: 503 }))).toEqual([]);
      expect(last().state.kind).toBe("empty");
    });

    it("opens nothing after a refused or cancelled sign-in, whose reason the sign-in screen says", async () => {
      browser.setVisibility("hidden");
      const went: string[] = [];
      const accountStore = memoryAccountStore();
      await accountStore.set("pending", { "state-1": { service: SERVICE, provider: "github", state: "state-1", verifier: "verifier-123", redirect_uri: "https://app.ovis.sh/", started_at: Date.now() } });
      await mountRelayShell(mountFor({
        entryUrl: "https://app.ovis.sh/#error=access_denied&state=state-1", store: deviceStore(await pcs("a".repeat(32))), navigate: (path) => { went.push(path); },
        accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }),
      }));
      expect(went).toEqual([]);
      expect(last().state).toMatchObject({ kind: "list", account: { kind: "signed-out" } });
    });

    it("leaves a page that moved while the saved pairings were read where it was taken", async () => {
      launch();
      const went: string[] = [];
      await mountRelayShell(mountFor({ store: deviceStore(await pcs("a".repeat(32))), navigate: (path) => { went.push(path); }, navigatedSinceEntry: () => true }));
      expect(went).toEqual([]);
    });

    it("opens Add a PC for a front page entered at /#add, and never on a PC's own page", async () => {
      await mountRelayShell(mountFor({ store: deviceStore([]), entryUrl: "https://app.ovis.sh/#add" }));
      expect(last().addEntry).toBe(true);
      await mountRelayShell(mountFor({ store: deviceStore([]), entryUrl: "https://app.ovis.sh/" }));
      expect(last().addEntry).toBe(false);
    });

    it("stays on a front page that came with a fragment, or after a PC's own page in this tab", async () => {
      const went: string[] = [];
      const store = deviceStore(await pcs("a".repeat(32)));
      launch();
      await mountRelayShell(mountFor({ store, entryUrl: "https://app.ovis.sh/#pane=w1", navigate: (path) => { went.push(path); } }));
      // the phone app's saved row for the hosted app opens it on its list (app/web/connect.js)
      launch();
      await mountRelayShell(mountFor({ store, entryUrl: "https://app.ovis.sh/#pcs", navigate: (path) => { went.push(path); } }));
      launch();
      await mountRelayShell(mountFor({ store: deviceStore([]), entryUrl: `https://app.ovis.sh/s/${"a".repeat(32)}/` }));
      await mountRelayShell(mountFor({ store, navigate: (path) => { went.push(path); }, checkPc: answering() }));
      expect(went).toEqual([]);
    });
  });

  it("returns admitted version observations to the dashboard and clears outdated on newer admission", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const store = deviceStore([{ ...offer, device_id: "paired", private_key: key.privateKey, public_spki: "fixture", label: "Phone" }]);
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    class Admitted extends RelayTransport {
      version = "0.0.1";
      override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL }; }
      override async fetch() { return Response.json({ managed: false }); }
    }
    const transport = new Admitted(offer);
    const front = mountFor({ store, accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }) });
    await mountRelayShell(front);
    expect(account().pcs?.[0]?.state).toBe("paired");
    await mountRelayShell(mountFor({ store, entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, shellVersion: "1.0.0", open: async () => transport }));
    await mountRelayShell(front);
    expect(account().pcs?.[0]?.state).toBe("needs-update");
    expect(last().observedVersions?.get(offer.server_id)?.version).toBe("0.0.1");
    transport.version = "1.0.0";
    await mountRelayShell(mountFor({ store, entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, shellVersion: "1.0.0", open: async () => transport,
      renderApp: () => ({ render() {}, unmount() {} }), pendingPush: { get: async () => undefined, clear: async () => {} } }));
    await mountRelayShell(front);
    expect(account().pcs?.[0]?.state).toBe("paired");
    transport.close();
  });

  it("C3: a PC only an account introduction saved is never opened by a launch; opened here by hand once, the next launch reopens it", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const rows: RelayDevice[] = [{ ...offer, device_id: "introduced", private_key: key.privateKey, public_spki: "fixture", label: "Phone", introduced_at: Date.now() }];
    const store = deviceStore(rows);
    const launch = async (): Promise<string[]> => {
      browser.sessionStore.delete("ovis-launched");
      const went: string[] = [];
      await mountRelayShell(mountFor({ store, navigate: (path) => { went.push(path); } }));
      return went;
    };
    expect(await launch()).toEqual([]);
    expect(last().state.kind).toBe("list");
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
      override async fetch() { return Response.json({ managed: false }); }
    }
    const transport = new Admitted(offer);
    // the person opens its page by hand (a tap on its row navigates there)
    await mountRelayShell(mountFor({ store, entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, shellVersion: "1.0.0", open: async () => transport,
      renderApp: () => ({ render() {}, unmount() {} }), pendingPush: { get: async () => undefined, clear: async () => {} } }));
    await untilStored(() => rows[0]?.introduced_at === undefined);
    expect(await launch()).toEqual([`/s/${offer.server_id}/`]);
    transport.close();
  });

  it("PADD-8: a Forget during the hand open of an introduced PC is not undone by marking it chosen", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const rows: RelayDevice[] = [{ ...offer, device_id: "introduced", private_key: key.privateKey, public_spki: "fixture", label: "Phone", introduced_at: Date.now() }];
    const base = deviceStore(rows);
    // the person forgets the PC right as its page opens: the read the marker write starts from still sees it
    const writes: string[] = [];
    const store: ShellDeviceStore = { ...base, async update(serverId, change, source) {
      const existing = rows.find((row) => row.server_id === serverId);
      const marks = existing?.introduced_at !== undefined && change(existing).introduced_at === undefined;
      if (!marks) return base.update(serverId, change, source);
      // the person forgets the PC right as the write that marks it chosen runs
      await base.remove(serverId);
      const next = change(undefined);
      writes.push(next.server_id);
      rows.push(next);
      return next;
    } };
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
      override async fetch() { return Response.json({ managed: false }); }
    }
    const transport = new Admitted(offer);
    await mountRelayShell(mountFor({ store, entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, shellVersion: "1.0.0", open: async () => transport,
      renderApp: () => ({ render() {}, unmount() {} }), pendingPush: { get: async () => undefined, clear: async () => {} } }));
    await drain();
    await settleSigned();
    // nothing wrote the forgotten row back
    expect(rows).toEqual([]);
    expect(writes).toEqual([]);
    transport.close();
  });

  it("closes an admitted result that arrives after Cancel without rendering it", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const result = Promise.withResolvers<RelayTransport>();
    const began = Promise.withResolvers<void>();
    let closed = false;
    class Late extends RelayTransport { override close() { closed = true; super.close(); } }
    const opened = new Late(offer);
    await mountRelayShell(mountFor({ entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]),
      navigate() {}, open: async () => { began.resolve(); return result.promise; } }));
    last().onPair();
    await began.promise;
    last().onCancel();
    const count = rendered.length;
    result.resolve(opened);
    await drain();
    expect(closed).toBe(true);
    expect(rendered).toHaveLength(count);
  });

  it("continues a confirmed typed-code offer in scope once without retaining its code", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP, code: "123456" };
    const paths: string[] = [];
    const settings = mountFor({ store: deviceStore([]), navigate: (path) => paths.push(path), findByCode: async () => offer });
    await mountRelayShell(settings);
    last().onCodeStart(); last().onCodeSubmit("typed-secret");
    await until(() => last().state.kind === "code-compare", "code comparison");
    last().onCodeMatch(); last().onCodeMatch();
    expect(paths).toHaveLength(1);
    expect([...browser.sessionStore.values()].join()).not.toMatch(/typed-secret|123456/);
    let attempts = 0;
    await mountRelayShell({ ...settings, entryUrl: paths[0] ?? "", open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "spent"); } });
    await drain();
    expect(attempts).toBe(1);
    await mountRelayShell({ ...settings, entryUrl: paths[0] ?? "" });
    expect(last().state.kind).toBe("confirm");
  });

  it("returns from code entry in place without discarding the caller's view", async () => {
    const paths: string[] = [];
    await mountRelayShell(mountFor({ store: deviceStore([]), navigate: (path) => paths.push(path) }));
    last().onCodeStart();
    last().onCancel();
    await drain();
    expect(last().state.kind).toBe("empty");
    expect(paths).toEqual([]);
  });

  it("takes up the dashboard's sheet on the PC's page only for the PC the join was for, once", async () => {
    const pc = keyFor();
    const other = keyFor();
    const entryUrl = encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.server_public_key, relay: AP, name: "Desk PC" }, "https://app.ovis.sh");
    const arriveWith = async (marker: unknown): Promise<RelayShellProps> => {
      if (marker !== undefined) browser.sessionStore.set(SHEET_JOIN, typeof marker === "string" ? marker : JSON.stringify(marker));
      rendered = [];
      await mountRelayShell(mountFor({ entryUrl }));
      expect(last().state.kind).toBe("confirm");
      return last();
    };

    expect((await arriveWith({ mode: "new", server_id: other.server_id })).sheetJoin).toBeNull();
    expect(browser.sessionStore.has(SHEET_JOIN)).toBe(false);
    expect((await arriveWith({ mode: "join", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "join", server_id: pc.server_id });
    expect(browser.sessionStore.has(SHEET_JOIN)).toBe(false);
    expect((await arriveWith({ mode: "new", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "new", server_id: pc.server_id });
    expect((await arriveWith({ mode: "new", server_id: pc.server_id, returnHash: "#pcs?filter=needs", code: "secret", access_token: "token" })).sheetJoin)
      .toEqual({ mode: "new", server_id: pc.server_id, returnHash: "#pcs?filter=needs" });
    expect((await arriveWith({ mode: "join", server_id: pc.server_id, returnHash: "#code=secret&state=private" })).sheetJoin)
      .toEqual({ mode: "join", server_id: pc.server_id });
    expect((await arriveWith(undefined)).sheetJoin).toBeNull();
    expect((await arriveWith({ mode: "add", server_id: pc.server_id })).sheetJoin).toBeNull();
    expect((await arriveWith("{not json")).sheetJoin).toBeNull();
  });
});
