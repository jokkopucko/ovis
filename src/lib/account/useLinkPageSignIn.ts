/**
 * Signing in from a button outside Settings (the relay tab of Add a connection): the sign-in starts
 * on the Ovis link page (deviceSignIn.ts, startLinkPageSignIn) in a new tab, with its code filled in,
 * and this page waits for it there. The tab is opened blank in the click itself, so no popup blocker
 * takes it, and pointed at the page once the service named it; in the desktop app that blank window
 * hands the page to the system browser (app/electron/src/main.ts, guard). A blocked tab leaves the
 * page and its code to open from here. Unmounting ends a sign-in still waiting, as Settings' does.
 * A sent tab stays open (no opener by design); after cancellation its old code never completes here.
 * The desktop app and the PC's own window sign in their own way instead (`own`): the person picks a provider here, and
 * the sign-in comes back over loopback (desktop.ts, ownWindow.ts), as an app's own sign-in.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { reserveTab } from "../externalLink.ts";
import { deviceOs, thisDeviceLabel } from "../phone.ts";
import { AccountHintError, isEmailHintProvider, type AccountHint, type AccountHintChoice, type SignInCreation } from "./accountHint.ts";
import { holdingSessionStore } from "./deleteAccount.ts";
import { desktopAccount } from "./desktop.ts";
import { startDeviceSignIn, startLinkPageSignIn, type DeviceSignIn } from "./deviceSignIn.ts";
import { addOwnSignInMethod, ownSignIn as startOwnSignIn, useOwnWindowRedirect } from "./ownWindow.ts";
import { AccountService, AccountServiceError, offeredProviders, SignedOutError, type OfferedProviders } from "./service.ts";
import { SignInError } from "./signin.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession } from "./store.ts";

export type LinkPageSignInState =
  | { kind: "idle" }
  | { kind: "starting" }
  /** `opened`: the page is in a tab of its own; false, the browser blocked it and only this page shows it */
  | { kind: "waiting"; started: Pick<DeviceSignIn, "provider" | "userCode" | "verificationUri" | "verificationUriComplete">; opened: boolean }
  /** an own sign-in at the provider's pages; `link`: the page the browser would not open in a tab of its own */
  | { kind: "redirecting"; link: string | null }
  | { kind: "hint"; hint: AccountHint }
  | { kind: "signed-in"; session: AccountSession }
  | { kind: "failed"; error: unknown };

export interface LinkPageSignIn {
  readonly state: LinkPageSignInState;
  readonly ready: boolean;
  /**
   * the providers to pick from: an own sign-in's, or, where the service has no link page, each provider's device sign-in;
   * null where the one button starts the link page's
   */
  readonly own: readonly AccountProvider[] | null;
  /** nothing this page can sign in with: no own sign-in, no link page and no device page (sign in elsewhere) */
  readonly unavailable: boolean;
  /** the providers the link page offers, as its copy names them */
  readonly linkPage: readonly AccountProvider[];
  readonly start: (provider?: AccountProvider) => void;
  readonly chooseAccountHint: (choice: AccountHintChoice) => void;
  readonly cancel: () => void;
}

export interface LinkRefusal { readonly provider: AccountProvider; readonly code: string }

export function useLinkPageSignIn(service: string, onSignedIn: (session: AccountSession, refusal?: LinkRefusal) => void): LinkPageSignIn {
  const [state, setState] = useState<LinkPageSignInState>({ kind: "idle" });
  const [offer, setOffer] = useState<OfferedProviders | null>(null);
  const bridge = desktopAccount();
  const ownRedirect = useOwnWindowRedirect(bridge === null);
  const running = useRef<AbortController | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    let live = true;
    setOffer(null);
    void offeredProviders(service, ["github"]).then((next) => { if (live) setOffer(next); });
    return () => { live = false; };
  }, [service]);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setState({ kind: "idle" });
  }, []);

  const ownSignIn = offer !== null && (bridge !== null || Boolean(ownRedirect));
  // no link page to pick a provider on: each provider's own device page, one button each (once this window is known
  // not to sign in its own way)
  const deviceOnly = offer !== null && !ownSignIn && ownRedirect !== undefined && offer.page.length === 0 && offer.device.length > 0;
  const own = offer === null ? null : ownSignIn ? offer.providers : deviceOnly ? offer.device : null;
  const unavailable = offer !== null && !ownSignIn && ownRedirect !== undefined && offer.page.length === 0 && offer.device.length === 0;
  const start = useCallback((provider?: AccountProvider, creation: SignInCreation | null = { create: "ask" }) => {
    if (offer === null) return;
    if (ownSignIn && provider !== undefined) {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      setState({ kind: "redirecting", link: null });
      // held back until it is known not to be cancelled: a sign-in finished after Cancel is never kept
      const blocked = (link: string): void => setState({ kind: "redirecting", link });
      const options = { bridge, service, redirect: ownRedirect ?? null, store: indexedAccountStore, signal: controller.signal, blocked };
      const connecting = creation?.create === "never";
      const intent = connecting ? { ...creation, wanted: () => !controller.signal.aborted } : creation ?? undefined;
      startOwnSignIn(provider, { ...options, store: connecting ? indexedAccountStore : holdingSessionStore(indexedAccountStore), intent }).then(async (session) => {
        // kept only if not cancelled, decided inside the write itself: a Cancel after it is too late and shows the sign-in
        if (!connecting && !await AccountService.storeSignIn(indexedAccountStore, session, { wanted: () => !controller.signal.aborted })) {
          await AccountService.revokeSession(session);
          if (controller.signal.aborted) return;
          throw new SignedOutError();
        }
        let installed = session;
        let refusal: LinkRefusal | undefined;
        if (creation?.create === "never") {
          try {
            installed = await addOwnSignInMethod(creation.thenAdd, session, options);
          } catch (error) {
            if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
              if (!(error instanceof Error)) throw error;
              refusal = { provider: creation.thenAdd, code: error instanceof AccountServiceError || error instanceof SignInError || error instanceof SignedOutError ? error.code : "failed" };
            }
          }
        }
        if (running.current === controller) running.current = null;
        else if (running.current !== null) return;
        setState({ kind: "signed-in", session: installed });
        signedIn.current(installed, refusal);
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (running.current === controller) running.current = null;
        console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
        setState(error instanceof AccountHintError ? { kind: "hint", hint: error.hint } : { kind: "failed", error });
      });
      return;
    }
    // a provider's button pressed again while its sign-in starts asks for no second code
    if (deviceOnly && running.current !== null) return;
    running.current?.abort();
    const tab = reserveTab();
    const controller = new AbortController();
    let sent = false;
    controller.signal.addEventListener("abort", () => { if (!sent) tab?.close(); }, { once: true });
    running.current = controller;
    setState({ kind: "starting" });
    void (async () => {
      const requester = { label: thisDeviceLabel(), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      const options = { service, store: indexedAccountStore, requester };
      const fallback = offer.device[0];
      const picked = deviceOnly ? offer.device.find((device) => device === provider) : undefined;
      const started = picked !== undefined ? await startDeviceSignIn({ ...options, provider: picked })
        : fallback === undefined ? await startDeviceSignIn({ ...options, provider: "ovis" })
        : await startLinkPageSignIn(options, fallback);
      controller.signal.throwIfAborted();
      if (tab !== null) tab.location.href = started.verificationUriComplete ?? started.verificationUri;
      sent = true;
      setState({ kind: "waiting", started, opened: tab !== null });
      const session = await started.finish(controller.signal);
      running.current = null;
      setState({ kind: "signed-in", session });
      signedIn.current(session);
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (!sent) tab?.close();
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      setState({ kind: "failed", error });
    }).finally(() => { if (running.current === controller) running.current = null; });
  }, [service, offer, ownSignIn, deviceOnly, bridge, ownRedirect]);

  const chooseAccountHint = (choice: AccountHintChoice): void => {
    if (state.kind !== "hint") return;
    const { hint } = state;
    if (choice === "create") start(hint.provider, null);
    else if (isEmailHintProvider(hint.existingProvider) && own?.includes(hint.existingProvider)) {
      start(hint.existingProvider, { create: "never", thenAdd: hint.provider });
    }
  };
  return { state, ready: offer !== null && ownRedirect !== undefined, own, unavailable, linkPage: offer === null ? [] : offer.page.length > 0 ? offer.page : offer.device, start, chooseAccountHint, cancel };
}
