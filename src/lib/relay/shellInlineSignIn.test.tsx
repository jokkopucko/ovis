import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { beginSignIn, finishSignIn, SIGN_IN_MS, signInReturn } from "../account/signin.ts";
import { memoryAccountStore, type AccountStore } from "../account/store.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";

const SERVICE = "https://account.ovis.sh";
const ORIGIN = "https://app.ovis.sh";

let waiting: (() => void)[] = [];
const changed = (): void => { for (const wake of waiting.splice(0)) wake(); };
async function until(holds: () => boolean): Promise<void> {
  for (;;) {
    const next = new Promise<void>((resolve) => { waiting.push(resolve); });
    if (holds()) return;
    await next;
  }
}

interface NativeAuth { readonly asked: string[]; release: () => void }

// A marked code (`admission: 1`) scanned on a device with no sign-in stops before the pairing, and its failure screen
// signs in right there. The pairing goes on on the PC's own page, as after a scan, and nothing pairs until it is pressed.
describe("signing in from a marked pairing's failure screen", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const realFetch = globalThis.fetch;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => { Reflect.deleteProperty(globalThis, "Capacitor"); globalThis.fetch = realFetch; setSystemTime(); browser.dispose(); waiting = []; });

  /**
   * The phone app's sign-in sheet: it answers the URL it was given through the fake service, or refuses it, once the test
   * releases it. The app trades the code with the page's own fetch (account/native.ts), so that fetch is the fake's too.
   */
  function nativeApp(fake: FakeAccountService, refuse = false): NativeAuth {
    globalThis.fetch = fake.fetch as typeof fetch;
    const auth: NativeAuth = { asked: [], release: () => {} };
    const gate = new Promise<void>((resolve) => { auth.release = resolve; });
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (_plugin: string, _method: string, options: { url: string }) => {
        auth.asked.push(options.url); changed();
        await gate;
        if (refuse) return { url: `ovis://account/callback?error=access_denied&state=${new URL(options.url).searchParams.get("state")}` };
        return { url: (await fake.fetch(options.url)).headers.get("location") };
      },
    } });
    return auth;
  }

  function page(entryUrl: string, accountStore: AccountStore, fake: FakeAccountService, opened: RelayOffer[], signIns: string[], navigated: string[] = [], saved: RelayDevice[] = [], accountFetch: typeof fetch = fake.fetch as typeof fetch) {
    let props: RelayShellProps | undefined;
    const drawn: RelayShellProps["state"][] = [];
    const devices: RelayDevice[] = [...saved];
    const store: ShellDeviceStore = {
      get: async (id) => devices.find((device) => device.server_id === id), list: async () => [...devices],
      remove: async () => {}, removeRow: async () => false, update: async (_id, change) => change(undefined),
    };
    const find = (node: ReactElement): RelayShellProps => node.type === RelayShell ? node.props as RelayShellProps : find((node.props as { children: ReactElement }).children);
    const mounted = mountRelayShell({
      container: {} as HTMLElement, entryUrl, shellVersion: "0.0.0-test", label: "Test phone", store, accountStore, accountService: SERVICE, accountFetch,
      renderApp: () => { throw new Error("the app is not expected here"); },
      createRoot: () => ({ render(element: ReactElement) { props = find(element); drawn.push(props.state); changed(); }, unmount() {} }),
      open: async (offer) => { opened.push(offer); changed(); throw new Error("stopped after the pairing began"); },
      openSignIn: (url) => { signIns.push(url); changed(); },
      navigate: (path) => { navigated.push(path); changed(); },
      checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
    });
    const current = (): RelayShellProps => { if (!props) throw new TypeError("not rendered"); return props; };
    const failure = (): string | null => { const { state } = current(); return state.kind === "failed" ? state.failure : null; };
    return { mounted, current, failure, navigated, drawn };
  }

  async function stoppedForSignIn(options: { native?: boolean; refuse?: boolean; beforeSignIn?: () => void } = {}) {
    const identity = generateKeyPair();
    const scannedOffer: RelayOffer = { v: 1, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", code: "123456", admission: 1 };
    const fake = new FakeAccountService();
    fake.offerSignIns(["github", "google"], ["github", "google"]);
    fake.signInAs("google", "acct_1");
    const native = options.native ? nativeApp(fake, options.refuse) : null;
    const accountStore = memoryAccountStore();
    const opened: RelayOffer[] = [], signIns: string[] = [];
    const scannedAt = Date.now();
    const first = page(encodeOffer(scannedOffer, ORIGIN), accountStore, fake, opened, signIns);
    await first.mounted;
    await until(() => first.current().state.kind === "confirm" && !("account" in first.current().state));
    first.current().onPair();
    await until(() => first.failure() === "sign-in-first");
    // the page's build names GitHub alone: Google comes from the account service's own list
    await until(() => first.current().accountProviders?.join() === "github,google");
    options.beforeSignIn?.();
    first.current().onSignIn?.("google");
    await until(() => signIns.length === 1 || (native?.asked.length ?? 0) === 1);
    const started = signIns[0] ?? native?.asked[0] ?? "";
    const state = new URL(started).searchParams.get("state") ?? "";
    const returnUrl = async () => (await fake.fetch(started)).headers.get("location") ?? "";
    /** The front page the account service sends the browser back to, and the PC's page it goes on to. */
    const comeBack = async (url: string, beforePcPage?: () => void) => {
      const front = page(url, accountStore, fake, opened, []);
      await front.mounted;
      await until(() => front.navigated.length === 1);
      beforePcPage?.();
      const pcSignIns: string[] = [];
      const pcPage = page(new URL(front.navigated[0]!, ORIGIN).href, accountStore, fake, opened, pcSignIns);
      await pcPage.mounted;
      return { front, pcPage, pcSignIns };
    };
    /** The front page alone: it hands the pairing on, and its PC's page is not loaded (a navigation stopped on the way). */
    const handOnly = async (url: string) => {
      const front = page(url, accountStore, fake, opened, []);
      await front.mounted;
      await until(() => front.navigated.length === 1);
      return front;
    };
    /** A later, ordinary scan of `scanned` in the same tab. */
    const scanAgain = async (scanned: RelayOffer) => {
      const later = page(encodeOffer(scanned, ORIGIN), accountStore, fake, opened, []);
      await later.mounted;
      await until(() => later.current().state.kind !== "connecting");
      return later;
    };
    return { offer: scannedOffer, scannedAt, fake, accountStore, opened, first, native, state, returnUrl, comeBack, handOnly, scanAgain };
  }

  it("goes on with the pairing on the PC's own page after a web sign-in, and pairs only on Add and pair", async () => {
    const { offer, accountStore, opened, first, state, returnUrl, comeBack } = await stoppedForSignIn();
    expect(first.current().state).toMatchObject({ kind: "failed", failure: "sign-in-first", account: { kind: "signing-in", provider: "google" } });
    expect((await accountStore.get("pending"))?.[state]?.pairing?.offer).toEqual(offer);
    // the pairing waits in the account store, never in this tab's session storage (which holds only the tab's launch mark)
    expect([...browser.sessionStore.keys()].filter((key) => key !== "ovis-launched")).toEqual([]);
    const { front, pcPage } = await comeBack(await returnUrl());
    // the front page, where the service sends a browser back, only hands the pairing on
    expect(front.current().state.kind).not.toBe("confirm");
    const link = new URL(front.navigated[0]!, ORIGIN);
    expect(link.pathname).toBe(`/s/${offer.server_id}/`);
    expect(decodeOffer(link.href)).toEqual(offer);
    await until(() => { const { state: now } = pcPage.current(); return now.kind === "confirm" && now.account === "unlisted"; });
    expect(pcPage.current().scoped).toBe(true);
    expect(pcPage.current().state).toMatchObject({ kind: "confirm", offer });
    expect(await accountStore.get("pending")).toEqual({});
    expect(opened).toEqual([]);
    pcPage.current().onPair();
    await until(() => opened.length === 1);
    expect(opened[0]).toMatchObject({ server_id: offer.server_id, code: "123456" });
  });

  it("brings a refused web sign-in to the PC's own page with its reason and a way back, and a second try keeps the scan's time", async () => {
    const scanTime = Date.now();
    setSystemTime(new Date(scanTime));
    const { accountStore, opened, state, comeBack } = await stoppedForSignIn();
    const at = (await accountStore.get("pending"))?.[state]?.pairing?.at;
    expect(at).toBe(scanTime);
    // the PC's page loads half a minute later: its clock must not start again from there
    const { pcPage, pcSignIns } = await comeBack(`${ORIGIN}/#error=access_denied&state=${state}`, () => { setSystemTime(new Date(scanTime + 30_000)); });
    await until(() => { const { state: now } = pcPage.current(); return now.kind === "failed" && now.account?.kind === "signed-out" && now.account.error !== null; });
    expect(pcPage.current().state).toMatchObject({ failure: "sign-in-first" });
    expect(pcPage.current().scoped).toBe(true);
    expect(await accountStore.get("pending")).toEqual({});
    pcPage.current().onSignIn?.("github");
    await until(() => pcSignIns.length === 1);
    const again = new URL(pcSignIns[0]!).searchParams.get("state") ?? "";
    expect((await accountStore.get("pending"))?.[again]?.pairing?.at).toBe(scanTime);
    expect(opened).toEqual([]);
  });

  it("asks for a new scan on the PC's own page when the sign-in took longer than the code is good for", async () => {
    const { offer, accountStore, opened, state, returnUrl, comeBack } = await stoppedForSignIn();
    await accountStore.update("pending", (current) => {
      const pending = current![state]!;
      return { ...current, [state]: { ...pending, pairing: { ...pending.pairing!, at: pending.pairing!.at - SIGN_IN_MS - 1 } } };
    });
    const { pcPage } = await comeBack(await returnUrl());
    await until(() => pcPage.failure() === "scan-expired");
    expect(pcPage.current().state).toMatchObject({ server_id: offer.server_id, name: "Desk" });
    expect(pcPage.current().scoped).toBe(true);
    expect(opened).toEqual([]);
  });

  it("refuses an offer in the record that is not its PC's, on that PC's page, as a scanned one is", async () => {
    const { accountStore, opened, state, returnUrl, comeBack } = await stoppedForSignIn();
    const other = exportPublicKey(generateKeyPair().publicKey);
    await accountStore.update("pending", (current) => {
      const pending = current![state]!;
      return { ...current, [state]: { ...pending, pairing: { ...pending.pairing!, offer: { ...pending.pairing!.offer, server_public_key: other } } } };
    });
    const { pcPage } = await comeBack(await returnUrl());
    await until(() => pcPage.current().state.kind === "forged");
    expect(opened).toEqual([]);
  });

  it("counts the code's time from the scan, not from the press of a provider", async () => {
    let pressedAt = 0;
    const { accountStore, state, scannedAt } = await stoppedForSignIn({ beforeSignIn: () => { pressedAt = Date.now() + 5 * 60_000; setSystemTime(new Date(pressedAt)); } });
    const at = (await accountStore.get("pending"))?.[state]?.pairing?.at ?? 0;
    expect(at).toBeGreaterThanOrEqual(scannedAt);
    expect(at).toBeLessThan(pressedAt);
  });

  it("reads the note on its own PC's page only, once, and a later scan of that PC is an ordinary one", async () => {
    const { offer, state, comeBack, scanAgain } = await stoppedForSignIn();
    const { pcPage } = await comeBack(`${ORIGIN}/#error=access_denied&state=${state}`);
    await until(() => pcPage.failure() === "sign-in-first");
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
    const later = await scanAgain(offer);
    await until(() => later.current().state.kind === "confirm");
    expect(later.current().state).toMatchObject({ kind: "confirm", offer });
  });

  it("leaves another PC's scan alone, drops the note there, and asks about the first PC afresh", async () => {
    const { offer, state, handOnly, scanAgain } = await stoppedForSignIn();
    await handOnly(`${ORIGIN}/#error=access_denied&state=${state}`);
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(true);
    const otherKey = generateKeyPair().publicKey;
    const other: RelayOffer = { v: 1, server_id: deriveServerId(otherKey), server_public_key: exportPublicKey(otherKey), relay: "wss://relay.ovis.sh", name: "Lab", code: "654321", admission: 1 };
    const otherPage = await scanAgain(other);
    await until(() => otherPage.current().state.kind === "confirm");
    expect(otherPage.current().state).toMatchObject({ kind: "confirm", offer: other });
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
    const first = await scanAgain(offer);
    await until(() => first.current().state.kind === "confirm");
    expect(first.current().state).toMatchObject({ kind: "confirm", offer });
  });

  it("drops a note its PC's page cannot use, so a later scan of that PC shows the confirm", async () => {
    const { offer, accountStore, state, returnUrl, comeBack, scanAgain } = await stoppedForSignIn();
    const other = exportPublicKey(generateKeyPair().publicKey);
    // a record whose offer is not its PC's, and old enough that a note left behind would say "scan again"
    await accountStore.update("pending", (current) => {
      const pending = current![state]!;
      return { ...current, [state]: { ...pending, pairing: { offer: { ...pending.pairing!.offer, server_public_key: other }, at: pending.pairing!.at - SIGN_IN_MS - 1 } } };
    });
    const { pcPage } = await comeBack(await returnUrl());
    await until(() => pcPage.current().state.kind === "forged");
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
    const later = await scanAgain(offer);
    await until(() => later.current().state.kind === "confirm");
    expect(later.failure()).toBeNull();
  });

  it("treats the same link after a stopped navigation as expired, and a new QR code of that PC as a new scan", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const { offer, state, handOnly, scanAgain } = await stoppedForSignIn();
    await handOnly(`${ORIGIN}/#error=access_denied&state=${state}`);
    setSystemTime(new Date(start + 2 * 60_000));
    const sameLink = await scanAgain(offer);
    await until(() => sameLink.failure() === "scan-expired");
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
    const newCode = await scanAgain({ ...offer, code: "999999" });
    await until(() => newCode.current().state.kind === "confirm");
  });

  it("lets a note go when its PC's page loads without the offer, so a fresh scan of that PC shows the confirm", async () => {
    const { offer, fake, accountStore, opened, state, handOnly, scanAgain } = await stoppedForSignIn();
    await handOnly(`${ORIGIN}/#error=access_denied&state=${state}`);
    const bare = page(`${ORIGIN}/s/${offer.server_id}/`, accountStore, fake, opened, []);
    await bare.mounted;
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
    const fresh = await scanAgain(offer);
    await until(() => fresh.current().state.kind === "confirm");
    expect(fresh.failure()).toBeNull();
  });

  it("judges a web return by its own sign-in: refused stays refused when another tab signed in meanwhile", async () => {
    const { fake, accountStore, opened, state, comeBack } = await stoppedForSignIn();
    // another tab signs in, through the same store, while this sign-in is at the provider
    const other = await beginSignIn("github", { store: accountStore, service: SERVICE, redirectUri: WEB_REDIRECT });
    const otherBack = signInReturn(new URL((await fake.fetch(other)).headers.get("location") ?? "").hash);
    await finishSignIn(otherBack!, { store: accountStore, fetch: fake.fetch });
    expect(await accountStore.get("session")).toBeDefined();
    const { pcPage } = await comeBack(`${ORIGIN}/#error=access_denied&state=${state}`);
    await until(() => pcPage.failure() === "sign-in-first");
    expect(pcPage.current().state).toMatchObject({ account: { kind: "signed-out", provider: "google" } });
    expect(pcPage.drawn.some((drawn) => drawn.kind === "confirm")).toBe(false);
    expect(opened).toEqual([]);
  });

  it("keeps the refused provider for its Try again", async () => {
    const { state, comeBack } = await stoppedForSignIn();
    const { pcPage } = await comeBack(`${ORIGIN}/#error=access_denied&state=${state}`);
    await until(() => pcPage.failure() === "sign-in-first");
    expect(pcPage.current().state).toMatchObject({ account: { kind: "signed-out", provider: "google" } });
  });

  it("asks for a new scan, and sends nothing, when Add and pair is pressed after the code's time", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const { opened, first, native } = await stoppedForSignIn({ native: true });
    native!.release();
    await until(() => { const { state } = first.current(); return state.kind === "confirm" && state.account === "unlisted"; });
    setSystemTime(new Date(start + SIGN_IN_MS + 1));
    first.current().onPair();
    await until(() => first.failure() === "scan-expired");
    expect(opened).toEqual([]);
  });

  it("starts no sign-in for a code scanned longer ago than it is good for", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const fake = new FakeAccountService();
    fake.offerSignIns(["github", "google"], ["github", "google"]);
    const accountStore = memoryAccountStore();
    const identity = generateKeyPair();
    const offer: RelayOffer = { v: 1, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", code: "123456", admission: 1 };
    const signIns: string[] = [];
    const scan = page(encodeOffer(offer, ORIGIN), accountStore, fake, [], signIns);
    await scan.mounted;
    await until(() => scan.current().state.kind === "confirm" && !("account" in scan.current().state));
    scan.current().onPair();
    await until(() => scan.failure() === "sign-in-first");
    setSystemTime(new Date(start + SIGN_IN_MS + 1));
    // a sign-in draws its PKCE verifier the moment it starts: none may be drawn for this press
    const drawsRandom = spyOn(crypto, "getRandomValues");
    try {
      scan.current().onSignIn?.("google");
      expect(drawsRandom).not.toHaveBeenCalled();
    } finally { drawsRandom.mockRestore(); }
    await until(() => scan.failure() === "scan-expired");
    expect(signIns).toEqual([]);
    expect(Object.keys((await accountStore.get("pending")) ?? {})).toEqual([]);
  });

  it("marks a new pairing's connecting and failure screens, and not a saved PC's that opens again", async () => {
    const fake = new FakeAccountService();
    const accountStore = memoryAccountStore();
    const identity = generateKeyPair();
    const fresh: RelayOffer = { v: 1, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", code: "123456" };
    const scan = page(encodeOffer(fresh, ORIGIN), accountStore, fake, [], []);
    await scan.mounted;
    await until(() => scan.current().state.kind === "confirm" && !("account" in scan.current().state));
    scan.current().onPair();
    await until(() => scan.current().state.kind === "failed");
    expect(scan.drawn.filter((state) => state.kind === "connecting" || state.kind === "failed").map((state) => "pairing" in state && state.pairing)).toEqual([true, true]);
    const key = await accountStore.key();
    const saved: RelayDevice = { server_id: fresh.server_id, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone", server_public_key: fresh.server_public_key, relay: fresh.relay, name: "Desk" };
    const reopen = page(`${ORIGIN}/s/${fresh.server_id}/`, accountStore, fake, [], [], [], [saved]);
    await reopen.mounted;
    await until(() => reopen.current().state.kind === "failed");
    const shown = reopen.drawn.filter((state) => state.kind === "connecting" || state.kind === "failed");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.some((state) => "pairing" in state)).toBe(false);
  });

  it("asks for a new scan, and opens nothing more, when Try again comes after the code's time", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const { opened, first, native } = await stoppedForSignIn({ native: true });
    native!.release();
    await until(() => { const { state } = first.current(); return state.kind === "confirm" && state.account === "unlisted"; });
    first.current().onPair();
    await until(() => first.current().state.kind === "failed" && first.failure() !== "scan-expired");
    expect(opened).toHaveLength(1);
    setSystemTime(new Date(start + SIGN_IN_MS + 1));
    first.current().onRetry();
    await until(() => first.failure() === "scan-expired");
    expect(opened).toHaveLength(1);
  });

  it("counts an offer whose return came after the note's time as expired, never as a new scan", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const { opened, returnUrl, comeBack } = await stoppedForSignIn();
    const { pcPage } = await comeBack(await returnUrl(), () => { setSystemTime(new Date(start + 2 * 60_000)); });
    await until(() => pcPage.failure() === "scan-expired");
    expect(pcPage.drawn.some((drawn) => drawn.kind === "confirm")).toBe(false);
    expect(opened).toEqual([]);
  });

  it("keeps a note to the one link it was written for: another QR code of that PC is a new scan", async () => {
    const { offer, state, handOnly, scanAgain } = await stoppedForSignIn();
    await handOnly(`${ORIGIN}/#error=access_denied&state=${state}`);
    const newCode = await scanAgain({ ...offer, code: "999999" });
    await until(() => newCode.current().state.kind === "confirm");
    expect(newCode.failure()).toBeNull();
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
  });

  it("hands the pairing on as soon as the sign-in is traded, while the account's directory read still waits", async () => {
    const { offer, fake, accountStore, opened, returnUrl } = await stoppedForSignIn();
    const unanswered = new Promise<Response>(() => {});
    const holdsDirectory = (async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/pcs" ? unanswered : fake.fetch(input as string, init)) as typeof fetch;
    const front = page(await returnUrl(), accountStore, fake, opened, [], [], [], holdsDirectory);
    await until(() => front.navigated.length === 1);
    expect(new URL(front.navigated[0]!, ORIGIN).pathname).toBe(`/s/${offer.server_id}/`);
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(true);
  });

  it("keeps the sign-in but drops its pairing's handoff when another PC's link opens while the code is traded", async () => {
    const { offer, fake, accountStore, opened, returnUrl } = await stoppedForSignIn();
    let release = (): void => {};
    let trading = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holdsToken = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/token") { trading = true; changed(); await held; }
      return fake.fetch(input as string, init);
    }) as typeof fetch;
    const front = page(await returnUrl(), accountStore, fake, opened, [], [], [], holdsToken);
    await until(() => trading);
    const otherKey = generateKeyPair().publicKey;
    const other: RelayOffer = { v: 1, server_id: deriveServerId(otherKey), server_public_key: exportPublicKey(otherKey), relay: "wss://relay.ovis.sh", name: "Lab", code: "654321" };
    const link = new URL(encodeOffer(other, ORIGIN));
    Object.assign(window.location, { href: link.href, hash: link.hash });
    window.dispatchEvent(new Event("hashchange"));
    await until(() => { const { state } = front.current(); return state.kind === "confirm" && state.offer.server_id === other.server_id; });
    release();
    await front.mounted;
    expect(front.navigated).toEqual([]);
    expect(browser.sessionStore.has("ovis-pairing-return")).toBe(false);
    expect(front.current().state).toMatchObject({ kind: "confirm", offer: other });
    expect(await accountStore.get("session")).toBeDefined();
    expect(offer.server_id).not.toBe(other.server_id);
  });

  it("asks about the same pairing in place once the app's sign-in sheet answers", async () => {
    const { offer, accountStore, opened, first, native } = await stoppedForSignIn({ native: true });
    expect(first.current().state).toMatchObject({ failure: "sign-in-first", account: { kind: "signing-in", provider: "google" } });
    native!.release();
    await until(() => { const { state } = first.current(); return state.kind === "confirm" && state.account === "unlisted"; });
    expect(first.current().state).toMatchObject({ offer });
    expect(first.current().scoped).toBe(true);
    expect(await accountStore.get("pending")).toEqual({});
    expect(opened).toEqual([]);
  });

  it("asks for a new scan when the app's sign-in sheet is refused after the code's time", async () => {
    const { first, native, opened } = await stoppedForSignIn({ native: true, refuse: true });
    setSystemTime(new Date(Date.now() + SIGN_IN_MS + 1));
    native!.release();
    await until(() => first.failure() === "scan-expired");
    expect(opened).toEqual([]);
  });
});
