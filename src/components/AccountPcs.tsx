import "./RelayShell.css";
import "./AccountPcs.css";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

import { ACCOUNT_PCS_CHANGED_EVENT, isNewAccountPc, type MyPc, type MyPcState } from "../lib/account/myPcs.ts";
import { isEmailHintProvider, type AccountHint, type AccountHintChoice } from "../lib/account/accountHint.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountProvider, AccountSession } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { ConnectionLine } from "./ConnectionLine.tsx";
import { outOfReachReason, outOfReachWord } from "./relayPcState.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

export const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", google: "Google", apple: "Apple" };

/** The providers a sign-in page offers, as one choice in `locale` ("Google or Apple"). */
export function providerChoice(locale: string, providers: readonly AccountProvider[]): string {
  return new Intl.ListFormat(locale, { type: "disjunction" }).format(providers.map((provider) => PROVIDER_NAMES[provider]));
}

/**
 * The providers' own marks, as their brand rules ask for a sign-in button: GitHub's and Apple's in
 * one colour (currentColor), Google's "G" always in its four colours, never recoloured.
 */
export function ProviderMark({ provider }: { readonly provider: AccountProvider }) {
  if (provider === "google") {
    return (
      <svg className="account-provider-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  }
  return provider === "github" ? (
    <svg className="account-provider-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ) : (
    <svg className="account-provider-mark" viewBox="0 0 17 20" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M14.04 10.63c-.02-2.33 1.9-3.45 1.99-3.5-1.08-1.59-2.77-1.8-3.37-1.83-1.43-.15-2.8.85-3.53.85-.73 0-1.85-.83-3.05-.81-1.57.02-3.02.92-3.83 2.33-1.63 2.83-.42 7.02 1.17 9.32.78 1.13 1.7 2.39 2.91 2.35 1.17-.05 1.61-.76 3.02-.76 1.41 0 1.81.76 3.04.73 1.26-.02 2.05-1.14 2.82-2.28.89-1.31 1.25-2.58 1.27-2.64-.03-.01-2.43-.93-2.45-3.69ZM11.73 3.79c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.6.69-1.12 1.79-.98 2.85 1.04.08 2.1-.53 2.74-1.31Z" />
    </svg>
  );
}

const PROVIDERS: readonly AccountProvider[] = ["github", "google", "apple"];

function AccountHintCard({ hint, canConnect, onChoice }: { readonly hint: AccountHint; readonly canConnect: boolean; readonly onChoice: (choice: AccountHintChoice) => void }) {
  const t = useT();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const provider = PROVIDER_NAMES[hint.existingProvider];
  return (
    <section className="account-device" aria-labelledby={titleId}>
      <h2 className="relay-shell-title" id={titleId} ref={title} tabIndex={-1}>{t("It looks like you already have an account made with {provider}.", { provider })}</h2>
      {canConnect && <p className="settings-description">{t("Sign in with {provider} and it will be connected to the same account.", { provider })}</p>}
      {hint.noAccount && <p className="account-error" role="alert">{t("This {provider} account has no Ovis account.", { provider })}</p>}
      <div className="account-device-actions">
        {canConnect && <button type="button" className="btn btn-primary" onClick={() => onChoice("connect")}>{t("Sign in with {provider} to connect", { provider })}</button>}
        <button type="button" className="btn" onClick={() => onChoice("create")}>{t("Create a new account")}</button>
      </div>
    </section>
  );
}

function providerLabel(provider: AccountProvider, t: ReturnType<typeof useT>): string {
  switch (provider) {
    case "github": return t("Continue with GitHub");
    case "google": return t("Continue with Google");
    case "apple": return t("Continue with Apple");
  }
}

export function AccountSignIn({
  onSignIn,
  error,
  notice = null,
  providers = ["github"],
  busy = false,
  busyProvider = null,
  failedProvider = null,
  nameOnly = false,
  hint,
  onHintChoice,
}: {
  readonly onSignIn: (provider: AccountProvider) => void;
  readonly error: string | null;
  readonly notice?: string | null;
  readonly providers?: readonly AccountProvider[];
  readonly busy?: boolean;
  readonly busyProvider?: AccountProvider | null;
  readonly failedProvider?: AccountProvider | null;
  /** each button names only its provider ("GitHub"), for a screen whose title already says what it is for */
  readonly nameOnly?: boolean;
  readonly hint?: AccountHint | undefined;
  readonly onHintChoice?: ((choice: AccountHintChoice) => void) | undefined;
}) {
  const t = useT();
  const [lastProvider, setLastProvider] = useState<AccountProvider | null>(null);
  if (hint !== undefined && onHintChoice !== undefined) {
    return <AccountHintCard hint={hint} canConnect={isEmailHintProvider(hint.existingProvider) && providers.includes(hint.existingProvider)} onChoice={onHintChoice} />;
  }
  const groupBusy = busy && (busyProvider === null || !providers.includes(busyProvider));
  const preferredRetry = busyProvider ?? failedProvider ?? lastProvider;
  const retryProvider = preferredRetry && providers.includes(preferredRetry) ? preferredRetry : providers[0] ?? "github";
  return (
    <div className="account-sign-in" {...(groupBusy ? { "aria-busy": "true" } : {})}>
      <div className="account-providers">
        {PROVIDERS.filter((provider) => providers.includes(provider)).map((provider) => {
          const isBusy = busy && busyProvider === provider;
          return (
            <button
              key={provider}
              type="button"
              className="btn account-provider"
              data-provider={provider}
              aria-busy={isBusy ? "true" : undefined}
              disabled={busy}
              onClick={() => {
                if (!busy) {
                  setLastProvider(provider);
                  onSignIn(provider);
                }
              }}
            >
              {isBusy
                ? <span className="boot-spinner account-provider-mark account-provider-spinner" aria-hidden="true" />
                : <ProviderMark provider={provider} />}
              {nameOnly ? PROVIDER_NAMES[provider] : providerLabel(provider, t)}
            </button>
          );
        })}
      </div>
      {notice !== null && error === null && <p className="account-fineprint account-notice" role="status">{notice}</p>}
      {error !== null && (
        <div className="account-error-block" role="alert">
          <p className="account-error">{error} {t("The PCs this device is paired with still work.")}</p>
          <button
            type="button"
            className="btn account-error-retry"
            data-action="retry-signin"
            disabled={busy}
            onClick={() => { if (!busy) onSignIn(retryProvider); }}
          >
            {t("Try again")}
          </button>
        </div>
      )}
    </div>
  );
}


export function pcStateWord(state: MyPcState, t: ReturnType<typeof useT>): string {
  switch (state) {
    case "paired": return t("Ready");
    case "needs-approval": return t("Needs approval");
    case "offline": return t("Offline");
    case "needs-update": return t("Update Ovis on it");
  }
}

export function accountPcStateText(pc: MyPc, t: ReturnType<typeof useT>): string {
  switch (pc.state) {
    // a pairing from before the account: removing this device through the account does not reach it yet
    case "paired": return pc.linked ? pcStateWord("paired", t) : t("Ready · not in the account yet");
    case "offline": return t("Offline · {when}", { when: lastSeen(pc.last_seen_at) });
    default: return pcStateWord(pc.state, t);
  }
}

/**
 * A PC of the account in a PC's own Settings list. That page holds no relay pairing, so it cannot
 * tell whether a listed PC still waits for an approval: it says the PC is in the account once it took
 * its place there (`joined`), that it waits to be added while it is only listed or admitted, and keeps
 * only what the directory itself knows (offline, an update needed).
 */
export function listedPcStateText(pc: MyPc, t: ReturnType<typeof useT>): string {
  // the account has a list, and this device does not find the PC in it: that is what there is to say of it
  if (pc.notInList === true && !pc.paired) return t("Not in your account's list yet");
  if (pc.state !== "needs-approval" || pc.paired) return accountPcStateText(pc, t);
  return pc.joined === true ? t("In your account") : t("Waiting to be added");
}

/**
 * The sign-in whose list the page shows, for `account`, to take a PC out of that list: when another sign-in (or none)
 * took its place meanwhile (another tab), SignedOutError, so nothing is removed from that one's list.
 */
export async function signInOfAccount(service: Pick<AccountService, "session">, account: string): Promise<AccountSession> {
  const session = await service.session();
  if (session === undefined || session.account !== account) throw new SignedOutError();
  return session;
}

/** The account's PCs in a PC's own Settings list, one row each; an offline one is removed in Manage account. */
export function AccountPcRows({ pcs, onChanged, now = Date.now() }: { readonly pcs: readonly MyPc[]; readonly onChanged: () => void; readonly now?: number }) {
  const t = useT();
  const refresh = useEffectEvent(onChanged);
  useEffect(() => {
    const changed = () => refresh();
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
  }, []);
  return pcs.map((pc) => (
    <li key={pc.server_id} className={pc.state === "paired" || pc.state === "needs-approval" ? "devices-row" : "devices-row is-away"} data-pc-state={pc.state}>
      <div className="devices-name">
        <span className="settings-label">{pc.name}<span className="devices-kind">{isNewAccountPc(pc, now) ? t("New PC") : "PC"}</span></span>
        <span className="settings-description">{listedPcStateText(pc, t)}</span>
      </div>
    </li>
  ));
}

export function NoAccountPcHint({ provider }: { readonly provider: AccountProvider }) {
  const t = useT();
  return <p className="settings-hint account-no-pc" role="note">{t("No PC in this account yet. Signed in with {provider}: each way of signing in is a separate Ovis account until you link them.", { provider: PROVIDER_NAMES[provider] })}</p>;
}

function statusDotOf(state: MyPcState): StatusDotState {
  switch (state) {
    case "paired": return "ready";
    case "needs-approval":
    case "needs-update": return "needs-you";
    case "offline": return "offline";
  }
}

export function PcStatusLine({ status, lastSeenAt = null }: { readonly status: PcStatus; readonly lastSeenAt?: string | null }) {
  const t = useT();
  if (status.kind === "answered") return <ConnectionLine state={{ kind: "answered", route: status.route, ...(status.relay === undefined ? {} : { relay: status.relay }), rttMs: status.rttMs }} />;
  if (status.kind === "checking") return <ConnectionLine state={{ kind: "checking" }} />;
  const away = status.reason === "pc" ? "offline" : "unreachable";
  return <ConnectionLine state={{ kind: "offline", text: outOfReachWord(away, t) }} reason={outOfReachReason({ displayState: away, last_seen_at: lastSeenAt, check: status }, t)} />;
}

export function CheckPcsButton({ status, onCheck }: { readonly status: ReadonlyMap<string, PcStatus>; readonly onCheck: () => void }) {
  const t = useT();
  const checking = [...status.values()].some((one) => one.kind === "checking");
  return (
    <div className="relay-shell-check">
      <button
        type="button"
        className="btn btn-ghost relay-shell-check-btn"
        aria-busy={checking ? "true" : undefined}
        onClick={onCheck}
        disabled={checking}
      >
        {checking ? t("Checking…") : t("Check now")}
      </button>
    </div>
  );
}

export function AccountPcList({ pcs, onJoin, status }: { readonly pcs: readonly MyPc[]; readonly onJoin?: (pc: MyPc) => void; readonly status?: ReadonlyMap<string, PcStatus> }) {
  const t = useT();
  return (
    <ul className="relay-shell-pcs">
      {pcs.map((pc) => {
        const pcStatus = status?.get(pc.server_id);
        const body = (
          <span className="account-pc-text">
            <span className="relay-shell-pc-name">{pc.name}</span>
            {pc.paired && pcStatus
              ? <PcStatusLine status={pcStatus} lastSeenAt={pc.last_seen_at} />
              : <span className="account-pc-state"><StatusDot state={statusDotOf(pc.state)} size="inline" />{accountPcStateText(pc, t)}</span>}
          </span>
        );
        return (
          <li key={pc.server_id} data-pc-state={pc.state}>
            {pc.paired
              ? <a className="relay-shell-pc" href={serverScopePath(pc.server_id)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></a>
              : pc.join && onJoin
                ? <button type="button" className="relay-shell-pc account-pc-join" onClick={() => onJoin(pc)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></button>
                : <div className="relay-shell-pc account-pc-waiting">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}
