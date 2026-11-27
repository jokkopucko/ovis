/**
 * Signing in from this PC's own window, in a browser on the PC itself: an app's own sign-in, as app.ovis.sh and the
 * desktop app do, instead of a code typed on the link page. The service sends the provider's return to
 * `http://127.0.0.1:<port>/callback` (RFC 8252 section 7.3, docs/account.md "Signing in"), which this PC serves as the
 * app's page and nothing more. That page hands the return to the window that started the sign-in, over a channel
 * of this origin alone; that window finishes it with the PKCE verifier it kept (signin.ts, finishOwnSignIn).
 *
 * Only when the PC says the window is its own (`own_window` in /api/health, dispatch.ts) and the page is on
 * exactly `http://127.0.0.1:` that port: a window reaching the PC any other way, a `localhost` spelling included,
 * signs in through the link page.
 */
import { useEffect, useState } from "react";

import type { BridgeHealth } from "../../../shared/machines.ts";
import { fetchBridgeHealth } from "../api.ts";
import { reserveTab } from "../externalLink.ts";
import { inMacApp, inNativeApp } from "../nativeApp.ts";
import type { SignInCreation } from "./accountHint.ts";
import { desktopAccount, desktopSignIn, type DesktopAccountBridge, type DesktopMethodLink } from "./desktop.ts";
import { indexedAccountService, pcAccountServiceOf } from "./service.ts";
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";

export const CALLBACK_PATH = "/callback";
const CHANNEL = "ovis-account-sign-in";

/** the phone and Mac apps sign in their own way, never with a code from a PC's page */
// read while rendering (usePcRemoval in the join requests), so also where a page is drawn with no document
export const pcServiceHere = (): string | null => desktopAccount() === null && !inNativeApp() && !inMacApp() && typeof document !== "undefined" ? pcAccountServiceOf(document, window.isSecureContext) : null;

/** The account service this PC's own page signs in with: the desktop app's, else the PC's own meta. Never the hosted shell's (accountServiceOf). */
export const accountServiceHere = (): string | null => desktopAccount()?.service ?? pcServiceHere();

type Message = { readonly kind: "return"; readonly params: string } | { readonly kind: "taken"; readonly state: string };

/** The loopback redirect this page signs in through, or null where it must use the link page. */
export function ownWindowRedirect(health: Pick<BridgeHealth, "own_window">, page: { readonly protocol: string; readonly hostname: string; readonly port: string }): string | null {
  const port = health.own_window?.port;
  if (port === undefined || page.protocol !== "http:" || page.hostname !== "127.0.0.1" || page.port !== String(port)) return null;
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

function stateOf(params: string): string | null {
  return new URLSearchParams(params.replace(/^\?/, "")).get("state");
}

/**
 * One sign-in's way through the provider's pages from this window, in the shape the desktop app's bridge has
 * (desktop.ts, desktopSignIn). `tab`: the tab reserved in the press (externalLink.ts, reserveTab); null when the
 * browser blocked it, and `blocked` is then told the address to offer as a link. `signal` ends the wait.
 */
export function ownWindowBridge(service: string, redirect: string, tab: Window | null, signal: AbortSignal, blocked: (url: string) => void): DesktopAccountBridge {
  return {
    service,
    start: async () => redirect,
    open: (url) => new Promise<string>((resolve, reject) => {
      const state = new URL(url).searchParams.get("state");
      if (state === null) { reject(new Error("A sign-in address without its state")); return; }
      const channel = new BroadcastChannel(CHANNEL);
      const end = (): void => { channel.close(); signal.removeEventListener("abort", aborted); };
      const aborted = (): void => { end(); tab?.close(); reject(signal.reason); };
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener("abort", aborted, { once: true });
      channel.onmessage = (event: MessageEvent<Message>) => {
        const message = event.data;
        if (message?.kind !== "return" || stateOf(message.params) !== state) return;
        channel.postMessage({ kind: "taken", state } satisfies Message);
        end();
        resolve(message.params);
      };
      if (tab !== null) tab.location.href = url;
      else blocked(url);
    }),
  };
}

/**
 * The loopback redirect of this window, once the PC has answered: null where the link page signs in (also when the
 * PC could not be asked), undefined while it is asked. `asked`: false where this page signs in another way.
 */
export function useOwnWindowRedirect(wanted: boolean): string | null | undefined {
  // the Mac and phone apps hand a sign-in page to the system browser, whose return never reaches their own window
  const asked = wanted && !inMacApp() && !inNativeApp();
  const [redirect, setRedirect] = useState<string | null | undefined>(asked ? undefined : null);
  useEffect(() => {
    if (!asked) { setRedirect(null); return; }
    let live = true;
    setRedirect(undefined);
    fetchBridgeHealth().then((health) => { if (live) setRedirect(ownWindowRedirect(health, window.location)); }, (error: unknown) => {
      console.warn("Ovis: whether this is the PC's own window could not be read", error instanceof Error ? error.name : error);
      if (live) setRedirect(null);
    });
    return () => { live = false; };
  }, [asked]);
  return redirect;
}

/**
 * Signs in with `provider` from this PC's own window. Call it in the press itself: the provider's tab is opened
 * before anything is awaited, so no popup blocker takes it; a blocked one is offered through `blocked` as a link.
 */
type OwnWindowOptions = {
  readonly service: string;
  readonly store: AccountStore;
  readonly signal: AbortSignal;
  readonly blocked: (url: string) => void;
  readonly intent?: SignInCreation | DesktopMethodLink | undefined;
};

export function ownWindowSignIn(provider: AccountProvider, options: OwnWindowOptions & { readonly redirect: string }): Promise<AccountSession> {
  const tab = reserveTab();
  return desktopSignIn(provider, ownWindowBridge(options.service, options.redirect, tab, options.signal, options.blocked), options.store, options.intent);
}

/**
 * A provider's own sign-in on this page, in the press itself: through the desktop app's bridge, else from this PC's own
 * window (`redirect`); a page with neither has none. The desktop app's ends in the system browser, not by `signal`.
 */
type OwnSignInOptions = OwnWindowOptions & { readonly bridge: DesktopAccountBridge | null; readonly redirect: string | null };

export function ownSignIn(provider: AccountProvider, options: OwnSignInOptions): Promise<AccountSession> {
  if (options.bridge !== null) return desktopSignIn(provider, options.bridge, options.store, options.intent);
  if (options.redirect === null) return Promise.reject(new Error("no own sign-in here"));
  return ownWindowSignIn(provider, { ...options, redirect: options.redirect });
}

export function addOwnSignInMethod(provider: AccountProvider, session: AccountSession, options: Omit<OwnSignInOptions, "intent">): Promise<AccountSession> {
  return indexedAccountService.forSignIn(session).addMethod(provider, (linkToken, bearer, generation) =>
    ownSignIn(provider, { ...options, intent: { linkToken, bearer, generation } }));
}

/** Whether a callback page's address carried a sign-in's return at all (a reloaded one no longer does). */
export const carriesReturn = (params: string): boolean => stateOf(params) !== null;

/** The callback page's return, read once, with the code taken out of its address at once. */
export function takeReturn(location: Pick<Location, "search">, history: Pick<History, "replaceState">): string {
  const params = location.search;
  history.replaceState(null, "", CALLBACK_PATH);
  return params;
}

/**
 * Hands a return to the window that started its sign-in. `onTaken` hears that a window of this origin took it;
 * nothing is heard when that window is gone.
 */
export function handOverReturn(params: string, onTaken: () => void): () => void {
  const state = stateOf(params);
  if (state === null) return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<Message>) => {
    if (event.data?.kind === "taken" && event.data.state === state) { channel.close(); onTaken(); }
  };
  channel.postMessage({ kind: "return", params } satisfies Message);
  return () => channel.close();
}
