import { useLayoutEffect, useRef } from "react";

import { useLocale, useT } from "../lib/i18n.ts";
import { SignInError } from "../lib/account/signin.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useLinkPageSignIn } from "../lib/account/useLinkPageSignIn.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { AccountSignIn, PROVIDER_NAMES, providerChoice } from "./AccountPcs.tsx";
import { linkAddress } from "./AccountSection.tsx";

function failureText(t: ReturnType<typeof useT>, error: unknown): string {
  if (!(error instanceof SignInError)) return t("The sign-in did not finish. Try again.");
  switch (error.code) {
    case "expired": return t("The code expired. Sign in again to get a new one.");
    case "denied": return t("The sign-in was refused.");
    case "unsupported": return t("This account service can't sign in a browser on this PC yet.");
    case "in_use": return t("This sign-in already belongs to another Ovis account. Nothing was changed.");
    case "no_sign_in": return t("The sign-in did not finish. Try again.");
  }
}

export function RelaySignIn({ service, onSignedIn, boundPc = false }: { service: string; onSignedIn: (session: AccountSession) => void; boundPc?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { state, ready, own, unavailable, linkPage, start, cancel } = useLinkPageSignIn(service, onSignedIn);
  const providers = providerChoice(locale, linkPage);
  const signInButton = useRef<HTMLButtonElement>(null);
  const providerButtons = useRef<HTMLDivElement>(null);
  const focusSignIn = (): void => { (signInButton.current ?? providerButtons.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus(); };
  const signInPage = useRef<HTMLAnchorElement>(null);
  const previous = useRef(state.kind);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = state.kind;
    switch (state.kind) {
      case "waiting": signInPage.current?.focus(); break;
      case "idle": if (before !== "idle") focusSignIn(); break;
      case "failed": focusSignIn(); break;
      case "redirecting":
      case "starting":
      case "signed-in": break;
      default: state satisfies never;
    }
  }, [state.kind]);
  if (state.kind === "signed-in") return <p className="connect-signin-lead">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[state.session.provider] })}</p>;
  if (state.kind === "redirecting") {
    return (
      <div className="account-device" data-testid="relay-signin-redirecting">
        <p className="settings-description" role="status">{t("Finish signing in in your browser.")}</p>
        <div className="account-device-actions">
          {state.link !== null && <ExternalLink kind="sign-in" className="btn btn-primary" href={state.link}>{t("Open the sign-in page")}</ExternalLink>}
          <button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button>
        </div>
      </div>
    );
  }
  if (state.kind === "waiting") {
    const { provider, userCode, verificationUri, verificationUriComplete } = state.started;
    const page = verificationUriComplete ?? verificationUri;
    return (
      <div className="account-device" data-testid="relay-signin-waiting">
        <p className="settings-description">{provider !== "ovis"
          ? t("Open {provider} and enter this code. Enter it only if you started this sign-in on this page.", { provider: PROVIDER_NAMES[provider] })
          : state.opened
            ? verificationUriComplete === null
              ? t("The sign-in page opened in a new tab. Enter this code there, then continue with {providers}.", { providers })
              : t("The sign-in page opened in a new tab with this code. Continue there with {providers}.", { providers })
            : t("On any device, open {address} and enter this code, then continue with {providers}. Enter it only if you started this sign-in on this page.", { address: linkAddress(verificationUri), providers })}</p>
        <output className="account-device-code" aria-live="polite">{userCode}</output>
        <p className="settings-description" role="status">{provider === "ovis" ? t("Waiting for the sign-in…") : t("Waiting for {provider}…", { provider: PROVIDER_NAMES[provider] })}</p>
        <div className="account-device-actions">
          <ExternalLink kind="sign-in" ref={signInPage} className={state.opened ? "btn" : "btn btn-primary"} href={page}>
            {provider === "ovis" ? t("Open the sign-in page") : t("Open {provider}", { provider: PROVIDER_NAMES[provider] })}
          </ExternalLink>
          <button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button>
        </div>
      </div>
    );
  }
  const failure = state.kind === "failed" ? failureText(t, state.error) : null;
  return (
    <>
      {boundPc && <p className="settings-description">{t("Sign in to this PC's account.")}</p>}
      {unavailable ? <p className="settings-hint">{t("Sign in on this PC's own screen, or in the Ovis app.")}</p>
        : own !== null ? <div ref={providerButtons}><AccountSignIn providers={own} onSignIn={start} error={failure} busy={state.kind === "starting"} /></div> : <>
      <button ref={signInButton} type="button" className="btn btn-primary connect-signin-button" aria-disabled={!ready || state.kind === "starting"} onClick={() => { if (ready && state.kind !== "starting") start(); }}>{state.kind === "starting" ? t("Signing in…") : t("Sign in to Ovis")}</button>
      {failure !== null && <p className="account-error" role="alert">{failure}</p>}
      </>}
    </>
  );
}
