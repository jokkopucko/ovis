import { useSyncExternalStore } from "react";
import { accountServiceOf } from "./account/service.ts";

/**
 * Whether this device has no network at all: the browser (or the phone app's WebView) says `navigator.onLine === false`,
 * and the page's account service did not answer the last ask since then. A Galaxy Z Flip6's WebView said false all along
 * on working Wi-Fi (app 1.0.7) while the account's list read fine, so a false is put to the account service
 * (checkNetwork) before the screen believes it; a page with no account service believes the flag. An open asks again
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
/** how long an ask waits for the account service before it counts as no answer */
export const CHECK_NETWORK_MS = 8_000;
const listeners = new Set<() => void>();

/**
 * Asks the page's account service whether the network answers while the device says it is offline: one ask per
 * connection at a time, which `fresh` (Try again, an open, the app coming back to the front) starts over. Any answer,
 * an error status too, is a network; `no-cors` keeps a page of another origin from being refused by CORS rather than by
 * the network; none within CHECK_NETWORK_MS is no network.
 */
export function checkNetwork({ fresh = false }: { readonly fresh?: boolean } = {}): Promise<void> {
  const service = typeof document === "undefined" ? null : accountServiceOf(document);
  if (!navigatorOffline() || service === null) {
    answered = false;
    return Promise.resolve();
  }
  if (asking !== null && asking.generation === generation && !fresh) return asking.done;
  const mine = generation;
  const done: Promise<void> = fetch(`${service}/v1/providers`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(CHECK_NETWORK_MS) }).then(() => true, () => false).then((reached) => {
    if (mine !== generation || asking?.done !== done) return;
    answered = reached;
    asking = null;
    for (const changed of listeners) changed();
  });
  asking = { generation: mine, done };
  return done;
}

/** Whether an open should say the device is offline: asked of the account service now while the device says so. */
export async function confirmOffline(): Promise<boolean> {
  if (!navigatorOffline()) return false;
  await checkNetwork({ fresh: true });
  return deviceOffline();
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
