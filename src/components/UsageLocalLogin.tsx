import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProviderUsage } from "../../shared/protocol.ts";
import type { UsageLoginProvider, UsageLoginRequest } from "../../shared/usage-login.ts";
import { fetchUsageLoginAccounts, startUsageLogin } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { usageName } from "../lib/usage.ts";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";

/**
 * Signs in again to an expired account this PC lists: the same sign-in as Add account, in a new
 * terminal tab, but in that account's own credential home, which the server finds by its key.
 */
export function UsageSignInAgain({ usage, onStarted, onFollow }: {
  readonly usage: ProviderUsage;
  readonly onStarted: (paneId: string) => void;
  /** where a popover hosts it: the dialog is opened outside the popover, which closes as focus leaves it */
  readonly onFollow?: (request: Extract<UsageLoginRequest, { provider: "claude" | "codex" }>) => void;
}) {
  const t = useT();
  // the sign-in, followed in its own dialog: Open terminal there hands over to the tab
  const [request, setRequest] = useState<Extract<UsageLoginRequest, { provider: "claude" | "codex" }> | null>(null);
  const provider = usage.id;
  if (provider !== "claude" && provider !== "codex") return null;
  return <span className="usage-sign-in-again">
    <button type="button" className="btn" aria-label={t("Sign in again to {name}", { name: usageName(usage) })} onClick={() => (onFollow ?? setRequest)({ provider, account: usage.key })}>{t("Sign in again")}</button>
    {request && <UsageSignInDialog request={request} onOpenTerminal={(paneId) => { setRequest(null); onStarted(paneId); }} onClose={() => setRequest(null)} />}
  </span>;
}

export function UsageLocalLogin({ provider, onStarted, onFollowed }: { readonly provider: UsageLoginProvider; readonly onStarted: (paneId: string) => void; /** a sign-in followed in the browser was closed: the flow that started it is done too */ readonly onFollowed?: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly (string | null)[] | null>(provider.separate_home ? [] : null);
  const [confirmed, setConfirmed] = useState(false);
  const [following, setFollowing] = useState<Extract<UsageLoginRequest, { provider: "claude" | "codex" }> | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (!provider.separate_home) action.current?.focus(); }, [accounts, confirmed, provider.separate_home]);
  useEffect(() => {
    if (provider.separate_home) return;
    const controller = new AbortController();
    void fetchUsageLoginAccounts(provider.id, controller.signal).then((result) => setAccounts(result.accounts))
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("Could not load sign-in options")); });
    return () => controller.abort();
  }, [provider, t]);
  if (accounts === null) return <p className={`settings-hint${error ? " account-error" : ""}`} role={error ? "alert" : "status"}>{error ?? t("Loading…")}</p>;
  if (accounts.length > 0 && !confirmed) return <div className="account-auth-form">
    <p className="settings-hint">{t("Signed in as {account}. Continuing may replace it.", { account: accounts.map((account) => account ?? t("an existing account")).join(", ") })}</p>
    <button ref={action} type="button" className="btn" onClick={() => setConfirmed(true)}>{t("Continue")}</button>
  </div>;
  return <form className="account-auth-form" onSubmit={(event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    const id = provider.id;
    if (id === "antigravity") return;
    if ((id === "claude" || id === "codex") && typeof name !== "string") return;
    // Claude and Codex are followed in the browser (UsageSignInDialog), which starts the login itself
    if (id === "claude" || id === "codex") { setFollowing({ provider: id, name: String(name) }); return; }
    setBusy(true); setError(null);
    void startUsageLogin({ provider: id, ...(confirmed ? { replace: true as const } : {}) }).then((started) => {
      onStarted(started.pane_id);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t("Could not start account sign-in"));
    }).finally(() => setBusy(false));
  }}>
    {provider.separate_home && <>
    <label className="settings-label" htmlFor="usage-account-name">{t("Account name")}</label>
    <input className="input" id="usage-account-name" name="name" pattern="[a-z0-9-]{1,32}" maxLength={32} required autoComplete="off" placeholder="work" disabled={busy} />
    <p className="settings-hint">{t("Lowercase letters, numbers and hyphens")}</p>
    </>}
    <p className="settings-hint">{provider.id === "claude" || provider.id === "codex"
      ? t("The sign-in page, and the code it asks for, show here in the browser.")
      : provider.id === "opencode" ? t("Choose OpenCode Go or Zen for plan limits.")
          : t("Follow the steps in the new tab.")}</p>
    {error && <p className="settings-hint account-error" role="alert">{error}</p>}
    <button ref={action} className="btn" type="submit" disabled={busy}>{busy ? t("Starting…") : t("Start sign-in")}</button>
    {following && <UsageSignInDialog request={following} onOpenTerminal={(paneId) => { setFollowing(null); onStarted(paneId); }} onClose={() => { setFollowing(null); onFollowed?.(); }} />}
  </form>;
}
