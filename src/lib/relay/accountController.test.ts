import { createShellTestPage } from "./shell.test.tsx";
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { openPage, type Page } from "../page.fixture.ts";

import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { keepKnownPcs } from "../account/knownPcs.ts";
import { indexedAccountStore, memoryAccountStore } from "../account/store.ts";
import { useHostedSignIn, type HostedSignIn } from "../account/hostedSignIn.ts";
import type { BlockRecord } from "../../../shared/account-records.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { shellAccountActions } from "../account/hostedSignIn.ts";

const AP = "wss://relay-ap.ovis.sh";
const SERVICE = "https://account.ovis.sh";

const keyFor = () => { const pair = generateKeyPair(); return { server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey) }; };

async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}
const drain = async (): Promise<void> => { for (let turn = 0; turn < 500; turn++) await Promise.resolve(); };

describe("the hosted shell's front page", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  let signOutPage: Page | undefined;
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(async () => {
    jest.useRealTimers();
    if (signOutPage) {
      await signOutPage.close();
      signOutPage = undefined;
      jest.restoreAllMocks();
    }
    browser.dispose();
  });

  const deviceStore = (devices: RelayDevice[]): ShellDeviceStore => ({
    async get(serverId) { return devices.find((device) => device.server_id === serverId); },
    async list() { return [...devices]; },
    async remove(serverId) { const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices.splice(at, 1); },
    async removeRow(serverId, row) { const at = devices.findIndex((device) => device.server_id === serverId && device.device_id === row); if (at < 0) return false; devices.splice(at, 1); return true; },
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
  const rows = (): number => account().pcs?.length ?? 0;
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
    shellAccountActions()?.signOut();
    await drain();
    const count = rendered.length;
    directory.resolve(Response.json({ pcs: [{ ...keyFor(), label: "Late PC", added_at: null, last_seen_at: null, public_key: null, relay: AP }] }));
    await drain();
    expect(rendered).toHaveLength(count);
    expect(last().state).toMatchObject({ account: { kind: "signed-out" } });
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
          if (["/v1/devices/challenge", "/v1/providers"].includes(new URL(String(input)).pathname)) return new Response(null, { status: 404 });
          if (new URL(String(input)).pathname === "/v1/signout") return Response.json({});
          return ++reads === 2 ? stale.promise : Response.json({ pcs: [] });
        },
      }));
      last().onRefreshAccount?.();
      await until(() => reads === 2, "the read held over the sign-out");
      shellAccountActions()?.signOut();
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

  // a hosted build names no providers of its own (GitHub alone): the sign-in screen offers what the service names
  it("offers the providers the account service names on the signed-out front page", async () => {
    await mountRelayShell(mountFor({
      accountService: SERVICE, accountProviders: ["github"], accountStore: memoryAccountStore(), store: deviceStore([]),
      accountFetch: async (input) => new URL(String(input)).pathname === "/v1/providers"
        ? Response.json({ providers: ["github", "google", "apple"], device: ["github"] }) : Response.json({ pcs: [] }),
    }));
    await until(() => last().accountProviders?.join() === "github,google,apple", "the service's providers");
    expect(last().state).toMatchObject({ account: { kind: "signed-out" } });
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

    browser.setVisibility("hidden");
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([paired]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs !== null, "the first read drawn");
    expect(rows()).toBe(3);
    expect(account().pcs!.map((pc) => [pc.name, pc.state])).toEqual([["Desk PC", "paired"], ["Mac mini", "needs-approval"], ["nuc", "needs-approval"]]);

    visible("hidden");
    jest.advanceTimersByTime(180_000);
    await drain();
    expect(reads).toBe(1);

    visible("visible");
    await until(() => reads === 2, "the read on coming into view");
    const drawn = rendered.length;
    await until(() => rendered.length > drawn, "that read drawn");
    expect(rows()).toBe(3);

    jest.advanceTimersByTime(59_999);
    await drain();
    expect(reads).toBe(2);
    jest.advanceTimersByTime(1);
    await until(() => reads === 3, "the read at 60 s");
    await drain();
    jest.advanceTimersByTime(60_000);
    await until(() => reads === 4, "the read at 120 s");
    await drain();

    answer = down;
    const before = last().state;
    jest.advanceTimersByTime(60_000);
    await until(() => reads === 5 && last().state !== before, "the failed read drawn");
    expect(rows()).toBe(3);
    expect(account().pcs).toHaveLength(3);
    expect(account().error).toContain("could not be reached");

    for (let read = 6; read <= 14; read++) {
      await drain();
      const drawnBefore = last().state;
      jest.advanceTimersByTime(60_000);
      await until(() => reads === read && last().state !== drawnBefore, `failed read ${read} drawn`);
    }
    // ten minutes of failed reads: nothing new is known of the PCs, so no row ages past what the account last confirmed
    expect(account().pcs!.map((pc) => [pc.name, pc.state])).toEqual([["Desk PC", "paired"], ["Mac mini", "needs-approval"], ["nuc", "needs-approval"]]);
    answer = ok;

    visible("hidden");
    jest.advanceTimersByTime(600_000);
    await drain();
    expect(reads).toBe(14);

    const shown = rendered.length;
    visible("visible");
    await until(() => reads === 15 && rendered.length > shown, "the read on coming back drawn");
    expect(account().error).toBeNull();
    expect(rows()).toBe(3);
  });

  it("keeps the account's PCs it listed last for a page loaded with no internet, and forgets them once signed out", async () => {
    const pair = generateKeyPair();
    const mac = { server_id: deriveServerId(pair.publicKey), label: "hasang-uui-MacBookPro", added_at: new Date(Date.now() - 86_400_000).toISOString(), last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString(), public_key: Buffer.from(pair.publicKey).toString("hex"), relay: AP };
    let online = true;
    const accountFetch = async (input: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(input)).pathname !== "/v1/pcs") return new Response(null, { status: 404 });
      if (!online) throw new TypeError("Failed to fetch");
      return ({ status: 200, ok: true, json: async () => ({ pcs: [mac] }) }) as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    const session = { service: SERVICE, account: "acct-test", provider: "github" as const, access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 };
    await accountStore.set("session", session);
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().pcs !== null, "the first read drawn");
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["hasang-uui-MacBookPro"]);

    // the app opened again with no internet: a new page, whose read gets no answer at all
    online = false;
    rendered = [];
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().error !== null, "the failed read drawn");
    expect(account().pcs).toEqual([]);
    expect(account().known).toEqual([{ server_id: mac.server_id, name: "hasang-uui-MacBookPro" }]);
    // another tab's read found none to keep since: this page's next failed read lists none either, not the earlier ones
    keepKnownPcs("acct-test", []);
    const drawn = rendered.length;
    visible("visible");
    await until(() => rendered.length > drawn && account().error !== null, "the next failed read on this page drawn");
    expect(account().known).toBeUndefined();

    shellAccountActions()?.signOut();
    await drain();
    rendered = [];
    await accountStore.set("session", session);
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().error !== null, "the next failed read drawn");
    expect(account().known ?? []).toEqual([]);
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

  it("reads once more for a Check again asked while a read is out, since that read may predate the PC just added, and settles only then", async () => {
    const desk = keyFor();
    const now = Date.now();
    const added = [{ server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 60_000).toISOString(), last_seen_at: new Date(now - 1_000).toISOString(), public_key: null, relay: AP }];
    let reads = 0;
    const early = Promise.withResolvers<void>();
    const accountFetch = async (input: Request | string | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/pcs") throw new Error(`unexpected request ${url.pathname}`);
      const read = ++reads;
      if (read === 2) await early.promise;
      return { status: 200, ok: true, json: async () => ({ pcs: read >= 3 ? added : [] }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs?.length === 0, "the empty account drawn");

    visible("visible");
    await until(() => reads === 2, "the background read out");
    let settled = 0;
    for (let press = 0; press < 2; press++) void Promise.resolve(last().onRefreshAccount?.()).then(() => { settled += 1; });
    await drain();
    expect([reads, settled]).toEqual([2, 0]);

    early.resolve();
    await until(() => settled === 2, "both asks settled");
    expect(reads).toBe(3);
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["Desk PC"]);

    for (const want of [4, 5]) {
      await last().onRefreshAccount?.();
      expect(reads).toBe(want);
    }
  });

  it("keeps a code being typed when the first read lands under it", async () => {
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    let reads = 0;
    const accountFetch = async (input: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(input)).pathname === "/v1/providers") return new Response(null, { status: 404 });
      reads += 1;
      await held;
      return { status: 200, ok: true, json: async () => ({ pcs: [] }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });

    const mounted = mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs === null, "the loading dashboard with its first read out");
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

    await accountStore.set("session", undefined);
    visible("visible");
    await until(() => { const { state } = last(); return (state.kind === "list" || state.kind === "empty") && state.account?.kind === "signed-out"; }, "the signed-out front page");
  });

  it("reads the directory as the sign-in it found, and again as one another tab stored before the list was asked", async () => {
    const desk = keyFor();
    const now = Date.now();
    const sessionOf = (account: string, provider: "github" | "google") => ({ service: SERVICE, account, provider, access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: now + 3_600_000 });
    const asked: string[] = [];
    const accountFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (new URL(String(input)).pathname === "/v1/providers") return new Response(null, { status: 404 });
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      asked.push(bearer);
      const pcs = bearer.endsWith("acct-b") ? [{ server_id: desk.server_id, label: "B's PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: null, public_key: null, relay: AP }] : [];
      return ({ status: 200, ok: true, json: async () => ({ pcs }) }) as unknown as Response;
    };
    const inner = memoryAccountStore();
    await inner.set("session", sessionOf("acct-a", "github"));
    let reads = 0;
    const accountStore: typeof inner = { ...inner, update: (async (name: Parameters<typeof inner.update>[0], change: Parameters<typeof inner.update>[1]) => {
      await inner.update(name, change);
      if (name === "session" && ++reads === 1) await inner.set("session", sessionOf("acct-b", "google"));
    }) as typeof inner.update };

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github", "google"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().pcs !== null, "the first list drawn");

    // B's PCs are never drawn under A's heading, and nothing was asked for A with B's token
    expect(account().provider).toBe("google");
    expect(rows()).toBe(1);
    expect(asked.every((bearer) => bearer.endsWith("acct-b"))).toBe(true);
  });

  it("drops a directory answer that lands after another tab stored another sign-in, and reads as that one", async () => {
    const desk = keyFor();
    const now = Date.now();
    const sessionOf = (account: string, provider: "github" | "google") => ({ service: SERVICE, account, provider, access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: now + 3_600_000, sign_in_id: `id-${account}` });
    const row = (label: string) => ({ server_id: desk.server_id, label, added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: null, public_key: null, relay: AP });
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    let asked = 0;
    const accountFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const forB = (new Headers(init?.headers).get("authorization") ?? "").endsWith("acct-b");
      asked += 1;
      if (!forB) await held;
      return ({ status: 200, ok: true, json: async () => ({ pcs: [row(forB ? "B's PC" : "A's PC")] }) }) as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", sessionOf("acct-a", "github"));

    const mounted = mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github", "google"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => asked === 1, "account A's directory asked");
    await accountStore.set("session", sessionOf("acct-b", "google"));
    answer();
    await mounted;
    await until(() => rendered.length > 0 && account().pcs !== null, "a list drawn");
    expect(account().provider).toBe("google");
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["B's PC"]);
  });

  it("keeps none of an account's rows once another sign-in took its place, even when that one's read fails", async () => {
    const desk = keyFor();
    const now = Date.now();
    const sessionOf = (account: string, provider: "github" | "google") => ({ service: SERVICE, account, provider, access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: now + 3_600_000, sign_in_id: `id-${account}` });
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    let asked = 0;
    const accountFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (new URL(String(input)).pathname === "/v1/providers") return new Response(null, { status: 404 });
      asked += 1;
      if ((new Headers(init?.headers).get("authorization") ?? "").endsWith("acct-b")) return ({ status: 503, ok: false, json: async () => ({}) }) as unknown as Response;
      if (asked === 2) await held;
      return ({ status: 200, ok: true, json: async () => ({ pcs: [{ server_id: desk.server_id, label: "A's PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: null, public_key: null, relay: AP }] }) }) as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", sessionOf("acct-a", "github"));

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github", "google"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => rendered.length > 0 && account().pcs !== null, "account A's list drawn");
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["A's PC"]);

    visible("visible");
    await until(() => asked === 2, "the second read asked");
    await accountStore.set("session", sessionOf("acct-b", "google"));
    answer();
    await until(() => asked >= 3 && account().provider === "google" && account().error !== null, "account B's failed read drawn");
    expect(account().pcs).toEqual([]);
  });

  it("starts one read when two reasons to read again land in the same moment", async () => {
    jest.useFakeTimers();
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
      if (reads > 1) await held;
      return { status: 200, ok: true, json: async () => ({ pcs: directory }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs !== null, "the first read drawn");

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

  it("S32-1: a PC page's Sign out is the overview's: it ends the hosted sign-in and keeps every unsent block", async () => {
    const accountStore = memoryAccountStore();
    const session = { service: SERVICE, account: "acct-test", provider: "github", sign_in_id: "s1", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 } as const;
    await accountStore.set("session", session);
    await accountStore.set("unsent_blocks", { r1: { account: session.account, sign_in_id: session.sign_in_id, records: [{ id: "r1" } as unknown as BlockRecord] } });
    spyOn(indexedAccountStore, "get").mockImplementation((name) => accountStore.get(name));
    const signedOut = Promise.withResolvers<void>();
    await mountRelayShell(mountFor({
      accountService: SERVICE, accountProviders: ["github"], accountStore, store: deviceStore([]),
      accountFetch: async (input, init) => {
        if (new URL(String(input)).pathname !== "/v1/signout") return Response.json({ pcs: [] });
        expect(init?.method).toBe("POST");
        signedOut.resolve();
        return Response.json({});
      },
    }));
    await until(() => rendered.length > 0 && account().pcs !== null, "the signed-in front page");
    let hosted: HostedSignIn | null = null;
    const Probe = (): null => { hosted = useHostedSignIn(); return null; };
    signOutPage = openPage("https://app.ovis.sh/");
    await signOutPage.render(createElement(Probe));
    expect(hosted).toMatchObject({ provider: "github" });
    await act(async () => { hosted!.signOut(); await signedOut.promise; });
    await drain();
    expect(await accountStore.get("session")).toBeUndefined();
    expect(Object.keys(await accountStore.get("unsent_blocks") ?? {})).toEqual(["r1"]);
    expect(last().state).toMatchObject({ account: { kind: "signed-out" } });
  });

});
