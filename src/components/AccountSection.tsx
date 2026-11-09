/**
 * Settings → Phone & devices → Account: sign in with GitHub, Google or Apple, see the account's PCs,
 * add or remove a sign-in method, sign out. The desktop app signs in through the system browser
 * (lib/account/desktop.ts); a browser on the PC's own secure address, which no sign-in can be sent
 * back to, signs in with a code (lib/account/deviceSignIn.ts): one button and the Ovis link page
 * where the service has it, else the provider's device flow. Only
 * the providers the service says it offers get a button. Elsewhere, and with the account off, none
 * of this.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import type { AccountLimits } from "../../shared/protocol.ts";
import { listThisPc, thisPcInNoAccount } from "../lib/account/addThisPc.ts";
import { desktopAccount, desktopProviders, desktopSignIn } from "../lib/account/desktop.ts";
import { ApiError } from "../lib/api.ts";
import { startDeviceSignIn, startLinkPageSignIn, type DeviceSignInProvider } from "../lib/account/deviceSignIn.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import { AccountService, AccountServiceError, DEVICE_PROVIDERS, offeredProviders, pcAccountServiceOf, sameSignIn, SignedOutError, type AccountIdentity, type DeviceProvider, type OfferedProviders } from "../lib/account/service.ts";
import { SignInError } from "../lib/account/signin.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession } from "../lib/account/store.ts";
import { currentLocale, useT, type Translate } from "../lib/i18n.ts";
import { inMacApp, inNativeApp } from "../lib/nativeApp.ts";
import { deviceLabel, deviceOs } from "../lib/phone.ts";
import { AccountPcList, AccountSignIn, PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import { QrCode } from "./QrCode.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

type View =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null }
  | { kind: "signing-in" }
  | { kind: "device-code"; provider: DeviceSignInProvider; userCode: string | null; verificationUri: string; verificationUriComplete: string | null }
  | { kind: "signed-in"; provider: AccountProvider; account: string; pcs: MyPc[] | null; methods: AccountIdentity[] | null; limits: AccountLimits | null; error: string | null };

/** Formats a byte count for an account's relay data allowance (B, KB, MB, GB). */
export function formatRelayBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${Math.round(safe)} B`;
  if (safe < 1024 * 1024) return `${Math.max(1, Math.round(safe / 1024))} KB`;
  if (safe < 1024 * 1024 * 1024) {
    const mb = safe / (1024 * 1024);
    return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
  }
  const gb = safe / (1024 * 1024 * 1024);
  const rounded = gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb);
  return `${rounded} GB`;
}

/** The server-provided plan name, PC slots (used/max), and relay data (used/cap when present) as one line. */
export function formatAccountLimits(t: Translate, limits: AccountLimits, listedPcs: number): { label: string; summary: string } {
  const plan = limits.plan.length > 0 ? limits.plan[0]!.toUpperCase() + limits.plan.slice(1) : limits.plan;
  const usedPcs = limits.pcs_used ?? listedPcs;
  const pcsPart = t("{used}/{max} PCs", { used: usedPcs, max: limits.pcs_max });
  const dataPart = typeof limits.data_cap_bytes === "number" && limits.data_cap_bytes > 0 && typeof limits.data_used_bytes === "number"
    ? t("{used} / {cap} relay data", { used: formatRelayBytes(limits.data_used_bytes), cap: formatRelayBytes(limits.data_cap_bytes) })
    : null;
  return {
    label: t("Plan · {plan}", { plan }),
    summary: dataPart !== null ? `${pcsPart} · ${dataPart}` : pcsPart,
  };
}

/** The account's limits as `session` reads them; null when the service reports none, or once another sign-in (or none) is stored. */
export async function accountLimitsOf(service: AccountService, session: AccountSession): Promise<AccountLimits | null> {
  const limits = await service.forSignIn(session).limits().catch(() => null);
  // another tab may have signed out or in while the answer was on its way: then it is no longer this section's to show
  const current = await service.session();
  return current !== undefined && sameSignIn(current, session) ? limits : null;
}

const isDeviceProvider = (provider: AccountProvider): provider is DeviceProvider => (DEVICE_PROVIDERS as readonly string[]).includes(provider);

/** The link page as a person reads it off the screen: account.ovis.sh/link. */
export const linkAddress = (uri: string): string => { const url = new URL(uri); return url.host + url.pathname; };

/** The pairing window this screen keeps open is reopened a minute before its ten minutes end. */
const RELIST_MS = 9 * 60_000;

/**
 * This PC, signed in and in no account yet: listed in the account with one tap, then it waits for a
 * device already in the account to add it, which the owner approves here (docs/account.md, "Adding a PC").
 */
function AddThisPc({ relayAbove = true }: { /** Settings has the relay's switch above; the welcome does not */ relayAbove?: boolean } = {}) {
  const t = useT();
  const [state, setState] = useState<{ kind: "hidden" } | { kind: "offer" } | { kind: "waiting"; name: string } | { kind: "error"; message: string }>({ kind: "hidden" });
  /** Reopens the window while this PC still waits; once a device added it, the screen is done and stops. */
  const relist = useCallback(async () => {
    if (!await thisPcInNoAccount()) { setState({ kind: "hidden" }); return; }
    await listThisPc(new AccountService({ store: indexedAccountStore }), { relistMs: RELIST_MS });
  }, []);
  useEffect(() => {
    let live = true;
    thisPcInNoAccount().then((none) => { if (live && none) setState({ kind: "offer" }); }, (error: unknown) => console.warn("Ovis: this PC's account could not be read", error instanceof Error ? error.name : error));
    return () => { live = false; };
  }, []);
  const waiting = state.kind === "waiting";
  useEffect(() => {
    if (!waiting) return;
    // the window this screen opened closes after ten minutes: kept open while the screen waits
    const timer = setInterval(() => { relist().catch((error: unknown) => console.warn("Ovis: this PC's pairing window was not reopened", error instanceof Error ? error.name : error)); }, RELIST_MS);
    return () => clearInterval(timer);
  }, [waiting, relist]);
  const add = (): void => {
    listThisPc(new AccountService({ store: indexedAccountStore }), { relistMs: RELIST_MS }).then((name) => setState({ kind: "waiting", name }), (error: unknown) => {
      console.warn("Ovis: this PC was not listed in the account", error instanceof Error ? error.name : error);
      setState({ kind: "error", message: error instanceof ApiError && error.code === "relay_off"
        ? relayAbove ? t("Turn on remote access through the Ovis relay above first.") : t("Turn on remote access through the Ovis relay in Settings → Devices and PCs first.")
        : t("This PC could not be listed in your account. Try again.") });
    });
  };
  if (state.kind === "hidden") return null;
  return (
    <div className="settings-item account-add-pc">
      {state.kind === "waiting" ? (
        <>
          <p className="settings-description" role="status">{t("On a phone already in your account, open the Ovis app and tap Add on {name}. Then approve it here.", { name: state.name })}</p>
          <p className="settings-description">{t("Every device of your account can use this PC after that.")}</p>
        </>
      ) : (
        <>
          <p className="settings-description">{t("Add this PC to your account, so every device of your account can use it with one approval.")}</p>
          <button type="button" className="btn btn-primary" onClick={add}>{t("Add this PC to my account")}</button>
          {state.kind === "error" && <p className="settings-condition" role="alert">{state.message}</p>}
        </>
      )}
    </div>
  );
}

/**
 * A fetch for the account service's first request that reports whether the service can be reached: an answer
 * other than a server error says it can (offeredProviders falls back quietly on any).
 */
export function reachabilityProbe(report: (reachable: boolean) => void, fetchImpl: typeof fetch = fetch): (input: Request | string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    try {
      const response = await fetchImpl(input, init);
      // a server error (a 503 while it is down or restarting) is no service to sign in to
      report(response.status < 500);
      return response;
    } catch (error) {
      report(false);
      throw error;
    }
  };
}

/** the waits before asking an account service that did not answer again: soon at first, then once a minute */
export const REPROBE_MS = [5_000, 15_000, 60_000] as const;

interface ReprobeTimers { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const windowTimers: ReprobeTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Asks `probe` until it says the account service can be reached, waiting REPROBE_MS between tries (the last one
 * repeats), so the sign-in comes back once a service that was down answers again. The function returned stops it.
 */
export function probeUntilReachable(probe: (live: () => boolean) => Promise<boolean>, timers: ReprobeTimers = windowTimers): () => void {
  let live = true;
  let handle: unknown = null;
  let tries = 0;
  const run = async (): Promise<void> => {
    handle = null;
    const reachable = await probe(() => live).catch(() => false);
    if (!live || reachable) return;
    handle = timers.set(() => void run(), REPROBE_MS[Math.min(tries, REPROBE_MS.length - 1)]!);
    tries += 1;
  };
  void run();
  return () => {
    live = false;
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
}

/** What Settings → Devices and PCs needs of the account: signed in or not, and the account's PCs for My devices. */
export interface AccountState {
  signedIn: boolean; account: string | null; pcs: MyPc[] | null;
  /** false once the account service did not answer: the relay tab then offers the relay's own pairing (ConnectPhoneDialog) */
  reachable: boolean;
}

/** the phone and Mac apps sign in their own way, never with a code from a PC's page */
const pcServiceHere = (): string | null => desktopAccount() === null && !inNativeApp() && !inMacApp() ? pcAccountServiceOf(document, window.isSecureContext) : null;

/** the account service this page signs in with: the desktop app's, or the one a PC's page names; null for none */
export const accountServiceHere = (): string | null => desktopAccount()?.service ?? pcServiceHere();

/**
 * The first-run welcome's sign-in (components/SetupGuide.tsx): the same sign-in in a box of its own,
 * with the guide's own line above it and its Not now below; once signed in, Add this PC.
 */
export interface WelcomeAccount { lead: ReactNode; later: ReactNode }

/** `onAccount`: the page lists the account's PCs itself (My devices), so this group does not */
export function AccountSection({ onAccount, welcome, recheck = 0 }: {
  onAccount?: (state: AccountState) => void; welcome?: WelcomeAccount;
  /** bumped to ask the account service again now, and read the sign-in again (Settings bumps it when Add a connection opens, and once its relay tab signed in) */
  recheck?: number;
} = {}) {
  const t = useT();
  const bridge = desktopAccount();
  const pcService = pcServiceHere();
  const offered = bridge !== null || pcService !== null;
  const [view, setView] = useState<View>({ kind: "loading" });
  const fallback: AccountProvider[] = bridge ? desktopProviders(bridge) : ["github"];
  const [offer, setOffer] = useState<OfferedProviders | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  /** a change to the ways in that waits for a fresh sign-in (403 reauth_required) */
  const [reauth, setReauth] = useState<{ action: "add" | "remove"; provider: AccountProvider } | null>(null);
  const deviceSignIn = useRef<AbortController | null>(null);
  // the sign-in a device code actually started: the link page's, or a provider's own when it fell back
  const startedProvider = useRef<DeviceSignInProvider | null>(null);
  const service = bridge?.service ?? pcService;
  const fallbackKey = fallback.join(",");
  useEffect(() => {
    if (service === null) return;
    return probeUntilReachable(async (live) => {
      let reachable = true;
      const probe = reachabilityProbe((answer) => { reachable = answer; if (live()) setUnreachable(!answer); });
      try {
        const offered = await offeredProviders(service, fallbackKey.split(",") as AccountProvider[], { fetch: probe });
        if (live()) setOffer(offered);
      } catch (error) {
        console.warn("Ovis: the account service's sign-ins could not be read", error instanceof Error ? error.name : error);
      }
      return reachable;
    });
  }, [service, fallbackKey, recheck]);
  /** the desktop app comes back over loopback with any provider; a PC's page only through a device flow */
  const providers: AccountProvider[] = bridge !== null ? offer?.providers ?? fallback : offer?.device ?? ["github"];
  /** a PC's page whose service has the Ovis link page: one button, GitHub or Google chosen on the link page */
  const linkPage = bridge === null && pcService !== null && (offer?.page.length ?? 0) > 0;
  // bumped by a sign-out and on unmount: a load still waiting for the account's PCs then shows nothing
  const loads = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loads.current;
    const show = (next: View) => { if (loads.current === generation) setView(next); };
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    if (session === undefined) { show({ kind: "signed-out", error: null }); return; }
    const signedIn = { kind: "signed-in", provider: session.provider, account: session.account } as const;
    show({ ...signedIn, pcs: null, methods: null, limits: null, error: null });
    // the limits row is optional: read from the session's own service, apart, so it never holds up the rest
    void accountLimitsOf(service, session).then((limits) => {
      if (loads.current !== generation || limits === null) return;
      setView((current) => current.kind === "signed-in" && current.account === session.account ? { ...current, limits } : current);
    });
    try {
      const [pcs, methods] = await Promise.all([
        service.listPcs(),
        service.identities().catch((error: unknown) => {
          // a service from before sign-in methods: the list is left out, the rest works
          if (error instanceof AccountServiceError) return null;
          throw error;
        }),
      ]);
      if (loads.current === generation) setView((current) => ({ ...signedIn, pcs: myPcs(pcs, [], { now: Date.now() }), methods, limits: current.kind === "signed-in" && current.account === session.account ? current.limits : null, error: null }));
    } catch (error) {
      if (error instanceof SignedOutError) show({ kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") });
      else if (loads.current === generation) setView((current) => ({ ...signedIn, pcs: [], methods: null, limits: current.kind === "signed-in" && current.account === session.account ? current.limits : null, error: t("The account service could not be reached. The PCs this device is paired with still work.") }));
    }
  }, [t]);

  const recheckAccount = useEffectEvent(() => {
    switch (view.kind) {
      case "device-code":
      case "signing-in": return;
      case "loading":
      case "signed-out":
      case "signed-in": if (offered) void load(); return;
      default: view satisfies never;
    }
  });
  useEffect(() => { recheckAccount(); }, [offered, load, recheck]);
  useEffect(() => {
    onAccount?.({ signedIn: view.kind === "signed-in", account: view.kind === "signed-in" ? view.account : null, pcs: view.kind === "signed-in" ? view.pcs : null, reachable: !unreachable });
  }, [onAccount, view, unreachable]);
  // closing Settings ends a device sign-in still waiting: its session is then never kept
  useEffect(() => () => { deviceSignIn.current?.abort(); loads.current++; }, []);

  if (!offered) return null;

  const unlinked = bridge !== null && view.kind === "signed-in" && view.methods !== null
    ? providers.filter((provider) => !view.methods?.some((method) => method.provider === provider)) : [];

  const cancelDeviceSignIn = (): void => {
    deviceSignIn.current?.abort();
    deviceSignIn.current = null;
  };

  /** `provider` null: the link page, where the person picked GitHub or Google themselves, so the text names neither */
  const failureText = (error: unknown, provider: AccountProvider | null): string => {
    const name = provider === null ? null : PROVIDER_NAMES[provider];
    if (error instanceof AccountServiceError && error.code === "identity_exists" && name !== null) return t("Your account already signs in with {provider}.", { provider: name });
    if (!(error instanceof SignInError)) return t("The sign-in did not finish. Try again.");
    switch (error.code) {
      case "denied": return name === null ? t("The sign-in was refused.") : t("{provider} refused the sign-in.", { provider: name });
      case "expired": return t("The code expired. Sign in again to get a new one.");
      case "unsupported": return t("This account service can't sign in a browser on this PC yet.");
      case "in_use": return name === null
        ? t("This sign-in already belongs to another Ovis account. Nothing was changed.")
        : t("This {provider} sign-in already belongs to another Ovis account. Nothing was changed.", { provider: name });
      case "no_sign_in": return t("The sign-in did not finish. Try again.");
    }
  };

  /** A device sign-in on a PC's own page: shows the link page's or the provider's code until it is approved. */
  const signInWithCode = (pcServiceOrigin: string, provider: DeviceSignInProvider): Promise<AccountSession> => {
    cancelDeviceSignIn();
    const controller = new AbortController();
    deviceSignIn.current = controller;
    setView({ kind: "device-code", provider, userCode: null, verificationUri: "", verificationUriComplete: null });
    startedProvider.current = null;
    return (async () => {
      const requester = { label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      const started = provider === "ovis"
        // the link page busy or down: the provider's own device page instead, GitHub's where the service has it
        ? await startLinkPageSignIn({ service: pcServiceOrigin, store: indexedAccountStore, requester }, offer?.device[0] ?? "github")
        : await startDeviceSignIn({ service: pcServiceOrigin, store: indexedAccountStore, provider, requester });
      controller.signal.throwIfAborted();
      startedProvider.current = started.provider;
      setView({ kind: "device-code", provider: started.provider, userCode: started.userCode, verificationUri: started.verificationUri, verificationUriComplete: started.verificationUriComplete });
      return started.finish(controller.signal);
    })().finally(() => { if (deviceSignIn.current === controller) deviceSignIn.current = null; });
  };

  /**
   * Runs one provider's sign-in the way this page can; null when it cannot here. `viaLinkPage`: the
   * link page, where the person picks GitHub or Google; a sign-in again for this same account passes
   * false, so it stays with the provider the account signed in with.
   */
  const runSignIn = (provider: AccountProvider, viaLinkPage = linkPage): Promise<AccountSession> | null => {
    if (bridge !== null) return desktopSignIn(provider, bridge, indexedAccountStore);
    if (pcService === null) return null;
    if (viaLinkPage) return signInWithCode(pcService, "ovis");
    return isDeviceProvider(provider) ? signInWithCode(pcService, provider) : null;
  };

  const signIn = (provider: AccountProvider): void => {
    if (bridge !== null) setView({ kind: "signing-in" });
    runSignIn(provider)?.then(load, (error: unknown) => {
      // cancelled, or Settings closed: the page already moved on
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      // the link page named no provider (the person picked one there); its fallback to a provider's own page did
      const started = startedProvider.current;
      const named = bridge === null && pcService !== null && linkPage ? (started === null || started === "ovis" ? null : started) : provider;
      setView({ kind: "signed-out", error: failureText(error, named) });
    });
  };

  const needsReauth = (error: unknown): boolean => error instanceof AccountServiceError && error.code === "reauth_required";

  /**
   * Adds `provider` to the signed-in account on purpose, from the desktop app only: a link goes
   * through a redirect sign-in, never a device code someone else could have typed.
   */
  const addMethod = (provider: AccountProvider): void => {
    if (bridge === null) return;
    setView({ kind: "signing-in" });
    new AccountService({ store: indexedAccountStore }).addMethod(provider, (linkToken, bearer) => desktopSignIn(provider, bridge, indexedAccountStore, { linkToken, bearer }))
      .then(() => load(), async (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Ovis: the sign-in method was not added", error instanceof SignInError || error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
        await load();
        if (needsReauth(error)) { setReauth({ action: "add", provider }); return; }
        const message = failureText(error, provider);
        setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
      });
  };

  const removeMethod = (provider: AccountProvider): void => {
    new AccountService({ store: indexedAccountStore }).removeIdentity(provider).then(() => load(), (error: unknown) => {
      console.warn("Ovis: the sign-in method was not removed", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      if (needsReauth(error)) { setReauth({ action: "remove", provider }); return; }
      const message = error instanceof AccountServiceError && error.code === "last_identity"
        ? t("Add another way to sign in before removing this one.") : t("The sign-in method could not be removed. Try again.");
      setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
    });
  };

  /**
   * The service wants a sign-in from the last ten minutes to change the ways in: sign in again
   * with the method this device uses, then repeat the change, on the same account only.
   */
  const signInAgain = (): void => {
    if (reauth === null || view.kind !== "signed-in") return;
    const { action, provider } = reauth;
    const { account, provider: current } = view;
    setReauth(null);
    runSignIn(current, false)?.then(async (session) => {
      await load();
      if (session.account !== account) return;
      if (action === "add") addMethod(provider);
      else removeMethod(provider);
    }, async (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      await load();
      setView((now) => now.kind === "signed-in" ? { ...now, error: failureText(error, current) } : now);
    });
  };

  const signOut = (): void => {
    cancelDeviceSignIn();
    loads.current++;
    void new AccountService({ store: indexedAccountStore }).signOut()
      .catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      .finally(() => setView({ kind: "signed-out", error: null }));
  };

  const signInParts = (
    <>
      {view.kind === "signed-out" && (
        <div className="settings-item" data-offer={offer === null ? "build" : "service"}>
          {linkPage
            ? (
              <div className="account-sign-in">
                <button type="button" className="btn btn-primary account-provider" data-provider="ovis" onClick={() => signIn("github")}>{t("Sign in")}</button>
                {view.error !== null && <p className="account-error" role="alert">{view.error}</p>}
              </div>
            )
            : <AccountSignIn onSignIn={signIn} error={view.error} providers={providers} />}
        </div>
      )}
      {view.kind === "signing-in" && <SettingsRow label={t("Signing in…")} description={t("Finish signing in in your browser.")}>{null}</SettingsRow>}
      {view.kind === "device-code" && (
        <div className="settings-item account-device">
          {view.userCode === null
            ? <p className="settings-description" role="status">{t("Signing in…")}</p>
            : view.provider === "ovis"
              ? (
                <>
                  <p className="settings-description">{t("On any device, open {address} and enter this code, then continue with GitHub or Google. Enter it only if you started this sign-in on this page.", { address: linkAddress(view.verificationUri) })}</p>
                  {view.verificationUriComplete !== null && <QrCode value={view.verificationUriComplete} label={t("QR code of the sign-in page with this code filled in")} />}
                  <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                  <p className="settings-description" role="status">{t("Waiting for the sign-in…")}</p>
                </>
              )
              : (
                <>
                  <p className="settings-description">{t("Open {provider} and enter this code. Enter it only if you started this sign-in on this page.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                  <p className="settings-description" role="status">{t("Waiting for {provider}…", { provider: PROVIDER_NAMES[view.provider] })}</p>
                </>
              )}
          <div className="account-device-actions">
            {view.userCode !== null && (
              <a className="btn btn-primary" href={view.verificationUri} target="_blank" rel="noopener noreferrer">
                {view.provider === "ovis" ? t("Open the sign-in page") : t("Open {provider}", { provider: PROVIDER_NAMES[view.provider] })}
              </a>
            )}
            <button type="button" className="btn" onClick={() => { cancelDeviceSignIn(); void load(); }}>{t("Cancel")}</button>
          </div>
        </div>
      )}
    </>
  );

  if (welcome !== undefined) {
    // signed out, the buttons wait for the service's own list: the build's fallback could offer one it lacks
    if (view.kind === "loading" || (view.kind === "signed-out" && offer === null)) return null;
    return (
      <div className="setup-signin">
        {view.kind === "signed-in"
          ? <><p className="setup-signin-done" role="status">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}</p><AddThisPc relayAbove={false} /></>
          : <>{welcome.lead}{signInParts}</>}
        {/* signed out only: a sign-in under way ends with its own Cancel, never folded away unnoticed by Not now */}
        {view.kind === "signed-out" && welcome.later}
      </div>
    );
  }

  return (
    <SettingsGroup title={t("Account")} section="account" keepNote note={view.kind === "signed-out" ? t("Sign in to use this PC from your phone and your other PCs.|account group") : undefined}>
      {signInParts}
      {view.kind === "signed-in" && (
        <>
          {/* which account: the service keeps no login or email, so its id names it, whole in the tooltip (G-106) */}
          <SettingsRow label={t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}
            description={<span title={view.account}>{t("Account")} <code className="account-id">{view.account.length > 12 ? `${view.account.slice(0, 12)}…` : view.account}</code></span>}>
            <button type="button" className="btn" onClick={signOut}>{t("Sign out of {provider}", { provider: PROVIDER_NAMES[view.provider] })}</button>
          </SettingsRow>
          {view.limits !== null && (() => {
            const listed = view.pcs?.filter((pc) => pc.listed).length ?? 0;
            const { label, summary } = formatAccountLimits(t, view.limits, listed);
            return (
              <div className="settings-row account-limits-row" data-testid="account-limits-row">
                <span className="settings-label">{label}</span>
                <span className="settings-fact account-limits-summary">{summary}</span>
              </div>
            );
          })()}
          {view.methods !== null && (
            <div className="settings-item account-methods">
              <p className="settings-label">{t("Ways to sign in")}</p>
              <ul className="account-method-list">
                {view.methods.map((method) => (
                  <li key={method.provider} className="account-method" data-provider={method.provider}>
                    <ProviderMark provider={method.provider} />
                    <span className="account-method-text">
                      <span>{PROVIDER_NAMES[method.provider]}</span>
                      <span className="settings-description">{t("Added {date}", { date: new Date(method.added_at).toLocaleDateString(currentLocale()) })}</span>
                    </span>
                    {/* the method this device signed in with stays: removing it would end this sign-in. The button names
                        what it removes (G-174) */}
                    {view.methods !== null && view.methods.length > 1 && method.provider !== view.provider && (
                      <button type="button" className="btn" onClick={() => removeMethod(method.provider)}>{t("Remove {provider}", { provider: PROVIDER_NAMES[method.provider] })}</button>
                    )}
                  </li>
                ))}
              </ul>
              {reauth !== null && (
                <div className="account-reauth" role="alert">
                  <p className="settings-description">{bridge === null
                      // a sign-in again stays with this account's provider, at its own device page, never the link page's choice
                      ? t("To change how you sign in, sign in again with {provider} on its own sign-in page first.", { provider: PROVIDER_NAMES[view.provider] })
                      : t("To change how you sign in, sign in again with {provider} first.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  {(bridge !== null || isDeviceProvider(view.provider)) && <button type="button" className="btn btn-primary" onClick={signInAgain}>{t("Sign in again")}</button>}
                </div>
              )}
              {bridge === null && <p className="settings-description">{t("Add another way to sign in from the Ovis desktop app.")}</p>}
              {unlinked.length > 0 && (
                <div className="account-method-add">
                  {unlinked.map((provider) => (
                    <button key={provider} type="button" className="btn" onClick={() => addMethod(provider)}>
                      <ProviderMark provider={provider} />{t("Add {provider}", { provider: PROVIDER_NAMES[provider] })}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <AddThisPc />
          {view.pcs !== null && onAccount === undefined && <div className="settings-item"><AccountPcList pcs={view.pcs} /></div>}
          {view.error !== null && <p className="settings-condition" role="alert">{view.error}</p>}
        </>
      )}
    </SettingsGroup>
  );
}
