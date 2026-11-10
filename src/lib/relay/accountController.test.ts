import { createShellTestPage } from "./shell.test.tsx";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";

const AP = "wss://relay-ap.ovis.sh";
const SERVICE = "https://account.ovis.sh";

const keyFor = () => { const pair = generateKeyPair(); return { server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey) }; };

/** Spins the microtask queue until `holds`, or fails naming `what`: the shell's reads are promises alone, so no clock takes part. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}
/** Enough turns for any read the shell wrongly started to reach the fetch (a read takes a few dozen). */
const drain = async (): Promise<void> => { for (let turn = 0; turn < 500; turn++) await Promise.resolve(); };

describe("the hosted shell's front page", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(() => { jest.useRealTimers(); browser.dispose(); });

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
  const rows = (): number => renderToStaticMarkup(rendered.at(-1)!).match(/<tr[^>]*data-pc-state="/g)?.length ?? 0;
  const visible = (next: "visible" | "hidden"): void => { browser.setVisibility(next); browser.page.dispatchEvent(new Event("visibilitychange")); };

  it("invalidates an in-flight directory read as soon as sign-out starts", async () => {
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const directory = Promise.withResolvers<Response>();
    const signout = Promise.withResolvers<Response>();
    let reads = 0;
    await mountRelayShell(mountFor({
      accountService: SERVICE, accountProviders: ["github"], accountStore, store: deviceStore([]),
      accountFetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/pcs") return ++reads === 1 ? Response.json({ pcs: [] }) : directory.promise;
        return signout.promise;
      },
    }));
    last().onRefreshAccount?.();
    await until(() => reads === 2, "explicit retry");
    last().onSignOut?.();
    await drain();
    const count = rendered.length;
    directory.resolve(Response.json({ pcs: [{ ...keyFor(), label: "Late PC", added_at: null, last_seen_at: null, public_key: null, relay: AP }] }));
    await drain();
    expect(rendered).toHaveLength(count);
    expect(last().state).toMatchObject({ account: { kind: "signed-out" } });
    expect(last().directoryRelays).toEqual([]);
    signout.resolve(Response.json({}));
    await drain();
  });

  it("reads the directory for a native sign-in made while a read from before the sign-out is still out", async () => {
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const stale = Promise.withResolvers<Response>();
    const tokened = Promise.withResolvers<void>();
    let reads = 0;
    const savedFetch = globalThis.fetch;
    try {
      await mountRelayShell(mountFor({
        accountService: SERVICE, accountProviders: ["github", "apple"], accountStore, store: deviceStore([]),
        accountFetch: async (input) => {
          if (new URL(String(input)).pathname === "/v1/signout") return Response.json({});
          return ++reads === 2 ? stale.promise : Response.json({ pcs: [] });
        },
      }));
      last().onRefreshAccount?.();
      await until(() => reads === 2, "the read held over the sign-out");
      last().onSignOut?.();
      // the phone app's Sign in with Apple, and the token the service answers it with
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }], nativePromise: async () => ({ idToken: "apple-id-token" }) } });
      globalThis.fetch = Object.assign(async () => { tokened.resolve(); return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, account: "acct-test", provider: "apple" }); }, { preconnect: savedFetch.preconnect });
      last().onSignIn?.("apple");
      await tokened.promise;
      await until(() => { const { state } = last(); return (state.kind === "list" || state.kind === "empty") && state.account?.kind === "signed-in" && state.account.pcs !== null; }, "the new sign-in's directory drawn");
      expect(reads).toBe(3);
    } finally {
      stale.resolve(Response.json({ pcs: [] }));
      Reflect.deleteProperty(globalThis, "Capacitor");
      globalThis.fetch = savedFetch;
    }
  });

  it("retains the selected provider while signing in and ignores a second provider tap", async () => {
    const accountStore = memoryAccountStore();
    const redirects: string[] = [];
    const redirected = Promise.withResolvers<void>();
    await mountRelayShell(mountFor({
      accountService: SERVICE, accountProviders: ["github", "google"], accountStore,
      store: deviceStore([]), openSignIn: (url) => { redirects.push(url); redirected.resolve(); },
    }));
    last().onSignIn?.("google");
    last().onSignIn?.("github");
    await redirected.promise;
    expect(last().state).toMatchObject({ account: { kind: "signing-in", provider: "google" } });
    expect(Object.values(await accountStore.get("pending") ?? {}).map((pending) => pending.provider)).toEqual(["google"]);
  });

  it("retains the failed provider on the signed-out view when an OAuth callback token exchange fails", async () => {
    const accountStore = memoryAccountStore();
    await accountStore.set("pending", {
      "state-google": {
        service: SERVICE,
        provider: "google",
        state: "state-google",
        verifier: "verifier-123",
        redirect_uri: "https://app.ovis.sh/",
        started_at: Date.now(),
      },
    });
    await mountRelayShell(mountFor({
      entryUrl: "https://app.ovis.sh/#code=bad-code&state=state-google",
      accountService: SERVICE,
      accountProviders: ["github", "google"],
      accountStore,
      store: deviceStore([]),
      accountFetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } }),
    }));
    expect(last().state).toMatchObject({
      account: {
        kind: "signed-out",
        provider: "google",
        error: "The sign-in did not finish. Try again.",
      },
    });
  });

  it("reads the directory again when the page comes into view and every 60 s while it stays there, never while hidden, and keeps the rows through a failed read", async () => {
    jest.useFakeTimers();
    const desk = keyFor(), mini = keyFor(), nuc = keyFor();
    const now = Date.now();
    const seen = new Date(now - 60_000).toISOString();
    const directory = [
      { server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: seen, public_key: null, relay: AP },
      { server_id: mini.server_id, label: "Mac mini", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: seen, public_key: null, relay: AP },
      { server_id: nuc.server_id, label: "nuc", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: seen, public_key: null, relay: "wss://relay.ovis.sh" },
    ];
    type Answer = { status: number; ok: boolean; json: () => Promise<unknown> };
    const ok = (): Answer => ({ status: 200, ok: true, json: async () => ({ pcs: directory }) });
    const down = (): Answer => ({ status: 500, ok: false, json: async () => ({ error: { code: "down" } }) });
    let answer: () => Answer = ok;
    let reads = 0;
    const accountFetch = async (input: Request | string | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/pcs") throw new Error(`unexpected request ${url.pathname}`);
      reads += 1;
      return answer() as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });
    const paired: RelayDevice = { server_id: desk.server_id, device_id: "0".repeat(16), private_key: {} as CryptoKey, public_spki: "spki", label: "Test phone", server_public_key: "k", relay: AP, name: "Desk PC" };

    // Given the page is opened in the background
    browser.setVisibility("hidden");
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([paired]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs !== null, "the first read drawn");
    expect(rows()).toBe(3);
    expect(account().pcs!.map((pc) => [pc.name, pc.state])).toEqual([["Desk PC", "paired"], ["Mac mini", "needs-approval"], ["nuc", "needs-approval"]]);

    // Then nothing is read again while it stays hidden, however long
    visible("hidden");
    jest.advanceTimersByTime(180_000);
    await drain();
    expect(reads).toBe(1);

    // When it comes into view: one read at once
    visible("visible");
    await until(() => reads === 2, "the read on coming into view");
    const drawn = rendered.length;
    await until(() => rendered.length > drawn, "that read drawn");
    expect(rows()).toBe(3);

    // then one every 60 s, not before
    jest.advanceTimersByTime(59_999);
    await drain();
    expect(reads).toBe(2);
    jest.advanceTimersByTime(1);
    await until(() => reads === 3, "the read at 60 s");
    await drain(); // settle this response before advancing the fake clock by another minute
    jest.advanceTimersByTime(60_000);
    await until(() => reads === 4, "the read at 120 s");
    await drain();

    // a read that fails keeps the rows and says so under them
    answer = down;
    const before = rendered.length;
    jest.advanceTimersByTime(60_000);
    await until(() => reads === 5 && rendered.length > before, "the failed read drawn");
    expect(rows()).toBe(3);
    expect(account().pcs).toHaveLength(3);
    expect(account().error).toContain("could not be reached");

    // and while reads keep failing, the kept rows still age: past 15 minutes unseen, Desk PC is offline
    for (let read = 6; read <= 14; read++) {
      await drain(); // the last read settles before the next minute
      const drawnBefore = rendered.length;
      jest.advanceTimersByTime(60_000);
      await until(() => reads === read && rendered.length > drawnBefore, `failed read ${read} drawn`);
    }
    expect(account().pcs!.map((pc) => [pc.name, pc.state])).toEqual([["Desk PC", "offline"], ["Mac mini", "offline"], ["nuc", "offline"]]);
    answer = ok;

    // hidden again: the timer stops with it
    visible("hidden");
    jest.advanceTimersByTime(600_000);
    await drain();
    expect(reads).toBe(14);

    // back in view: read again, and the failure's line goes
    const shown = rendered.length;
    visible("visible");
    await until(() => reads === 15 && rendered.length > shown, "the read on coming back drawn");
    expect(account().error).toBeNull();
    expect(rows()).toBe(3);
  });

  it("reads nothing again while the first read is still out, so an older answer never lands over a newer one", async () => {
    const desk = keyFor();
    const now = Date.now();
    const directory = [{ server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: new Date(now - 60_000).toISOString(), public_key: null, relay: AP }];
    let reads = 0;
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const accountFetch = async (input: Request | string | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/pcs") throw new Error(`unexpected request ${url.pathname}`);
      reads += 1;
      if (reads === 1) await held;
      return { status: 200, ok: true, json: async () => ({ pcs: directory }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });

    const mounted = mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs === null, "the loading dashboard with its first read out");
    visible("visible");
    await drain();
    expect(reads).toBe(1);

    answer();
    await mounted;
    await until(() => account().pcs !== null, "the first read drawn");
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["Desk PC"]);
  });

  it("keeps a code being typed when the first read lands under it", async () => {
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    let reads = 0;
    const accountFetch = async (): Promise<Response> => {
      reads += 1;
      await held;
      return { status: 200, ok: true, json: async () => ({ pcs: [] }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });

    const mounted = mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs === null, "the loading dashboard with its first read out");
    // Add a PC, Pair with a QR or code, Pair with a code
    last().onCodeStart();
    await until(() => last().state.kind === "code-entry", "the code entry");

    answer();
    await mounted;
    await drain();
    expect(last().state.kind).toBe("code-entry");
  });

  it("signs the page out when a read again finds the sign-in gone, rather than keeping the account's rows", async () => {
    const desk = keyFor();
    const now = Date.now();
    const directory = [{ server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: new Date(now - 60_000).toISOString(), public_key: null, relay: AP }];
    const accountFetch = async (): Promise<Response> => ({ status: 200, ok: true, json: async () => ({ pcs: directory }) }) as unknown as Response;
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().pcs !== null, "the first read drawn");

    // another tab signed out: the session is gone from the shared store
    await accountStore.set("session", undefined);
    visible("visible");
    await until(() => { const { state } = last(); return (state.kind === "list" || state.kind === "empty") && state.account?.kind === "signed-out"; }, "the signed-out front page");
  });

  it("reads the directory as the sign-in it found, and again as one another tab stored before the list was asked", async () => {
    const desk = keyFor();
    const now = Date.now();
    const sessionOf = (account: string, provider: "github" | "google") => ({ service: SERVICE, account, provider, access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: now + 3_600_000 });
    const asked: string[] = [];
    const accountFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      asked.push(bearer);
      const pcs = bearer.endsWith("acct-b") ? [{ server_id: desk.server_id, label: "B's PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: null, public_key: null, relay: AP }] : [];
      return ({ status: 200, ok: true, json: async () => ({ pcs }) }) as unknown as Response;
    };
    const inner = memoryAccountStore();
    await inner.set("session", sessionOf("acct-a", "github"));
    // another tab stores account B's sign-in right after the page read account A's
    let reads = 0;
    const accountStore: typeof inner = { ...inner, get: (async (name: Parameters<typeof inner.get>[0]) => {
      const value = await inner.get(name);
      if (name === "session" && ++reads === 1) await inner.set("session", sessionOf("acct-b", "google"));
      return value;
    }) as typeof inner.get };

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github", "google"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().pcs !== null, "the first list drawn");

    // B's PCs are never drawn under A's heading, and nothing was asked for A with B's token
    expect(account().provider).toBe("google");
    expect(rows()).toBe(1);
    expect(asked.every((bearer) => bearer.endsWith("acct-b"))).toBe(true);
  });

  it("starts one read when two reasons to read again land in the same moment", async () => {
    jest.useFakeTimers();
    const desk = keyFor();
    const now = Date.now();
    const directory = [{ server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: new Date(now - 60_000).toISOString(), public_key: null, relay: AP }];
    let reads = 0;
    /** holds every read after the first open until the test lets it answer, so the triggers below overlap it */
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const accountFetch = async (input: Request | string | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/pcs") throw new Error(`unexpected request ${url.pathname}`);
      reads += 1;
      if (reads > 1) await held;
      return { status: 200, ok: true, json: async () => ({ pcs: directory }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs !== null, "the first read drawn");

    // two visibility changes in one tick (a tab switched away and back), then the 60 s tick while that read is out
    visible("visible");
    visible("visible");
    await until(() => reads >= 2, "the read on coming into view");
    await drain();
    expect(reads).toBe(2);
    jest.advanceTimersByTime(60_000);
    await drain();
    expect(reads).toBe(2);

    const drawn = rendered.length;
    answer();
    await until(() => rendered.length > drawn, "the read drawn");
    await drain();
    expect(reads).toBe(2);
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["Desk PC"]);
  });

});
