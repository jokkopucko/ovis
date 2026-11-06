/**
 * Drives the hosted shell's screens (components/RelayShell.tsx) from the page's address to a
 * connected PC, then hands the page to the app with the relay as its transport. Loaded only in
 * shell mode and only after the offer has left the address (boot.ts), since it brings the
 * cryptography and the mux with it.
 */
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ACCOUNT_FEATURE, MIN_SERVER_VERSION, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { UpdateStatus } from "../../../shared/update.ts";
import { RelayShell } from "../../components/RelayShell.tsx";
import { myPcs } from "../account/myPcs.ts";
import type { MyPc } from "../account/myPcs.ts";
import { accountProvidersOf, accountServiceOf, AccountService, offeredProviders, SignedOutError } from "../account/service.ts";
import { beginSignIn, finishSignIn, SignInError, signInReturn } from "../account/signin.ts";
import { enrollOnPc, keepRemovals, PEER_STATUS_MS, linkThisDevice, needsLink, pcAccountStatus, planEnroll, sendQueuedAdds, takeIntroduction } from "../account/join.ts";
import { leaveAccount } from "../account/leave.ts";
import { nativeSignIn, nativeSignInAvailable } from "../account/native.ts";
import { indexedAccountStore } from "../account/store.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import type { AccountProvider, AccountStore } from "../account/store.ts";
import { fetchUpdateStatus, requestUpdate } from "../api.ts";
import { t } from "../i18n.ts";
import { deviceLabel } from "../phone.ts";
import { registerPendingPush } from "../push.ts";
import type { PendingPushStore } from "../push.ts";
import { alertPrefs, loadSettings, SettingsProvider } from "../settings.ts";
import { readAlertFilters, withAlertFilters } from "../alertFilters.ts";
import { onLazyChunkFailure } from "../lazyChunk.ts";
import { requestFreshShell } from "../shellMode.ts";
import { setTransport } from "../transport.ts";
import { DEVICES_CHANGED_EVENT } from "../useRelay.ts";
import { takeEntryUrl } from "./boot.ts";
import { RelayUnreachableError } from "./channel.ts";
import { nativeDirectSocket } from "./directSocket.ts";
import { indexedDeviceStore, indexedPendingPush, ServerIdentityChangedError } from "./device.ts";
import type { RelayDeviceStore } from "./device.ts";
import { failureOf, forgedOffer, forgetsDevice, iosBrowserTab, keyMismatch, offerOf, pairsAgainWithoutKey, shellEntry } from "./shellState.ts";
import type { AccountView, PcUpdate, RelayShellState } from "./shellState.ts";
import { relaySkew, reloadOnce } from "./skew.ts";
import type { ReloadMemory } from "./skew.ts";
import { openRelayTransport } from "./transport.ts";
import { offerFromCode, TypedCodeError } from "./pairCode.ts";
import type { RelayTransport } from "./transport.ts";

export interface RelayShellMount {
  container: HTMLElement;
  /** the address the page loaded with, offer fragment included (boot.ts took it off the address bar) */
  entryUrl: string;
  /** mounts the app on the container once the transport is set; what it returns is unmounted should the PC turn this phone away later */
  renderApp: () => Root;
  store?: RelayDeviceStore;
  pendingPush?: PendingPushStore;
  open?: typeof openRelayTransport;
  navigate?: (path: string) => void;
  /** who this phone is, for a new pairing; the browser's user agent by default */
  label?: string;
  /** this shell's package.json version; the build's by default */
  shellVersion?: string;
  /** brings in a newer shell: the worker checks for one, then the page reloads */
  reload?: () => Promise<void>;
  /** finds a PC by a typed code (pairCode.ts); tests hand in their own */
  findByCode?: typeof offerFromCode;
  /** this client's account key and sign-in; the `ovis-account` database by default */
  accountStore?: AccountStore;
  /** the account service's origin; the page's `ovis-account-service` meta by default, and no sign-in without one */
  accountService?: string | null;
  /** the sign-ins offered; the page's `ovis-account-providers` meta by default */
  accountProviders?: readonly AccountProvider[];
  accountFetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  /** takes the page to the provider's sign-in; the return comes back to the front page */
  openSignIn?: (url: string) => void;
}

declare const __APP_VERSION__: string;

/** How long a PC an introduction named may refuse this device before it is taken as removed: past a few of its mailbox pulls. */
const INTRODUCED_GRACE_MS = 15 * 60_000;

/** How long a device that just paired looks for its introduction, and how often. */
const INTRODUCTION_WAIT_MS = 60_000;
const INTRODUCTION_POLL_MS = 3_000;

/** How long a PC's update may take, from the install request to the restarted server: a build on a slow PC included. */
const UPDATE_MS = 15 * 60_000;
/** How often the shell reads the PC's update status while it installs. */
const UPDATE_POLL_MS = 1000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function reloadPage(serverId: string | null): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    // a worker check that hangs must not keep the stale shell up: the reload goes on without it
    await Promise.race([registration?.update(), wait(5000)]);
  } catch (error) { console.warn("Ovis: the service worker did not check for a newer shell", error); }
  if (serverId !== null) await freshShellNext(serverId);
  window.location.reload();
}

async function freshShellNext(serverId: string): Promise<void> {
  try { await requestFreshShell(caches, serverId); } catch (error) { console.warn("Ovis: the worker was not asked for a fresh shell", error); }
}

function tabMemory(): ReloadMemory | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** What a connection attempt was, for the screen a failure lands on (shellState.ts failureOf). */
interface Attempt {
  offer: RelayOffer;
  code: boolean;
  paired: boolean;
  /** the attempt showed digits to compare: the PC took the pairing without a code */
  compared?: boolean;
  /** opened from a link without a code, to pair by comparing digits */
  codeless?: boolean;
  /** a saved key the PC refused was already dropped for this link (shellState.ts pairsAgainWithoutKey) */
  refreshed?: boolean;
  /** this attempt paired just now: the PC has not seen the key prove itself on this session yet */
  fresh?: boolean;
  /** this attempt already tried the key of a link whose answer was lost */
  retriedPending?: boolean;
}

/** Settings' Forget this PC: the phone's key for the PC is gone; the PC lists the device until it is revoked there. */
export async function forgetSavedPc(serverId: string, store: RelayDeviceStore = indexedDeviceStore): Promise<void> {
  await store.remove(serverId);
}

/** What a failed sign-in says on the front page. */
function signInFailure(error: unknown): string {
  if (error instanceof SignInError && error.code === "denied") return t("The sign-in was cancelled.");
  return t("The sign-in did not finish. Try again.");
}

export async function mountRelayShell(mount: RelayShellMount): Promise<void> {
  const store = mount.store ?? indexedDeviceStore;
  const accountStore = mount.accountStore ?? indexedAccountStore;
  const accountService = mount.accountService === undefined ? accountServiceOf(document) : mount.accountService;
  let accountProviders = mount.accountProviders ?? accountProvidersOf(document);
  const account = new AccountService({ store: accountStore, ...(mount.accountFetch ? { fetch: mount.accountFetch } : {}) });
  const openSignIn = mount.openSignIn ?? ((url: string) => { window.location.assign(url); });
  let accountView: AccountView | null = accountService === null ? null : { kind: "signed-out", error: null };
  const open = mount.open ?? openRelayTransport;
  const navigate = mount.navigate ?? ((path: string) => { window.location.assign(path); });
  const label = mount.label ?? deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const shellVersion = mount.shellVersion ?? __APP_VERSION__;
  let entry = shellEntry(mount.entryUrl);
  const reload = mount.reload ?? (() => reloadPage(entry.serverId));
  // a part of the app the host no longer has (the kept shell is a release behind): the reload the
  // app then offers asks the host for the shell, not the kept one
  onLazyChunkFailure(() => { if (entry.serverId !== null) void freshShellNext(entry.serverId); });
  const scoped = entry.serverId !== null;
  const iosTab = iosBrowserTab({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone: (navigator as Navigator & { standalone?: boolean }).standalone });
  let shell: Root | null = null;
  let app: Root | null = null;
  let transport: RelayTransport | null = null;
  let last: Attempt | null = null;
  let opening: AbortController | null = null;
  /** the PC the update screen is for, while it is up */
  let outdated: { opened: RelayTransport; attempt: Attempt; name: string | null; version: string } | null = null;
  let updating = false;
  /** the comparison on screen: its digits, and the phone's answer that they match */
  let comparison: { name: string | null; digits: string; matched: () => void; typed: boolean } | null = null;
  /**
   * A PC of the account joined from its card: this phone types the digits that PC shows, as it may not
   * be the owner's (directory names are anyone's). Kept in this tab's session storage, since opening the
   * PC loads its page anew; only ever makes a comparison stricter.
   */
  const TYPED_JOIN = "ovis-typed-join";
  const typedJoinFor = (serverId: string): boolean => {
    try { return sessionStorage.getItem(TYPED_JOIN) === serverId; } catch { return false; }
  };
  const setTypedJoin = (serverId: string | null): void => {
    try { if (serverId === null) sessionStorage.removeItem(TYPED_JOIN); else sessionStorage.setItem(TYPED_JOIN, serverId); } catch { /* no storage: the plain comparison stays */ }
  };
  /** the phone apps' way to the PC's direct carriers; none in a browser, which reaches the PC through the relay only */
  const directSocket = nativeDirectSocket();
  /** the offer a typed code found, until its ID is compared on screen */
  let codeOffer: RelayOffer | null = null;
  const findByCode = mount.findByCode ?? offerFromCode;

  // the push subscription this PC's worker kept while no window could hand it over (public/sw.js
  // pushsubscriptionchange): registered with the PC once it is connected, and when the worker says
  // it kept one while this window is in the app
  const pendingPush = mount.pendingPush ?? indexedPendingPush;
  const registerPending = (serverId: string): void => {
    // with this device's alert choices, as the app's own registration sends them, which then skips it
    registerPendingPush(serverId, pendingPush, withAlertFilters(alertPrefs(loadSettings()), readAlertFilters())).catch((error: unknown) => {
      console.warn("Ovis: the PC did not take this device's new push subscription", error);
    });
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      if (transport === null || last === null || (event.data as { type?: unknown } | null)?.type !== "push-subscription-change") return;
      registerPending(last.offer.server_id);
    });
  }

  const toFront = (): void => navigate("/");

  let shown: RelayShellState | null = null;
  // the build's list shows at once; the service's own answer replaces it, so a Google button
  // appears only once the service says it is set up for Google
  if (accountService !== null && mount.accountProviders === undefined) {
    offeredProviders(accountService, accountProviders, mount.accountFetch ? { fetch: mount.accountFetch } : {}).then((offered) => {
      if (offered.providers.join() === accountProviders.join()) return;
      accountProviders = offered.providers;
      if (shown !== null) show(shown);
    }, (error: unknown) => console.warn("Ovis: the account service's sign-ins could not be read", error instanceof Error ? error.name : error));
  }

  const show = (state: RelayShellState): void => {
    shown = state;
    shell ??= createRoot(mount.container);
    shell.render(createElement(StrictMode, null, createElement(SettingsProvider, null,
      createElement(RelayShell, { state, scoped, iosTab, onPair: pair, onRetry: retry, onCancel: cancel, onBack: toFront, onForget: forget, onUpdate: update, onMatch: match, onCodeStart: codeStart, onCodeSubmit: codeSubmit, onCodeMatch: codeMatch, ...(accountService === null ? {} : { onSignIn: signIn, accountProviders, onJoin: joinPc, onSignOut: signOut, onLeave: leave }) }))));
  };

  /** The front page: the saved PCs, or the account's once signed in. */
  const showFront = async (): Promise<void> => {
    const devices = await store.list();
    show(devices.length === 0 ? { kind: "empty", account: accountView } : { kind: "list", devices, account: accountView });
  };

  /** The account's directory merged with the PCs this device is paired with; the pairings work whatever the service says. */
  const loadAccount = async (): Promise<void> => {
    if (accountService === null) { await showFront(); return; }
    const session = await account.session();
    if (session === undefined) { await showFront(); return; }
    const signedIn = { kind: "signed-in", provider: session.provider, pcs: null, error: null } as const;
    accountView = signedIn;
    await showFront();
    try {
      const directory = await account.listPcs();
      // an add this device signed that some PCs missed goes out again whenever the account answers
      sendQueuedAdds({ service: account, store: accountStore, account: session.account }).catch((error: unknown) => console.warn("Ovis: kept adds could not be sent", error instanceof Error ? error.name : error));
      accountView = { ...signedIn, pcs: myPcs(directory, await store.list(), { now: Date.now(), accountKey: (await accountStore.key()).public_spki, account: session.account }) };
    } catch (error) {
      if (error instanceof SignedOutError) accountView = { kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") };
      else {
        console.warn("Ovis: the account's PCs could not be read", error);
        accountView = { ...signedIn, pcs: myPcs([], await store.list(), { now: Date.now(), accountKey: (await accountStore.key()).public_spki, account: session.account }), error: t("The account service could not be reached. The PCs this device is paired with still work.") };
      }
    }
    await showFront();
  };

  /**
   * A PC of the account this device is not paired with: compare digits with it, as a link without a
   * code does. `typed`: from the new-PC card, whose PC shows its digits on its own screen (docs/account.md, "Adding a PC").
   */
  const joinPc = (pc: MyPc, options: { typed?: boolean } = {}): void => {
    const join = pc.join;
    if (join === undefined) return;
    const link = new URL(encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: join.server_public_key, relay: join.relay, name: pc.name }, window.location.origin));
    setTypedJoin(options.typed ? pc.server_id : null);
    navigate(link.pathname + link.hash);
  };

  const signOut = (): void => {
    void account.signOut().catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      .finally(async () => { accountView = { kind: "signed-out", error: null }; await showFront(); });
  };

  const leave = (): void => {
    void leaveAccount({ service: account, accountStore, relayStore: store }).then(async ({ unconfirmed }) => {
      // a PC the account does not list kept this device: say so, rather than claim it is gone everywhere
      const names = new Map((await store.list()).map((device) => [device.server_id, device.name ?? device.server_id.slice(0, 8)]));
      accountView = { kind: "signed-out", error: unconfirmed.length === 0 ? null
        : t("This device left the account. These PCs the account does not list still have it, so revoke it on them: {pcs}", { pcs: unconfirmed.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ") }) };
      await showFront();
    }, async (error: unknown) => {
      console.warn("Ovis: this device did not leave the account", error instanceof Error ? error.name : error);
      if (accountView?.kind === "signed-in") accountView = { ...accountView, error: t("This device could not leave the account. Try again.") };
      await showFront();
    });
  };


  const signIn = (provider: AccountProvider): void => {
    if (accountService === null) return;
    accountView = { kind: "signing-in" };
    void showFront();
    // in the phone app the system's sign-in sheet brings the return back to the page; elsewhere the page goes to the provider
    const started = nativeSignInAvailable()
      ? nativeSignIn(provider, { store: accountStore, service: accountService }).then(loadAccount)
      : beginSignIn(provider, { store: accountStore, service: accountService, redirectUri: `${window.location.origin}/` }).then(openSignIn);
    started.catch(async (error: unknown) => {
      console.warn("Ovis: the sign-in did not start", error);
      accountView = { kind: "signed-out", error: signInFailure(error) };
      await showFront();
    });
  };

  const failed = async (error: unknown, attempt: Attempt): Promise<void> => {
    comparison = null;
    if (pairsAgainWithoutKey(error, { ...attempt, codeless: attempt.codeless === true })) {
      // a Cancel or another link while the key goes ends this recovery: the newer attempt owns the screen
      if (last !== attempt) return;
      await store.remove(attempt.offer.server_id);
      if (last !== attempt) return;
      await connect({ ...attempt, refreshed: true });
      return;
    }
    let failure = failureOf(error, { code: attempt.code, paired: attempt.paired, compared: attempt.compared === true, codeless: attempt.codeless === true });
    if (failure === "revoked") {
      const saved = await store.get(attempt.offer.server_id);
      // a link whose answer was lost: the PC may hold the account key now, so that key is tried once before anything is forgotten
      if (saved?.pending_key && !attempt.retriedPending) {
        const { pending_key: pending, ...rest } = saved;
        await store.update(saved.server_id, () => ({ ...rest, private_key: pending.private_key, public_spki: pending.public_spki }));
        await connect({ ...attempt, retriedPending: true });
        return;
      }
      if (saved?.introduced_at !== undefined && Date.now() - saved.introduced_at < INTRODUCED_GRACE_MS) failure = "not-added-yet";
    }
    if (forgetsDevice(failure)) await store.remove(attempt.offer.server_id).catch(() => undefined);
    // the relay's close code is the one fact the sentence does not carry; a plain refusal adds nothing
    const detail = error instanceof RelayUnreachableError && error.closeCode !== null ? error.message : null;
    const mismatch = error instanceof ServerIdentityChangedError && error.saved !== undefined && error.offered !== undefined
      ? keyMismatch(attempt.offer.server_id, [{ key: error.saved, from: "saved" }, { key: error.offered, from: "link" }]) : null;
    show({ kind: "failed", failure, name: attempt.offer.name ?? null, detail, ...(mismatch ? { mismatch } : {}) });
  };

  const connect = async (attempt: Attempt): Promise<void> => {
    // digits shown on an earlier try say nothing about how this one fails
    attempt.compared = false;
    last = attempt;
    opening?.abort();
    const controller = new AbortController();
    opening = controller;
    show({ kind: "connecting", name: attempt.offer.name ?? null });
    // signed in, a new pairing takes the account key and asks to join the account, so the PC's prompt says so
    const signedIn = accountService !== null && await account.session() !== undefined;
    const accountKey = signedIn ? await accountStore.key() : undefined;
    // a comparison that asks to join the account is taken only after this device rang through the account
    // service (approvers check that ring); without one, it asks to pair this PC only
    let intent: "pc" | "account" = "pc";
    if (accountKey && attempt.offer.code === undefined && (await store.get(attempt.offer.server_id))?.device_id == null) {
      try { await account.postAdmission(attempt.offer.server_id, label.slice(0, 48), accountKey.public_spki); intent = "account"; }
      catch (error) { console.warn("Ovis: the account service did not take the join; pairing this PC only", error instanceof Error ? error.name : error); }
    }
    let opened: RelayTransport;
    try {
      opened = await open(attempt.offer, {
        store, label, signal: controller.signal,
        ...(accountKey ? { accountKey, intent } : {}),
        ...(directSocket ? { directSocket } : {}),
        // a link without a code: the digits wait on screen until this phone says they match
        compare: (digits) => new Promise<void>((resolve) => {
          if (controller.signal.aborted) return;
          attempt.compared = true;
          comparison = { name: attempt.offer.name ?? null, digits, matched: resolve, typed: typedJoinFor(attempt.offer.server_id) };
          show({ kind: "compare", name: comparison.name, digits, confirmed: false, ...(comparison.typed ? { typed: true } : {}) });
        }),
        // the PC turned this phone away after it was in: the app goes, and the reason takes its place
        onFatal: (error) => {
          if (transport !== opened) return;
          transport = null;
          app?.unmount();
          app = null;
          void failed(error, { offer: attempt.offer, code: false, paired: true });
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      await failed(error, attempt);
      return;
    }
    comparison = null;
    if (controller.signal.aborted) { opened.close(); return; }
    // the PC admitted this phone: a pairing code is spent, and every later attempt (Try again on
    // the update screen included) signs with the saved device key instead of pairing again
    const { code, ...saved } = attempt.offer;
    const enrolled: Attempt = { offer: saved, code: false, paired: true, ...(attempt.paired ? {} : { fresh: true }) };
    last = enrolled;
    if (code !== undefined && entry.offer !== null) entry = { ...entry, offer: null };
    await admitted(opened, enrolled);
  };

  const enterApp = (opened: RelayTransport, attempt: Attempt): void => {
    outdated = null;
    transport = opened;
    setTransport(opened);
    shell?.unmount();
    shell = null;
    app = mount.renderApp();
    registerPending(attempt.offer.server_id);
    void joinAccount(opened, attempt.offer.server_id, attempt.fresh === true);
  };

  /**
   * Once in a PC that has accounts, while signed in: this device's pairing joins the account (a QR
   * pairing is linked to the account key, with no tap), the PC is listed in the account's directory,
   * and an introduction waiting there saves the account's other PCs. A failure leaves the pairing as
   * it was; the next connection tries again.
   */
  const joinAccount = async (opened: RelayTransport, serverId: string, fresh: boolean): Promise<void> => {
    if (accountService === null || !opened.server?.features?.includes(ACCOUNT_FEATURE)) return;
    const session = await account.session();
    if (session === undefined) return;
    // a session that just paired has not proved its key to the PC, which then refuses a link and
    // keeps an introduction from it: the account's steps take a connection of their own, signed in
    let own: RelayTransport | null = null;
    try {
      const key = await accountStore.key();
      let device = await store.get(serverId);
      if (device === undefined || device.device_id === null) return;
      if (fresh) own = await open(offerOf(device), { store, label });
      const through = own ?? opened;
      const fetch = (path: string, init?: RequestInit) => through.fetch(path, init);
      const status = await pcAccountStatus(fetch);
      const linking = needsLink(status, device, session.account);
      // a PC this link brings into the account, or one still waiting for the member that linked it (who may be gone),
      // gets this client's enrollment: the account's removals first, read from its other PCs
      if (linking && (status.account === null || status.enrolling === true)) await planEnroll(accountStore, serverId, session.account);
      if (linking) device = await linkThisDevice({ fetch, device, key, account: session.account, store });
      // the app's session proved the old key, or none: it signs in again with the account key, so this device can approve
      if (linking || fresh) {
        const renewed = opened.renew();
        // a Devices panel open since before the link reads the list again, over the session that proved the new key
        if (linking) void renewed.then(() => window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)));
      }
      // a PC of another account is not this account's to list or introduce from
      if (device.public_spki !== key.public_spki || (!linking && status.account !== session.account)) return;
      // the account's removals this PC holds, checked and kept as signed, for a PC this client enrolls later (#2956)
      if (!linking) await keepRemovals({ store: accountStore, account: session.account, removals: status.removals });
      // the PC lists this row as a member: only now does it count as in the account here
      if (!linking && device.account !== session.account && device.device_id !== null && !status.unlinked.includes(device.device_id)) {
        const known = device;
        device = await store.update(serverId, (current) => ({ ...(current ?? known), account: session.account }));
      }
      const publicKey = Array.from(importPublicKey(device.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await account.putPc(serverId, { label: (device.name ?? serverId.slice(0, 8)).slice(0, 48), public_key: publicKey, relay: device.relay });
      // listed first, so a removal this client signs from now on reaches it by mailbox too
      if ((await accountStore.get("enrolls"))?.[serverId] !== undefined) {
        // the PC takes an enrollment only from a session that signed in with the account key, which the ones above did not
        let signedIn = opened;
        // the account's other PCs this device is in, read first for what they keep out (docs/account.md, "Enrolling a PC")
        const peers: RelayTransport[] = [];
        try {
          if (linking || fresh) signedIn = await open(offerOf(device), { store, label });
          const others = (await store.list()).filter((other) => other.server_id !== serverId && other.device_id !== null && other.account === session.account && other.public_spki === key.public_spki);
          const reached = await Promise.allSettled(others.map(async (other) => {
            const controller = new AbortController();
            // fixed wait: a PC that does not open within the deadline counts as not checked, as one that does not answer
            const timer = setTimeout(() => controller.abort(), PEER_STATUS_MS);
            const peer = await open(offerOf(other), { store, label, signal: controller.signal }).finally(() => clearTimeout(timer));
            peers.push(peer);
            return { serverId: other.server_id, fetch: (path: string, init?: RequestInit) => peer.fetch(path, init) };
          }));
          const pc = { server_id: serverId, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? serverId.slice(0, 8)).slice(0, 48) };
          // PCs the directory lists that this device cannot read: their removals are unknown here
          // the directory unread counts as one more PC this device cannot read
          const listed = await account.listPcs().then((pcs) => pcs.filter((entry) => entry.server_id !== serverId).length, () => 1);
          await enrollOnPc({
            fetch: (path, init) => signedIn.fetch(path, init), store: accountStore, account: session.account, serverId, pc, listed,
            // a PC that could not be opened is one more that was not checked
            others: reached.map((result) => result.status === "fulfilled" ? result.value : { serverId: "", fetch: () => Promise.reject(result.reason) }),
          });
        } catch (error) { console.warn("Ovis: this PC did not get the account's devices yet", error instanceof Error ? error.name : error); }
        finally {
          if (signedIn !== opened) signedIn.close();
          for (const peer of peers) peer.close();
        }
      }
      // the approver hands the introduction over once this device's row exists, which may be a moment after it
      const deadline = Date.now() + (fresh ? INTRODUCTION_WAIT_MS : 0);
      for (;;) {
        if ((await takeIntroduction({ fetch, key, label, store, relay: device.relay })).length > 0 || Date.now() >= deadline) break;
        await wait(INTRODUCTION_POLL_MS);
      }
    } catch (error) {
      console.warn("Ovis: this PC did not join the account yet", error instanceof Error ? error.name : error);
    } finally {
      own?.close();
    }
  };


  /** The PC let this phone in: the version policy (skew.ts) decides between the app, the update screen and a newer shell. */
  const admitted = async (opened: RelayTransport, attempt: Attempt): Promise<void> => {
    const server = opened.server ?? { version: "", relayProtocol: 0 };
    const skew = relaySkew({ server, shellVersion });
    if (skew === "protocol-mismatch") {
      opened.close();
      await failed(new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${server.relayProtocol}`), attempt);
      return;
    }
    const memory = tabMemory();
    if (skew === "server-newer" && memory !== null && reloadOnce(memory, shellVersion, server.version)) {
      opened.close();
      await reload();
      return;
    }
    if (skew !== "pc-outdated") { enterApp(opened, attempt); return; }
    transport = opened;
    setTransport(opened);
    outdated = { opened, attempt, name: attempt.offer.name ?? null, version: server.version };
    await offerUpdate(outdated);
  };

  const showUpdate = (on: NonNullable<typeof outdated>, update: PcUpdate): void => {
    if (outdated !== on || transport !== on.opened) return;
    show({ kind: "outdated", name: on.name, serverVersion: on.version, minVersion: MIN_SERVER_VERSION, update });
  };

  /** The Update button only for an install the PC's supervisor manages (server/update-api.ts); the steps by hand otherwise. */
  const offerUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    showUpdate(on, { phase: "reading" });
    let status: UpdateStatus | null = null;
    try { status = await fetchUpdateStatus(); } catch (error) { console.warn("Ovis: the PC's update status could not be read", error); }
    showUpdate(on, status?.managed === true ? { phase: "offer" } : { phase: "manual" });
  };

  /** The status once a check or install the PC runs has settled, or the deadline passed. */
  const settled = async (deadline: number): Promise<UpdateStatus> => {
    for (;;) {
      const status = await fetchUpdateStatus();
      if (status.phase !== "checking") return status;
      if (Date.now() > deadline) throw new Error("The PC's update check did not finish");
      await wait(UPDATE_POLL_MS);
    }
  };

  /**
   * Installs the release on offer on the PC (POST /api/updates/install, as Settings → Updates does),
   * then follows GET /api/updates until the restarted server answers through the relay: the
   * transport reconnects by itself, and its WELCOME names the new version.
   */
  const runUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    const deadline = Date.now() + UPDATE_MS;
    showUpdate(on, { phase: "installing", step: null });
    let status = await fetchUpdateStatus();
    if (!status.available || status.latest_revision === null) {
      await requestUpdate({ command: "check" });
      status = await settled(deadline);
    }
    if (!status.available || status.latest_revision === null) throw new Error(status.blocked_reason ?? status.error ?? "No update is on offer");
    await requestUpdate({ command: "install", expected_revision: status.latest_revision });
    for (;;) {
      await wait(UPDATE_POLL_MS);
      if (outdated !== on || transport !== on.opened) return;
      if (Date.now() > deadline) throw new Error("The PC did not come back with the update");
      if (on.opened.server !== undefined && on.opened.server.version !== on.version) break;
      let now: UpdateStatus;
      try { now = await fetchUpdateStatus(); } catch {
        // the server is restarting: the relay carrier dropped, and the transport is reconnecting
        showUpdate(on, { phase: "restarting" });
        continue;
      }
      if (now.phase === "error") throw new Error(now.error ?? "The update failed");
      showUpdate(on, now.phase === "restarting" ? { phase: "restarting" } : { phase: "installing", step: now.step ?? null });
    }
    // the pairing code, if the attempt had one, was spent on the admission before the update
    await admitted(on.opened, { ...on.attempt, code: false, paired: true });
  };

  const update = (): void => {
    const on = outdated;
    if (on === null || updating) return;
    updating = true;
    void runUpdate(on).catch((error: unknown) => {
      showUpdate(on, { phase: "failed", detail: error instanceof Error ? error.message : null });
    }).finally(() => { updating = false; });
  };

  const pair = (): void => {
    if (entry.offer === null) return;
    void connect({ offer: entry.offer, code: entry.offer.code !== undefined, paired: false, codeless: entry.offer.code === undefined });
  };

  const retry = (): void => {
    if (last === null) return;
    // the update screen holds the PC's connection open: a new attempt replaces it
    outdated = null;
    transport?.close();
    transport = null;
    void connect(last);
  };

  const match = (typed?: string): void => {
    const current = comparison;
    if (current === null) return;
    if (current.typed && typed !== current.digits) {
      // one wrong entry ends this comparison: a guess never gets a second try at the same digits
      comparison = null;
      setTypedJoin(null);
      opening?.abort();
      opening = null;
      show({ kind: "compare", name: current.name, digits: "", confirmed: false, typed: true, wrong: true });
      return;
    }
    setTypedJoin(null);
    show({ kind: "compare", name: current.name, digits: current.digits, confirmed: true });
    current.matched();
  };

  const codeStart = (): void => {
    opening?.abort();
    opening = null;
    codeOffer = null;
    show({ kind: "code-entry", failure: null });
  };

  /** One tap, one exchange (pairCode.ts): a failure goes back to the field, and nothing retries with the code. */
  const codeSubmit = (input: string): void => {
    opening?.abort();
    const controller = new AbortController();
    opening = controller;
    codeOffer = null;
    show({ kind: "code-looking" });
    findByCode(input, { signal: controller.signal }).then((offer) => {
      if (controller.signal.aborted) return;
      codeOffer = offer;
      show({ kind: "code-compare", offer });
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      show({ kind: "code-entry", failure: error instanceof TypedCodeError ? error.failure : "unreachable" });
    });
  };

  // the IDs matched: the PC's own page takes the offer as it takes a scanned QR code's, and pairs from there
  const codeMatch = (): void => {
    const offer = codeOffer;
    codeOffer = null;
    if (offer === null) return;
    navigate(encodeOffer(offer, window.location.origin));
  };

  const cancel = (): void => {
    comparison = null;
    setTypedJoin(null);
    codeOffer = null;
    opening?.abort();
    opening = null;
    toFront();
  };

  // Forget only forgets: the link whose key failed the check is never paired with, here or by a
  // later Pair, so pairing again takes a new QR code scanned from the PC itself
  const forget = (): void => {
    const serverId = last?.offer.server_id ?? entry.serverId;
    const name = last?.offer.name ?? null;
    entry = { ...entry, offer: null };
    last = null;
    void (async () => {
      if (serverId !== null) await store.remove(serverId);
      show({ kind: "forgotten", name });
    })();
  };

  const arrived = (): boolean => {
    if (entry.damaged) { show({ kind: "failed", failure: "bad-offer", name: null, detail: null }); return true; }
    // a link that puts another key under this PC's id is never paired with, before or after a
    // Forget: it is no attempt (nothing retries it) and it touches no saved key
    if (entry.offer !== null && forgedOffer(entry.offer)) {
      show({ kind: "forged", name: entry.offer.name ?? null, mismatch: keyMismatch(entry.offer.server_id, [{ key: entry.offer.server_public_key, from: "link" }]) });
      entry = { ...entry, offer: null };
      return true;
    }
    if (entry.offer !== null) { show({ kind: "confirm", offer: entry.offer }); return true; }
    return false;
  };

  // a pairing link pasted into this tab while a screen is up changes only the fragment, which
  // loads nothing: it is taken off the address and asked about like one the page loaded with
  window.addEventListener("hashchange", () => {
    if (app !== null || window.location.hash === "") return;
    const next = shellEntry(takeEntryUrl(window));
    if (next.offer === null && !next.damaged) return;
    opening?.abort();
    opening = null;
    // the update screen's PC connection goes with its screen: nothing on the new one retries it
    outdated = null;
    transport?.close();
    transport = null;
    last = null;
    entry = next;
    arrived();
  });

  // a sign-in coming back; boot.ts already took it off the address, as it does an offer
  const returned = accountService !== null && entry.serverId === null && entry.offer === null ? signInReturn(new URL(mount.entryUrl).hash) : null;

  if (arrived()) return;
  if (entry.serverId !== null) {
    const saved = await store.get(entry.serverId);
    if (saved === undefined) show({ kind: "empty" });
    // a key saved from a forged link (an earlier build saved before admission): Forget removes it
    else if (forgedOffer(offerOf(saved))) show({ kind: "failed", failure: "identity-changed", name: saved.name ?? null, detail: null, mismatch: keyMismatch(saved.server_id, [{ key: saved.server_public_key, from: "saved" }]) });
    else await connect({ offer: offerOf(saved), code: false, paired: saved.device_id !== null });
    return;
  }
  if (returned !== null) {
    accountView = { kind: "signing-in" };
    await showFront();
    try {
      await finishSignIn(returned, { store: accountStore, ...(mount.accountFetch ? { fetch: mount.accountFetch } : {}) });
    } catch (error) {
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      accountView = { kind: "signed-out", error: signInFailure(error) };
    }
  }
  await loadAccount();
}
