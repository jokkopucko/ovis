import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../account/signin.ts";
import { moveQueryToFragment } from "../pageQuery.ts";
import { memoryAccountStore, type AccountStore } from "../account/store.ts";
import { bootRelayShell, takeEntryUrl } from "./boot.ts";
import type { ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";

const SERVICE = "https://account.ovis.sh";

let waiting: (() => void)[] = [];
const changed = (): void => { for (const wake of waiting.splice(0)) wake(); };
async function until(holds: () => boolean): Promise<void> {
  for (;;) {
    const next = new Promise<void>((resolve) => { waiting.push(resolve); });
    if (holds()) return;
    await next;
  }
}
const providerOf = async (accountStore: AccountStore, url: string): Promise<string | undefined> => (await accountStore.get("pending"))?.[new URL(url).searchParams.get("state") ?? ""]?.provider;
const ORIGIN = "https://app.ovis.sh";

/** A browser's address bar: `replaceState` changes the address a reload then loads. */
function addressBar(url: string) {
  const at = new URL(url);
  const location = { href: at.href, pathname: at.pathname, search: at.search, hash: at.hash };
  const replaced: string[] = [];
  const history = { replaceState(_data: unknown, _unused: string, next: string) {
    replaced.push(next);
    const moved = new URL(next, at.origin);
    Object.assign(location, { href: moved.href, pathname: moved.pathname, search: moved.search, hash: moved.hash });
  } };
  return { location, history, replaced };
}

describe("a link that opens the hosted shell on a provider's sign-in (#sign-in=<provider>)", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => { Reflect.deleteProperty(globalThis, "Capacitor"); browser.dispose(); waiting = []; });

  function service(offered: readonly ("github" | "google")[] = ["github", "google"]): FakeAccountService {
    const fake = new FakeAccountService();
    fake.offerSignIns([...offered], [...offered]);
    fake.signInAs("github", "acct_1");
    return fake;
  }

  /** Loads the address in `bar` as the browser would: boot takes the entry URL, then the shell mounts on it. */
  /** What a test page mounts with, less the entry: the fake service, this store, and its sign-ins recorded. */
  function mountOptions(fake: FakeAccountService, accountStore: AccountStore, signIns: string[], accountFetch: typeof fetch = fake.fetch as typeof fetch) {
    const store: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async (_id, change) => change(undefined) };
    const find = (node: ReactElement): RelayShellProps => node.type === RelayShell ? node.props as RelayShellProps : find((node.props as { children: ReactElement }).children);
    return {
      shellVersion: "0.0.0-test", label: "Test phone", store, accountStore, accountService: SERVICE, accountFetch, accountProviders: ["github" as const],
      createRoot: () => ({ render(element: ReactElement) { find(element); }, unmount() {} }),
      open: async () => { throw new Error("no pairing is expected here"); },
      openSignIn: (url: string) => { signIns.push(url); changed(); },
      navigate: () => {}, checkPc: async () => ({ kind: "offline" as const, reason: "relay" as const }), reload: async () => {},
    };
  }

  async function load(bar: ReturnType<typeof addressBar>, fake: FakeAccountService, accountStore: AccountStore, signIns: string[], accountFetch: typeof fetch = fake.fetch as typeof fetch) {
    await mountRelayShell({
      container: {} as HTMLElement, entryUrl: takeEntryUrl(bar), renderApp: () => { throw new Error("the app is not expected here"); },
      ...mountOptions(fake, accountStore, signIns, accountFetch),
    });
  }


  /** The account service's provider list held until released. */
  function heldProviders(fake: FakeAccountService) {
    let release = (): void => {};
    let asked = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/providers") { asked = true; changed(); await gate; }
      return fake.fetch(input as string, init);
    }) as typeof globalThis.fetch;
    return { fetch, release, asked: () => asked };
  }
  async function signInElsewhere(fake: FakeAccountService, accountStore: AccountStore): Promise<void> {
    const begun = await beginSignIn("github", { store: accountStore, service: SERVICE, redirectUri: WEB_REDIRECT });
    await finishSignIn(signInReturn(new URL((await fake.fetch(begun)).headers.get("location") ?? "").hash)!, { store: accountStore, fetch: fake.fetch });
  }
  function scanned(): RelayOffer {
    const key = generateKeyPair().publicKey;
    return { v: 1, server_id: deriveServerId(key), server_public_key: exportPublicKey(key), relay: "wss://relay.ovis.sh", name: "Desk", code: "123456" };
  }
  function arrive(offer: RelayOffer): void {
    const link = new URL(encodeOffer(offer, ORIGIN));
    Object.assign(window.location, { href: link.href, hash: link.hash });
    window.dispatchEvent(new Event("hashchange"));
  }
  /** A later page that does start a sign-in: once its sign-in opens, any start before it would have opened too. */
  async function control(fake: FakeAccountService, signIns: string[], before: number): Promise<void> {
    const store = memoryAccountStore();
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, store, signIns);
    await until(() => signIns.length > before);
    expect(signIns).toHaveLength(before + 1);
    expect(await providerOf(store, signIns.at(-1)!)).toBe("github");
  }

  it("starts a provider's sign-in once, on the same path as its button: one pending record, PKCE and its state", async () => {
    const fake = service();
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns);
    await until(() => signIns.length === 1);
    const started = new URL(signIns[0]!);
    const state = started.searchParams.get("state") ?? "";
    expect(started.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = await accountStore.get("pending");
    expect(Object.keys(pending ?? {})).toEqual([state]);
    expect(pending?.[state]).toMatchObject({ provider: "google" });
    expect(pending?.[state]).not.toHaveProperty("pairing");
  });

  it("does nothing for a provider the account service does not offer, and starts one it does", async () => {
    const fake = service(["github"]);
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns);
    await load(addressBar(`${ORIGIN}/#sign-in=gitlab`), fake, accountStore, signIns);
    await load(addressBar(`${ORIGIN}/#sign-in=`), fake, accountStore, signIns);
    // the one that is offered, loaded last: by the time its sign-in opens, none started above did
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, accountStore, signIns);
    await until(() => signIns.length > 0);
    expect(signIns).toHaveLength(1);
    expect(await providerOf(accountStore, signIns[0]!)).toBe("github");
    expect(Object.keys((await accountStore.get("pending")) ?? {})).toHaveLength(1);
  });

  it("takes the entry off the address before the shell runs, and keeps any other fragment", async () => {
    const bar = addressBar(`${ORIGIN}/#sign-in=github`);
    expect(takeEntryUrl(bar)).toBe(`${ORIGIN}/#sign-in=github`);
    expect(bar.replaced).toEqual(["/"]);
    expect(bar.location.hash).toBe("");
    const other = addressBar(`${ORIGIN}/#pane=w1:p1`);
    takeEntryUrl(other);
    expect(other.replaced).toEqual([]);
  });

  it("does nothing on a page already signed in, where a signed-out one starts it", async () => {
    const fake = service();
    const signedIn = memoryAccountStore();
    const begun = await beginSignIn("github", { store: signedIn, service: SERVICE, redirectUri: WEB_REDIRECT });
    await finishSignIn(signInReturn(new URL((await fake.fetch(begun)).headers.get("location") ?? "").hash)!, { store: signedIn, fetch: fake.fetch });
    const signIns: string[] = [];
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, signedIn, signIns);
    const signedOut = memoryAccountStore();
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, signedOut, signIns);
    await until(() => signIns.length > 0);
    expect(signIns).toHaveLength(1);
    expect(await providerOf(signedOut, signIns[0]!)).toBe("github");
    expect(Object.keys((await signedIn.get("pending")) ?? {})).toEqual([]);
  });

  it("starts nothing again when the page is reloaded", async () => {
    const fake = service();
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    const bar = addressBar(`${ORIGIN}/#sign-in=github`);
    await load(bar, fake, accountStore, signIns);
    await until(() => signIns.length === 1);
    await load(bar, fake, accountStore, signIns);
    // another page that does ask for a sign-in, loaded after the reload: its sign-in is the only one that opens
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns);
    await until(() => signIns.length > 1);
    expect(signIns).toHaveLength(2);
    expect(await providerOf(accountStore, signIns[1]!)).toBe("google");
  });

  it("takes the entry from the fragment alone, and a query naming one is dropped, never moved into the fragment", async () => {
    const fake = service();
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    const both = addressBar(`${ORIGIN}/?sign-in=github#sign-in=github`);
    await load(both, fake, accountStore, signIns);
    await until(() => signIns.length === 1);
    expect(both.location.hash).toBe("");
    expect(both.location.search).toBe("");
    // reloaded: nothing starts again
    await load(both, fake, accountStore, signIns);
    const queryOnly = addressBar(`${ORIGIN}/?sign-in=github`);
    await load(queryOnly, fake, accountStore, signIns);
    expect(queryOnly.location.hash).toBe("");
    await control(fake, signIns, 1);
    // an older history entry's query, moved on Back, loses it too
    const older = { location: { pathname: "/", search: "?sign-in=github&pane=w1%3Ap1" }, history: { state: null, replaceState(_data: unknown, _unused: string, next: string) { older.moved = next; } }, moved: "" };
    moveQueryToFragment(older);
    expect(older.moved).toBe("/#pane=w1%3Ap1");
  });

  it("starts nothing when another tab signed in while the provider list was read", async () => {
    const fake = service();
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    const held = heldProviders(fake);
    const loading = load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns, held.fetch);
    await until(held.asked);
    await signInElsewhere(fake, accountStore);
    held.release();
    await loading;
    await control(fake, signIns, 0);
    expect(Object.keys((await accountStore.get("pending")) ?? {})).toEqual([]);
  });

  it("starts nothing after a Back to another fragment while the provider list was read", async () => {
    const fake = service();
    const signIns: string[] = [];
    const held = heldProviders(fake);
    const loading = load(addressBar(`${ORIGIN}/#sign-in=github`), fake, memoryAccountStore(), signIns, held.fetch);
    await until(held.asked);
    window.dispatchEvent(new Event("popstate"));
    held.release();
    await loading;
    await control(fake, signIns, 0);
  });

  it("starts nothing once a PC's link arrives, whether while the list is read or while the sign-in is being written", async () => {
    const fake = service();
    const signIns: string[] = [];
    const held = heldProviders(fake);
    const first = load(addressBar(`${ORIGIN}/#sign-in=github`), fake, memoryAccountStore(), signIns, held.fetch);
    await until(held.asked);
    arrive(scanned());
    held.release();
    await first;
    // the second: the link arrives after every check on the page, while the pending record is written
    let release = (): void => {};
    let writing = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const memory = memoryAccountStore();
    const store: AccountStore = { ...memory, update: async (key, change) => { if (key === "pending") { writing = true; changed(); await gate; } return memory.update(key, change); } } as AccountStore;
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, store, signIns);
    await until(() => writing);
    arrive(scanned());
    release();
    await control(fake, signIns, 0);
  });

  it("starts nothing when the account service names no provider at all, rather than the build's own", async () => {
    const fake = service();
    const signIns: string[] = [];
    const none = (async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/providers" ? Response.json({ providers: [], device: [] }) : fake.fetch(input as string, init)) as typeof fetch;
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, memoryAccountStore(), signIns, none);
    await control(fake, signIns, 0);
  });

  it("starts nothing when a Back or an offer arrives while the shell is still loading", async () => {
    const fake = service();
    const signIns: string[] = [];
    for (const arrival of [() => window.dispatchEvent(new Event("popstate")), () => arrive(scanned())]) {
      const entry = new URL(`${ORIGIN}/#sign-in=github`);
      Object.assign(window.location, { href: entry.href, pathname: "/", search: "", hash: entry.hash });
      let release = (): void => {};
      const loading = new Promise<void>((resolve) => { release = resolve; });
      let mounted: Promise<void> | undefined;
      const options = mountOptions(fake, memoryAccountStore(), signIns);
      // a page with no start screen of its own: boot's start badge has nothing to replace
      const container = { querySelector: () => null, dataset: {} } as unknown as HTMLElement;
      bootRelayShell(container, () => { throw new Error("the app is not expected here"); }, (async () => {
        await loading;
        return { mountRelayShell: (mount: Parameters<typeof mountRelayShell>[0]) => { mounted = mountRelayShell({ ...mount, ...options }); changed(); return mounted; } };
      }) as unknown as Parameters<typeof bootRelayShell>[2]);
      // the shell's code is still loading: nothing of it runs yet
      arrival();
      release();
      await until(() => mounted !== undefined);
      await mounted;
    }
    await control(fake, signIns, 0);
  });

  it("starts nothing when another tab signed in while the sign-in's pending record was written", async () => {
    const fake = service();
    const signIns: string[] = [];
    const memory = memoryAccountStore();
    let release = (): void => {};
    let writing = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store: AccountStore = { ...memory, update: async (key, change) => {
      if (key === "pending" && !writing) { writing = true; changed(); await gate; }
      return memory.update(key, change);
    } } as AccountStore;
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, store, signIns);
    await until(() => writing);
    // the other tab shares the stored account, not this page's view of it
    await signInElsewhere(fake, memory);
    release();
    await control(fake, signIns, 0);
  });

  it("opens no sign-in sheet in the phone app when another tab signed in while the sign-in's pending record was written", async () => {
    const opened: string[] = [];
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (_plugin: string, method: string, options: { url: string }) => { if (method === "authenticate") { opened.push(options.url); changed(); } return new Promise(() => {}); },
    } });
    const fake = service();
    const memory = memoryAccountStore();
    let release = (): void => {};
    let writing = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store: AccountStore = { ...memory, update: async (key, change) => {
      if (key === "pending" && !writing) { writing = true; changed(); await gate; }
      return memory.update(key, change);
    } } as AccountStore;
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, store, []);
    await until(() => writing);
    await signInElsewhere(fake, memory);
    release();
    // a later page in the app that does start one: once its sheet opens, any sheet before it would have opened too
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, memoryAccountStore(), []);
    await until(() => opened.length > 0);
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]!).pathname).toContain("github");
  });
});
