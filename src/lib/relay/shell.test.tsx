import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ReactElement } from "react";

import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { ACCOUNT_READ_WAIT_MS, ACCOUNT_STEPS_WAIT_MS, mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { RelayTransport, type RelayTransportOptions } from "./transport.ts";
import { MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";

const AP = "wss://relay-ap.ovis.sh";
const SERVICE = "https://account.ovis.sh";
const SHEET_JOIN = "ovis-add-pc-sheet";

const keyFor = () => { const pair = generateKeyPair(); return { server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey) }; };

/** Spins the microtask queue until `holds`, or fails naming `what`: the shell's reads are promises alone, so no clock takes part. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}
/** As `until`, for work that signs: a signature settles off the microtask queue, which each turn here waits out, and no faked clock holds it. */
async function untilSigned(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 2_000; turn++) { if (holds()) return; await crypto.subtle.digest("SHA-256", new Uint8Array(1)); }
  throw new Error(`gave up waiting for ${what}`);
}
/** Enough turns for any read the shell wrongly started to reach the fetch (a read takes a few dozen). */
const drain = async (): Promise<void> => { for (let turn = 0; turn < 500; turn++) await Promise.resolve(); };

/** An isolated browser boundary shared by the controller suites; no production seam. */
export function createShellTestPage() {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let visibility: "visible" | "hidden" = "visible";
  const page = new EventTarget();
  const sessionStore = new Map<string, string>();
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
  afterEach(() => { jest.useRealTimers(); setTransport(nativeTransport); browser.dispose(); });

  const deviceStore = (devices: RelayDevice[]): RelayDeviceStore => ({
    async get(serverId) { return devices.find((device) => device.server_id === serverId); },
    async list() { return [...devices]; },
    async remove(serverId) { const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices.splice(at, 1); },
    async update(serverId, change) { const next = change(devices.find((device) => device.server_id === serverId)); const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices[at] = next; else devices.push(next); return next; },
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
    // another tab signs in; nothing redraws a confirm that is not the front page
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    await drain();
    expect(last().state).toEqual({ kind: "confirm", offer });
    last().onPair();
    // nothing more can be confirmed while the sign-in is read again, and a second press starts nothing
    expect(last().state).toEqual({ kind: "confirm", offer, account: "checking", pressed: "own" });
    last().onPair();
    await until(() => last().state.kind === "confirm" && (last().state as { account?: string }).account === "unlisted", "the confirm asked again");
    await drain();
    expect(prepared).toHaveLength(0);
    // the screen now says the PC joins the account: that is confirmed, and the pairing carries the account's key
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
      accountFetch: async (input) => { if (new URL(String(input)).pathname === "/v1/pcs") return Response.json({ pcs: [] }); exchanging = true; return token.promise; },
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
      // the sign-in lands after the press's own read, the moment the pairing begins (the memory store sets at once)
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
    // the pairing's own page opened the PC: nothing is kept for a later load
    expect(browser.sessionStore.has("ovis-device-only-pc")).toBe(false);
    opened.close();
  });

  it("keeps a pairing confirmed with a key of the device's own out of an account signed in meanwhile when the page reloads for a newer shell", async () => {
    browser.setVisibility("hidden");
    // the tab's reload memory (updateFlow.ts) is window.sessionStorage
    (window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage;
    const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
    const accountStore = memoryAccountStore();
    const session = { service: SERVICE, account: "acct-test", provider: "github" as const, access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 };
    const devices: RelayDevice[] = [];
    const store = deviceStore(devices);
    const prepared: RelayTransportOptions[] = [];
    const transports: RelayTransport[] = [];
    let accountRequests = 0, apps = 0, reloads = 0;
    // a PC newer than the shell: its first admission reloads the page before the app opens
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
      // the sign-in lands after the press's own read, the moment the pairing begins (the memory store sets at once)
      createRoot: () => ({ render(element: ReactElement) { rendered.push(element); if (shellProps(element).state.kind === "connecting") void accountStore.set("session", session); }, unmount() {} }),
    });
    await until(() => last().state.kind === "confirm" && !("account" in last().state), "the signed-out confirm");
    last().onPair();
    await until(() => reloads === 1, "the reload for the newer shell");
    expect(apps).toBe(0);
    expect(await accountStore.get("session")).toEqual(session);
    // the reloaded page opens the PC from its saved pairing, signed in by now: it is still the pairing that was confirmed
    await page(`https://app.ovis.sh/s/${offer.server_id}/`);
    await until(() => apps === 1, "the app");
    await drain();
    expect(reloads).toBe(1);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.accountKey).toBeUndefined();
    expect(prepared[1]?.accountKey).toBeUndefined();
    expect(accountRequests).toBe(0);
    // a later load of the PC is no part of that pairing: it acts as whoever is signed in then
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
      // asked about the account now signed in: that is confirmed
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
      // the second account lists the PC, which only its own directory says
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
        // the other sign-in lands the moment the pairing begins, after the press's own read (the memory store sets at once)
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
      // another tab signs in as another account, and the PC then turns this page's session away
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
      // the directory was not answered in time: it says nothing, so the PC counts as one the pairing adds
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => variant() === "unlisted", "the confirm without the directory");
      last().onPair();
      await drain();
      expect(variant()).toBe("checking");
      expect(prepared).toHaveLength(0);
      // the press's read is not waited for either: the sign-in on this device is still the one the confirm named
      jest.advanceTimersByTime(ACCOUNT_READ_WAIT_MS);
      await until(() => prepared.length === 1, "the pairing");
      expect(prepared[0]?.accountKey).toBeDefined();
    });

    /**
     * A PC of the account as it answers a device it just paired with over the relay. The new row has no account
     * (server/devices.ts, enrollRelay), so the status lists it as unlinked until its `link` (accountRows), and the
     * link ends the row's other sessions, the app's among them (linkAccountKey, onLinked: `auth_changed`).
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
      await untilSigned(() => (devices[0] as { account_enrollment?: { state: string } }).account_enrollment?.state === "complete", "the enrollment");
      expect(apps).toBe(1);
      // the link ends the row's other sessions and the renewal reconnects: both land while no app has a terminal open
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
        // the PC never answers the account's status
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
        // the tab's reload memory (updateFlow.ts) is window.sessionStorage
        (window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage;
        const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC" };
        const accountStore = memoryAccountStore();
        await accountStore.set("session", sessionOf("a"));
        const devices: RelayDevice[] = [];
        const store = deviceStore(devices);
        const prepared: RelayTransportOptions[] = [];
        const transports: RelayTransport[] = [];
        /** what was written to the account service, as `<sign-in> <method> <path>`, and how often the PC was asked for anything */
        const written: string[] = [];
        let asked = 0, apps = 0, reloads = 0;
        // a PC newer than the shell: its first admission reloads the page before the app opens
        class Newer extends RelayTransport {
          override get server() { return { version: "1.1.0", relayProtocol: RELAY_PROTOCOL, features: ["account"] }; }
          override async renew() {}
          override async fetch(): Promise<Response> { asked++; return Response.json({}); }
        }
        const page = (entryUrl: string) => mountRelayShell(mountFor({
          entryUrl, store, navigate() {}, shellVersion: "1.0.0",
          // another tab signs out, or in as someone else, before the reload is through
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
        // the reloaded page opens the PC from its saved pairing
        await page(`https://app.ovis.sh/s/${offer.server_id}/`);
        await until(() => apps === 1, "the app");
        await untilSigned(() => false, "the enrollment, were one begun").catch(() => undefined);
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
        // the pairing's own page opened the PC: nothing is kept for a later load
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
            // a page that is reloaded, or closed and opened again, while it connects: its opening never ends
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
        // the reloaded page starts from the saved pairing, and is gone before it is through connecting
        void page(`https://app.ovis.sh/s/${offer.server_id}/`, true);
        await until(() => hangs === 1, "the connecting that never ends");
        // another tab signs in as someone else meanwhile
        await accountStore.set("session", sessionOf("b"));
        // the load after it: still the pairing that was confirmed, and not for this sign-in
        await page(`https://app.ovis.sh/s/${offer.server_id}/`);
        await until(() => apps === 1, "the app");
        await untilSigned(() => false, "the enrollment, were one begun").catch(() => undefined);
        expect(prepared).toHaveLength(2);
        expect(prepared[1]?.accountKey).toBeUndefined();
        expect(asked).toBe(before.asked);
        expect(written.slice(before.written)).toEqual([]);
        // the pairing's own page opened the PC: nothing is kept for a later load
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
      // the PC came back with the release
      version = "1.0.0";
      jest.advanceTimersByTime(1_000);
      await untilSigned(() => apps === 1, "the PC, opened after its update");
      await untilSigned(() => (devices[0] as { account_enrollment?: { state: string } }).account_enrollment?.state === "complete", "the enrollment");
      expect(apps).toBe(1);
      for (const transport of transports) transport.close();
    });

    it("stops saying checking, and pairs with a key of the device's own, when the sign-in on this device cannot be read", async () => {
      jest.useFakeTimers();
      browser.setVisibility("hidden");
      const offer = { v: 1 as const, ...keyFor(), relay: AP, name: "Desk PC", code: "123456" };
      const memory = memoryAccountStore();
      // the store never answers a read of the sign-in
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
      // nothing says this device is signed in: the confirm speaks of no account
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
      // before any press, a confirm still being read names no wording
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
    // the directory not read yet: whether the pairing adds the PC is not known, so nothing is asked and a press does nothing
    const answer = await signedInMount([{ server_id: offer.server_id, label: "Desk PC", added_at: new Date().toISOString(), last_seen_at: null, public_key: null, relay: AP }]);
    expect(shellProps(rendered[0]!).state).toMatchObject({ kind: "confirm", account: "checking" });
    await drain();
    expect(confirm().account).toBe("checking");
    last().onPair();
    await drain();
    expect(confirm().account).toBe("checking");
    answer();
    await until(() => confirm().account === "listed", "the directory");
    // a directory that could not be read lists nothing
    const failing = Promise.withResolvers<Response>();
    rendered = [];
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    await mountRelayShell(mountFor({ entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: () => failing.promise }));
    await drain();
    expect(confirm().account).toBe("checking");
    failing.reject(new TypeError("offline"));
    await until(() => confirm().account === "unlisted", "the failed read");
    // accounts on, nobody signed in: the device's own key, as before
    await signedInMount([], false);
    expect(shellProps(rendered[0]!).state).toMatchObject({ kind: "confirm", account: "checking" });
    await until(() => confirm().account === undefined, "the missing sign-in");
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

    // a marker for another PC is not this page's join
    expect((await arriveWith({ mode: "new", server_id: other.server_id })).sheetJoin).toBeNull();
    // whatever the marker, the page took it: a later plain visit shows the screens alone
    expect(browser.sessionStore.has(SHEET_JOIN)).toBe(false);
    // this PC's join goes on in the sheet, in its mode
    expect((await arriveWith({ mode: "join", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "join", server_id: pc.server_id });
    expect(browser.sessionStore.has(SHEET_JOIN)).toBe(false);
    expect((await arriveWith({ mode: "new", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "new", server_id: pc.server_id });
    expect((await arriveWith({ mode: "new", server_id: pc.server_id, returnHash: "#pcs?filter=needs", code: "secret", access_token: "token" })).sheetJoin)
      .toEqual({ mode: "new", server_id: pc.server_id, returnHash: "#pcs?filter=needs" });
    expect((await arriveWith({ mode: "join", server_id: pc.server_id, returnHash: "#code=secret&state=private" })).sheetJoin)
      .toEqual({ mode: "join", server_id: pc.server_id });
    // no marker, a mode that is no join, or a marker that does not parse: the screens alone
    expect((await arriveWith(undefined)).sheetJoin).toBeNull();
    expect((await arriveWith({ mode: "add", server_id: pc.server_id })).sheetJoin).toBeNull();
    expect((await arriveWith("{not json")).sheetJoin).toBeNull();
  });
});
