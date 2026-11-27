import { useSyncExternalStore } from "react";
import { accountServiceOf } from "./account/service.ts";
import { inNativeApp } from "./nativeApp.ts";

/**
 * Whether this device has no network at all: the browser (or the phone app's WebView) says `navigator.onLine === false`,
 * and the last ask since then went unanswered. A Galaxy Z Flip6's WebView said false all along on working Wi-Fi (app
 * 1.0.7) while the account's list read fine, so a false is put to the account service, or to the page's own origin
 * where it has none (checkNetwork, askAddress), before the screen believes it. An open asks again
 * (confirmOffline) rather than trusting an earlier answer. `true` can still be a network with no way to the internet,
 * which the request that fails then says itself.
 */
export function deviceOffline(): boolean {
  return navigatorOffline() && !answered;
}

/** What the browser (or WebView) itself says: `navigator.onLine === false`, which deviceOffline puts to the account service. */
export function navigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** the account service answered the last ask */
let answered = false;
/** each online or offline event starts another connection: an ask started on an earlier one settles nothing */
let generation = 0;
/** the ask whose answer counts; one that another replaced (a fresh ask, another connection) settles nothing */
let asking: { readonly generation: number; readonly done: Promise<void> } | null = null;
/**
 * Where checkNetwork asks: the page's account service, or with none (a shell built with OVIS_ACCOUNT_SERVICE_URL=off)
 * the page's own origin, under /api/, which no service worker answers (public/sw.js). The phone app answers its own
 * origin itself (app/android BundledShell), with or without a network, so there the flag stands. Null: nowhere to ask.
 */
function askAddress(): string | null {
  if (typeof document === "undefined") return null;
  const service = accountServiceOf(document);
  if (service !== null) return `${service}/v1/providers`;
  return inNativeApp() ? null : new URL("/api/health", window.location.origin).href;
}

/** how long an ask waits for an answer before it counts as no answer */
export const CHECK_NETWORK_MS = 8_000;
const listeners = new Set<() => void>();

/**
 * Asks the page's account service (or its own origin: askAddress) whether the network answers while the device says it is offline: one ask per
 * connection at a time, which `fresh` (Try again, an open, the app coming back to the front) starts over. Any answer,
 * an error status too, is a network; `no-cors` keeps a page of another origin from being refused by CORS rather than by
 * the network; none within CHECK_NETWORK_MS is no network.
 */
export function checkNetwork({ fresh = false }: { readonly fresh?: boolean } = {}): Promise<void> {
  const address = navigatorOffline() ? askAddress() : null;
  if (address === null) {
    answered = false;
    return Promise.resolve();
  }
  if (asking !== null && asking.generation === generation && !fresh) return asking.done;
  const mine = generation;
  const done: Promise<void> = fetch(address, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(CHECK_NETWORK_MS) }).then(() => true, () => false).then((reached) => {
    if (mine !== generation || asking?.done !== done) return;
    answered = reached;
    asking = null;
    for (const changed of listeners) changed();
  });
  asking = { generation: mine, done };
  return done;
}

/**
 * Whether an open should say the device is offline: asked now while the device says so. An ask started since (Try
 * again) replaces this one, so the open waits for that one's answer too rather than for an answer no one counts.
 */
export async function confirmOffline(): Promise<boolean> {
  if (!navigatorOffline()) return false;
  await checkNetwork({ fresh: true });
  while (asking !== null) await asking.done;
  return deviceOffline();
}

/**
 * A click on a link to a PC's page: while the device says it is offline the page opens nothing with no network, so the
 * click is held until confirmOffline answers, then followed, or `offline` runs instead.
 */
export function followUnlessOffline(href: string, offline: () => void) {
  return (event: { preventDefault(): void }): void => {
    if (!navigatorOffline()) return;
    event.preventDefault();
    void confirmOffline().then((still) => { if (still) offline(); else window.location.assign(href); });
  };
}

function networkChanged(): void {
  generation++;
  answered = false;
  asking = null;
}

/** the window whose online and offline events start another connection, once for every screen that watches */
let tracked: Window | null = null;

function watch(changed: () => void): () => void {
  if (tracked !== window) {
    tracked = window;
    window.addEventListener("online", networkChanged);
    window.addEventListener("offline", networkChanged);
  }
  const wentOffline = (): void => { void checkNetwork(); changed(); };
  const shown = (): void => { if (document.visibilityState === "visible") void checkNetwork({ fresh: true }); };
  listeners.add(changed);
  window.addEventListener("online", changed);
  window.addEventListener("offline", wentOffline);
  document.addEventListener("visibilitychange", shown);
  void checkNetwork();
  return () => {
    listeners.delete(changed);
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", wentOffline);
    document.removeEventListener("visibilitychange", shown);
  };
}

/** deviceOffline, drawn again as the browser's online and offline events, and checkNetwork's answers, say it changed. */
export function useOffline(): boolean {
  return useSyncExternalStore(watch, deviceOffline, () => false);
}
